'use strict';

const { Client } = require('pg');
const config = require('./config');
const { SCHEMA_SQL } = require('./schema');
const { Diagnostics } = require('./diagnostics');
const { scenarios } = require('./scenarios');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializePgError(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: error.message,
    code: error.code || null,
    severity: error.severity || null,
    detail: error.detail || null,
    hint: error.hint || null,
    where: error.where || null,
  };
}

function publicHandle(handle) {
  if (!handle) return null;
  const { done, ...plain } = handle;
  void done;
  return plain;
}

class LockLab {
  constructor(options = {}) {
    this.pgConfig = options.pgConfig || config.pg;
    this.diagnostics = options.diagnostics || new Diagnostics(this.pgConfig);
    this.ownsDiagnostics = !options.diagnostics;
    this.run = null;
    this.operationQueue = Promise.resolve();
  }

  withOperation(operation) {
    const result = this.operationQueue.then(() => operation());
    this.operationQueue = result.catch(() => {});
    return result;
  }

  get handles() {
    return this.run?.handles || [];
  }

  listScenarios() {
    return Object.values(scenarios).map((scenario) => ({      id: scenario.id,
      name: scenario.name,
      summary: scenario.summary,
      teaching: scenario.teaching,
      defaultDeadlockTimeoutMs: scenario.defaultDeadlockTimeoutMs || null,
      sessions: scenario.sessions,
      steps: scenario.steps.map((step) => ({
        id: step.id,
        title: step.title,
        narration: step.narration || '',
      })),
    }));
  }

  async health() {
    return this.diagnostics.health();
  }

  async createRun(scenarioId = 'normal-block', options = {}) {
    return this.withOperation(() => this._createRun(scenarioId, options));
  }

  async resetCurrentRun(options = {}) {
    const scenarioId = this.run?.scenarioId || options.scenarioId || 'normal-block';
    return this.createRun(scenarioId, options);
  }

  async _createRun(scenarioId, options) {
    const scenario = scenarios[scenarioId];
    if (!scenario) {
      const error = new Error(`未知场景: ${scenarioId}`);
      error.statusCode = 400;
      throw error;
    }

    await this._closeSessions('reset');

    const budgetMs = Number(options.budgetMs || this.run?.budgetMs || config.budget.defaultMs);
    const deadlockTimeoutMs = Number(
      options.deadlockTimeoutMs || scenario.defaultDeadlockTimeoutMs || 4000,
    );

    const run = {
      runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      scenarioId,
      scenarioName: scenario.name,
      status: 'initializing',
      createdAt: new Date().toISOString(),
      stepIndex: 0,
      advancing: false,
      budgetMs,
      deadlockTimeoutMs,
      sessions: new Map(),
      handles: [],
      events: [],
      samples: [],
      stepResults: [],
      sampleSeq: 0,
      eventSeq: 0,
      handleSeq: 0,
      settlementSeq: 0,
      lastSnapshot: null,
      lastError: null,
    };
    this.run = run;

    this.emit('run:create', `创建可复现运行：${scenario.name}`, { scenarioId, deadlockTimeoutMs });

    try {
      const schemaClient = await this.diagnostics.pool.connect();
      try {
        await schemaClient.query('BEGIN');
        await schemaClient.query('SET LOCAL lock_timeout = 5000');
        await schemaClient.query('SET LOCAL statement_timeout = 15000');
        await schemaClient.query(SCHEMA_SQL);
        await schemaClient.query('COMMIT');
      } catch (schemaError) {
        await schemaClient.query('ROLLBACK').catch(() => {});
        if (schemaError.code === '55P03') {
          schemaError.message = `重置演示表时等待锁超时：可能有另一个控制台/测试进程正在使用同一数据库。请停止它或使用独立 PGDATABASE。原始错误：${schemaError.message}`;
        }
        throw schemaError;
      } finally {
        schemaClient.release();
      }
      this.emit('schema:ready', '三张演示小表已重建并写入固定初始数据');

      for (const spec of scenario.sessions) {
        await this._connectSession(spec, deadlockTimeoutMs);
      }

      run.status = 'ready';
      this.emit('run:ready', `${scenario.sessions.length} 个 PostgreSQL 连接已就绪`);
      run.lastSnapshot = await this.takeSnapshot({ reason: 'run-ready', budgetMs });
      return this.getState();
    } catch (error) {
      run.status = 'error';
      run.lastError = serializePgError(error);
      this.emit('run:error', error.message, { error: run.lastError });
      throw error;
    }
  }

