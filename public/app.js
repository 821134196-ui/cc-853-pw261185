'use strict';

const $ = (selector) => document.querySelector(selector);

const ui = {
  healthCard: $('#healthCard'), healthDot: $('#healthDot'), healthTitle: $('#healthTitle'), healthMeta: $('#healthMeta'),
  scenarioSelect: $('#scenarioSelect'), budgetMs: $('#budgetMs'), intervalMs: $('#intervalMs'),
  advanceBtn: $('#advanceBtn'), sampleBtn: $('#sampleBtn'), autoBtn: $('#autoBtn'), denseTraceBtn: $('#denseTraceBtn'), resetBtn: $('#resetBtn'),
  refreshStateBtn: $('#refreshStateBtn'), controlHint: $('#controlHint'),
  runStatusPill: $('#runStatusPill'), scenarioSummary: $('#scenarioSummary'), stepList: $('#stepList'), teachingBox: $('#teachingBox'),
  winnerPanel: $('#winnerPanel'), sampleBadges: $('#sampleBadges'), atomicBanner: $('#atomicBanner'), graph: $('#lockGraph'),
  sessionTableBody: $('#sessionTableBody'), locksTableBody: $('#locksTableBody'),
  strideRange: $('#strideRange'), strideValue: $('#strideValue'), minIntervalSelect: $('#minIntervalSelect'),
  analysisStats: $('#analysisStats'), samplingRule: $('#samplingRule'), judgmentList: $('#judgmentList'),
  stitchedPanel: $('#stitchedPanel'), eventList: $('#eventList'),
};

let scenarios = [];
let state = null;
let analysis = null;
let autoEnabled = false;
let autoTimer = null;
let requestInFlight = false;
let traceActive = false;
let traceTimer = null;
let traceSampling = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  const n = Number(ms);
  if (n < 1000) return `${n.toFixed(0)} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(2)} s`;
  const m = Math.floor(n / 60000);
  const s = ((n % 60000) / 1000).toFixed(1);
  return `${m}m${s}s`;
}

function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function sessionColor(name, index = 0) {
  if (name === 'A') return 'var(--blue)';
  if (name === 'B') return 'var(--orange)';
  if (name === 'C') return 'var(--aqua)';
  if (name === 'D') return 'var(--violet)';
  return ['var(--blue)', 'var(--orange)', 'var(--aqua)', 'var(--violet)'][index % 4];
}

function pidToDisplayName(pid) {
  if (!state) return `PID ${pid}`;
  return state.pidToName?.[pid] || state.sessions?.find((s) => s.pid === Number(pid))?.name || `PID ${pid}`;
}

function setHint(message, isError = false) {
  ui.controlHint.textContent = message;
  ui.controlHint.style.color = isError ? 'var(--critical)' : '';
}

async function loadScenarios() {
  const payload = await api('/api/scenarios');
  scenarios = payload.scenarios || [];
  ui.scenarioSelect.innerHTML = scenarios
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
    .join('');
}

async function refreshHealth() {
  try {
    const health = await api('/api/health');
    if (health.ok === false) throw new Error(health.error || 'database unavailable');
    ui.healthDot.className = 'health-dot ok';
    ui.healthTitle.textContent = 'PostgreSQL 已连接';
    ui.healthMeta.textContent = `${health.user} @ ${health.database} · deadlock_timeout=${health.deadlock_timeout}`;
  } catch (error) {
    ui.healthDot.className = 'health-dot bad';
    ui.healthTitle.textContent = 'PostgreSQL 不可用';
    ui.healthMeta.textContent = error.message;
  }
}

async function refreshState(render = true) {
  state = await api('/api/state');
  if (render) renderAll();
  return state;
}

async function refreshAnalysis() {
  if (!state?.active) {
    analysis = null;
    renderAnalysis();
    return;
  }
  const params = new URLSearchParams({ stride: ui.strideRange.value });
  if (ui.minIntervalSelect.value !== '0') params.set('minIntervalMs', ui.minIntervalSelect.value);
  analysis = await api(`/api/analysis?${params}`);
  renderAnalysis();
}

