-- DEV-13019: a shadow user holds the Live Exports of one Whalesync team, not one Whalesync person.
-- Existing shadow users get their team id from Whalesync after this deploys (docs/whalesync-scratch-api-access.md).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "whalesyncTeamId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_whalesyncTeamId_key" ON "User"("whalesyncTeamId");
