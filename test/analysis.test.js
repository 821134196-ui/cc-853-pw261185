'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSampling, selectByStride, buildStitchedGraph } = require('../server/analysis');

function edgeSample(seq, at, edges, converged = false, cycles = []) {
  return {
    sampleSeq: seq,
    capturedAt: at,
    incomplete: false,
    timedOut: false,
    error: null,
    edges,
    cycles,
    converged,
  };
}

const edgeAB = { id: '1->2', waiterPid: 2, blockerPid: 1, waiterName: 'B', blockerName: 'A', resource: 'xid' };
const edgeCB = { id: '2->3', waiterPid: 3, blockerPid: 2, waiterName: 'C', blockerName: 'B', resource: 'row' };

test('selectByStride keeps deterministic atomic samples', () => {
  const samples = Array.from({ length: 6 }, (_, i) => ({ sampleSeq: i + 1 }));
  assert.deepEqual(selectByStride(samples, 2).map((s) => s.sampleSeq), [1, 3, 5]);
});

test('sparse sampling withdraws unobserved edges and cycles without cross-time stitching', () => {
  const samples = [
    edgeSample(1, '2026-01-01T00:00:00.000Z', [edgeAB], false, [[1, 2]]),
    edgeSample(2, '2026-01-01T00:00:00.100Z', [edgeAB, edgeCB]),
    edgeSample(3, '2026-01-01T00:00:00.200Z', [], true),
    edgeSample(4, '2026-01-01T00:00:00.300Z', [edgeAB], false, [[1, 2]]),
    edgeSample(5, '2026-01-01T00:00:00.400Z', [edgeAB, edgeCB]),
    edgeSample(6, '2026-01-01T00:00:00.500Z', [], true),
  ];

  const result = evaluateSampling({ samples, stride: 3, pidToName: new Map([[1, 'A'], [2, 'B'], [3, 'C']]) });
  assert.deepEqual(result.selectedSampleSeqs, [1, 4]);
  const edgeJudgment = result.judgments.find((j) => j.id === 'edge:2->3');
  assert.equal(edgeJudgment.sparse.supportedBySample, false);
  assert.equal(edgeJudgment.sparse.mustRetract, true);

  const cycle = result.judgments.find((j) => j.kind === 'deadlock-cycle');
  assert.equal(cycle.sparse.supportedBySample, true, 'selected samples 1 and 4 do contain the cycle');

  const stitched = buildStitchedGraph(result.selectedSampleSeqs.map((seq) => samples.find((s) => s.sampleSeq === seq)));
  assert.equal(stitched.valid, false);
  assert.match(stitched.warning, /不是任一原子采样时刻/);
});

test('winner can remain instrumented while sample-only winner claim is withdrawn', () => {
  const samples = [
    edgeSample(1, '2026-01-01T00:00:00.000Z', [edgeAB]),
    edgeSample(2, '2026-01-01T00:00:00.500Z', [edgeAB, edgeCB]),
    edgeSample(3, '2026-01-01T00:00:01.000Z', [], true),
  ];
  const handles = [
    { id: 'h1', sessionName: 'B', pid: 2, status: 'resolved', settlementRank: 1, startedMono: 1, settledMono: 2 },
    { id: 'h2', sessionName: 'C', pid: 3, status: 'resolved', settlementRank: 2, startedMono: 1, settledMono: 3 },
  ];
  const result = evaluateSampling({ samples, handles, stride: 2, pidToName: new Map([[1, 'A'], [2, 'B'], [3, 'C']]) });
  assert.deepEqual(result.selectedSampleSeqs, [1, 3]);
  const winner = result.judgments.find((j) => j.kind === 'lock-winner');
  assert.equal(winner.title.includes('B'), true);
  assert.equal(winner.sparse.supportedBySample, false);
  assert.equal(winner.sparse.retainedByInstrumentation, true);
  assert.match(winner.sparse.verdict, /无法仅凭采样/);
});
