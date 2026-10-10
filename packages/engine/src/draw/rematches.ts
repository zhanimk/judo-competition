import {
  createRoundRobin,
  legacyPoolStandings,
  poolStandings,
  resolveMatches,
  placements,
  type Draw,
  type Match,
} from './index.ts';
type Standing = { entryId: string; wins: number; tiedWins: number; lot: number };
type Needed = { parent: string; pool?: string; members: string[] };
export type TieRequirement = Readonly<{
  parent: string;
  pool?: string;
  members: readonly string[];
  /** First circle of this next stage, including a virtual unapproved review. */
  round: number;
}>;
export type AdditionalRoundApproval = Readonly<{
  parent: string;
  pool?: string;
  members: readonly string[];
  procedure: 'ROUND_ROBIN';
}>;
export type DrawProgress = Readonly<{
  phase: 'GROUPS' | 'TIEBREAK' | 'ADMIN_REVIEW' | 'KNOCKOUT' | 'COMPLETE';
  complete: boolean;
  poolStageComplete: boolean;
  pendingReviews: readonly TieRequirement[];
  automaticPairs: readonly TieRequirement[];
  /** Virtual barrier only. Existing unconfirmed contests retain their own rounds. */
  roundBarrier: number | null;
  places: readonly { place: number; entryId: string }[] | null;
}>;

/** The new policy is opt-in on an immutable draw snapshot. Never upgrade legacy
 * draws by current application defaults; malformed half-policies fail closed. */
export function isWinsOnlyTiePolicy(draw: Draw): boolean {
  if (draw.tieRanking === undefined && draw.tieMany === undefined) return false;
  if (
    draw.tieRanking !== 'WINS_ONLY' ||
    draw.tieMany !== 'ADMIN_REVIEW' ||
    draw.tieBreak !== 'REMATCH'
  )
    throw new Error('DRAW_TIE_POLICY_INVALID');
  return true;
}

