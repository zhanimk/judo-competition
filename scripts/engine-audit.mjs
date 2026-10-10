// Read-only audit of the built engine through its public exports.
// npm run build -w @judo/engine
// node scripts/engine-audit.mjs > docs/reports/latest-engine-audit.json
import assert from 'node:assert/strict';
import {
  generateDraw,
  resolveMatches,
  placements,
  appendRematches,
  poolStandings,
  rematchStandings,
} from '@judo/engine/draw';
import { createMatch, applyCommand, correctStoppedClock, tally } from '@judo/engine/match';

const formats = ['ROUND_ROBIN', 'REPECHAGE', 'MIXED'];
const seeds = [0, 1, 0xffffffff];
let checked = 0,
  maxMatches = 0;
for (let n = 2; n <= 128; n++)
  for (const format of formats)
    for (const seed of seeds) {
      const entries = Array.from({ length: n }, (_, i) => ({
        id: 'e' + String(i).padStart(3, '0'),
        clubId: 'club' + (i % 7),
      }));
      const draw = {
        ...generateDraw(format, entries, seed, 'REPECHAGE_ONLY'),
        tieBreak: 'REMATCH',
      };
      const winners = {};
      for (;;) {
        const next = resolveMatches(draw, winners).filter((m) => m.ready && !winners[m.id]);
        if (!next.length) break;
        for (const m of next) winners[m.id] = [m.whiteEntryId, m.blueEntryId].sort()[0];
      }
      assert.equal(
        appendRematches(draw, winners),
        draw,
        'strict rankings should need no extra round',
      );
      const resolved = resolveMatches(draw, winners);
      assert.equal(new Set(resolved.map((m) => m.id)).size, resolved.length);
      const byRound = new Map();
      for (const m of resolved) {
        assert.ok(m.whiteEntryId && m.blueEntryId && m.winnerEntryId);
        assert.notEqual(m.whiteEntryId, m.blueEntryId);
        assert.ok([m.whiteEntryId, m.blueEntryId].includes(m.winnerEntryId));
        const present = byRound.get(m.round) ?? new Set();
        for (const id of [m.whiteEntryId, m.blueEntryId]) {
          assert.ok(
            !present.has(id),
            `${format} n=${n}: athlete repeated in ordinary round ${m.round}`,
          );
          present.add(id);
        }
        byRound.set(m.round, present);
      }
      const medals = placements(draw, winners);
      assert.ok(medals);
      assert.equal(new Set(medals.map((m) => m.entryId)).size, medals.length);
      if (draw.algorithm === 'custom-round-robin-v1') {
        assert.equal(draw.matches.length, (n * (n - 1)) / 2);
        assert.equal(medals.length, n);
      } else
        assert.deepEqual(
          medals.map((m) => m.place),
          [1, 2, 3, 3],
        );
      maxMatches = Math.max(maxMatches, draw.matches.length);
      checked++;
    }
assert.equal(checked, 1143, 'all fixed draw cases must be visited');

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = random(20261010),
  pick = (a) => a[Math.floor(rng() * a.length)];
const statuses = {},
  corrections = {};
let accepted = 0,
  rejected = 0,
  clockCorrections = 0;
