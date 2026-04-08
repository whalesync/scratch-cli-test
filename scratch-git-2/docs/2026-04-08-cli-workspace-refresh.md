# Workspace Sync on `files download`

**Date:** 2026-04-08
**Status:** Proposed

## Problem

When a user initializes a workspace locally with `scratchmd workspaces init`, the workspace marker file (`.scratch/.scratchmd`) captures a snapshot of the workspace's connections at init time. This snapshot is never updated. If someone later adds or removes connections or linked tables via the web app, the local workspace becomes structurally out of sync with the server. The only recovery path today is a destructive re-init that discards all local state.

## Goal

Integrate workspace structure sync into the existing `files download` command. Before downloading file changes, `files download` should detect structural drift (new/removed connections and linked folders) and reconcile local state with the server.

## Command Interface Changes

Add two new flags to `files download`:

```
scratchmd files download
    --on-delete=prompt    (default) Interactively ask per removed connection/folder
    --on-delete=remove    Automatically delete removed connections/folders
    --on-delete=keep      Automatically keep removed connections/folders as detached
```

These flags control behavior when the server no longer has a connection or folder that exists locally. The default (`prompt`) preserves the existing interactive UX. The `remove` and `keep` options allow scripted/CI usage without interaction.

## Behavior

### Overview

`run_download` currently does:
1. Resolve workspace and build `ConnectionContext` list from the local marker
2. Loop over each connection and run `download_single_repo`
3. Update master worktrees, sync schemas, rebuild indexes
4. Regenerate docs

The new flow inserts a **workspace sync phase** before the existing download loop:

1. **Resolve workspace** (existing)
2. **Workspace sync phase** (new) — fetch server state, diff, set up new connections, handle removed ones
3. **Rebuild connection contexts** from the updated marker
4. **Download files** for all connections (existing, but now operating on the refreshed connection list)
5. **Regenerate docs** (existing)

### Phase 2 Detail: Workspace Sync

#### 2a. Fetch current server state

Make two API calls:

- `GET /cli/v1/workbooks/{id}` — returns `Workbook` with `connector_accounts[]`
- `GET /cli/v1/workbooks/{id}/linked` — returns `LinkedTableGroup[]` with `data_folders[]`

The workbook endpoint is already used by `workspaces init` and `workspaces show`. The linked tables endpoint is already used by `linked list`. Both API client methods exist: `ApiClient::get_workbook()` and `ApiClient::list_linked_tables()`.

#### 2b. Diff connections

Compare the local marker's `connections[]` against the server's `connector_accounts[]`, keyed by connection `id`.

| Set | Definition |
|-----|-----------|
| **Added** | Connection exists on server but not in local marker |
| **Removed** | Connection exists in local marker but not on server |
| **Unchanged** | Connection exists in both (proceed to file download as normal) |

#### 2c. Set up new connections

For each added connection, run the same per-connection setup that `init_v2` performs (`workspaces.rs` lines 384–430):

1. Compute `dir_name` via `connector_dir_name(service, display_name)`
2. Skip if `git_url` or `repo_path` is empty (print warning)
3. Clone bare repo → `layout.bare_repo_path(repo_path)`
4. Materialize dirty checkout → `layout.dirty_checkout_path(dir_name)`
5. Set up reviewed-dirty worktree → `layout.reviewed_dirty_checkout_path(dir_name)`
6. Set up master worktree → `layout.master_worktree_path(dir_name)`
7. Include schema files in sparse checkout and sync them
8. Build SQLite index → `layout.index_db_path(repo_path)`

Print: `Setting up new connection: {dir_name}...`

This connection then participates in the normal download loop that follows.

#### 2d. Handle removed connections

For each connection in the local marker that no longer exists on the server, behavior depends on the `--on-delete` flag:

**`--on-delete=prompt` (default):**
```
Connection "Airtable - My Base" was removed from the server.
  [d] Delete local files
  [k] Keep as detached (files remain, no longer synced)
  > 
```

**`--on-delete=remove`:** Automatically delete.

**`--on-delete=keep`:** Automatically keep as detached.

##### Delete path

Remove all local artifacts for the connection:
- Prune git worktrees from the bare repo, then delete the bare repo: `.repos/{repo_basename}.git`
- Delete index DB: `.repos/{repo_basename}.db`
- Delete dirty checkout dir: `{workspace}/{dir_name}/`
- Delete scratch dir: `.scratch/connections/scratch/{dir_name}/`
- Delete master worktree: `.scratch/connections/master/{dir_name}/`
- Delete reviewed-dirty worktree: `.scratch/connections/dirty/{dir_name}/`

