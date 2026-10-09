import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRepechage,
  createMixed,
  createRoundRobin,
  resolveMatches,
  poolStandings,
  placements,
} from '../src/draw/index.ts';
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, clubId: `c${i % 7}` }));
test('quarter repechage 8..128: only quarter-final losers enter repechage; crossed bronze; unique medallists', () => {
  for (let n = 8; n <= 128; n++)
    for (const seed of [0, 7, 4294967295]) {
      const d = createRepechage(entries(n), seed),
        winners: Record<string, string> = {};
      assert.equal(d.matches.length, n + 3);
      for (const m of d.matches) {
        const row = resolveMatches(d, winners).find((r) => r.id === m.id)!;
        assert.ok(row.ready);
        assert.notEqual(row.whiteEntryId, row.blueEntryId);
        winners[m.id] = (seed % 2 ? row.blueEntryId : row.whiteEntryId)!;
      }
      const rows = resolveMatches(d, winners);
      assert.deepEqual(
        placements(d, winners)!.map((p) => p.place),
        [1, 2, 3, 3],
      );
      const semis = rows.filter((m) => m.round === Math.log2(d.size) - 1);
      const bronze = rows.filter((m) => m.stage === 'BRONZE');
      const quarters = rows.filter((m) => m.round === Math.log2(d.size) - 2);
      const repechage = rows.filter((m) => m.stage === 'REPECHAGE');
      const loser = (m: (typeof rows)[number]) =>
        m.winnerEntryId === m.whiteEntryId ? m.blueEntryId : m.whiteEntryId;
      assert.deepEqual(
        repechage.flatMap((m) => [m.whiteEntryId, m.blueEntryId]).sort(),
        quarters.map(loser).sort(),
      );
      for (let i = 0; i < 2; i++) {
        assert.equal(bronze[i].whiteEntryId, repechage[i].winnerEntryId);
        assert.equal(bronze[i].blueEntryId, loser(semis[1 - i]));
      }

      const final = rows.find((m) => m.id === `r${Math.log2(d.size)}-m1`)!;
      const medals = [final.whiteEntryId, final.blueEntryId, ...bronze.map((m) => m.winnerEntryId)];
      assert.equal(new Set(medals).size, 4);
      assert.equal(
        bronze[0].blueEntryId,
        semis[1].winnerEntryId === semis[1].whiteEntryId
          ? semis[1].blueEntryId
          : semis[1].whiteEntryId,
      );
      assert.equal(rows.filter((m) => m.ready).length, 0);
    }
  assert.throws(() => createRepechage(entries(7), 1), /REPECHAGE_MIN_8/);
});
test('mixed 4..128: pools of 2..4, each pair once, complete dependency progression, qualifiers in opposite halves', () => {
  for (let n = 4; n <= 128; n++) {
    const d = createMixed(entries(n), 42),
      winners: Record<string, string> = {};
    assert.deepEqual(createMixed([...entries(n)].reverse(), 42), d);
    assert.equal(new Set(d.pools!.flatMap((p) => p.entries)).size, n);
    for (const p of d.pools!) {
      assert.ok(p.entries.length >= 2 && p.entries.length <= 4);
      assert.equal(
        d.matches.filter((m) => m.pool === p.id).length,
        (p.entries.length * (p.entries.length - 1)) / 2,
      );
      assert.equal(poolStandings(d, winners, p.id), null);
    }
    const opening = d.matches.filter((m) => m.stage === 'MAIN' && 'pool' in m.white);
    for (const p of d.pools!) {
      const positions = opening.flatMap((m, i) =>
        [m.white, m.blue].some((s) => 'pool' in s && s.pool === p.id) ? [i] : [],
      );
      assert.equal(positions.length, 2);
      assert.ok(positions[0] < opening.length / 2 && positions[1] >= opening.length / 2);
    }
    for (const m of d.matches) {
      const row = resolveMatches(d, winners).find((r) => r.id === m.id)!;
      assert.ok(row.ready, m.id);
      assert.notEqual(row.whiteEntryId, row.blueEntryId);
      winners[m.id] = row.whiteEntryId!;
    }
    assert.equal(resolveMatches(d, winners).filter((r) => r.ready).length, 0);
    for (const p of d.pools!)
      assert.equal(poolStandings(d, winners, p.id)!.length, p.entries.length);
  }
  assert.throws(() => createMixed(entries(3), 1), /MIXED_MIN_4/);
});
test('custom three-way tie uses published lot, never result arrival order', () => {
  const d = createRoundRobin(entries(3), 42),
    winners: Record<string, string> = {};
  const ids = d.positions.map((e) => e!.id);
  for (const m of d.matches) {
    assert.ok('entryId' in m.white && 'entryId' in m.blue);
    const a = ids.indexOf(m.white.entryId),
      b = ids.indexOf(m.blue.entryId);
    winners[m.id] = ids[(a + 1) % 3 === b ? a : b];
  }
  const ranking = poolStandings(d, winners)!;
  assert.deepEqual(
    ranking.map((r) => r.wins),
    [1, 1, 1],
  );
  assert.deepEqual(
    ranking.map((r) => r.entryId),
    ids,
  );
  assert.deepEqual(
    poolStandings(d, Object.fromEntries(Object.entries(winners).reverse())),
    ranking,
  );
});

test('dependency closure includes loser repechage and every pool-qualified playoff', async () => {
  const { dependentMatches } = await import('../src/draw/index.ts');
  const rep = createRepechage(entries(8), 1);
  const ids = dependentMatches(rep, 'r1-m1');
  assert.ok(ids.includes('rep-a'));
  assert.ok(ids.includes('bronze-a'));
  assert.ok(ids.includes('bronze-b'));
  assert.ok(ids.includes('r3-m1'));
  assert.ok(!ids.includes('r1-m2'));
  const mixed = createMixed(entries(8), 1),
    opening = mixed.matches.find((m) => m.pool === 'A')!;
  const affected = dependentMatches(mixed, opening.id);
  assert.equal(affected.length, mixed.matches.filter((m) => m.stage === 'MAIN').length);
  assert.equal(dependentMatches(createRoundRobin(entries(4), 1), 'r1-m1').length, 0);
});
