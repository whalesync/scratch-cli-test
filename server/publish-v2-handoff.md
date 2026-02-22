# Publish v2: Pipeline-Based Phased Publishing — Agent Handoff

This document describes the publish v2 feature as implemented in the Mackerel prototype. Use it to reimplement the same feature in the sister project.

All file paths below are absolute to the Mackerel repository at `/Users/ijd/repos/mackerel/`.

---

## 1. What Problem It Solves

The original publish was a single ~500-line function (`publishAll()`) that interleaved planning and execution. Three independently complex concerns were tangled together:

1. **Two-pass `@/` reference resolution** — When creating records that cross-reference each other (e.g., Book→Author and Author→Book), you can't set the references until both records exist. So you create them first (stripping refs), then backfill refs in a second pass.
2. **Circular delete reference clearing** — If two records reference each other and both are being deleted, all inbound references must be nulled out before any delete can succeed (otherwise the external service rejects the delete due to FK constraints).
3. **Operation ordering** — Edits must happen before deletes (to clear refs), creates must happen before backfill (to get real IDs).

## 2. The Solution: Build + Run Pipeline

Publishing is split into two phases:

### Build (pure analysis, no API calls)

Reads the user's dirty branch, classifies every changed file, analyzes references, and materializes a plan as **a sequence of git commits on a `publish/{userId}/{pipelineId}` branch**. Each commit has a `[phase-type]` prefix in its commit message.

### Run (pure execution)

Walks the pipeline commits sequentially. For each commit, diffs it against its parent commit (not against main) to find the exact set of changes, then publishes them via the connector. Streams NDJSON progress messages to the UI.

### Why diff commit-to-commit, not against main?

After each phase publishes and pulls canonical data back to main, the main branch now contains server-computed fields (timestamps, CDN URLs, etc.) that weren't in the original data. If subsequent phases diffed against this updated main, they'd see phantom changes and try to revert them. By diffing each commit against its parent within the pipeline branch, each phase sees only its own intended changes.

## 3. The Four Phase Types

| Phase        | Commit prefix | What it does                                                                                                                  | When present                                       |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Edit**     | `[edit]`      | Publishes user's modified files + synthetic reference-clearing edits (nulling fields pointing to records about to be deleted) | Files modified, or deletes need ref-clearing       |
| **Create**   | `[create]`    | Publishes new files with unresolvable `@/` refs stripped out                                                                  | Files added                                        |
| **Delete**   | `[delete]`    | Bulk-deletes records from external service, removes from main                                                                 | Files deleted                                      |
| **Backfill** | `[backfill]`  | Re-applies `@/` references that were stripped during create (targets now have real IDs on main)                               | Only when creates had unresolvable `@/` cross-refs |

**Ordering**: edit → create → delete → backfill. Each phase depends on the previous one completing.

**Most publishes are simple**: editing a few files produces just 1 commit (`[edit]`). The full 4-phase pipeline only appears for complex mixed operations with circular references.

| Scenario                                           | Commits                                            |
| -------------------------------------------------- | -------------------------------------------------- |
| Edit some files                                    | 1 (`[edit]`)                                       |
| Create some files                                  | 1 (`[create]`)                                     |
| Delete some files                                  | 1-2 (`[edit]` + `[delete]` if ref-clearing needed) |
| Create files with `@/` cross-refs                  | 2 (`[create]` + `[backfill]`)                      |
| Mixed edits + creates + deletes with circular refs | Up to 4                                            |

## 4. File Map

### Core pipeline logic