function renderAll() {
  renderControls();
  renderScript();
  renderSnapshot();
  renderWinner();
  renderEvents();
  renderAnalysis().catch(() => {});
}

function renderControls() {
  if (!state) return;
  if (state.active) {
    ui.scenarioSelect.value = state.scenarioId;
    if (document.activeElement !== ui.budgetMs) ui.budgetMs.value = state.budgetMs || 250;
    ui.runStatusPill.textContent = state.status;
    ui.runStatusPill.className = `pill ${state.status}`;
    ui.advanceBtn.disabled = traceActive || Boolean(state.advancing) || requestInFlight || state.status === 'completed';
    ui.advanceBtn.textContent = state.status === 'completed' ? '脚本已完成' : `推进下一步（${state.stepIndex + 1}/${state.totalSteps}）`;
  } else {
    ui.runStatusPill.textContent = '无运行';
    ui.advanceBtn.disabled = true;
  }
  ui.sampleBtn.disabled = requestInFlight;
  ui.resetBtn.disabled = requestInFlight || traceActive;
  ui.denseTraceBtn.disabled = traceActive;
  ui.scenarioSelect.disabled = traceActive;
}

function renderScript() {
  const scenario = scenarios.find((s) => s.id === state?.scenarioId);
  ui.scenarioSummary.textContent = scenario?.summary || state?.scenarioName || '';
  ui.teachingBox.textContent = scenario?.teaching || '';
  const steps = state?.script || scenario?.steps || [];
  ui.stepList.innerHTML = steps.map((step) => `
    <li class="step-item ${escapeHtml(step.state || 'pending')}">
      <div class="step-index">${step.state === 'done' ? '✓' : step.index + 1}</div>
      <div>
        <div class="step-title">${escapeHtml(step.title)}</div>
        <div class="step-narration">${escapeHtml(step.narration || '')}</div>
      </div>
    </li>
  `).join('');
}

function snapshotBadges(snap) {
  if (!snap) return '<span class="badge warn">尚无样本</span>';
  const badges = [
    `<span class="badge">#${snap.sampleSeq ?? '?'} ${escapeHtml(snap.reason || '')}</span>`,
    `<span class="badge ${snap.incomplete ? 'bad' : 'good'}">${snap.incomplete ? '不完整' : '单语句原子样本'}</span>`,
    `<span class="badge">查询 ${formatMs(snap.durationMs)}</span>`,
    `<span class="badge">上限 ${formatMs(snap.budgetMs)}</span>`,
    `<span class="badge ${snap.overheadRatio && snap.overheadRatio > 0.2 ? 'warn' : ''}">开销占比 ${snap.overheadRatio === null ? '—' : `${(snap.overheadRatio * 100).toFixed(1)}%`}</span>`,
  ];
  if (snap.counts) badges.push(`<span class="badge ${snap.counts.cycles ? 'bad' : ''}">边 ${snap.counts.edges} · 环 ${snap.counts.cycles}</span>`);
  return badges.join('');
}

function renderSnapshot() {
  const snap = state?.latestSnapshot;
  ui.sampleBadges.innerHTML = snapshotBadges(snap);
  if (!snap) {
    ui.atomicBanner.className = 'atomic-banner bad';
    ui.atomicBanner.innerHTML = '尚未采集诊断样本。';
  } else if (snap.incomplete) {
    ui.atomicBanner.className = 'atomic-banner bad';
    ui.atomicBanner.innerHTML = `<strong>该样本不完整，不能用于构图：</strong>${escapeHtml(snap.error?.message || 'statement timeout')}。请放宽开销上限后立即重采。`;
  } else {
    ui.atomicBanner.className = 'atomic-banner';
    ui.atomicBanner.innerHTML = `<strong>样本 #${snap.sampleSeq}：</strong>${formatDateTime(snap.capturedAt)} 采集；图中所有边、资源和环均来自这一条诊断查询，不与其他时刻拼接。`;
  }
  renderGraph(snap);
  renderSessionTable(snap);
  renderLocksTable(snap);
}

