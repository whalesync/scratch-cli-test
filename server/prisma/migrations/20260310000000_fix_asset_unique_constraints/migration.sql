-- Truncate Asset table to avoid constraint violations during development.
-- remoteAssetId is only unique per dataFolderId (not per service), so the old
-- constraint was incorrect for workbooks with multiple connections of the same service.
TRUNCATE TABLE "Asset" CASCADE;

-- Drop the old unique constraint that scoped by service
DROP INDEX "Asset_workbookId_service_remoteAssetId_key";

-- Create the corrected unique constraint scoped by dataFolderId
CREATE UNIQUE INDEX "Asset_workbookId_dataFolderId_remoteAssetId_key" ON "Asset"("workbookId", "dataFolderId", "remoteAssetId");

-- Create unique constraint for source-to-destination asset mapping (used by sync upsert)
CREATE UNIQUE INDEX "Asset_sourceAssetId_dataFolderId_key" ON "Asset"("sourceAssetId", "dataFolderId");
