/*
  Warnings:

  - A unique constraint covering the columns `[whalesyncUserId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "whalesyncUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_whalesyncUserId_key" ON "User"("whalesyncUserId");