  async _connectSession(spec, deadlockTimeoutMs) {
    const run = this.run;
    const client = new Client({
      ...this.pgConfig,
      application_name: `locklab-session-${spec.name.toLowerCase()}`,
    });
    client.on('error', (error) => {
      this.emit('connection:error', `会话 ${spec.name} 连接错误：${error.message}`, {
        session: spec.name,
        error: serializePgError(error),
      });
      const session = run.sessions.get(spec.name);
      if (session) session.lastError = serializePgError(error);
    });

    await client.connect();
    const pidResult = await client.query('SELECT pg_backend_pid() AS pid');
    const pid = Number(pidResult.rows[0].pid);
    try {
      await client.query('SELECT set_config($1, $2, false)', ['deadlock_timeout', `${deadlockTimeoutMs}ms`]);
    } catch (error) {
      // Some managed PostgreSQL roles are not allowed to alter this GUC.
      // The server/system value still reproduces the deadlock; only the requested
      // detector delay may differ.
      if (error.code !== '42501') throw error;
      this.emit('setting:readonly', `${spec.name} 不能设置 deadlock_timeout，继续使用服务器默认值`, {
        session: spec.name,
        requestedDeadlockTimeoutMs: deadlockTimeoutMs,
      });
    }

    const session = {
      name: spec.name,
      label: spec.label,
      role: spec.role || null,
      pid,
      client,
      connected: true,
      activeHandleId: null,
      lastError: null,
    };
    run.sessions.set(spec.name, session);
    this.emit('session:connect', `${spec.name} 已连接，PostgreSQL PID=${pid}`, {
      session: spec.name,
      pid,
      role: spec.role,
    });
    return session;
  }

  async _closeSessions(reason = 'close') {
    const run = this.run;
    if (!run) return;
    for (const session of run.sessions.values()) {
      try {
        if (session.pid) {
          await this.diagnostics.pool.query('SELECT pg_cancel_backend($1)', [session.pid]).catch(() => {});
        }
      } catch {
        // 管理池不可用时仍尝试直接关闭客户端。
      }
      try {
        await Promise.race([
          session.client.end(),
          sleep(700),
        ]);
      } catch {
        // 关闭旧连接时忽略。
      }
      session.connected = false;
      this.emit('session:close', `会话 ${session.name} 已关闭（${reason}）`, { session: session.name, pid: session.pid });
    }
    run.sessions.clear();
  }

  emit(type, message, data = {}) {
    if (!this.run) return null;
    const event = {
      id: ++this.run.eventSeq,
      at: new Date().toISOString(),
      mono: Number(process.hrtime.bigint() / 1000000n),
      type,
      message,
      ...data,
    };
    this.run.events.push(event);
    if (this.run.events.length > 600) this.run.events.splice(0, this.run.events.length - 600);
    return event;
  }

  getSession(name) {
    const session = this.run?.sessions.get(name);
    if (!session) {
      const error = new Error(`会话不存在: ${name}`);
      error.statusCode = 400;
      throw error;
    }
    return session;
  }

  async query(name, text, params = [], meta = {}) {
    const session = this.getSession(name);
    this.emit('sql:execute', `${name} 执行${meta.label ? `「${meta.label}」` : ' SQL'}`, {
      session: name,
      pid: session.pid,
      label: meta.label || null,
      resource: meta.resource || null,
      sql: text,
    });
    try {
      const result = await session.client.query(text, params);
      return { rowCount: result.rowCount, rows: result.rows };
    } catch (error) {
      this.emit('sql:error', `${name} SQL 错误：${error.message}`, {
        session: name,
        pid: session.pid,
        code: error.code || null,
        error: serializePgError(error),
      });
      throw error;
    }
  }

