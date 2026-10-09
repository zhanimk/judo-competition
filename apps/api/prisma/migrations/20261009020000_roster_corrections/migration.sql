-- Keep every historical entry ID and its values; removal only archives a row.
ALTER TABLE "Entry" ADD COLUMN "archivedAt" TIMESTAMP(3);
CREATE INDEX "Entry_categoryId_archivedAt_idx" ON "Entry"("categoryId", "archivedAt");
CREATE INDEX "Entry_clubId_archivedAt_idx" ON "Entry"("clubId", "archivedAt");
