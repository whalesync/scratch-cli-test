-- DEV-10569: per-schedule IANA timezone for the cron's wall-clock time.
-- Nullable; NULL = UTC (backward compatible with all existing rows).
ALTER TABLE "Schedule" ADD COLUMN "timezone" TEXT;
