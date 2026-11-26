'use strict';

const { Pool } = require('pg');
const config = require('./config');

const DIAGNOSTIC_SQL = `
SELECT
  statement_timestamp() AS sample_at,
  a.pid,
  a.usename,
  a.application_name,
  a.client_addr::text AS client_addr,
  a.backend_start,
  a.xact_start,
  a.query_start,
  a.state_change,
  a.state,
  a.wait_event_type,
  a.wait_event,
  LEFT(a.query, 600) AS query,
  pg_blocking_pids(a.pid) AS blocker_pids,
  (EXTRACT(EPOCH FROM (clock_timestamp() - a.xact_start)) * 1000)::float AS xact_age_ms,
  (EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)) * 1000)::float AS query_age_ms,
  l.database AS lock_database_oid,
  l.relation AS lock_relation_oid,
  l.locktype,
  l.mode AS lock_mode,
  l.granted AS lock_granted,
  l.fastpath AS lock_fastpath,
  n.nspname AS lock_schema,
  c.relname AS lock_relation,
  l.page,
  l.tuple,
  l.virtualxid AS lock_virtualxid,
  l.transactionid::text AS lock_transactionid,
  l.classid AS lock_classid,
  l.objid AS lock_objid,
  l.objsubid AS lock_objsubid
FROM pg_stat_activity a
LEFT JOIN pg_locks l ON l.pid = a.pid
LEFT JOIN pg_class c ON c.oid = l.relation
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.datname = current_database()
  AND a.application_name LIKE $1
  AND a.application_name <> ALL($2::text[])
  AND a.pid <> pg_backend_pid()
ORDER BY a.pid, l.granted DESC NULLS LAST, l.locktype, l.mode
`;

function clampBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return config.budget.defaultMs;
  return Math.min(config.budget.maxMs, Math.max(config.budget.minMs, Math.round(n)));
}

function lockResourceKey(lock) {
  return [
    lock.locktype,
    lock.lock_database_oid ?? '',
    lock.lock_relation_oid ?? '',
    lock.page ?? '',
    lock.tuple ?? '',
    lock.lock_virtualxid ?? '',
    lock.lock_transactionid ?? '',
    lock.lock_classid ?? '',
    lock.lock_objid ?? '',
    lock.lock_objsubid ?? '',
  ].join(':');
}

function describeResource(lock) {
  if (!lock) return '未知资源';
  const qualifiedRelation = [lock.lock_schema, lock.lock_relation].filter(Boolean).join('.');

  switch (lock.locktype) {
    case 'transactionid':
      return `事务 ID ${lock.transactionid || '?'}`;
    case 'virtualxid':
      return `虚拟事务 ${lock.virtualxid || '?'}`;
    case 'tuple':
      return `行锁 ${qualifiedRelation || lock.lock_relation_oid || '?'} ctid=(${lock.page ?? '?'},${lock.tuple ?? '?'})`;
    case 'relation':
      return `表/索引锁 ${qualifiedRelation || lock.lock_relation_oid || 'pg_class OID ' + lock.lock_relation_oid}`;
    case 'page':
      return `页锁 ${qualifiedRelation || lock.lock_relation_oid || '?'} page=${lock.page ?? '?'}`;
    case 'object':
      return `对象锁 classid=${lock.lock_classid} objid=${lock.lock_objid} subid=${lock.lock_objsubid}`;
    case 'advisory':
      return `咨询锁 ${lock.lock_classid}/${lock.lock_objid}/${lock.lock_objsubid}`;
    default:
      return `${lock.locktype} ${lockResourceKey(lock)}`;
  }
}

function normalizeLock(row) {
  if (!row.locktype) return null;
  const lock = {
    locktype: row.locktype,
    mode: row.lock_mode,
    granted: row.lock_granted,
    fastpath: row.lock_fastpath,
    databaseOid: row.lock_database_oid == null ? null : Number(row.lock_database_oid),
    relationOid: row.lock_relation_oid == null ? null : Number(row.lock_relation_oid),
    schema: row.lock_schema,
    relation: row.lock_relation,
    page: row.page,
    tuple: row.tuple,
    virtualxid: row.lock_virtualxid,
    transactionid: row.lock_transactionid,
    classid: row.lock_classid == null ? null : Number(row.lock_classid),
    objid: row.lock_objid == null ? null : Number(row.lock_objid),
    objsubid: row.lock_objsubid == null ? null : Number(row.lock_objsubid),
  };
  lock.resourceKey = lockResourceKey({
    locktype: lock.locktype,
    lock_database_oid: lock.databaseOid,
    lock_relation_oid: lock.relationOid,
    page: lock.page,
    tuple: lock.tuple,
    lock_virtualxid: lock.virtualxid,
    lock_transactionid: lock.transactionid,
    lock_classid: lock.classid,
    lock_objid: lock.objid,
    lock_objsubid: lock.objsubid,
  });
  lock.resourceLabel = describeResource(lock);
  return lock;
}

