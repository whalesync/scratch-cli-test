# Sync One Record

Adds a "Sync this record" button to the sync editor's record preview pane, allowing users to save the sync configuration and run it against a single selected record.

## Design Decisions

- **Direction:** Sync runs in the sync's configured direction only (source -> destination).
- **Scope:** Creates a sync job scoped to one record. Runs the transform/copy step only (no pull, no publish).
- **Overwrite behavior:** No special handling. The sync runs normally; whatever the output is, that's what happens.
- **Save requirement:** The sync must be saved before syncing. If there are unsaved changes, auto-save first, then sync.
- **UI placement:** Button in the "Record preview" header, next to the file selector and match status icon.

## What Changes

### 1. Server: New endpoint `POST /workbooks/:workbookId/syncs/:syncId/sync-one-record`

**File:** `server/src/sync/sync.controller.ts`

New endpoint that accepts a source file path and runs `syncTableMapping` scoped to that single record. This is a synchronous operation (not a queued job) because it processes exactly one record and should complete quickly.

**Request body:**

```ts
{
  sourceFilePath: string; // Full path of the source record file
  sourceDataFolderId: DataFolderId; // Which table mapping to use
}
```

**Response:**

```ts
{
  success: boolean;
  result: {
    created: boolean; // Whether a new file was created
    updated: boolean; // Whether an existing file was updated
    destinationPath: string | null; // Path of the written file
    error: string | null; // Error message if transform/write failed
  }
}
```

### 2. Server: `SyncService.syncOneRecord()`

**File:** `server/src/sync/sync.service.ts`

New method that extracts the single-record sync logic from `syncTableMapping`. Needs to:

1. Load the sync's `SyncMapping` and find the `TableMapping` matching the given `sourceDataFolderId`.
2. Load source and destination DataFolder schemas (same as `syncTableMapping` steps 1-2).
3. Read the single source file by path from the dirty branch.
4. Parse it into a `SyncRecord`.
5. Build match key caches and remote ID mappings for just this one record (need source + destination caches to resolve matching).
   - **Key consideration:** The full `syncTableMapping` populates match key caches across ALL source and ALL destination records. For single-record sync, we need the destination cache to be fully populated (to find the match), but only need the one source record. This means we still page through destination files for cache building, but read only one source file.
   - Alternative: query the `SyncMatchKeys` table if caches from a prior full sync still exist. This is fragile (caches may be stale), so the safer approach is to rebuild destination-side caches.
6. Run the transformer pipeline on the record.
7. Write the output file to the destination folder via `scratchGitService`.
8. Return the result.

**Cache strategy:** Build full caches (source match keys, destination match keys, remote ID mappings, FK record caches) the same way `syncTableMapping` does — page through all source and destination files. This ensures accurate record matching and FK resolution. The only difference is in Pass 2: instead of iterating all source files to transform and write, we only transform and write the single requested record. This may be slower than a targeted lookup for large folders, but the result is accurate and consistent with a full sync.

**Complexity note:** `syncTableMapping` is a large method (~300 lines) with tightly coupled cache-building, paging, and transform logic. Rather than refactoring it, the cleanest approach is a new method that reuses the internal helpers (`parseFileToRecord`, `fillSyncCachesBatch`, `buildRecordMatchingMappings`, `applyTransformerPipeline`, `populateForeignKeyRecordCache`, etc.) but with simplified flow: full cache building (Pass 1 identical to `syncTableMapping`), then a single-record Pass 2 that transforms and writes only the target file. FK resolution phase runs the same way, also scoped to the one record.

### 3. Client: API function

**File:** `client/src/lib/api/sync.ts`

Add `syncOneRecord` function:

```ts
syncOneRecord: async (
  workbookId: WorkbookId,
  syncId: SyncId,
  sourceFilePath: string,
  sourceDataFolderId: DataFolderId,
): Promise<SyncOneRecordResponse> => { ... }
```

### 4. Client: SyncEditor UI

**File:** `client/src/app/workbook/[id]/components/MainPane/SyncEditor.tsx`

Add a "Sync this record" button in the record preview header (line ~1035), between the file selector and the match status icons.

**Behavior:**

1. Button is disabled when:
   - No preview file is selected (`!selectedPreviewFile`)
   - Preview is loading
   - Sync is currently being saved
   - No valid folder pair is active
2. On click:
   - If `hasUnsavedChanges`, call `handleSave()` first. If save fails, stop.
   - Call `syncApi.syncOneRecord(workbookId, syncId, selectedPreviewFile, activePair.sourceId)`.
   - Show a notification with the result (success: green, error: red).
3. Show a small loading spinner on the button while the sync is in progress.

**Layout sketch:**

```
Record preview  [file-selector ▾]  [⟳ Sync this record]  ✓  ⟳
```

### 5. Shared types

**File:** `packages/shared-types/src/...`

Add `SyncOneRecordBody` and `SyncOneRecordResponse` types, referenced by both client and server.

## Files to Change

| File                                                              | Change                                      |
| ----------------------------------------------------------------- | ------------------------------------------- |
| `packages/shared-types`                                           | Add request/response types                  |
| `server/src/sync/sync.controller.ts`                              | Add `POST :syncId/sync-one-record` endpoint |
| `server/src/sync/sync.service.ts`                                 | Add `syncOneRecord()` method                |
| `client/src/lib/api/sync.ts`                                      | Add `syncOneRecord` API function            |
| `client/src/app/workbook/[id]/components/MainPane/SyncEditor.tsx` | Add button to preview header                |

## Resolved Questions

- **FK resolution:** Yes, do FK resolution. Build full caches, then only transform/write the one file. Records with FK transformers should produce accurate results.
- **Destination cache cost:** Accepted. Building full caches is slower than a targeted lookup, but still faster than syncing all files. Accuracy over speed for V1.
