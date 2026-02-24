-- Rename the table
ALTER TABLE "PublishPlanEntry" RENAME TO "PublishPlanOperation";

-- Rename the primary key index
ALTER INDEX "PublishPlanEntry_pkey" RENAME TO "PublishPlanOperation_pkey";

-- Rename indexes
ALTER INDEX "PublishPlanEntry_planId_idx" RENAME TO "PublishPlanOperation_planId_idx";
ALTER INDEX "PublishPlanEntry_planId_phase_status_idx" RENAME TO "PublishPlanOperation_planId_phase_status_idx";
ALTER INDEX "PublishPlanEntry_planId_dataFolderId_idx" RENAME TO "PublishPlanOperation_planId_dataFolderId_idx";
