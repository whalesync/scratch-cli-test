-- AlterTable
ALTER TABLE "PublishPlan" ADD COLUMN     "authorId" TEXT;

-- AddForeignKey
ALTER TABLE "PublishPlan" ADD CONSTRAINT "PublishPlan_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
