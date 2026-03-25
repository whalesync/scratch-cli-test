# Repository Structures

How data is laid out on disk for the CLI (local checkout) and the Git service (bare repos). Understanding both is required to share business logic between them via the **materialize → perform → commit → cleanup** pattern.

## Repo Identity

Connection repos use a composite ID stored in `connectorAccount.repoPath`:

```
{orgId}/{workbookId}/{connectorAccountId}
```

On the git service disk this becomes: `{REPOS_DIR}/{orgId}/{workbookId}/{connectorAccountId}.git`

The workbook config repo reuses the same pattern with workbookId in place of connectorAccountId:

```
{orgId}/{workbookId}/{workbookId}
```

## Branches

| Branch  | Owner  | Purpose                                     |
| ------- | ------ | ------------------------------------------- |
| `main`  | Server | Published/pulled truth — server writes here |
| `dirty` | CLI    | User's working copy — CLI pushes here       |

## Connection Repo (inside git)

```
{folder}/
  record-1.json
  record-2.json
  scratch_pending_abc.json        # New records not yet published
.scratch/
  {folder}/
    schema.json                   # Table schema + FK annotations
    publish-plan-{ts}/            # Phase files for active plan
      edit/
        record-1.json             # { content, changedFields }
      create/
        scratch_pending_abc.json  # Stripped JSON (no pending refs)
      delete/
        record-3.json             # { remoteId }
      backfill/
        record-1.json             # { content, changedFields }
      rename/
        scratch_pending_abc.json  # {} placeholder
  .publish-plans/
    {ts}/
      plan.json                   # Plan manifest (summary, tablePaths)
```

Phase dirs only exist when a publish plan is active. `cleanup_old_plan_dirs` removes previous plans on new plan creation.

## Workbook Config Repo (inside git)

```
syncs/
  {sync-slug}.json                # Portable sync config (source, dest, field mappings)
```

## CLI Local Disk (V2 workspace)

```
{workspace}/
  .scratchmd                      # Workspace marker (version, workbookId, serverUrl)
  .scratch/
    workbook/
      syncs/*.json                # Downloaded sync configs
      transformers/*.rhai         # Rhai transform scripts
      docs.md                     # Generated documentation
    connections/
      {CONNECTOR-NAME}/
        master/                   # Git worktree of main branch (read-only)
        index.db                  # SQLite index (filename <-> remoteId)
  {CONNECTOR-NAME}/               # Dirty branch checkout
    .scratchmd                    # Connector marker (connectorAccountId, repoPath)
    .git/
    .scratch/                     # Same structure as "Connection Repo" above
    {folder}/
      *.json                      # Record files
```

## Git Service Disk (bare repos)

```
{REPOS_DIR}/
  {orgId}/
    {workbookId}/
      {connectorAccountId}.git    # Bare repo (main + dirty branches)
      {connectorAccountId}.db     # SQLite index
      {workbookId}.git            # Workbook config repo
      {workbookId}.db             # Workbook config index (if any)
```

`index.db` is co-located with the bare repo in `REPOS_DIR` (controlled by `GIT_INDEX_DIR` env var, defaults to `GIT_REPOS_DIR`).

## Materialize-Perform-Commit-Cleanup Pattern

When the service needs to run CLI-style business logic (e.g. build a publish plan) against a bare repo:

1. **Materialize** — `git worktree add {tmp} dirty` from the bare repo to get a working tree
2. **Perform** — Run the shared logic against the materialized directory (same code paths as CLI)
3. **Commit** — Stage changes in the worktree and commit to dirty branch
4. **Cleanup** — `git worktree remove {tmp}` and delete the temp directory

For syncs that read from a source and write to a destination, two worktrees are needed:

- Source connection repo: materialized **read-only**
- Destination connection repo: materialized **read-write**, committed after sync

The worktree path differs between CLI and service but the directory structure inside is identical — this is what enables code sharing.

**Future optimization — tree-native reads**: Materializing a full worktree is wasteful for large repos (e.g. 100k files, 1 change). The better path is to skip worktrees entirely: use `gix` to tree-diff `main` vs `dirty` (O(changed files)), read only the needed blobs directly from the bare repo, build the plan in memory, and commit via the existing `commit_changes_to_ref` tree builder. The shared `build_publish_plan` logic stays the same — only the I/O layer changes (swap `collect_files(dir)` for `collect_files_from_tree(repo, branch)`).

## plan.json Manifest Format

```json
{
  "planId": "20260324-120000",
  "createdAt": "2026-03-24T12:00:00Z",
  "connectionName": "Airtable - MyBase",
  "connectionId": "cac_xyz789",
  "summary": {
    "edit": 5,
    "create": 3,
    "delete": 1,
    "backfill": 2,
    "rename": 3
  },
  "tablePaths": ["Posts", "Authors"]
}
```

`tablePaths` tells the consumer which `.scratch/{folder}/publish-plan-{ts}/` directories to scan for phase files.
