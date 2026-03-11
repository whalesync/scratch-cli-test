/*
  Warnings:

  - You are about to drop the `AiAgentCredential` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AiAgentCredential" DROP CONSTRAINT "AiAgentCredential_userId_fkey";

-- DropTable
DROP TABLE "AiAgentCredential";

-- DropEnum
DROP TYPE "AiAgentCredentialSource";
