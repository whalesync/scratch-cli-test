/*
  Warnings:

  - You are about to drop the column `parentId` on the `DataFolder` table. All the data in the column will be lost.
  - You are about to drop the column `schema` on the `DataFolder` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[workbookId,name]` on the table `DataFolder` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "DataFolder" DROP CONSTRAINT "DataFolder_parentId_fkey";

-- DropIndex
DROP INDEX "DataFolder_parentId_idx";

-- DropIndex
DROP INDEX "DataFolder_workbookId_parentId_name_key";

-- AlterTable
ALTER TABLE "DataFolder" DROP COLUMN "parentId",
DROP COLUMN "schema";

-- CreateIndex
CREATE UNIQUE INDEX "DataFolder_workbookId_name_key" ON "DataFolder"("workbookId", "name");