  begin(name) {
    return this.query(name, 'BEGIN');
  }

  commit(name) {
    return this.query(name, 'COMMIT');
  }

  rollback(name) {
    return this.query(name, 'ROLLBACK');
  }

  startQuery(name, label, text, params = [], meta = {}) {
    const run = this.run;
    const session = this.getSession(name);
    if (session.activeHandleId) {
      throw new Error(`会话 ${name} 已有未结束的脚本语句`);
    }

    const handle = {
      id: `h${++run.handleSeq}`,
      sessionName: name,
      pid: session.pid,
      label,
      resource: meta.resource || null,
      sql: text,
      status: 'pending',
      startedAt: new Date().toISOString(),
      startedMono: Number(process.hrtime.bigint() / 1000000n),
      settledAt: null,
      settledMono: null,
      settlementRank: null,
      rowCount: null,
      error: null,
      done: null,
      resolveDone: null,
    };
    handle.done = new Promise((resolve) => {
      handle.resolveDone = resolve;
    });

    run.handles.push(handle);
    session.activeHandleId = handle.id;
    this.emit('sql:start', `${name} 开始执行「${label}」`, {
      handleId: handle.id,
      session: name,
      pid: session.pid,
      resource: handle.resource,
      sql: text,
    });

    const execution = session.client.query(text, params);
    execution.then(
      (result) => this._finishHandle(handle, session, {
        status: 'resolved',
        rowCount: result.rowCount,
      }),
      (error) => this._finishHandle(handle, session, {
        status: 'rejected',
        error: serializePgError(error),
      }),
    );

    return handle;
  }

  _finishHandle(handle, session, fields) {
    if (handle.status !== 'pending') return;
    Object.assign(handle, fields);
    handle.settledAt = new Date().toISOString();
    handle.settledMono = Number(process.hrtime.bigint() / 1000000n);
    handle.settlementRank = ++this.run.settlementSeq;
    if (session.activeHandleId === handle.id) session.activeHandleId = null;

    this.emit(
      fields.status === 'resolved' ? 'sql:settle' : 'sql:reject',
      fields.status === 'resolved'
        ? `${handle.sessionName} 的「${handle.label}」已结束（结算顺序 #${handle.settlementRank}）`
        : `${handle.sessionName} 的「${handle.label}」被 PostgreSQL 拒绝：${handle.error?.message || '未知错误'}`,
      {
        handleId: handle.id,
        session: handle.sessionName,
        pid: handle.pid,
        status: handle.status,
        code: handle.error?.code || null,
        settlementRank: handle.settlementRank,
        resource: handle.resource,
      },
    );

    if (handle.error?.code === '40P01') {
      this.emit('postgres:deadlock', `PostgreSQL 死锁检测器中止了 ${handle.sessionName}（PID ${handle.pid}）`, {
        victimSession: handle.sessionName,
        victimPid: handle.pid,
        sqlstate: '40P01',
        handleId: handle.id,
      });
    }
    handle.resolveDone?.(handle);
  }

  async probeWait(pid) {
    return this.diagnostics.probeWait(pid);
  }

  async waitUntilBlocked(handle, timeoutMs = 10000) {
    const target = typeof handle === 'string' ? this.getActiveHandle(handle) : handle;
    if (!target) throw new Error('waitUntilBlocked 缺少语句句柄');
    const deadline = Date.now() + timeoutMs;
    let lastProbe = null;

    while (Date.now() < deadline) {
      if (target.status !== 'pending') {
        const error = new Error(`语句在观察到锁等待前已经${target.status === 'resolved' ? '完成' : '失败'}`);
        error.handle = publicHandle(target);
        throw error;
      }

      lastProbe = await this.probeWait(target.pid).catch(() => null);
      const blocked = lastProbe && (
        Number(lastProbe.blockerPids?.length || 0) > 0 || lastProbe.hasUngrantedLock === true
      );
      if (blocked) {
        await sleep(45);
        const stable = await this.probeWait(target.pid).catch(() => lastProbe);
        if (stable && (Number(stable.blockerPids?.length || 0) > 0 || stable.hasUngrantedLock)) {
          this.emit('lock:wait-confirmed', `${target.sessionName} 已进入稳定锁等待`, {
            handleId: target.id,
            session: target.sessionName,
            pid: target.pid,
            blockers: (stable.blockerPids || []).map(Number),
            waitEvent: stable.waitEvent,
          });
          return stable;
        }
      }
      await sleep(20);
    }
    throw new Error(`等待 ${target.sessionName} 进入锁等待超时；最后探测：${JSON.stringify(lastProbe)}`);
  }

