import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoundRobin,
  createMixed,
  appendRematches,
  poolStandings,
  resolveMatches,
  placements,
  type Draw,
} from '../src/draw/index.ts';
const entries = Array.from({ length: 8 }, (_, i) => ({ id: String(i), clubId: String(i) }));
function cycle(draw: Draw, pool?: string) {
  const ms = draw.matches.filter((m) => (pool ? m.pool === pool : true));
  const ids = pool
    ? draw.pools!.find((p) => p.id === pool)!.entries
    : draw.positions.map((p) => p!.id);
  return Object.fromEntries(
    ms.map((m) => {
      const a = 'entryId' in m.white ? m.white.entryId : '',
        b = 'entryId' in m.blue ? m.blue.entryId : '';
      return [m.id, (ids.indexOf(a) + 1) % ids.length === ids.indexOf(b) ? a : b];
    }),
  );
}
test('cyclic equality requires additional bouts; repeated equality creates another round without duplicates', () => {
  let d: Draw = { ...createRoundRobin(entries.slice(0, 3), 1), tieBreak: 'REMATCH' };
  const w = cycle(d);
  assert.equal(poolStandings(d, w), null);
  assert.equal(placements(d, w), null);
  d = appendRematches(d, w);
  assert.equal(d.matches.length, 6);
  assert.equal(appendRematches(d, w), d);
  const extra = d.matches.filter((m) => m.tieBreakRound);
  Object.assign(w, cycle({ ...d, matches: extra }));
  assert.equal(poolStandings(d, w), null);
  d = appendRematches(d, w);
  assert.equal(d.matches.length, 9);
  for (const m of d.matches.filter((m) => m.tieBreakRound === 'tb-2')) {
    const a = (m.white as { entryId: string }).entryId,
      b = (m.blue as { entryId: string }).entryId;
    w[m.id] = a < b ? a : b;
  }
  assert.equal(poolStandings(d, w)?.length, 3);
  assert.equal(placements(d, w)?.length, 3);
  assert.equal(appendRematches(d, w), d);
});
test('mixed group tie blocks qualification until rematches finish', () => {
  let d: Draw = { ...createMixed(entries.slice(0, 6), 2), tieBreak: 'REMATCH' };
  const pool = d.pools![0].id,
    w = cycle(d, pool);
  assert.ok(
    resolveMatches(d, w)
      .filter((m) => m.stage === 'MAIN')
      .every((m) => !m.ready),
  );
  d = appendRematches(d, w);
  assert.equal(d.tieRounds?.length, 1);
  assert.ok(d.matches.filter((m) => m.tieBreakRound).every((m) => m.round < 4));
  for (const m of d.matches.filter((m) => m.tieBreakRound)) {
    const a = (m.white as { entryId: string }).entryId,
      b = (m.blue as { entryId: string }).entryId;
    w[m.id] = a < b ? a : b;
  }
  assert.ok(poolStandings(d, w, pool));
});
