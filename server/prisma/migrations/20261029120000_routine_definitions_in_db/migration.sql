-- DEV-11399: routine definitions move from `routines/*.yaml` in the workbook config git repo to
-- Postgres. The YAML text is the source of truth; git becomes a one-time import source plus a
-- transitional one-way mirror.

-- CreateTable
CREATE TABLE "RoutineDefinition" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workbookId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "RoutineDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoutineDefinition_workbookId_filePath_key" ON "RoutineDefinition"("workbookId", "filePath");

-- CreateIndex
CREATE INDEX "RoutineDefinition_workbookId_idx" ON "RoutineDefinition"("workbookId");

-- AddForeignKey
ALTER TABLE "RoutineDefinition" ADD CONSTRAINT "RoutineDefinition_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "Workbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: new workbooks never have routines in git, so the column defaults to false ...
ALTER TABLE "Workbook" ADD COLUMN "routinesPendingGitImport" BOOLEAN NOT NULL DEFAULT false;

-- ... but every workbook that exists at migration time may still hold `routines/*.yaml` in its
-- config repo and must be imported on first touch. An explicit UPDATE (not the column default)
-- is what marks them, because Postgres fills existing rows with the default.
UPDATE "Workbook" SET "routinesPendingGitImport" = true;
