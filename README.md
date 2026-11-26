# PostgreSQL 锁诊断台

一个可复现的本地数据库锁诊断工作台：多个持久连接同时操作 `demo_accounts`、`demo_inventory`、`demo_orders` 三张小表，关联 **阻塞者、等待者、事务开始时间、锁模式/资源、等待事件**，并演示普通阻塞、多等待者交接、PostgreSQL 死锁裁决以及稀疏采样后必须收回的判断。

## 快速开始

```bash
npm install
npm run setup     # 无系统 PostgreSQL 时，在 .postgres/ 内下载/解压用户态 PG 15
npm start         # http://127.0.0.1:3210
```

`npm run setup` 是幂等的：

- 有 `DATABASE_URL` 或标准 `PG*` 环境变量时，可使用现有 PostgreSQL 14+；
- 没有系统 PostgreSQL 时，会通过 `apt-get download` 把 Debian 包解压到 `.postgres/dist`，不需要 `root`/`sudo`；
- 本地集群数据目录是 `.postgres/data`，端口默认 `55432`；
- 创建 `locklab` 角色和数据库。本地引导环境会把该角色设为超级用户，以便按场景缩短 `deadlock_timeout`；使用外部受限角色时会自动回退到服务器的 `deadlock_timeout`。

常用命令：

```bash
npm test          # 纯函数测试 + 真实 PostgreSQL 场景集成测试
npm run doctor    # 检查 Node、PG 二进制、SQL 连接和 Web 端口
npm run db:stop   # 停止项目本地 PostgreSQL
npm run db:start  # 启动已有 .postgres/data 集群
npm run dev       # 必要时先 setup，再启动 Web 服务
```

可覆盖默认端口：

```bash
PGPORT=55433 PORT=4100 npm run setup
PGPORT=55433 PORT=4100 npm start
```

## 复现脚本

控制台左上角选择场景并点击 **推进下一步**。每一步都会：

1. 在指定持久连接上执行 `BEGIN` / `UPDATE` / `COMMIT` / `ROLLBACK`；
2. 对会阻塞的语句，等待 `pg_blocking_pids(pid)` 或未授予的 `pg_locks` 稳定出现；
3. 立即采集一个原子诊断样本并刷新依赖图。

内置场景：

| 场景 | 连接 | 可验证内容 |
|---|---|---|
| `normal-block` | A、B | A 持 `accounts #1`，B 等待；同快照显示 `B → A`；A 提交后 B 得锁，B 提交后图收敛 |
| `handoff-queue` | A、B、C | 按顺序入队；采样可见 `C → B → A`；A 提交后 **B 先得锁**，随后变成 `C → B`；B 提交后 C 得锁 |
| `deadlock-cycle` | A、B | 两事务以相反顺序更新 `accounts #1` 和 `inventory SKU-LOCK-1`；同快照出现双向环，PostgreSQL 返回 SQLSTATE `40P01` |
| `multi-table-orders` | A、B | 关联 `orders`、`accounts` 上的跨表锁资源和事务时间 |

“谁先拿到锁”不是只靠图猜：服务端记录本工作台每个连接的查询 Promise 实际结算顺序（`settlementRank`）。在 `handoff-queue` 中，它与 PostgreSQL 等待队列边互相印证。

## 诊断快照与证据边界

核心查询在单个诊断事务中执行，并通过：

- `pg_stat_activity`：PID、状态、`xact_start`、`query_start`、等待事件、SQL；
- `pg_blocking_pids(pid)`：权威阻塞 PID 数组；
- `pg_locks`：`locktype`、关系/OID、事务 ID、`mode`、`granted`、`fastpath`；
- `pg_class` / `pg_namespace`：可读的表名和 schema。

服务端把结果构建成 **等待者 → 阻塞者** 的 waits-for 图，并用 Tarjan SCC 检测同一样本中的环。

关键规则：

1. **只有同一个 `sampleSeq` 内的边和环可以构成当前依赖图。**
2. 不同采样时刻的边可以做时间线/降采样分析，但页面会明确标记为“禁止当真的跨时刻拼接”，不能合并成一张当前图。
3. 没采到某个边，不证明阻塞没有发生；只能给出“最后看到”和“之后未见”的时间区间。
4. 死锁的独立强证据是 PostgreSQL `40P01` 事件；即使采样错过了环，也能证明数据库检测到了死锁。
5. 对本工作台自己的连接，驱动层查询结算顺序可保留获胜者证据；但稀疏目录采样本身可能无法证明谁先得锁，页面会区分这两类结论。

## 可调开销上限

页面中的 **诊断查询开销上限** 会转换为：

