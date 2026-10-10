import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatch, applyCommand } from '@judo/engine/match';
import { refreshParticipantNames } from '../src/features/live/participant-names.ts';
import type { View } from '../src/features/live/live-board';

function fixture(): View {
  let state = createMatch({
    durationMs: 180000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
    holdThresholds: [{ ms: 20000, score: 'IPPON' }],
  });
  state = applyCommand(state, { id: 'start', expectedVersion: state.version, type: 'START' });
  state = applyCommand(state, {
    id: 'score',
    expectedVersion: state.version,
    type: 'AWARD',
    side: 'WHITE',
    kind: 'YUKO',
  });
  state = applyCommand(state, {
    id: 'tick',
    expectedVersion: state.version,
    type: 'ADVANCE',
    ms: 7000,
  });
  return {
    tournamentId: 'tournament',
    tournamentName: 'QA',
    tournamentStatus: 'RUNNING',
    number: 1,
    currentMatch: {
      id: 'bout',
      key: 'R1M1',
      category: 'U15',
      revision: 3,
      state,
      white: { id: 'white', firstName: 'Али', lastName: 'Старая', club: 'Клуб 1' },
      blue: { id: 'blue', firstName: 'Нур', lastName: 'Верная', club: 'Клуб 2' },
    },
    lastResult: null,
  };
}

test('a reconnected offline scoreboard refreshes names while preserving its local time, scores and IDs', () => {
  const saved = fixture(),
    before = structuredClone(saved),
    live = structuredClone(saved);
  live.currentMatch!.white.firstName = 'Әли';
  live.currentMatch!.white.lastName = 'Исправленная';
  live.currentMatch!.state.elapsedMs = 0;
  live.currentMatch!.revision = 1;
  live.currentMatch!.white.club = 'Must not replace local metadata';
  const display = refreshParticipantNames(saved, live);
  assert.equal(display.currentMatch!.white.lastName, 'Исправленная');
  assert.equal(display.currentMatch!.white.firstName, 'Әли');
  assert.equal(display.currentMatch!.white.id, 'white');
  assert.equal(display.currentMatch!.white.club, 'Клуб 1');
  assert.equal(display.currentMatch!.state, saved.currentMatch!.state);
  assert.equal(display.currentMatch!.revision, saved.currentMatch!.revision);
  assert.deepEqual(
    saved,
    before,
    'the offline journal remains valid evidence and is never rewritten',
  );
  assert.equal(display.currentMatch!.state.elapsedMs, 7000);
});

test('another tournament, another bout or changed sides never rebind a saved offline scoreboard', () => {
  const saved = fixture();
  for (const change of [
    (v: View) => {
      v.tournamentId = 'foreign';
    },
    (v: View) => {
      v.currentMatch!.id = 'next-bout';
    },
    (v: View) => {
      v.currentMatch!.white.id = 'another-athlete';
    },
    (v: View) => {
      [v.currentMatch!.white, v.currentMatch!.blue] = [v.currentMatch!.blue, v.currentMatch!.white];
    },
  ]) {
    const live = structuredClone(saved);
    change(live);
    assert.equal(refreshParticipantNames(saved, live), saved);
  }
});

test('loss of connection or absent participants keeps the last known identity without a crash', () => {
  const saved = fixture();
  assert.equal(refreshParticipantNames(saved, null), saved);
  assert.equal(refreshParticipantNames(saved, { ...saved, currentMatch: null }), saved);
  const incomplete = structuredClone(saved);
  incomplete.currentMatch!.white = null as unknown as NonNullable<View['currentMatch']>['white'];
  assert.equal(refreshParticipantNames(saved, incomplete), saved);
});
