'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshot } = require('../server/diagnostics');

function activityRow(overrides = {}) {
  return {
    sample_at: '2026-01-01T00:00:00.000Z',
    pid: 1,
    application_name: 'locklab-session-a',
    state: 'active',
    wait_event_type: 'Lock',
    wait_event: 'transactionid',
    blocker_pids: [],
    xact_age_ms: 12.5,
    query_age_ms: 3,
    ...overrides,
  };
}

test('buildSnapshot correlates waiter, blocker, resource and cycle', () => {
  const rows = [
    activityRow({
      pid: 101,
      application_name: 'locklab-session-a',
      state: 'idle in transaction',
      wait_event_type: 'Client',
      wait_event: 'ClientRead',
      blocker_pids: [],
      locktype: 'transactionid',
      lock_mode: 'ExclusiveLock',
      lock_granted: true,
      lock_transactionid: '700',
    }),
    activityRow({
      pid: 102,
      application_name: 'locklab-session-b',
      blocker_pids: [101],
      locktype: 'transactionid',
      lock_mode: 'ShareLock',
      lock_granted: false,
      lock_transactionid: '700',
    }),
  ];

  const snapshot = buildSnapshot({ rows, durationMs: 2, budgetMs: 100, sampleSeq: 1 });
  assert.equal(snapshot.counts.edges, 1);
  assert.equal(snapshot.converged, false);
  const edge = snapshot.edges[0];
  assert.equal(edge.waiterPid, 102);
  assert.equal(edge.blockerPid, 101);
  assert.equal(edge.resourceMatch, true);
  assert.equal(edge.resource, '事务 ID 700');
  assert.equal(edge.requestedMode, 'ShareLock');
  assert.equal(edge.heldMode, 'ExclusiveLock');
});

test('buildSnapshot detects a same-sample deadlock cycle', () => {
  const rows = [
    activityRow({ pid: 1, blocker_pids: [2] }),
    activityRow({ pid: 2, blocker_pids: [1] }),
  ];
  const snapshot = buildSnapshot({ rows, durationMs: 1, budgetMs: 100, sampleSeq: 2 });
  assert.equal(snapshot.cycles.length, 1);
  assert.deepEqual(snapshot.cycles[0].map(Number).sort(), [1, 2]);
  assert.equal(snapshot.warnings.some((w) => w.code === 'DEADLOCK_CYCLE'), true);
});

test('timeout snapshots are explicitly incomplete and never called converged', () => {
  const snapshot = buildSnapshot({
    rows: [],
    durationMs: 5,
    budgetMs: 2,
    timedOut: true,
    cancelled: true,
    error: Object.assign(new Error('timeout'), { code: '57014' }),
  });
  assert.equal(snapshot.incomplete, true);
  assert.equal(snapshot.atomic, false);
  assert.equal(snapshot.converged, false);
  assert.match(snapshot.error.message, /timeout/);
});
