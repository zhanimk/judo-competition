import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDraw,
  resolveMatches,
  placements,
  appendRematches,
  drawProgress,
  approveAdditionalRound,
  withdrawalProgress,
  type Draw,
} from '../src/draw/index.ts';
import {
  createMatch,
  applyCommand,
  tally,
  type Command,
  type MatchState,
  type Rules,
} from '../src/match/index.ts';
const entrants = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, clubId: `c${i % 3}` }));
const current = (format: string, n: number, seed = 19): Draw => ({
  ...generateDraw(format, entrants(n), seed, 'KNOCKOUT_FROM_SIX'),
  tieBreak: 'REMATCH',
  tieRanking: 'WINS_ONLY',
  tieMany: 'ADMIN_REVIEW',
  roundRobinMedals: 'TWO_BRONZE_FOR_FOUR_FIVE',
});

test('strict audit: all 640 outcome paths for six/seven entrants preserve distinct finalists and crossed bronze routes', () => {
  let paths = 0;
  for (const n of [6, 7]) {
    const draw = current('REPECHAGE', n);
    for (let mask = 0; mask < 2 ** draw.matches.length; mask++) {
      const winners: Record<string, string> = {};
      for (const [i, match] of draw.matches.entries()) {
        assert.equal(placements(draw, winners), null);
        const row = resolveMatches(draw, winners).find((m) => m.id === match.id)!;
        assert.ok(row.ready);
        winners[match.id] = mask & (2 ** i) ? row.whiteEntryId! : row.blueEntryId!;
      }
      const rows = resolveMatches(draw, winners);
      const podium = placements(draw, winners)!;
      assert.deepEqual(
        podium.map((p) => p.place),
        [1, 2, 3, 3],
      );
      assert.equal(new Set(podium.map((p) => p.entryId)).size, 4);
      const semis = rows.filter((m) => m.round === 2);
      const losers = semis.map((m) =>
        m.winnerEntryId === m.whiteEntryId ? m.blueEntryId : m.whiteEntryId,
      );
      const bronze = rows.filter((m) => m.stage === 'BRONZE');
      assert.deepEqual(
        bronze.map((m) => m.blueEntryId),
        [...losers].reverse(),
      );
      assert.ok(
        bronze.every(
          (m) =>
            ![podium[0].entryId, podium[1].entryId].includes(m.whiteEntryId!) &&
            ![podium[0].entryId, podium[1].entryId].includes(m.blueEntryId!),
        ),
      );
      paths++;
    }
  }
  assert.equal(paths, 640);
});

test('strict audit: all 1098 round-robin outcomes rank by independent victory counts, resolving every equal cohort explicitly', () => {
  let paths = 0;
  for (const n of [2, 3, 4, 5]) {
    const original = current('ROUND_ROBIN', n);
    for (let mask = 0; mask < 2 ** original.matches.length; mask++) {
      let draw = original;
      const wins = new Map(entrants(n).map((e) => [e.id, 0]));
      const winners: Record<string, string> = {};
      for (const [i, match] of original.matches.entries()) {
        assert.ok('entryId' in match.white && 'entryId' in match.blue);
        const winner = mask & (2 ** i) ? match.white.entryId : match.blue.entryId;
        winners[match.id] = winner;
        wins.set(winner, wins.get(winner)! + 1);
      }
      for (let step = 0; step < 10 && !drawProgress(draw, winners).complete; step++) {
        const progress = drawProgress(draw, winners);
        if (progress.pendingReviews.length) {
          const review = progress.pendingReviews[0];
          draw = approveAdditionalRound(draw, winners, {
            ...review,
            members: [...review.members].sort(),
            procedure: 'ORDERED_PLACES',
          });
        } else {
          draw = appendRematches(draw, winners);
          const ready = resolveMatches(draw, winners).filter((m) => m.ready);
          assert.ok(ready.length);
          for (const m of ready) winners[m.id] = [m.whiteEntryId!, m.blueEntryId!].sort()[0];
        }
      }
      const podium = placements(draw, winners)!;
      assert.ok(podium);
      const expected = entrants(n)
        .map((e) => e.id)
        .sort((a, b) => wins.get(b)! - wins.get(a)! || a.localeCompare(b));
      assert.deepEqual(
        podium.map((p) => p.entryId),
        expected,
      );
      assert.deepEqual(
        podium.map((p) => p.place),
        n === 5
          ? [1, 2, 3, 3, 5]
          : n === 4
            ? [1, 2, 3, 3]
            : Array.from({ length: n }, (_, i) => i + 1),
      );
      paths++;
    }
  }
  assert.equal(paths, 1098);
});

