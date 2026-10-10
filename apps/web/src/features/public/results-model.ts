import { drawProgress, placements, type Draw } from '@judo/engine/draw';
export function finalCategoryPlaces(
  draw: Draw,
  contests: { key: string; status: string; winnerEntryId?: string | null }[],
) {
  const winners = Object.fromEntries(
    contests
      .filter((c) => c.status === 'CONFIRMED' && c.winnerEntryId)
      .map((c) => [c.key, c.winnerEntryId!]),
  );
  return placements(draw, winners);
}

export function categoryProgress(
  draw: Draw,
  contests: { key: string; status: string; winnerEntryId?: string | null }[],
) {
  return drawProgress(
    draw,
    Object.fromEntries(
      contests
        .filter((c) => c.status === 'CONFIRMED' && c.winnerEntryId)
        .map((c) => [c.key, c.winnerEntryId!]),
    ),
  );
}
