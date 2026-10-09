CREATE TABLE "Tournament" (
 "id" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "city" TEXT NOT NULL,
 "venue" TEXT NOT NULL,
 "startDate" TEXT NOT NULL,
 "endDate" TEXT NOT NULL,
 "timezone" TEXT NOT NULL DEFAULT 'Asia/Almaty',
 "tatamiCount" INTEGER NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'DRAFT',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Tournament_tatamiCount_check" CHECK ("tatamiCount" BETWEEN 1 AND 32)
);
CREATE TABLE "Category" (
 "id" TEXT NOT NULL,
 "tournamentId" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "gender" TEXT NOT NULL,
 "birthYearFrom" INTEGER NOT NULL,
 "birthYearTo" INTEGER NOT NULL,
 "maxWeightGrams" INTEGER NOT NULL,
 "durationSeconds" INTEGER NOT NULL,
 "format" TEXT NOT NULL DEFAULT 'SINGLE_ELIMINATION',
 "clubSeparation" TEXT NOT NULL DEFAULT 'LATEST_MEETING',
 CONSTRAINT "Category_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Category_birthYear_check" CHECK ("birthYearFrom" <= "birthYearTo"),
 CONSTRAINT "Category_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Category_tournamentId_name_key" ON "Category"("tournamentId", "name");
CREATE TABLE "Entry" (
 "id" TEXT NOT NULL,
 "categoryId" TEXT NOT NULL,
 "firstName" TEXT NOT NULL,
 "lastName" TEXT NOT NULL,
 "birthYear" INTEGER NOT NULL,
 "club" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Entry_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Entry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Entry_categoryId_idx" ON "Entry"("categoryId");