```sql
BEGIN;
SELECT set_config('statement_timeout', '<budgetMs>', true);
-- 诊断查询
COMMIT;
```

允许范围默认 `2..5000ms`。每次采样展示：

- 实际服务端/往返耗时；
- `statement_timeout` 预算；
- 是否超时/不完整；
- 相对自动采样间隔的开销占比。

若诊断查询超时，快照会标记为 `incomplete`，UI 拒绝把它渲染成可信依赖图，也不会声称“图已收敛”。

## 采样变稀实验室

右侧面板可对当前运行已记录的样本做确定性降采样：

- `stride = N`：每 N 个原子样本保留一个；
- 最小时间间隔：进一步按时间过滤；
- 展示总样本数、保留数、必须收回的判断数；
- 对每条边、每个死锁环、获胜者结论、收敛结论和解锁时间窗分别给出：
  - 稀疏样本是否仍支持；
  - 若不支持，必须收回哪一句“采样判断”；
  - 驱动事件是否仍保留工具自身的事实证据。

建议复现方式：选择 `handoff-queue`，把自动采样间隔设为 `100–200ms` 并开始采样，然后逐步推进；完成后把 stride 调到 `3–8`，观察 `C → B`、解锁窗口和收敛结论如何消失或变宽。

也可以直接点击 **自动播放并密集录制**：页面会重建当前场景，以约 `90ms` 间隔持续请求真实原子快照，同时自动逐步推进；脚本结束后自动把 stride 设为 `5` 并刷新右侧分析。这个按钮只是编排现有 HTTP API，不会在浏览器中拼接诊断图。

## HTTP API

```text
GET  /api/health
GET  /api/scenarios
GET  /api/state
POST /api/runs                 { "scenarioId": "deadlock-cycle", "deadlockTimeoutMs": 700 }
POST /api/advance              { "budgetMs": 250 }
POST /api/snapshots            { "budgetMs": 250, "intervalMs": 500 }
POST /api/settings             { "budgetMs": 120 }
POST /api/runs/current/reset   { "scenarioId": "normal-block" }
GET  /api/samples?limit=300
GET  /api/analysis?stride=4&minIntervalMs=250
```

示例：

```bash
curl -s -X POST localhost:3210/api/runs \
  -H 'content-type: application/json' \
  -d '{"scenarioId":"deadlock-cycle","deadlockTimeoutMs":700}'

curl -s -X POST localhost:3210/api/advance \
  -H 'content-type: application/json' -d '{"budgetMs":250}'
```

## 测试

```bash
npm test
```

测试包含：

- 采样选择、跨时刻拼接警告、稀疏结论收回；
- 快照关联、资源描述、同快照环检测、超时不完整标记；
- 对真实本地 PostgreSQL 运行全部脚本：
  - 普通阻塞边与收敛；
  - B/C 入队和实际结算顺序；
  - 死锁环与 `40P01`；
  - 开销预算边界。

`scripts/test.sh` 默认使用独立数据库 `locklab_test`，避免集成测试重建表演示表时与正在运行的控制台（默认使用 `locklab`）互相等待锁。可用 `PGTEST_DATABASE=... npm test` 覆盖测试库名；如果显式设置了 `DATABASE_URL`，测试会原样使用该连接串指向的数据库。

## 目录

```text
server/config.js        PG/HTTP/预算配置
server/schema.js        三张小表和固定数据
server/diagnostics.js   单语句诊断 SQL、快照建模、SCC 环
server/analysis.js      降采样、证据评估、跨时刻拼接警告
server/lab.js           持久连接、脚本运行器、事件/句柄/样本
server/scenarios.js     可手动推进的复现脚本
server/server.js        零框架 HTTP API + 静态资源
public/                 原生 HTML/CSS/JS 控制台和 SVG 图
scripts/                用户态 PostgreSQL 引导/启停/检查
test/                   单元与真实 PG 集成测试
```

## 故障排查

- **连接失败**：运行 `npm run doctor`；确认 `npm run setup` 成功且 `npm run db:start`。
- **端口冲突**：用 `PGPORT` 改数据库端口、`PORT` 改 Web 端口。
- **死锁太快被裁决**：本地 `locklab` 超级用户可调大场景的 `deadlockTimeoutMs`；或在创建运行时传入更大值，并在最后一步等待检测器。
- **诊断预算太小**：调高 UI 中的毫秒上限；超时样本不会被当作图证据。
- **apt 镜像 502**：setup 会忽略部分索引错误并继续使用可用的 Debian main 索引；若仍失败，可设置 `LOCKLAB_PG_BIN` 指向已有 PG bin，或提供 `DATABASE_URL`。
