/*
  Warnings:

  - This deletes all content in the Asset table.
*/
DELETE FROM "Asset";

-- DropIndex
DROP INDEX "Asset_workbookId_recordFilePath_idx";

-- DropIndex
DROP INDEX "Asset_workbookId_service_remoteAssetId_recordFilePath_key";

-- AlterTable
ALTER TABLE "Asset" DROP COLUMN "assetContext",
DROP COLUMN "fieldPath",
DROP COLUMN "recordFilePath",
DROP COLUMN "recordRemoteId",
ADD COLUMN     "dataFolderId" TEXT;

-- CreateIndex
CREATE INDEX "Asset_dataFolderId_idx" ON "Asset"("dataFolderId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_workbookId_service_remoteAssetId_key" ON "Asset"("workbookId", "service", "remoteAssetId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_dataFolderId_fkey" FOREIGN KEY ("dataFolderId") REFERENCES "DataFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
