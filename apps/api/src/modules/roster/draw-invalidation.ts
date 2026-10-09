import type { Prisma } from '@prisma/client';

/** Caller holds tournament and affected category locks. Never overwrite a snapshot. */
export async function invalidatePreviewDraws(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  categoryIds: string[],
  actorId: string,
  cause: { type: string; commandId?: string },
) {
  const previews = await tx.drawRecord.findMany({
    where: { categoryId: { in: [...new Set(categoryIds)].sort() }, status: 'PREVIEW' },
    select: {
      id: true,
      categoryId: true,
      version: true,
      status: true,
      fingerprint: true,
      snapshot: true,
    },
    orderBy: { categoryId: 'asc' },
  });
  for (const draw of previews) {
    await tx.drawRecord.update({
      where: { id: draw.id },
      data: { status: 'STALE', version: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        actorId,
        tournamentId,
        entityId: draw.id,
        action: 'DRAW_INVALIDATED',
        payload: {
          cause,
          invalidatedDraws: [draw],
          before: { status: 'PREVIEW', version: draw.version },
          after: { status: 'STALE', version: draw.version + 1 },
        },
      },
    });
  }
  return previews.map((draw) => draw.categoryId);
}
