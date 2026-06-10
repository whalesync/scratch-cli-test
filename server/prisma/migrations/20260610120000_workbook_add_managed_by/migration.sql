-- CreateEnum
CREATE TYPE "WorkbookManager" AS ENUM ('ws_crm');

-- AlterTable
ALTER TABLE "Workbook" ADD COLUMN     "managedBy" "WorkbookManager";