function graphPositions(snap) {
  const width = 820;
  const known = state?.sessions || [];
  const positions = new Map();
  const count = Math.max(known.length, snap?.sessions?.length || 0, 1);
  const xs = count <= 2 ? [190, 630] : count === 3 ? [130, 410, 690] : Array.from({ length: count }, (_, i) => 90 + i * (640 / Math.max(1, count - 1)));
  known.forEach((session, index) => positions.set(Number(session.pid), { x: xs[index] ?? 100 + index * 180, y: 185, session, knownIndex: index }));

  for (const node of snap?.sessions || []) {
    const pid = Number(node.pid);
    if (!positions.has(pid)) {
      const index = positions.size;
      positions.set(pid, { x: width / 2, y: index % 2 ? 315 : 330, session: node, knownIndex: index });
    }
  }
  return positions;
}

function boundaryPoint(cx, cy, angle, halfW = 96, halfH = 48) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const radius = 1 / Math.sqrt((cos * cos) / (halfW * halfW) + (sin * sin) / (halfH * halfH));
  return { x: cx + cos * radius, y: cy + sin * radius };
}

function labelWidth(label) {
  return [...String(label)].reduce((width, char) => width + (/[一-鿿]/.test(char) ? 11 : 6.3), 0) + 18;
}

function renderGraph(snap) {
  const svg = ui.graph;
  if (!snap || snap.incomplete) {
    svg.innerHTML = `
      <text x="410" y="190" text-anchor="middle" class="node-state">${snap?.incomplete ? '样本不完整：拒绝绘制可能失真的依赖图' : '暂无快照'}</text>`;
    return;
  }

  const positions = graphPositions(snap);
  const cyclePids = new Set((snap.cycles || []).flat().map(Number));
  const blockerPids = new Set((snap.edges || []).map((e) => Number(e.blockerPid)));
  const waiterPids = new Set((snap.edges || []).map((e) => Number(e.waiterPid)));
  const pairGroups = new Map();

  for (const edge of snap.edges || []) {
    const a = Math.min(edge.waiterPid, edge.blockerPid);
    const b = Math.max(edge.waiterPid, edge.blockerPid);
    const key = `${a}:${b}`;
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key).push(edge);
  }

  const defs = `
    <defs>
      <marker id="arrow-normal" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path class="marker-normal" d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
      <marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path class="marker-cycle" d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
    </defs>`;

  const edgeElements = [];
  for (const group of pairGroups.values()) {
    group.forEach((edge, groupIndex) => {
      const source = positions.get(Number(edge.waiterPid));
      const target = positions.get(Number(edge.blockerPid));
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const angle = Math.atan2(dy, dx);
      const start = boundaryPoint(source.x, source.y, angle);
      const end = boundaryPoint(target.x, target.y, angle + Math.PI);
      const length = Math.hypot(dx, dy) || 1;
      const normalX = -dy / length;
      const normalY = dx / length;
      const count = group.length;
      const curve = count === 1 ? 0 : (groupIndex - (count - 1) / 2) * 54;
      const cx = (start.x + end.x) / 2 + normalX * curve;
      const cy = (start.y + end.y) / 2 + normalY * curve;
      const labelX = 0.25 * start.x + 0.5 * cx + 0.25 * end.x;
      const labelY = 0.25 * start.y + 0.5 * cy + 0.25 * end.y;
      const inCycle = (snap.cycles || []).some((cycle) => cycle.map(Number).includes(Number(edge.waiterPid)) && cycle.map(Number).includes(Number(edge.blockerPid)));
      const cls = `graph-edge ${inCycle ? 'cycle' : ''} ${edge.resourceMatch === false ? 'unmatched' : ''}`;
      const marker = inCycle ? 'url(#arrow-cycle)' : 'url(#arrow-normal)';
      const label = edge.resourceHint || edge.resource || 'lock';
      const width = Math.min(250, labelWidth(label));
      edgeElements.push(`
        <path class="${cls}" d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}" marker-end="${marker}">
          <title>${escapeHtml(edge.waiterName)} → ${escapeHtml(edge.blockerName)}&#10;${escapeHtml(edge.resource)}&#10;${escapeHtml(edge.requestedMode || '')} → ${escapeHtml(edge.heldMode || '')}</title>
        </path>
        <g>
          <rect class="edge-label-bg" x="${(labelX - width / 2).toFixed(1)}" y="${(labelY - 11).toFixed(1)}" width="${width}" height="21" rx="10"></rect>
          <text class="edge-label" x="${labelX.toFixed(1)}" y="${(labelY + 3.5).toFixed(1)}" text-anchor="middle">${escapeHtml(label.length > 30 ? `${label.slice(0, 29)}…` : label)}</text>
        </g>
      `);
    });
  }

  const nodeElements = [...positions.entries()].map(([pid, pos]) => {
    const session = pos.session || {};
    const name = session.scriptName || session.name || pidToDisplayName(pid);
    const color = sessionColor(name, pos.knownIndex);
    const inCycle = cyclePids.has(pid);
    const isBlocker = blockerPids.has(pid);
    const isWaiter = waiterPids.has(pid);
    const stateText = session.state || 'unknown';
    const age = session.xactAgeMs === null || session.xactAgeMs === undefined ? '无打开事务' : `xact ${formatMs(session.xactAgeMs)}`;
    return `
      <g class="graph-node ${inCycle ? 'cycle' : ''}" transform="translate(${pos.x},${pos.y})">
        <rect class="node-box" x="-92" y="-43" width="184" height="86" rx="16"></rect>
        <rect class="identity-bar" x="-92" y="-43" width="8" height="86" style="fill:${color}"></rect>
        <text class="node-name" x="-72" y="-17">${escapeHtml(name)}</text>
        <text class="node-pid" x="-72" y="2">PID ${pid}</text>
        <text class="node-state" x="-72" y="20">${escapeHtml(String(stateText).slice(0, 24))}</text>
        <text class="node-age" x="-72" y="37">${escapeHtml(age)}</text>
        <g class="node-badges">
          ${isBlocker ? `<circle cx="58" cy="-25" r="12" style="fill:var(--orange)"></circle><text x="58" y="-21" text-anchor="middle" fill="#fff">阻</text>` : ''}
          ${isWaiter ? `<circle cx="${isBlocker ? 30 : 58}" cy="-25" r="12" style="fill:var(--blue)"></circle><text x="${isBlocker ? 30 : 58}" y="-21" text-anchor="middle" fill="#fff">等</text>` : ''}
          ${inCycle ? `<text x="72" y="38" text-anchor="end" fill="var(--critical)" style="font-weight:900;font-size:11px">DEADLOCK</text>` : ''}
        </g>
      </g>`;
  }).join('');

  const empty = (snap.edges || []).length === 0 ? `
    <g>
      <rect x="250" y="145" width="320" height="78" rx="18" fill="var(--surface)" stroke="var(--good)" stroke-width="1.5"></rect>
      <text x="410" y="177" text-anchor="middle" style="font-size:18px;font-weight:850;fill:var(--good)">无等待边 · 图已收敛</text>
      <text x="410" y="202" text-anchor="middle" class="node-state">该原子样本中没有 pg_blocking_pids / 死锁环</text>
    </g>` : '';

  svg.innerHTML = defs + edgeElements.join('') + nodeElements + empty;
}

