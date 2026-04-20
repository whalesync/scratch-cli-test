# Plan: SQLite Index for Staging File Tracking

**Created:** 2026-04-20

## Problem

During a "pull all" operation, Phase 2 (processing staged files) has severe I/O inefficiency on the scratch-git VM:

1. **`read_staged_files`**: Each paginated call walks the entire staging directory tree, sorts all paths, then skips to the requested offset. For 100k files in batches of 100, this means 1,000 calls each walking and sorting 100k paths — O(n² log n) total.

2. **`commit_staged`**: Previously loaded all file contents into memory at once. Already fixed to batch in chunks of 500 (commit `369c0408`), but still walks the full directory on each call.

3. **No resumability**: If the server dies mid-Phase-2, there's no record of which files were already processed or committed. The job must restart from the beginning.

These issues contributed to a production outage on 2026-04-17 when a pull-all saturated the scratch-git VM's disk I/O for 2+ hours, starving sshd and blocking deploys.

## Approach

Replace directory-walk-based pagination with a SQLite index file stored in the staging directory. The SQLite database tracks which files have been staged, processed (indexed in Postgres), and committed (written to git).

### SQLite Schema

File location: `{staging_dir}/{jobId}/index.db`

```sql
CREATE TABLE staged_files (
  path TEXT PRIMARY KEY,
  folder TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  committed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_unprocessed ON staged_files(folder, processed);
CREATE INDEX idx_uncommitted ON staged_files(folder, committed);
```

- `processed = 0` → not yet indexed in Postgres
- `processed = 1` → indexed in Postgres (file index, file references, asset index)
- `committed = 0` → not yet committed to git
- `committed = 1` → committed to git

### Complexity Improvement

| Operation                      | Before                           | After                     |
| ------------------------------ | -------------------------------- | ------------------------- |
| `read_staged_files` (per call) | O(n log n) directory walk + sort | O(batch) SQLite query     |
| `read_staged_files` (total)    | O(n² log n)                      | O(n)                      |
| `commit_staged` (per call)     | O(n) directory walk              | O(batch) SQLite query     |
| Resume after crash             | Restart from beginning           | Pick up where we left off |

## Changes

### scratch-git (Rust) — `staging.rs`

#### 1. `stage_files` — modify existing

`POST /api/staging/{jobId}/files` — body: `{ folder, files: [{ path, content }] }`

After writing files to disk (unchanged), also insert their paths into the SQLite index:

```rust
INSERT INTO staged_files (path, folder) VALUES (?1, ?2)
```

The SQLite database is created lazily on the first `stage_files` call for a given jobId.

#### 2. `read_staged_files` — modify existing

`GET /api/staging/{jobId}/files?folder=X&limit=100`

**Remove the `offset` parameter.** Instead, query SQLite for unprocessed files:

```sql
SELECT path FROM staged_files WHERE folder = ?1 AND processed = 0 LIMIT ?2
```

For each returned path, read file content from disk by direct path (O(1) per file). Return:

```json
{ "files": [{ "path": "...", "content": "..." }], "remaining": 4500 }
```

The `remaining` count lets NestJS track progress. The `total` field from the old response is replaced by `remaining` since that's more useful for progress reporting.

#### 3. `mark_staged_files_processed` — new endpoint

`POST /api/staging/{jobId}/processed` — body: `{ folder, paths: string[] }`

Marks files as processed in SQLite:

```sql
UPDATE staged_files SET processed = 1 WHERE folder = ?1 AND path IN (?2...)
```

Returns: `{ "count": 100 }`

#### 4. `commit_staged` — modify existing

`POST /api/staging/{jobId}/commit` — body: `{ repoId, folder, branch?, message?, batchSize? }`

**Add `batchSize` parameter** (default 1000). Instead of committing all files in one call:

```sql
SELECT path FROM staged_files WHERE folder = ?1 AND committed = 0 LIMIT ?2
```

