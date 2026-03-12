/*
  Warnings:

  - You are about to drop the column `aiPromptHistory` on the `Sync` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Sync" DROP COLUMN "aiPromptHistory";