function tarjanCycles(nodes, adjacency) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const low = new Map();
  const components = [];

  function strongConnect(v) {
    indexes.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) || []) {
      if (!indexes.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indexes.get(w)));
      }
    }

    if (low.get(v) === indexes.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!indexes.has(node)) strongConnect(node);
  }

  return components
    .filter((component) => component.length > 1 || (component.length === 1 && (adjacency.get(component[0]) || []).includes(component[0])))
    .map((component) => component.map(String));
}

function buildSnapshot({ rows = [], durationMs, budgetMs, timedOut = false, cancelled = false, error = null, sampleSeq = null, runId = null, reason = 'manual' }) {
  const sessions = new Map();
  let sampleAt = null;

  for (const row of rows) {
    sampleAt = sampleAt || row.sample_at;
    const pid = Number(row.pid);
    if (!sessions.has(pid)) {
      sessions.set(pid, {
        pid,
        name: row.application_name,
        applicationName: row.application_name,
        user: row.usename,
        clientAddr: row.client_addr,
        state: row.state,
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        query: row.query,
        backendStart: row.backend_start,
        xactStart: row.xact_start,
        queryStart: row.query_start,
        stateChange: row.state_change,
        xactAgeMs: row.xact_age_ms,
        queryAgeMs: row.query_age_ms,
        blockerPids: (row.blocker_pids || []).map(Number),
        locks: [],
        ungrantedLocks: [],
        waitingResources: [],
        scriptName: null,
        scriptRole: null,
        activeHandleId: null,
        scriptResourceHint: null,
      });
    }

    const session = sessions.get(pid);
    const lock = normalizeLock(row);
    if (lock) {
      session.locks.push(lock);
      if (!lock.granted) {
        session.ungrantedLocks.push(lock);
        session.waitingResources.push(lock.resourceLabel);
      }
    }
  }

  const edges = [];
  const edgeKeys = new Set();
  const warnings = [];

  for (const waiter of sessions.values()) {
    if (waiter.blockerPids.length === 0 && waiter.ungrantedLocks.length > 0) {
      warnings.push({
        code: 'UNRESOLVED_WAIT',
        pid: waiter.pid,
        message: `PID ${waiter.pid} 有未授予锁，但 pg_blocking_pids 未返回阻塞者`,
      });
    }

    for (const blockerPidRaw of waiter.blockerPids) {
      const blockerPid = Number(blockerPidRaw);
      if (!sessions.has(blockerPid)) {
        sessions.set(blockerPid, {
          pid: blockerPid,
          name: `external:${blockerPid}`,
          applicationName: null,
          external: true,
          state: 'unknown',
          blockerPids: [],
          locks: [],
          ungrantedLocks: [],
          waitingResources: [],
        });
        warnings.push({
          code: 'BLOCKER_OUTSIDE_FILTER',
          pid: blockerPid,
          message: `阻塞者 PID ${blockerPid} 不在 locklab 会话过滤范围内`,
        });
      }

      const blocker = sessions.get(blockerPid);
      const waitingLock = waiter.ungrantedLocks[0] || null;
      let heldLock = null;
      if (waitingLock) {
        heldLock = blocker.locks.find((lock) => lock.granted && lock.resourceKey === waitingLock.resourceKey) || null;
      }

      const key = `${blockerPid}->${waiter.pid}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);

      edges.push({
        id: key,
        // 依赖方向：waiter --waits_for--> blocker
        from: waiter.pid,
        to: blockerPid,
        waiterPid: waiter.pid,
        blockerPid,
        direction: 'waits_for',
        resource: waitingLock ? waitingLock.resourceLabel : (waiter.waitEvent ? `${waiter.waitEventType}/${waiter.waitEvent}` : '未知资源'),
        resourceKey: waitingLock ? waitingLock.resourceKey : null,
        requestedMode: waitingLock ? waitingLock.mode : null,
        heldMode: heldLock ? heldLock.mode : null,
        resourceMatch: Boolean(heldLock),
        waitingLock,
        heldLock,
        observedInSampleSeq: sampleSeq,
      });
    }
  }

  const nodes = [...sessions.values()].map((session) => ({
    pid: session.pid,
    name: session.scriptName || session.name,
    applicationName: session.applicationName,
    scriptName: session.scriptName,
    scriptRole: session.scriptRole,
    state: session.state,
    waitEventType: session.waitEventType,
    waitEvent: session.waitEvent,
    xactStart: session.xactStart,
    xactAgeMs: session.xactAgeMs,
    queryAgeMs: session.queryAgeMs,
    query: session.query,
    blockerPids: session.blockerPids,
    waitingResources: session.waitingResources,
    locks: session.locks,
    lockCount: session.locks.length,
    ungrantedCount: session.ungrantedLocks.length,
    activeHandleId: session.activeHandleId,
    scriptResourceHint: session.scriptResourceHint,
    external: Boolean(session.external),
  }));

  const adjacency = new Map(nodes.map((node) => [Number(node.pid), []]));
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const cycles = tarjanCycles([...adjacency.keys()], adjacency);
  const waitingPids = new Set(edges.map((edge) => edge.waiterPid));
  const blockerPidSet = new Set(edges.map((edge) => edge.blockerPid));

  if (cycles.length > 0) {
    warnings.push({ code: 'DEADLOCK_CYCLE', message: '同一原子快照中检测到等待环', cycles });
  }

  return {
    id: sampleSeq == null ? null : `s${sampleSeq}`,
    sampleSeq,
    runId,
    reason,
    capturedAt: sampleAt || new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    atomic: !timedOut && !error,
    evidenceBasis: 'single-statement pg_stat_activity + pg_locks + pg_blocking_pids',
    budgetMs,
    durationMs: Number(durationMs.toFixed(3)),
    overheadRatio: null,
    timedOut,
    cancelled,
    error: error ? { message: error.message, code: error.code || null } : null,
    incomplete: timedOut || Boolean(error),
    sessions: nodes,
    edges,
    cycles,
    warnings,
    counts: {
      sessions: nodes.length,
      edges: edges.length,
      waiting: waitingPids.size,
      blockers: blockerPidSet.size,
      cycles: cycles.length,
      ungrantedLocks: sessions ? [...sessions.values()].reduce((n, s) => n + s.ungrantedLocks.length, 0) : 0,
    },
    converged: !timedOut && !error && edges.length === 0 && cycles.length === 0,
  };
}

class Diagnostics {
  constructor(pgConfig = config.pg) {
    this.pool = new Pool({ ...pgConfig, application_name: 'locklab-diag', max: 4 });
    this.pool.on('error', (error) => {
      // 空闲连接错误不能使进程崩溃；/api/health 会暴露后续连接失败。
      console.error('[diagnostics-pool] idle client error:', error.message);
    });
  }

  async health() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT
          version() AS version,
          current_database() AS database,
          current_user AS user,
          now() AS now,
          current_setting('deadlock_timeout') AS deadlock_timeout
      `);
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async probeWait(pid) {
    const result = await this.pool.query(
      `SELECT
         a.state,
         a.wait_event_type AS "waitEventType",
         a.wait_event AS "waitEvent",
         pg_blocking_pids(a.pid) AS "blockerPids",
         EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted) AS "hasUngrantedLock"
       FROM pg_stat_activity a
       WHERE a.pid = $1`,
      [pid],
    );
    return result.rows[0] || null;
  }

  async collectSnapshot(options = {}) {
    const budgetMs = clampBudget(options.budgetMs);
    const sampleSeq = options.sampleSeq ?? null;
    const runId = options.runId ?? null;
    const reason = options.reason || 'manual';
    const started = process.hrtime.bigint();
    let client;
    let rows = [];
    let timedOut = false;
    let cancelled = false;
    let error = null;

    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['statement_timeout', String(budgetMs)]);
      const result = await client.query(DIAGNOSTIC_SQL, [config.diagnosticAppPrefix, config.diagnosticAppNames]);
      rows = result.rows;
      await client.query('COMMIT');
    } catch (caught) {
      error = caught;
      timedOut = caught.code === '57014';
      cancelled = caught.code === '57014' || /canceling statement due to statement timeout/i.test(caught.message);
      if (client) await client.query('ROLLBACK').catch(() => {});
    } finally {
      if (client) client.release();
    }

    const durationMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3));
    const snapshot = buildSnapshot({
      rows,
      durationMs,
      budgetMs,
      timedOut,
      cancelled,
      error,
      sampleSeq,
      runId,
      reason,
    });
    if (Number.isFinite(options.intervalMs) && options.intervalMs > 0) {
      snapshot.overheadRatio = Number((snapshot.durationMs / options.intervalMs).toFixed(5));
    }
    return snapshot;
  }

  async close() {
    await this.pool.end().catch(() => {});
  }
}

module.exports = {
  Diagnostics,
  buildSnapshot,
  clampBudget,
  describeResource,
  lockResourceKey,
};
