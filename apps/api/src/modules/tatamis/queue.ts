import type { Prisma } from '@prisma/client';
import { compareScheduledBouts } from '@judo/engine/draw';
export async function readyQueue(db: Prisma.TransactionClient, tatamiId: string) {
  const rows = await db.contest.findMany({
    where: { tatamiId, status: 'READY' },
    include: {
      draw: {
        include: {
          category: {
            include: {
              entries: { select: { id: true, firstName: true, lastName: true, club: true } },
            },
          },
        },
      },
    },
  });
  return rows.sort((a, b) =>
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
  return earliest._min.round;
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
