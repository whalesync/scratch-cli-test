-- AlterTable
ALTER TABLE "FileReference" ADD COLUMN     "targetFolderId" TEXT;

-- CreateIndex
CREATE INDEX "FileReference_workbookId_targetFolderId_targetFileRecordId_idx" ON "FileReference"("workbookId", "targetFolderId", "targetFileRecordId");
