/*
  Warnings:

  - You are about to drop the `AiAgentTokenUsageEvent` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AiAgentTokenUsageEvent" DROP CONSTRAINT "AiAgentTokenUsageEvent_userId_fkey";

-- DropTable
DROP TABLE "AiAgentTokenUsageEvent";
