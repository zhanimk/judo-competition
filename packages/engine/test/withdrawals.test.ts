import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDraw,
  generateDraw,
  resolveMatches,
  withdrawEntry,
  withdrawalProgress,
  drawProgress,
  placements,
  approveAdditionalRound,
  type Draw,
} from '../src/draw/index.ts';
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `athlete-${i}`, clubId: `club-${i}` }));
const v4 = (draw: Draw): Draw => ({
  ...draw,
  tieBreak: 'REMATCH',
  tieRanking: 'WINS_ONLY',
  tieMany: 'ADMIN_REVIEW',
});

test('withdrawal awards only future pairs and preserves every confirmed historical result', () => {
  const draw = v4(generateDraw('ROUND_ROBIN', entries(4), 15));
  const first = resolveMatches(draw, {})[0];
  const winners = { [first.id]: first.whiteEntryId! };
  const before = structuredClone({ draw, winners });
  const result = withdrawEntry(draw, winners, first.whiteEntryId!);
  assert.equal(result.winners[first.id], first.whiteEntryId);
  assert.equal(result.walkovers.length, 2);
  assert.ok(result.walkovers.every((m) => m.winnerEntryId !== first.whiteEntryId));
  assert.deepEqual({ draw, winners }, before);
  assert.deepEqual(withdrawalProgress(result.snapshot, result.winners).walkovers, []);
  assert.throws(
    () => withdrawEntry(result.snapshot, result.winners, first.whiteEntryId!),
    /ALREADY_WITHDRAWN/,
  );
  assert.throws(() => withdrawEntry(draw, {}, 'foreign'), /UNKNOWN/);
  assert.throws(
    () => withdrawEntry(createDraw(entries(4), 1), {}, entries(4)[0].id),
    /V4_REQUIRED/,
  );
});

test('two removed athletes create an empty branch and the next opponent advances without a fictional winner', () => {
  const draw = v4(createDraw(entries(4), 2));
  const opening = resolveMatches(draw, {});
  const empty = opening[0],
    other = opening[1];
  const planned = withdrawalProgress(
    { ...draw, withdrawnEntryIds: [empty.whiteEntryId!, empty.blueEntryId!] },
    { [other.id]: other.whiteEntryId! },
  );
  assert.ok(planned.snapshot.voidMatches?.includes(empty.id));
  assert.equal(planned.winners[empty.id], undefined);
  assert.equal(planned.walkovers.find((m) => m.key === empty.id)?.winnerEntryId, null);
  assert.equal(drawProgress(planned.snapshot, planned.winners).complete, true);
  assert.equal(placements(planned.snapshot, planned.winners)?.[0].entryId, other.whiteEntryId);
  assert.ok(
    !placements(planned.snapshot, planned.winners)?.some((p) =>
      planned.snapshot.withdrawnEntryIds!.includes(p.entryId),
    ),
  );
});

test('round robin withdrawal completes remaining walkovers but removed athletes never receive places', () => {
  const draw = v4(generateDraw('ROUND_ROBIN', entries(3), 4));
  const [remaining, ...removed] = draw.positions.map((e) => e!.id);
  const planned = withdrawalProgress({ ...draw, withdrawnEntryIds: removed }, {});
  assert.equal(planned.snapshot.voidMatches?.length, 1);
  assert.deepEqual(placements(planned.snapshot, planned.winners), [
    { place: 1, entryId: remaining },
  ]);
  assert.equal(drawProgress(planned.snapshot, planned.winners).complete, true);
  const none = withdrawalProgress(
    { ...draw, withdrawnEntryIds: draw.positions.map((e) => e!.id) },
    {},
  );
  assert.deepEqual(placements(none.snapshot, none.winners), []);
});

test('a quarter-final withdrawal follows loser routes without reappearing on the mat or receiving bronze', () => {
  const draw = v4(generateDraw('REPECHAGE', entries(8), 9, 'REPECHAGE_ONLY'));
  const removed = draw.positions[0]!.id;
  let next = withdrawEntry(draw, {}, removed);
  for (let i = 0; i < 30 && !drawProgress(next.snapshot, next.winners).complete; i++) {
    const match = resolveMatches(next.snapshot, next.winners).find((m) => m.ready);
    assert.ok(match);
    assert.notEqual(match.whiteEntryId, removed);
    assert.notEqual(match.blueEntryId, removed);
    next = withdrawalProgress(next.snapshot, { ...next.winners, [match.id]: match.whiteEntryId! });
  }
  assert.equal(drawProgress(next.snapshot, next.winners).complete, true);
  assert.ok(!placements(next.snapshot, next.winners)?.some((p) => p.entryId === removed));
  assert.ok(next.walkovers.every((m) => m.winnerEntryId !== removed));
});

test('void metadata cannot silently cancel a pair of eligible opponents', () => {
  const draw = v4(createDraw(entries(4), 8));
  assert.throws(
    () => resolveMatches({ ...draw, voidMatches: [draw.matches[0].id] }, {}),
    /VOID_MATCH_INVALID/,
  );
});

test('84 seeded full v4 tournaments with withdrawals, empty branches and explicit tie decisions finish without removed opponents or duplicate medals', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 12, 16, 31, 32, 64, 128])
    for (const format of ['ROUND_ROBIN', 'REPECHAGE', 'MIXED'])
      for (const seed of [17, 20261016]) {
        let random = seed;
        const pick = () => {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          return random;
        };
        const original = v4(generateDraw(format, entries(n), seed, 'REPECHAGE_ONLY'));
        const removed = original.positions.filter((e, i) => e && i % 3 === 0).map((e) => e!.id);
        let progress = withdrawalProgress({ ...original, withdrawnEntryIds: removed }, {});
        let finished = false;
        for (let round = 0; round < 100; round++) {
          const status = drawProgress(progress.snapshot, progress.winners);
          if (status.complete) {
            finished = true;
            break;
          }
          if (status.pendingReviews.length) {
            const review = status.pendingReviews[0];
            const ordered = [...review.members].reverse();
            progress = withdrawalProgress(
              approveAdditionalRound(progress.snapshot, progress.winners, {
                ...review,
                members: ordered,
                procedure: round % 2 === 0 ? 'ROUND_ROBIN' : 'ORDERED_PLACES',
              }),
              progress.winners,
            );
            continue;
          }
          const ready = resolveMatches(progress.snapshot, progress.winners).filter((m) => m.ready);
          assert.ok(ready.length, `${format}/${n}/${seed}: unresolved stage has no work`);
          const winners = { ...progress.winners };
          for (const m of ready) {
            assert.ok(m.whiteEntryId && m.blueEntryId && m.whiteEntryId !== m.blueEntryId);
            assert.ok(!removed.includes(m.whiteEntryId) && !removed.includes(m.blueEntryId));
            winners[m.id] = pick() % 2 ? m.whiteEntryId : m.blueEntryId;
          }
          progress = withdrawalProgress(progress.snapshot, winners);
        }
        assert.equal(finished, true, `${format}/${n}/${seed}`);
        const places = placements(progress.snapshot, progress.winners)!;
        assert.equal(new Set(places.map((p) => p.entryId)).size, places.length);
        assert.ok(places.every((p) => !removed.includes(p.entryId)));
        assert.equal(
          new Set(progress.snapshot.matches.map((m) => m.id)).size,
          progress.snapshot.matches.length,
        );
        for (const m of original.matches) {
          const current = progress.snapshot.matches.find((row) => row.id === m.id)!;
          assert.deepEqual(current.white, m.white);
          assert.deepEqual(current.blue, m.blue);
        }
      }
});
