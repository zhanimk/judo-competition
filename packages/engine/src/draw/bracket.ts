import type { Draw, Slot } from './index.ts';
export type BracketNode = {
  id: string;
  round: number;
  index: number;
  leafStart: number;
  white: Slot | null;
  blue: Slot | null;
  matchId: string | null;
};
/** Restore visual BYE nodes without creating contests or fictional results. */
export function bracketNodes(draw: Draw): BracketNode[] {
  const mixed = draw.algorithm === 'custom-pools-knockout-v1';
  const main = draw.matches.filter((m) => m.stage === 'MAIN');
  const firstRound = main[0]?.round ?? 1;
  let sources: (Slot | null)[] = mixed
    ? main.filter((m) => m.round === firstRound).flatMap((m) => [m.white, m.blue])
    : draw.positions.map((e) => (e ? { entryId: e.id } : null));
  const matches = new Map(
    (mixed ? main : draw.matches).map((m) => [
      mixed
        ? `r${m.round - firstRound + 1}-m${main.filter((x) => x.round === m.round).indexOf(m) + 1}`
        : m.id,
      m,
    ]),
  );
  const nodes: BracketNode[] = [];
  for (let round = 1; sources.length > 1; round++) {
    const next: (Slot | null)[] = [];
    for (let index = 0; index < sources.length / 2; index++) {
      const id = `r${round}-m${index + 1}`;
      const white = sources[index * 2],
        blue = sources[index * 2 + 1];
      const match = matches.get(id);
      nodes.push({
        id,
        round,
        index,
        leafStart: index * 2 ** round,
        white,
        blue,
        matchId: match?.id ?? null,
      });
      next.push(match ? { winnerOf: match.id } : (white ?? blue));
    }
    sources = next;
  }
  return nodes;
}