| File                                                               | Purpose                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/types.ts`      | Type definitions: `PipelinePhaseType`, `PipelinePhase`, `PipelineInfo`, `PhaseResult`                     |
| `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/build.ts`      | `buildPipeline()` — analyzes dirty files, writes typed git commits to pipeline branch                     |
| `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/run.ts`        | `runPipeline()` — walks commits, dispatches to phase handlers, streams progress                           |
| `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/phases.ts`     | Per-phase execution: `runEditPhase()`, `runCreatePhase()`, `runDeletePhase()`, `runBackfillPhase()`       |
| `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/helpers.ts`    | Utilities: path parsing, `@/` ref detection/stripping/resolution, phase type parsing from commit messages |
| `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/publish-v2.ts` | `publishAllV2()` — convenience function that chains build + run into one async generator                  |
| `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/index.ts`      | Barrel export                                                                                             |

### API endpoints

| File                                                                                      | Route                   | Purpose                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `/Users/ijd/repos/mackerel/src/app/api/workspaces/[workspaceId]/publish-v2/plan/route.ts` | `POST /publish-v2/plan` | Build pipeline, return `PipelineInfo` JSON                                       |
| `/Users/ijd/repos/mackerel/src/app/api/workspaces/[workspaceId]/publish-v2/run/route.ts`  | `POST /publish-v2/run`  | Run a previously-built pipeline (accepts `PipelineInfo` in body), streams NDJSON |
| `/Users/ijd/repos/mackerel/src/app/api/workspaces/[workspaceId]/publish-v2/route.ts`      | `POST /publish-v2`      | One-shot: build + run together, streams NDJSON                                   |

### Frontend

| File                                                                        | What it does                                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/ijd/repos/mackerel/src/components/views/changes-view.tsx`           | Two-step UX: "Plan Publish" shows phase breakdown → "Run Publish" executes with live progress. "Re-plan" button rebuilds if changes occurred. |
| `/Users/ijd/repos/mackerel/src/components/providers/workspace-provider.tsx` | React context: `planPublish()`, `runPublishPlan()`, `publishPlan` state, progress tracking                                                    |
| `/Users/ijd/repos/mackerel/src/lib/api-client.ts`                           | Client-side API calls: `publishV2Plan(workspaceId)`                                                                                           |

### Design docs

| File                                                               | Purpose                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `/Users/ijd/repos/mackerel/docs/publish-v2-pipeline-design.md`     | Full design document with rationale, examples, and open questions |
| `/Users/ijd/repos/mackerel/docs/publish-v2-implementation-plan.md` | Implementation plan with design decisions and migration path      |

---

## 5. Implementation Deviation: DB-Based Pipeline

**IMPORTANT**: Unlike the Mackerel prototype which used a git branch (`publish/{userId}/{pipelineId}`) to store the plan (commits for each phase), the production implementation will use a **Database-centric approach**.

### Why the change?

Using Git branches for ephemeral state text/json storage is heavy and hard to query. A DB table offers better visibility, easier state management, and atomic updates for status flags.

### The New Architecture

Instead of `[phase]` commits, we will use a `PublishPipelineEntry` table in Postgres.

**Schema Concept:**

```prisma
model PublishPipelineEntry {
  id         String @id @default(cuid())
  pipelineId String
  pipeline   PublishPipeline @relation(fields: [pipelineId], references: [id], onDelete: Cascade)

  filePath   String // The logical path of the file

  // The content/operation for each phase.
  // If null, this file is not involved in this phase.
  editOperation     Json? // { content: string }
  createOperation   Json? // { content: string }
  deleteOperation   Json? // { } (marker)
  backfillOperation Json? // { content: string }

  // Status flags for execution
  editStatus     String? // 'pending', 'success', 'failed'
  createStatus   String?
  deleteStatus   String?
  backfillStatus String?

  // Optimization flags (to avoid checking nulls)
  hasEdit     Boolean @default(false)
  hasCreate   Boolean @default(false)
  hasDelete   Boolean @default(false)
  hasBackfill Boolean @default(false)

  @@unique([pipelineId, filePath])
}
```

### Mapping Phases to DB

1. **Build Phase**:

   - Instead of writing a commit, the `PipelineBuildService` will `createMany` entries in `PublishPipelineEntry`.
   - **Edit Phase**: Populates `editOperation` and sets `hasEdit=true`.
   - **Create Phase**: Populates `createOperation` and sets `hasCreate=true`.
   - **Delete Phase**: Populates `deleteOperation` and sets `hasDelete=true`.
   - **Backfill Phase**: Populates `backfillOperation` and sets `hasBackfill=true`.

2. **Run Phase**:
   - Iterates through phases (Edit -> Create -> Delete -> Backfill).
   - For each phase, queries `PublishPipelineEntry` where `has${Phase} == true`.
   - Executes the operation.
   - Updates `${phase}Status`.

The `FileIndex` and `FileReference` are **still required** and used exactly as before to compute the dependencies and resolve references during the **Build Phase**.

---

## 5. The Two Supporting Indexes

The publish pipeline depends on two Postgres indexes that cache data derived from git. Both are rebuildable from scratch by scanning git files — they are caches, not sources of truth.

