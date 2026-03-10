# Strip Connection Name Prefix — Migration Plan

## Problem

Every file in a connection's git repo is currently stored under a top-level folder matching the
connection display name. For a connection named `Supabase1` with a folder at path
`/Supabase1/public/tableA`, git stores files at `Supabase1/public/tableA/record.json`.

The goal is to drop that first segment so git stores the same file at `public/tableA/record.json`.
The `DataFolder.path` in the DB must be updated in parallel: `/Supabase1/public/tableA` → `/public/tableA`.

The client must remain functional with both the old layout (prefix present) and the new layout
(prefix absent) during the transition window.

---

## What "strip the top-level folder" means for git

Git has no `mv` — a "rename" is: read all blobs, write a new tree without the wrapper directory,
create a new commit pointing at that tree. No blob data changes; only tree objects change.

The three-branch state machine produces three cases:

| Case | Condition | Action |
|------|-----------|--------|
| A | `main == dirty == merge_base` | One new commit; point all three refs to it |
| B | `main == merge_base`, `dirty` is ahead | Two new commits (new-main, new-dirty); move merge_base tag |
| C | `main != merge_base != dirty` (all differ) | Three new commits; move all three refs |

In all cases:
- No blob objects are created — blobs are reused by OID
- Only new tree objects (one per level of nesting removed) and commit objects are written
- The old commits (and their trees) become unreachable garbage; git GC will collect them
- History is effectively replaced (orphan commits) — this is intentional

---

## Part 1 — Rust Service: New migration endpoint

### New route

```
POST /api/repo/admin/strip-prefix/{id}
```

This is an admin-only endpoint (no workbook auth — called server-to-service). It operates on one
repo identified by its `repo_id`.

### Algorithm

```
1. Resolve main OID, dirty OID, merge_base OID (tag)
2. Determine case (A / B / C) by comparing OIDs
3. For each unique tree that needs rewriting:
   a. Read the root tree of that commit
   b. Expect exactly ONE top-level directory entry (the connection prefix folder)
   c. Verify it is a tree (directory), not a blob
   d. Return its child tree OID — this becomes the new root tree
   e. Create a new orphan commit (no parents) pointing at the new root tree
   f. Force-update the ref to the new commit
4. Move merge_base tag to the new main-equivalent commit
5. Return { old_main, new_main, old_dirty, new_dirty, old_merge_base, new_merge_base, case: "A"|"B"|"C" }
```

### Error handling

- If root tree has zero top-level entries: repo is empty, skip (return `{ case: "empty" }`)
- If root tree has more than one top-level entry: the prefix may already be stripped OR repo is
  in unexpected state — return an error with the entry names so the caller can decide
- If the single top-level entry is not a tree (is a blob): return an error

### Implementation location

- New handler: `scratch-git-2/src/routes/admin.rs` (new file)
- Add route in `main.rs`: `POST /api/repo/admin/strip-prefix/{id}`
- Implement as a method on `GitRepo`: `strip_top_level_prefix(&self) -> Result<StripPrefixResult, AppError>`

---

## Part 2 — Server: Migration endpoint + job

### New NestJS endpoint

```
POST /workbooks/:id/migrate/strip-connection-prefix
```

Auth: admin only (or internal service token). Called manually or from a migration script.

### Per-connector-account flow

```
For each ConnectorAccount in the workbook (where repoPath is not null):
  1. Collect all DataFolders for this connectorAccount
  2. Call rust service: POST /api/repo/admin/strip-prefix/{repoId}
  3. If result.case == "empty": skip DB update, log
  4. If error (multi-entry or blob): log, skip, report
  5. On success: update all DataFolder.path records for this connectorAccount
     - Strip the first path segment from each path
     - "/Supabase1/public/tableA"  →  "/public/tableA"
     - "/Supabase1/accounts"       →  "/accounts"
     - Also update DataFolder.name if name == connectionDisplayName (unlikely but safe)
  6. Log result per connectorAccount
```

### DB update query

```sql
-- For a given connectorAccountId, strip the first path segment
UPDATE "DataFolder"
SET path = regexp_replace(path, '^/[^/]+', '')
WHERE "connectorAccountId" = $1
  AND path ~ '^/[^/]+/';
-- Paths with only one segment (e.g. "/tableName") become "/" — needs separate handling
-- Paths with two+ segments (e.g. "/Connection/table") → "/table" or "/schema/table"
```

In practice, use Prisma/Knex to fetch all folders, compute new paths in TypeScript, then batch
update. This makes it easy to validate before writing.

