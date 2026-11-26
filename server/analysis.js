'use strict';

function sampleTime(sample) {
  const t = Date.parse(sample.capturedAt || sample.collectedAt);
  return Number.isFinite(t) ? t : 0;
}

function isValidSample(sample) {
  return sample && !sample.incomplete && !sample.timedOut && !sample.error;
}

function selectByStride(samples, stride = 1, options = {}) {
  const sorted = [...samples].sort((a, b) => (a.sampleSeq ?? 0) - (b.sampleSeq ?? 0));
  const n = Math.max(1, Number.parseInt(stride, 10) || 1);
  const selected = sorted.filter((_, index) => index % n === 0);
  if (options.includeLast && sorted.length > 0 && selected[selected.length - 1] !== sorted[sorted.length - 1]) {
    selected.push(sorted[sorted.length - 1]);
  }
  return selected;
}

function selectByMinInterval(samples, minIntervalMs = 0) {
  const sorted = [...samples].sort((a, b) => sampleTime(a) - sampleTime(b));
  if (!minIntervalMs || minIntervalMs <= 0) return sorted;
  const selected = [];
  let lastTime = null;
  for (const sample of sorted) {
    const t = sampleTime(sample);
    if (lastTime === null || t - lastTime >= minIntervalMs) {
      selected.push(sample);
      lastTime = t;
    }
  }
  return selected;
}

function buildStitchedGraph(samples) {
  const edges = [];
  for (const sample of samples) {
    if (!isValidSample(sample)) continue;
    for (const edge of sample.edges || []) {
      edges.push({
        ...edge,
        sourceSampleSeq: sample.sampleSeq,
        sourceCapturedAt: sample.capturedAt,
      });
    }
  }
  return {
    valid: false,
    warning: '这是多个时刻边的并集，不是任一原子采样时刻的真实等待图；只能用于追溯，不能当作当前依赖图。',
    edges,
  };
}

function nameForPid(pid, pidToName) {
  return pidToName?.get?.(Number(pid)) || `PID ${pid}`;
}

function edgeTitle(edge, pidToName) {
  const waiter = nameForPid(edge.waiterPid, pidToName);
  const blocker = nameForPid(edge.blockerPid, pidToName);
  return `${waiter} → ${blocker}`;
}

function intervalWidth(bounds) {
  if (!bounds?.from || !bounds?.to) return null;
  return new Date(bounds.to).getTime() - new Date(bounds.from).getTime();
}

function buildEdgeJudgments({ allSamples, sparseSamples, pidToName }) {
  const byEdge = new Map();

  for (const sample of allSamples) {
    if (!isValidSample(sample)) continue;
    for (const edge of sample.edges || []) {
      if (!byEdge.has(edge.id)) {
        byEdge.set(edge.id, {
          edge,
          seqs: [],
          firstAt: sample.capturedAt,
          lastAt: sample.capturedAt,
          lastSeenSeq: sample.sampleSeq,
        });
      }
      const item = byEdge.get(edge.id);
      item.seqs.push(sample.sampleSeq);
      item.lastAt = sample.capturedAt;
      item.lastSeenSeq = sample.sampleSeq;
    }
  }

  const sparseEdgeSeqs = new Map();
  for (const sample of sparseSamples) {
    if (!isValidSample(sample)) continue;
    for (const edge of sample.edges || []) {
      if (!sparseEdgeSeqs.has(edge.id)) sparseEdgeSeqs.set(edge.id, []);
      sparseEdgeSeqs.get(edge.id).push(sample.sampleSeq);
    }
  }

  return [...byEdge.values()].map(({ edge, seqs, firstAt, lastAt, lastSeenSeq }) => {
    const sparseSeqs = sparseEdgeSeqs.get(edge.id) || [];
    const sampleSupportedSparse = sparseSeqs.length > 0;
    const title = `阻塞边 ${edgeTitle(edge, pidToName)}`;
    return {
      id: `edge:${edge.id}`,
      kind: 'blocking-edge',
      title,
      resource: edge.resource,
      dense: {
        supported: true,
        sampleSeqs: seqs,
        firstAt,
        lastAt,
      },
      sparse: {
        supportedBySample: sampleSupportedSparse,
        sampleSeqs: sparseSeqs,
        mustRetract: !sampleSupportedSparse,
        verdict: sampleSupportedSparse
          ? `变稀后仍在采样 #${sparseSeqs.join(', #')} 同一快照中观察到该边。`
          : '变稀后的任何单个原子快照都没有同时包含这条边；必须收回“采样看到该阻塞关系”的判断。',
      },
    };
  });
}

