-- Live Export run-store engine (docs/plans/2026-09-25-live-export-git-free-run-store).

-- AlterTable
ALTER TABLE "RoutineRun" ADD COLUMN "liveExportEngine" TEXT;

-- CreateTable
CREATE TABLE "LiveExportRunFailure" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routineRunId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "error" TEXT,
    "errorCode" TEXT,

    CONSTRAINT "LiveExportRunFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveExportRunFailure_routineRunId_idx" ON "LiveExportRunFailure"("routineRunId");

-- CreateIndex
CREATE INDEX "LiveExportRunFailure_pipelineId_idx" ON "LiveExportRunFailure"("pipelineId");

-- AddForeignKey
ALTER TABLE "LiveExportRunFailure" ADD CONSTRAINT "LiveExportRunFailure_routineRunId_fkey" FOREIGN KEY ("routineRunId") REFERENCES "RoutineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
