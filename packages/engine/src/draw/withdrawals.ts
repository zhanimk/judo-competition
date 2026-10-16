import { appendRematches, isWinsOnlyTiePolicy, resolveMatches, type Draw } from './index.ts';

/** Historical winners are immutable. Only unconfirmed pairs get a walkover. */
export function withdrawalProgress(draw: Draw, confirmed: Readonly<Record<string, string>>) {
  const withdrawn = new Set(draw.withdrawnEntryIds ?? []);
  const entrants = new Set(draw.positions.flatMap((e) => (e ? [e.id] : [])));
  if (
    withdrawn.size !== (draw.withdrawnEntryIds?.length ?? 0) ||
    [...withdrawn].some((id) => !entrants.has(id))
  )
    throw new Error('WITHDRAWAL_ENTRIES_INVALID');
  let snapshot = draw;
  const winners = { ...confirmed };
  const walkovers: {
    key: string;
    whiteEntryId?: string;
    blueEntryId?: string;
    winnerEntryId: string | null;
  }[] = [];
  for (;;) {
    snapshot = appendRematches(snapshot, winners);
    const ready = resolveMatches(snapshot, winners).filter(
      (m) =>
        !m.winnerEntryId &&
        !m.voided &&
        (m.whiteEntryId !== undefined || m.whiteEmpty) &&
        (m.blueEntryId !== undefined || m.blueEmpty) &&
        (m.whiteEmpty ||
          m.blueEmpty ||
          withdrawn.has(m.whiteEntryId!) ||
          withdrawn.has(m.blueEntryId!)),
    );
    if (!ready.length) return { snapshot, winners, walkovers };
    for (const m of ready) {
      const whiteEligible = m.whiteEntryId && !withdrawn.has(m.whiteEntryId);
      const blueEligible = m.blueEntryId && !withdrawn.has(m.blueEntryId);
      const winnerEntryId = whiteEligible ? m.whiteEntryId! : blueEligible ? m.blueEntryId! : null;
      if (winnerEntryId) winners[m.id] = winnerEntryId;
      else snapshot = { ...snapshot, voidMatches: [...(snapshot.voidMatches ?? []), m.id] };
      walkovers.push({
        key: m.id,
        whiteEntryId: m.whiteEntryId,
        blueEntryId: m.blueEntryId,
        winnerEntryId,
      });
    }
  }
}

export function withdrawEntry(
  draw: Draw,
  winners: Readonly<Record<string, string>>,
  entryId: string,
) {
  if (!isWinsOnlyTiePolicy(draw)) throw new Error('WITHDRAWAL_V4_REQUIRED');
  if (!draw.positions.some((e) => e?.id === entryId)) throw new Error('WITHDRAWAL_ENTRY_UNKNOWN');
  if (draw.withdrawnEntryIds?.includes(entryId)) throw new Error('ENTRY_ALREADY_WITHDRAWN');
  return withdrawalProgress(
    { ...draw, withdrawnEntryIds: [...(draw.withdrawnEntryIds ?? []), entryId] },
    winners,
  );
}
