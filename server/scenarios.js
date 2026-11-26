'use strict';

const accountUpdateSql = `
  UPDATE demo_accounts
     SET balance_cents = balance_cents - $1,
         version = version + 1
   WHERE id = $2
`;

const inventoryUpdateSql = `
  UPDATE demo_inventory
     SET on_hand = on_hand - $1
   WHERE sku = $2
`;

const orderTouchSql = `
  UPDATE demo_orders
     SET status = $1,
         updated_at = now()
   WHERE id = $2
`;

async function waitForBlockerName(lab, waiterName, blockerName, timeoutMs = 5000) {
  const waiter = lab.getSession(waiterName);
  const blocker = lab.getSession(blockerName);
  const deadline = Date.now() + timeoutMs;
  let probe = null;
  while (Date.now() < deadline) {
    probe = await lab.probeWait(waiter.pid);
    const blockers = (probe?.blockerPids || []).map(Number);
    if (blockers.includes(blocker.pid)) return probe;
    await lab.sleep(20);
  }
  throw new Error(`等待 ${waiterName} 的阻塞者变为 ${blockerName} 超时：${JSON.stringify(probe)}`);
}

const scenarios = {
  'normal-block': {
    id: 'normal-block',
    name: '普通阻塞与收敛',
    summary: 'A 在事务中锁住 accounts #1；B 更新同一行时等待。A 提交后 B 获得锁，B 提交后图为空。',
    teaching: '普通阻塞没有环。pg_blocking_pids 给出权威阻塞关系，未授予的 pg_locks 给出等待资源。',
    defaultDeadlockTimeoutMs: 4000,
    sessions: [
      { name: 'A', label: 'Alice / 账务事务', role: 'blocker' },
      { name: 'B', label: 'Bob / 并发扣款', role: 'waiter' },
    ],
    steps: [
      {
        id: 'a-lock-account',
        title: 'A 开启事务并锁住 accounts #1',
        narration: 'UPDATE 会获得行级排他锁；事务不提交，锁持续持有。',
        run: async (lab) => {
          await lab.begin('A');
          await lab.query('A', accountUpdateSql, [25, 1], { label: 'A 扣款并持锁', resource: 'demo_accounts id=1' });
          return { lock: 'demo_accounts id=1' };
        },
      },
      {
        id: 'b-wait-account',
        title: 'B 更新同一行，进入锁等待',
        narration: 'B 的语句保持 active，但 wait_event_type=Lock；单一快照应显示 B → A。',
        run: async (lab) => {
          await lab.begin('B');
          const handle = lab.startQuery('B', 'B 并发扣款', accountUpdateSql, [10, 1], {
            resource: 'demo_accounts id=1',
          });
          const probe = await lab.waitUntilBlocked(handle);
          return { handleId: handle.id, blockerPids: (probe.blockerPids || []).map(Number) };
        },
      },
      {
        id: 'a-commit-unlock',
        title: '提交 A：唯一等待者 B 先拿到锁',
        narration: 'A 的 COMMIT 完成后锁立即释放；B 的排队 UPDATE 被唤醒并完成，但 B 事务仍未提交。',
        run: async (lab) => {
          const handle = lab.getActiveHandle('B');
          await lab.commit('A');
          await lab.waitUntilSettled(handle, 5000);
          return {
            winner: 'B',
            settlementRank: handle.settlementRank,
            note: 'B 是唯一等待者，因此解锁后由 B 先获得锁。',
          };
        },
      },
      {
        id: 'b-commit-converge',
        title: '提交 B，依赖图及时收敛',
        narration: 'B 提交后其行锁也释放；立即采样应看不到任何等待边或环。',
        run: async (lab) => {
          await lab.commit('B');
          await lab.sleep(30);
          return { convergedExpected: true };
        },
      },
    ],
  },

  'handoff-queue': {
    id: 'handoff-queue',
    name: '多等待者与解锁交接',
    summary: 'A 持锁，B、C 按手动启动顺序排队。A 提交后 B 先得锁；B 提交后 C 才得锁。',
    teaching: 'PostgreSQL 等待队列会反映为 C 等待 B、B 等待 A。谁先得锁要用同快照队列边 + 连接结算顺序共同解释。',
    defaultDeadlockTimeoutMs: 4000,
    sessions: [
      { name: 'A', label: 'Alice / 初始持锁者', role: 'blocker' },
      { name: 'B', label: 'Bob / 第一等待者', role: 'first-waiter' },
      { name: 'C', label: 'Chen / 第二等待者', role: 'second-waiter' },
    ],
    steps: [
      {
        id: 'a-lock',
        title: 'A 锁住 accounts #1',
        narration: '建立第一个排他行锁。',
        run: async (lab) => {
          await lab.begin('A');
          await lab.query('A', accountUpdateSql, [25, 1], { resource: 'demo_accounts id=1' });
          return {};
        },
      },
      {
        id: 'b-queues-first',
        title: 'B 发起更新并成为第一等待者',
        narration: '先让 B 稳定等待，再启动 C，保证脚本顺序可复现。',
        run: async (lab) => {
          await lab.begin('B');
          const h = lab.startQuery('B', 'B 排队扣款', accountUpdateSql, [10, 1], { resource: 'demo_accounts id=1' });
          await lab.waitUntilBlocked(h);
          return { handleId: h.id };
        },
      },
      {
        id: 'c-queues-second',
        title: 'C 发起更新：同快照可见 C → B → A',
        narration: '即使 B 尚未被授予锁，pg_blocking_pids 也能显示队列中的上游等待者。',
        run: async (lab) => {
          await lab.begin('C');
          const h = lab.startQuery('C', 'C 排队扣款', accountUpdateSql, [5, 1], { resource: 'demo_accounts id=1' });
          await lab.waitUntilBlocked(h);
          await waitForBlockerName(lab, 'C', 'B');
          return { handleId: h.id, queue: 'C -> B -> A' };
        },
      },
      {
        id: 'a-release-b-wins',
        title: 'A 提交：B 先拿到锁，C 转为等待 B',
        narration: '观察 B 的语句先结算；随后单一快照应显示 C → B，而不是跨时刻拼出的旧边。',
        run: async (lab) => {
          const bHandle = lab.handles.find((h) => h.sessionName === 'B' && h.status === 'pending');
          await lab.commit('A');
          await lab.waitUntilSettled(bHandle, 5000);
          await waitForBlockerName(lab, 'C', 'B', 5000);
          return {
            winner: 'B',
            settlementRank: bHandle.settlementRank,
            nextBlockerForC: 'B',
            explanation: 'B 先入队；A 释放后唤醒 B。B 的事务仍开着，所以 C 继续等待 B。',
          };
        },
      },
      {
        id: 'b-release-c-wins',
        title: 'B 提交：C 第二个拿到锁',
        narration: 'B 结束事务后 C 的更新结算。',
        run: async (lab) => {
          const cHandle = lab.handles.find((h) => h.sessionName === 'C' && h.status === 'pending');
          await lab.commit('B');
          await lab.waitUntilSettled(cHandle, 5000);
          return { winner: 'C', settlementRank: cHandle.settlementRank };
        },
      },
      {
        id: 'c-commit',
        title: 'C 提交，队列清空',
        narration: '最后一个事务结束后立即采样，图应收敛。',
        run: async (lab) => {
          await lab.commit('C');
          await lab.sleep(30);
          return { convergedExpected: true };
        },
      },
    ],
  },

  'deadlock-cycle': {
    id: 'deadlock-cycle',
    name: '死锁环重现与裁决',
    summary: 'A 持 accounts #1 等 inventory；B 持 inventory 等 accounts #1，形成同快照双向环。PostgreSQL 返回 40P01。',
    teaching: '死锁要求同一原子快照中出现环。PostgreSQL deadlock_timeout 后选择并中止一个受害者；连接事件记录实际受害者，而不是凭 PID 猜。',
    defaultDeadlockTimeoutMs: 3000,
    sessions: [
      { name: 'A', label: 'Alice / 账户→库存', role: 'cyclic-worker' },
      { name: 'B', label: 'Bob / 库存→账户', role: 'cyclic-worker' },
    ],
    steps: [
      {
        id: 'a-account',
        title: 'A 锁住 accounts #1',
        narration: 'A 的第一把锁。',
        run: async (lab) => {
          await lab.begin('A');
          await lab.query('A', accountUpdateSql, [1, 1], { resource: 'demo_accounts id=1' });
          return {};
        },
      },
      {
        id: 'b-inventory',
        title: 'B 锁住 inventory SKU-LOCK-1',
        narration: 'B 的第一把锁，与 A 操作不同小表。',
        run: async (lab) => {
          await lab.begin('B');
          await lab.query('B', inventoryUpdateSql, [1, 'SKU-LOCK-1'], { resource: 'demo_inventory SKU-LOCK-1' });
          return {};
        },
      },
      {
        id: 'a-waits-inventory',
        title: 'A 请求同一 inventory 行并等待 B',
        narration: '第一条等待边 A → B（依赖方向）。',
        run: async (lab) => {
          const h = lab.startQuery('A', 'A 再更新库存', inventoryUpdateSql, [1, 'SKU-LOCK-1'], {
            resource: 'demo_inventory SKU-LOCK-1',
          });
          await lab.waitUntilBlocked(h);
          return { handleId: h.id };
        },
      },
      {
        id: 'b-waits-account-cycle',
        title: 'B 请求 accounts #1：同一快照出现环',
        narration: '此时 B → A 与 A → B 必须在同一个诊断快照中看到，才可称为采样观测到死锁环。',
        run: async (lab) => {
          const h = lab.startQuery('B', 'B 再更新账户', accountUpdateSql, [1, 1], {
            resource: 'demo_accounts id=1',
          });
          await lab.waitUntilBlocked(h);
          await lab.sleep(60);
          const snapshot = await lab.takeSnapshot({ reason: 'explicit-cycle-check' });
          return {
            handleId: h.id,
            cycleCount: snapshot.cycles.length,
            cycles: snapshot.cycles,
            warning: snapshot.cycles.length ? null : '本次即时采样未捕获环，可能已被检测器裁决；请提高 deadlock_timeout 或加密采样。',
          };
        },
      },
      {
        id: 'detector-victim',
        title: '等待 PostgreSQL 死锁检测器并回滚受害者',
        narration: 'deadlock_timeout 到达后，一个连接收到 SQLSTATE 40P01。脚本按真实错误记录受害者并 ROLLBACK。',
        run: async (lab) => {
          const pending = lab.handles.filter((h) => h.status === 'pending');
          await Promise.all(pending.map((h) => lab.waitUntilSettled(h, lab.run.deadlockTimeoutMs + 8000).catch(() => null)));
          await lab.sleep(50);

          const victim = lab.handles.find((h) => h.error?.code === '40P01');
          if (!victim) {
            throw new Error('未观察到 PostgreSQL 40P01 死锁裁决；请确认两个事务仍处于死锁状态。');
          }
          const survivor = lab.handles.find((h) => h.sessionName !== victim.sessionName);
          await lab.rollback(victim.sessionName).catch(() => {});
          return {
            victim: victim.sessionName,
            victimPid: victim.pid,
            sqlstate: '40P01',
            survivor: survivor?.sessionName || null,
            survivorStatementStatus: survivor?.status || null,
          };
        },
      },
      {
        id: 'finish-survivor',
        title: '结束存活者事务，依赖图收敛',
        narration: '这里使用 ROLLBACK 保持演示数据不变；存活者之前获得的锁随事务结束释放。',
        run: async (lab) => {
          const victimEvent = [...lab.run.events].reverse().find((e) => e.type === 'postgres:deadlock');
          const victimName = victimEvent?.victimSession;
          const survivorName = ['A', 'B'].find((name) => name !== victimName) || 'B';
          await lab.rollback(survivorName).catch(() => {});
          await lab.sleep(30);
          return { survivor: survivorName, convergedExpected: true };
        },
      },
    ],
  },

  'multi-table-orders': {
    id: 'multi-table-orders',
    name: '三表交叉阻塞',
    summary: '用 accounts、inventory、orders 三张表演示跨表资源关联：A/B 以不同顺序更新订单和账户，形成普通队列或潜在环。',
    teaching: '资源描述来自 pg_locks 的 locktype/OID；脚本资源提示只用于解释业务行，不替代数据库证据。',
    defaultDeadlockTimeoutMs: 4000,
    sessions: [
      { name: 'A', label: '订单履约事务', role: 'blocker' },
      { name: 'B', label: '状态更新事务', role: 'waiter' },
    ],
    steps: [
      {
        id: 'a-order',
        title: 'A 更新 orders #101',
        narration: '先在订单小表上持有锁。',
        run: async (lab) => {
          await lab.begin('A');
          await lab.query('A', orderTouchSql, ['locking', 101], { resource: 'demo_orders id=101' });
          return {};
        },
      },
      {
        id: 'b-account',
        title: 'B 更新 accounts #2 后再等 orders #101',
        narration: 'B 先持有 accounts #2，为跨表资源关联做准备。',
        run: async (lab) => {
          await lab.begin('B');
          await lab.query('B', accountUpdateSql, [7, 2], { resource: 'demo_accounts id=2' });
          const h = lab.startQuery('B', 'B 等待订单 101', orderTouchSql, ['blocked-by-a', 101], {
            resource: 'demo_orders id=101',
          });
          await lab.waitUntilBlocked(h);
          return { handleId: h.id };
        },
      },
      {
        id: 'inspect-resources',
        title: '关联订单资源、事务开始时间与阻塞者',
        narration: '快照同时展示 xact_start/xact_age、未授予锁模式、请求事务 ID 和阻塞 PID。',
        run: async (lab) => {
          const snapshot = await lab.takeSnapshot({ reason: 'multi-table-resource-check' });
          return { edges: snapshot.edges.length, sessions: snapshot.counts.sessions };
        },
      },
      {
        id: 'a-finish',
        title: 'A 提交订单变更，B 获得 orders 锁',
        narration: 'B 的订单语句结算，但 B 仍持有 accounts #2，直到下一步结束。',
        run: async (lab) => {
          const h = lab.getActiveHandle('B');
          await lab.commit('A');
          await lab.waitUntilSettled(h, 5000);
          return { winner: 'B' };
        },
      },
      {
        id: 'b-finish',
        title: 'B 回滚，全部资源释放',
        narration: '使用 ROLLBACK 恢复固定数据。',
        run: async (lab) => {
          await lab.rollback('B');
          await lab.sleep(30);
          return { convergedExpected: true };
        },
      },
    ],
  },
};

module.exports = { scenarios };
