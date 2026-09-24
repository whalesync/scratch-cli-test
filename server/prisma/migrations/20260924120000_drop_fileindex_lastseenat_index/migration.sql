-- Nothing queries FileIndex by lastSeenAt, but this index was rewritten on every FileIndex upsert
-- (lastSeenAt changes each time, so no update could be HOT) and, being the smallest
-- (workbookId, folderPath, ...) index, it was the one Postgres' generic plans walked end-to-end
-- for bulk `recordId IN (...)` lookups on large folders.
DROP INDEX "FileIndex_workbookId_folderPath_lastSeenAt_idx";
