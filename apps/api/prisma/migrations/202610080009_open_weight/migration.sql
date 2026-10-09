BEGIN;
ALTER TABLE "Category" ALTER COLUMN "maxWeightGrams" DROP NOT NULL;
ALTER TABLE "Category" ADD COLUMN "minWeightGrams" INTEGER;
ALTER TABLE "Category" ADD CONSTRAINT "Category_weight_bounds_check" CHECK (
  ("maxWeightGrams" IS NOT NULL AND "maxWeightGrams" BETWEEN 1000 AND 300000 AND "minWeightGrams" IS NULL)
  OR ("maxWeightGrams" IS NULL AND "minWeightGrams" IS NOT NULL AND "minWeightGrams" BETWEEN 1000 AND 300000)
);
COMMIT;
