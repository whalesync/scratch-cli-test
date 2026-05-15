-- AlterTable
ALTER TABLE "DataFolder" ADD COLUMN     "incrementalCursor" JSON,
ADD COLUMN     "lastFullPullAt" TIMESTAMP(3),
ADD COLUMN     "lastIncrementalPullAt" TIMESTAMP(3);
