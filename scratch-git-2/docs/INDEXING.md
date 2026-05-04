# Record Index and Validation

The `scratchmd` CLI maintains a SQLite database (`.scratch/scratch.db`) inside the workspace. This database stores two things:

1. **`record_index_v1`** — a lightweight index of every record file on disk, used to detect which files are stale (changed since last index run).
2. **`validation_results_v1`** — cached validation violations, computed during the last `refresh-record-index` run.

The desktop app reads both tables via IPC. It never computes validation results itself.

---

## record_index_v1 schema

```sql
CREATE TABLE record_index_v1 (
    folder_path       TEXT NOT NULL,
    file_name         TEXT NOT NULL,
    content_hash      TEXT NOT NULL,   -- SHA-256 of file bytes
    processor_version TEXT NOT NULL,   -- bumped when validator logic changes
    mtime_ns          INTEGER NOT NULL DEFAULT 0,
    file_size_bytes   INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (folder_path, file_name)
);
```

---

## Staleness detection and indexing

`refresh-record-index` walks every record file in every connection directory and decides whether each file needs re-indexing. The decision uses a two-step check:

**Step 1 — fast path (mtime + size)**

Compare the file's current `mtime_ns` and `file_size_bytes` against the stored row. If both match, the file is considered up to date and skipped.

**Step 2 — hash check (only when step 1 fails)**

If the mtime or size differs, read the file and compute its SHA-256 hash. Compare against `content_hash` in the index row:

- **Hash differs** → file has genuinely changed. Run validators, upsert the row with the new hash, mtime, and size.
- **Hash same** → the file was modified then reverted (same bytes, different mtime). No re-validation needed. Update only `mtime_ns` and `file_size_bytes` in the stored row so the fast path passes next time.

The hash is never computed unless `mtime_ns` or `file_size_bytes` has changed first. This keeps indexing fast for large workspaces where most files are unchanged.

---

## CLI commands

### Re-index and re-validate

```bash
# Re-index the entire workspace (all connections, all folders)
scratchmd refresh-record-index --workspace .

# Re-index specific files only (comma-separated or repeated flag)
scratchmd refresh-record-index --path posts/post-1.json --path posts/post-2.json --workspace .
```

`refresh-record-index` both updates the index and writes fresh validation results. It is the single entry point for both operations — there is no separate "validate only" command.

### Inspect stale files without re-indexing

```bash
# Show which files on disk differ from the stored index (does not write anything)
scratchmd list-stale-records --workspace .
```

`list-stale-records` performs the same mtime/size comparison as `refresh-record-index` but never updates the database. Use it to audit staleness without triggering a full revalidation.

### Read validation results

```bash
# Results for a single record
scratchmd get-validation-results --record posts/post-1.json --workspace .

# Results for an entire folder (aggregated)
scratchmd get-folder-validation-results --folder posts --workspace .

# Print the active validation config without touching the DB
scratchmd dump-validation-config --workspace .
```

---

## File watching (desktop app)

The desktop app uses [chokidar](https://github.com/paulmillr/chokidar) to watch for filesystem changes and trigger automatic re-indexing.

### What is watched

Each connection directory root is watched (e.g. `my-connection/`). The `.scratch/` directory and `.git/` are excluded — they contain internal state and their changes do not require re-indexing record files.

### Debounce

Changes are debounced with a **500 ms** window. Multiple rapid writes (e.g. a bulk download) are collapsed into a single refresh trigger.

### Internal mutation guard

When the app itself writes to the workspace (e.g. a pull or publish operation), it wraps the operation in `beginInternalWorkspaceMutation`. This increments a counter. Any file change events that arrive while the counter is positive (or within a **1 500 ms grace period** after it drops to zero) are tagged `source: 'internal'`.

The resulting `WorkspaceFilesChangedEvent` carries a `source` field:

- `'external'` — a change arrived from outside the app (user edited a file directly, an external tool ran, etc.)
- `'internal'` — the change was caused by the app itself

The renderer uses `source` to decide whether to show a "files changed" notification and how to animate the UI refresh.

### What happens on a detected change

1. chokidar fires an `add` / `change` / `unlink` event for one or more files.
2. Events are buffered for 500 ms, then flushed as a `WorkspaceFilesChangedEvent`.
3. The desktop calls `refreshRecordIndex(workspacePath)` (no path filter) via IPC.
4. `scratchmd refresh-record-index` runs, updates the index, rewrites validation results.
5. The problems panel refreshes via its existing polling / event subscription.

Validation runs are serialised — if a refresh is already in-flight when another change arrives, the new run is queued and starts after the current one completes.

---

## How the desktop reads record files

The record index is **not** used to serve file content to the UI. The `FolderDataGrid` component reads record files directly from disk at display time via `readDiffGridData`. It reads three copies of each record in parallel:

| Copy | Path |
|---|---|
| Working (current) | `<connection>/<folder>/` |
| Dirty | `.scratch/connections/scratch/<connection>/<folder>/dirty/` |
| Master | `.scratch/connections/scratch/<connection>/<folder>/main/` |

The diff between dirty and master is what drives the "changed" / "unchanged" column highlighting in the grid.

The index is only consulted for validation results (`validation_results_v1`) — it has no role in deciding what data to display.

---

## Relationship between INDEXING.md and VALIDATION.md

This document covers when and how indexing runs, staleness detection, and file watching. For the validation rule format, built-in validators, Python validators, and the `validation_results_v1` schema, see [`VALIDATION.md`](VALIDATION.md).
