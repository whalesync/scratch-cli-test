-- AlterTable
ALTER TABLE "Sync" ADD COLUMN     "workbookId" TEXT;

-- AddForeignKey
ALTER TABLE "Sync" ADD CONSTRAINT "Sync_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "Workbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
