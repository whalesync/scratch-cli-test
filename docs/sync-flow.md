# Sync Flow

How the sync pipeline works end-to-end, from job dispatch through record transformation and file writing.

## Entry Point

A sync job starts in `SyncDataFoldersJobHandler.run()` (`server/src/worker/jobs/job-definitions/sync-data-folders.job.ts`). It loads the `Sync` record from the database, extracts the `SyncMapping` (which contains an array of `TableMapping` objects), and processes each table mapping sequentially.

For each table mapping, the job calls `SyncService.syncTableMapping()` twice:

1. **Phase 1 (`DATA`)** — builds caches, transforms data fields, writes files.
2. **Phase 2 (`FOREIGN_KEY_MAPPING`)** — re-runs only table mappings that have `source_fk_to_dest_fk` or `source_asset_to_dest_asset` transformers, resolving cross-table references that weren't available during Phase 1.

---

## syncTableMapping — Step by Step

All of the core logic lives in `SyncService.syncTableMapping()` (`server/src/sync/sync.service.ts`).

### 1. Load source and destination DataFolders

Fetches both DataFolder records from the database, reads their schemas from git (falling back to DB), and resolves the destination git repo ID.

### 2. Pass 1 — Populate caches (DATA phase only)

This pass builds the lookup tables that transformers depend on later. It is skipped entirely during the `FOREIGN_KEY_MAPPING` phase, which reuses caches from Phase 1.

#### 2a. Page through source files

Source files are read in paginated batches from the dirty branch. Each batch is parsed into `SyncRecord` objects (JSON content + extracted record ID).

For each batch:

