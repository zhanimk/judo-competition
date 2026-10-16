import type { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { compareScheduledBouts, drawProgress, resolveMatches, type Draw } from '@judo/engine/draw';
type ResultRow = {
  key: string;
  status: string;
  winnerEntryId: string | null;
  resultReason?: string | null;
};
function winners(rows: readonly ResultRow[]) {
  if (
    rows.some(
      (row) =>
        row.status === 'CONFIRMED' && !row.winnerEntryId && row.resultReason !== 'NO_CONTEST',
    )
  )
    throw new ConflictException('DRAW_RESULTS_INVALID');
  return Object.fromEntries(
    rows
      .filter((row) => row.status === 'CONFIRMED' && row.winnerEntryId)
      .map((row) => [row.key, row.winnerEntryId!]),
  );
}
export async function readyQueue(db: Prisma.TransactionClient, tatamiId: string) {
  const rows = await db.contest.findMany({
    where: { tatamiId, status: 'READY' },
    include: {
      draw: {
        select: {
          categoryId: true,
          category: {
            include: {
              entries: {
                where: { archivedAt: null },
                select: { id: true, firstName: true, lastName: true, club: true },
              },
            },
          },
        },
      },
    },
  });
  if (!rows.length) return rows;
  // A 128-athlete RR has 8,128 matches, all potentially READY. Fetch its
  // snapshot/results once, rather than duplicating them for each ready pair.
  const draws = await db.drawRecord.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.drawId))] }, status: 'CONFIRMED' },
    select: {
      id: true,
      snapshot: true,
      contests: { select: { key: true, status: true, winnerEntryId: true, resultReason: true } },
    },
  });
  const drawById = new Map(draws.map((draw) => [draw.id, draw]));
  const resolved = new Map<string, Map<string, ReturnType<typeof resolveMatches>[number]>>();
  const eligible = rows.filter((row) => {
    if (!resolved.has(row.drawId)) {
      const draw = drawById.get(row.drawId);
      if (!draw) throw new ConflictException('DRAW_NOT_CONFIRMED');
      resolved.set(
        row.drawId,
        new Map(
          resolveMatches(draw.snapshot as unknown as Draw, winners(draw.contests)).map((match) => [
            match.id,
            match,
          ]),
        ),
      );
    }
    const match = resolved.get(row.drawId)!.get(row.key);
    return !!(
      match?.ready &&
      match.whiteEntryId === row.whiteEntryId &&
      match.blueEntryId === row.blueEntryId
    );
  });
  return eligible.sort((a, b) =>
    compareScheduledBouts(
      { ...a, ...a.draw.category, categoryId: a.draw.categoryId },
      { ...b, ...b.draw.category, categoryId: b.draw.categoryId },
    ),
  );
}
export async function unfinishedRound(db: Prisma.TransactionClient, tatamiId: string) {
  const earliest = await db.contest.aggregate({
    where: {
      status: { not: 'CONFIRMED' },
      OR: [{ tatamiId }, { draw: { category: { homeTatamiId: tatamiId } } }],
    },
    _min: { round: true },
  });
  const categories = await db.category.findMany({
    // A moved individual bout does not move its category or later virtual
    // reviews. Only the pinned home mat owns a missing tie-break circle.
    where: { homeTatamiId: tatamiId },
    include: {
      draw: {
        include: {
          contests: {
            select: { key: true, status: true, winnerEntryId: true, resultReason: true },
          },
        },
      },
    },
  });
  const barriers = categories.flatMap((category) => {
    if (!category.draw || category.draw.status !== 'CONFIRMED') return [];
    const progress = drawProgress(
      category.draw.snapshot as unknown as Draw,
      winners(category.draw.contests),
    );
    return progress.roundBarrier === null ? [] : [progress.roundBarrier];
  });
  return earliest._min.round === null && !barriers.length
    ? null
    : Math.min(...barriers, ...(earliest._min.round === null ? [] : [earliest._min.round]));
}
export async function tatamiQueue(db: Prisma.TransactionClient, tatamiId: string) {
  const rows = await readyQueue(db, tatamiId);
  const round = await unfinishedRound(db, tatamiId);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    revision: r.revision,
    round: r.round,
    status: r.status,
    queueOrder: r.queueOrder,
    blockedByRound: round !== null && r.round > round,
    category: r.draw.category.name,
    durationSeconds: r.draw.category.durationSeconds,
    white: r.draw.category.entries.find((e) => e.id === r.whiteEntryId) ?? null,
    blue: r.draw.category.entries.find((e) => e.id === r.blueEntryId) ?? null,
  }));
}