function renderSessionTable(snap) {
  const rows = (state?.sessions || []).map((session) => {
    const node = snap?.sessions?.find((n) => Number(n.pid) === Number(session.pid));
    const blockerNames = (node?.blockerPids || []).map((pid) => pidToDisplayName(pid));
    const isWaiter = (node?.blockerPids || []).length > 0 || (node?.ungrantedCount || 0) > 0;
    const isBlocker = (snap?.edges || []).some((e) => Number(e.blockerPid) === session.pid);
    const inCycle = (snap?.cycles || []).some((c) => c.map(Number).includes(session.pid));
    const resource = node?.waitingResources?.[0] || '—';
    return `
      <tr>
        <td><span class="session-chip"><i style="--session-color:${sessionColor(session.name)};background:${sessionColor(session.name)}"></i>${escapeHtml(session.name)}</span><div class="muted small">${escapeHtml(session.label || '')}</div></td>
        <td class="mono">${session.pid}</td>
        <td>${escapeHtml(node?.state || '—')}<div class="muted small">${escapeHtml(node?.waitEventType ? `${node.waitEventType}/${node.waitEvent}` : '')}</div></td>
        <td class="mono">${formatTime(node?.xactStart)}</td>
        <td class="mono">${formatMs(node?.xactAgeMs)}</td>
        <td>${node?.waitEvent ? `<span class="tag wait">${escapeHtml(node.waitEvent)}</span>` : '—'}</td>
        <td>${blockerNames.length ? blockerNames.map((n) => `<span class="tag block">${escapeHtml(n)}</span>`).join(' ') : '—'}</td>
        <td>${isWaiter ? `<span class="tag wait">等待</span> ${escapeHtml(resource)}` : '—'}${node?.waitingResources?.[1] ? `<div class="muted small">${escapeHtml(node.waitingResources[1])}</div>` : ''}</td>
        <td>${node?.scriptResourceHint ? escapeHtml(node.scriptResourceHint) : '—'}<div>${isBlocker ? '<span class="tag block">阻塞者</span>' : ''} ${inCycle ? '<span class="tag cycle">环中</span>' : ''}</div></td>
      </tr>`;
  }).join('');
  ui.sessionTableBody.innerHTML = rows || `<tr><td colspan="9" class="muted">暂无会话</td></tr>`;
}