### 5.1 FileIndex

**Purpose**: Maps `(folderPath, recordId) → filename`. Allows fast lookups between external service record IDs and the JSON filenames stored in git.

**Schema** (from `/Users/ijd/repos/mackerel/prisma/schema.prisma` lines 116-126):

```prisma
model FileIndex {
  id         String    @id @default(cuid())
  folderPath String    // e.g., "airtable/conn-xyz/appABC/tblDEF"
  recordId   String    // External service record ID, e.g. "rec123abc"
  filename   String    // e.g., "old-man.json"
  lastSeenAt DateTime? // Stamped during pull for stale detection

  @@unique([folderPath, recordId])
  @@index([folderPath, filename])
  @@index([folderPath, lastSeenAt])
}
```

**Implementation**: `/Users/ijd/repos/mackerel/src/lib/file-index.ts` (252 lines)

#### How it's populated

1. **During pull** (`/Users/ijd/repos/mackerel/src/lib/pull.ts`):

   - After writing each batch of records to main, calls `fileIndex.upsertBatch(entries)` where each entry is `{ folderPath, recordId, filename }`.
   - `upsertBatch()` uses raw SQL `INSERT ... ON CONFLICT DO UPDATE` in chunks of 500 for efficiency. Stamps `lastSeenAt = now()` on every upsert.
   - After the full pull completes, calls `fileIndex.findStaleEntries(folderPath, pullStartTime, limit)` to find records with `lastSeenAt < pullStartTime` or `lastSeenAt IS NULL`. These represent records that existed in the index but were not returned by the external service — i.e., they were deleted upstream. The stale entries are deleted from both git and the FileIndex.

2. **Auto-rebuild** (also in pull.ts):

   - Before each pull, checks if FileIndex count matches actual JSON file count on disk.
   - If diverged, triggers `fileIndex.rebuild()` to reindex.

3. **Rebuild** (`fileIndex.rebuild(gitBucket, folderPath)`):
   - Reads `.schema.json` to get `idPath` (defaults to `"id"`).
   - Lists all JSON files on main (excluding `.schema.json`, `.meta.json`).
   - For each file: reads content, extracts record ID via `idPath`, builds `{ folderPath, recordId, filename }`.
   - Upserts all entries, then removes stale entries (IDs in the index but not on disk).

#### How the publish pipeline uses it

- **`@/` resolution**: `resolveAtRefsViaIndex()` in helpers.ts — converts `@/path/to/file.json` values to real record IDs by calling `fileIndex.getRecordId(folderPath, filename)`.
- **Stripping unresolvable refs**: `stripUnresolvableAtRefs()` — checks if a `@/` target exists (has a record ID in FileIndex). If not, the field is deferred to the backfill phase.
- **Delete phase**: `runDeletePhase()` in phases.ts calls `fileIndex.getRecordId()` to find the external record ID for each file being deleted.
- **Backfill phase**: `runBackfillPhase()` calls `fileIndex.getRecordId()` to get the record ID of newly created records (which were pulled back to main after the create phase).

#### API functions

| Function            | Signature                                             | Purpose                                        |
| ------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `getFilename`       | `(folderPath, recordId) → filename \| null`           | Single lookup by record ID                     |
| `getRecordId`       | `(folderPath, filename) → recordId \| null`           | Reverse lookup by filename                     |
| `getFilenamesBatch` | `(folderPath, recordIds[]) → Map<recordId, filename>` | Batch lookup for pull efficiency               |
| `getRecordIdsBatch` | `(folderPath, filenames[]) → Map<filename, recordId>` | Batch reverse lookup                           |
| `upsertBatch`       | `(entries[]) → void`                                  | Bulk upsert with raw SQL, chunks of 500        |
| `removeBatch`       | `(entries[]) → void`                                  | Bulk delete, chunks of 500                     |
| `findStaleEntries`  | `(folderPath, before, limit) → entries[]`             | Find entries not seen since `before` timestamp |
| `countEntries`      | `(folderPath) → number`                               | Count entries for a folder                     |
| `removeAll`         | `(folderPath) → void`                                 | Clear all entries for a folder                 |
| `rebuild`           | `(gitBucket, folderPath) → number`                    | Full rebuild from git files                    |

---

### 5.2 FileReference