- **Fill sync caches** — If the table mapping has `recordMatching` configured, reduces each matching-field value to a [canonical match key](/server/src/sync/README.md#record-matching) (using the field's own extraction transformer, so matching is direction-independent) and inserts it into the `SyncMatchKeys` table for the source side. If there's no `recordMatching`, inserts `SyncRemoteIdMapping` entries directly with `null` destination (every source record will be a create).

- **Collect foreign key values** — Scans column mappings for any `lookup_field` transformers. For each one, extracts the FK values from the source records and accumulates them in a `Map<DataFolderId, Set<string>>` keyed by the referenced folder. These values are used later to pre-fetch referenced records.

  > **How `lookup_field` works (cache population):** The `lookup_field` transformer denormalizes data by extracting a field from a related record via foreign key. During this cache-building step, the sync collects all FK values that `lookup_field` mappings will need. For example, if source records have a `categoryId` field and the mapping uses `lookup_field` with `referencedFieldPath: "name"`, the sync collects all unique `categoryId` values so it can later fetch and cache the corresponding category records.

#### 2b. Page through destination files

Destination files are also read in paginated batches. Each batch:

- Tracks used destination filenames in `usedDestFileNames` (for deduplication when creating new files).
- Inserts destination-side match keys into `SyncMatchKeys` (when `recordMatching` is configured).

The parsed records themselves are dropped once the batch is handled — only the filename set survives the walk. Holding every destination record for the whole call was the sync worker's largest allocation (~700 MB on a 42k-record folder) and OOM-killed it, so the two later consumers re-read instead: Pass 2 reads back just the matched records of each source page, and Pass 3 streams the destination folder a second time (DEV-11194). Both see the same pre-sync bytes, because nothing a run writes lands on the dirty branch until its single commit at the end.

#### 2c. Build record matching mappings

Joins source and destination match keys via SQL to produce `SyncRemoteIdMapping` entries. Source records that have a matching destination record get a non-null `destinationRemoteId` and `destinationFilePath`. Unmatched source records get null destinations (will be created as new records).

#### 2d. Populate foreign key record cache

For each referenced folder that had FK values collected in step 2a, fetches all records from that folder, parses them, and inserts relevant ones into the `SyncForeignKeyRecord` table. This cache is keyed by `(syncId, dataFolderId, foreignKeyValue)` and stores the full record data as JSON.

> **How `lookup_field` works (runtime):** During the DATA phase, the `lookup_field` transformer calls `lookupTools.lookupFieldFromFkRecord(fkValue, referencedDataFolderId, referencedFieldPath)`. This queries the `SyncForeignKeyRecord` cache, finds the referenced record by its FK value, and extracts the requested field using lodash `get()`. For example, FK value `"cat_123"` with `referencedFieldPath: "name"` returns the `name` field from the cached category record. The transformer handles both scalar and array FK values — arrays produce an array of looked-up values. During the `FOREIGN_KEY_MAPPING` phase, `lookup_field` skips (returns `skip: true`) since its work is already done.

### 3. Pass 2 — Transform and write records

Pages through source files again. For each batch:

#### 3a. Load destination mappings for the batch

Queries `SyncRemoteIdMapping` to get the destination file path (or null) for each source record in the batch.

#### 3b. Validate unmapped records

If `recordMatching` is configured, checks for source records that have no mapping. These are records with missing or empty match key values — they're logged as errors.

#### 3c. Transform each record

For each source record with a mapping:

**New records** (mapping has null `destinationFilePath`):

- Calls `transformRecordAsync()` which iterates each column mapping, extracts the source value, and runs the transformer pipeline.
- Generates a destination record ID (uses the mapped ID column value if one was produced, otherwise generates a temporary pending-publish ID).
- Resolves a filename from the destination schema's slug column or falls back to the temp ID, deduplicating against existing filenames.

**Existing records** (mapping has a `destinationFilePath`):

- Reads the existing destination records for this batch's matched paths via `ScratchGitService.readRepoFilesByFolder` (one bulk call per source page, grouped into a single tree walk), and discards them at the page boundary.
- Calls `transformRecordAsync()` with `baseFields` set to the existing destination record's fields. This clones the existing object and uses lodash `set()` to write only the mapped fields, preserving the original JSON key ordering. A path whose file is no longer in git yields no `baseFields`, so the record is rewritten from the mappings alone.
- Skips the write entirely if the transformed fields are identical to the existing record (avoids no-op file writes).

> **How `source_fk_to_dest_fk` works:** This transformer resolves foreign key IDs from the source system to references in the destination system. During the **DATA phase, it skips** (returns `skip: true`) — FK resolution is deferred because the referenced destination records may not exist yet (they might be created by the same sync). During the **FOREIGN_KEY_MAPPING phase**, it resolves each FK value by calling `lookupTools.getDestinationMappingForSourceFk(fkValue, referencedDataFolderId)`, which queries the `SyncRemoteIdMapping` table. If the destination record has a real (published) remote ID, the transformer uses that ID directly. If the destination record only has a pending-publish ID (it was just created by this sync), the transformer produces a pseudo-reference like `@/path/to/file.json` that points to the destination file path (canonical format — workspace-absolute, connection folder first — defined in [`pseudo-refs.md`](./pseudo-refs.md)). The transformer handles both scalar and array FK values and checks idempotency (skips if the destination already has the correct reference). A foreign key it **cannot** resolve raises a warning instead of failing the record or the table (`onUnresolved`, default `'ignore'`; set `'fail'` to make a dangling reference stop the sync instead), and the warning names **which** of three causes it hit, because each has a different fix (DEV-11223): the referenced record was never synced from that folder (deleted upstream, filtered out, or never pulled — the common case); it was synced but has not reached the destination yet; or the referenced table synced no records at all, which usually means it is not one of this sync's table pairs. They are told apart by `SyncRemoteIdMapping`, whose rows a folder rewrites at the start of its own `DATA` phase — one per source record it synced, with the destination columns null until a counterpart exists — so a missing row and a destination-less row mean different things. What it writes depends on whether the write would **lose** a link the destination already holds. Dropping the dangling entry and writing the field would publish an _unlink_, destroying a correct link over a reference we merely failed to resolve — so if any link currently on the destination record is missing from the resolved set, the field is left **completely untouched** (`skip`). If the write only **adds** to what the destination already holds, it goes through: on a multi-value link a newly added, resolvable reference still lands even while a sibling dangles (otherwise it would stay unwritten for as long as the dangling target is missing — forever, for a hard-deleted CRM record). A link the source itself removed still clears normally: that arrives as a null or shorter source value with nothing unresolved, so the guard never fires on it. An **ambiguous** key (two records in the referenced folder claim the same `targetKeyPath` value) is always a hard failure, even under `'ignore'` — linking the wrong record is worse than not linking. A sync that raised warnings completes, and its routine run reads "completed with warnings" with the count (DEV-11222).

> **How `source_asset_to_dest_asset` works:** This transformer maps source asset IDs to destination asset IDs, creating destination Asset records on demand. Like `source_fk_to_dest_fk`, it **skips during the DATA phase** and runs during the **FOREIGN_KEY_MAPPING phase**. The `sourceService`, `sourceDataFolderId`, and `destinationService` are provided via `TransformContext` (set from the sync's source/destination DataFolders), while `destinationDataFolderId` is specified in the transformer options (allowing assets to target a different table, e.g. WordPress Media vs Posts). For each source asset ID, it calls `lookupTools.getOrCreateDestinationAssetMapping()`, which: (1) finds the source `Asset` record by `(workbookId, sourceDataFolderId, sourceService, remoteAssetId)`, (2) upserts a destination `Asset` keyed by `(sourceAssetId, destinationDataFolderId)` — creating one with a temporary pending-publish ID if it doesn't exist, copying over all metadata (filename, mimeType, size, dimensions, etc.). If the destination asset is new or unpublished, the transformer produces a pseudo-reference like `@asset/{id}`. If it's already published, it uses the raw asset ID. The transformer handles `ASSET_NOT_FOUND` (source asset not indexed) and `ASSET_NOT_REHOSTED` errors, supports `onUnresolved: 'ignore'`, and performs the same idempotency check as the FK transformer.

#### 3d. Serialize and collect files

Each transformed record is serialized to JSON (formatted with Prettier) and added to the `filesToWrite` array.

### 4. Backfill new record mappings (DATA phase only)

After all source pages are processed, updates the `SyncRemoteIdMapping` entries for newly created records with their destination file paths and record IDs. This is critical so the FOREIGN_KEY_MAPPING phase can resolve FK references to records that were just created.

### 5. Batch write to git

All accumulated files are committed to the destination repo's dirty branch in a single `commitFilesToBranch` call.

---

## Post-Sync (back in the job handler)

After all table mappings complete both phases:

1. **Progress checkpointing** — The job tracks creates, updates, errors, and warnings per table and reports them via the progress system.
2. **Last sync time** — If all tables succeeded, updates `Sync.lastSyncTime`.
3. **Publish-after-sync** — If enabled and files were written, enqueues publish pipeline jobs for each unique destination connector account.
4. **Git GC** — Runs garbage collection on the workbook's git repo.

---

## Transformer Pipeline

The transformer pipeline (`applyTransformerPipeline`) chains multiple transformers on a single field. Each column mapping can have one or more transformer configs. The output of transformer N becomes the input of transformer N+1.

Key behaviors:

- **Skip short-circuits the pipeline** — If any transformer returns `skip: true`, the pipeline stops immediately and the field is left unchanged.
- **Failure short-circuits the pipeline** — If any transformer returns `success: false`, the pipeline stops and the error propagates up, causing the entire record to fail.
- **Warnings accumulate** — Warnings from all steps are merged into the final result.
- **Phase is uniform** — All transformers in a pipeline see the same phase. Transformers that don't operate in the current phase return `skip: true`.
