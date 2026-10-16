import { createHash } from 'node:crypto';
import { withdrawEntry, resolveMatches, poolStandings, type Draw } from '@judo/engine/draw';
import type { Contest, DrawRecord } from '@prisma/client';
import type { MatchState } from '@judo/engine/match';
import { confirmedDrawWinners, unstartedContest } from './draw-propagation.js';
import { hasOfflineOwnership } from '../matches/offline-ownership.js';

export function withdrawalPlan(
  record: DrawRecord,
  rows: Contest[],
  entryId: string,
  actorId: string,
) {
  const before = record.snapshot as unknown as Draw;
  const winners = confirmedDrawWinners(rows);
  const startedKnockout =
    before.algorithm === 'custom-pools-knockout-v1' &&
    rows.some(
      (row) => before.matches.some((m) => m.id === row.key && !m.pool) && !unstartedContest(row),
    );
  const source = startedKnockout
    ? {
        ...before,
        frozenPoolWithdrawnIds: before.frozenPoolOrder
          ? before.frozenPoolWithdrawnIds
          : [...(before.withdrawnEntryIds ?? [])],
        frozenPoolOrder:
          before.frozenPoolOrder ??
          Object.fromEntries(
            (before.pools ?? []).map((p) => {
              const standings = poolStandings(before, winners, p.id);
              if (!standings) throw new Error('WITHDRAWAL_QUALIFICATION_UNRESOLVED');
              return [p.id, standings.map((r) => r.entryId)];
            }),
          ),
      }
    : before;
  const planned = withdrawEntry(source, winners, entryId);
  const resolved = new Map(resolveMatches(planned.snapshot, planned.winners).map((m) => [m.id, m]));
  const automatic = new Set(planned.walkovers.map((m) => m.key));
  const blocked = rows.some((row) => {
    if (hasOfflineOwnership(row)) return true;
    const state = row.state as unknown as MatchState | null;
    if (automatic.has(row.key)) return state?.status === 'RUNNING' || !!state?.hold;
    const next = resolved.get(row.key);
    return (
      next &&
      (row.whiteEntryId !== (next.whiteEntryId ?? null) ||
        row.blueEntryId !== (next.blueEntryId ?? null)) &&
      !unstartedContest(row)
    );
  });
  return {
    entryId,
    expectedVersion: record.version,
    impactToken: createHash('sha256')
      .update(
        JSON.stringify({
          actorId,
          entryId,
          record,
          rows: [...rows].sort((a, b) => a.key.localeCompare(b.key)),
        }),
      )
      .digest('hex'),
    walkovers: planned.walkovers,
    blocked,
    // Propagation recalculates automatic outcomes from the original saved results.
    snapshot: { ...source, withdrawnEntryIds: planned.snapshot.withdrawnEntryIds },
  };
}
