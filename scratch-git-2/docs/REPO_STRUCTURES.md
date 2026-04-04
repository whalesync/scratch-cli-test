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
transformers/
  {name}.rhai                     # Rhai transform scripts
```

## Git Service Disk (bare repos — unchanged)

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

---

## CLI Local Disk — current layout (being replaced)

The old layout scattered `.scratchmd` marker files into every connector directory and stored each connector as a self-contained git clone with a full `.git/` directory:

```
{workspace}/
  .scratchmd                      # Workspace marker only
  .scratch/
    workbook/
      syncs/*.json
      transformers/*.rhai
      docs.md
    connections/
      {CONNECTOR-NAME}/
        master/                   # Git worktree of main branch
        index.db
  {CONNECTOR-NAME}/               # Full git clone (dirty branch)
    .scratchmd                    # ← connector marker, one per connector
    .git/                         # ← full git directory, one per connector
    .scratch/                     # .scratch content mixed into user's working dir
    {folder}/
      *.json
```

Problems with this layout:

- `.scratchmd` files spread across every connector directory (hard to manage, easy to accidentally commit)
- `.git/` directories give connector folders a "repo" identity that confuses tools and users
- `.scratch/` mixed into the area the user edits
- Bare repos are only on the service; the CLI uses a completely different structure, making the `reposdir`/`loculdir` abstraction impossible

---

## CLI Local Disk — new layout

```
{workspace}/
  .scratch/
    .scratchmd                         # Single file — all metadata (workbook + all connections)
    connections/
      scratch/
      master/
      dirty/                          # Ephemeral reviewed snapshots used only when working tree has unreviewed edits
    docs/
  .repos/                              # Bare repos, mirroring service disk layout exactly
    {connectorAccountId}.git
    {connectorAccountId}.db
    {workbookId}.git                   # Workbook config repo
  .scratch/workspace/                  # Materialization of workbook config repo
    syncs/*.json
    transformers/*.rhai
    docs.md
  {CONNECTOR-NAME}/                    # Dirty branch checkout — the area the user lives in
    {folder}/
      *.json                           # Record files only — no .scratchmd, no .git, no .scratch
```

Key properties:

- **No `.git` file or directory in `{CONNECTOR-NAME}/`** — see note below
- **No `.scratchmd` in connector directories** — all metadata in the single workspace `.scratch/.scratchmd`
- **`.scratch/` content is at `.scratch/connections/scratch/{CONNECTOR-NAME}/`** — outside the user's editing area
- **`.repos/` is flat per workbook** — the composite `repoPath` remains the logical repo ID, but local bare repos and DBs use only the final repo basename inside the workbook root

### Global local-workspace registry

The CLI also maintains a lightweight global registry at:

```yaml
~/.scratchmd/workspaces.yaml
```

It stores initialized workspaces by workbook ID and absolute path:

```yaml
version: "1"
workspaces:
  - id: wkb_xxx
    path: /absolute/path/to/My Workspace
```

This is used to find a previously initialized workspace even when the current
working directory is outside that workspace tree.

### `.scratch/.scratchmd` format (version 3)

The single workspace `.scratch/.scratchmd` now includes all connection metadata that previously required per-connector marker files:

```yaml
version: "3"
workbook:
  id: wkb_xxx
  name: My Workspace
  orgId: org123
  serverUrl: https://...
  initializedAt: "2026-01-01T00:00:00Z"
connections:
  - id: ca_xxx
    displayName: My Airtable
    service: AIRTABLE
    repoPath: org123/wkb_xxx/ca_xxx
    dirName: AIRTABLE - My Airtable
```

### No `.git` file in connector directories

Git normally places a `.git` file (a pointer back to the bare repo) in every linked worktree. We deliberately do not use `git worktree add` for connector directories. Instead, **every git command is invoked with explicit `--git-dir` and `--work-tree` parameters**:

```bash
# Checkout dirty branch into a plain directory
git --git-dir=.repos/{repo_basename}.git --work-tree={CONNECTOR-NAME} checkout dirty -- .

# Stage and status
git --git-dir=.repos/{repo_basename}.git --work-tree={CONNECTOR-NAME} add -A
git --git-dir=.repos/{repo_basename}.git --work-tree={CONNECTOR-NAME} status --porcelain

# Commit (low-level, no HEAD required)
tree=$(git --git-dir=.repos/{repo_basename}.git write-tree)
parent=$(git --git-dir=.repos/{repo_basename}.git rev-parse refs/heads/dirty)
commit=$(git --git-dir=.repos/{repo_basename}.git commit-tree $tree -p $parent -m "message")
git --git-dir=.repos/{repo_basename}.git update-ref refs/heads/dirty $commit
```

The result is that `{CONNECTOR-NAME}/` is a completely plain directory — no git footprint, no marker files. Any tool (`ls`, `find`, VS Code) sees only the JSON record files. Cleanup is a simple `rm -rf`.

This is also why we do **not** want the user-facing data folders to be real Git worktrees. Real linked worktrees come with `.git` pointers, branch checkout ownership, and Git lifecycle rules (`git worktree add/remove`) that are easy to leak or misuse. We already saw the downside of that on the service side: a leaked linked worktree can keep `dirty` checked out and block pushes. The manually managed approach avoids that entire class of problems. We materialize plain directories on demand, operate against them with explicit `--git-dir/--work-tree`, and delete or refresh them whenever needed.

The same approach applies to the master checkout at `.scratch/connections/master/{CONNECTOR-NAME}/`, to the planner-only reviewed snapshots under `.scratch/connections/dirty/{CONNECTOR-NAME}/`, and to the service's temporary materializations under `.temp/`.

---

## `reposdir` / `loculdir` parameters

The path abstraction that unifies CLI and service is two parameters:

| Parameter  | CLI value            | Service value                     |
| ---------- | -------------------- | --------------------------------- |
| `reposdir` | `.repos/`            | `.` (workbook dir, same as today) |
| `loculdir` | `.` (workspace root) | `.temp/`                          |

Derived paths (same formula on both sides):

| Path                     | Formula                                                     |
| ------------------------ | ----------------------------------------------------------- |
| Bare repo                | `{reposdir}/{repo_basename}.git`                            |
| Index DB                 | `{reposdir}/{repo_basename}.db`                             |
| Dirty checkout           | `{loculdir}/{connector_name}/`                              |
| Connection scratch       | `{loculdir}/.scratch/connections/scratch/{connector_name}/` |
| Master worktree          | `{loculdir}/.scratch/connections/master/{connector_name}/`  |
| Reviewed dirty snapshot  | `{loculdir}/.scratch/connections/dirty/{connector_name}/`   |
| Workbook materialization | `{loculdir}/.scratch/workspace/`                            |

This is implemented as `WorkspaceLayout` in `src/shared/layout.rs`.

---

## Service temporary materialization (`.temp/`)

When the service needs to run shared business logic (build a publish plan, build an index) against a bare repo, it materializes working directories under `.temp/` relative to the workbook's directory in `REPOS_DIR`:

```
{REPOS_DIR}/{orgId}/{workbookId}/
  {connectorAccountId}.git         # Bare repo
  .temp/                           # Created on demand, removed after operation
    .scratch/
      connections/
        scratch/{connectorAccountId}/
        master/{connectorAccountId}/
    {connectorAccountId}/          # Dirty checkout (no .git file — see above)
```

The service uses `WorkspaceLayout::for_service(workbook_dir)` which sets `reposdir = "."` and `loculdir = ".temp"`. After the operation completes, `.temp/` is removed entirely.

This replaces the old `TempWorktree` pattern which placed worktrees at random UUID paths with no consistent structure.

---

## Materialize-Perform-Commit-Cleanup Pattern

When the service (or CLI) needs to run business logic against a bare repo:

1. **Materialize** — checkout dirty branch into `{loculdir}/{connector_name}/` using `git --git-dir ... --work-tree ... checkout dirty -- .`
2. **Perform** — run the shared logic (plan building, indexing, etc.) against the materialized directory
3. **Commit** — stage changes with `git add -A`, commit via `update-ref` (no HEAD needed)
4. **Cleanup** — `rm -rf {loculdir}/{connector_name}/` (no `git worktree remove` needed)

The worktree path differs between CLI (persistent) and service (temporary under `.temp/`) but the directory structure inside is identical — this is what enables code sharing.

**Future optimization — tree-native reads**: Materializing a full worktree is wasteful for large repos (e.g. 100k files, 1 change). The better path is to skip materialization entirely: use `gix` to tree-diff `main` vs `dirty` (O(changed files)), read only the needed blobs directly from the bare repo, build the plan in memory, and commit via the existing `commit_changes_to_ref` tree builder. The shared `build_publish_plan` logic stays the same — only the I/O layer changes (swap `collect_files(dir)` for `collect_files_from_tree(repo, branch)`).

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

---

## Manual Verification Checklist

Use this as the refactor acceptance test:

1. Download a workbook locally
2. Make changes
3. Create a publish plan
4. Upload
5. Ask the Nest server to execute the publish plan
6. Verify the git backend service still works with all old functionality, including UI/DB-based syncs, publish plans, and other existing service flows
