import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyCommand, tally, scoreboardScores } from '../src/match/index.ts';
import type { Rules, Command } from '../src/match/index.ts';
const rules: Rules = {
  durationMs: 60000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [
    { ms: 5000, score: 'YUKO' },
    { ms: 10000, score: 'WAZA_ARI' },
    { ms: 20000, score: 'IPPON' },
  ],
};
type Action = Command extends infer C
  ? C extends Command
    ? Omit<C, 'id' | 'expectedVersion'>
    : never
  : never;
function fixture() {
  let state = createMatch(rules);
  return {
    get state() {
      return state;
    },
    send(action: Action) {
      const command = {
        ...action,
        id: `c${state.version}`,
        expectedVersion: state.version,
      } as Command;
      state = applyCommand(state, command);
      return command;
    },
  };
}
test('idempotent delivery, stale version, reused ID and immutable input', () => {
  const f = fixture(),
    before = structuredClone(f.state);
  const command = f.send({ type: 'START' });
  assert.equal(before.status, 'READY');
  assert.deepEqual(applyCommand(f.state, command), f.state);
  assert.throws(() => applyCommand(f.state, { ...command, type: 'STOP' }), /COMMAND_ID_REUSED/);
  assert.throws(() => applyCommand(f.state, { ...command, id: 'new' }), /VERSION_CONFLICT/);
});