function buildCycleJudgments({ allSamples, sparseSamples, pidToName }) {
  const denseCycles = [];
  for (const sample of allSamples) {
    if (!isValidSample(sample)) continue;
    for (const cycle of sample.cycles || []) {
      denseCycles.push({ sampleSeq: sample.sampleSeq, at: sample.capturedAt, cycle });
    }
  }

  const sparseCycles = [];
  for (const sample of sparseSamples) {
    if (!isValidSample(sample)) continue;
    for (const cycle of sample.cycles || []) {
      sparseCycles.push({ sampleSeq: sample.sampleSeq, at: sample.capturedAt, cycle });
    }
  }

  if (denseCycles.length === 0) return [];
  const first = denseCycles[0];
  const sparseFirst = sparseCycles[0] || null;
  const names = first.cycle.map((pid) => nameForPid(pid, pidToName)).join(' ↔ ');

  return [
    {
      id: 'deadlock-cycle',
      kind: 'deadlock-cycle',
      title: `同一快照内的死锁环：${names}`,
      dense: { supported: true, observations: denseCycles },
      sparse: {
        supportedBySample: Boolean(sparseFirst),
        observations: sparseCycles,
        mustRetract: !sparseFirst,
        verdict: sparseFirst
          ? `稀疏采样 #${sparseFirst.sampleSeq} 仍在同一原子快照中捕获环。`
          : '稀疏采样错过完整环；不能用不同快照里的边拼出死锁环，必须收回“采样观察到死锁环”。PostgreSQL 的 40P01 裁决事件仍可独立证明死锁发生过。',
      },
    },
  ];
}

function buildWinnerJudgment({ handles = [], sparseSamples = [], pidToName }) {
  const waitHandles = handles
    .filter((h) => h && h.startedMono != null && h.settledMono != null && h.status !== 'pending')
    .sort((a, b) => (a.settlementRank ?? Number.MAX_SAFE_INTEGER) - (b.settlementRank ?? Number.MAX_SAFE_INTEGER) || a.settledMono - b.settledMono);

  if (waitHandles.length < 2) return null;
  const winner = waitHandles[0];
  const runnerUp = waitHandles[1];

  // 稀疏样本是否直接显示了 handoff：某个稀疏样本中亚军等待冠军。
  const winnerPid = winner.pid;
  const runnerUpPid = runnerUp.pid;
  const handoffSample = sparseSamples.find((s) => isValidSample(s) && (s.edges || []).some((e) => Number(e.waiterPid) === Number(runnerUpPid) && Number(e.blockerPid) === Number(winnerPid)));

  return {
    id: 'lock-winner',
    kind: 'lock-winner',
    title: `解锁后先获得锁：${winner.sessionName || nameForPid(winnerPid, pidToName)}`,
    dense: {
      supported: true,
      winnerHandleId: winner.id,
      settlementOrder: waitHandles.map((h) => ({ handleId: h.id, sessionName: h.sessionName, rank: h.settlementRank, at: h.settledAt })),
      basis: '本工作台持有连接的查询结算顺序（驱动事件），并可由密集快照中的队列/handoff 边印证。',
    },
    sparse: {
      supportedBySample: Boolean(handoffSample),
      sampleSeq: handoffSample?.sampleSeq ?? null,
      retainedByInstrumentation: true,
      mustRetractSampleOnlyClaim: !handoffSample,
      verdict: handoffSample
        ? `稀疏样本 #${handoffSample.sampleSeq} 捕获到 ${runnerUp.sessionName} 转而等待 ${winner.sessionName}，支持该交接顺序。`
        : '稀疏快照只看到“都在等”和“都结束”，无法仅凭采样判断谁先拿到锁；必须收回采样层面的获胜者/精确解锁时刻结论。连接驱动记录的结算顺序仍可解释本脚本中的真实顺序。',
    },
  };
}

