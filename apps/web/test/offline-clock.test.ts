import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createMatch } from '@judo/engine/match';
import { advanceJournalClock } from '../src/features/offline/clock.ts';
import { appendJournalCommand, type Journal } from '../src/features/offline/journal.ts';
import { offlineSyncConflict } from '../src/features/offline/sync-failure.ts';
import { ApiError } from '../src/features/tournaments/api.ts';
function fixture(): Journal {
  const state = createMatch({
    durationMs: 600000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
    holdThresholds: [
      { ms: 5000, score: 'YUKO' },
      { ms: 10000, score: 'WAZA_ARI' },
      { ms: 20000, score: 'IPPON' },
    ],
  });
  return {
    sessionId: 'session',
    opening: false,
    revision: 0,
    events: [],
    view: {
      tournamentId: 't',
      tournamentName: 'QA',
      tournamentStatus: 'RUNNING',
      number: 1,
      currentMatch: null,
      lastResult: null,
    },
    state: applyCommand(state, { id: 'start', expectedVersion: 0, type: 'START' }),
  };
}
test('offline monotonic clock retains fractional milliseconds through repeated durable ticks', () => {
  let journal = fixture(),
    anchor = 0;
  for (let i = 1; i <= 1000; i++) {
    const step = advanceJournalClock(journal, anchor, i * 250.75);
    journal = step.journal;
    anchor = step.nextAnchor;
  }
  assert.equal(journal.state.elapsedMs, 250750);
  assert.equal(
    journal.events.reduce((total, c) => total + (c.type === 'ADVANCE' ? c.ms : 0), 0),
    250750,
  );
});
test('a rejected stop during hold does not consume elapsed time or lose the automatic hold score', () => {
  const journal = appendJournalCommand(fixture(), { type: 'HOLD', side: 'WHITE' });
  const before = structuredClone(journal);
  assert.throws(
    () => advanceJournalClock(journal, 0, 6000.5, { type: 'STOP' }),
    /RESOLVE_HOLD_FIRST/,
  );
  assert.deepEqual(journal, before);
  const retry = advanceJournalClock(journal, 0, 6010.5);
  assert.equal(retry.journal.state.hold?.elapsedMs, 6010);
  assert.equal(retry.journal.state.awards.filter((a) => a.active && a.kind === 'YUKO').length, 1);
  assert.equal(retry.nextAnchor, 6010);
});
test('a rejected button at a terminal boundary is recovered by the next tick without rewinding time', () => {
  const journal = appendJournalCommand(fixture(), { type: 'HOLD', side: 'BLUE' });
  assert.throws(
    () => advanceJournalClock(journal, 0, 20001, { type: 'TOKETA' }),
    /INVALID_TRANSITION/,
  );
  const recovered = advanceJournalClock(journal, 0, 20010).journal;
  assert.equal(recovered.state.status, 'PROVISIONAL');
  assert.equal(recovered.state.elapsedMs, 20000);
  assert.deepEqual(recovered.state.outcome, { winner: 'BLUE', reason: 'IPPON' });
});
test('time on pause is never added on resumption and recovery never guesses time spent asleep', () => {
  const paused = appendJournalCommand(fixture(), { type: 'STOP' });
  const resumed = advanceJournalClock(paused, 0, 100000.75, { type: 'START' });
  assert.equal(
    advanceJournalClock(resumed.journal, resumed.nextAnchor, 100001.75).journal.state.elapsedMs,
    1,
  );
  const recovered = appendJournalCommand(fixture(), { type: 'RECOVER' });
  assert.equal(recovered.state.status, 'PAUSED');
  assert.equal(recovered.state.elapsedMs, 0);
});
test('timeout and rate limiting retain the exact packet for automatic retry; revoked access still requires review', () => {
  for (const status of [408, 429, 500, 502, 503])
    assert.equal(offlineSyncConflict(new ApiError('Temporary', status)), undefined);
  assert.equal(offlineSyncConflict(new TypeError('offline')), undefined);
  for (const status of [400, 401, 403, 404, 409])
    assert.equal(offlineSyncConflict(new ApiError('REVIEW', status)), 'REVIEW');
});
