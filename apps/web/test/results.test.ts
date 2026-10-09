import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDraw,
  createRoundRobin,
  createRepechage,
  createMixed,
  resolveMatches,
} from '@judo/engine/draw';
import { finalCategoryPlaces } from '../src/features/public/results-model.ts';

test('public final places wait for every confirmed result and disappear after a result is reopened', () => {
  for (const [make, n] of [
    [createDraw, 2],
    [createRoundRobin, 3],
    [createRepechage, 8],
    [createMixed, 8],
  ] as const) {
    const draw = make(
      Array.from({ length: n }, (_, i) => ({ id: `e${i}`, clubId: `c${i % 3}` })),
      52,
    );
    const winners: Record<string, string> = {};
    while (true) {
      const next = resolveMatches(draw, winners).find(
        (m) => m.whiteEntryId && m.blueEntryId && !m.winnerEntryId,
      );
      if (!next) break;
      winners[next.id] = next.whiteEntryId!;
    }
    const contests = draw.matches.map((m) => ({
      key: m.id,
      status: 'CONFIRMED',
      winnerEntryId: winners[m.id],
    }));
    assert.equal(finalCategoryPlaces(draw, []), null);
    const last = contests.at(-1)!;
    const saved = last.winnerEntryId;
    last.status = 'ACTIVE';
    assert.equal(
      finalCategoryPlaces(draw, contests),
      null,
      'provisional winner cannot create final places',
    );
    last.status = 'CONFIRMED';
    const places = finalCategoryPlaces(draw, contests)!;
    assert.equal(places[0].place, 1);
    assert.equal(new Set(places.map((p) => p.entryId)).size, places.length);
    if (make === createRepechage) assert.equal(places.filter((p) => p.place === 3).length, 2);
    last.winnerEntryId = '';
    assert.equal(finalCategoryPlaces(draw, contests), null);
    last.winnerEntryId = saved;
    assert.deepEqual(finalCategoryPlaces(draw, contests), places);
  }
});
