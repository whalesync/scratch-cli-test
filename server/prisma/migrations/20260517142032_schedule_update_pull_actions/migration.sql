-- Converge legacy schedules to the new naming: every existing PULL schedule
-- becomes FULL_PULL. PULL and FULL_PULL are runtime-equivalent, so this is a
-- pure rename
UPDATE "Schedule" SET "action" = 'FULL_PULL' WHERE "action" = 'PULL';
