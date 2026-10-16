import { rematchStandings, isWinsOnlyTiePolicy } from './rematches.ts';
export type Entry = Readonly<{ id: string; clubId: string }>;
export type Slot =
  | Readonly<{ entryId: string }>
  | Readonly<{ winnerOf: string }>
  | Readonly<{ loserOf: string }>
  | Readonly<{ pool: string; place: number }>;
export type Match = Readonly<{
  id: string;
  round: number;
  white: Slot;
  blue: Slot;
  stage?: 'MAIN' | 'REPECHAGE' | 'BRONZE' | 'POOL' | 'TIEBREAK';
  tieBreakRound?: string;
  pool?: string;
}>;
export type Draw = Readonly<{
  medalPolicy?: 'QUARTER_REPECHAGE';
  tieBreak?: 'PUBLISHED_LOT' | 'REMATCH';
  /** Missing fields preserve the historical head-to-head/rematch profile. */
  tieRanking?: 'WINS_ONLY';
  tieMany?: 'ADMIN_REVIEW';
  withdrawnEntryIds?: readonly string[];
  voidMatches?: readonly string[];
  frozenPoolOrder?: Readonly<Record<string, readonly string[]>>;
  frozenPoolWithdrawnIds?: readonly string[];
  tieDecisions?: readonly Readonly<{
    parent: string;
    pool?: string;
    /** Explicit order inside one equal-wins cohort, never automatic score ranking. */
    members: readonly string[];
    sourceResults: readonly Readonly<{ matchId: string; winnerEntryId: string | null }>[];
  }>[];
  tieRounds?: readonly {
    id: string;
    parent: string;
    pool?: string;
    members: readonly string[];
    procedure?: 'DECIDING_BOUT' | 'ROUND_ROBIN';
  }[];
  algorithm:
    | 'custom-club-balanced-v1'
    | 'custom-round-robin-v1'
    | 'custom-quarter-repechage-v1'
    | 'custom-pools-knockout-v1';
  pools?: readonly Readonly<{ id: string; entries: readonly string[] }>[];
  seed: number;
  size: number;
  positions: readonly (Entry | null)[];
  matches: readonly Match[];
  firstRoundClubPairs: number;
  optimalityProven: false;
}>;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Custom, unseeded draw only. Club balancing is a heuristic, not an IJF profile. */
export function createDraw(entries: readonly Entry[], seed: number): Draw {
  if (entries.length < 2 || entries.length > 128) throw new Error('ENTRY_COUNT');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('INVALID_SEED');
  if (entries.some((e) => !e.id.trim() || !e.clubId.trim())) throw new Error('INVALID_ENTRY');
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error('DUPLICATE_ENTRY');
  const rng = random(seed);
  const size = 2 ** Math.ceil(Math.log2(entries.length));
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  function split(list: Entry[], capacity: number): (Entry | null)[] {
    if (capacity === 1) return [list[0] ? { ...list[0] } : null];
    const groups = new Map<string, Entry[]>();
    for (const e of list) groups.set(e.clubId, [...(groups.get(e.clubId) ?? []), e]);
    const buckets = shuffle([...groups.values()], rng).sort((a, b) => b.length - a.length);
    const left: Entry[] = [],
      right: Entry[] = [];
    for (const group of buckets) {
      for (const entry of shuffle([...group], rng)) {
        const lc = left.filter((e) => e.clubId === entry.clubId).length;
        const rc = right.filter((e) => e.clubId === entry.clubId).length;
        const takeLeft =
          left.length >= capacity / 2
            ? false
            : right.length >= capacity / 2
              ? true
              : lc !== rc
                ? lc < rc
                : left.length !== right.length
                  ? left.length < right.length
                  : rng() < 0.5;
        (takeLeft ? left : right).push(entry);
      }
    }
    return [...split(left, capacity / 2), ...split(right, capacity / 2)];
  }
  const positions = split(ordered, size);
  const matches: Match[] = [];
  let sources: (Slot | null)[] = positions.map((e) => (e ? { entryId: e.id } : null));
  let round = 1;
  while (sources.length > 1) {
    const next: (Slot | null)[] = [];
    for (let i = 0; i < sources.length; i += 2) {
      const white = sources[i],
        blue = sources[i + 1];
      if (!white || !blue) {
        next.push(white ?? blue);
        continue;
      }
      const id = `r${round}-m${i / 2 + 1}`;
      matches.push({ id, round, white, blue });
      next.push({ winnerOf: id });
    }
    sources = next;
    round++;
  }
  let firstRoundClubPairs = 0;
  for (let i = 0; i < size; i += 2) {
    if (positions[i] && positions[i + 1] && positions[i]!.clubId === positions[i + 1]!.clubId)
      firstRoundClubPairs++;
  }
  return {
    algorithm: 'custom-club-balanced-v1',
    seed,
    size,
    positions,
    matches,
    firstRoundClubPairs,
    optimalityProven: false,
  };
}

