-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "runContext" JSONB,
ADD COLUMN     "runId" TEXT;

-- CreateIndex
CREATE INDEX "Job_runId_idx" ON "Job"("runId");
