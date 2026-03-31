# Sync Performance Optimization

## Context

Sync is a full transform pass across all files in a workbook — every record is read, transformed, and compared regardless of whether it changed. This is by design. The problem is that this full pass is slow: a 13-table sync with ~35K total records across source and destination folders takes 10+ minutes and sometimes hangs indefinitely.

**Profiled run** (2026-03-31, `syn_p3NGLREgze` — Airtable -> Webflow, 13 table pairs):

| Metric                           | Value                                            |
| -------------------------------- | ------------------------------------------------ |
| Tables                           | 13                                               |
| Largest source folder (Products) | 11,920 files                                     |
| Largest source folder (Used)     | 21,444 files                                     |
| Slow API calls (>100ms)          | 283                                              |
| Avg slow call duration           | 733ms                                            |
| Total time in slow git reads     | 200s                                             |
| Sync outcome                     | Hung during FK resolution pass on Products table |

### Per-folder breakdown of git read time

| Folder                                  | Calls | Total Time |
| --------------------------------------- | ----- | ---------- |
| Extreme (Copy)/Products (source)        | 53    | 68.4s      |
| Copy of ExtremeHiFi/Products (dest)     | 52    | 46.8s      |
| Extreme (Copy)/Used (source)            | 88    | 39.7s      |
| Copy of ExtremeHiFi/Dealer Useds (dest) | 44    | 21.1s      |
| All other folders combined              | 46    | ~24s       |

---

## Primary Bottleneck: scratch-git-2 `files-paginated` Performance

The `files-paginated` endpoint is the dominant cost in every sync run. Each call reads up to 1000 files and takes 700ms-1.3s. A folder with 12K files requires 12+ paginated requests, each re-walking the entire directory.

### Current Implementation (read.rs:316-396)

```
Request arrives
  → Open git repo
  → Walk tree to target folder (read_tree_at_path)
  → Collect ALL entries in the folder (even if we only need 1000)
  → Sort entries alphabetically
  → Linear scan to find cursor position
  → Take next `limit` entries
  → For each entry: individual blob read via repo.find_object(oid)
  → Serialize all file contents as JSON
  → Return response
```

### Identified Issues

**1. N+1 blob reads** (biggest cost, ~80% of request time)

- Each file's content is read individually via `read_blob_to_string(oid)` → `repo.find_object(oid)`
- For 1000 files per page, that's 1000 separate git object lookups
- Each lookup involves finding the object in the packfile, decompressing it, and converting to string
- No batch API exists in the current code

**2. Full tree walk on every page**

- Every pagination request re-walks the entire folder tree, even for page 12 of 12
- For a 12K-file folder, this means loading and sorting 12K entries before returning 1000
- The cursor is found by linear scanning the sorted list

**3. No caching**

- No in-memory cache for tree listings or blob content
- The same folder's tree is walked identically on consecutive pagination requests
- The same blobs may be read multiple times across passes

**4. Linear cursor scan**

- `file_entries.iter().position(|(name, _)| name == cursor)` — O(n) on every request
- For the last page of a 12K folder, scans ~11K entries before finding the cursor

---

## Optimization Options

### Option 1: Batch blob reads in scratch-git-2

**Approach**: Instead of reading blobs one at a time, read them in a batch operation. The gix library may support more efficient object access patterns (e.g., reading from packfiles in sequence).

**Expected impact**: 3-5x speedup on `files-paginated` for content reads. The 1000 individual `find_object` calls are the dominant cost.

**Possible approaches**:

- Use gix's pack traversal to read multiple objects in a single packfile scan
- Pre-sort OIDs to enable sequential packfile access
- Use a thread pool to parallelize blob reads (Rust makes this safe)

**Complexity**: Medium. Requires understanding gix's internal object access patterns.

### Option 2: Cache tree listings across pagination requests

**Approach**: Cache the sorted `(name, oid)` list for a folder after the first pagination request. Subsequent pages reuse the cached list instead of re-walking the tree.

**Expected impact**: 2-3x speedup for large folders on pages 2+. The tree walk + sort is ~100-200ms per request for large folders.

**Implementation sketch**:

- In-memory LRU cache keyed by `(repo_id, branch, folder, commit_oid)`
- Invalidated when commit OID changes (ensures consistency)
- Could also cache at the folder tree OID level for better hit rates

**Complexity**: Low. Straightforward cache layer.

### Option 3: Expose a bulk file-read endpoint

**Approach**: New endpoint that accepts a list of file paths and returns all their contents in one request. The sync server would first get the file listing (metadata-only, which is fast), then fetch all contents in a single HTTP call.