Remove the connection from the marker file.

##### Detach path

The connection's files remain on disk but are marked as **detached**:

1. Remove the connection from the workspace marker's `connections[]` list (so future downloads skip it).
2. Rewrite the connector-level `.scratchmd` marker inside the connection directory (`{workspace}/{dir_name}/.scratchmd`) to include a `detached: true` field:
   ```yaml
   version: "2"
   detached: true
   workbook:
     id: wkb_abc123
     name: My Workspace
   connector:
     id: coa_xyz789
     displayName: Old Airtable
     service: AIRTABLE
     repoPath: org_123--wkb_abc--coa_xyz
   ```
3. Clean up the git infrastructure (bare repo, worktrees, index DB) since the remote repo no longer exists. Only the materialized files in the dirty checkout directory are preserved.
4. Print: `Connection "Airtable - My Base" detached — files preserved at {workspace}/{dir_name}/`

The detached directory becomes a plain folder of files with no sync capability. The user can manually delete it whenever they choose.

#### 2e. Handle linked table changes

After connection sync, compare the server's linked table list against what exists locally:

- **New linked tables** within existing connections: These will be picked up automatically by the `download_single_repo` step that follows (new files appear in the git fetch from the dirty branch). No special handling needed — just let the normal download flow handle them.
- **Removed linked tables** within existing connections: Similarly, the file deletions propagate through the normal three-way merge in `download_single_repo`. The git fetch will include the deletions from the server.

Linked table changes that belong to **new connections** are handled automatically because step 2c sets up the connection's git repo, and the subsequent download loop fetches the files.

For linked tables belonging to **removed connections**, they are handled by step 2d (the whole connection is either deleted or detached).

No additional linked-table-specific logic is needed beyond what the existing download flow provides — the structural sync of connections is the key missing piece.

#### 2f. Update the marker file

After all additions and removals, rewrite `.scratch/.scratchmd` with the updated connection list. Preserve the original `initialized_at` timestamp.

This requires either:
- A new `markers::rewrite_connections()` function that reads the existing marker, replaces `connections`, and writes it back
- Or modifying `write_workspace` to accept an optional `initialized_at` override

#### 2g. Rebuild connection contexts

After the marker is updated, re-run `build_connection_contexts` so the download loop operates on the current set of connections (including new ones, excluding removed ones).

### Updated `run_download` Flow

```
fn run_download(cwd, server_url, json, on_delete) -> Result<()> {
    // 1. Resolve workspace (existing)
    let (workspace_marker, workspace_dir, _, server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&server_url)?;

    // 2. Workspace sync phase (NEW)
    let sync_result = sync_workspace_structure(
        &workspace_dir,
        &workspace_marker,
        &server_url,
        &token,
        on_delete,
        json,
    )?;

    // 3. Re-read marker and rebuild contexts after sync
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, Some(cwd))?;

    // 4. Download files (existing loop, now with updated contexts)
    let mut results = Vec::new();
    for ctx in &contexts {
        results.push(download_single_repo(ctx, &token)?);
        // ... master worktree, schema sync, index rebuild
    }

    // 5. Regenerate docs (existing)
    generate_docs::write_docs(&workspace_dir, &wb_name);

    // 6. Output (existing + sync summary)
    print_results(sync_result, results, json);
}
```

## Implementation Steps

### Step 1: Extract `setup_connection` helper from `workspaces.rs`

Refactor `init_v2` to extract the per-connection setup loop body (lines 384–430) into a reusable function:

```rust
pub fn setup_connection(
    ca: &ConnectorAccount,
    layout: &WorkspaceLayout,
    token: &str,
) -> anyhow::Result<i64>
```

Update `init_v2` to call this function. No behavior change — purely a refactor.

### Step 2: Add `teardown_connection` helper to `workspaces.rs`

New function to cleanly remove all local artifacts for a connection:

```rust
pub fn teardown_connection(
    entry: &ConnectionEntry,
    layout: &WorkspaceLayout,
) -> anyhow::Result<()>
```

Prunes git worktrees, then removes bare repo, index DB, dirty checkout, scratch dir, master worktree, and reviewed-dirty worktree.

### Step 3: Add `detach_connection` helper

