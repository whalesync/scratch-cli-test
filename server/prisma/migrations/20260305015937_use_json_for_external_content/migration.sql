-- AlterTable
ALTER TABLE "PublishPlan" ALTER COLUMN "result" SET DATA TYPE JSON;

-- AlterTable
ALTER TABLE "PublishPlanOperation" ALTER COLUMN "content" SET DATA TYPE JSON,
ALTER COLUMN "changedFields" SET DATA TYPE JSON;

-- AlterTable
ALTER TABLE "SyncForeignKeyRecord" ALTER COLUMN "recordData" SET DATA TYPE JSON;
