import { createRoundRobin, legacyPoolStandings, type Draw, type Match } from './index.ts';
type Standing = { entryId: string; wins: number; tiedWins: number; lot: number };
type Needed = { parent: string; pool?: string; members: string[] };
export function rematchStandings(
  draw: Draw,
  winners: Readonly<Record<string, string>>,
  pool?: string,
) {
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
    const groups: Standing[][] = [];
    for (const row of rows) {
      const previous = groups.at(-1);
      if (previous && previous[0].wins === row.wins && previous[0].tiedWins === row.tiedWins)
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