function renderLocksTable(snap) {
  const rows = [];
  for (const node of snap?.sessions || []) {
    for (const lock of node.locks || []) {
      rows.push(`
        <tr>
          <td><span class="session-chip">${escapeHtml(node.scriptName || node.applicationName || node.pid)}</span></td>
          <td class="mono">${escapeHtml(lock.locktype)}</td>
          <td class="mono">${escapeHtml(lock.mode)}</td>
          <td>${lock.granted ? '<span class="tag good">granted</span>' : '<span class="tag cycle">waiting</span>'}</td>
          <td>${escapeHtml(lock.resourceLabel)}</td>
          <td>${lock.fastpath ? 'yes' : 'no'}</td>
        </tr>`);
    }
  }
  ui.locksTableBody.innerHTML = rows || `<tr><td colspan="6" class="muted">当前样本没有锁记录或样本不可用。</td></tr>`;
}

function renderWinner() {
  const handles = [...(state?.handles || [])].sort((a, b) => (a.settlementRank || 99999) - (b.settlementRank || 99999));
  if (!handles.length) {
    ui.winnerPanel.innerHTML = '<div class="empty-note">推进脚本后，这里按 Node 驱动实际收到查询完成/错误的顺序，解释解锁后谁先拿到锁。</div>';
    return;
  }
  ui.winnerPanel.innerHTML = handles.map((h) => `
    <div class="winner-row ${h.status === 'rejected' ? 'rejected' : ''}">
      <div class="rank">${h.settlementRank ?? '…'}</div>
      <div>
        <strong>${escapeHtml(h.sessionName)} · ${escapeHtml(h.label)}</strong>
        <span>${h.status === 'pending' ? '仍在等待锁' : `结算于 ${formatTime(h.settledAt)}`} · 开始 ${formatTime(h.startedAt)}</span>
        ${h.error ? `<div class="code-pill">${escapeHtml(h.error.code || 'ERROR')}: ${escapeHtml(h.error.message)}</div>` : ''}
      </div>
      <span class="tag ${h.status === 'resolved' ? 'good' : h.status === 'rejected' ? 'cycle' : 'wait'}">
        ${h.status === 'resolved' ? '完成' : h.status === 'rejected' ? '被裁决' : '等待中'}
      </span>
    </div>`).join('');
}

function renderEvents() {
  const events = [...(state?.events || [])].reverse();
  ui.eventList.innerHTML = events.map((event) => `
    <div class="event type-${escapeHtml(event.type)}">
      <time>${formatTime(event.at)}<br/>#${event.id}</time>
      <p>${escapeHtml(event.message)}</p>
    </div>`).join('') || '<div class="empty-note">暂无事件</div>';
}

