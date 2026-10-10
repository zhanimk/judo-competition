import { drawProgress, resolveMatches, type Draw, type Slot } from '@judo/engine/draw';

type ContestResult = { key: string; status: string; winnerEntryId?: string | null };

/** Print the same confirmed dependencies and final places as the sporting engine. */
export function protocolDrawView(draw: Draw, status: string, contests: readonly ContestResult[]) {
  const winners = Object.fromEntries(
    status === 'CONFIRMED'
      ? contests
          .filter((contest) => contest.status === 'CONFIRMED' && contest.winnerEntryId)
          .map((contest) => [contest.key, contest.winnerEntryId!])
      : [],
  );
  const progress = drawProgress(draw, winners);
  return {
    matches: resolveMatches(draw, winners).map((match) => ({
      ...match,
      white: match.whiteEntryId ? ({ entryId: match.whiteEntryId } satisfies Slot) : match.white,
      blue: match.blueEntryId ? ({ entryId: match.blueEntryId } satisfies Slot) : match.blue,
    })),
    places: status === 'CONFIRMED' && progress.complete ? progress.places : null,
    pendingReviews: status === 'CONFIRMED' ? progress.pendingReviews : [],
  };
}
