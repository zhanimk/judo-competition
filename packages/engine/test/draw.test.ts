import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraw, resolveMatches } from '../src/draw/index.ts';
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `athlete-${i}`, clubId: `club-${i % 5}` }));

test('every size 2..128: unique positions, correct BYEs and N-1 actual contests', () => {
  for (let n = 2; n <= 128; n++)
    for (const seed of [0, 1, 42, 4294967295]) {
      const d = createDraw(entries(n), seed);
      assert.equal(d.matches.length, n - 1);
      assert.equal(d.positions.filter((e) => !e).length, d.size - n);
      assert.equal(new Set(d.positions.filter(Boolean).map((e) => e!.id)).size, n);
      for (let i = 0; i < d.size; i += 2) assert.ok(d.positions[i] || d.positions[i + 1]);
      const winners: Record<string, string> = {};
      for (const m of d.matches) {
        const row = resolveMatches(d, winners).find((r) => r.id === m.id)!;
        assert.ok(row.ready);
        assert.notEqual(row.whiteEntryId, row.blueEntryId);
        winners[m.id] = row.whiteEntryId!;
      }
      assert.equal(resolveMatches(d, winners).filter((r) => r.ready).length, 0);
      assert.equal(Object.keys(winners).length, n - 1);
    }
});

test('reproducible independent of input order; caller input unchanged', () => {
  const e = entries(13),
    before = structuredClone(e);
  assert.deepEqual(createDraw(e, 42), createDraw([...e].reverse(), 42));
  assert.deepEqual(e, before);
});

test('two clubmates in opposite halves, four in different quarters', () => {
  for (const count of [2, 4])
    for (let seed = 0; seed < 100; seed++) {
      const e = entries(8).map((e, i) => ({ ...e, clubId: i < count ? 'shared' : `single-${i}` }));
      const d = createDraw(e, seed);
      const branches = d.positions.flatMap((e, i) =>
        e?.clubId === 'shared' ? [Math.floor(i / (8 / count))] : [],
      );
      assert.equal(new Set(branches).size, count);
    }
});

test('five of eight from one club: exactly one unavoidable opening pair', () => {
  const e = entries(8).map((e, i) => ({ ...e, clubId: i < 5 ? 'shared' : `single-${i}` }));
  for (let seed = 0; seed < 100; seed++) assert.equal(createDraw(e, seed).firstRoundClubPairs, 1);
});

test('all same club still produces complete draw', () => {
  const d = createDraw(
    entries(8).map((e) => ({ ...e, clubId: 'shared' })),
    3,
  );
  assert.equal(d.firstRoundClubPairs, 4);
  assert.equal(d.matches.length, 7);
});

test('invalid inputs and invalid result dependencies are rejected', () => {
  for (const n of [0, 1, 129]) assert.throws(() => createDraw(entries(n), 1), /ENTRY_COUNT/);
  assert.throws(() => createDraw([entries(2)[0], entries(2)[0]], 1), /DUPLICATE/);
  assert.throws(() => createDraw(entries(2), -1), /INVALID_SEED/);
  const d = createDraw(entries(4), 1);
  assert.throws(() => resolveMatches(d, { bad: 'athlete-0' }), /UNKNOWN_MATCH/);
  assert.throws(() => resolveMatches(d, { [d.matches[0].id]: 'intruder' }), /INVALID_WINNER/);
  assert.throws(() => resolveMatches(d, { [d.matches.at(-1)!.id]: 'athlete-0' }), /DEPENDENCY/);
});

test('3048 club distributions: minimum feasible opening pairs for balanced, dominant and single-club rosters', () => {
  for (let n = 2; n <= 128; n++)
    for (let seed = 0; seed < 8; seed++)
      for (const kind of ['balanced', 'dominant', 'same']) {
        const entries = Array.from({ length: n }, (_, i) => ({
          id: String(i),
          clubId:
            kind === 'same'
              ? 'a'
              : kind === 'dominant'
                ? i < Math.ceil(n * 0.7)
                  ? 'a'
                  : 'b'
                : String(i % 6),
        }));
        const draw = createDraw(entries, seed),
          counts = new Map<string, number>();
        for (const e of entries) counts.set(e.clubId, (counts.get(e.clubId) ?? 0) + 1);
        const lowerBound = Math.max(0, Math.max(...counts.values()) - draw.size / 2);
        assert.equal(draw.firstRoundClubPairs, lowerBound, `${n}/${seed}/${kind}`);
      }
});

test('round robin 2..128: every pair once, no simultaneous athlete within a round, deterministic', async () => {
  const { createRoundRobin } = await import('../src/draw/index.ts');
  for (let n = 2; n <= 128; n++) {
    const d = createRoundRobin(entries(n), 42),
      pairs = new Set<string>(),
      rounds = new Map<number, Set<string>>();
    assert.equal(d.matches.length, (n * (n - 1)) / 2);
    for (const m of d.matches) {
      assert.ok('entryId' in m.white && 'entryId' in m.blue);
      const ids = [m.white.entryId, m.blue.entryId];
      assert.notEqual(ids[0], ids[1]);
      const key = ids.sort().join('|');
      assert.ok(!pairs.has(key));
      pairs.add(key);
      const round = rounds.get(m.round) ?? new Set<string>();
      for (const id of ids) {
        assert.ok(!round.has(id));
        round.add(id);
      }
      rounds.set(m.round, round);
    }
    assert.equal(rounds.size, n % 2 ? n : n - 1);
    assert.equal(resolveMatches(d, {}).filter((m) => m.ready).length, d.matches.length);
    assert.deepEqual(d, createRoundRobin([...entries(n)].reverse(), 42));
  }
});

test('round-robin positions remain an independent snapshot after the source roster changes', async () => {
  const { createRoundRobin } = await import('../src/draw/index.ts');
  const roster = entries(3),
    draw = createRoundRobin(roster, 42),
    snapshot = structuredClone(draw);
  roster[0].id = 'replacement';
  roster[1].clubId = 'new-club';
  assert.deepEqual(draw, snapshot);
});

test('only own result-map entries count as confirmed winners or standings', async () => {
  const { createRoundRobin, poolStandings, placements } = await import('../src/draw/index.ts');
  for (const draw of [createDraw(entries(2), 42), createRoundRobin(entries(2), 42)]) {
    const match = draw.matches[0];
    assert.ok('entryId' in match.white);
    const inherited = Object.create({ [match.id]: match.white.entryId }) as Record<string, string>;
    const row = resolveMatches(draw, inherited)[0];
    assert.equal(row.winnerEntryId, undefined);
    assert.equal(row.ready, true);
    assert.equal(placements(draw, inherited), null);
    if (draw.algorithm === 'custom-round-robin-v1')
      assert.equal(poolStandings(draw, inherited), null);
    assert.equal(resolveMatches(draw, { [match.id]: match.white.entryId })[0].ready, false);
  }
});