function confirmedWinner(winners: Readonly<Record<string, string>>, matchId: string) {
  return Object.hasOwn(winners, matchId) ? winners[matchId] : undefined;
}

/** Replay confirmed winners without mutating the draw. BYEs never become results. */
export function resolveMatches(draw: Draw, winners: Readonly<Record<string, string>>) {
  const known = new Set(draw.matches.map((m) => m.id));
  if (
    new Set(draw.voidMatches ?? []).size !== (draw.voidMatches?.length ?? 0) ||
    draw.voidMatches?.some((id) => !known.has(id))
  )
    throw new Error('VOID_MATCH_INVALID');
  for (const id of Object.keys(winners)) if (!known.has(id)) throw new Error('UNKNOWN_MATCH');
  const blockKnockout =
    isWinsOnlyTiePolicy(draw) &&
    draw.algorithm === 'custom-pools-knockout-v1' &&
    (!draw.pools?.length ||
      draw.pools.some((pool) => poolStandings(draw, winners, pool.id) === null));
  const resolved = new Map<string, string | null>();
  const losers = new Map<string, string | null>();
  const rows = [];
  const resolve = (slot: Slot): string | null | undefined => {
    if ('entryId' in slot) return slot.entryId;
    if ('winnerOf' in slot) return resolved.get(slot.winnerOf);
    if ('loserOf' in slot) return losers.get(slot.loserOf);
    return poolStandings(draw, winners, slot.pool)?.[slot.place - 1]?.entryId;
  };
  for (const match of draw.matches) {
    const blocked = blockKnockout && !match.pool;
    const white = blocked ? undefined : resolve(match.white),
      blue = blocked ? undefined : resolve(match.blue);
    const winner = confirmedWinner(winners, match.id);
    if (winner !== undefined) {
      if (white === undefined || blue === undefined) throw new Error('DEPENDENCY_UNCONFIRMED');
      if (winner !== white && winner !== blue) throw new Error('INVALID_WINNER');
      resolved.set(match.id, winner);
      losers.set(match.id, winner === white ? blue : white);
    }
    const voided = draw.voidMatches?.includes(match.id) ?? false;
    if (voided) {
      if (
        winner !== undefined ||
        white === undefined ||
        blue === undefined ||
        (white !== null && !draw.withdrawnEntryIds?.includes(white)) ||
        (blue !== null && !draw.withdrawnEntryIds?.includes(blue))
      )
        throw new Error('VOID_MATCH_INVALID');
      resolved.set(match.id, null);
      losers.set(match.id, null);
    }
    rows.push({
      ...match,
      whiteEntryId: white ?? undefined,
      blueEntryId: blue ?? undefined,
      whiteEmpty: white === null,
      blueEmpty: blue === null,
      voided,
      winnerEntryId: winner,
      ready: !!white && !!blue && winner === undefined && !voided,
    });
  }
  return rows;
}

