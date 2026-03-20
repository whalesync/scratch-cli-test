-- AlterTable
ALTER TABLE "McpClient" ADD COLUMN     "userId" TEXT;

-- AddForeignKey
ALTER TABLE "McpClient" ADD CONSTRAINT "McpClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