**Expected impact**: Eliminates pagination overhead entirely. One tree walk + one bulk blob read per folder per pass. Could also enable the server to skip known-unchanged files.

**Implementation sketch**:

```
POST /api/repo/read/{id}/files-bulk
Body: { branch: "dirty", paths: ["Products/foo.json", "Products/bar.json", ...] }
Response: { files: [{ path, content }, ...] }
```

**Complexity**: Low-medium. New endpoint, but blob reading logic already exists.

### Option 4: Stream file contents instead of buffering

**Approach**: Return file contents as a streaming response (NDJSON or similar) instead of collecting all 1000 files into a single JSON array before sending.

**Expected impact**: Reduces memory pressure and time-to-first-byte, but doesn't reduce total I/O time. Most useful for very large pages.

**Complexity**: Medium. Requires changing the response format and client-side parsing.

### Option 5: Memory-mapped or pre-loaded packfile access

**Approach**: Keep the git packfile memory-mapped across requests so that object lookups avoid repeated file open/seek overhead.

**Expected impact**: Modest (10-30% improvement on blob reads). Only helps if the OS page cache isn't already keeping the packfile hot.

**Complexity**: Low if gix supports it natively.

---

## Secondary Optimization: Server-side Caching Between Passes

The sync service reads each folder 3+ times per sync run:

1. Pass 1: Read source files (fill match key caches)
2. Pass 1: Read destination files (fill match key caches)
3. Pass 2: Read source files again (transform and compare)
4. FK pass: Read source files again (for tables with FK columns)

### Option: Cache parsed records between passes

**Approach**: After Pass 1 reads source/dest files, store the parsed records in an in-memory Map keyed by file path. Pass 2 and the FK pass reuse this cache instead of re-reading from git.

**Expected impact**: Eliminates ~40% of git API calls. For the profiled sync, this would save ~80s of git read time.

**Trade-off**: Memory usage. 35K JSON records could be 500MB+ in memory. May need to be selective about which tables to cache (small tables: always cache; large tables: stream).

**Implementation sketch** (in `sync.service.ts`):

```typescript
// Pass 1: Build cache while reading
const sourceRecordCache = new Map<string, ParsedRecord>();
// ... in the pagination loop:
for (const file of page.files) {
  const record = parseRecord(file.content);
  sourceRecordCache.set(file.path, record);
}

// Pass 2: Read from cache instead of git
for (const [path, record] of sourceRecordCache) {
  // transform and compare
}
```

**Complexity**: Low. The data structures already exist; this is plumbing.

---

## Hang Bug (RESOLVED)

### Root Cause

The sync appeared to "hang" during FK resolution because the `source_fk_to_dest_fk` transformer was making **one Prisma `findFirst` query per FK array element**. For the Products table (11,920 records × 7 FK columns × ~117 avg FK references per record), this produced an estimated **1.4 million sequential DB queries**. At ~2ms per query, that's ~47 minutes of wall-clock time with no log output between batch boundaries — making it look frozen.

The `Dealers That Carry Them` field was the worst offender: each product referenced ~103 dealers, meaning 1.2M lookups for just that one field.

### Fix Applied

Replaced the per-element DB query in `lookup-tools.ts` with a lazy-loaded in-memory Map. On first access for a given `(syncId, referencedDataFolderId)` pair, all mappings are bulk-loaded from `SyncRemoteIdMapping` into a Map. Subsequent lookups are O(1) in-memory.

- **Before**: ~1.6M individual Prisma queries across all FK tables
- **After**: 13 bulk queries (one per referenced folder), max 21K rows per query (~2.5MB)

### Before/After Comparison

| Metric              | Before (hung)     | After (completed)        |
| ------------------- | ----------------- | ------------------------ |
| Outcome             | Hung indefinitely | Completed successfully   |
| Total time          | >10min (killed)   | **522s (~8.7 min)**      |
| Slow API calls      | 283               | 189                      |
| Total git read time | 200s              | 126s                     |
| FK resolution       | Never finished    | All 8 FK tables resolved |

The remaining ~8.7 minutes is dominated by scratch-git-2 file reads (see Primary Bottleneck section above).

---

## Recommended Priority

1. **Fix the hang bug** — reliability before performance
2. **Option 2** (cache tree listings) — low effort, helps all paginated reads
3. **Option 1** (batch blob reads) — highest impact on the core bottleneck
4. **Server-side caching between passes** — eliminates redundant reads
5. **Option 3** (bulk file-read endpoint) — cleanest long-term solution, enables future optimizations
