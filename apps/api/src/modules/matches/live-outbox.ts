import type { Prisma } from '@prisma/client';

export type DurableLiveNotice = {
  tournamentId: string;
  tatamiId?: string;
  kind: 'state' | 'result' | 'queue' | 'roster' | 'protocol' | 'access';
};

/** The caller holds the Tournament lock. Commit order is therefore cursor order
 * within a tournament; notifications carry no private sporting or session data. */
export async function enqueueLive(tx: Prisma.TransactionClient, notice: DurableLiveNotice) {
  await tx.liveOutbox.create({
    data: {
      tournamentId: notice.tournamentId,
      tatamiId: notice.tatamiId ?? null,
      kind: notice.kind,
    },
  });
}
