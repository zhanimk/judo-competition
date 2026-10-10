import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, createMatch } from '@judo/engine/match';
import { resultClock } from '../src/features/live/result-clock.ts';

test('a confirmed Golden Score third-shido result at zero elapsed time still identifies the phase', () => {
  let state = createMatch({
    durationMs: 60000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
    holdThresholds: [],
  });
  let id = 0;
  const act = (command: Parameters<typeof applyCommand>[1]) => {
    state = applyCommand(state, command);
  };
  for (const command of [
    { type: 'START' },
    { type: 'ADVANCE', ms: 60000 },
    { type: 'GOLDEN' },
    { type: 'START' },
    ...Array.from({ length: 3 }, () => ({ type: 'AWARD', side: 'WHITE', kind: 'SHIDO' })),
    { type: 'CONFIRM' },
  ])
    act({ ...command, id: String(++id), expectedVersion: state.version } as Parameters<
      typeof applyCommand
    >[1]);
  assert.equal(state.outcome?.reason, 'ACCUMULATED_SHIDO');
  assert.equal(state.goldenMs, 0);
  assert.equal(resultClock(state), '1:00.0 + GS 0:00.0');
});

test('regular results preserve elapsed tenths without inventing a Golden Score phase', () => {
  const state = createMatch({
    durationMs: 60000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['IPPON'],
    holdThresholds: [],
  });
  state.elapsedMs = 35499;
  assert.equal(resultClock(state), '0:35.4');
  assert.equal(resultClock(null), '—');
});
