-- Add syncId column to Job table for filtering jobs by sync
ALTER TABLE "Job" ADD COLUMN "syncId" TEXT;

-- Backfill syncId from the data JSON field for existing sync jobs
UPDATE "Job" SET "syncId" = "data"->>'syncId' WHERE "data"->>'syncId' IS NOT NULL;

-- Create index for efficient filtering
CREATE INDEX "Job_syncId_idx" ON "Job"("syncId");
