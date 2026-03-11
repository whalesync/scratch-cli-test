-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "sourceAssetId" TEXT;

-- CreateIndex
CREATE INDEX "Asset_sourceAssetId_idx" ON "Asset"("sourceAssetId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
