-- AlterTable
ALTER TABLE "PublishPlan" ADD COLUMN     "postMainCommitSha" TEXT,
ADD COLUMN     "preDirtyCommitSha" TEXT;
