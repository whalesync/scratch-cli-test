-- CreateTable: monthly per-organization tally of high-level run executions, by type (DEV-10543).
-- One row per (organization, calendar-month-UTC, runType); counts roll over by month and past
-- months are retained as history. Incremented atomically when a run reaches a terminal,
-- non-cancelled state. Org-scoped: survives workbook deletion, cascades only on org deletion.
CREATE TABLE "OrganizationMonthlyRunCount" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "runType" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrganizationMonthlyRunCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMonthlyRunCount_organizationId_periodStart_runT_key" ON "OrganizationMonthlyRunCount"("organizationId", "periodStart", "runType");

-- CreateIndex
CREATE INDEX "OrganizationMonthlyRunCount_organizationId_periodStart_idx" ON "OrganizationMonthlyRunCount"("organizationId", "periodStart");

-- AddForeignKey
ALTER TABLE "OrganizationMonthlyRunCount" ADD CONSTRAINT "OrganizationMonthlyRunCount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
