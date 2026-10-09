ALTER TABLE "Category" ADD COLUMN "homeTatamiId" TEXT;
ALTER TABLE "Category" ADD CONSTRAINT "Category_homeTatamiId_fkey" FOREIGN KEY ("homeTatamiId") REFERENCES "Tatami"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Preserve existing venues. A completed/active contest takes priority over queued contests.
UPDATE "Category" AS category SET "homeTatamiId" = chosen."tatamiId"
FROM (
 SELECT DISTINCT ON (d."categoryId") d."categoryId", c."tatamiId"
 FROM "Contest" c JOIN "DrawRecord" d ON d.id = c."drawId"
 WHERE c."tatamiId" IS NOT NULL
 ORDER BY d."categoryId", CASE c.status WHEN 'CONFIRMED' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END,
 COALESCE(c."confirmedAt", c."updatedAt"), c.id
) chosen WHERE category.id = chosen."categoryId";