/** Circle schedule: every unordered pair meets exactly once; an odd-field rest is not a contest. */
export function createRoundRobin(entries: readonly Entry[], seed: number): Draw {
  // Reuse input validation, then independently randomize the circle.
  createDraw(entries, seed);
  const positions = shuffle(
    entries.map((e) => ({ ...e })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    random(seed),
  );
  const circle: (Entry | null)[] = [...positions];
  if (circle.length % 2) circle.push(null);
  const matches: Match[] = [];
  let firstRoundClubPairs = 0;
  for (let r = 1; r < circle.length; r++) {
    for (let i = 0; i < circle.length / 2; i++) {
      const a = circle[i],
        b = circle[circle.length - 1 - i];
      if (!a || !b) continue;
      const [white, blue] = (r + i) % 2 ? [a, b] : [b, a];
      matches.push({
        id: `r${r}-m${i + 1}`,
        round: r,
        white: { entryId: white.id },
        blue: { entryId: blue.id },
      });
      if (r === 1 && a.clubId === b.clubId) firstRoundClubPairs++;
    }
    circle.splice(1, 0, circle.pop()!);
  }
  return {
    algorithm: 'custom-round-robin-v1',
    seed,
    size: entries.length,
    positions,
    matches,
    firstRoundClubPairs,
    optimalityProven: false,
  };
}

/** Quarter-final repechage. Eight or more entrants ensure four real quarter-finals. */
export function createRepechage(entries: readonly Entry[], seed: number): Draw {
  if (entries.length < 8) throw new Error('REPECHAGE_MIN_8');
  const base = createDraw(entries, seed);
  return { ...withQuarterRepechage(base), algorithm: 'custom-quarter-repechage-v1' };
}

/** Attach medal routes to a full knockout quarter-final stage, including mixed draws. */
function withQuarterRepechage(base: Draw): Draw {
  const main = base.matches.filter((m) => !m.stage || m.stage === 'MAIN');
  const rounds = Math.max(...main.map((m) => m.round));
  const quarters = main.filter((m) => m.round === rounds - 2);
  const semis = main.filter((m) => m.round === rounds - 1);
  if (quarters.length !== 4 || semis.length !== 2) throw new Error('INCOMPLETE_QUARTER_FINALS');
  const extras: Match[] = [
    {
      id: 'rep-a',
      round: rounds,
      stage: 'REPECHAGE',
      white: { loserOf: quarters[0].id },
      blue: { loserOf: quarters[1].id },
    },
    {
      id: 'rep-b',
      round: rounds,
      stage: 'REPECHAGE',
      white: { loserOf: quarters[2].id },
      blue: { loserOf: quarters[3].id },
    },
    {
      id: 'bronze-a',
      round: rounds + 1,
      stage: 'BRONZE',
      white: { winnerOf: 'rep-a' },
      blue: { loserOf: semis[1].id },
    },
    {
      id: 'bronze-b',
      round: rounds + 1,
      stage: 'BRONZE',
      white: { winnerOf: 'rep-b' },
      blue: { loserOf: semis[0].id },
    },
  ];
  return {
    ...base,
    medalPolicy: 'QUARTER_REPECHAGE',
    matches: [...base.matches, ...extras],
  };
}

/** Custom ranking: wins, wins within the tied cohort, then the published pre-draw lot.
 * The lot is the immutable order in pool.entries, never database IDs or completion time.
 * This is an explicitly disclosed custom tie-break, not an IJF ranking profile.
 */
export function legacyPoolStandings(
  draw: Draw,
  winners: Readonly<Record<string, string>>,
  poolId?: string,
) {
  const members = poolId
    ? draw.pools?.find((p) => p.id === poolId)?.entries
    : draw.positions.flatMap((e) => (e ? [e.id] : []));
  if (!members) throw new Error('UNKNOWN_POOL');
  const matches = draw.matches.filter((m) =>
    poolId ? m.pool === poolId : draw.algorithm === 'custom-round-robin-v1',
  );
  if (
    !matches.length ||
    matches.some((m) => !confirmedWinner(winners, m.id) && !draw.voidMatches?.includes(m.id))
  )
    return null;
  const wins = new Map(members.map((id) => [id, 0]));
  for (const m of matches) {
    if (draw.voidMatches?.includes(m.id)) continue;
    const w = confirmedWinner(winners, m.id)!;
    if (
      !('entryId' in m.white) ||
      !('entryId' in m.blue) ||
      (w !== m.white.entryId && w !== m.blue.entryId)
    )
      throw new Error('INVALID_WINNER');
    wins.set(w, wins.get(w)! + 1);
  }
  return members
    .map((entryId, lot) => ({
      entryId,
      wins: wins.get(entryId)!,
      lot: lot + 1,
      tiedWins: matches.filter(
        (m) =>
          confirmedWinner(winners, m.id) === entryId &&
          'entryId' in m.white &&
          'entryId' in m.blue &&
          wins.get(m.white.entryId) === wins.get(m.blue.entryId),
      ).length,
    }))
    .sort((a, b) => b.wins - a.wins || b.tiedWins - a.tiedWins || a.lot - b.lot);
}

export function poolStandings(
  draw: Draw,
  winners: Readonly<Record<string, string>>,
  poolId?: string,
) {
  const frozen = poolId ? draw.frozenPoolOrder?.[poolId] : undefined;
  if (frozen) {
    const members = draw.pools?.find((p) => p.id === poolId)?.entries;
    if (
      !members ||
      frozen.length !== members.length ||
      new Set(frozen).size !== members.length ||
      members.some((id) => !frozen.includes(id))
    )
      throw new Error('FROZEN_POOL_INVALID');
    const original = rematchStandings(
      { ...draw, withdrawnEntryIds: draw.frozenPoolWithdrawnIds },
      winners,
      poolId,
    ).standings;
    if (!original) throw new Error('FROZEN_POOL_RESULTS_CHANGED');
    if (original.some((row, index) => row.entryId !== frozen[index]))
      throw new Error('FROZEN_POOL_RESULTS_CHANGED');
    return original;
  }
  return draw.tieBreak === 'REMATCH'
    ? rematchStandings(draw, winners, poolId).standings
    : legacyPoolStandings(draw, winners, poolId);
}

/** Balanced pools of 2–4; two qualifiers per pool, crossed knockout, same-pool athletes in opposite halves. */
export function createMixed(entries: readonly Entry[], seed: number, repechage = false): Draw {
  if (repechage && entries.length < 8) throw new Error('MIXED_REPECHAGE_MIN_8');
  if (entries.length < 4) throw new Error('MIXED_MIN_4');
  const base = createDraw(entries, seed);
  const count = Math.max(repechage ? 4 : 2, 2 ** Math.ceil(Math.log2(entries.length / 4)));
  const buckets: Entry[][] = Array.from({ length: count }, () => []);
  // Repeated club members are distributed over the currently least represented pools.
  const ordered = base.positions
    .flatMap((e) => (e ? [e] : []))
    .sort((a, b) => a.clubId.localeCompare(b.clubId));
  for (const e of ordered) {
    const options = buckets
      .map((b, i) => ({ i, size: b.length, club: b.filter((x) => x.clubId === e.clubId).length }))
      .filter((b) => b.size < Math.ceil(entries.length / count))
      .sort((a, b) => a.club - b.club || a.size - b.size || a.i - b.i);
    buckets[options[0].i].push(e);
  }
  // Balance sizes while preserving the declared maximum. This also prevents empty pools.
  while (
    Math.max(...buckets.map((b) => b.length)) - Math.min(...buckets.map((b) => b.length)) >
    1
  ) {
    const high = buckets.reduce((a, b) => (a.length > b.length ? a : b));
    const low = buckets.reduce((a, b) => (a.length < b.length ? a : b));
    low.push(high.pop()!);
  }
  const pools = buckets.map((b, i) => ({
    id: count <= 26 ? String.fromCharCode(65 + i) : `P${i + 1}`,
    entries: b.map((e) => e.id),
  }));
  const matches: Match[] = [];
  let firstRoundClubPairs = 0;
  buckets.forEach((bucket, i) => {
    const rr = createRoundRobin(bucket, seed + i > 0xffffffff ? i : seed + i);
    // Published lot follows the actual randomized round-robin positions.
    pools[i].entries = rr.positions.flatMap((e) => (e ? [e.id] : []));
    firstRoundClubPairs += rr.firstRoundClubPairs;
    matches.push(
      ...rr.matches.map((m) => ({
        ...m,
        id: pools[i].id + '-' + m.id,
        stage: 'POOL' as const,
        pool: pools[i].id,
      })),
    );
  });
  let sources: Slot[] = [];
  for (const parity of [0, 1])
    for (let i = parity; i < count; i += 2) {
      sources.push({ pool: pools[i].id, place: 1 }, { pool: pools[i ^ 1].id, place: 2 });
    }
  let round = 4;
  while (sources.length > 1) {
    const next: Slot[] = [];
    for (let i = 0; i < sources.length; i += 2) {
      const id = `ko-${round}-${i / 2 + 1}`;
      matches.push({ id, round, stage: 'MAIN', white: sources[i], blue: sources[i + 1] });
      next.push({ winnerOf: id });
    }
    sources = next;
    round++;
  }
  const result: Draw = {
    ...base,
    algorithm: 'custom-pools-knockout-v1',
    positions: base.positions.filter((e) => e !== null),
    size: entries.length,
    pools,
    matches,
    firstRoundClubPairs,
  };
  return repechage ? withQuarterRepechage(result) : result;
}

export const NEW_DRAW_FORMATS = ['REPECHAGE', 'ROUND_ROBIN', 'MIXED'] as const;
export function drawFormat(draw: Draw): string {
  return {
    'custom-club-balanced-v1': 'SINGLE_ELIMINATION',
    'custom-round-robin-v1': 'ROUND_ROBIN',
    'custom-quarter-repechage-v1': 'REPECHAGE',
    'custom-pools-knockout-v1': 'MIXED',
  }[draw.algorithm];
}

export const DRAW_FORMATS = ['SINGLE_ELIMINATION', 'REPECHAGE', 'ROUND_ROBIN', 'MIXED'] as const;
export function generateDraw(
  format: string,
  entries: readonly Entry[],
  seed: number,
  policy: 'LEGACY' | 'REPECHAGE_ONLY' = 'LEGACY',
): Draw {
  if (policy === 'REPECHAGE_ONLY') {
    if (!NEW_DRAW_FORMATS.some((f) => f === format)) throw new Error('FORMAT_UNSUPPORTED');
    if (entries.length < 8 || format === 'ROUND_ROBIN') return createRoundRobin(entries, seed);
    return format === 'MIXED' ? createMixed(entries, seed, true) : createRepechage(entries, seed);
  }
  switch (format) {
    case 'SINGLE_ELIMINATION':
      return createDraw(entries, seed);
    case 'REPECHAGE':
      return createRepechage(entries, seed);
    case 'ROUND_ROBIN':
      return createRoundRobin(entries, seed);
    case 'MIXED':
      return createMixed(entries, seed);
    default:
      throw new Error('FORMAT_UNSUPPORTED');
  }
}

/** Only confirmed, complete categories receive placements. No fabricated bronze for formats without bronze bouts. */
export function placements(
  draw: Draw,
  winners: Readonly<Record<string, string>>,
): { place: number; entryId: string }[] | null {
  const rows = resolveMatches(draw, winners);
  if (rows.some((m) => !m.winnerEntryId && !m.voided)) return null;
  if (draw.algorithm === 'custom-round-robin-v1')
    return (
      poolStandings(draw, winners)
        ?.filter((r) => !draw.withdrawnEntryIds?.includes(r.entryId))
        .map((r, i) => ({ place: i + 1, entryId: r.entryId })) ?? null
    );
  const final = rows.filter((m) => !m.stage || m.stage === 'MAIN').at(-1)!;
  return [
    { place: 1, entryId: final.winnerEntryId! },
    {
      place: 2,
      entryId: (final.winnerEntryId === final.whiteEntryId
        ? final.blueEntryId
        : final.whiteEntryId)!,
    },
    ...rows
      .filter((m) => m.stage === 'BRONZE')
      .map((m) => ({ place: 3, entryId: m.winnerEntryId! })),
  ].filter((place) => !!place.entryId && !draw.withdrawnEntryIds?.includes(place.entryId));
}

/** Transitive sporting dependencies, including loser routes and pool rankings. */
export function dependentMatches(draw: Draw, matchId: string): string[] {
  if (!draw.matches.some((m) => m.id === matchId)) throw new Error('UNKNOWN_MATCH');
  const affected = new Set([matchId]);
  const depends = (slot: Slot) =>
    'winnerOf' in slot
      ? affected.has(slot.winnerOf)
      : 'loserOf' in slot
        ? affected.has(slot.loserOf)
        : 'pool' in slot
          ? draw.matches.some((m) => m.pool === slot.pool && affected.has(m.id))
          : false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of draw.matches)
      if (!affected.has(m.id) && (depends(m.white) || depends(m.blue))) {
        affected.add(m.id);
        changed = true;
      }
  }
  return [...affected].filter((id) => id !== matchId);
}

