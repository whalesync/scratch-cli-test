# Pull Job Refactor Plan

**File:** `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts`

**Goal:** Make this job clear to read, memory-efficient, and robust on resume.

**Status:** Implemented (except #4 — deletion on resume). Landed in branch `cfonger-17`.

---

## Problems (all fixed except #4)

### Memory

1. ~~**`gitFiles` accumulates full file content.**~~ **Fixed.** Replaced with `pulledPaths: Set<string>`.

2. ~~**Double `JSON.parse` per file in the callback.**~~ **Fixed.** `BuiltFile` now carries
   `parsedRecord` (a reference to the original connector record object) alongside the stringified
   `content`. Downstream consumers use `parsedRecord` directly — no re-parsing.

### Correctness

3. ~~**`pullStats` counts are wrong for large pulls.**~~ **Fixed.** Added `createdCount`,
   `updatedCount`, `deletedCount` to `PullLinkedFolderFilesPublicProgress`. PostHog and UI use
   actual counts; path arrays remain capped at 100 for UI display. Client and desktop updated to
   prefer count fields with fallback to `.length` for backward compatibility.

4. **Deletion is skipped entirely on resume.** Still skipped — `pulledPaths` only contains files
   from the resumed portion, so deletion based on incomplete data would incorrectly remove files.
   Deletion happens on the next full (non-resumed) pull. A future fix could query git for files
   committed since the job started to reconstruct the full set.

5. ~~**`abortSignal` is accepted but never checked.**~~ **Fixed.** Checked at the top of the
   `onBatch` callback and in the main folder loop.

### Clarity

6. ~~**`pullFolder` is ~500 lines.**~~ **Fixed.** Split into four phases (`loadFolderAndConnector`,
   `pullAndCommitRecords`, `deleteStaleFiles`, `finalizeFolder`) and four batch methods
   (`commitBatch`, `updateFileIndex`, `updateFileReferences`, `updateAssetIndex`).

7. ~~**Mutable state shared via closure.**~~ **Fixed.** The callback only captures `pulledPaths`
   (Set) and `usedFileNames` (Set). All other state is passed explicitly via `FolderContext` and
   method parameters.

8. ~~**Inconsistent log source names.**~~ **Fixed.** Single `LOG_SOURCE` constant used everywhere.

---

## Remaining work

### Fix deletion on resume (#4)

**Risk:** Higher — changes resume semantics.

Instead of skipping deletion when `isResuming`, reconstruct the full set of pulled paths by
querying git for files committed since the job started. This lets deletion work correctly even
on resumed runs.

Approaches:
- Store the pre-pull file list (just paths) in `jobProgress` at the start of each folder
- Or: union `pulledPaths` with files committed since the job's start timestamp (from git log)
