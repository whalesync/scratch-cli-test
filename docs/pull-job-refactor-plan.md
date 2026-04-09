# Pull Job Refactor Plan

**File:** `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts`

**Goal:** Make this job clear to read, memory-efficient, and robust on resume.

---

## Problems

### Memory

1. **`gitFiles` accumulates full file content** (line 398: `gitFiles = gitFiles.concat(batchGitFiles)`).
   Only paths are needed for the deletion step, but content is held too. A folder with 10k records
   can easily push this to hundreds of MB.

2. **Double `JSON.parse` per file in the callback.** `buildGitFilesFromConnectorFiles` stringifies
   each record, then the callback parses it back at lines 413 and 451 to build index entries and
   extract assets. Every file gets serialized once and deserialized twice.

### Correctness

3. **`pullStats` counts are wrong for large pulls.** Lines 603-605 count
   `publicProgress.createdPaths.length`, which is capped at `MAX_PROGRESS_PATHS = 100`. Any folder
   with >100 changes reports wrong stats to PostHog.

4. **Deletion is skipped entirely on resume** (line 539). The comment acknowledges `gitFiles` only
   has partial data after resume, so stale files survive until the next full pull.

5. **`abortSignal` is accepted but never checked.** A cancelled job runs to completion.

### Clarity

6. **`pullFolder` is ~500 lines** doing schema refresh, file building, git commits, three index
   updates, asset extraction, deletion, rebase, GC, progress tracking, event emission, and error
   handling — all in one method with a 150-line closure callback.

7. **Mutable state shared via closure.** The callback captures and mutates `gitFiles`,
   `usedFileNames`, `publicProgress`, `totalFilesAccumulator`, and `completedFolderIds`.

8. **Inconsistent log source names.** "DownloadLinkedFolderFilesJob" at lines 564/582 vs
   "PullLinkedFolderFilesJob" everywhere else.

---

## Changes

### 1. Fix the memory bug: track paths, not content

Replace `gitFiles: { path: string; content: string }[]` with `pulledPaths: Set<string>`.

After `commitFilesToBranch`, add each file's path to the Set. The deletion step at line 549
already only uses paths. This is the single highest-impact change.

### 2. Avoid double JSON.parse by passing structured data through the pipeline

Change `buildGitFilesFromConnectorFiles` to return a richer object:

```ts
type BuiltFile = {
  path: string; // full git path (e.g. /folder/file.json)
  content: string; // formatted JSON string for git commit
  recordId: string; // extracted from the record
  parsedRecord: Record<string, unknown>; // the original record object
};
```

The callback can then use `parsedRecord` directly for index updates and asset extraction
instead of re-parsing `content`. `formatJsonWithPrettier` is just `JSON.stringify(data, null, 2)`
so there's no reason to parse its output back.

### 3. Track actual counts separately from capped path arrays

Add counters to `publicProgress`:

```ts
createdCount: number; // actual count, not capped
updatedCount: number;
deletedCount: number;
```

Use these for PostHog stats. Keep the path arrays capped at `MAX_PROGRESS_PATHS` for UI display.

### 4. Fix deletion on resume

Instead of skipping deletion when `isResuming`, query git for the list of files that existed
before the pull started. We already checkpoint at the start of each folder — store the
pre-pull file list (just paths) in `jobProgress` if the folder has few enough files, or
accept the query cost of `listRepoFiles` to rebuild it.

Simpler approach: on resume, union the `pulledPaths` Set with files committed since the job's
start timestamp (available from git log). This gives a complete picture without holding
everything in memory from the start.

### 5. Extract the callback into named methods

Break the 150-line callback into focused methods on the class:

```
commitBatch(repoId, builtFiles, folderContext) → CommitResult
updateFileIndex(builtFiles, folderContext)
updateFileReferences(builtFiles, folderContext, schema)
updateAssetIndex(builtFiles, folderContext, connector, schema)
```

Each method is ~20-30 lines, testable in isolation, and doesn't rely on closure state.

The callback itself becomes a ~30-line orchestrator:

```ts
const onBatch = async ({ files, connectorProgress }) => {
  const builtFiles = buildGitFilesFromConnectorFiles(...);
  const commitResult = await this.commitBatch(repoId, builtFiles, folderCtx);

  for (const path of builtFiles.map(f => f.path)) pulledPaths.add(path);

  await this.updateFileIndex(builtFiles, folderCtx);
  await this.updateFileReferences(builtFiles, folderCtx, tableSpec);
  await this.updateAssetIndex(builtFiles, folderCtx, connector, tableSpec);

  this.trackBatchProgress(publicProgress, commitResult, files.length);
  await checkpoint({ publicProgress, jobProgress, connectorProgress });
};
```

### 6. Check `abortSignal`

Add checks at the top of the callback and before expensive operations (commit, rebase, deletion):

```ts
if (abortSignal.aborted) return;
```

For the callback, throw an error that the connector's `pullRecordFiles` loop will propagate up,
or return early if the connector supports it.

### 7. Extract `pullFolder` into phases

The current method does everything sequentially. Break it into clearly named phases:

```
pullFolder:
  1. validateAndLoadFolder()     — DB lookup, connector setup
  2. refreshSchema()             — fetch + write schema to git
  3. pullAndCommitRecords()      — the batch loop (calls onBatch callback)
  4. deleteStaleFiles()          — compare pulled paths vs git, remove extras
  5. finalizeFolder()            — rebase, GC, emit events, checkpoint
```

Each phase is a private method. `pullFolder` becomes a ~40-line orchestrator that's easy to
read top-to-bottom.

### 8. Fix log source names

Replace "DownloadLinkedFolderFilesJob" with "PullLinkedFolderFilesJob" at lines 564 and 582.

---

## Order of operations

These changes are mostly independent and can be landed in separate commits:

| Order | Change                              | Risk                                               | Impact                     |
| ----- | ----------------------------------- | -------------------------------------------------- | -------------------------- |
| 1     | Track paths not content (#1)        | Low — drop-in replacement                          | Fixes memory blowup        |
| 2     | Fix stats counting (#3)             | Low — additive                                     | Fixes wrong PostHog data   |
| 3     | Fix log source names (#8)           | None                                               | Cleanup                    |
| 4     | Check abortSignal (#6)              | Low                                                | Fixes ignored cancellation |
| 5     | Avoid double parse (#2)             | Medium — touches `buildGitFilesFromConnectorFiles` | Memory + perf              |
| 6     | Extract callback into methods (#5)  | Medium — structural refactor                       | Readability                |
| 7     | Extract pullFolder into phases (#7) | Medium — structural refactor                       | Readability                |
| 8     | Fix deletion on resume (#4)         | Higher — changes resume semantics                  | Correctness                |
