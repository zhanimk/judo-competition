ALTER TABLE "Contest" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "state" JSONB, ADD COLUMN "clockAnchorMs" DOUBLE PRECISION,
ADD COLUMN "clockEpoch" TEXT, ADD COLUMN "winnerEntryId" TEXT,
ADD COLUMN "resultReason" TEXT, ADD COLUMN "confirmedAt" TIMESTAMP(3),
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "Contest_one_active_per_tatami" ON "Contest" ("tatamiId") WHERE "status" = 'ACTIVE';
CREATE TABLE "MatchEvent" ("id" TEXT PRIMARY KEY,"contestId" TEXT NOT NULL,"actorId" TEXT NOT NULL,
"type" TEXT NOT NULL,"payload" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "MatchEvent_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "Contest"("id") ON DELETE CASCADE);
CREATE INDEX "MatchEvent_contestId_createdAt_idx" ON "MatchEvent"("contestId","createdAt");
