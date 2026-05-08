# Folder Index — How It Works

The folder-index is a per-connection SQLite database that drives the data grid, diff view, and validation UI in the desktop app. This document describes every command that can mutate it, what each one reads from disk, and how validation is woven into the indexing pipeline.

> **Note**: The now-deleted `INDEXING.md` and `VALIDATION.md` described an older system (`record_index_v1` / `validation_results_v1` at `.scratch/scratch.db`). The folder-index described here replaced that system entirely — validation reads (`get-validation-stats`, `get-folder-validation-results`, `get-filenames-with-errors`) all query the folder-index DB.

---

## One database per connection

Each connection gets one SQLite DB at `.repos/<connection_dir_name>.db`. It contains one table per leaf folder, plus the shared `validation_results` table described below.

---

## Three file trees

Every record lives in up to three on-disk locations:

| Tree | Path | Meaning |
|---|---|---|
| **Working** | `<workspace>/<connection>/<folder>/` | Current edits; what the user is looking at |
| **Dirty** | `<workspace>/.scratch/connections/dirty/<connection>/<folder>/` | Accepted (reviewed) changes, not yet published |
| **Master** | `<workspace>/.scratch/connections/master/<connection>/<folder>/` | Last published state |

A record can be present in any combination of the three trees. The grid always shows the working version if it exists, falling back through dirty → master.

---

## Folder-index schema

Each connection gets one DB file. Inside it, each leaf folder gets its own table, named by sanitising the folder path (e.g. `public/posts` → `public_posts`). There is also one shared table:

### Per-folder record table

```sql
CREATE TABLE IF NOT EXISTS "<table_name>" (
    filename        TEXT PRIMARY KEY,

    -- Working tree
    working_mtime   INTEGER,   -- Unix ns; NULL if file absent
    working_size    INTEGER,   -- bytes; NULL if file absent

    -- Dirty tree
    dirty_mtime     INTEGER,
    dirty_size      INTEGER,

    -- Master tree
    master_mtime    INTEGER,
    master_size     INTEGER,

    -- Derived flags (computed from JSON content)
    approved_changes   INTEGER NOT NULL DEFAULT 0,   -- dirty == master
    unapproved_changes INTEGER NOT NULL DEFAULT 0,   -- dirty != master
    has_errors         INTEGER NOT NULL DEFAULT 0,   -- any error-level validation result

    -- Optional per-field columns (added on demand)
    -- e.g. "fields.title"       TEXT
    --      "fields.title:mt"    INTEGER   (mtime of working file when column was last written)
    --      "fields.title:sz"    INTEGER   (size of working file when column was last written)
);
```

### `validation_results`

```sql
CREATE TABLE IF NOT EXISTS validation_results (
    folder_path    TEXT NOT NULL,   -- e.g. "my-connection/public/posts"
    filename       TEXT NOT NULL,
    field_path     TEXT NOT NULL,
    validator_kind TEXT NOT NULL,
    level          TEXT NOT NULL,   -- 'error' | 'warning'
    message        TEXT,
    description    TEXT,
    fixable        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (folder_path, filename, field_path, validator_kind)
);
```

Stores per-record validation violations for the connection. Written during `reindex_files_full` for any record that is stale and has a `validation.json` config. The `has_errors` flag on the per-folder table is derived from this table and denormalised for fast filtering.

`folder_path` is embedded directly in the PK so that `get-validation-stats` and `get-folder-validation-sample` can query by folder without a separate metadata table.

---

## Commands that write to the folder-index

### `reindex-table --folder <folder>`

**Full rebuild for one folder.** Drops all rows in the folder's table, reads every JSON file from all three trees, recomputes all flags and field values, runs validators, rewrites `validation_results` rows for this folder's records.

**What it reads from disk:**
- `stat()` (mtime + size) for every file in all three trees
- Full JSON parse of every file in all three trees (not just working)
- `validation.json` config if present

**Cost:** proportional to the total number of records × number of tree versions present. Parses every JSON file.

---

### `reindex-workspace`

Calls `reindex-table` for every leaf folder in the workspace. Iterates `listFolders` in the desktop (which handles multi-level paths like `connection/schema/table` for PostgreSQL).

---

### `paginate-records` → `run_query` (incremental path)

**Lazy incremental update, called on every grid page load.** The reindex path is selected by the `reindex` flag in `QueryOptions`; the normal grid load uses the incremental path.

#### Step 1 — classify stale files (`find_stale`)

Two non-overlapping stale sets are computed:

**`find_stale_working` — base staleness (mtime/size, no JSON reads)**

Detects files whose working mtime/size changed vs stored values, plus rows that claim a working file that is now gone.

