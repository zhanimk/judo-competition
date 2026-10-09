ALTER TABLE "DrawRecord" ADD COLUMN "publishedAt" TIMESTAMP(3), ADD COLUMN "publicationRevision" INTEGER NOT NULL DEFAULT 0;
-- Preserve the visibility of already-published confirmed draws; new draws are private.
UPDATE "DrawRecord" d SET "publishedAt" = t."publishedAt" FROM "Category" c JOIN "Tournament" t ON t.id=c."tournamentId" WHERE d."categoryId"=c.id AND d.status='CONFIRMED' AND t."publishedAt" IS NOT NULL;
