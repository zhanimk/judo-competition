ALTER TABLE "Tournament" ADD COLUMN "administrationRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TournamentCommand" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "command" JSONB NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TournamentCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TournamentCommand_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TournamentCommand_tournamentId_createdAt_idx" ON "TournamentCommand"("tournamentId", "createdAt");
