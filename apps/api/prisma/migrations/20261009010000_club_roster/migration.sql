-- Add a tournament directory without altering historical entry text or draw data.
-- PG_UNICODE_FAST uses full Unicode lower-case mapping independent of LC_CTYPE.
-- Fail before ALTER on unsupported profiles instead of splitting legacy clubs.
DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 180000
    OR current_setting('server_encoding') <> 'UTF8'
    OR to_regcollation('pg_catalog.pg_unicode_fast') IS NULL THEN
    RAISE EXCEPTION 'ROSTER_MIGRATION_REQUIRES_POSTGRESQL_18_UTF8'
      USING DETAIL = 'PostgreSQL 18+ with UTF8 and pg_catalog.pg_unicode_fast is required for Unicode club normalization.';
  END IF;
END;
$$;

ALTER TABLE "Tournament" ADD COLUMN "rosterRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Entry" ADD COLUMN "clubId" TEXT;
ALTER TABLE "Entry" ADD COLUMN "gender" TEXT;

CREATE TABLE "Club" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Club_tournamentId_normalizedName_key"
  ON "Club"("tournamentId", "normalizedName");
ALTER TABLE "Club" ADD CONSTRAINT "Club_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match ECMAScript whitespace explicitly (including BOM); POSIX whitespace
-- differs by database locale and can split legacy clubs during directory lookup.
WITH names AS (
  SELECT c."tournamentId", e."id",
    trim(regexp_replace(normalize(e."club", NFKC), U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g')) AS name
  FROM "Entry" e JOIN "Category" c ON c."id" = e."categoryId"
), grouped AS (
  SELECT DISTINCT ON ("tournamentId", lower(name COLLATE pg_catalog."pg_unicode_fast"))
    "tournamentId", name, lower(name COLLATE pg_catalog."pg_unicode_fast") AS normalized
  FROM names ORDER BY "tournamentId", lower(name COLLATE pg_catalog."pg_unicode_fast"), "id"
)
INSERT INTO "Club" ("id", "tournamentId", "name", "normalizedName")
SELECT gen_random_uuid()::text, "tournamentId", name, normalized FROM grouped;

UPDATE "Entry" e SET "clubId" = club."id"
FROM "Category" category, "Club" club
WHERE category."id" = e."categoryId" AND club."tournamentId" = category."tournamentId"
  AND club."normalizedName" = lower(trim(regexp_replace(normalize(e."club", NFKC), U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g')) COLLATE pg_catalog."pg_unicode_fast");
-- Legacy rows may keep null gender; the API infers it from their category.
CREATE INDEX "Entry_clubId_idx" ON "Entry"("clubId");
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RosterCommand" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "command" JSONB NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RosterCommand_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RosterCommand_tournamentId_createdAt_idx" ON "RosterCommand"("tournamentId", "createdAt");
ALTER TABLE "RosterCommand" ADD CONSTRAINT "RosterCommand_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