**Purpose**: Tracks references between files across branches. Maps "who references what" for both `@/` (unresolved) references and resolved ID references. Enables reverse lookups like "find all files that reference this file" — critical for the reference-clearing step before deletes.

**Schema** (from `/Users/ijd/repos/mackerel/prisma/schema.prisma` lines 136-148):

```prisma
model FileReference {
  id                 String  @id @default(cuid())
  gitBucket          String  // identifies the git repository
  sourceFilePath     String  // full path, e.g. "webflow/conn1/site1/books/old-man.json"
  targetFolderPath   String  // full path, e.g. "webflow/conn1/site1/authors"
  targetFileName     String? // e.g. "hemingway.json" (set for @/ refs)
  targetFileRecordId String? // e.g. "67abc123def456" (set for resolved ID refs)
  branch             String  // "main" or "dirty/{userId}"

  @@index([gitBucket, targetFolderPath, targetFileName])
  @@index([gitBucket, targetFolderPath, targetFileRecordId])
  @@index([gitBucket, sourceFilePath, branch])
}
```

**Implementation**: `/Users/ijd/repos/mackerel/src/lib/file-reference.ts` (548 lines)

#### Two types of references it tracks

1. **`@/` references (unresolved)**: File content contains strings like `"@/webflow/conn1/site1/authors/hemingway.json"`. The `@/` prefix means "this is a reference to another file in the git repo, resolve it to a real external ID at publish time." These are stored with `targetFolderPath` + `targetFileName` populated.

2. **Resolved ID references**: After a record has been created in the external service, its reference fields contain real IDs (e.g., `"67abc123def456"`) instead of `@/` paths. These are identified using the schema's `reference: true` + `referenceTarget` field metadata. Stored with `targetFolderPath` + `targetFileRecordId` populated.

#### Reference extraction (`extractReferences()`)

The core function that parses file content and returns `ExtractedRef[]`:

**Pass 1 — `@/` references**: Recursively walks all values in the JSON looking for strings starting with `"@/"`. Splits each into `targetFolderPath` + `targetFileName`.

**Pass 2 — Resolved ID references**: If a `NodeSchema` is provided, iterates schema fields with `reference: true` and `referenceTarget`. For each, reads the field value. If it's a string not starting with `@/`, stores it as `targetFileRecordId`. The `targetFolderPath` is constructed as `connectionPrefix + "/" + field.referenceTarget`.

Deduplication is applied via a `Set` keyed on `folderPath|fileName|recordId`.

#### How it's populated

1. **During writes to main** (`/Users/ijd/repos/mackerel/src/lib/storage/files.ts`):

   - `writeFilesToMain()` calls `fileReference.updateRefsForFiles(gitBucket, "main", files, schemasByFolder)`. When schemas are provided (during pull), both `@/` and resolved ID refs are extracted.
   - `deleteFilesFromMain()` calls `fileReference.removeRefsForFiles()` to clean up refs where deleted files were the source.

2. **During writes to dirty branch** (`/Users/ijd/repos/mackerel/src/lib/storage/files.ts`):

   - `writeFilesToDirty()` calls `fileReference.updateRefsForFiles(gitBucket, "dirty/{userId}", files)`. No schema is passed for user edits, so only `@/` refs are extracted.
   - `deleteFilesFromDirty()` calls `fileReference.removeRefsForFiles()`.

3. **Update pattern** (`updateRefsForFiles()`):

   - Delete all existing refs for the given source files on the given branch.
   - Extract refs from each file's content.
   - Bulk insert new refs using raw SQL `INSERT ... ON CONFLICT DO NOTHING` in chunks of 500.

4. **Backfill** (`backfillRefs(gitBucket, branch)`):
   Called after pull completes. Cross-references FileIndex to fill in missing data:

   - **Pass 1**: Refs that have `targetFileRecordId` but no `targetFileName` → look up filename in FileIndex.
   - **Pass 2**: Refs that have `targetFileName` but no `targetFileRecordId` → look up record ID in FileIndex.
     This ensures both columns are populated for optimal query performance (queries can match by either filename or record ID).

5. **Rebuild** (`rebuild(gitBucket, folderPath)`):
   - Lists all JSON files on main.
   - Reads `.schema.json` for the folder.
   - Extracts refs from every file (both `@/` and resolved ID).
   - Clears existing refs for the folder on main, inserts new ones.
   - Runs `backfillRefs()` to cross-link.