Two modes:
- **Cold path** (table is empty — `row_count == 0`): scans all three trees and returns every filename on disk. This handles the initial seed when the desktop first opens a workspace. No mtime comparison — just filesystem listing. Note: `run_query` always creates the DB and ensures schema before calling `find_stale_working`, so the cold-path trigger is an empty table, not a missing DB file.
- **Hot path** (table has rows): scans only the working tree. Compares `stat()` of each working file against `working_mtime`/`working_size` in the stored row. Dirty and master are **not** scanned here — the desktop triggers explicit `reindex-table` calls after any dirty/master mutation (see [Desktop-triggered reindexes](#desktop-triggered-reindexes) below).

**What it reads from disk:** `stat()` on working tree files only (hot path), or filesystem listing of all three trees (cold path). Never opens or parses JSON.

**`find_stale_columns` — column staleness (mtime check, no JSON reads)**

For rows whose base stats are current, checks whether any active field columns (e.g. `fields.title`) are stale relative to `working_mtime`. A column is stale when its `:mt` timestamp differs from `working_mtime`.

**What it reads from disk:** only the stored `:mt` values from the DB — no disk I/O beyond the initial check.

#### Step 2 — reindex base-stale files (`reindex_files_full`)

For each file in `base_stale`:
1. `stat()` all three versions (working, dirty, master)
2. Read and parse JSON from each version that exists on disk
3. Compute `approved_changes` (dirty content == master content), `unapproved_changes` (dirty != master), field values
4. Run validators if a `validation.json` is present; write/delete rows in `validation_results`
5. Derive `has_errors` from `validation_results` for this filename
6. Upsert the row (or DELETE if absent from all three trees)

**What it reads from disk:** `stat()` + full JSON parse for each present tree version. Validator reads `validation.json` if present.

#### Step 3 — reindex column-stale files (`reindex_files_columns`)

For each file in `column_stale` (base row is current, field columns are stale):
1. Read and parse only the **working** JSON
2. Update field column values + their `:mt`/`:sz` timestamps

**What it reads from disk:** working JSON file only. Does not re-stat dirty/master. Does not re-run validators.

---

## How validation is mixed into indexing

Validation is not a separate pass — it runs inside `reindex_files_full` for every file whose base stats are stale.

```
reindex_files_full(filename):
  ├── stat() working, dirty, master
  ├── parse JSON from each present version
  ├── compute approved_changes / unapproved_changes
  ├── if validation.json exists:
  │     run_validators_dry(record, validators)
  │     DELETE FROM validation_results WHERE folder_path = ? AND filename = ?
  │     INSERT INTO validation_results ... (one row per violation)
  ├── has_errors = (any error-level row exists for this filename)
  └── UPSERT into "<table>" (or DELETE if all trees absent)
```

**Validators only run when a file is detected as stale in the working tree** (or on cold-path initial seed). Validators do not re-run during `reindex_files_columns` (column-only updates). This is intentional: validation rules are evaluated against the working content, and a column-stale file has an unchanged working version.

The `has_errors` flag on the record row is a denormalised copy derived from `validation_results` — it is updated in the same transaction as the record row so the grid can filter by `HasErrors` without joining.

### Validation stats

`get-validation-stats` and `get-folder-validation-sample` read from the folder-index DB. They:
1. Open `.repos/<connection_dir_name>.db`
2. Query `SELECT DISTINCT folder_path FROM validation_results` to enumerate folders that have violations
3. Count error/warning rows per folder directly from `validation_results`

No separate metadata table is needed because `folder_path` is part of the `validation_results` PK.

---

## Desktop-triggered reindexes

The desktop controls all dirty/master mutations. After each mutation, it explicitly reindexes the affected records so the hot path of `find_stale_working` doesn't need to scan dirty/master on every page load.

Two scoped commands are used:
- **`reindex-files --folder <f> --file <f1> --file <f2> ...`** — cheapest: reads all three tree versions and updates the DB row only for the named files.
- **`reindex-table --folder <f>`** — full folder rebuild: drops all rows and rebuilds. Used only when the full folder changes (pull, push, reindex-workspace).

| IPC handler | What changes on disk | Explicit reindex |
|---|---|---|
| `scratch:accept-record` | working → dirty (dirty changes) | `reindex-files` for the one record |
| `scratch:reject-record` | working only (reverts to dirty content) | none — hot path detects working change |
| `scratch:discard-record` | dirty + working → master | `reindex-files` for the one record |
| `files:accept-field-changes` | dirty changes (all touched files) | `reindex-files` for each file in `result.paths` |
| `files:reject-field-changes` | dirty + working change (all touched files) | `reindex-files` for each file in `result.paths` |
| `scratch:push-workspace-changes` | dirty → master (all) | `reindex-table` for all folders |
| `scratch:pull-workspace-changes` | master updated (all) | `reindex-table` for all folders |
| `scratch:reindex-workspace` | explicit user action | `reindex-table` for all folders |

**Why `reject-record` needs no reindex:** it restores the working file from the dirty branch without touching dirty. The working-tree mtime change is detected automatically by the hot path on the next `paginate-records` call.

Cell-level edits (`files:accept-cell-change`, `files:accept-cell-input-text`, `files:write-file-text-raw`) write only to the working tree. These are also detected automatically by the hot path — no explicit reindex needed.

---

## Summary: what each operation reads from disk

| Operation | `stat()` | JSON parse | Trees |
|---|---|---|---|
| `find_stale_working` cold path | no (just listing) | no | all three |
| `find_stale_working` hot path | working only | no | working only |
| `find_stale_columns` | no | no | none (DB only) |
| `reindex_files_full` | all three | all three present | all three |
| `reindex_files_columns` | none | working only | working only |
| `reindex-table` (full rebuild) | all three | all three present | all three |
