/*
  Warnings:

  - You are about to drop the column `lastSchemaRefreshAt` on the `DataFolder` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DataFolder" DROP COLUMN "lastSchemaRefreshAt";
