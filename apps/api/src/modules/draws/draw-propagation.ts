import { ConflictException } from '@nestjs/common';
import type { Contest, DrawRecord, Prisma } from '@prisma/client';
import { appendRematches, drawProgress, resolveMatches, type Draw } from '@judo/engine/draw';
import { hasOfflineOwnership } from '../matches/offline-ownership.js';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export function confirmedDrawWinners(rows: readonly Contest[]) {
  if (rows.some((row) => row.status === 'CONFIRMED' && !row.winnerEntryId))
    throw new ConflictException('DRAW_RESULTS_INVALID');
  return Object.fromEntries(
    rows.filter((row) => row.status === 'CONFIRMED').map((row) => [row.key, row.winnerEntryId!]),
  );
}

export function unstartedContest(row: Contest) {
  return (
    ['READY', 'WAITING'].includes(row.status) &&
    row.state === null &&
    row.winnerEntryId === null &&
    row.confirmedAt === null &&
    row.endedAt === null &&
    !hasOfflineOwnership(row)
  );
}

/** Caller holds Tournament/all Tatamis/Session/Category/all draw Contest locks.
 * Newly appended rounds and changed unstarted KO circles are one atomic update. */
export async function propagateDraw(
  tx: Prisma.TransactionClient,
  record: DrawRecord,
  homeTatamiId: string | null,
  actorId: string,
  tournamentId: string,
  approvedSnapshot?: Draw,
) {
  const before = record.snapshot as unknown as Draw;
  const all = await tx.contest.findMany({ where: { drawId: record.id } });
  const rowsByKey = new Map(all.map((row) => [row.key, row]));
  const winners = confirmedDrawWinners(all);
  const snapshot = appendRematches(approvedSnapshot ?? before, winners);
  const beforeKeys = new Set(before.matches.map((match) => match.id));
  if (
    all.length !== beforeKeys.size ||
    all.some((row) => !beforeKeys.has(row.key)) ||
    new Set(all.map((row) => row.key)).size !== all.length
  )
    throw new ConflictException('DRAW_CONTESTS_INVALID');
  const resolved = resolveMatches(snapshot, winners);
  const added = resolved.filter((match) => !beforeKeys.has(match.id));
  const changedContestIds: string[] = [];
  const addedContestIds: string[] = [];
  for (const match of resolved) {
    const row = rowsByKey.get(match.id);
    if (!row) continue;
    const pairChanged =
      row.whiteEntryId !== (match.whiteEntryId ?? null) ||
      row.blueEntryId !== (match.blueEntryId ?? null);
    const roundChanged = row.round !== match.round;
    const availabilityChanged =
      (row.status === 'WAITING' && match.ready) || (row.status === 'READY' && !match.ready);
    if (!pairChanged && !roundChanged && !availabilityChanged) continue;
    if (!unstartedContest(row)) throw new ConflictException('TIEBREAK_DEPENDENCY_STARTED');
    let queueOrder = row.queueOrder;
    let tatamiId = row.tatamiId;
    if (match.ready && !tatamiId && homeTatamiId) {
      const last = await tx.contest.aggregate({
        where: { tatamiId: homeTatamiId },
        _max: { queueOrder: true },
      });
      tatamiId = homeTatamiId;
      queueOrder = (last._max.queueOrder ?? 0) + 1;
    }
    await tx.contest.update({
      where: { id: row.id },
      data: {
        round: match.round,
        whiteEntryId: match.whiteEntryId ?? null,
        blueEntryId: match.blueEntryId ?? null,
        status: match.ready ? 'READY' : 'WAITING',
        tatamiId,
        queueOrder,
        revision: { increment: 1 },
      },
    });
    changedContestIds.push(row.id);
  }
  for (const match of added) {
    const tatamiId = match.ready ? homeTatamiId : null;
    const last = tatamiId
      ? await tx.contest.aggregate({ where: { tatamiId }, _max: { queueOrder: true } })
      : null;
    const row = await tx.contest.create({
      data: {
        drawId: record.id,
        key: match.id,
        round: match.round,
        whiteEntryId: match.whiteEntryId ?? null,
        blueEntryId: match.blueEntryId ?? null,
        status: match.ready ? 'READY' : 'WAITING',
        tatamiId,
        queueOrder: tatamiId ? (last!._max.queueOrder ?? 0) + 1 : null,
      },
    });
    addedContestIds.push(row.id);
  }
  let draw = record;
  if (snapshot !== before) {
    draw = await tx.drawRecord.update({
      where: { id: record.id },
      data: { snapshot: json(snapshot), version: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        actorId,
        tournamentId,
        entityId: record.id,
        action: approvedSnapshot ? 'TIEBREAK_APPROVED' : 'TIEBREAK_CREATED',
        payload: json({
          beforeVersion: record.version,
          version: draw.version,
          matches: added,
          changedContestIds,
        }),
      },
    });
  }
  return { draw, progress: drawProgress(snapshot, winners), addedContestIds, changedContestIds };
}

/** Missing/manual-review stages have no physical Contest row. A row count alone
 * cannot finish the tournament. Caller holds its Tournament lock. */
export async function tournamentComplete(tx: Prisma.TransactionClient, tournamentId: string) {
  const tournament = await tx.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament || tournament.status !== 'RUNNING') return false;
  const categories = await tx.category.findMany({
    where: { tournamentId, entries: { some: { archivedAt: null } } },
    include: { draw: { include: { contests: true } }, entries: { where: { archivedAt: null } } },
  });
  if (!categories.length) return false;
  return categories.every((category) => {
    const record = category.draw;
    if (!record || record.status !== 'CONFIRMED' || category.entries.length < 2) return false;
    const snapshot = record.snapshot as unknown as Draw;
    const members = snapshot.positions.flatMap((entry) => (entry ? [entry.id] : []));
    const memberIds = new Set(members),
      matchIds = new Set(snapshot.matches.map((match) => match.id));
    if (
      members.length !== category.entries.length ||
      memberIds.size !== members.length ||
      category.entries.some((entry) => !memberIds.has(entry.id)) ||
      record.contests.length !== snapshot.matches.length ||
      record.contests.some(
        (row) => row.status !== 'CONFIRMED' || hasOfflineOwnership(row) || !row.winnerEntryId,
      ) ||
      new Set(record.contests.map((row) => row.key)).size !== snapshot.matches.length ||
      matchIds.size !== snapshot.matches.length ||
      record.contests.some((row) => !matchIds.has(row.key))
    )
      return false;
    try {
      return drawProgress(snapshot, confirmedDrawWinners(record.contests)).complete;
    } catch {
      return false;
    }
  });
}
