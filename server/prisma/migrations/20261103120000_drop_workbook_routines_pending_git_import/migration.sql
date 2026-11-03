-- DEV-12620: every workbook's routine definitions are in "RoutineDefinition" and the one-time git
-- import that read this flag has been removed, so the flag has nothing left to track.
ALTER TABLE "Workbook" DROP COLUMN IF EXISTS "routinesPendingGitImport";
