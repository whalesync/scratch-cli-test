-- Rename targetFileRecordId -> targetRemoteId
ALTER TABLE "FileReference" RENAME COLUMN "targetFileRecordId" TO "targetRemoteId";

-- Rename targetFolderId -> targetRemoteTableId
ALTER TABLE "FileReference" RENAME COLUMN "targetFolderId" TO "targetRemoteTableId";

-- Drop old indexes
DROP INDEX IF EXISTS "FileReference_workbookId_targetFolderPath_targetFileRecordId_idx";
DROP INDEX IF EXISTS "FileReference_workbookId_targetFolderId_targetFileRecordId_idx";

-- Create new indexes
CREATE INDEX "FileReference_workbookId_targetFolderPath_targetRemoteId_idx" ON "FileReference"("workbookId", "targetFolderPath", "targetRemoteId");
CREATE INDEX "FileReference_workbookId_targetRemoteTableId_targetRemoteId_idx" ON "FileReference"("workbookId", "targetRemoteTableId", "targetRemoteId");
