-- AlterEnum
ALTER TYPE "ScheduleAction" ADD VALUE 'ROUTINE';

-- CreateTable
CREATE TABLE "RoutineRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workbookId" TEXT NOT NULL,
    "routineFilePath" TEXT NOT NULL,
    "routineName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "trigger" TEXT NOT NULL,
    "triggeredByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RoutineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineRunStep" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "runId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "folder" TEXT,
    "connection" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "jobId" TEXT,
    "pipelineId" TEXT,

    CONSTRAINT "RoutineRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoutineRun_workbookId_idx" ON "RoutineRun"("workbookId");

-- CreateIndex
CREATE INDEX "RoutineRun_routineFilePath_idx" ON "RoutineRun"("routineFilePath");

-- CreateIndex
CREATE INDEX "RoutineRun_status_idx" ON "RoutineRun"("status");

-- CreateIndex
CREATE INDEX "RoutineRunStep_runId_idx" ON "RoutineRunStep"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RoutineRunStep_runId_stepIndex_key" ON "RoutineRunStep"("runId", "stepIndex");

-- AddForeignKey
ALTER TABLE "RoutineRun" ADD CONSTRAINT "RoutineRun_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "Workbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineRunStep" ADD CONSTRAINT "RoutineRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RoutineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
