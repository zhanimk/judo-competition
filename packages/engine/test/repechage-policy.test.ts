import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDraw,
  resolveMatches,
  placements,
  dependentMatches,
  drawFormat,
} from '../src/draw/index.ts';
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, clubId: `c${i % 5}` }));
test('v7: only two formats for every size and requested legacy option; old v6 keeps explicit large circles and pools', () => {
  for (const format of ['REPECHAGE', 'MIXED', 'ROUND_ROBIN']) {
    for (let n = 2; n <= 128; n++) {
      const draw = generateDraw(format, entries(n), 42, 'TWO_FORMATS');
      assert.equal(drawFormat(draw), n <= 5 ? 'ROUND_ROBIN' : 'REPECHAGE');
      if (n >= 6) {
        assert.equal(draw.matches.filter((m) => m.stage === 'BRONZE').length, 2);
        assert.equal(draw.pools, undefined);
      }
    }
  }
  assert.equal(
    drawFormat(generateDraw('ROUND_ROBIN', entries(8), 42, 'KNOCKOUT_FROM_SIX')),
    'ROUND_ROBIN',
  );
  assert.equal(drawFormat(generateDraw('MIXED', entries(12), 42, 'KNOCKOUT_FROM_SIX')), 'MIXED');
});
test('stored REPECHAGE_ONLY policy: 2–7 entrants retain round robin without fake bronze bouts', () => {
  for (const format of ['REPECHAGE', 'MIXED', 'ROUND_ROBIN'])
    for (let n = 2; n < 8; n++) {
      const d = generateDraw(format, entries(n), 42, 'REPECHAGE_ONLY');
      assert.equal(drawFormat(d), 'ROUND_ROBIN');
      assert.equal(d.matches.length, (n * (n - 1)) / 2);
      const pairs = d.matches.map((m) =>
        JSON.stringify(
          [m.white, m.blue].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ),
      );
      assert.equal(new Set(pairs).size, pairs.length);
    }
  assert.throws(
    () => generateDraw('SINGLE_ELIMINATION', entries(8), 42, 'REPECHAGE_ONLY'),
    /FORMAT_UNSUPPORTED/,
  );
});
test('new knockout formats 8–128: quarter-final losers, cross semifinal losers, two distinct bronze winners', () => {
  for (const format of ['REPECHAGE', 'MIXED'])
    for (let n = 8; n <= 128; n++)
      for (const seed of [0, 42]) {
        const d = generateDraw(format, entries(n), seed, 'REPECHAGE_ONLY');
        assert.equal(d.medalPolicy, 'QUARTER_REPECHAGE');
        const winners: Record<string, string> = {};
        for (const match of d.matches) {
          const row = resolveMatches(d, winners).find((m) => m.id === match.id)!;
          assert.ok(row.ready, `${format}/${n}/${match.id}`);
          assert.notEqual(row.whiteEntryId, row.blueEntryId);
          winners[row.id] =
            row.whiteEntryId! < row.blueEntryId! ? row.whiteEntryId! : row.blueEntryId!;
        }
        const rows = resolveMatches(d, winners),
          main = rows.filter((m) => !m.stage || m.stage === 'MAIN');
        const final = main.at(-1)!;
        const quarters = main.filter((m) => m.round === final.round - 2),
          semis = main.filter((m) => m.round === final.round - 1);
        const loser = (m: typeof final) =>
          m.winnerEntryId === m.whiteEntryId ? m.blueEntryId : m.whiteEntryId;
        const reps = rows.filter((m) => m.stage === 'REPECHAGE'),
          bronzes = rows.filter((m) => m.stage === 'BRONZE');
        assert.equal(quarters.length, 4);
        assert.equal(semis.length, 2);
        assert.equal(reps.length, 2);
        assert.equal(bronzes.length, 2);
        assert.deepEqual(
          reps.flatMap((m) => [m.whiteEntryId, m.blueEntryId]).sort(),
          quarters.map(loser).sort(),
        );
        for (let i = 0; i < 2; i++) {
          assert.equal(bronzes[i].whiteEntryId, reps[i].winnerEntryId);
          assert.equal(bronzes[i].blueEntryId, loser(semis[1 - i]));
          assert.ok(dependentMatches(d, semis[1 - i].id).includes(bronzes[i].id));
          const pending = { ...winners };
          delete pending[bronzes[i].id];
          assert.equal(
            placements(d, pending),
            null,
            'No complete podium before BOTH bronzes confirmed',
          );
        }
        const medals = placements(d, winners)!;
        assert.deepEqual(
          medals.map((p) => p.place),
          [1, 2, 3, 3],
        );
        assert.equal(new Set(medals.map((p) => p.entryId)).size, 4);
        if (format === 'MIXED') {
          assert.ok(d.pools!.length >= 4);
          for (const p of d.pools!) assert.ok(p.entries.length >= 2 && p.entries.length <= 4);
        }
      }
});
test('stored legacy formats keep their original medal rules', () => {
  for (const format of ['SINGLE_ELIMINATION', 'MIXED']) {
    const d = generateDraw(format, entries(8), 42);
    assert.equal(d.matches.filter((m) => m.stage === 'BRONZE').length, 0);
  }
});

test('v6: six/seven competitors use a real knockout with BYEs and two distinct bronze winners', () => {
  for (const n of [6, 7])
    for (const format of ['REPECHAGE', 'MIXED', 'ROUND_ROBIN'])
      for (let seed = 0; seed < 100; seed++) {
        const d = generateDraw(format, entries(n), seed, 'KNOCKOUT_FROM_SIX');
        assert.equal(d.algorithm, 'custom-quarter-repechage-v1');
        assert.equal(d.positions.filter((e) => !e).length, 8 - n);
        assert.equal(d.matches.filter((m) => m.stage === 'REPECHAGE').length, n - 6);
        assert.equal(d.matches.length, n === 6 ? 7 : 9);
        assert.equal(d.matches.filter((m) => m.stage === 'BRONZE').length, 2);
        const winners: Record<string, string> = {};
        for (const m of d.matches) {
          const row = resolveMatches(d, winners).find((r) => r.id === m.id)!;
          assert.ok(row.ready, `${n} ${seed} ${m.id}`);
          assert.notEqual(row.whiteEntryId, row.blueEntryId);
          winners[m.id] = row.whiteEntryId!;
        }
        assert.deepEqual(
          placements(d, winners)!.map((p) => p.place),
          [1, 2, 3, 3],
        );
        assert.equal(new Set(placements(d, winners)!.map((p) => p.entryId)).size, 4);
        for (const bronze of d.matches.filter((m) => m.stage === 'BRONZE')) {
          const incomplete = { ...winners };
          delete incomplete[bronze.id];
          assert.equal(placements(d, incomplete), null);
        }
        assert.equal(
          generateDraw(format, entries(n), seed, 'REPECHAGE_ONLY').algorithm,
          'custom-round-robin-v1',
        );
      }
});
