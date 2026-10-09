import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { MatchState } from '@judo/engine/match';

/** Call after checking an exact saved receipt, within the command transaction. */
export async function assertUnusedCommandIds(
  tx: Prisma.TransactionClient,
  ids: string[],
  state: MatchState | null,
) {
  if (new Set(ids).size !== ids.length) throw new ConflictException('COMMAND_ID_REUSED');
  const reused = await tx.matchEvent.findFirst({
    where: {
      OR: [
        { id: { in: ids } },
        // Pre-upgrade packets did not store separate event receipts. Check
        // envelope IDs and online/admin commands too, across all contests.
        {
          type: { in: ['OFFLINE_SYNC', 'OFFLINE_RELEASE'] },
          OR: ids.map((eventId) => ({
            payload: { path: ['events'], array_contains: [{ id: eventId }] },
          })),
        },
      ],
    },
    select: { id: true },
  });
  if (reused || state?.awards.some((award) => ids.includes(award.id)))
    throw new ConflictException('COMMAND_ID_REUSED');
}
