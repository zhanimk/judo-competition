import { Prisma } from '@prisma/client';

/** Null-owner identities are never a shared catalogue of orphan tournaments. */
export const athleteScope = (
  tournamentId: string,
  ownerId: string | null,
): Prisma.AthleteWhereInput =>
  ownerId === null
    ? { ownerId: null, entries: { some: { category: { tournamentId } } } }
    : { ownerId };

export async function scopedAthleteIds(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  ownerId: string | null,
  ids: string[],
) {
  if (ids.length === 0) return new Set<string>();
  const athletes = await tx.athlete.findMany({
    where: { ...athleteScope(tournamentId, ownerId), id: { in: [...new Set(ids)] } },
    select: { id: true },
  });
  return new Set(athletes.map((athlete) => athlete.id));
}

/** Categories/draws are locked before shared identities, as in sporting commands. */
export async function lockIdentityDraws(tx: Prisma.TransactionClient, categoryIds: string[]) {
  if (categoryIds.length)
    await tx.$queryRaw`SELECT id FROM "DrawRecord" WHERE "categoryId" IN (${Prisma.join([...new Set(categoryIds)].sort())}) ORDER BY id FOR UPDATE`;
}

export async function lockAthleteIds(tx: Prisma.TransactionClient, athleteIds: string[]) {
  for (const id of [...new Set(athleteIds)].sort())
    await tx.$queryRaw`SELECT id FROM "Athlete" WHERE id=${id} FOR UPDATE`;
}

/** Filter in PostgreSQL before loading the bounded directory page. */
export async function searchAthleteIds(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  ownerId: string | null,
  words: string[],
  limit: number,
) {
  // Match JS NFKC/whitespace/Unicode lowering even on a C-locale database.
  const text = Prisma.sql`lower(regexp_replace(normalize(concat_ws(' ', e."lastName", e."firstName", e."birthYear"::text, e."club"), NFKC), U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]+', ' ', 'g') COLLATE pg_catalog."pg_unicode_fast")`;
  const search = words.length
    ? Prisma.join(
        words.map((word) => Prisma.sql`position(${word} in ${text}) > 0`),
        ' AND ',
      )
    : Prisma.sql`TRUE`;
  const authorized =
    ownerId === null
      ? Prisma.sql`c."tournamentId" = ${tournamentId}`
      : Prisma.sql`t."ownerId" = ${ownerId}`;
  const found = await tx.$queryRaw<{ id: string }[]>`
    SELECT a."id" FROM "Athlete" a
    WHERE a."ownerId" IS NOT DISTINCT FROM ${ownerId}
      AND EXISTS (
        SELECT 1 FROM "Entry" e
        JOIN "Category" c ON c."id" = e."categoryId"
        JOIN "Tournament" t ON t."id" = c."tournamentId"
        WHERE e."athleteId" = a."id" AND ${authorized} AND ${search}
      )
    ORDER BY a."createdAt" DESC, a."id" ASC LIMIT ${limit}`;
  return found.map((athlete) => athlete.id);
}

export type AthleteDisplay = {
  entryId: string;
  tournamentId: string;
  firstName: string;
  lastName: string;
  birthYear: number;
  gender: string;
  club: string;
};
export type AthleteDirectoryItem = {
  id: string;
  display: AthleteDisplay;
  activeEntry: { entryId: string; categoryId: string } | null;
};
