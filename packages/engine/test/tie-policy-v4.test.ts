import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoundRobin,
  generateDraw,
  resolveMatches,
  placements,
  poolStandings,
  appendRematches,
  approveAdditionalRound,
  drawProgress,
  isWinsOnlyTiePolicy,
  type Draw,
  type Match,
  type AdditionalRoundApproval,
} from '../src/draw/index.ts';

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${String(i).padStart(3, '0')}`,
    clubId: `club${i % 7}`,
  }));
const v4 = (draw: Draw): Draw => ({
  ...draw,
  tieBreak: 'REMATCH',
  tieRanking: 'WINS_ONLY',
  tieMany: 'ADMIN_REVIEW',
});

test('manual order resolves only the current three-way cohort without invented bouts or rewritten winners', () => {
  const draw = v4(createRoundRobin(entries(3), 7));
  const winners = cycle(draw.matches, groupMembers(draw));
  const original = structuredClone({ draw, winners });
  const review = drawProgress(draw, winners).pendingReviews[0];
  const order = [...review.members].reverse();
  const resolved = approveAdditionalRound(draw, winners, {
    ...review,
    members: order,
    procedure: 'ORDERED_PLACES',
  });
  assert.deepEqual(
    placements(resolved, winners)?.map((p) => p.entryId),
    order,
  );
  assert.equal(drawProgress(resolved, winners).complete, true);
  assert.deepEqual(resolved.matches, draw.matches);
  assert.deepEqual({ draw, winners }, original);
  assert.throws(
    () =>
      approveAdditionalRound(resolved, winners, {
        ...review,
        members: order,
        procedure: 'ORDERED_PLACES',
      }),
    /STALE/,
  );
  assert.throws(
    () =>
      approveAdditionalRound(draw, winners, {
        ...review,
        members: [order[0], order[0], order[2]],
        procedure: 'ORDERED_PLACES',
      }),
    /COHORT_INVALID/,
  );
  const revoked = { ...winners };
  delete revoked[draw.matches[0].id];
  assert.equal(drawProgress(resolved, revoked).complete, false);
});

test('manual order releases MIXED qualification only after every tied group has a decision', () => {
  const draw = v4(generateDraw('MIXED', entries(12), 9, 'REPECHAGE_ONLY'));
  const pools = draw.pools!;
  const winners = Object.fromEntries(
    pools.flatMap((p) =>
      Object.entries(
        cycle(
          draw.matches.filter((m) => m.pool === p.id),
          p.entries,
        ),
      ),
    ),
  );
  let resolved = draw;
  for (const pool of pools) {
    const review = drawProgress(resolved, winners).pendingReviews.find((r) => r.pool === pool.id)!;
    assert.ok(review);
    resolved = approveAdditionalRound(resolved, winners, {
      ...review,
      procedure: 'ORDERED_PLACES',
      members: [...review.members].reverse(),
    });
    if (pool !== pools.at(-1))
      assert.ok(
        resolveMatches(resolved, winners)
          .filter((m) => !m.pool)
          .every((m) => !m.ready),
      );
  }
  assert.equal(drawProgress(resolved, winners).poolStageComplete, true);
  assert.ok(resolveMatches(resolved, winners).some((m) => !m.pool && m.ready));
  assert.deepEqual(resolved.matches, draw.matches);
});
const groupMembers = (draw: Draw, pool?: string) =>
  pool
    ? draw.pools!.find((p) => p.id === pool)!.entries
    : draw.positions.flatMap((p) => (p ? [p.id] : []));
const direct = (m: Match): [string, string] => {
  assert.ok('entryId' in m.white && 'entryId' in m.blue);
  return [m.white.entryId, m.blue.entryId];
};
const minWins = (matches: readonly Match[]) =>
  Object.fromEntries(matches.map((m) => [m.id, direct(m).sort()[0]]));
function cycle(matches: readonly Match[], members: readonly string[]) {
  assert.equal(members.length % 2, 1);
  return Object.fromEntries(
    matches.map((m) => {
      const [a, b] = direct(m),
        delta = (members.indexOf(b) - members.indexOf(a) + members.length) % members.length;
      return [m.id, delta <= (members.length - 1) / 2 ? a : b];
    }),
  );
}
function equalFour(matches: readonly Match[], members: readonly string[]) {
  const [a, b, c, d] = members;
  const winners = new Map([
    [[a, b].sort().join('|'), a],
    [[a, c].sort().join('|'), a],
    [[a, d].sort().join('|'), d],
    [[b, c].sort().join('|'), b],
    [[b, d].sort().join('|'), b],
    [[c, d].sort().join('|'), c],
  ]);
  return Object.fromEntries(matches.map((m) => [m.id, winners.get(direct(m).sort().join('|'))!]));
}
const approval = (draw: Draw, winners: Record<string, string>): AdditionalRoundApproval => ({
  ...drawProgress(draw, winners).pendingReviews[0],
  procedure: 'ROUND_ROBIN',
});
function finish(draw: Draw, winners: Record<string, string>) {
  for (;;) {
    const ready = resolveMatches(draw, winners).filter((m) => m.ready && !winners[m.id]);
    if (!ready.length) return;
    for (const m of ready) winners[m.id] = [m.whiteEntryId!, m.blueEntryId!].sort()[0];
  }
}
function assertUniqueCircleAthletes(draw: Draw) {
  const present = new Map<number, Set<string>>();
  for (const m of draw.matches.filter((m) => m.tieBreakRound)) {
    const circle = present.get(m.round) ?? new Set<string>();
    for (const id of direct(m)) {
      assert.ok(!circle.has(id), `duplicate athlete in circle ${m.round}`);
      circle.add(id);
    }
    present.set(m.round, circle);
  }
}

test('v4 equal wins require two new deciding bouts even when the earlier personal meetings have winners', () => {
  const draw = v4(createRoundRobin(entries(4), 17)),
    ids = groupMembers(draw);
  const winners = equalFour(draw.matches, ids),
    original = structuredClone({ draw, winners });
  const progress = drawProgress(draw, winners);
  assert.equal(progress.complete, false);
  assert.equal(progress.phase, 'TIEBREAK');
  assert.equal(progress.roundBarrier, 4);
  assert.equal(progress.automaticPairs.length, 2);
  assert.equal(progress.pendingReviews.length, 0);
  assert.equal(placements(draw, winners), null);
  const extra = appendRematches(draw, winners);
  assert.equal(extra.matches.length, 8);
  assert.deepEqual(
    extra.matches.filter((m) => m.tieBreakRound).map((m) => m.round),
    [4, 4],
  );
  assert.equal(appendRematches(extra, winners), extra);
  assertUniqueCircleAthletes(extra);
  for (const m of extra.matches.filter((m) => m.tieBreakRound)) {
    const pair = direct(m);
    winners[m.id] = pair.includes(ids[1]) ? ids[1] : ids[3];
  }
  assert.deepEqual(
    placements(extra, winners)?.map((p) => p.entryId),
    [ids[1], ids[0], ids[3], ids[2]],
  );
  assert.equal(drawProgress(extra, winners).complete, true);
  assert.deepEqual(draw, original.draw);
});

test('v4 three-way equality waits for an administrator without additional contests or a fictional champion', () => {
  const draw = v4(createRoundRobin(entries(3), 7)),
    winners = cycle(draw.matches, groupMembers(draw));
  const original = structuredClone({ draw, winners });
  assert.equal(appendRematches(draw, winners), draw);
  const progress = drawProgress(draw, winners);
  assert.equal(progress.phase, 'ADMIN_REVIEW');
  assert.equal(progress.complete, false);
  assert.equal(progress.poolStageComplete, false);
  assert.equal(progress.places, null);
  assert.equal(progress.roundBarrier, 4);
  assert.equal(progress.automaticPairs.length, 0);
  assert.deepEqual(progress.pendingReviews[0], {
    parent: 'base:all',
    pool: undefined,
    members: groupMembers(draw),
    round: 4,
  });
  assert.ok(resolveMatches(draw, winners).every((m) => !!m.winnerEntryId));
  assert.deepEqual({ draw, winners }, original);
});

test('an explicit v4 additional round uses real circles, immutable sources and exact current cohort membership', () => {
  const draw = v4(createRoundRobin(entries(3), 8)),
    winners = cycle(draw.matches, groupMembers(draw));
  const original = structuredClone({ draw, winners }),
    request = approval(draw, winners);
  const extra = approveAdditionalRound(draw, winners, request);
  assert.deepEqual(
    extra.matches.filter((m) => m.tieBreakRound).map((m) => m.round),
    [4, 5, 6],
  );
  assert.equal(extra.tieRounds![0].procedure, 'ROUND_ROBIN');
  assert.deepEqual(
    approveAdditionalRound(draw, winners, { ...request, members: [...request.members].reverse() }),
    extra,
  );
  assert.deepEqual({ draw, winners }, original);
  assertUniqueCircleAthletes(extra);
  assert.equal(drawProgress(extra, winners).phase, 'TIEBREAK');
  assert.equal(drawProgress(extra, winners).roundBarrier, null);
  assert.throws(() => approveAdditionalRound(extra, winners, request), /TIEBREAK_REVIEW_STALE/);
  Object.assign(winners, minWins(extra.matches.filter((m) => m.tieBreakRound)));
  assert.equal(drawProgress(extra, winners).complete, true);
  assert.equal(placements(extra, winners)?.length, 3);
});

test('repeated three-way equality waits again and a nested approval follows the last parent circle', () => {
  let draw = v4(createRoundRobin(entries(3), 9));
  const winners = cycle(draw.matches, groupMembers(draw));
  draw = approveAdditionalRound(draw, winners, approval(draw, winners));
  Object.assign(
    winners,
    cycle(
      draw.matches.filter((m) => m.tieBreakRound),
      groupMembers(draw),
    ),
  );
  const progress = drawProgress(draw, winners);
  assert.equal(progress.pendingReviews[0].parent, 'tb-1');
  assert.equal(progress.roundBarrier, 7);
  assert.equal(progress.complete, false);
  assert.equal(appendRematches(draw, winners), draw);
  draw = approveAdditionalRound(draw, winners, approval(draw, winners));
  assert.deepEqual(
    draw.matches.filter((m) => m.tieBreakRound === 'tb-2').map((m) => m.round),
    [7, 8, 9],
  );
  Object.assign(winners, minWins(draw.matches.filter((m) => m.tieBreakRound === 'tb-2')));
  assert.equal(drawProgress(draw, winners).complete, true);
});

test('nested stages rank only their own wins and simultaneous two-person cohorts share the next true circle', () => {
  let draw = v4(createRoundRobin(entries(5), 10));
  const ids = groupMembers(draw),
    winners = cycle(draw.matches, ids);
  draw = approveAdditionalRound(draw, winners, approval(draw, winners));
  const [a, b, c, d, e] = ids;
  const results = new Map([
    [[a, b].sort().join('|'), a],
    [[a, c].sort().join('|'), a],
    [[a, d].sort().join('|'), d],
    [[a, e].sort().join('|'), a],
    [[b, c].sort().join('|'), b],
    [[b, d].sort().join('|'), b],
    [[b, e].sort().join('|'), b],
    [[c, d].sort().join('|'), c],
    [[c, e].sort().join('|'), c],
    [[d, e].sort().join('|'), d],
  ]);
  for (const m of draw.matches.filter((m) => m.tieBreakRound === 'tb-1'))
    winners[m.id] = results.get(direct(m).sort().join('|'))!;
  const progress = drawProgress(draw, winners);
  assert.equal(progress.automaticPairs.length, 2);
  assert.ok(progress.automaticPairs.every((p) => p.parent === 'tb-1' && p.round === 11));
  assert.equal(progress.pendingReviews.length, 0);
  draw = appendRematches(draw, winners);
  assert.deepEqual(
    draw.matches
      .filter((m) => m.tieBreakRound !== undefined && m.tieBreakRound !== 'tb-1')
      .map((m) => m.round),
    [11, 11],
  );
  for (const m of draw.matches.filter(
    (m) => m.tieBreakRound !== undefined && m.tieBreakRound !== 'tb-1',
  ))
    winners[m.id] = direct(m).includes(b) ? b : d;
  assert.deepEqual(
    placements(draw, winners)?.map((p) => p.entryId),
    [b, a, d, c, e],
  );
  assertUniqueCircleAthletes(draw);
});

test('MIXED v4 blocks every knockout pair while any group has unfinished base results', () => {
  const draw = v4(generateDraw('MIXED', entries(16), 11, 'REPECHAGE_ONLY'));
  const winners = minWins(
    draw.matches.filter((m) => m.pool === draw.pools![0].id || m.pool === draw.pools![1].id),
  );
  assert.ok(
    resolveMatches(draw, winners)
      .filter((m) => !m.pool)
      .every((m) => !m.ready && !m.whiteEntryId && !m.blueEntryId),
  );
  assert.equal(drawProgress(draw, winners).poolStageComplete, false);
  const legacy = { ...draw, tieRanking: undefined, tieMany: undefined };
  assert.ok(resolveMatches(legacy, winners).some((m) => m.stage === 'MAIN' && m.ready));
});

test('MIXED independent tied pools discovered at successive confirmations share circle four and preserve KO IDs', () => {
  let draw = v4(generateDraw('MIXED', entries(16), 12, 'REPECHAGE_ONLY'));
  const original = structuredClone(draw),
    pools = draw.pools!;
  const winners = equalFour(
    draw.matches.filter((m) => m.pool === pools[0].id),
    pools[0].entries,
  );
  draw = appendRematches(draw, winners);
  const firstExtra = draw.matches.filter((m) => m.tieBreakRound);
  for (const m of firstExtra) winners[m.id] = direct(m)[0];
  Object.assign(
    winners,
    equalFour(
      draw.matches.filter((m) => m.pool === pools[1].id && !m.tieBreakRound),
      pools[1].entries,
    ),
  );
  draw = appendRematches(draw, winners);
  assert.ok(draw.matches.filter((m) => m.tieBreakRound).every((m) => m.round === 4));
  assert.equal(draw.matches.filter((m) => m.tieBreakRound).length, 4);
  for (const m of original.matches.filter((m) => !m.pool)) {
    const shifted = draw.matches.find((x) => x.id === m.id)!;
    assert.equal(shifted.round, m.round + 1);
    assert.deepEqual({ ...shifted, round: m.round }, m);
  }
  for (const pool of pools.slice(2))
    Object.assign(winners, minWins(draw.matches.filter((m) => m.pool === pool.id)));
  assert.ok(
    resolveMatches(draw, winners)
      .filter((m) => !m.pool)
      .every((m) => !m.ready),
  );
  Object.assign(
    winners,
    minWins(draw.matches.filter((m) => m.pool === pools[1].id && !!m.tieBreakRound)),
  );
  assert.equal(drawProgress(draw, winners).poolStageComplete, true);
  assert.equal(
    resolveMatches(draw, winners).filter((m) => m.stage === 'MAIN' && m.ready).length,
    4,
  );
  assertUniqueCircleAthletes(draw);
  finish(draw, winners);
  assert.equal(drawProgress(draw, winners).complete, true);
  assert.deepEqual(
    placements(draw, winners)?.map((p) => p.place),
    [1, 2, 3, 3],
  );
});

test('MIXED approved three-way group circles shift knockout, repechage and bronze together, never release KO early', () => {
  let draw = v4(generateDraw('MIXED', entries(12), 13, 'REPECHAGE_ONLY'));
  const original = structuredClone(draw),
    pool = draw.pools![0];
  const winners = cycle(
    draw.matches.filter((m) => m.pool === pool.id),
    pool.entries,
  );
  for (const other of draw.pools!.slice(1))
    Object.assign(winners, minWins(draw.matches.filter((m) => m.pool === other.id)));
  assert.equal(drawProgress(draw, winners).phase, 'ADMIN_REVIEW');
  assert.equal(appendRematches(draw, winners), draw);
  draw = approveAdditionalRound(draw, winners, approval(draw, winners));
  assert.deepEqual(
    draw.matches.filter((m) => m.tieBreakRound).map((m) => m.round),
    [4, 5, 6],
  );
  for (const m of original.matches.filter((m) => !m.pool))
    assert.equal(draw.matches.find((x) => x.id === m.id)!.round, m.round + 3);
  assert.ok(
    resolveMatches(draw, winners)
      .filter((m) => !m.pool)
      .every((m) => !m.ready),
  );
  Object.assign(winners, minWins(draw.matches.filter((m) => m.tieBreakRound)));
  assert.equal(drawProgress(draw, winners).poolStageComplete, true);
  assert.ok(resolveMatches(draw, winners).some((m) => m.stage === 'MAIN' && m.ready));
  finish(draw, winners);
  assert.equal(drawProgress(draw, winners).complete, true);
  assert.equal(drawProgress(draw, winners).places?.length, 4);
});

test('approval cannot invent a member, reuse a resolved review, choose two participants or substitute another procedure', () => {
  const draw = v4(createRoundRobin(entries(3), 14)),
    winners = cycle(draw.matches, groupMembers(draw));
  const request = approval(draw, winners),
    original = structuredClone({ draw, winners });
  for (const bad of [
    { ...request, parent: 'base:another' },
    { ...request, pool: 'foreign' },
    { ...request, members: ['foreign', ...request.members.slice(1)] },
  ])
    assert.throws(() => approveAdditionalRound(draw, winners, bad), /TIEBREAK_REVIEW_STALE/);
  for (const members of [
    [request.members[0], request.members[0], request.members[1]],
    request.members.slice(0, 2),
    ['', ...request.members.slice(1)],
  ])
    assert.throws(
      () => approveAdditionalRound(draw, winners, { ...request, members }),
      /TIEBREAK_COHORT_INVALID/,
    );
  assert.throws(
    () =>
      approveAdditionalRound(draw, winners, {
        ...request,
        procedure: 'PICK_WINNER',
      } as unknown as AdditionalRoundApproval),
    /TIEBREAK_PROCEDURE_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      approveAdditionalRound(
        { ...draw, tieRanking: undefined, tieMany: undefined },
        winners,
        request,
      ),
    /TIEBREAK_V4_REQUIRED/,
  );
  assert.deepEqual({ draw, winners }, original);
});

test('incomplete v4 policies and contradictory confirmed results fail closed', () => {
  const base = createRoundRobin(entries(3), 15);
  for (const broken of [
    { ...base, tieRanking: 'WINS_ONLY' as const },
    { ...base, tieMany: 'ADMIN_REVIEW' as const },
    { ...v4(base), tieBreak: 'PUBLISHED_LOT' as const },
  ])
    assert.throws(() => drawProgress(broken, {}), /DRAW_TIE_POLICY_INVALID/);
  const draw = v4(base),
    winners = cycle(draw.matches, groupMembers(draw));
  assert.throws(() => drawProgress(draw, { ...winners, foreign: 'e000' }), /UNKNOWN_MATCH/);
  assert.throws(
    () => appendRematches(draw, { ...winners, [draw.matches[0].id]: 'foreign' }),
    /INVALID_WINNER/,
  );
  const mixed = v4(generateDraw('MIXED', entries(12), 15, 'REPECHAGE_ONLY'));
  assert.throws(
    () =>
      drawProgress(mixed, { [mixed.matches.find((m) => !m.pool)!.id]: mixed.pools![0].entries[0] }),
    /DEPENDENCY_UNCONFIRMED/,
  );
});

test('v3 head-to-head, automatic three-way rounds and published-lot snapshots retain their historical semantics', () => {
  const base = createRoundRobin(entries(4), 16),
    legacy = { ...base, tieBreak: 'REMATCH' as const };
  const ids = groupMembers(legacy),
    winners = equalFour(legacy.matches, ids),
    original = structuredClone(legacy);
  assert.equal(isWinsOnlyTiePolicy(legacy), false);
  assert.equal(appendRematches(legacy, winners), legacy);
  assert.deepEqual(
    placements(legacy, winners)?.map((p) => p.entryId),
    ids,
  );
  assert.deepEqual(legacy, original);
  const rr3 = createRoundRobin(entries(3), 16),
    cycleWinners = cycle(rr3.matches, groupMembers(rr3));
  assert.equal(appendRematches({ ...rr3, tieBreak: 'REMATCH' }, cycleWinners).matches.length, 6);
  const lot = { ...rr3, tieBreak: 'PUBLISHED_LOT' as const };
  assert.equal(drawProgress(lot, cycleWinners).complete, true);
  assert.equal(drawProgress(lot, cycleWinners).poolStageComplete, true);
});

test('all v4 sizes 2..128 complete with valid opponents, actual BYEs and unique medals across three formats and seeds', () => {
  let checked = 0;
  for (let n = 2; n <= 128; n++)
    for (const format of ['ROUND_ROBIN', 'REPECHAGE', 'MIXED'])
      for (const seed of [0, 1, 0xffffffff]) {
        const draw = v4(generateDraw(format, entries(n), seed, 'REPECHAGE_ONLY')),
          winners: Record<string, string> = {};
        finish(draw, winners);
        const progress = drawProgress(draw, winners);
        assert.equal(progress.complete, true, `${format} n=${n} seed=${seed}`);
        assert.equal(progress.pendingReviews.length, 0);
        assert.equal(progress.automaticPairs.length, 0);
        assert.equal(appendRematches(draw, winners), draw);
        const rows = resolveMatches(draw, winners),
          seen = new Map<number, Set<string>>();
        for (const m of rows) {
          assert.ok(m.whiteEntryId && m.blueEntryId && m.winnerEntryId);
          assert.notEqual(m.whiteEntryId, m.blueEntryId);
          const circle = seen.get(m.round) ?? new Set<string>();
          for (const id of [m.whiteEntryId, m.blueEntryId]) {
            assert.ok(!circle.has(id));
            circle.add(id);
          }
          seen.set(m.round, circle);
        }
        assert.equal(new Set(progress.places!.map((p) => p.entryId)).size, progress.places!.length);
        checked++;
      }
  assert.equal(checked, 1143);
});

test('adversarial cyclic equality at every RR size 3..128 never creates automatic champions or unapproved rounds', () => {
  for (let n = 3; n <= 128; n++) {
    const draw = v4(createRoundRobin(entries(n), n));
    const members = groupMembers(draw);
    const tied = n % 2 ? members : members.slice(1);
    const matches = draw.matches.filter((m) => direct(m).every((id) => tied.includes(id)));
    const winners = cycle(matches, tied);
    if (n % 2 === 0)
      for (const m of draw.matches.filter((m) => direct(m).includes(members[0])))
        winners[m.id] = members[0];
    const progress = drawProgress(draw, winners);
    assert.equal(progress.complete, false, `n=${n}`);
    assert.equal(progress.phase, 'ADMIN_REVIEW');
    assert.equal(progress.automaticPairs.length, 0);
    assert.equal(progress.pendingReviews.length, 1);
    assert.deepEqual(progress.pendingReviews[0].members, tied);
    assert.equal(progress.roundBarrier, (n % 2 ? n : n - 1) + 1);
    assert.equal(appendRematches(draw, winners), draw);
    assert.equal(placements(draw, winners), null);
  }
});
