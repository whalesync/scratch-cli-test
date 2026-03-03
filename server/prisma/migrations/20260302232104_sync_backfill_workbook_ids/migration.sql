-- Backfill Sync.workbookId from SyncTablePair -> DataFolder relationship
UPDATE "Sync" s
SET "workbookId" = df."workbookId"
FROM "SyncTablePair" stp
JOIN "DataFolder" df ON df.id = stp."sourceDataFolderId"
WHERE stp."syncId" = s.id
  AND s."workbookId" IS NULL;