New function to mark a connection as detached:

```rust
pub fn detach_connection(
    entry: &ConnectionEntry,
    workspace_marker: &WorkspaceMarker,
    layout: &WorkspaceLayout,
) -> anyhow::Result<()>
```

Rewrites the connector `.scratchmd` with `detached: true`, then removes git infrastructure (bare repo, worktrees, index DB) while preserving the dirty checkout directory.

### Step 4: Add `detached` field to `ConnectorMarker`

In `markers.rs`, add an optional `detached` field:

```rust
pub struct ConnectorMarker {
    pub version: String,
    #[serde(default)]
    pub detached: bool,
    pub workbook: ConnectorWorkbookRef,
    pub connector: ConnectorRef,
}
```

### Step 5: Update marker write to support preserving `initialized_at`

Add `markers::rewrite_connections()`:

```rust
pub fn rewrite_connections(
    dir: &Path,
    connections: &[ConnectionEntry],
) -> io::Result<()>
```

Reads the existing marker, replaces `connections`, writes it back.

### Step 6: Add `--on-delete` flag to `files download`

Update the `FilesCommands::Download` variant in `files.rs`:

```rust
Download {
    /// What to do when a connection was removed from the server
    #[arg(long, value_enum, default_value = "prompt")]
    on_delete: OnDeleteAction,
},
```

```rust
#[derive(Clone, Copy, clap::ValueEnum)]
enum OnDeleteAction {
    Prompt,
    Remove,
    Keep,
}
```

### Step 7: Implement `sync_workspace_structure`

New function in `files.rs` (or a new `sync.rs` module) that:

1. Fetches workbook from server (requires making `run_download` async, or using a blocking runtime for this call)
2. Diffs server connections against local marker
3. Calls `setup_connection` for additions
4. Calls `teardown_connection` or `detach_connection` for removals based on `on_delete`
5. Calls `markers::rewrite_connections` to update the marker

**Note on async:** `run_download` is currently sync. The API client is async. The simplest approach is to use `tokio::runtime::Handle::current().block_on()` for the API calls within the sync context, matching patterns used elsewhere in the CLI (e.g., `linked` commands call async APIs from sync handlers).

### Step 8: Update output

Extend `DownloadResult` or add a parallel `SyncResult` struct to capture:

```rust
struct WorkspaceSyncResult {
    connections_added: Vec<String>,
    connections_removed: Vec<String>,
    connections_detached: Vec<String>,
}
```

Include this in both human-readable and JSON output.

### Step 9: Update PARITY.md

Add workspace sync on download to the "New capabilities in Rust" table.

## Files to Modify

| File | Change |
|------|--------|
| `src/cli/commands/files.rs` | Add `--on-delete` flag, `sync_workspace_structure`, updated `run_download` flow |
| `src/cli/commands/workspaces.rs` | Extract `setup_connection`, add `teardown_connection`, `detach_connection` |
| `src/cli/config/markers.rs` | Add `detached` to `ConnectorMarker`, add `rewrite_connections()` |
| `docs/PARITY.md` | Document new behavior |

## Edge Cases

- **Connection renamed on server**: The `id` matches but `display_name` changed. The `dir_name` is derived from `display_name`, so a rename would look like a remove + add. The user gets prompted about the "removal" and the new name gets set up fresh. Acceptable for v1.
- **No network**: The API calls needed for the sync phase will fail. Since `files download` already requires network (for `git fetch`), this is consistent. The error should be clear.
- **Partially failed sync**: If setup fails for one new connection, print an error for that connection and continue with the rest. Only successfully set up connections get added to the marker.
- **Already up to date**: If there are no structural changes, the sync phase is a no-op (just the API call overhead). Print nothing extra — proceed directly to file download.
- **Running from inside a connection subdirectory**: Today, `files download` scopes to that single connection. The sync phase should still run for the whole workspace, since structural changes affect the workspace level. After sync, the scoped download proceeds as normal.
- **`--on-delete=keep` + future re-add**: If a connection is detached and then re-added on the server, `setup_connection` will attempt to clone into the same `dir_name`. It should detect the existing directory, skip it or warn, and set up fresh git infrastructure. The detached marker in `.scratchmd` should be removed/overwritten.
- **JSON mode**: When `--json` is active, interactive prompts are not possible. Default to `keep` behavior (preserve files, mark as detached) and include the detached connections in the JSON output so the caller can handle them programmatically.
