import { ConflictException } from '@nestjs/common';
import type { Contest, Prisma } from '@prisma/client';

type AthleteContest = Pick<Contest, 'id' | 'whiteEntryId' | 'blueEntryId' | 'tatamiId'> & {
  draw: { categoryId: string };
};
export type ContestAthletes = { athleteIds: string[]; entryIds: string[] };

/**
 * Call after tournament, tatami, contest and command-ID locks. Identity binding
 * is immutable once a contest references an Entry. Shared Athlete locks order
 * reservation/release across tournaments without locking their foreign rows.
 */
export async function lockContestAthletes(
  tx: Prisma.TransactionClient,
  row: AthleteContest,
  options: { requirePair?: boolean } = {},
): Promise<ContestAthletes> {
  const requirePair = options.requirePair !== false;
  if (
    requirePair &&
    (!row.whiteEntryId || !row.blueEntryId || row.whiteEntryId === row.blueEntryId)
  )
    throw new ConflictException('MATCH_NOT_READY');
  const entryIds = [row.whiteEntryId, row.blueEntryId].filter((id): id is string => !!id);
  const entries = await tx.entry.findMany({
    where: { id: { in: entryIds } },
    select: { id: true, categoryId: true, athleteId: true, archivedAt: true },
  });
  if (
    requirePair &&
    (entries.length !== 2 ||
      entries.some(
        (entry) => !entry.athleteId || entry.archivedAt || entry.categoryId !== row.draw.categoryId,
      ))
  )
    throw new ConflictException('MATCH_NOT_READY');
  // Administrative release/reset can repair an incomplete old contest while
  // still locking every known participant. Admission always requires two.
  const athleteIds = [
    ...new Set(entries.flatMap((entry) => (entry.athleteId ? [entry.athleteId] : []))),
  ].sort();
  if (requirePair && athleteIds.length !== 2) throw new ConflictException('MATCH_NOT_READY');
  for (const id of athleteIds) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Athlete" WHERE id=${id} FOR UPDATE
    `;
    if (locked.length !== 1) throw new ConflictException('MATCH_NOT_READY');
  }
  // Historical aliases remain relevant to rest/busy even if a roster row was
  // archived. Never replace original Entry IDs in draws, contests or results.
  const aliases = await tx.entry.findMany({
    where: { athleteId: { in: athleteIds } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return { athleteIds, entryIds: aliases.map((entry) => entry.id) };
}

/** Caller holds the shared Athlete locks until the command and audit commit. */
export async function requireAvailableAthletes(
  tx: Prisma.TransactionClient,
  row: AthleteContest,
  athletes: ContestAthletes,
  options: { tatamiId?: string | null; restMs?: number } = {},
) {
  const participants = [
    { whiteEntryId: { in: athletes.entryIds } },
    { blueEntryId: { in: athletes.entryIds } },
  ];
  const tatamiId = options.tatamiId === undefined ? row.tatamiId : options.tatamiId;
  if (
    await tx.contest.findFirst({
      where: {
        id: { not: row.id },
        status: 'ACTIVE',
        OR: [...(tatamiId ? [{ tatamiId }] : []), ...participants],
      },
      select: { id: true },
    })
  )
    throw new ConflictException('TATAMI_OR_ATHLETE_BUSY');
  if (options.restMs === undefined) return;
  if (!Number.isFinite(options.restMs) || options.restMs < 0)
    throw new ConflictException('MATCH_NOT_READY');
  if (
    await tx.contest.findFirst({
      where: {
        id: { not: row.id },
        status: 'CONFIRMED',
        AND: [
          { OR: participants },
          {
            OR: [
              { endedAt: { gt: new Date(Date.now() - options.restMs) } },
              {
                endedAt: null,
                confirmedAt: { gt: new Date(Date.now() - options.restMs) },
              },
            ],
          },
        ],
      },
      select: { id: true },
    })
  )
    throw new ConflictException('REST_REQUIRED');
}
