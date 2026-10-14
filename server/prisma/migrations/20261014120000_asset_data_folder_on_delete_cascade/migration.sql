/*
  DEV-12324: Asset rows now follow their data folder. Deleting a DataFolder deletes its Asset rows
  (previously the FK was ON DELETE SET NULL, which left the rows behind with a NULL dataFolderId), so the
  rehosted-asset reaper cron can find and delete their now-unreferenced files in the GCS assets bucket.

  Warnings:

  - This first deletes the Asset rows that earlier data-folder deletes orphaned under the old SET NULL
    rule. Every writer sets dataFolderId, so a NULL value only ever comes from that rule; none of these rows
    are rehosted, and no code path reads them.
*/
DELETE FROM "Asset" WHERE "dataFolderId" IS NULL;

-- DropForeignKey
ALTER TABLE "Asset" DROP CONSTRAINT "Asset_dataFolderId_fkey";

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_dataFolderId_fkey" FOREIGN KEY ("dataFolderId") REFERENCES "DataFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