test('strict audit: every withdrawn subset in six/seven-person grids, before play and after each confirmed prefix, finishes without rewriting history', () => {
  for (const n of [6, 7]) {
    const original = current('REPECHAGE', n);
    const historical: Record<string, string> = {};
    for (let prefix = 0; prefix <= original.matches.length; prefix++) {
      for (let mask = 0; mask < 2 ** n; mask++) {
        const removed = entrants(n)
          .filter((_, i) => mask & (2 ** i))
          .map((e) => e.id);
        let result = withdrawalProgress({ ...original, withdrawnEntryIds: removed }, historical);
        for (
          let step = 0;
          step < original.matches.length && !drawProgress(result.snapshot, result.winners).complete;
          step++
        ) {
          const ready = resolveMatches(result.snapshot, result.winners).find((m) => m.ready);
          assert.ok(ready, `${n}/${prefix}/${mask}`);
          assert.ok(
            !removed.includes(ready.whiteEntryId!) && !removed.includes(ready.blueEntryId!),
          );
          result = withdrawalProgress(result.snapshot, {
            ...result.winners,
            [ready.id]: ready.whiteEntryId!,
          });
        }
        const podium = placements(result.snapshot, result.winners);
        assert.ok(podium);
        assert.equal(new Set(podium.map((p) => p.entryId)).size, podium.length);
        assert.ok(podium.every((p) => !removed.includes(p.entryId)));
        for (const [key, winner] of Object.entries(historical))
          assert.equal(result.winners[key], winner);
        assert.deepEqual(withdrawalProgress(result.snapshot, result.winners).walkovers, []);
      }
      if (prefix < original.matches.length) {
        const ready = resolveMatches(original, historical).find((m) => m.ready)!;
        historical[ready.id] = ready.whiteEntryId!;
      }
    }
  }
});

const rules: Rules = {
  durationMs: 120000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [
    { ms: 5000, score: 'YUKO' },
    { ms: 10000, score: 'WAZA_ARI' },
    { ms: 20000, score: 'IPPON' },
  ],
};
let id = 0;
const send = (state: MatchState, action: object) =>
  applyCommand(state, {
    ...action,
    id: `audit-${id++}`,
    expectedVersion: state.version,
  } as Command);
const sporting = (s: MatchState) => ({
  phase: s.phase,
  status: s.status,
  elapsedMs: s.elapsedMs,
  goldenMs: s.goldenMs,
  hold: s.hold && { side: s.hold.side, elapsedMs: s.hold.elapsedMs },
  outcome: s.outcome,
  white: tally(s, 'WHITE'),
  blue: tally(s, 'BLUE'),
});
test('strict audit: hold scoring and clocks are independent of tick partition in both phases and colours', () => {
  for (const side of ['WHITE', 'BLUE'])
    for (const golden of [false, true])
      for (const priorWaza of [false, true])
        for (const duration of [1, 4999, 5000, 5001, 9999, 10000, 19999, 20000, 30000]) {
          let initial = send(createMatch(rules), { type: 'START' });
          if (priorWaza) {
            initial = send(initial, { type: 'AWARD', side: 'WHITE', kind: 'WAZA_ARI' });
            initial = send(initial, { type: 'AWARD', side: 'BLUE', kind: 'WAZA_ARI' });
          }
          initial = send(initial, {
            type: 'ADVANCE',
            ms: golden ? rules.durationMs : rules.durationMs - 1000,
          });
          if (golden) {
            initial = send(initial, { type: 'GOLDEN' });
            initial = send(initial, { type: 'START' });
          }
          initial = send(initial, { type: 'HOLD', side });
          const large = send(initial, { type: 'ADVANCE', ms: duration });
          let small = initial;
          for (let elapsed = 0; elapsed < duration && small.status === 'RUNNING'; elapsed += 137)
            small = send(small, { type: 'ADVANCE', ms: Math.min(137, duration - elapsed) });
          assert.deepEqual(
            sporting(small),
            sporting(large),
            `${side}/${golden}/${priorWaza}/${duration}`,
          );
        }
});

test('strict audit: an unknown draw policy is rejected instead of silently using legacy rules', () => {
  assert.throws(
    () => generateDraw('ROUND_ROBIN', entrants(6), 1, 'UNKNOWN_PROFILE' as never),
    /DRAW_POLICY_UNSUPPORTED/,
  );
});

test('strict audit: accumulated Golden Score time cannot exceed exact integer storage', () => {
  let state = send(createMatch(rules), { type: 'START' });
  state = send(state, { type: 'ADVANCE', ms: rules.durationMs });
  state = send(state, { type: 'GOLDEN' });
  state = send(state, { type: 'START' });
  state = send(state, { type: 'ADVANCE', ms: Number.MAX_SAFE_INTEGER });
  const before = structuredClone(state);
  assert.throws(() => send(state, { type: 'ADVANCE', ms: 1 }), /INVALID_TIME/);
  assert.deepEqual(state, before);
});
