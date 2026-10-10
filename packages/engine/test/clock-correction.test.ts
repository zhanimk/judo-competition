import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCommand,
  correctStoppedClock,
  createMatch,
  MAX_CORRECTED_GOLDEN_MS,
  tally,
} from '../src/match/index.ts';
import type { Command, MatchState, Rules } from '../src/match/index.ts';

const rules: Rules = {
  durationMs: 60000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [
    { ms: 10000, score: 'WAZA_ARI' },
    { ms: 20000, score: 'IPPON' },
  ],
};
let nextId = 0;
const send = (state: MatchState, action: Omit<Command, 'id' | 'expectedVersion'>) =>
  applyCommand(state, {
    ...action,
    id: 'clock-fixture-' + nextId++,
    expectedVersion: state.version,
  } as Command);
function paused() {
  return send(
    send(send(createMatch(rules), { type: 'START' }), { type: 'ADVANCE', ms: 12000 } as Command),
    { type: 'STOP' },
  );
}
function golden() {
  return send(
    send(send(createMatch(rules), { type: 'START' }), {
      type: 'ADVANCE',
      ms: rules.durationMs,
    } as Command),
    { type: 'GOLDEN' },
  );
}
test('correcting a paused regular clock preserves phase, scores/history and immutable input', () => {
  let input = paused();
  input = send(input, { type: 'AWARD', side: 'WHITE', kind: 'YUKO' } as Command);
  const before = structuredClone(input);
  const result = correctStoppedClock(input, { phase: 'REGULAR', elapsedMs: 17000 });
  assert.deepEqual(input, before);
  assert.equal(result.elapsedMs, 17000);
  assert.equal(result.goldenMs, input.goldenMs);
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.phase, input.phase);
  assert.equal(result.version, input.version + 1);
  assert.deepEqual(result.awards, input.awards);
  assert.deepEqual(result.receipts, input.receipts);
  assert.deepEqual(result.rules, input.rules);
  assert.equal(result.outcome, null);
  assert.equal(tally(result, 'WHITE').YUKO, 1);
});
test('regular exact expiry uses the existing tie decision and a correction can restore stopped time', () => {
  const decision = correctStoppedClock(paused(), { phase: 'REGULAR', elapsedMs: 60000 });
  assert.equal(decision.status, 'DECISION');
  assert.equal(decision.outcome, null);
  assert.equal(decision.phase, 'REGULAR');
  assert.throws(() => send(decision, { type: 'START' }), /INVALID_TRANSITION/);
  const corrected = correctStoppedClock(decision, { phase: 'REGULAR', elapsedMs: 59900 });
  assert.equal(corrected.status, 'PAUSED');
  assert.equal(corrected.elapsedMs, 59900);
  assert.equal(corrected.phase, 'REGULAR');
  assert.equal(send(corrected, { type: 'START' }).status, 'RUNNING');
});
test('regular exact expiry with a score lead proposes the existing TIME outcome, without confirming it', () => {
  const input = send(paused(), { type: 'AWARD', side: 'BLUE', kind: 'YUKO' } as Command);
  const result = correctStoppedClock(input, { phase: 'REGULAR', elapsedMs: 60000 });
  assert.equal(result.status, 'PROVISIONAL');
  assert.deepEqual(result.outcome, { winner: 'BLUE', reason: 'TIME' });
  assert.deepEqual(result.awards, input.awards);
  assert.equal(result.phase, 'REGULAR');
});
test('unconfirmed TIME outcome can restore stopped regular time without removing scores and expires again consistently', () => {
  const scored = send(paused(), { type: 'AWARD', side: 'BLUE', kind: 'YUKO' } as Command);
  const premature = correctStoppedClock(scored, { phase: 'REGULAR', elapsedMs: rules.durationMs });
  const before = structuredClone(premature);
  const restored = correctStoppedClock(premature, { phase: 'REGULAR', elapsedMs: 50000 });
  assert.deepEqual(premature, before);
  assert.equal(restored.status, 'PAUSED');
  assert.equal(restored.outcome, null);
  assert.equal(restored.elapsedMs, 50000);
  assert.equal(restored.phase, 'REGULAR');
  assert.deepEqual(restored.awards, premature.awards);
  assert.equal(restored.version, premature.version + 1);
  const reexpired = correctStoppedClock(restored, {
    phase: 'REGULAR',
    elapsedMs: rules.durationMs,
  });
  assert.equal(reexpired.status, 'PROVISIONAL');
  assert.deepEqual(reexpired.outcome, premature.outcome);
  assert.deepEqual(reexpired.awards, premature.awards);
});
test('TIME exception cannot edit a confirmed outcome or other provisional outcomes and does not cross into Golden Score', () => {
  const scored = send(paused(), { type: 'AWARD', side: 'BLUE', kind: 'YUKO' } as Command);
  const time = correctStoppedClock(scored, { phase: 'REGULAR', elapsedMs: rules.durationMs });
  assert.throws(
    () => correctStoppedClock(send(time, { type: 'CONFIRM' }), { phase: 'REGULAR', elapsedMs: 0 }),
    /PAUSE_REQUIRED/,
  );
  for (const reason of ['IPPON', 'COMBINATION', 'ACCUMULATED_SHIDO', 'GOLDEN_SCORE']) {
    const other = { ...time, outcome: { winner: 'BLUE' as const, reason } };
    assert.throws(
      () => correctStoppedClock(other, { phase: 'REGULAR', elapsedMs: 0 }),
      /PAUSE_REQUIRED/,
    );
  }
  assert.throws(
    () => correctStoppedClock({ ...time, phase: 'GOLDEN' }, { phase: 'GOLDEN', elapsedMs: 0 }),
    /PAUSE_REQUIRED/,
  );
  assert.throws(
    () => correctStoppedClock(time, { phase: 'GOLDEN', elapsedMs: 0 }),
    /CLOCK_PHASE_MISMATCH/,
  );
});
test('Golden Score correction preserves regular clock and has an explicit technical six-hour bound', () => {
  const input = golden();
  for (const elapsedMs of [0, 1, MAX_CORRECTED_GOLDEN_MS]) {
    const corrected = correctStoppedClock(input, { phase: 'GOLDEN', elapsedMs });
    assert.equal(corrected.goldenMs, elapsedMs);
    assert.equal(corrected.elapsedMs, input.elapsedMs);
    assert.equal(corrected.phase, 'GOLDEN');
    assert.equal(corrected.status, 'PAUSED');
    assert.equal(corrected.outcome, null);
  }
  assert.equal(MAX_CORRECTED_GOLDEN_MS, 21600000);
  assert.throws(
    () => correctStoppedClock(input, { phase: 'GOLDEN', elapsedMs: MAX_CORRECTED_GOLDEN_MS + 1 }),
    /INVALID_TIME/,
  );
});
test('clock correction rejects running, unstarted, provisional and confirmed states', () => {
  const ready = createMatch(rules);
  const running = send(ready, { type: 'START' });
  const provisional = send(running, { type: 'AWARD', side: 'WHITE', kind: 'IPPON' } as Command);
  const confirmed = send(provisional, { type: 'CONFIRM' });
  for (const input of [ready, running, provisional, confirmed]) {
    const before = structuredClone(input);
    assert.throws(
      () => correctStoppedClock(input, { phase: 'REGULAR', elapsedMs: 0 }),
      /PAUSE_REQUIRED/,
    );
    assert.deepEqual(input, before);
  }
});
test('clock correction cannot resolve a saved hold or bypass a saved outcome', () => {
  const holding = send(send(createMatch(rules), { type: 'START' }), {
    type: 'HOLD',
    side: 'WHITE',
  } as Command);
  const stoppedHold = send(holding, { type: 'RECOVER' });
  assert.throws(
    () => correctStoppedClock(stoppedHold, { phase: 'REGULAR', elapsedMs: 0 }),
    /RESOLVE_HOLD_FIRST/,
  );
  const invalidOutcome = { ...paused(), outcome: { winner: 'WHITE' as const, reason: 'TIME' } };
  assert.throws(
    () => correctStoppedClock(invalidOutcome, { phase: 'REGULAR', elapsedMs: 0 }),
    /RESULT_LOCKED/,
  );
});
test('clock phase and exact integer bounds are validated without clamping or changing input', () => {
  const input = paused();
  const before = structuredClone(input);
  assert.throws(
    () => correctStoppedClock(input, { phase: 'GOLDEN', elapsedMs: 0 }),
    /CLOCK_PHASE_MISMATCH/,
  );
  for (const elapsedMs of [-1, 0.1, NaN, Infinity, 60001, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => correctStoppedClock(input, { phase: 'REGULAR', elapsedMs }),
      /INVALID_TIME/,
    );
  assert.equal(correctStoppedClock(input, { phase: 'REGULAR', elapsedMs: 0 }).elapsedMs, 0);
  assert.deepEqual(input, before);
});
test('clock correction is excluded from regular and offline judge command types', () => {
  assert.throws(
    () =>
      applyCommand(paused(), {
        id: 'forbidden',
        expectedVersion: paused().version,
        type: 'EDIT_TIME',
        phase: 'REGULAR',
        elapsedMs: 0,
      } as unknown as Command),
    /UNKNOWN_COMMAND/,
  );
});
