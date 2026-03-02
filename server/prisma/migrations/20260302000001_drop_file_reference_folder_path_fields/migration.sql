-- Drop indexes that reference the columns being removed
DROP INDEX IF EXISTS "FileReference_workbookId_targetFolderPath_targetFileName_idx";
DROP INDEX IF EXISTS "FileReference_workbookId_targetFolderPath_targetRemoteId_idx";

-- Drop columns
ALTER TABLE "FileReference" DROP COLUMN "targetFolderPath";
ALTER TABLE "FileReference" DROP COLUMN "targetFileName";