export type CategoryLoad = { id: string; matches: number; tatamiId?: string | null };
/** Largest categories first; fixed categories remain on their tatami. No category is split. */
export function balanceCategoryLoads(
  categories: readonly CategoryLoad[],
  tatamiIds: readonly string[],
) {
  if (!tatamiIds.length || new Set(tatamiIds).size !== tatamiIds.length)
    throw new Error('INVALID_TATAMIS');
  if (
    new Set(categories.map((c) => c.id)).size !== categories.length ||
    categories.some(
      (c) =>
        !Number.isInteger(c.matches) ||
        c.matches < 0 ||
        (c.tatamiId && !tatamiIds.includes(c.tatamiId)),
    )
  )
    throw new Error('INVALID_CATEGORY_LOAD');
  const loads = new Map(tatamiIds.map((id) => [id, 0]));
  const assignments = new Map<string, string>();
  for (const c of categories)
    if (c.tatamiId) {
      assignments.set(c.id, c.tatamiId);
      loads.set(c.tatamiId, loads.get(c.tatamiId)! + c.matches);
    }
  const pending = categories
    .filter((c) => !c.tatamiId)
    .sort((a, b) => b.matches - a.matches || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of pending) {
    const tatamiId = tatamiIds.reduce((best, id) =>
      loads.get(id)! < loads.get(best)! ? id : best,
    );
    assignments.set(c.id, tatamiId);
    loads.set(tatamiId, loads.get(tatamiId)! + c.matches);
  }
  return {
    assignments: categories.map((c) => ({ categoryId: c.id, tatamiId: assignments.get(c.id)! })),
    loads: tatamiIds.map((id) => ({ tatamiId: id, matches: loads.get(id)! })),
  };
}

