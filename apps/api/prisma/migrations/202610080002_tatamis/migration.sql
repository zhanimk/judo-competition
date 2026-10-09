CREATE TABLE "Tatami" (
 "id" TEXT NOT NULL,
 "tournamentId" TEXT NOT NULL,
 "number" INTEGER NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'IDLE',
 CONSTRAINT "Tatami_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Tatami_number_check" CHECK ("number" > 0),
 CONSTRAINT "Tatami_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Tatami_tournamentId_number_key" ON "Tatami"("tournamentId", "number");
-- Preserve existing tournaments: backfill their declared tatamis exactly once.
INSERT INTO "Tatami" ("id", "tournamentId", "number")
SELECT gen_random_uuid()::text, t."id", n FROM "Tournament" t CROSS JOIN LATERAL generate_series(1,t."tatamiCount") n;
