import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatch, type Rules } from '@judo/engine/match';
import { mergeCommandResponse } from '../src/features/live/command-response.ts';
import type { View } from '../src/features/live/live-board';

const rules: Rules = {
  durationMs: 60000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [{ ms: 20000, score: 'IPPON' }],
};
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
