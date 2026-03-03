-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workbookId" TEXT NOT NULL,
    "service" "Service" NOT NULL,
    "remoteAssetId" TEXT NOT NULL,
    "recordFilePath" TEXT NOT NULL,
    "recordRemoteId" TEXT,
    "fieldPath" TEXT,
    "assetContext" TEXT NOT NULL DEFAULT 'FIELD_VALUE',
    "url" TEXT,
    "filename" TEXT,
    "mimeType" TEXT,
    "size" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "altText" TEXT,
    "mediaType" TEXT,
    "urlExpiresAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_workbookId_service_remoteAssetId_recordFilePath_key" ON "Asset"("workbookId", "service", "remoteAssetId", "recordFilePath");

-- CreateIndex
CREATE INDEX "Asset_workbookId_recordFilePath_idx" ON "Asset"("workbookId", "recordFilePath");

-- CreateIndex
CREATE INDEX "Asset_workbookId_service_idx" ON "Asset"("workbookId", "service");

-- CreateIndex
CREATE INDEX "Asset_urlExpiresAt_idx" ON "Asset"("urlExpiresAt");

-- CreateIndex
CREATE INDEX "Asset_workbookId_lastSeenAt_idx" ON "Asset"("workbookId", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "Workbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
