-- AlterTable: denormalized per-folder record-file count, sourced from git (direct-child,
-- non-dotfile blobs on `main` — matches the folder viewer). Refreshed after a pull and by
-- an hourly cron. Workbook totals are summed from this column on read (no Workbook column).
-- Existing rows default to 0; the first pull/cron corrects them.
ALTER TABLE "DataFolder" ADD COLUMN "recordCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DataFolder" ADD COLUMN "recordCountUpdatedAt" TIMESTAMP(3);