function buildConvergenceJudgment({ sparseSamples = [] }) {
  const valid = sparseSamples.filter(isValidSample);
  const converged = valid.filter((s) => s.converged);
  const latest = valid[valid.length - 1] || null;
  const latestConverged = latest?.converged === true;
  return {
    id: 'graph-convergence',
    kind: 'convergence',
    title: '事务结束后依赖图收敛为空',
    dense: { supported: true },
    sparse: {
      supportedBySample: latestConverged,
      sampleSeq: latest?.sampleSeq ?? null,
      convergedSampleSeqs: converged.map((s) => s.sampleSeq),
      mustRetract: !latestConverged,
      verdict: latestConverged
        ? `稀疏序列的最新有效样本 #${latest.sampleSeq} 已无等待边/环。`
        : '稀疏序列没有留下事务结束后的有效空图样本；不能凭“后面没采到”声称图已及时收敛，应立即手动补一次带开销上限的原子采样。',
    },
  };
}

function buildUnlockWindowJudgments({ allSamples = [], sparseSamples = [] }) {
  // 对每条边，找稀疏序列中最后一次看到和之后第一次未看到，给出加宽的时间界。
  const sparseValid = sparseSamples.filter(isValidSample);
  const result = [];
  const edgeIds = new Set();
  for (const s of allSamples.filter(isValidSample)) for (const e of s.edges || []) edgeIds.add(e.id);

  for (const edgeId of edgeIds) {
    let lastSeen = null;
    let nextAbsent = null;
    for (const sample of sparseValid) {
      const present = (sample.edges || []).some((e) => e.id === edgeId);
      if (present) {
        lastSeen = sample;
        nextAbsent = null;
      } else if (lastSeen && !nextAbsent) {
        nextAbsent = sample;
        break;
      }
    }
    if (!lastSeen || !nextAbsent) continue;
    result.push({
      id: `unlock-window:${edgeId}`,
      kind: 'unlock-window',
      edgeId,
      betweenSampleSeqs: [lastSeen.sampleSeq, nextAbsent.sampleSeq],
      from: lastSeen.capturedAt,
      to: nextAbsent.capturedAt,
      widthMs: intervalWidth({ from: lastSeen.capturedAt, to: nextAbsent.capturedAt }),
      verdict: `解锁/边消失只能限定在 #${lastSeen.sampleSeq} 到 #${nextAbsent.sampleSeq} 之间；采样越稀，时间界越宽，不能声称恰好发生在某个采样时刻。`,
    });
  }
  return result;
}

function evaluateSampling(input = {}) {
  const allSamples = (input.samples || []).filter((s) => Number.isFinite(s.sampleSeq)).sort((a, b) => a.sampleSeq - b.sampleSeq);
  const stride = Math.max(1, Number.parseInt(input.stride, 10) || 1);
  const minIntervalMs = Number(input.minIntervalMs) || null;
  let sparseSamples = selectByStride(allSamples, stride, { includeLast: false });
  if (minIntervalMs) sparseSamples = selectByMinInterval(sparseSamples, minIntervalMs);

  const pidToName = input.pidToName instanceof Map ? input.pidToName : new Map(Object.entries(input.pidToName || {}).map(([k, v]) => [Number(k), v]));
  const edgeJudgments = buildEdgeJudgments({ allSamples, sparseSamples, pidToName });
  const cycleJudgments = buildCycleJudgments({ allSamples, sparseSamples, pidToName });
  const winner = buildWinnerJudgment({ handles: input.handles || [], sparseSamples, pidToName });
  const convergence = buildConvergenceJudgment({ sparseSamples });
  const windows = buildUnlockWindowJudgments({ allSamples, sparseSamples });

  const judgments = [...edgeJudgments, ...cycleJudgments, ...(winner ? [winner] : []), convergence, ...windows];
  const withdrawn = judgments.filter((j) => j.sparse?.mustRetract || j.sparse?.mustRetractSampleOnlyClaim);

  return {
    stride,
    minIntervalMs,
    totalSamples: allSamples.length,
    selectedSampleSeqs: sparseSamples.map((s) => s.sampleSeq),
    omittedSamples: Math.max(0, allSamples.length - sparseSamples.length),
    stitchedGraph: buildStitchedGraph(sparseSamples),
    judgments,
    withdrawnCount: withdrawn.length,
    rule: '只有同一样本内的边和环可作为当前依赖图证据；不同样本的边只能形成带时间界的历史，不能拼接成图。',
  };
}

module.exports = {
  evaluateSampling,
  selectByStride,
  selectByMinInterval,
  buildStitchedGraph,
  isValidSample,
};
