-- Convert ScheduleAction enum column to plain text.
-- Existing data is preserved: PostgreSQL enum values are already stored as text internally.

-- Schedule.action
ALTER TABLE "Schedule" ALTER COLUMN "action" TYPE text USING "action"::text;

-- Drop the enum type now that no columns reference it
DROP TYPE "ScheduleAction";