test('idempotent delivery accepts reordered JSON keys and receipts from older snapshots', () => {
  const original: Command = { type: 'START', expectedVersion: 0, id: 'start' };
  const reordered: Command = { id: 'start', expectedVersion: 0, type: 'START' };
  const state = applyCommand(createMatch(rules), original);
  assert.deepEqual(applyCommand(state, reordered), state);
  const legacy = { ...state, receipts: { start: JSON.stringify(original) } };
  assert.deepEqual(applyCommand(legacy, reordered), legacy);
  assert.throws(() => applyCommand(state, { ...reordered, type: 'STOP' }), /COMMAND_ID_REUSED/);
});
test('third shido proposes winner, revocation pauses and preserves history', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'AWARD', side: 'BLUE', kind: 'SHIDO' });
  f.send({ type: 'AWARD', side: 'BLUE', kind: 'SHIDO' });
  const third = f.send({ type: 'AWARD', side: 'BLUE', kind: 'SHIDO' });
  assert.equal(f.state.outcome?.winner, 'WHITE');
  assert.equal(f.state.status, 'PROVISIONAL');
  f.send({ type: 'REVOKE', awardId: third.id });
  assert.equal(f.state.status, 'PAUSED');
  assert.equal(Boolean(f.state.outcome), false);
  assert.equal(tally(f.state, 'BLUE').SHIDO, 2);
  assert.equal(f.state.awards.length, 3);
});
test('ippon and two waza-ari; confirmed result locked', () => {
  for (const kinds of [['IPPON'], ['WAZA_ARI', 'WAZA_ARI']] as const) {
    const f = fixture();
    f.send({ type: 'START' });
    for (const kind of kinds) f.send({ type: 'AWARD', side: 'WHITE', kind });
    assert.equal(f.state.outcome?.winner, 'WHITE');
    f.send({ type: 'CONFIRM' });
    assert.throws(() => f.send({ type: 'START' }), /RESULT_LOCKED/);
  }
});
test('regular expiry compares scores; tie requires explicit golden and start', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'ADVANCE', ms: 60000 });
  assert.equal(f.state.status, 'DECISION');
  f.send({ type: 'GOLDEN' });
  assert.equal(f.state.status, 'PAUSED');
  f.send({ type: 'START' });
  f.send({ type: 'AWARD', side: 'BLUE', kind: 'SHIDO' });
  assert.equal(Boolean(f.state.outcome), false);
  f.send({ type: 'AWARD', side: 'WHITE', kind: 'YUKO' });
  assert.equal(f.state.outcome?.reason, 'GOLDEN_SCORE');
  const g = fixture();
  g.send({ type: 'START' });
  g.send({ type: 'AWARD', side: 'BLUE', kind: 'YUKO' });
  g.send({ type: 'ADVANCE', ms: 60000 });
  assert.equal(g.state.outcome?.winner, 'BLUE');
});
test('hold survives regular expiry and yields only one final score', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'ADVANCE', ms: 59000 });
  f.send({ type: 'HOLD', side: 'WHITE' });
  f.send({ type: 'ADVANCE', ms: 11000 });
  assert.equal(f.state.status, 'RUNNING');
  assert.equal(f.state.elapsedMs, 60000);
  assert.equal(tally(f.state, 'WHITE').WAZA_ARI, 1);
  f.send({ type: 'TOKETA' });
  assert.equal(tally(f.state, 'WHITE').WAZA_ARI, 1);
  assert.equal(tally(f.state, 'WHITE').YUKO, 0);
  assert.equal(f.state.outcome?.winner, 'WHITE');
});
test('terminal hold clamps time to exact threshold even with delayed tick', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'HOLD', side: 'BLUE' });
  f.send({ type: 'ADVANCE', ms: 30000 });
  assert.equal(f.state.elapsedMs, 20000);
  assert.equal(f.state.awards.length, 1);
  assert.equal(f.state.outcome?.winner, 'BLUE');
  const g = fixture();
  g.send({ type: 'START' });
  g.send({ type: 'ADVANCE', ms: 60000 });
  g.send({ type: 'GOLDEN' });
  g.send({ type: 'START' });
  g.send({ type: 'HOLD', side: 'WHITE' });
  g.send({ type: 'ADVANCE', ms: 30000 });
  assert.equal(g.state.goldenMs, 5000);
  assert.equal(tally(g.state, 'WHITE').YUKO, 1);
});
test('existing waza makes hold terminate at combination threshold', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'AWARD', side: 'WHITE', kind: 'WAZA_ARI' });
  f.send({ type: 'HOLD', side: 'WHITE' });
  f.send({ type: 'ADVANCE', ms: 20000 });
  assert.equal(f.state.elapsedMs, 10000);
  assert.equal(f.state.outcome?.reason, 'COMBINATION');
});
test('reject bad profile, disabled scores, negative time and ambiguous stop', () => {
  assert.throws(() => createMatch({ ...rules, durationMs: 0 }), /INVALID_DURATION/);
  assert.throws(
    () => createMatch({ ...rules, holdThresholds: [...rules.holdThresholds].reverse() }),
    /INVALID_THRESHOLDS/,
  );
  let state = createMatch({ ...rules, enabledScores: ['IPPON'], holdThresholds: [] });
  state = applyCommand(state, { id: 'start', expectedVersion: 0, type: 'START' });
  assert.throws(
    () =>
      applyCommand(state, {
        id: 'bad',
        expectedVersion: 1,
        type: 'AWARD',
        side: 'WHITE',
        kind: 'YUKO',
      }),
    /DISABLED_SCORE/,
  );
  const f = fixture();
  f.send({ type: 'START' });
  assert.throws(() => f.send({ type: 'ADVANCE', ms: -1 }), /INVALID_TIME/);
  f.send({ type: 'HOLD', side: 'WHITE' });
  assert.throws(() => f.send({ type: 'STOP' }), /RESOLVE_HOLD_FIRST/);
});

test('hold boundary milliseconds: below threshold, exact yuko, waza and ippon', () => {
  for (const [ms, kind] of [
    [4999, null],
    [5000, 'YUKO'],
    [9999, 'YUKO'],
    [10000, 'WAZA_ARI'],
    [19999, 'WAZA_ARI'],
    [20000, 'IPPON'],
  ] as const) {
    const f = fixture();
    f.send({ type: 'START' });
    f.send({ type: 'HOLD', side: 'WHITE' });
    f.send({ type: 'ADVANCE', ms });
    const score = tally(f.state, 'WHITE');
    assert.equal(score.YUKO, kind === 'YUKO' ? 1 : 0);
    assert.equal(score.WAZA_ARI, kind === 'WAZA_ARI' ? 1 : 0);
    assert.equal(score.IPPON, kind === 'IPPON' ? 1 : 0);
    if (f.state.hold) {
      f.send({ type: 'TOKETA' });
      assert.deepEqual(tally(f.state, 'WHITE'), score);
    }
  }
});