export function rematchStandings(
  draw: Draw,
  winners: Readonly<Record<string, string>>,
  pool?: string,
) {
  const winsOnly = isWinsOnlyTiePolicy(draw);
  const members = pool
    ? draw.pools?.find((p) => p.id === pool)?.entries
    : draw.positions.flatMap((p) => (p ? [p.id] : []));
  if (!members) throw new Error('UNKNOWN_POOL');
  const needed: Needed[] = [];
  function rank(
    ids: readonly string[],
    matches: readonly Match[],
    parent: string,
  ): Standing[] | null {
    const rows = legacyPoolStandings(
      {
        ...draw,
        algorithm: 'custom-round-robin-v1',
        positions: ids.map((id) => ({ id, clubId: id })),
        matches,
      },
      winners,
    );
    if (!rows) return null;
    // The immutable lot stabilizes display/cohort member order, never awards a
    // place to athletes with equal wins. Every such cohort must be resolved.
    if (winsOnly) rows.sort((a, b) => b.wins - a.wins || a.lot - b.lot);
    const groups: Standing[][] = [];
    for (const row of rows) {
      const previous = groups.at(-1);
      if (
        previous &&
        previous[0].wins === row.wins &&
        (winsOnly || previous[0].tiedWins === row.tiedWins)
      )
        previous.push(row);
      else groups.push([row]);
    }
    let complete = true;
    const result: Standing[] = [];
    for (const group of groups) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }
      const tied = group.map((r) => r.entryId);
      const round = draw.tieRounds?.find(
        (r) =>
          r.parent === parent &&
          r.members.length === tied.length &&
          tied.every((id) => r.members.includes(id)),
      );
      if (!round) {
        needed.push({ parent, pool, members: tied });
        complete = false;
        continue;
      }
      const resolved = rank(
        tied,
        draw.matches.filter((m) => m.tieBreakRound === round.id),
        round.id,
      );
      if (!resolved) complete = false;
      else result.push(...resolved.map((r) => group.find((g) => g.entryId === r.entryId)!));
    }
    return complete ? result : null;
  }
  const base = draw.matches.filter(
    (m) =>
      !m.tieBreakRound && (pool ? m.pool === pool : draw.algorithm === 'custom-round-robin-v1'),
  );
  return { standings: rank(members, base, 'base:' + (pool ?? 'all')), needed };
}
/** Append only newly required rounds. Repeating the same confirmed results is a no-op. */
export function appendRematches(draw: Draw, winners: Readonly<Record<string, string>>): Draw {
  if (isWinsOnlyTiePolicy(draw)) {
    // Validate the complete confirmed map, including dependency membership.
    resolveMatches(draw, winners);
    const pending = requirements(draw, winners).filter((need) => need.members.length === 2);
    return addRounds(draw, pending, 'DECIDING_BOUT');
  }
  if (
    draw.tieBreak !== 'REMATCH' ||
    !['custom-round-robin-v1', 'custom-pools-knockout-v1'].includes(draw.algorithm)
  )
    return draw;
  const pools = draw.pools?.map((p) => p.id) ?? [undefined];
  const pending = pools.flatMap((pool) => rematchStandings(draw, winners, pool).needed);
  if (!pending.length) return draw;
  const matches = [...draw.matches],
    rounds = [...(draw.tieRounds ?? [])];
  for (const need of pending) {
    const id = 'tb-' + (rounds.length + 1);
    const rr = createRoundRobin(
      need.members.map((id) => ({ id, clubId: id })),
      draw.seed,
    );
    const offset = Math.max(
      ...matches.filter((m) => (need.pool ? m.pool === need.pool : true)).map((m) => m.round),
    );
    rounds.push({ ...need, id });
    matches.push(
      ...rr.matches.map((m) => ({
        ...m,
        id: id + '-' + m.id,
        round: need.pool ? offset : offset + m.round,
        stage: need.pool ? ('POOL' as const) : ('TIEBREAK' as const),
        pool: need.pool,
        tieBreakRound: id,
      })),
    );
  }
  return { ...draw, matches, tieRounds: rounds };
}

function groupPools(draw: Draw): (string | undefined)[] {
  if (draw.algorithm === 'custom-round-robin-v1') return [undefined];
  if (draw.algorithm === 'custom-pools-knockout-v1')
    return draw.pools?.map((pool) => pool.id) ?? [];
  return [];
}

function nextRound(draw: Draw, parent: string): number {
  // Base cohorts discovered on different confirmations share one next circle.
  // A nested cohort follows the last actual circle of its own parent stage.
  const matches = parent.startsWith('base:')
    ? draw.matches.filter(
        (match) =>
          !match.tieBreakRound && (draw.algorithm === 'custom-round-robin-v1' || !!match.pool),
      )
    : draw.matches.filter((match) => match.tieBreakRound === parent);
  if (!matches.length) throw new Error('TIEBREAK_PARENT_INVALID');
  return Math.max(...matches.map((match) => match.round)) + 1;
}

function requirements(draw: Draw, winners: Readonly<Record<string, string>>): TieRequirement[] {
  return groupPools(draw).flatMap((pool) =>
    rematchStandings(draw, winners, pool).needed.map((need) => ({
      ...need,
      members: [...need.members],
      round: nextRound(draw, need.parent),
    })),
  );
}

/** No invented champions or physical placeholder bouts for a manual review.
 * Consumers must combine roundBarrier with actual unfinished contest rounds. */
