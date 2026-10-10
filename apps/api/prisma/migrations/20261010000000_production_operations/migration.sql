ALTER TABLE "Tournament" ADD COLUMN "protocolRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Contest" ADD COLUMN "endedAt" TIMESTAMP(3);

-- Keep historical results conservative: no trustworthy actual end time existed.
-- Availability falls back to confirmedAt for these rows.
CREATE TABLE "DrawCommand" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "command" JSONB NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DrawCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DrawCommand_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DrawCommand_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "DrawCommand_tournamentId_createdAt_idx" ON "DrawCommand"("tournamentId", "createdAt");
CREATE INDEX "DrawCommand_categoryId_createdAt_idx" ON "DrawCommand"("categoryId", "createdAt");

CREATE TABLE "ProtocolArtifact" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "lang" TEXT NOT NULL,
  "categoryIds" JSONB NOT NULL,
  "scope" TEXT NOT NULL,
  "source" JSONB NOT NULL,
  "sha256" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "bytes" BYTEA NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  CONSTRAINT "ProtocolArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProtocolArtifact_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProtocolArtifact_content_check" CHECK ("kind" IN ('DRAW','PARTICIPANTS','TEAMS') AND "lang" IN ('ru','kk') AND "scope" IN ('ALL','SELECTED') AND "version" > 0 AND "byteSize" > 0 AND "byteSize" <= 67108864 AND "byteSize" = octet_length("bytes") AND "sha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "ProtocolArtifact_tournamentId_version_key" ON "ProtocolArtifact"("tournamentId", "version");
CREATE INDEX "ProtocolArtifact_tournamentId_publishedAt_version_idx" ON "ProtocolArtifact"("tournamentId", "publishedAt", "version");

CREATE TABLE "ProtocolCommand" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "artifactId" TEXT,
  "actorId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "command" JSONB NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProtocolCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProtocolCommand_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProtocolCommand_tournamentId_createdAt_idx" ON "ProtocolCommand"("tournamentId", "createdAt");

CREATE TABLE "LiveOutbox" (
  "id" BIGSERIAL NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "tatamiId" TEXT,
  "kind" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  CONSTRAINT "LiveOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LiveOutbox_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LiveOutbox_kind_check" CHECK ("kind" IN ('state','result','queue','roster','protocol','access'))
);
CREATE INDEX "LiveOutbox_tournamentId_id_idx" ON "LiveOutbox"("tournamentId", "id");
CREATE INDEX "LiveOutbox_publishedAt_nextAttemptAt_id_idx" ON "LiveOutbox"("publishedAt", "nextAttemptAt", "id");