export type ScheduledBout = {
  round: number;
  birthYearFrom: number;
  birthYearTo: number;
  maxWeightGrams: number | null;
  minWeightGrams?: number | null;
  categoryId: string;
  queueOrder: number | null;
  key: string;
};
/** Round barriers first; within a round youngest age band, lightest weight, then stable category/bout order. */
export function compareScheduledBouts(a: ScheduledBout, b: ScheduledBout) {
  return (
    a.round - b.round ||
    b.birthYearFrom - a.birthYearFrom ||
    b.birthYearTo - a.birthYearTo ||
    (a.maxWeightGrams || Infinity) - (b.maxWeightGrams || Infinity) ||
    (a.maxWeightGrams === null && b.maxWeightGrams === null
      ? (a.minWeightGrams ?? 0) - (b.minWeightGrams ?? 0)
      : 0) ||
    a.categoryId.localeCompare(b.categoryId) ||
    (a.queueOrder ?? 0) - (b.queueOrder ?? 0) ||
    a.key.localeCompare(b.key, 'en', { numeric: true })
  );
}

export { bracketNodes, type BracketNode } from './bracket.ts';
export { withdrawalProgress, withdrawEntry } from './withdrawals.ts';

export {
  appendRematches,
  rematchStandings,
  drawProgress,
  approveAdditionalRound,
  isWinsOnlyTiePolicy,
  type DrawProgress,
  type TieRequirement,
  type AdditionalRoundApproval,
} from './rematches.ts';