#### How the publish pipeline uses it

- **Build phase** (`/Users/ijd/repos/mackerel/src/lib/publish-pipeline/build.ts` lines 281-301):

  - For each deleted file, builds a `RefTarget` with `folderPath`, `fileName`, and `recordId`.
  - Calls `fileReference.findRefsToFiles(gitBucket, refTargets, ["main", dirtyBranch])`.
  - Returns all files that reference the files being deleted.
  - For each of those source files (excluding files themselves being deleted): reads the content, nulls out the reference fields, and writes the cleared version as a synthetic edit in the `[edit]` phase.

- **After publish** (`/Users/ijd/repos/mackerel/src/lib/publish-pipeline/run.ts` line 195):
  - `fileReference.removeRefsForBranch(gitBucket, "dirty/{userId}")` — cleans up all dirty branch refs after successful rebase.

#### API functions

| Function              | Signature                                          | Purpose                                                     |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `extractReferences`   | `(content, schema?, connPrefix?) → ExtractedRef[]` | Core extraction: finds `@/` refs + resolved ID refs         |
| `updateRefsForFiles`  | `(gitBucket, branch, files[], schemas?) → void`    | Delete-then-insert refs for a batch of source files         |
| `removeRefsForFiles`  | `(gitBucket, branch, filePaths[]) → void`          | Remove refs where given files are the source                |
| `removeRefsForBranch` | `(gitBucket, branch) → void`                       | Clear all refs for a branch                                 |
| `findRefsToFiles`     | `(gitBucket, targets[], branches?) → refs[]`       | Reverse lookup: find all refs pointing at these targets     |
| `backfillRefs`        | `(gitBucket, branch) → number`                     | Cross-reference FileIndex to fill missing fileName/recordId |
| `countRefsForFolder`  | `(gitBucket, folderPath) → number`                 | Count refs from files in a folder on main                   |
| `rebuild`             | `(gitBucket, folderPath) → number`                 | Full rebuild from git files                                 |

---

## 6. Build Phase Algorithm (step by step)

Source: `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/build.ts`

1. Generate a pipeline ID (UUID truncated to 12 chars). Create branch `publish/{userId}/{pipelineId}` from main HEAD.
2. Read dirty files via `storage.getDirtyFiles()`. Classify each as `added`, `modified`, or `deleted`.
3. **Build `[edit]` commit**:
   - Collect all user-modified files (read content from dirty branch).
   - If there are deletes, run `buildRefClearingEdits()`:
     - For each deleted file, read the record ID from main.
     - Build `RefTarget[]` with folderPath + fileName + recordId.
     - Query `fileReference.findRefsToFiles()` to find all files that reference the deleted files.
     - For each referencing file (that is NOT itself being deleted): read content from dirty branch, null out all `@/` refs pointing to deleted files AND resolved ID refs matching deleted record IDs.
   - Write all edits (user + synthetic) as a single commit with message `[edit] N edit(s) + M reference-clearing fix(es)`.
4. **Build `[create]` commit**:
   - For each added file, read from dirty branch.
   - Parse JSON, check for `@/` references.
   - For each `@/` ref, check FileIndex to see if the target exists on main. If not, strip the field and track it for backfill.
   - Write all creates as a single commit with message `[create] N new record(s)`.
5. **Build `[delete]` commit**:
   - Collect all deleted file paths.
   - Delete them from the pipeline branch with message `[delete] N record(s)`.
6. **Build `[backfill]` commit** (only if creates had unresolvable `@/` refs):
   - For each file that had deferred refs, re-read the original content from dirty (with `@/` refs intact).
   - Write them to the pipeline branch with message `[backfill] Restore @/ references for N file(s)`.
7. Return `PipelineInfo { pipelineId, branch, mergeBaseOid, phases[] }`.

Empty phases are skipped (no empty commits). If no phases are produced, the pipeline branch is deleted and an error is thrown.

## 7. Run Phase Algorithm (step by step)

Source: `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/run.ts`

1. **Validate**: Check pipeline branch still exists. Check merge base matches current main HEAD (staleness check — if main advanced, reject and ask caller to rebuild).
2. **Walk commits**: Get all commits between merge base and pipeline branch tip.
3. **For each commit**:
   - Parse `[phase-type]` from commit message.
   - Diff this commit against its parent (first commit diffs against merge base).
   - Dispatch to the appropriate phase handler.