function invariants(s) {
  assert.ok(Number.isSafeInteger(s.version) && s.version >= 0);
  assert.ok(
    Number.isSafeInteger(s.elapsedMs) && s.elapsedMs >= 0 && s.elapsedMs <= s.rules.durationMs,
  );
  assert.ok(Number.isSafeInteger(s.goldenMs) && s.goldenMs >= 0);
  assert.equal(!!s.outcome, ['PROVISIONAL', 'CONFIRMED'].includes(s.status));
  if (s.outcome) assert.ok(['WHITE', 'BLUE'].includes(s.outcome.winner));
  if (s.phase === 'GOLDEN') assert.equal(s.elapsedMs, s.rules.durationMs);
  if (s.status === 'DECISION') {
    assert.equal(s.phase, 'REGULAR');
    assert.equal(s.elapsedMs, s.rules.durationMs);
    assert.equal(s.hold, null);
  }
  if (s.hold) {
    assert.ok(['RUNNING', 'PAUSED'].includes(s.status));
    assert.ok(Number.isSafeInteger(s.hold.elapsedMs) && s.hold.elapsedMs >= 0);
  }
  for (const side of ['WHITE', 'BLUE']) {
    const t = tally(s, side);
    assert.ok(t.IPPON <= 1 && t.WAZA_ARI <= 2 && t.SHIDO <= 3);
  }
}
const operations = [
  'START',
  'STOP',
  'ADVANCE',
  'AWARD',
  'HOLD',
  'TOKETA',
  'GOLDEN',
  'REVOKE',
  'CONFIRM',
  'RECOVER',
  'CORRECT',
];
for (let series = 0; series < 600; series++) {
  let state = createMatch({
    durationMs: pick([30000, 60000, 180000]),
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
    holdThresholds: [
      { ms: 5000, score: 'YUKO' },
      { ms: 10000, score: 'WAZA_ARI' },
      { ms: 20000, score: 'IPPON' },
    ],
  });
  for (let step = 0; step < 90; step++) {
    const before = structuredClone(state),
      type = pick(operations);
    let succeeded = false;
    try {
      if (type === 'CORRECT') {
        state = correctStoppedClock(state, {
          phase: state.phase,
          elapsedMs: Math.floor(
            rng() * (state.phase === 'REGULAR' ? state.rules.durationMs + 1 : 600001),
          ),
        });
        clockCorrections++;
        corrections[state.status] = (corrections[state.status] ?? 0) + 1;
      } else {
        const command = { id: `audit-${series}-${step}`, expectedVersion: state.version, type };
        if (['AWARD', 'HOLD'].includes(type)) command.side = pick(['WHITE', 'BLUE']);
        if (type === 'AWARD') command.kind = pick(['YUKO', 'WAZA_ARI', 'IPPON', 'SHIDO']);
        if (type === 'ADVANCE')
          command.ms = pick([0, 1, 4999, 5000, 9999, 10000, 20000, 60000, 180000]);
        if (type === 'REVOKE')
          command.awardId =
            pick(state.awards.filter((a) => a.active).map((a) => a.id)) ?? 'unknown';
        state = applyCommand(state, command);
      }
      succeeded = true;
    } catch {
      assert.deepEqual(state, before, 'rejected operation mutated the input');
      rejected++;
    }
    if (succeeded) {
      assert.equal(state.version, before.version + 1);
      accepted++;
      statuses[state.status] = (statuses[state.status] ?? 0) + 1;
    }
    invariants(state);
  }
}
assert.equal(accepted + rejected, 54000, 'all fixed-seed action attempts must be visited');