  getActiveHandle(sessionName) {
    const session = this.getSession(sessionName);
    return this.run.handles.find((h) => h.id === session.activeHandleId) || null;
  }

  async waitUntilSettled(handle, timeoutMs = 15000) {
    const target = typeof handle === 'string' ? this.run.handles.find((h) => h.id === handle) : handle;
    if (!target) throw new Error('waitUntilSettled 缺少语句句柄');
    if (target.status !== 'pending') return target;

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等待语句 ${target.id} 结算超时`)), timeoutMs);
    });
    try {
      await Promise.race([target.done, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return target;
  }

  sleep(ms) {
    return sleep(ms);
  }

  async advance(options = {}) {
    return this.withOperation(() => this._advance(options));
  }

  async _advance(options) {
    const run = this.run;
    if (!run) {
      const error = new Error('尚未创建运行');
      error.statusCode = 409;
      throw error;
    }
    if (run.advancing) {
      const error = new Error('已有脚本步骤正在推进');
      error.statusCode = 409;
      throw error;
    }
    const scenario = scenarios[run.scenarioId];
    const step = scenario.steps[run.stepIndex];
    if (!step) {
      run.status = 'completed';
      return this.getState();
    }

    run.advancing = true;
    run.status = 'advancing';
    this.emit('step:start', `步骤 ${run.stepIndex + 1}/${scenario.steps.length}：${step.title}`, { stepId: step.id });
    const started = Date.now();

    try {
      const result = await step.run(this, options);
      run.stepResults.push({
        index: run.stepIndex,
        id: step.id,
        title: step.title,
        ok: true,
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        result: result || null,
      });
      run.stepIndex += 1;
      run.status = run.stepIndex >= scenario.steps.length ? 'completed' : 'ready';
      this.emit('step:done', `步骤完成：${step.title}`, { stepId: step.id, result: result || null });
      run.lastSnapshot = await this.takeSnapshot({ reason: `after-step:${step.id}`, budgetMs: options.budgetMs });
      return this.getState();
    } catch (error) {
      const serialized = serializePgError(error);
      run.stepResults.push({
        index: run.stepIndex,
        id: step.id,
        title: step.title,
        ok: false,
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        error: serialized,
      });
      run.status = 'error';
      run.lastError = serialized;
      this.emit('step:error', `步骤失败：${error.message}`, { stepId: step.id, error: serialized });
      run.lastSnapshot = await this.takeSnapshot({ reason: `step-error:${step.id}` }).catch(() => run.lastSnapshot);
      error.state = this.getState();
      throw error;
    } finally {
      run.advancing = false;
    }
  }

  async updateSettings(patch = {}) {
    return this.withOperation(async () => {
      if (!this.run) {
        const error = new Error('尚未创建运行');
        error.statusCode = 409;
        throw error;
      }
      if (patch.budgetMs != null) {
        const { clampBudget } = require('./diagnostics');
        this.run.budgetMs = clampBudget(patch.budgetMs);
      }
      if (patch.deadlockTimeoutMs != null) {
        this.run.deadlockTimeoutMs = Math.min(30000, Math.max(50, Number(patch.deadlockTimeoutMs) || 4000));
      }
      return this.getState();
    });
  }

  async takeSnapshot(options = {}) {
    if (!this.run) throw new Error('尚未创建运行');
    const run = this.run;
    run.sampleSeq += 1;
    const snapshot = await this.diagnostics.collectSnapshot({
      budgetMs: options.budgetMs || run.budgetMs,
      intervalMs: options.intervalMs,
      sampleSeq: run.sampleSeq,
      runId: run.runId,
      reason: options.reason || 'manual',
    });
    this.decorateSnapshot(snapshot);
    run.samples.push(snapshot);
    if (run.samples.length > 1600) run.samples.splice(0, run.samples.length - 1600);
    run.lastSnapshot = snapshot;
    return snapshot;
  }

  decorateSnapshot(snapshot) {
    const run = this.run;
    if (!run) return snapshot;
    const pidToName = new Map();
    for (const session of run.sessions.values()) pidToName.set(session.pid, session.name);

    for (const node of snapshot.sessions) {
      const session = [...run.sessions.values()].find((s) => s.pid === node.pid);
      if (session) {
        node.scriptName = session.name;
        node.name = session.name;
        node.scriptLabel = session.label;
        node.scriptRole = session.role;
        node.activeHandleId = session.activeHandleId;
        const handle = run.handles.find((h) => h.id === session.activeHandleId);
        node.scriptResourceHint = handle?.resource || null;
        node.activeHandleLabel = handle?.label || null;
      }
    }

    for (const edge of snapshot.edges) {
      edge.waiterName = pidToName.get(edge.waiterPid) || `PID ${edge.waiterPid}`;
      edge.blockerName = pidToName.get(edge.blockerPid) || `PID ${edge.blockerPid}`;
      const waiterNode = snapshot.sessions.find((n) => n.pid === edge.waiterPid);
      const handle = run.handles.find((h) => h.id === waiterNode?.activeHandleId);
      edge.resourceHint = handle?.resource || waiterNode?.scriptResourceHint || null;
      edge.title = `${edge.waiterName} waits for ${edge.blockerName}`;
    }

    snapshot.pidToName = Object.fromEntries(pidToName);
    return snapshot;
  }

  getSamples(options = {}) {
    const samples = this.run?.samples || [];
    const limit = Math.min(1000, Math.max(1, Number(options.limit) || 200));
    return samples.slice(-limit);
  }

  getAnalysis(query = {}) {
    if (!this.run) return null;
    const { evaluateSampling } = require('./analysis');
    const pidToName = new Map();
    for (const session of this.run.sessions.values()) pidToName.set(session.pid, session.name);
    return evaluateSampling({
      samples: this.run.samples,
      handles: this.run.handles.map(publicHandle),
      pidToName,
      stride: query.stride || 1,
      minIntervalMs: query.minIntervalMs,
    });
  }

  getState() {
    if (!this.run) {
      return {
        active: false,
        scenarios: this.listScenarios(),
        budget: config.budget,
      };
    }
    const run = this.run;
    const scenario = scenarios[run.scenarioId];
    const pidToName = {};
    for (const session of run.sessions.values()) pidToName[session.pid] = session.name;

    return {
      active: true,
      runId: run.runId,
      scenarioId: run.scenarioId,
      scenarioName: run.scenarioName,
      status: run.status,
      createdAt: run.createdAt,
      stepIndex: run.stepIndex,
      totalSteps: scenario.steps.length,
      advancing: run.advancing,
      budgetMs: run.budgetMs,
      deadlockTimeoutMs: run.deadlockTimeoutMs,
      sampleCount: run.samples.length,
      pidToName,
      sessions: [...run.sessions.values()].map((s) => ({
        name: s.name,
        label: s.label,
        role: s.role,
        pid: s.pid,
        connected: s.connected,
        activeHandleId: s.activeHandleId,
        lastError: s.lastError,
      })),
      handles: run.handles.map(publicHandle),
      events: run.events.slice(-160),
      stepResults: run.stepResults,
      script: scenario.steps.map((step, index) => ({
        id: step.id,
        index,
        title: step.title,
        narration: step.narration || '',
        state: index < run.stepIndex ? 'done' : index === run.stepIndex ? (run.advancing ? 'running' : 'next') : 'pending',
      })),
      latestSnapshot: run.lastSnapshot,
      budgetLimits: config.budget,
    };
  }

  async close() {
    if (this.run) await this._closeSessions('shutdown');
    if (this.ownsDiagnostics) await this.diagnostics.close();
  }
}

module.exports = { LockLab, sleep, serializePgError };