test('live hold upgrades one award, survives reload, and does not award a second waza on ticks', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'AWARD', side: 'BLUE', kind: 'YUKO' });
  f.send({ type: 'HOLD', side: 'BLUE' });
  const yuko = f.send({ type: 'ADVANCE', ms: 5000 });
  assert.equal(tally(f.state, 'BLUE').YUKO, 2);
  assert.deepEqual(applyCommand(f.state, yuko), f.state);
  const waza = f.send({ type: 'ADVANCE', ms: 5000 });
  assert.equal(tally(f.state, 'BLUE').YUKO, 1);
  assert.equal(tally(f.state, 'BLUE').WAZA_ARI, 1);
  assert.equal(f.state.awards.find((a) => a.id === yuko.id)?.active, false);
  const reloaded = JSON.parse(JSON.stringify(f.state));
  const next = f.send({ type: 'ADVANCE', ms: 9999 });
  assert.deepEqual(applyCommand(reloaded, next), f.state);
  assert.equal(f.state.status, 'RUNNING');
  assert.equal(f.state.hold?.elapsedMs, 19999);
  assert.equal(f.state.awards.filter((a) => a.active).length, 2);
  const ippon = f.send({ type: 'ADVANCE', ms: 1000 });
  assert.equal(f.state.elapsedMs, 20000);
  assert.equal(f.state.status, 'PROVISIONAL');
  assert.deepEqual(tally(f.state, 'BLUE'), { YUKO: 1, WAZA_ARI: 0, IPPON: 1, SHIDO: 0 });
  assert.equal(f.state.awards.find((a) => a.id === waza.id)?.active, false);
  f.send({ type: 'REVOKE', awardId: ippon.id });
  assert.equal(f.state.status, 'PAUSED');
  assert.deepEqual(tally(f.state, 'BLUE'), { YUKO: 1, WAZA_ARI: 0, IPPON: 0, SHIDO: 0 });
});

test('separate holds retain scores; second waza ends at ten seconds with incremental ticks', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'HOLD', side: 'WHITE' });
  f.send({ type: 'ADVANCE', ms: 10000 });
  f.send({ type: 'TOKETA' });
  f.send({ type: 'HOLD', side: 'WHITE' });
  f.send({ type: 'ADVANCE', ms: 5000 });
  assert.equal(tally(f.state, 'WHITE').YUKO, 1);
  f.send({ type: 'ADVANCE', ms: 10000 });
  assert.equal(f.state.elapsedMs, 20000);
  assert.equal(f.state.outcome?.reason, 'COMBINATION');
  assert.deepEqual(tally(f.state, 'WHITE'), { YUKO: 0, WAZA_ARI: 2, IPPON: 0, SHIDO: 0 });
});

test('custom thresholds remain authoritative and old running snapshots can acquire a hold award', () => {
  let state = createMatch({ ...rules, holdThresholds: [{ ms: 8000, score: 'WAZA_ARI' }] });
  state = { ...state, status: 'RUNNING', hold: { side: 'WHITE', elapsedMs: 7999 } };
  state = applyCommand(state, { id: 'tick', expectedVersion: 0, type: 'ADVANCE', ms: 1 });
  assert.equal(tally(state, 'WHITE').WAZA_ARI, 1);
  state = applyCommand(state, { id: 'more', expectedVersion: 1, type: 'ADVANCE', ms: 10000 });
  assert.equal(state.status, 'RUNNING');
  assert.equal(tally(state, 'WHITE').WAZA_ARI, 1);
});
test('stopped timer rejects advancement; confirmed outcome rejects correction', () => {
  const f = fixture();
  f.send({ type: 'START' });
  f.send({ type: 'ADVANCE', ms: 1234 });
  f.send({ type: 'STOP' });
  assert.throws(() => f.send({ type: 'ADVANCE', ms: 1000 }), /INVALID_TRANSITION/);
  assert.equal(f.state.elapsedMs, 1234);
  const score = f.send({ type: 'AWARD', side: 'BLUE', kind: 'IPPON' });
  f.send({ type: 'CONFIRM' });
  assert.throws(() => f.send({ type: 'REVOKE', awardId: score.id }), /RESULT_LOCKED/);
});