export function drawProgress(draw: Draw, winners: Readonly<Record<string, string>>): DrawProgress {
  const rows = resolveMatches(draw, winners);
  const winsOnly = isWinsOnlyTiePolicy(draw);
  const needs = winsOnly ? requirements(draw, winners) : [];
  const pendingReviews = needs.filter((need) => need.members.length >= 3);
  const automaticPairs = needs.filter((need) => need.members.length === 2);
  const pools = groupPools(draw);
  const poolStageComplete = pools.every((pool) => poolStandings(draw, winners, pool) !== null);
  const places = placements(draw, winners);
  const complete = places !== null;
  const waitingTie = rows.some((match) => match.tieBreakRound && !match.winnerEntryId);
  return {
    phase: complete
      ? 'COMPLETE'
      : pendingReviews.length
        ? 'ADMIN_REVIEW'
        : automaticPairs.length || waitingTie
          ? 'TIEBREAK'
          : !poolStageComplete
            ? 'GROUPS'
            : 'KNOCKOUT',
    complete,
    poolStageComplete,
    pendingReviews,
    automaticPairs,
    roundBarrier: needs.length ? Math.min(...needs.map((need) => need.round)) : null,
    places,
  };
}

function addRounds(
  draw: Draw,
  pending: readonly TieRequirement[],
  procedure: 'DECIDING_BOUT' | 'ROUND_ROBIN',
): Draw {
  if (!pending.length) return draw;
  const matches = [...draw.matches];
  const rounds = [...(draw.tieRounds ?? [])];
  for (const need of pending) {
    const id = 'tb-' + (rounds.length + 1);
    const rr = createRoundRobin(
      need.members.map((id) => ({ id, clubId: id })),
      draw.seed,
    );
    const added = rr.matches.map((match) => ({
      ...match,
      id: id + '-' + match.id,
      round: need.round - 1 + match.round,
      stage: need.pool ? ('POOL' as const) : ('TIEBREAK' as const),
      pool: need.pool,
      tieBreakRound: id,
    }));
    if (
      rounds.some((round) => round.id === id) ||
      added.some((match) => matches.some((old) => old.id === match.id))
    )
      throw new Error('TIEBREAK_ID_CONFLICT');
    rounds.push({
      parent: need.parent,
      pool: need.pool,
      members: [...need.members],
      id,
      procedure,
    });
    matches.push(...added);
  }
  // The pure draw has no live Contest state. The server must reject this shift
  // if any affected knockout/medal contest has already started or confirmed.
  if (draw.algorithm === 'custom-pools-knockout-v1') {
    const knockout = matches.filter((match) => !match.pool);
    const groupLastRound = Math.max(
      ...matches.filter((match) => match.pool).map((match) => match.round),
    );
    const knockoutFirstRound = Math.min(...knockout.map((match) => match.round));
    const shift = Math.max(0, groupLastRound + 1 - knockoutFirstRound);
    if (shift)
      for (let index = 0; index < matches.length; index++) {
        const match = matches[index];
        if (!match.pool) matches[index] = { ...match, round: match.round + shift };
      }
  }
  return { ...draw, matches, tieRounds: rounds };
}

/** Pure construction of an explicitly approved current review. Authorization,
 * reasons, revisions, immutable receipts and started-dependency checks belong
 * to the server transaction, never to this sporting calculation. */
export function approveAdditionalRound(
  draw: Draw,
  winners: Readonly<Record<string, string>>,
  approval: AdditionalRoundApproval,
): Draw {
  if (!isWinsOnlyTiePolicy(draw)) throw new Error('TIEBREAK_V4_REQUIRED');
  if (approval.procedure !== 'ROUND_ROBIN') throw new Error('TIEBREAK_PROCEDURE_UNSUPPORTED');
  if (
    !Array.isArray(approval.members) ||
    approval.members.length < 3 ||
    approval.members.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(approval.members).size !== approval.members.length
  )
    throw new Error('TIEBREAK_COHORT_INVALID');
  const pending = drawProgress(draw, winners).pendingReviews.find(
    (need) =>
      need.parent === approval.parent &&
      need.pool === approval.pool &&
      need.members.length === approval.members.length &&
      need.members.every((id) => approval.members.includes(id)),
  );
  if (!pending) throw new Error('TIEBREAK_REVIEW_STALE');
  return addRounds(draw, [pending], 'ROUND_ROBIN');
}
