-- Each existing admission gets a distinct identity. Names are never merge keys.
CREATE TABLE "Athlete" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Athlete_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Entry" ADD COLUMN "athleteId" TEXT;

INSERT INTO "Athlete" ("id", "ownerId", "createdAt")
SELECT e."id", t."ownerId", e."createdAt"
FROM "Entry" e
JOIN "Category" c ON c."id" = e."categoryId"
JOIN "Tournament" t ON t."id" = c."tournamentId";

UPDATE "Entry" SET "athleteId" = "id";
ALTER TABLE "Entry" ALTER COLUMN "athleteId" SET NOT NULL;

CREATE INDEX "Athlete_ownerId_idx" ON "Athlete"("ownerId");
CREATE INDEX "Entry_athleteId_idx" ON "Entry"("athleteId");

ALTER TABLE "Athlete" ADD CONSTRAINT "Athlete_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_athleteId_fkey"
    FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
