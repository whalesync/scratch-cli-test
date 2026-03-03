-- AlterTable
ALTER TABLE "ConnectorAccount" ADD COLUMN     "repoPath" TEXT;

-- Backfill existing ConnectorAccounts



-- For V2 Workbooks: [orgId]--[workbookId]--[connAccountId]
UPDATE "ConnectorAccount"
SET "repoPath" = "Workbook"."organizationId" || '--' || "ConnectorAccount"."workbookId" || '--' || "ConnectorAccount"."id"
FROM "Workbook"
WHERE "ConnectorAccount"."workbookId" = "Workbook"."id" AND "Workbook"."version" >= 2;
