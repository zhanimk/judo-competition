import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, createMatch, type Rules } from '@judo/engine/match';
import {
  appendJournalCommand,
  canReleaseJournal,
  type Journal,
} from '../src/features/offline/journal.ts';

const rules: Rules = {
  durationMs: 60000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [{ ms: 20000, score: 'IPPON' }],
};
function fixture(): Journal {
  let state = createMatch(rules);
  state = applyCommand(state, { id: 'start', expectedVersion: state.version, type: 'START' });
  state = applyCommand(state, { id: 'stop', expectedVersion: state.version, type: 'STOP' });
  return {
    sessionId: 'session',
    view: {
      tournamentId: 't',
      tournamentName: 'Tournament',
      tournamentStatus: 'RUNNING',
      number: 1,
      currentMatch: null,
      lastResult: null,
    },
    state,
    revision: 2,
    events: [],
    opening: false,
  };
}

test('ownership cannot be released after a local command entered the write queue', () => {
  const saved = fixture();
  assert.equal(canReleaseJournal(saved), true);
  const newer = appendJournalCommand(saved, { type: 'AWARD', side: 'WHITE', kind: 'YUKO' });
  assert.equal(canReleaseJournal(newer), false);
  assert.equal(saved.events.length, 0, 'the persisted snapshot remains immutable');
  assert.equal(newer.events.length, 1);
});

test('an in-flight ownership release rejects new scores and timer commands without losing the journal', () => {
  const saved = fixture();
  saved.packet = {
    id: 'release',
    expectedVersion: saved.revision,
    sessionId: saved.sessionId,
    type: 'OFFLINE_RELEASE',
    events: [],
  };
  const before = structuredClone(saved);
  assert.throws(
    () => appendJournalCommand(saved, { type: 'AWARD', side: 'WHITE', kind: 'YUKO' }),
    /OFFLINE_RELEASE_IN_PROGRESS/,
  );
  assert.throws(
    () => appendJournalCommand(saved, { type: 'START' }),
    /OFFLINE_RELEASE_IN_PROGRESS/,
  );
  assert.equal(canReleaseJournal(saved), false);
  assert.deepEqual(saved, before);
});
