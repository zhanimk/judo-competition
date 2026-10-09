import type { BracketNode } from '@judo/engine/draw';
export { bracketNodes, type BracketNode } from '@judo/engine/draw';
export const CARD_WIDTH = 272;
export const CARD_HEIGHT = 164;
export const COLUMN_GAP = 64;
export const ROW_PITCH = 196;
export const HEADER_HEIGHT = 56;
export type BracketView = {
  startRound: number;
  endRound: number;
  startLeaf: number;
  leafCount: number;
};
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
