-- AlterTable
ALTER TABLE "ConnectorAccount" ADD COLUMN     "migrationLockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "disabledForMigrationAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ConnectorAccount_migrationLockedAt_idx" ON "ConnectorAccount"("migrationLockedAt");
