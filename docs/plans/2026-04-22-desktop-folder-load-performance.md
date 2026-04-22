# Desktop Folder Load Performance

**Date**: 2026-04-22
**Status**: Proposed

## Problem

Clicking a folder with many records (e.g. HubSpot Contacts with 1000+ files) in the desktop app takes 30-60 seconds before anything renders. The UI shows a loading spinner the entire time.

## Root Cause

`readDiffGridDataPage()` in `scratch-desktop/src/main/local-files.ts:1093` loads **every** JSON file across three branches before returning any data to the renderer:

```
readFolderSnapshots(workingPath)   // read + parse all files
readFolderSnapshots(dirtyPath)     // read + parse all files
readFolderSnapshots(masterPath)    // read + parse all files
```

For 1000 records, that's 3000 file reads + JSON parses + `flattenObject()` calls, all in the main process.

### Why it can't just paginate reads

The function needs the full dataset to compute:

1. **Summary counts** (added/modified/deleted/unpublished) — requires comparing every record across all three branches (lines 1127-1139, 1141-1149)
2. **Filter counts** (unreviewed, unpublished) — requires classifying every row (lines 1152-1155)
3. **Sorting** — sort order applies before pagination (line 1158)

Only after all that does it slice to the requested page (line 1161):

```typescript
const pagedRows = sortedRows.slice(offset, offset + limit);
```

### Bottleneck details

- `readFolderSnapshots()` (line 865) reads files in batches of 10 (`BATCH_CONCURRENCY = 10`)
- Each file: `readFile()` (async I/O) + `JSON.parse()` (sync) + `flattenObject()` (sync)
- No caching — re-clicking the same folder re-reads everything
- All work happens on the main Electron process

## Possible Approaches

### 1. Cache parsed snapshots

Cache the `Map<string, JsonFileSnapshot>` result of `readFolderSnapshots()` keyed by folder path + folder mtime. If the folder hasn't changed, skip the file reads entirely. Invalidate on file write/delete.

**Impact**: Instant on re-visit. No help on first load.

### 2. Incremental / background summary computation

Return the first page of data immediately (read only enough files to fill page 1), then compute summaries and filter counts in the background. Update the UI incrementally as counts arrive.

**Impact**: Fast initial render. Complexity in splitting the read path and streaming updates to the renderer.

### 3. Precompute a lightweight index

Maintain a per-folder index file (e.g. `.scratch/index/<folder>/status.json`) that stores each file's hash and diff status. On folder click, read the index (one file) instead of every record. Only read full file contents for the current page's rows.

**Impact**: Fast load at any scale. Requires keeping the index in sync on every file change.

### 4. Increase batch concurrency

Raise `BATCH_CONCURRENCY` from 10 to a higher value (50-100). Simple change, but trades main-process CPU pressure for speed.

**Impact**: Moderate speedup (maybe 2-3x). Doesn't solve the fundamental O(n) problem.

### 5. Move file reads to a worker thread

Offload `readFolderSnapshots()` to a Node.js worker thread so the main process stays responsive. Doesn't reduce total time but unblocks the UI.

**Impact**: UI stays responsive during load. Same total wait time.

## Recommended Path

Start with **approach 1 (caching)** — it's the simplest change with the biggest payoff for repeated navigation. Combine with **approach 4 (higher concurrency)** for a quick win on first load.

For a proper fix at scale, **approach 2 or 3** would be needed, but they're significantly more complex.
