'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LockLab } = require('../server/lab');

const lab = new LockLab();
let healthy = false;
let healthError = null;

test.before(async () => {
  try {
    await lab.health();
    healthy = true;
  } catch (error) {
    healthError = error;
  }
});

test.after(async () => {
  await lab.close();
});

test('normal blocking correlates B→A and converges after both transactions end', async (t) => {
  if (!healthy) return t.skip(`PostgreSQL unavailable: ${healthError?.message}`);

  let state = await lab.createRun('normal-block');
  assert.equal(state.sessions.length, 2);

  await lab.advance(); // A lock
  state = await lab.advance(); // B waits
  let snap = state.latestSnapshot;
  assert.equal(snap.counts.edges, 1);
  assert.equal(snap.cycles.length, 0);
  const edge = snap.edges[0];
  assert.equal(edge.waiterName, 'B');
  assert.equal(edge.blockerName, 'A');
  assert.ok(edge.resource.includes('事务 ID'));
  const bNode = snap.sessions.find((n) => n.scriptName === 'B');
  assert.ok(bNode.xactStart, 'waiter should expose xact_start');
  assert.ok(bNode.xactAgeMs >= 0);

  state = await lab.advance(); // A commit
  assert.equal(state.stepResults.at(-1).result.winner, 'B');
  assert.equal(state.latestSnapshot.counts.edges, 0);

  state = await lab.advance(); // B commit
  assert.equal(state.status, 'completed');
  assert.equal(state.latestSnapshot.converged, true);
});

test('handoff records B before C and graph changes from C→B→A to C→B', async (t) => {
  if (!healthy) return t.skip(`PostgreSQL unavailable: ${healthError?.message}`);

  await lab.createRun('handoff-queue');
  await lab.advance();
  await lab.advance();
  let state = await lab.advance(); // C waits
  assert.equal(state.latestSnapshot.counts.edges, 2);
  const ids = state.latestSnapshot.edges.map((e) => `${e.waiterName}->${e.blockerName}`).sort();
  assert.deepEqual(ids, ['B->A', 'C->B']);

  state = await lab.advance(); // A release, B wins
  assert.equal(state.stepResults.at(-1).result.winner, 'B');
  assert.equal(state.latestSnapshot.edges.length, 1);
  assert.equal(state.latestSnapshot.edges[0].waiterName, 'C');
  assert.equal(state.latestSnapshot.edges[0].blockerName, 'B');

  state = await lab.advance(); // B release, C wins
  assert.equal(state.stepResults.at(-1).result.winner, 'C');
  const ranks = state.handles
    .filter((h) => h.status === 'resolved')
    .sort((a, b) => a.settlementRank - b.settlementRank)
    .map((h) => h.sessionName);
  assert.deepEqual(ranks, ['B', 'C']);

  state = await lab.advance();
  assert.equal(state.latestSnapshot.converged, true);
});

test('deadlock scenario captures a same-sample cycle and PostgreSQL 40P01 victim', async (t) => {
  if (!healthy) return t.skip(`PostgreSQL unavailable: ${healthError?.message}`);

  await lab.createRun('deadlock-cycle', { deadlockTimeoutMs: 700 });
  await lab.advance();
  await lab.advance();
  await lab.advance();
  const cycleState = await lab.advance();
  const cycleStep = cycleState.stepResults.at(-1);
  assert.equal(cycleStep.result.cycleCount, 1);
  assert.equal(cycleState.latestSnapshot.cycles.length, 1);

  const detectorState = await lab.advance();
  const detectorResult = detectorState.stepResults.at(-1).result;
  assert.equal(detectorResult.sqlstate, '40P01');
  assert.ok(['A', 'B'].includes(detectorResult.victim));
  const deadlockEvent = detectorState.events.find((e) => e.type === 'postgres:deadlock');
  assert.ok(deadlockEvent, 'state should retain a postgres:deadlock event');

  const finalState = await lab.advance();
  assert.equal(finalState.latestSnapshot.converged, true);
});

test('diagnostic budget timeout is represented as incomplete evidence', async (t) => {
  if (!healthy) return t.skip(`PostgreSQL unavailable: ${healthError?.message}`);
  await lab.createRun('normal-block');
  // 1ms is intentionally below the catalog query's normal runtime on a cold cache.
  // If this particular machine is fast enough, the query may pass; either way the
  // API shape must be valid and a timeout must never be reported as a converged graph.
  const snapshot = await lab.takeSnapshot({ budgetMs: 1 });
  assert.equal(typeof snapshot.durationMs, 'number');
  assert.equal(snapshot.budgetMs, 2, 'budget should be clamped to the configured minimum');
  if (snapshot.timedOut) {
    assert.equal(snapshot.incomplete, true);
    assert.equal(snapshot.converged, false);
  }
});
