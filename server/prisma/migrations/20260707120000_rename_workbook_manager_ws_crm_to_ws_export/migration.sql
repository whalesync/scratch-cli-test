-- Rename the `WorkbookManager` enum value `ws_crm` to `ws_export`. `ALTER TYPE ...
-- RENAME VALUE` renames the label in place, so every existing `Workbook.managedBy`
-- row that pointed at `ws_crm` now reads `ws_export` automatically — no data
-- backfill needed. (There are essentially no rows using this value in prod.)
-- AlterEnum
ALTER TYPE "WorkbookManager" RENAME VALUE 'ws_crm' TO 'ws_export';