test('golden score award can be revoked without deleting regular scores or rewinding time', () => {
  const f = fixture();
  f.send({ type: 'START' });
  const regular = f.send({ type: 'AWARD', side: 'WHITE', kind: 'YUKO' });
  f.send({ type: 'AWARD', side: 'BLUE', kind: 'YUKO' });
  f.send({ type: 'ADVANCE', ms: 60000 });
  f.send({ type: 'GOLDEN' });
  f.send({ type: 'START' });
  f.send({ type: 'ADVANCE', ms: 3210 });
  const gold = f.send({ type: 'AWARD', side: 'BLUE', kind: 'YUKO' });
  assert.equal(f.state.outcome?.winner, 'BLUE');
  assert.throws(
    () => f.send({ type: 'REVOKE', awardId: regular.id }),
    /CORRECTION_REQUIRES_REVIEW/,
  );
  f.send({ type: 'REVOKE', awardId: gold.id });
  assert.equal(f.state.status, 'PAUSED');
  assert.equal(Boolean(f.state.outcome), false);
  assert.equal(f.state.goldenMs, 3210);
  assert.equal(tally(f.state, 'BLUE').YUKO, 1);
  f.send({ type: 'START' });
  f.send({ type: 'AWARD', side: 'WHITE', kind: 'WAZA_ARI' });
  assert.equal(f.state.outcome?.winner, 'WHITE');
});

test('third shido displays opponent ippon in either colour and phase; undo removes only derived ippon', () => {
  for (const penalized of ['WHITE', 'BLUE'] as const) {
    for (const phase of ['REGULAR', 'GOLDEN'] as const) {
      const winner = penalized === 'WHITE' ? 'BLUE' : 'WHITE';
      const f = fixture();
      f.send({ type: 'START' });
      if (phase === 'GOLDEN') {
        f.send({ type: 'ADVANCE', ms: rules.durationMs });
        f.send({ type: 'GOLDEN' });
        f.send({ type: 'START' });
      } else {
        f.send({ type: 'AWARD', side: winner, kind: 'YUKO' });
      }
      f.send({ type: 'AWARD', side: penalized, kind: 'SHIDO' });
      f.send({ type: 'AWARD', side: penalized, kind: 'SHIDO' });
      assert.equal(scoreboardScores(f.state, winner).IPPON, 0);
      const third = f.send({ type: 'AWARD', side: penalized, kind: 'SHIDO' });
      assert.deepEqual(f.state.outcome, { winner, reason: 'ACCUMULATED_SHIDO' });
      assert.equal(f.state.status, 'PROVISIONAL');
      assert.equal(scoreboardScores(f.state, winner).IPPON, 1);
      assert.equal(scoreboardScores(f.state, penalized).IPPON, 0);
      assert.equal(scoreboardScores(f.state, penalized).SHIDO, 3);
      assert.equal(tally(f.state, winner).IPPON, 0);
      assert.equal(
        f.state.awards.some((award) => award.kind === 'IPPON'),
        false,
      );
      assert.equal(scoreboardScores(applyCommand(f.state, third), winner).IPPON, 1);
      f.send({ type: 'REVOKE', awardId: third.id });
      assert.equal(f.state.status, 'PAUSED');
      assert.equal(f.state.outcome, null);
      assert.equal(scoreboardScores(f.state, winner).IPPON, 0);
      assert.equal(scoreboardScores(f.state, penalized).SHIDO, 2);
      assert.equal(scoreboardScores(f.state, winner).YUKO, phase === 'REGULAR' ? 1 : 0);
      f.send({ type: 'AWARD', side: penalized, kind: 'SHIDO' });
      f.send({ type: 'CONFIRM' });
      const restored = JSON.parse(JSON.stringify(f.state));
      assert.equal(scoreboardScores(restored, winner).IPPON, 1);
      assert.equal(restored.outcome.reason, 'ACCUMULATED_SHIDO');
    }
  }
});