### Migration script

A standalone Node.js script (or yarn workspace command) that:
1. Iterates all workbooks
2. For each workbook, calls the migration endpoint
3. Reports success/failure per workbook

This allows running environment-by-environment (dev → staging → prod) with review between steps.

---

## Part 3 — Client: Support both path formats simultaneously

### Current behavior

`getIntermediateSegments()` in [TreeNode.tsx](client/src/app/workbook/[id]/components/Sidebar/TreeNode.tsx)
strips **both** the first segment (connection name) **and** the last segment (table name) to find
intermediate path segments:

```typescript
// Line 105-109
function getIntermediateSegments(folderPath: string): string[] {
  const segments = folderPath.replace(/^\//, '').split('/');
  if (segments.length <= 2) return [];
  return segments.slice(1, -1);  // drops first and last
}
```

For `/Supabase1/public/tableA`:
- Before migration: segments = `["Supabase1", "public", "tableA"]` → intermediates = `["public"]` ✓
- After migration: segments = `["public", "tableA"]` → intermediates = `[]` ✗ (loses "public" grouping)

### Fix

The client needs to detect whether the path uses the old (prefixed) or new (unprefixed) format and
handle both. The cleanest signal is `DataFolder.connectorDisplayName` — if the first path segment
equals the connection display name, the old format is in use.

**Update `getIntermediateSegments`** to accept an optional `connectionName?: string`:

```typescript
function getIntermediateSegments(folderPath: string, connectionName?: string): string[] {
  const segments = folderPath.replace(/^\//, '').split('/');
  // Drop the connection-name prefix if still present (old format)
  const adjusted = (connectionName && segments[0] === connectionName)
    ? segments.slice(1)   // old format: drop prefix, keep rest
    : segments;           // new format: use as-is
  if (adjusted.length <= 1) return [];
  return adjusted.slice(0, -1);  // drop last segment (table name)
}
```

**Update `buildFolderTree`** to pass `connectorDisplayName`:

```typescript
function buildFolderTree(folders: DataFolder[], groupName: string): FolderTreeNode {
  const root: FolderTreeNode = { folders: [], children: new Map() };
  for (const folder of folders) {
    const segments = getIntermediateSegments(
      folder.path ?? `/${groupName}/${folder.name}`,
      folder.connectorDisplayName ?? groupName,
    );
    // ... rest unchanged
  }
  return root;
}
```

**Update URL path construction in `TableNode`** — the encoded folder path used in routes is built
from `folder.path`:

```typescript
// Current (line 765-769)
const encodedFolderPath = (folder.path ?? folder.name)
  .replace(/^\//, '')
  .split('/')
  .map((s) => encodeURIComponent(s))
  .join('/');
```

This is safe as-is — it encodes `folder.path` from the DB, which will correctly reflect the new
format after migration. No change needed here.

**API calls using folder path** — the server's file listing passes `folder.path` to the git service
after stripping the leading `/`. After migration the DB path is already correct. No change to server
or API client needed.

### Path in git vs path in DB after migration

| | DB path | Git path |
|-|---------|----------|
| Before | `/Supabase1/public/tableA` | `Supabase1/public/tableA/file.json` |
| After | `/public/tableA` | `public/tableA/file.json` |

These stay in sync because the server always strips the leading `/` before passing to git:
`folder.path.replace(/^\//, '')` → `public/tableA` → lists `public/tableA/` in git.

---

## Rollout Order

1. **Deploy client fix (Part 3)** first — makes client handle both formats gracefully
2. **Deploy Rust endpoint (Part 1)** — no repos are migrated yet, endpoint just exists
3. **Deploy server endpoint (Part 2)** — same, just exists
4. **Run migration** on dev, verify, then staging, verify, then prod:
   ```
   POST /workbooks/:id/migrate/strip-connection-prefix  (per workbook)
   ```
   After each environment: verify the client renders folders correctly before proceeding.
5. **Remove old-format compatibility code** from client in a later cleanup PR once all envs are migrated.

---

## Status

- [x] Part 1: Rust `strip-prefix` endpoint in scratch-git-2
- [x] Part 2: Server migration endpoint + DB update logic (`POST /scratch-git/:id/strip-connection-prefix`)
- [x] Part 3: Client dual-format compatibility in `getIntermediateSegments`
- [x] Part 4: Admin UI — "Strip Connection Prefix" button in connections modal
- [ ] Run migration on dev
- [ ] Run migration on staging
- [ ] Run migration on prod
- [ ] Cleanup: remove old-format compat code from client