// Policy observations are findings, not required bugs. A subsequent engine
// fix must not fail this audit just because a known discrepancy disappears.
function observePolicy(run) {
  try {
    return run();
  } catch (error) {
    // A future explicit manual-review policy may reject this old fixture.
    // Invariant failures above remain fatal; policy-case errors are reported.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
const rr4 = {
  ...generateDraw(
    'ROUND_ROBIN',
    ['A', 'B', 'C', 'D'].map((id) => ({ id, clubId: id })),
    17,
  ),
  tieBreak: 'REMATCH',
};
const desired = new Map([
  ['AB', 'A'],
  ['AC', 'A'],
  ['AD', 'D'],
  ['BC', 'B'],
  ['BD', 'B'],
  ['CD', 'C'],
]);
const equalWins = Object.fromEntries(
  rr4.matches.map((m) => [m.id, desired.get([m.white.entryId, m.blue.entryId].sort().join(''))]),
);
const mismatch = observePolicy(() => ({
  standings: poolStandings(rr4, equalWins),
  needed: rematchStandings(rr4, equalWins).needed,
  matchesBefore: rr4.matches.length,
  matchesAfter: appendRematches(rr4, equalWins).matches.length,
}));
const twoWayGroups = (mismatch.needed ?? []).map((group) =>
  Array.isArray(group.members) ? [...group.members].sort().join('') : '',
);
const equalWinsStatus =
  mismatch.matchesBefore === 6 &&
  mismatch.matchesAfter === 6 &&
  !mismatch.needed?.length &&
  Array.isArray(mismatch.standings)
    ? 'observed'
    : mismatch.matchesAfter > mismatch.matchesBefore &&
        twoWayGroups.includes('AB') &&
        twoWayGroups.includes('CD')
      ? 'resolved'
      : 'needs_review';

const mixed = {
  ...generateDraw(
    'MIXED',
    Array.from({ length: 12 }, (_, i) => ({ id: `mixed-${i}`, clubId: `club-${i}` })),
    7,
    'REPECHAGE_ONLY',
  ),
  tieBreak: 'REMATCH',
};
const target = mixed.pools[0],
  [a, b, c] = target.entries;
const cyclicPairs = new Map([
  [[a, b].sort().join('|'), a],
  [[b, c].sort().join('|'), b],
  [[c, a].sort().join('|'), c],
]);
const mixedWinners = Object.fromEntries(
  mixed.matches
    .filter((m) => m.pool)
    .map((m) => [
      m.id,
      m.pool === target.id
        ? cyclicPairs.get([m.white.entryId, m.blue.entryId].sort().join('|'))
        : [m.white.entryId, m.blue.entryId].sort()[0],
    ]),
);
const mixedObservation = observePolicy(() => ({
  newRounds: appendRematches(mixed, mixedWinners)
    .matches.filter((m) => m.tieBreakRound)
    .map((m) => m.round),
}));
const newRounds = mixedObservation.newRounds ?? [];
const lastPoolRound = Math.max(
  ...mixed.matches.filter((m) => m.pool === target.id).map((m) => m.round),
);
const mixedStatus =
  newRounds.length === 3 && newRounds.every((round) => round === lastPoolRound)
    ? 'observed'
    : newRounds.length === 3 &&
        new Set(newRounds).size === 3 &&
        Math.min(...newRounds) > lastPoolRound
      ? 'resolved'
      : 'needs_review';
const mixedMismatch = {
  entries: 12,
  pool: target.id,
  members: target.entries,
  lastPoolRound,
  ...mixedObservation,
};

console.log(
  JSON.stringify(
    {
      date: '2026-10-10',
      mode: 'read-only compiled engine public exports',
      randomSeed: 20261010,
      draw: {
        checked,
        maxMatches,
        formats,
        seeds,
        n: [2, 128],
        policy: 'REPECHAGE_ONLY',
        passed: true,
      },
      match: {
        series: 600,
        attempted: 54000,
        accepted,
        rejected,
        clockCorrections,
        statuses,
        corrections,
        passed: true,
      },
      findings: [
        {
          id: 'RR_EQUAL_WINS_HEAD_TO_HEAD',
          status: equalWinsStatus,
          profile: 'LEGACY',
          description:
            'A/B have two wins each and C/D one each. Observe whether prior head-to-head resolves those ties without additional bouts. Historical policy and a future wins-only policy must be versioned separately.',
        },
        {
          id: 'MIXED_TIEBREAK_COLLAPSED_ROUNDS',
          status: mixedStatus,
          profile: 'REPECHAGE_ONLY',
          description:
            'A three-way pool cycle produces three extra bouts. Observe whether their round numbers collapse to the final base pool round. Three-way tie policy and knockout scheduling still require separate review.',
        },
      ],
      equalWinsLegacyMismatch: { status: equalWinsStatus, ...mismatch },
      mixedCollapsedRounds: { status: mixedStatus, ...mixedMismatch },
      limits: [
        'Not exhaustive outcome exploration',
        'No official IJF certification',
        'No browser, DB, realtime or equipment test',
        'Draw smoke uses deterministic lexicographic winners, not every possible result',
        'State smoke checks invariants, not an independent sporting oracle',
      ],
    },
    null,
    2,
  ),
);
