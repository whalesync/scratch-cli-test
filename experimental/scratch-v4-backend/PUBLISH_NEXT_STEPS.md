# Publish Next Steps

## Current state

`scratchmdv4 plan-publish` produces a raw diff only:
- `create/` — files in dirty, not in master
- `update/` — files in both, content changed
- `delete/` — files in master, not in dirty

The reporting shows `(raw diff counts)` with no arrow yet.
Everything below describes what the plan step must compute before the arrow can be shown.

---

## What the full plan step must produce

The real plan has **6 phases**, each becoming its own subfolder in the plan:

| Phase | Folder | Meaning |
|-------|--------|---------|
| `edit` | `edit/` | Update existing record (stripped content + changedFields) |
| `create` | `create/` | Create new record (stripped content) |
| `delete` | `delete/` | Delete record (empty `{}`, remote ID in plan.json index) |
| `backfill` | `backfill/` | Re-update after creates resolve pending IDs |
| `rename` | `rename/` | Rename `scratch_pending_*.json` → real filename after create |
| `asset-upload` | `asset-upload/` | Upload asset files before editing (skip for now) |

The arrow in reporting maps raw diff → plan phases:

```
Posts  (2 modified, 1 deleted)  →  (2 edit, 1 delete, 1 edit[ref-clear], 1 backfill)
```

---

## How the plan is built — step by step

### Step 1 — Load deleted remote IDs

For each deleted file (in master, not in dirty):
- Open `index.db` for the connection
- Query `file_index` for `(folder, filename)` → `remote_id`
- Build `deletedRemoteIds: Set<String>`

These IDs are written into `plan.json` so execute-publish can call `deleteRecords` without reading master.

---

### Step 2 — Find ref-clearing candidates

Files that were NOT modified by the user but still need an edit because they reference a deleted record.

- Query `file_references` table in `index.db`:
  ```sql
  SELECT source_folder, source_filename
  FROM file_references
  WHERE target_remote_id IN (<deletedRemoteIds>)
  ```
- These files get an `edit` operation even though they are not in the dirty diff
- Their content is read from the **dirty** worktree (same as a normal edit)
- After stripping (pass 1 below), the FK field pointing at the deleted record becomes null/empty

---

### Step 3 — Three-pass stripping (applied to every edit and create file)

For each file going into `edit/` or `create/`:

**Pass 1 — Strip FK refs to deleted records**
- Load the folder's `schema.json` from `.scratch/connections/{ConnName}/master/.scratch/{folder}/schema.json`
- Walk schema properties two levels deep looking for `x-scratch-foreign-key` annotations
- For each FK field, read the value from the file content
  - If it is a string matching a deleted remote ID → set to `null`
  - If it is an array → filter out any deleted remote IDs
- If the content changed → mark `refCleared = true`

**Pass 2 — Strip pseudo-refs (`@/folder/file.json`)**
- Scan all string values in the record for the `@/` prefix
- These are references to pending new records that don't have remote IDs yet
- Strip them (set to `null`) before sending to the remote service
- If anything was stripped → add a **backfill** entry (see step 5)
- The `file_index` will be used at execute time to resolve `@/` → real remote ID

**Pass 3 — Strip `@asset/` pseudo-refs** (skip until asset upload is implemented)

---

### Step 4 — Classify each file into plan phases

**Modified files (dirty ≠ master)**
→ apply 3-pass stripping to dirty content
→ write `edit/{filename}` with stripped content
→ write `changedFields` into `plan.json` (keys that differ between master and stripped-dirty)
→ if pass 2 or 3 stripped anything → also write `backfill/{filename}` with pre-stripped content (pass 1 output)

**Added files (in dirty, not in master)**
→ apply 3-pass stripping to dirty content
→ write `create/{filename}` with stripped content
→ if filename matches `scratch_pending_*` → also write `rename/{filename}` as marker
→ if pass 2 or 3 stripped anything → also write `backfill/{filename}`

**Deleted files (in master, not in dirty)**
→ write `delete/{filename}` as `{}`
→ store `remote_id` in the `delete` section of `plan.json`

**Ref-cleared files (from step 2, not otherwise modified)**
→ same as modified files but source is dirty worktree content
→ write `edit/{filename}` with FK refs nulled out

---

### Step 5 — Backfill entries

A backfill is a second update sent after creates complete, restoring values that were stripped in pass 2/3.

Example: record A has a field `author` pointing to a pending new record B (`@/Posts/scratch_pending_abc.json`).
- Pass 2 strips the `author` field to null → goes into `edit/` as null
- After create, B gets real ID `recXXX`
- Backfill restores `author = recXXX` → goes into `backfill/` with the pre-stripped value
- At execute time, the executor resolves `@/Posts/scratch_pending_abc.json` → `recXXX` using `file_index`

The `backfill/` file content is the **pass 1 output** (deleted refs stripped, pseudo-refs NOT stripped).
Execute-publish resolves `@/` references at runtime using `file_index`.

---

### Step 6 — Rename entries

For every file in `create/` whose name starts with `scratch_pending_`:
- Write `rename/{filename}` as marker `{}`
- At execute time, after the create returns the assigned remote ID, rename the file in dirty + master

---

### Step 7 — Write plan.json index

The `plan.json` at the plan root stores:

```json
{
  "planId": "20260317-123456",
  "createdAt": "...",
  "connectionName": "Webflow",
  "connectionId": "abc123",
  "summary": {
    "edit": 2,
    "create": 1,
    "delete": 1,
    "backfill": 1,
    "rename": 1,
    "assetUpload": 0
  },
  "deleteIndex": {
    "Ivan - dev testing/Posts/old-post.json": "686abc123"
  },
  "changedFields": {
    "Ivan - dev testing/Posts/post1.json": ["fieldData"]
  }
}
```

`deleteIndex` maps deleted file paths → remote IDs (needed by execute since master file is gone).
`changedFields` maps updated file paths → array of top-level changed keys (for efficient PATCH).

---

## What changes in `plan-publish` Rust code

1. **Load SQLite index** — open `index.db` per connection, query `file_index` and `file_references`
2. **Three-pass stripping** — implement in Rust using serde_json, schema parsing (reuse `extract_fk_fields` from `build_index.rs`)
3. **changedFields computation** — diff top-level keys between master JSON and stripped dirty JSON
4. **New plan subfolders** — `edit/`, `backfill/`, `rename/` alongside existing `create/`, `delete/`
5. **Richer plan.json** — add `deleteIndex` and `changedFields` maps
6. **Updated reporting** — show the arrow: `(raw diff) → (plan phases)`

---

## What execute-publish needs from the plan

Execute-publish reads the plan folder and:
1. Runs phases in order: `asset-upload` → `edit` → `create` → `delete` → `backfill` → `rename`
2. For `delete`: gets remote ID from `plan.json deleteIndex`
3. For `edit`/`create`: reads file content from the plan subfolder (already stripped)
4. For `edit`: passes `changedFields` from `plan.json` to `connector.updateRecords()`
5. For `backfill`: resolves `@/` refs using updated `file_index` (after creates populated new IDs)
6. For `rename`: renames `scratch_pending_*` → real filename in dirty + master worktrees
7. After all phases: `rebase-dirty` so dirty === master

---

## What we deliberately skip for now

- **Asset upload** — `@asset/` stripping and upload phase
- **Rename detection** — same-content different-filename treated as delete+create (safe but wasteful)
- **Cross-connection FK deps** — connections publish independently, no ordering between them