function renderAnalysis() {
  if (!analysis) {
    ui.analysisStats.innerHTML = '';
    ui.samplingRule.textContent = '运行脚本并采样后，这里会展示降采样后必须收回的判断。';
    ui.judgmentList.innerHTML = '';
    ui.stitchedPanel.innerHTML = '<div class="empty-note">暂无跨时刻边。</div>';
    return;
  }
  ui.strideValue.textContent = analysis.stride;
  ui.analysisStats.innerHTML = `
    <div class="stat"><strong>${analysis.totalSamples}</strong><span>总样本</span></div>
    <div class="stat"><strong>${analysis.selectedSampleSeqs.length}</strong><span>稀疏保留</span></div>
    <div class="stat"><strong>${analysis.withdrawnCount}</strong><span>需收回</span></div>`;
  ui.samplingRule.textContent = analysis.rule;
  ui.judgmentList.innerHTML = analysis.judgments.map((j) => {
    const sparse = j.sparse || {};
    const cls = sparse.mustRetract || sparse.mustRetractSampleOnlyClaim ? 'withdraw' : sparse.retainedByInstrumentation && !sparse.supportedBySample ? 'instrument' : 'supported';
    const dense = j.dense?.sampleSeqs?.length ? `密集证据：样本 #${j.dense.sampleSeqs.join(', #')}` : j.dense?.observations?.length ? `密集证据：${j.dense.observations.length} 个环样本` : '密集/驱动证据已记录';
    return `
      <article class="judgment ${cls}">
        <h3>${escapeHtml(j.title)}</h3>
        <p>${escapeHtml(sparse.verdict || '')}</p>
        <div class="evidence">${escapeHtml(dense)}${j.betweenSampleSeqs ? ` · 时间界 #${j.betweenSampleSeqs[0]}→#${j.betweenSampleSeqs[1]}，宽 ${formatMs(j.widthMs)}` : ''}</div>
      </article>`;
  }).join('');

  const edges = analysis.stitchedGraph?.edges || [];
  ui.stitchedPanel.innerHTML = edges.length
    ? `<div class="rule-box bad">${escapeHtml(analysis.stitchedGraph.warning)}</div>` + edges.map((e) => `
        <div class="stitched-edge">#${e.sourceSampleSeq} ${escapeHtml(e.waiterName)} → ${escapeHtml(e.blockerName)}<br/><span class="muted">${escapeHtml(e.resourceHint || e.resource)}</span></div>
      `).join('')
    : '<div class="empty-note">所选稀疏样本中没有边可拼接；没有边不代表中间从未阻塞。</div>';
}

async function handleAdvance() {
  if (requestInFlight) return;
  requestInFlight = true;
  renderControls();
  setHint('正在执行下一步，并等待 PostgreSQL 锁状态达到脚本屏障…');
  try {
    state = await api('/api/advance', { method: 'POST', body: { budgetMs: Number(ui.budgetMs.value) } });
    renderAll();
    setHint('步骤完成；图来自该步骤后的即时原子样本。');
    await refreshAnalysis();
  } catch (error) {
    if (error.payload?.active) state = error.payload;
    renderAll();
    setHint(`步骤失败：${error.message}`, true);
    await refreshAnalysis().catch(() => {});
  } finally {
    requestInFlight = false;
    renderControls();
  }
}

async function handleSample() {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    await api('/api/snapshots', { method: 'POST', body: { budgetMs: Number(ui.budgetMs.value), intervalMs: Number(ui.intervalMs.value), reason: 'manual-button' } });
    await refreshState();
    await refreshAnalysis();
  } catch (error) {
    setHint(`采样失败：${error.message}`, true);
  } finally {
    requestInFlight = false;
    renderControls();
  }
}

async function handleCreateRun(scenarioId) {
  if (requestInFlight) return;
  requestInFlight = true;
  setHint('正在重建小表并建立可复现连接…');
  try {
    state = await api('/api/runs', { method: 'POST', body: { scenarioId, budgetMs: Number(ui.budgetMs.value) } });
    analysis = null;
    renderAll();
    setHint('运行已重置，可以逐步推进。');
  } catch (error) {
    setHint(`创建运行失败：${error.message}`, true);
  } finally {
    requestInFlight = false;
    renderControls();
  }
}

async function handleReset() {
  await handleCreateRun(state?.scenarioId || ui.scenarioSelect.value || 'normal-block');
}

async function autoTick() {
  if (!autoEnabled) return;
  try {
    await api('/api/snapshots', { method: 'POST', body: { budgetMs: Number(ui.budgetMs.value), intervalMs: Number(ui.intervalMs.value), reason: 'auto' } });
    await refreshState();
    await refreshAnalysis();
  } catch (error) {
    setHint(`自动采样失败：${error.message}`, true);
  } finally {
    if (autoEnabled) autoTimer = setTimeout(autoTick, Math.max(50, Number(ui.intervalMs.value) || 500));
  }
}

function toggleAuto() {
  autoEnabled = !autoEnabled;
  ui.autoBtn.textContent = autoEnabled ? '停止自动采样' : '开始自动采样';
  ui.autoBtn.classList.toggle('primary', autoEnabled);
  if (autoEnabled) {
    clearTimeout(autoTimer);
    autoTick();
  } else {
    clearTimeout(autoTimer);
  }
}

function traceSampleTick() {
  if (!traceActive) return;
  if (!traceSampling) {
    traceSampling = true;
    api('/api/snapshots', {
      method: 'POST',
      body: { budgetMs: Number(ui.budgetMs.value), intervalMs: 90, reason: 'dense-trace' },
    }).catch(() => {}).finally(() => { traceSampling = false; });
  }
  traceTimer = setTimeout(traceSampleTick, 90);
}

async function handleDenseTrace() {
  if (traceActive || requestInFlight) return;
  const scenarioId = state?.scenarioId || ui.scenarioSelect.value || 'handoff-queue';
  traceActive = true;
  renderControls();
  setHint('正在重建运行，并以约 90ms 间隔密集录制真实原子样本…');
  try {
    await handleCreateRun(scenarioId);
    traceActive = true;
    clearTimeout(traceTimer);
    traceSampleTick();

    let guard = 0;
    while (state?.active && !['completed', 'error'].includes(state.status) && guard < 12) {
      guard += 1;
      await handleAdvance();
    }

    traceActive = false;
    clearTimeout(traceTimer);
    await refreshState();
    ui.strideRange.value = '5';
    ui.strideValue.textContent = '5';
    await refreshAnalysis();
    setHint('密集录制完成。拖动“每 N 个样本取 1 个”，查看哪些边、环、获胜者和收敛判断必须收回。');
  } catch (error) {
    setHint(`密集录制失败：${error.message}`, true);
  } finally {
    traceActive = false;
    clearTimeout(traceTimer);
    renderControls();
  }
}

ui.advanceBtn.addEventListener('click', handleAdvance);
ui.sampleBtn.addEventListener('click', handleSample);
ui.resetBtn.addEventListener('click', handleReset);
ui.autoBtn.addEventListener('click', toggleAuto);
ui.denseTraceBtn.addEventListener('click', handleDenseTrace);
ui.refreshStateBtn.addEventListener('click', async () => { await refreshState(); await refreshAnalysis(); });
ui.scenarioSelect.addEventListener('change', () => handleCreateRun(ui.scenarioSelect.value));
ui.strideRange.addEventListener('input', () => { ui.strideValue.textContent = ui.strideRange.value; refreshAnalysis(); });
ui.minIntervalSelect.addEventListener('change', refreshAnalysis);
ui.budgetMs.addEventListener('change', async () => {
  const value = Math.min(5000, Math.max(2, Number(ui.budgetMs.value) || 250));
  ui.budgetMs.value = value;
  if (state?.active) {
    try { state = await api('/api/settings', { method: 'POST', body: { budgetMs: value } }); renderControls(); } catch { /* use per-request value */ }
  }
});

(async function init() {
  try {
    await loadScenarios();
    await refreshState();
    if (!state?.active) state = await api('/api/runs', { method: 'POST', body: { scenarioId: 'normal-block' } });
    renderAll();
    await refreshAnalysis();
    await refreshHealth();
    setInterval(refreshHealth, 5000);
  } catch (error) {
    setHint(`初始化失败：${error.message}。请先运行 npm run setup。`, true);
    await refreshHealth();
  }
})();
