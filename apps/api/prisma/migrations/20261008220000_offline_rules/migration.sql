ALTER TABLE "Tournament" ADD COLUMN "rulesSnapshot" JSONB;
ALTER TABLE "Contest" ADD COLUMN "offlineSessionId" TEXT;
ALTER TABLE "Contest" ADD COLUMN "offlineActorId" TEXT;
UPDATE "Tournament" SET "rulesSnapshot" = jsonb_build_object('version', 'custom-2026-v1', 'official', false, 'tieBreak', 'PUBLISHED_LOT', 'restMs', 600000, 'shidoLimit', 3, 'wazaForIppon', 2, 'enabledScores', '["YUKO","WAZA_ARI","IPPON"]'::jsonb, 'holdThresholds', '[{"ms":5000,"score":"YUKO"},{"ms":10000,"score":"WAZA_ARI"},{"ms":20000,"score":"IPPON"}]'::jsonb);
UPDATE "Tournament" t SET "rulesSnapshot" = "rulesSnapshot" || '{"version":"custom-2026-v2","tieBreak":"REMATCH"}'::jsonb WHERE t.status = 'DRAFT' AND NOT EXISTS (SELECT 1 FROM "Category" c JOIN "DrawRecord" d ON d."categoryId" = c.id WHERE c."tournamentId" = t.id AND d.status = 'CONFIRMED');