4. **Phase handlers** (from `/Users/ijd/repos/mackerel/src/lib/publish-pipeline/phases.ts`):
   - **`runEditPhase`**: For each modified file, read current + parent versions from the pipeline branch commits. Compute changed fields by diffing. Resolve `@/` refs via FileIndex. Call `connector.publish()` with type `"update"`. Pull canonical version back to main.
   - **`runCreatePhase`**: For each added file, read content from the commit. Resolve `@/` refs via FileIndex. Call `connector.publish()` with type `"create"`. Pull canonical version back to main (gives real IDs).
   - **`runDeletePhase`**: Group deleted files by folder. Look up record IDs from FileIndex. Call `connector.bulkPublish()` with type `"delete"` in pages (respecting `bulkPublishPageSizes.delete`). Delete from main. Remove from FileIndex.
   - **`runBackfillPhase`**: For each modified file, read backfill + parent versions. Compute changed fields (the restored `@/` refs). Resolve `@/` refs via FileIndex (targets now exist on main with real IDs). Call `connector.publish()` with type `"update"`. Pull canonical version back to main.
5. **After all commits**: Rebase dirty branch onto main. Clean up dirty branch FileReference entries.
6. **Cleanup**: Delete pipeline branch on full success. Keep it on failure for debugging.
7. **Stream**: Throughout, yield NDJSON messages: `header`, `file-start`, `file-complete`, `cancelled`, `reset`, `footer`.

## 8. `@/` Reference Resolution

`@/` is a notation used in file content to represent a reference to another file in the same git repo. Example: `"author": "@/webflow/conn1/site1/authors/hemingway.json"`.

At publish time, `@/` refs are resolved to real external record IDs:

1. Parse the path after `@/` — split into folder path + filename.
2. Query `fileIndex.getRecordId(folderPath, filename)` to get the external ID.
3. Substitute the ID into the publish payload.

This resolution uses FileIndex, NOT direct git reads — so FileIndex must be populated and up-to-date.

## 9. Staleness and Error Handling

- **Staleness**: The pipeline records `mergeBaseOid` (main HEAD at build time). Before running, the runner checks if main HEAD still matches. If another user published or a pull happened, the pipeline is rejected. Rebuilding is cheap (no API calls).
- **Phase failure**: If any phase throws, the runner stops. Successfully completed phases have already written to main. The pipeline branch is preserved for debugging.
- **Per-file errors**: Individual file failures within a phase don't stop the phase — they're collected in `PhaseResult.errors`. But a thrown exception stops everything.
- **Cancellation**: AbortSignal support throughout. If aborted, yields a `cancelled` message.

## 10. UI Flow

1. User sees pending changes in the changes view.
2. Clicks "Plan Publish" → calls `POST /publish-v2/plan` → gets back `PipelineInfo` with phase breakdown.
3. UI shows phase icons (edit/create/delete/backfill) with file counts.
4. User clicks "Run Publish" → calls `POST /publish-v2/run` with the `PipelineInfo` body → streams NDJSON progress.
5. If changes occurred after planning, user can click "Re-plan" to rebuild.

## 11. Integration Points Summary

### During Pull

1. Records written to main → `fileIndex.upsertBatch()` stamps `lastSeenAt`
2. Records written to main → `fileReference.updateRefsForFiles()` with schemas (both `@/` and resolved ID refs)
3. After all batches → `fileReference.backfillRefs()` cross-links filename ↔ recordId
4. Stale detection → `fileIndex.findStaleEntries()` → delete from git + FileIndex

### During User Edits (Dirty Branch)

1. User edits file → `writeFilesToDirty()` → `fileReference.updateRefsForFiles()` (only `@/` refs, no schema)
2. FileIndex is NOT updated on dirty branch (only tracks main branch state)

### During Publish

1. Build: `fileReference.findRefsToFiles()` to find inbound refs to deleted files
2. Build: `fileIndex.getRecordId()` to check `@/` target existence for stripping
3. Run: `resolveAtRefsViaIndex()` to convert `@/` paths to real IDs via FileIndex
4. Run (delete): `fileIndex.getRecordId()` to get external IDs for deleted files
5. Run (delete): `fileIndex.removeBatch()` to clean up after successful deletes
6. After run: `fileReference.removeRefsForBranch()` to clean up dirty branch refs
