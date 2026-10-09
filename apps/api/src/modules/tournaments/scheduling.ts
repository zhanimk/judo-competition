import { ConflictException } from '@nestjs/common';
import { balanceCategoryLoads } from '@judo/engine/draw';
import type { Prisma } from '@prisma/client';
/** Caller holds the tournament lock. Only ready, unassigned contests are queued. */
export async function scheduleCategories(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  actorId: string,
) {
  const t = await tx.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
    include: {
      tatamis: { orderBy: { number: 'asc' } },
      categories: { orderBy: { name: 'asc' }, include: { draw: { include: { contests: true } } } },
    },
  });
  if (!t.categories.length || t.categories.some((c) => c.draw?.status !== 'CONFIRMED'))
    throw new ConflictException('ALL_DRAWS_REQUIRED');
  for (const mat of [...t.tatamis].sort((a, b) => a.id.localeCompare(b.id)))
    await tx.$queryRaw`SELECT id FROM "Tatami" WHERE id=${mat.id} FOR UPDATE`;
  const plan = balanceCategoryLoads(
    t.categories.map((c) => ({
      id: c.id,
      tatamiId: c.homeTatamiId,
      matches: c.draw!.contests.filter((m) => m.status !== 'CONFIRMED').length,
    })),
    t.tatamis.map((m) => m.id),
  );
  const queues = new Map<string, number>();
  for (const mat of t.tatamis) {
    const max = await tx.contest.aggregate({
      where: { tatamiId: mat.id },
      _max: { queueOrder: true },
    });
    queues.set(mat.id, max._max.queueOrder ?? 0);
  }
  const pinned: { categoryId: string; tatamiId: string }[] = [];
  const queued: string[] = [];
  for (const c of t.categories) {
    const tatamiId = plan.assignments.find((a) => a.categoryId === c.id)!.tatamiId;
    if (!c.homeTatamiId) {
      await tx.category.update({ where: { id: c.id }, data: { homeTatamiId: tatamiId } });
      pinned.push({ categoryId: c.id, tatamiId });
    }
    const rows = c
      .draw!.contests.filter((m) => m.status === 'READY' && !m.tatamiId)
      .sort((a, b) => a.round - b.round || a.key.localeCompare(b.key, 'en', { numeric: true }));
    for (const row of rows) {
      const next = queues.get(tatamiId)! + 1;
      queues.set(tatamiId, next);
      await tx.contest.update({
        where: { id: row.id },
        data: { tatamiId, queueOrder: next, revision: { increment: 1 } },
      });
      queued.push(row.id);
    }
  }
  if (pinned.length || queued.length)
    await tx.auditEvent.create({
      data: {
        actorId,
        tournamentId,
        entityId: tournamentId,
        action: 'CATEGORIES_SCHEDULED',
        payload: { pinned, queued, loads: plan.loads },
      },
    });
  return { ...plan, queued: queued.length };
}
