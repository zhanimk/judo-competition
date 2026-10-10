-- A controller is a durable tombstone, not a foreign key to a disposable session.
-- Expiry/logout never silently transfers control to another browser.
ALTER TABLE "Tatami"
    ADD COLUMN "accessRevision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "controlGeneration" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "controllerSessionId" TEXT,
    ADD COLUMN "controllerDeviceId" TEXT,
    ADD COLUMN "controllerActorId" TEXT,
    ADD COLUMN "controlledAt" TIMESTAMP(3);
ALTER TABLE "Contest" ADD COLUMN "offlineControlGeneration" INTEGER;

CREATE TABLE "AccessCommand" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "tatamiId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessCommand_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccessCommand_tatamiId_createdAt_idx" ON "AccessCommand"("tatamiId", "createdAt");
CREATE INDEX "AccessCommand_tournamentId_createdAt_idx" ON "AccessCommand"("tournamentId", "createdAt");
ALTER TABLE "AccessCommand" ADD CONSTRAINT "AccessCommand_tournamentId_fkey"
    FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessCommand" ADD CONSTRAINT "AccessCommand_tatamiId_fkey"
    FOREIGN KEY ("tatamiId") REFERENCES "Tatami"("id") ON DELETE CASCADE ON UPDATE CASCADE;
