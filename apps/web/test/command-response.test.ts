import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, createMatch, type Rules } from '@judo/engine/match';
import { mergeCommandResponse, isMatchState } from '../src/features/live/command-response.ts';
import type { View } from '../src/features/live/live-board';

const rules: Rules = {
  durationMs: 60000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [{ ms: 20000, score: 'IPPON' }],
};
test('administrative walkover and withdrawal snapshots remain readable for recovery without accepting provisional invented outcomes', () => {
  for (const reason of ['WALKOVER', 'WITHDRAWAL']) {
    const state = {
      ...createMatch(rules),
      status: 'CONFIRMED',
      outcome: { winner: 'WHITE', reason },
    };
    assert.equal(isMatchState(state), true);
    assert.equal(isMatchState({ ...state, status: 'PROVISIONAL' }), false);
    assert.equal(isMatchState({ ...state, hold: { side: 'WHITE', elapsedMs: 10 } }), false);
  }
  assert.equal(
    isMatchState({
      ...createMatch(rules),
      status: 'CONFIRMED',
      outcome: { winner: 'WHITE', reason: 'NO_CONTEST' },
    }),
    false,
  );
});
function fixture(): View {
  return {
    tournamentId: 't',
    tournamentName: 'Tournament',
    tournamentStatus: 'RUNNING',
    number: 1,
    currentMatch: {
      id: 'match',
      key: '1',
      category: 'Category',
      revision: 10,
      state: createMatch(rules),
      white: { id: 'white', firstName: 'White', lastName: 'Athlete', club: 'Club' },
      blue: { id: 'blue', firstName: 'Blue', lastName: 'Athlete', club: 'Club' },
    },
    lastResult: null,
  };
}

test('a replayed old confirmation cannot hide a match reopened at a higher revision', () => {
  const view = fixture();
  const result = { revision: 9, status: 'CONFIRMED', state: createMatch(rules) };
  assert.equal(mergeCommandResponse(view, 'match', result), view);
  assert.equal(mergeCommandResponse(view, 'another-match', { ...result, revision: 11 }), view);
});

test('a current command receipt updates scores and a current confirmation clears the match', () => {
  const view = fixture();
  const state = { ...view.currentMatch!.state, elapsedMs: 25000 };
  const updated = mergeCommandResponse(view, 'match', { revision: 11, status: 'ACTIVE', state })!;
  assert.equal(updated.currentMatch!.revision, 11);
  assert.equal(updated.currentMatch!.state.elapsedMs, 25000);
  assert.equal(view.currentMatch!.revision, 10);
  const confirmed = mergeCommandResponse(updated, 'match', {
    revision: 12,
    status: 'CONFIRMED',
    state,
  })!;
  assert.equal(confirmed.currentMatch, null);
});

test('a replayed receipt cannot rewind clock ticks that advanced state at the same contest revision', () => {
  const view = fixture();
  const start = applyCommand(view.currentMatch!.state, {
    id: 'start',
    expectedVersion: 0,
    type: 'START',
  });
  const advanced = applyCommand(start, {
    id: 'tick',
    expectedVersion: start.version,
    type: 'ADVANCE',
    ms: 25000,
  });
  view.currentMatch!.state = advanced;
  const receipt = { revision: view.currentMatch!.revision, status: 'ACTIVE', state: start };
  assert.equal(mergeCommandResponse(view, 'match', receipt), view);
  assert.equal(view.currentMatch!.state.elapsedMs, 25000);
  const newer = applyCommand(advanced, {
    id: 'stop',
    expectedVersion: advanced.version,
    type: 'STOP',
  });
  assert.equal(
    mergeCommandResponse(view, 'match', { ...receipt, state: newer })?.currentMatch?.state.status,
    'PAUSED',
  );
});
