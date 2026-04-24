# CLI: Materialize Empty Data Folders

**Date**: 2026-04-23
**Status**: Resolved (2026-04-24)
**Linear**: DEV-9984
**Branch**: `dev-9984-show-empty-folders`

## Implementation Notes

- **Server change was required (plan deviation).** The Rollout section below said "no server changes", but live testing showed the CLI endpoint was dropping `path` from the response. Fixed in [server/src/cli/cli-workbook.controller.ts:128,138](server/src/cli/cli-workbook.controller.ts#L128) (added `path: true` to the Prisma select and `path: df.path` to the DTO mapping) and [server/src/cli/dtos/cli-workbook.dto.ts](server/src/cli/dtos/cli-workbook.dto.ts) (`CliDataFolderDto.path`).
- **Step 5 decision**: `apply_remote_changes_to_working_copy` was audited and skipped. The upload path is synchronous; adding folder reconcile would cascade a sync→async conversion for marginal benefit (next `download` creates any missing folder anyway).
- **Step 6 decision**: no desktop code changes needed. `collectLeafFolders` already emits directories with zero subdirectories, and `FolderTree.tsx` only gates the numeric badge (not the folder name) on `fileCount > 0`. Intermediate-folder selectability is an intentional product decision — not in scope for this ticket.

## Problem

When `scratchmd` initializes a workspace (`init`) or downloads remote changes (`download`), any `DataFolder` that contains zero record files never appears on disk. This hides otherwise-valid folders from users browsing the workspace in Finder/VS Code/the desktop app and makes it look like the folder doesn't exist. Symmetrically, when a folder is deleted server-side between syncs, its empty local directory is left behind.

## Root Cause

The CLI never creates folders from folder metadata — directories are only created as a side effect of writing a record file into them. See [files.rs:3080-3086](scratch-git-2/src/cli/commands/files.rs#L3080-L3086):

```rust
fn write_file(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // ...
}
```

Two flows both rely on this side effect:

1. **Workspace init** — [workspaces.rs:620](scratch-git-2/src/cli/commands/workspaces.rs#L620) `setup_connection()` clones a bare repo and runs a sparse checkout. Git does not track empty directories, so any folder that is empty on the remote has no tree entry and is never created on disk.
2. **Download** — [files.rs:2882-2897](scratch-git-2/src/cli/commands/files.rs#L2882-L2897) `materialize_local_repo()` iterates the file map and calls `write_file` per record. Folders with no files get no calls.

The server already returns folder metadata on the workbook fetch: `ConnectorAccount.dataFolders: DataFolder[]` where each folder has a POSIX `path` (see [data-folder.entity.ts:21](server/src/workbook/entities/data-folder.entity.ts#L21)). The CLI's Rust `DataFolder` struct at [api/mod.rs:246-249](scratch-git-2/src/cli/api/mod.rs#L246-L249) currently only deserializes `id` and `name` — the `path` field is dropped on the floor.

## Desired Behavior

After either `init` or `download` completes:

1. Every `DataFolder` that the server reports for a connection exists as a directory on disk under that connection's `dirty_dir`, regardless of whether it contains any record files.
2. Any empty local directory under `dirty_dir` that does **not** correspond to a server-reported `DataFolder` is removed (symmetric cleanup for server-side folder deletion).
3. The desktop app's sidebar reflects (1) and (2) on the next refresh.

## Approach

Introduce a single helper that reconciles the on-disk folder set with the server's folder list for a given connection:

- Ensure every server folder path exists via `std::fs::create_dir_all`.
- Prune local directories that (a) do not correspond to any server folder path and (b) are empty after record-file materialization completes. The "empty" guard keeps us out of the record-file merge lane — non-empty directories are already managed by the existing merge/delete logic.

Call this helper at the end of both materialization paths. Do **not** change `write_file` or try to infer empty folders from the file map — use the authoritative folder list from the API.

### Why not store folder paths in the workspace marker?

Tempting, but folders are created and deleted on the server between syncs. Reading the marker would go stale; re-fetching is the correct source of truth. The init path already has the fresh `Workbook` in hand. The download path currently works off the local workspace marker only — it needs a small addition to fetch folder metadata.

## Implementation Steps

### 1. Expose `path` on the CLI's `DataFolder`

Edit [api/mod.rs:246-249](scratch-git-2/src/cli/api/mod.rs#L246-L249):

```rust
pub struct DataFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
}
```

Update the two `data_folders: vec![]` test fixtures ([tests/workspaces.rs:46,184](scratch-git-2/src/cli/commands/tests/workspaces.rs#L46)) — no changes needed since they use `Default` construction. Verify via `cargo build`.

### 2. Add a shared helper

Add to `commands/files.rs` (or a small new module `commands/folders.rs` if preferred):

```rust
/// Reconcile on-disk folders under `dirty_dir` with the server's folder list.
///
/// 1. Creates a directory for every folder path (parents included).
/// 2. Prunes any local directory not in the server set, but only if empty —
///    non-empty dirs are owned by the record-file merge path.
pub fn reconcile_data_folder_dirs(
    dirty_dir: &Path,
    data_folders: &[crate::api::DataFolder],
) -> anyhow::Result<()> {
    let mut wanted: HashSet<PathBuf> = HashSet::new();
    for df in data_folders {
        let Some(path) = df.path.as_deref() else { continue };
        let trimmed = path.trim_start_matches('/');
        if trimmed.is_empty() { continue; }
        let target = dirty_dir.join(trimmed);
        std::fs::create_dir_all(&target)
            .with_context(|| format!("create empty data folder dir {}", target.display()))?;
        // Mark every ancestor up to dirty_dir as wanted so we don't prune them.
        let mut cursor = target.as_path();
        while cursor != dirty_dir {
            wanted.insert(cursor.to_path_buf());
            let Some(parent) = cursor.parent() else { break };
            cursor = parent;
        }
    }
    prune_empty_unknown_dirs(dirty_dir, dirty_dir, &wanted)?;
    Ok(())
}

/// Walk `dirty_dir` post-order; remove any directory that is both (a) absent
/// from `wanted` and (b) empty after any deeper pruning has run. Hidden
/// entries (e.g. `.scratch`, `.scratchmd`) are never descended into or removed.
fn prune_empty_unknown_dirs(
    root: &Path,
    dir: &Path,
    wanted: &HashSet<PathBuf>,
) -> anyhow::Result<()> { /* ... */ }
```

Per [CLAUDE.md](CLAUDE.md): `DataFolder.path always starts with /`. The `trim_start_matches('/')` is defensive — a leading slash would make `join` treat it as absolute and escape `dirty_dir`.

Safety notes for the pruner:

- Skip `.scratch`, `.scratchmd`, and any other dotfile entries — these are CLI metadata, not data folders.
- Post-order traversal ensures a deleted leaf lets its (also-unwanted) parent become empty and get pruned in turn.
- `std::fs::remove_dir` (not `remove_dir_all`) — fails if non-empty, which is exactly the safety guard we want. No `-rf`.

### 3. Wire into `init` path

In [workspaces.rs:620 `setup_connection`](scratch-git-2/src/cli/commands/workspaces.rs#L620), after `materialize_dirty_checkout` (line 641) succeeds, call:

```rust
reconcile_data_folder_dirs(&dirty_dir, &ca.data_folders)?;
```

The `ConnectorAccount` is already in scope and carries `data_folders` from the workbook fetch — no extra API call needed. On init the prune step is a no-op (fresh clone) but calling the same helper keeps the two paths consistent.

### 4. Wire into `download` path

`download_single_repo` in [files.rs:1901](scratch-git-2/src/cli/commands/files.rs#L1901) currently has no folder metadata. Two sub-steps:

- In `download_workbook` at [files.rs:1548](scratch-git-2/src/cli/commands/files.rs#L1548), fetch the workbook once before the loop:

  ```rust
  let wb: crate::api::Workbook = client.get(&format!("workbooks/{}", workbook_id)).await?;
  ```

  (Requires taking `server_url` from the workspace marker — already done for other paths via `workspace_marker.workbook.server_url`.)

- Match each `ConnectionContext` to its `ConnectorAccount` by `id == ctx.connection_id`, then pass the folder slice into `download_single_repo`, which calls `reconcile_data_folder_dirs(&ctx.dirty_dir, folders)` after [`materialize_local_repo` at line 1992](scratch-git-2/src/cli/commands/files.rs#L1992). Ordering matters: reconcile must run _after_ file materialization so that folders freshly emptied by the download are eligible for pruning.

- If the connector is no longer on the server (stale local marker), skip reconciliation for that connection rather than bailing — teardown of a whole connection is a different flow.

### 5. Other materialization sites

Audit these for the same gap and apply `reconcile_data_folder_dirs` where user-visible:

- `apply_remote_changes_to_working_copy` ([files.rs:2901](scratch-git-2/src/cli/commands/files.rs#L2901)) — used during merges.
- Any `reviewed_dirty_dir` / `master_dir` population — these are internal diff scaffolding and should **not** get empty folders (they should mirror git state exactly). Confirm during implementation.

### 6. Desktop app

The desktop reads the folder list from disk, so the CLI change is the primary fix. But the current disk walker has a shape issue that interacts with this work — address it in the same PR.

**Current behavior** ([scratch-desktop/src/main/local-files.ts:694-717](scratch-desktop/src/main/local-files.ts#L694-L717)): `collectLeafFolders` only emits directories that have **no subdirectories**. An intermediate folder (has children) is never emitted as its own entry, regardless of whether it holds record files.

**Implications after the CLI change:**

- An empty leaf `DataFolder` → emitted → appears in sidebar. ✓ Works automatically.
- An empty intermediate `DataFolder` (has child `DataFolder`s, no records) — the CLI will create the directory, but `collectLeafFolders` still won't emit it. The sidebar's `buildTree` ([FolderTree.tsx:57-80](scratch-desktop/src/renderer/src/pages/workspace/FolderTree.tsx#L57-L80)) may synthesize an intermediate node from path segments; verify it renders and is navigable.

**Required change**: audit whether intermediate nodes are real, interactive DataFolders in the UI. If `buildTree` only renders them as path segments (not selectable), broaden `collectLeafFolders` to emit **every** non-hidden directory (not just leaves) and teach `buildTree` to prefer the emitted entry over a synthesized segment when both exist. Keep `computeFolderStats` as-is — it already returns `fileCount: 0` for empty dirs, which is the correct display.

If the audit shows the current leaf-only model is intentional (DataFolders cannot contain both records and child folders), document that in the file and note this plan as resolved for the desktop side — no code change needed beyond verifying empty leaves render.

### 7. Tests

- Unit test for `reconcile_data_folder_dirs`:
  - Creates missing directories: paths `/Foo`, `/Bar/Baz` under an empty tempdir → both exist after call.
  - Skips junk paths: entries with `path: None` and `path: "/"` are ignored without panicking.
  - Prunes unknown empty dirs: seed tempdir with `/Stale`, call with empty folder list → `/Stale` is gone.
  - Leaves non-empty unknown dirs alone: seed `/HasFile/record.json`, call with empty folder list → `/HasFile` still exists.
  - Never removes `.scratch` or `.scratchmd`: seed both, call with empty folder list → both still exist.
- Integration extension in [tests/workspaces.rs](scratch-git-2/src/cli/commands/tests/workspaces.rs): a stub `ConnectorAccount` with two `DataFolder`s but an empty git tree → after `setup_connection`, both folder paths exist under `dirty_dir`.
- Integration for download:
  - Remote adds a new empty folder → local `dirty_dir` picks it up.
  - Remote removes a folder that was empty locally → local directory is pruned.
  - Remote removes a folder that still has a user-edited file locally → directory is preserved (covered by the "empty" guard).
- Manual desktop check: after `scratchmd init` of a workbook with one empty folder, the folder appears in the desktop sidebar on next refresh.

## Resolved Decisions

1. **Nullable `path`**: skip folders where `path` is `null` or empty. Not expected to occur in practice — `DataFolder.path` should always be populated server-side — but the code handles it defensively.
2. **Server-side folder deletion**: reconcile prunes the local directory when the server no longer reports it, but only if the directory is empty. This keeps the change in the folder-metadata lane and never touches directories that still hold record files — those go through the existing merge/delete path.
3. **Desktop app**: reads folder list from disk via [scratch-desktop/src/main/local-files.ts:137](scratch-desktop/src/main/local-files.ts#L137). Empty _leaf_ folders will appear automatically once the CLI creates them. Empty _intermediate_ folders need a `collectLeafFolders` audit (see step 6).

## Rollout

- Single PR on `dev-9984-show-empty-folders`.
- No migration, no data changes, no server changes.
- Rust CLI + (conditionally) desktop TypeScript.
- `cargo fmt && cargo test` in `scratch-git-2/`; `yarn build && yarn lint` at the repo root.
