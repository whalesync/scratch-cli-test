# Repository Structures

How data is laid out on disk for the CLI (local checkout) and the Git service (bare repos). The CLI uses a single real `git worktree add` of `main` per connection; the service operates purely on the bare repos via gix/git-cli and does not materialize worktrees today.

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

| Branch  | Owner  | Purpose                                                                                                                                                                           |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`  | Server | Published/pulled truth — server writes here.                                                                                                                                      |
| `dirty` | Server | Approved-but-not-yet-published staging area on the server. CLI ships RFC 7396 patches via `/upload-patch` and the server applies them here; the publish pipeline reads from here. |

The local CLI no longer pushes to `dirty`. The user's accepted-but-not-published edits live in `<workspace>/.scratch/connections/<conn>/accepted-patches.json` — see [REVIEW_MODEL.md](REVIEW_MODEL.md).

## Connection Repo (inside git)

```
{folder}/
  record-1.json
  record-2.json
  scratch_pending_{hash}.json     # Records produced by a local sync that don't yet have a remote ID
.scratch/
  {folder}/
    schema.json                   # Table schema + FK annotations
```

The `/upload-patch` → `publish-v2/plan-job` → `publish-v2/run-job` flow does not write phase files into the repo. The legacy `publish-from-git` job used to write `.scratch/{folder}/publish-plan-{ts}/` and `.scratch/.publish-plans/` directories inside the server-side bare repo; that job and its server-side endpoint + worker were removed in Phase 7.

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

## CLI Local Disk layout

```
{workspace}/
  .scratch/
    .scratchmd                         # Single file — all metadata (workbook + all connections)
    lock                               # Workspace-wide file lock for mutating CLI ops
    conflicts.log                      # JSONL audit log of same-field collisions from pull / publish reconcile
    connections/
      {CONNECTOR-NAME}/
        accepted-patches.json          # User's approved-but-not-published edits — see REVIEW_MODEL.md
      scratch/
        {CONNECTOR-NAME}/              # Per-connection schema files + validator config (cache)
    workspace/                         # Materialization of workbook config repo
      syncs/*.json
      transformers/*.rhai
      docs.md
    docs/
  .repos/                              # Bare repos, mirroring service disk layout
    {connectorAccountId}.git
    {connectorAccountId}.db
    {workbookId}.git                   # Workbook config repo
  {CONNECTOR-NAME}/                    # Real git worktree of refs/heads/main (the user's editing area)
    .git                               # Gitlink file → ../.repos/{connectorAccountId}.git/worktrees/{name}
    .scratch/                          # Schemas + views, carried natively by the main tree
      {folder}/
        schema.json
        view.json
    {folder}/
      *.json                           # Record files
```

Key properties:

- **One non-sparse `git worktree add` per connection on `refs/heads/main`** (slice F.2.b). The `.git` gitlink file is the only git artifact in the user's editing area; the bare repo + objects live at `.repos/{connectorAccountId}.git/`.
- **`accepted-patches.json` is the authoritative "approved-but-not-yet-published" store** — see [REVIEW_MODEL.md](REVIEW_MODEL.md). The CLI no longer maintains a local `refs/heads/dirty` branch; `setup_connection` prunes that ref post-clone (slice F.5).
- **`.scratch/connections/scratch/{CONNECTOR-NAME}/` is a cache.** Schemas + views live in the worktree's `.scratch/` tree natively; the cache directory exists because some readers (`shared/validators`, `shared/index`, `cli/commands/validation`) still resolve schemas from there rather than from the worktree.
- **`.repos/` is flat per workbook** — the composite `repoPath` (`{orgId}/{workbookId}/{connectorAccountId}`) remains the logical repo ID, but local bare repos and DBs use only the final basename inside the workbook root.

### Pre-Phase-5 layout (historical)

Before slice F (2026-05-20), the CLI maintained three worktrees per connection:

- `{CONNECTOR-NAME}/` was a **sparse** worktree of the local `dirty` branch (the "user's accepted edits" snapshot), with manual `--git-dir`/`--work-tree` invocations instead of a `.git` link.
- `.scratch/connections/master/{CONNECTOR-NAME}/` held the published-state worktree (sparse on `main`), used as the snapshot source for diff detection.
- `.scratch/connections/dirty/{CONNECTOR-NAME}/` held the "reviewed-dirty" worktree (an identical sparse copy of `dirty`), used by the local publish-plan generator.

Slice F retired all three by collapsing to one real `git worktree add` of `main` and moving the approved-state record into `accepted-patches.json`. See the [workspace-simplification plan](../../docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md) for the migration history.

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

### Worktree mechanics

The user-facing connector directory is a real `git worktree add` of `refs/heads/main` (slice F.2.b). The only git artifact in the user's editing area is the `.git` gitlink file (a single file pointing at `../.repos/{connectorAccountId}.git/worktrees/{name}/`). Tools that walk the filesystem (`ls`, VS Code, `find`) see only that one-line gitlink alongside the record files.

```bash
# Initial creation — once per connection at workspaces init (parallelized via rayon)
git --git-dir=.repos/{connectorAccountId}.git worktree add --no-detach {CONNECTOR-NAME} main

# Read / status / stage from inside the worktree (no --git-dir needed; the gitlink resolves)
cd {CONNECTOR-NAME}
git status --porcelain
git fetch origin main

# Advance the main ref after a successful pull / publish reconcile
git update-ref refs/heads/main refs/remotes/origin/main
```

Cleanup uses `git worktree remove` so the bare repo's `worktrees/` administrative directory is cleaned in lockstep:

```bash
git --git-dir=.repos/{connectorAccountId}.git worktree remove {CONNECTOR-NAME}
git --git-dir=.repos/{connectorAccountId}.git worktree prune
```

This was a deliberate flip from the pre-F approach (manual `--git-dir`/`--work-tree` against plain directories, with the bare repo as the only "real" git surface). Once the local `dirty` branch went away and accepted state moved into `accepted-patches.json`, the original reasons for avoiding a linked worktree (branch checkout ownership, leaked `dirty` lock) no longer applied. The real worktree gets us cheap `git status` via index-backed stat checks and avoids hand-rolled materialization.

### Cleaning up the gitlink

`git worktree add` writes its administrative state in two places: the gitlink file inside the worktree, and a `worktrees/{name}/` directory inside the bare repo. `git worktree remove` cleans both. Avoid manual `rm -rf {CONNECTOR-NAME}/` without a follow-up `git worktree prune` — the bare repo's record of the linked worktree will leak and block future `worktree add` calls with the same name.

---

## `reposdir` / `loculdir` parameters

The path abstraction that unifies CLI and service is two parameters, exposed via `WorkspaceLayout` in `src/shared/layout.rs`:

| Parameter  | CLI value            | Service value (currently unused)  |
| ---------- | -------------------- | --------------------------------- |
| `reposdir` | `.repos/`            | `.` (workbook dir)                |
| `loculdir` | `.` (workspace root) | `.temp/`                          |

Derived paths (same formula on both sides):

| Path                     | Formula                                                     |
| ------------------------ | ----------------------------------------------------------- |
| Bare repo                | `{reposdir}/{repo_basename}.git`                            |
| Index DB                 | `{reposdir}/{repo_basename}.db`                             |
| User-facing worktree     | `{loculdir}/{connector_name}/`                              |
| Connection root          | `{loculdir}/.scratch/connections/{connector_name}/`         |
| └─ Accepted patches      | `{connection_root}/accepted-patches.json`                   |
| Connection scratch cache | `{loculdir}/.scratch/connections/scratch/{connector_name}/` |
| Workbook materialization | `{loculdir}/.scratch/workspace/`                            |

`WorkspaceLayout::worktree_path(connector_name)` returns the "user-facing worktree" row.

`WorkspaceLayout::for_service(workbook_dir)` exists for symmetry but currently has no live caller — the service binary stopped needing in-process worktrees once `service/routes/plan_publish.rs` was deleted in Phase 7a. The infrastructure is preserved in case future shared-logic-on-the-service work needs it; if it ever comes back, the layout already accommodates the `.temp/` materialization pattern below.

---

## Materialize-Perform-Commit-Cleanup pattern (not currently used)

When shared business logic needs to run against a bare repo without a persistent worktree (e.g. the service building a publish plan), the layout supports a four-step pattern:

1. **Materialize** — `git worktree add {loculdir}/{connector_name}/ main` to put files on disk under the temporary path.
2. **Perform** — run the shared logic against the materialized directory.
3. **Commit** — stage with `git add -A`, commit, write the ref via `update-ref`.
4. **Cleanup** — `git worktree remove {loculdir}/{connector_name}/`, then `git worktree prune` on the bare repo.

The CLI uses step 1 once at `workspaces init` (the worktree stays persistent for the user's editing area, not removed after each operation). The service binary currently does nothing on this pattern; the historical caller (`service/routes/plan_publish.rs`) was removed in Phase 7a along with the `TempWorktree` helper that used random UUID paths.

If a new service-side use case lands, prefer tree-native reads over materialization: `gix` can tree-diff and read individual blobs without ever putting files on disk (O(changed files) instead of O(workspace size)).

---

## Manual Verification Checklist

Use this as a refactor acceptance test for layout-affecting changes:

1. `scratchmd workspaces init` a workbook locally — verify the `{workspace}/` tree matches the [CLI Local Disk layout](#cli-local-disk-layout).
2. Edit a record file in the user-facing worktree.
3. `scratchmd files accept <path>` — verify `<workspace>/.scratch/connections/<conn>/accepted-patches.json` is created with the expected `Update`/`Create`/`Delete` entry. See [REVIEW_MODEL.md](REVIEW_MODEL.md) for the accept/reject/discard semantics that get exercised here.
4. `scratchmd files upload` — verify the patch file ships to the server (server's `dirty` branch advances).
5. `scratchmd files publish` — verify the publish plan executes, local `refs/heads/main` advances, and patches that landed in `main` drop from `accepted-patches.json` (failed-connector patches survive). See [PULL_AFTER_PUBLISH.md](PULL_AFTER_PUBLISH.md) for the reconcile flow.
6. Verify the git backend service still works with all server-side flows (UI/DB-based syncs and the publish-v2 plan-job/run-job path).