Read content for those paths, commit to git, then mark them:

```sql
UPDATE staged_files SET committed = 1 WHERE folder = ?1 AND path IN (?2...)
```

Return:

```json
{
  "success": true,
  "committed": 1000,
  "remaining": 2200,
  "created": ["Products/new-file.json"],
  "updated": ["Products/existing.json"],
  "unchanged": []
}
```

NestJS loops until `committed === 0`.

#### 5. `cleanup_staging` — no change

`DELETE /api/staging/{jobId}`

Already does `remove_dir_all` on the staging directory — this deletes the SQLite file along with everything else.

### NestJS — `pull-linked-folder-files-v2.job.ts`

#### `processFolder` — modify Phase 2

Replace the current sequential offset-based loop + single commit call with two symmetric loops.

**Pass `abortSignal` into `processFolder`** (currently not passed) and check it at the top of each iteration. Each `await` yields to the event loop, giving BullMQ a chance to set `abortSignal.aborted` when the user cancels or the server is shutting down. Worst-case latency is one batch cycle.

```typescript
// --- Index loop: read staged files and update DB indexes ---
while (true) {
  if (abortSignal.aborted) throw new JobCanceledError(jobId);

  const batch = await this.scratchGitService.readStagedFiles(jobId, stagingFolder, batchSize);
  if (batch.files.length === 0) break;

  const builtFiles = /* ... hydrate from batch ... */;

  await Promise.all([
    this.updateFileIndex(folderCtx, builtFiles),
    this.updateFileReferences(folderCtx, builtFiles),
    this.updateAssetIndex(folderCtx, builtFiles),
  ]);

  await this.scratchGitService.markStagedFilesProcessed(
    jobId, stagingFolder, batch.files.map(f => f.path)
  );

  await checkpoint(progress);
}

// --- Commit loop: commit staged files to git in batches ---
while (true) {
  if (abortSignal.aborted) throw new JobCanceledError(jobId);

  const result = await this.scratchGitService.commitStagedFiles(
    jobId, repoId, MAIN_BRANCH, stagingFolder, message, 1000
  );
  if (result.committed === 0) break;

  pullStats.created += result.created.length;
  pullStats.updated += result.updated.length;
  // ... update publicProgress ...

  await checkpoint(progress);
}
```

Both loops are:

- **Bounded**: each HTTP call handles at most `batchSize` files
- **Resumable**: SQLite state persists across crashes — unprocessed/uncommitted files are picked up on restart
- **Cancellable**: `abortSignal` checked each iteration via event loop yield on `await`
- **Progress-tracked**: BullMQ checkpoint after each batch

#### `scratchGitService` — add/modify methods

- `readStagedFiles(jobId, folder, limit)` — remove `offset` parameter
- `markStagedFilesProcessed(jobId, folder, paths)` — new method
- `commitStagedFiles(jobId, repoId, branch, folder, message, batchSize)` — add `batchSize` parameter, handle new response shape

### What doesn't change

- Phase 1 fetch logic (connector API calls, `onBatch` callback structure)
- Post-processing (`rebaseDirty`, `runGitGc`, `buildIndex`)
- `collect_paths_recursive` — kept for any future use but no longer called in the hot path
- `cleanup_staging` — `remove_dir_all` covers the SQLite file
- Smoke tests — they operate at the API level above this

## Dependencies

- `rusqlite` crate needs to be added to `scratch-git-2/Cargo.toml`

## Risks

- **SQLite write contention during Phase 1**: Multiple folders can be fetched in parallel, each calling `stage_files` concurrently. SQLite handles concurrent readers well but serializes writes. Since each `stage_files` call is a quick batch insert, this should be fine — but worth monitoring.
- **SQLite file corruption on hard VM reset**: If the VM is hard-reset during a write to the SQLite file, the database could be corrupted. This is acceptable because the staging directory is ephemeral — a corrupted index just means the pull job restarts from scratch on resume, same as today's behavior.
