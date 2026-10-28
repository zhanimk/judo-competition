import type { BracketNode, Draw } from '@judo/engine/draw';
export { bracketNodes, type BracketNode } from '@judo/engine/draw';
export const CARD_WIDTH = 272;
export const CARD_HEIGHT = 116;
export const COLUMN_GAP = 64;
export const ROW_PITCH = 140;
export const HEADER_HEIGHT = 56;
export type BracketView = {
  startRound: number;
  endRound: number;
  startLeaf: number;
  leafCount: number;
};
/** Medal branches retain the engine's sources, including direct bronze routes for 6/7. */
export function layoutMedalBracket(draw: Draw, offsetY: number) {
  const bronzes = draw.matches.filter((m) => m.stage === 'BRONZE');
  const cards: (BracketNode & { x: number; y: number })[] = [];
  const lines: { from: string; to: string; path: string }[] = [];
  bronzes.forEach((bronze, index) => {
    const y = offsetY + HEADER_HEIGHT + index * (ROW_PITCH + 40);
    const repechage = draw.matches.find(
      (m) =>
        m.stage === 'REPECHAGE' &&
        [bronze.white, bronze.blue].some((slot) => 'winnerOf' in slot && slot.winnerOf === m.id),
    );
    const node = (match: typeof bronze, x: number) => ({
      id: match.id,
      matchId: match.id,
      round: match.round,
      index,
      leafStart: 0,
      white: match.white,
      blue: match.blue,
      x,
      y,
    });
    cards.push(node(bronze, CARD_WIDTH + COLUMN_GAP));
    if (repechage) {
      cards.push(node(repechage, 0));
      const side = 'winnerOf' in bronze.white && bronze.white.winnerOf === repechage.id ? 0 : 1;
      const endY = y + 22 + side * 34 + 17;
      lines.push({
        from: repechage.id,
        to: bronze.id,
        path: `M ${CARD_WIDTH} ${y + CARD_HEIGHT / 2} H ${CARD_WIDTH + COLUMN_GAP / 2} V ${endY} H ${CARD_WIDTH + COLUMN_GAP}`,
      });
    }
  });
  return {
    cards,
    lines,
    height: bronzes.length ? HEADER_HEIGHT + bronzes.length * (ROW_PITCH + 40) : 0,
    width: 2 * CARD_WIDTH + COLUMN_GAP,
  };
}
export function layoutBracket(nodes: BracketNode[], view: BracketView) {
  const selected = nodes.filter(
    (n) =>
      n.round >= view.startRound &&
      n.round <= view.endRound &&
      n.leafStart >= view.startLeaf &&
      n.leafStart < view.startLeaf + view.leafCount,
  );
  const cards = selected.map((n) => {
    const span = 2 ** (n.round - view.startRound);
    const localIndex = n.index - view.startLeaf / 2 ** n.round;
    return {
      ...n,
      x: (n.round - view.startRound) * (CARD_WIDTH + COLUMN_GAP),
      y: HEADER_HEIGHT + (localIndex + 0.5) * span * ROW_PITCH - CARD_HEIGHT / 2,
    };
  });
  const byId = new Map(cards.map((c) => [c.id, c]));
  const lines = cards.flatMap((c) => {
    if (c.round === view.endRound) return [];
    const parent = byId.get(`r${c.round + 1}-m${Math.floor(c.index / 2) + 1}`);
    if (!parent) return [];
    const x = c.x + CARD_WIDTH,
      y = c.y + CARD_HEIGHT / 2,
      endY = parent.y + CARD_HEIGHT / 2;
    return [
      {
        from: c.id,
        to: parent.id,
        path: `M ${x} ${y} H ${x + COLUMN_GAP / 2} V ${endY} H ${parent.x}`,
      },
    ];
  });
  return {
    cards,
    lines,
    width: (view.endRound - view.startRound + 1) * (CARD_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: HEADER_HEIGHT + (view.leafCount / 2 ** view.startRound) * ROW_PITCH,
  };
}
