import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDraw,
  createRepechage,
  createRoundRobin,
  resolveMatches,
  type Draw,
} from '@judo/engine/draw';
import { protocolDrawView } from '../src/features/draws/protocol-view.ts';

const entries = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `entry-${i}`, clubId: `club-${i}` }));
const records = (winners: Record<string, string>, status = 'CONFIRMED') =>
  Object.entries(winners).map(([key, winnerEntryId]) => ({ key, winnerEntryId, status }));
function finish(draw: Draw) {
  const winners: Record<string, string> = {};
  for (;;) {
    const ready = resolveMatches(draw, winners).filter((match) => match.ready);
    if (!ready.length) return winners;
    for (const match of ready) winners[match.id] = match.whiteEntryId!;
  }
}

test('print resolves confirmed semifinal winners, while provisional results leave their final slots unresolved', () => {
  const draw = createDraw(entries(4), 8);
  const first = draw.matches.filter((match) => match.round === 1);
  assert.equal(first.length, 2);
  const semifinalWinners = Object.fromEntries(
    resolveMatches(draw, {})
      .filter((match) => match.round === 1)
      .map((match) => [match.id, match.whiteEntryId!]),
  );
  const final = draw.matches.find((match) => match.round === 2)!;
  const pending = protocolDrawView(draw, 'CONFIRMED', records(semifinalWinners, 'PROVISIONAL'));
  assert.deepEqual(pending.matches.find((match) => match.id === final.id)?.white, final.white);
  assert.equal(pending.places, null);
  const confirmed = protocolDrawView(draw, 'CONFIRMED', records(semifinalWinners));
  const finalPair = confirmed.matches.find((match) => match.id === final.id)!;
  assert.deepEqual(finalPair.white, { entryId: semifinalWinners[first[0].id] });
  assert.deepEqual(finalPair.blue, { entryId: semifinalWinners[first[1].id] });
  assert.equal(confirmed.places, null);
});

test('final print awards engine places only after both the draw and its results are confirmed', () => {
  const draw = createDraw(entries(4), 11),
    winners = finish(draw);
  const final = resolveMatches(draw, winners).find((match) => match.round === 2)!;
  const printed = protocolDrawView(draw, 'CONFIRMED', records(winners));
  assert.equal(printed.places?.find((place) => place.place === 1)?.entryId, final.winnerEntryId);
  assert.equal(printed.places?.find((place) => place.place === 2)?.entryId, final.blueEntryId);
  assert.equal(protocolDrawView(draw, 'PREVIEW', records(winners)).places, null);
  const unfinished = records(winners).map((record) =>
    record.key === final.id ? { ...record, status: 'PROVISIONAL' } : record,
  );
  assert.equal(protocolDrawView(draw, 'CONFIRMED', unfinished).places, null);
});

test('repechage print resolves loser slots to stable athlete IDs and preserves both bronze places', () => {
  const draw = createRepechage(entries(8), 14),
    winners = finish(draw);
  const printed = protocolDrawView(draw, 'CONFIRMED', records(winners));
  const dependent = draw.matches.filter(
    (match) => 'loserOf' in match.white || 'loserOf' in match.blue,
  );
  assert.ok(dependent.length > 0);
  for (const source of dependent) {
    const match = printed.matches.find((match) => match.id === source.id)!;
    assert.ok('entryId' in match.white && 'entryId' in match.blue);
  }
  assert.equal(printed.places?.filter((place) => place.place === 3).length, 2);
});

test('all base bouts confirmed in a three-way tie print an administrator review instead of fictional places', () => {
  const draw: Draw = {
    ...createRoundRobin(entries(3), 17),
    tieBreak: 'REMATCH',
    tieRanking: 'WINS_ONLY',
    tieMany: 'ADMIN_REVIEW',
  };
  const ids = draw.positions.map((entry) => entry!.id);
  const winners = Object.fromEntries(
    draw.matches.map((match) => {
      assert.ok('entryId' in match.white && 'entryId' in match.blue);
      const a = match.white.entryId,
        b = match.blue.entryId;
      return [match.id, (ids.indexOf(b) - ids.indexOf(a) + ids.length) % ids.length === 1 ? a : b];
    }),
  );
  const source = structuredClone({ draw, winners });
  const printed = protocolDrawView(draw, 'CONFIRMED', records(winners));
  assert.equal(printed.places, null);
  assert.equal(printed.pendingReviews.length, 1);
  assert.deepEqual(new Set(printed.pendingReviews[0].members), new Set(ids));
  assert.deepEqual({ draw, winners }, source);
});
