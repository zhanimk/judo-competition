-- Only untouched draft tournaments adopt the new policy. Existing draws keep their rules.
UPDATE "Tournament" t SET "rulesSnapshot" = "rulesSnapshot" || '{"version":"custom-2026-v3","drawPolicy":"REPECHAGE_ONLY"}'::jsonb
WHERE t.status = 'DRAFT' AND NOT EXISTS (
 SELECT 1 FROM "Category" c JOIN "DrawRecord" d ON d."categoryId" = c.id WHERE c."tournamentId" = t.id
);
UPDATE "Category" c SET format = 'REPECHAGE'
FROM "Tournament" t WHERE c."tournamentId" = t.id AND t."rulesSnapshot"->>'drawPolicy' = 'REPECHAGE_ONLY' AND c.format = 'SINGLE_ELIMINATION';
