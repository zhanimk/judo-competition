import { ConflictException } from '@nestjs/common';
import { resolveMatches, type Draw } from '@judo/engine/draw';
import { categoryResults, type ProtocolCategory } from './protocol-model.js';

export type TeamReadinessReason =
  | 'DRAW_NOT_CONFIRMED'
  | 'OFFLINE_OWNED'
  | 'MATCHES_NOT_CONFIRMED'
  | 'RESULTS_INCONSISTENT'
  | 'RESULTS_UNRESOLVED';

/** Inspect only the immutable database snapshot used to render the document. */
export function teamReadiness(category: ProtocolCategory): TeamReadinessReason | null {
  const record = category.draw;
  if (!record || record.status !== 'CONFIRMED') return 'DRAW_NOT_CONFIRMED';
  if (
    record.contests.some(
      (contest) =>
        contest.offlineSessionId ||
        contest.offlineActorId ||
        contest.offlineControlGeneration != null,
    )
  )
    return 'OFFLINE_OWNED';
  try {
    const draw = record.snapshot as unknown as Draw;
    if (!Array.isArray(draw.matches) || !draw.matches.length || !Array.isArray(draw.positions))
      return 'RESULTS_INCONSISTENT';
    const matchIds = new Set(draw.matches.map((match) => match.id));
    const contestIds = new Set(record.contests.map((contest) => contest.key));
    const entryIds = new Set(category.entries.map((entry) => entry.id));
    const positionIds = draw.positions.flatMap((entry) => (entry ? [entry.id] : []));
    if (
      matchIds.size !== draw.matches.length ||
      contestIds.size !== record.contests.length ||
      matchIds.size !== contestIds.size ||
      [...contestIds].some((id) => !matchIds.has(id)) ||
      entryIds.size < 2 ||
      entryIds.size !== category.entries.length ||
      positionIds.length !== entryIds.size ||
      new Set(positionIds).size !== positionIds.length ||
      positionIds.some((id) => !entryIds.has(id))
    )
      return 'RESULTS_INCONSISTENT';
    if (record.contests.some((contest) => contest.status !== 'CONFIRMED' || !contest.winnerEntryId))
      return 'MATCHES_NOT_CONFIRMED';
    const results = categoryResults(category)!;
    const rows = resolveMatches(draw, results.winners);
    if (
      rows.some((match) => {
        const contest = record.contests.find((contest) => contest.key === match.id)!;
        return (
          !match.winnerEntryId ||
          !match.whiteEntryId ||
          !match.blueEntryId ||
          match.whiteEntryId === match.blueEntryId ||
          !entryIds.has(match.whiteEntryId) ||
          !entryIds.has(match.blueEntryId) ||
          contest.whiteEntryId !== match.whiteEntryId ||
          contest.blueEntryId !== match.blueEntryId
        );
      })
    )
      return 'RESULTS_INCONSISTENT';
    if (!results.places?.length) return 'RESULTS_UNRESOLVED';
    if (
      results.places.some((place) => !entryIds.has(place.entryId)) ||
      new Set(results.places.map((place) => place.entryId)).size !== results.places.length
    )
      return 'RESULTS_INCONSISTENT';
    return null;
  } catch {
    // Corrupt winners, missing sporting dependencies and malformed stored draws
    // must never produce an apparently final medal document.
    return 'RESULTS_INCONSISTENT';
  }
}

export function requireTeamResults(categories: readonly ProtocolCategory[]) {
  const pending = categories.flatMap((category) => {
    const reason = teamReadiness(category);
    return reason ? [{ id: category.id, name: category.name, reason }] : [];
  });
  if (pending.length)
    throw new ConflictException({ message: 'TEAMS_NOT_READY', categories: pending });
}
