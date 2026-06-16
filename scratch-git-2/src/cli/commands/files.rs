use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use clap::Subcommand;
use serde_json::Value as JsonValue;

use crate::api::{ConnectorAccount, DataFolder};
use crate::config::markers;
use crate::shared::folder_index;
use crate::shared::layout::{OldLayoutDetection, WorkspaceLayout};
use crate::shared::review_ops::{
    self, compute_accepted_state, is_data_path_in_folder, parse_json_value_at, write_file,
    ConnectionPaths, FieldCommandResult, FileMap,
};
use crate::shared::validators;

#[derive(Clone, Copy, clap::ValueEnum)]
pub enum OnDeleteAction {
    /// Interactively ask per removed connection
    Prompt,
    /// Automatically delete removed connections
    Remove,
    /// Automatically keep removed connections as detached
    Keep,
}

#[derive(Subcommand)]
pub enum FilesCommands {
    /// Download remote changes — re-anchors accepted patches against the new server `main` and replays them onto the worktree. Refuses with a structured error if any unreviewed working-tree edits exist.
    Download {
        /// What to do when a connection was removed from the server
        #[arg(long, value_enum, default_value = "prompt")]
        on_delete: OnDeleteAction,
        /// Skip refreshing the per-folder SQLite index for changed records.
        /// By default, `index refresh-files-full` runs for each affected folder so the
        /// grid stays current without a follow-up `index rebuild-folder` sweep.
        #[arg(long = "skip-folder-index")]
        skip_folder_index: bool,
    },
    /// Accept all current working-tree record changes (writes to accepted-patches.json)
    #[command(name = "accept-all")]
    AcceptAll {
        /// Optional folder to scope the accept to (e.g. "ConnectionName/folder").
        /// When unset, accepts across every connection in the workspace.
        #[arg(long)]
        folder: Option<PathBuf>,
        /// Skip refreshing the per-folder SQLite index for the accepted records.
        /// By default, `index refresh-files-full` runs for each affected folder so the grid stays current.
        #[arg(long = "skip-folder-index")]
        skip_folder_index: bool,
    },
    /// Discard every pending and approved-but-unpublished change, reverting records to their last published state
    #[command(name = "discard-all")]
    DiscardAll {
        /// Optional folder to scope the discard to (e.g. "ConnectionName/folder").
        /// When unset, discards across every connection in the workspace.
        #[arg(long)]
        folder: Option<PathBuf>,
        /// Skip refreshing the per-folder SQLite index for the discarded records.
        /// By default, `index refresh-files-full` runs for each affected folder so the grid stays current.
        #[arg(long = "skip-folder-index")]
        skip_folder_index: bool,
    },
    /// Discard pending and approved-but-unpublished changes for one or more specific paths, reverting them to their last published state
    Discard {
        /// Paths to discard, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Discard every unreviewed working-tree change, restoring records to their last accepted state
    #[command(name = "reject-all")]
    RejectAll {
        /// Optional folder to scope the reject to (e.g. "ConnectionName/folder").
        /// When unset, rejects across every connection in the workspace.
        #[arg(long)]
        folder: Option<PathBuf>,
        /// Skip refreshing the per-folder SQLite index for the rejected records.
        /// By default, `index refresh-files-full` runs for each affected folder so the grid stays current.
        #[arg(long = "skip-folder-index")]
        skip_folder_index: bool,
    },
    /// Accept one or more working-tree changes (writes to accepted-patches.json)
    Accept {
        /// Paths to accept, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        /// Multiple paths are upserted into the patch file in a single atomic write per connection.
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Accept one field's value across all records in a folder (writes to accepted-patches.json)
    #[command(name = "accept-field")]
    AcceptField {
        /// Folder path relative to the workspace root, or absolute path to a folder inside the workspace
        #[arg(long)]
        folder: PathBuf,
        /// Dot-separated field path to accept (for example: "name" or "author.name")
        #[arg(long)]
        field: String,
    },
    /// Restore one or more files' working-tree content to their approved state
    Reject {
        /// Paths to reject, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Restore one field's working value across all records in a folder to its approved value
    #[command(name = "reject-field")]
    RejectField {
        /// Folder path relative to the workspace root, or absolute path to a folder inside the workspace
        #[arg(long)]
        folder: PathBuf,
        /// Dot-separated field path to reject (for example: "name" or "author.name")
        #[arg(long)]
        field: String,
    },
    /// Discard one field's value across all records in a folder, restoring it to the main-branch value
    ///
    /// Differs from `reject-field`: reject undoes only the unreviewed working delta,
    /// discard rolls the field all the way back to its published value AND drops the
    /// field from any accepted-patches entry. If discarding empties a `create` patch
    /// entry, the working file is also removed.
    #[command(name = "discard-field")]
    DiscardField {
        /// Folder path relative to the workspace root, or absolute path to a folder inside the workspace
        #[arg(long)]
        folder: PathBuf,
        /// Dot-separated field path to discard (for example: "name" or "author.name")
        #[arg(long)]
        field: String,
    },
    /// Restore one or more approved deletions: write main-branch content back to the worktree and drop the patch entry
    #[command(name = "restore-deleted-record")]
    RestoreDeletedRecord {
        /// Paths to restore, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Discard one or more approved creates: remove them from the worktree and drop the patch entry
    #[command(name = "discard-created-record")]
    DiscardCreatedRecord {
        /// Paths to discard, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// List record changes that exist only in the working tree and have not been accepted locally
    Unreviewed,
    /// Per-folder counts of unreviewed and approved-but-unpublished records across every connection in the workspace.
    ///
    /// Reads the persisted `approvedChanges` / `unapprovedChanges` bit columns from each folder's
    /// SQLite index — no mtime walk, no JSON parse, no git. Folders that haven't been indexed
    /// yet (or where both counts are zero) are omitted. Use `index refresh-folder` first if you
    /// need fresh bits for folders that have changed since the last index update.
    #[command(name = "get-review-stats")]
    GetReviewStats,
    /// List entries in accepted-patches.json (accepted locally but not yet published)
    Unpublished,
    /// List entries in accepted-patches.json (alias of `unpublished`, kept for back-compat)
    Unpushed,
    /// Upload locally accepted changes to the server's dirty branch (no publish).
    ///
    /// Reads accepted-patches.json verbatim and POSTs the payload to
    /// `/upload-patch/{init,commit}`. The server applies the patches to its
    /// dirty branch and stops there — running the publish plan + dispatching
    /// to external connectors is a separate step (`scratchmd files publish`).
    Upload {
        /// Skip refreshing the per-folder SQLite index for changed records.
        /// By default, `index refresh-files-full` runs for each affected folder so the
        /// grid stays current without a follow-up `index rebuild-folder` sweep.
        #[arg(long = "skip-folder-index")]
        skip_folder_index: bool,
    },
    /// Publish accepted changes to external connectors (plan-job + run-job).
    ///
    /// Drives `/publish-v2/plan-job` (builds the plan from the server's
    /// current dirty vs main) and then `/publish-v2/run-job` (executes the
    /// plan, dispatching to the external service). Does NOT upload local
    /// changes — run `scratchmd files upload` first if you have unpublished
    /// local accepted edits.
    Publish,
    /// Roll back records from a publish plan to their pre-publish values.
    ///
    /// Reads the pre-publish blobs **locally** from the workspace's bare
    /// repo at `preMainCommitSha` (an ancestor of current main), writes
    /// them to the working tree, and snapshots the result into
    /// `accepted-patches.json` so the records surface as
    /// approved-but-unpublished. Records that didn't exist pre-publish
    /// (Creates) are reverted by deleting the working file.
    ///
    /// `--file-path` rolls back a single record; the filter flags
    /// (`--data-folder-id` / `--phase` / `--filename`) operate on the
    /// plan's full record list fetched fresh from the server. Without any
    /// flags, the entire plan is rolled back.
    #[command(name = "revert-plan")]
    RevertPlan {
        /// Publish plan id.
        #[arg(long = "plan-id")]
        plan_id: String,
        /// Single-record mode: connection-relative path
        /// (e.g. `/public/posts/post-102.json`).
        #[arg(long = "file-path")]
        file_path: Option<String>,
        /// Data-folder filter (matches the records endpoint).
        #[arg(long = "data-folder-id")]
        data_folder_id: Option<String>,
        /// Phase filter (`edit`, `create`, `delete`, …).
        #[arg(long = "phase")]
        phase: Option<String>,
        /// Filename-substring filter, case-insensitive.
        #[arg(long = "filename")]
        filename: Option<String>,
    },
}

#[derive(Clone)]
struct ConnectionContext {
    connection_id: String,
    conn_dir_name: String,
    worktree_dir: PathBuf,
    scratch_dir: PathBuf,
    workspace_dir: PathBuf,
    bare_repo: PathBuf,
    db_path: PathBuf,
}

impl ConnectionContext {
    /// Subset of fields review_ops needs. Derives the workspace root from
    /// `worktree_dir.parent()` because `workspace_dir` is historically the
    /// workbook materialization path (`<workspace>/.scratch/workspace`),
    /// not the workspace root — same derivation [`accepted_patches_dir`]
    /// used before slice H moved it to shared.
    fn to_paths(&self) -> ConnectionPaths {
        let workspace_root = self
            .worktree_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        ConnectionPaths {
            conn_dir_name: self.conn_dir_name.clone(),
            workspace_dir: workspace_root,
            worktree_dir: self.worktree_dir.clone(),
            bare_repo: self.bare_repo.clone(),
            scratch_dir: self.scratch_dir.clone(),
        }
    }
}

// Thin wrappers that adapt this module's `ConnectionContext` to
// `review_ops::ConnectionPaths` so existing call sites don't have to change.
// Slice H.2 may inline these once napi callers force a different style.

fn accepted_patches_dir(ctx: &ConnectionContext) -> PathBuf {
    review_ops::accepted_patches_dir(&ctx.to_paths())
}

fn read_worktree_files_and_scratch_state(ctx: &ConnectionContext) -> anyhow::Result<FileMap> {
    review_ops::read_worktree_files_and_scratch_state(&ctx.to_paths())
}

fn write_or_remove_working_file(
    ctx: &ConnectionContext,
    rel_path: &str,
    bytes: Option<&[u8]>,
) -> anyhow::Result<()> {
    review_ops::write_or_remove_working_file(&ctx.to_paths(), rel_path, bytes)
}

fn apply_changed_working_files(
    ctx: &ConnectionContext,
    previous_file_path_to_contents_map_in_worktree: &FileMap,
    next_file_path_to_contents_map_in_worktree: &FileMap,
    repo_folder: &str,
) -> anyhow::Result<()> {
    review_ops::apply_changed_working_files(
        &ctx.to_paths(),
        previous_file_path_to_contents_map_in_worktree,
        next_file_path_to_contents_map_in_worktree,
        repo_folder,
    )
}

fn sync_schema_files_from_worktree(ctx: &ConnectionContext) -> anyhow::Result<()> {
    review_ops::sync_schema_files_from_worktree(&ctx.to_paths())
}

fn accept_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    file_path_to_contents_map_in_main_branch: &FileMap,
    file: &mut crate::shared::accepted_patches::AcceptedPatchesFile,
    file_path_to_contents_map_in_worktree: &FileMap,
) -> anyhow::Result<FieldCommandResult> {
    review_ops::accept_field_in_folder(
        &ctx.conn_dir_name,
        repo_folder,
        field,
        file_path_to_contents_map_in_main_branch,
        file,
        file_path_to_contents_map_in_worktree,
    )
}

fn reject_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    file_path_to_contents_map_in_main_branch: &FileMap,
    file: &crate::shared::accepted_patches::AcceptedPatchesFile,
    file_path_to_contents_map_in_worktree: &FileMap,
) -> anyhow::Result<(FileMap, FieldCommandResult)> {
    review_ops::reject_field_in_folder(
        &ctx.conn_dir_name,
        repo_folder,
        field,
        file_path_to_contents_map_in_main_branch,
        file,
        file_path_to_contents_map_in_worktree,
    )
}

fn discard_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    file_path_to_contents_map_in_main_branch: &FileMap,
    file: &mut crate::shared::accepted_patches::AcceptedPatchesFile,
    file_path_to_contents_map_in_worktree: &FileMap,
) -> anyhow::Result<(FileMap, FieldCommandResult)> {
    review_ops::discard_field_in_folder(
        &ctx.conn_dir_name,
        repo_folder,
        field,
        file_path_to_contents_map_in_main_branch,
        file,
        file_path_to_contents_map_in_worktree,
    )
}

#[derive(Default)]
struct WorkspaceSyncResult {
    connections_added: Vec<String>,
    connections_removed: Vec<String>,
    connections_detached: Vec<String>,
}

#[derive(Default)]
struct DownloadResult {
    status: String,
    files_created: i32,
    files_updated: i32,
    files_deleted: i32,
    files_merged: i32,
    conflicts_auto_resolved: i32,
    messages: Vec<String>,
    /// Repo-relative data paths whose dirty branch or working tree moved
    /// during this download. Used by the caller to drive a targeted
    /// folder_index reindex instead of a workspace-wide one.
    changed_paths: Vec<String>,
}

#[derive(Default)]
struct UploadResult {
    /// Connection directory name (e.g. "HubSpot"). Empty for the aggregate
    /// result. Lets the desktop modal render per-connection cards.
    connection_name: String,
    /// Repo-relative data paths whose local trees moved during this upload.
    /// Drives the caller's per-path folder_index reindex.
    changed_paths: Vec<String>,
    status: String,
    /// New files (present in dirty, absent from main).
    files_created: i32,
    /// Edits (present in both, with field-level differences).
    files_updated: i32,
    /// Deletes (present in main, absent from dirty).
    files_deleted: i32,
    files_merged: i32,
    files_plan: i32,
    conflicts_auto_resolved: i32,
    retries: i32,
    messages: Vec<String>,
    created_paths: Vec<String>,
    updated_paths: Vec<String>,
    deleted_paths: Vec<String>,
    merged_paths: Vec<String>,
    /// Soft signal from `/upload-patch/commit` that the server has more
    /// recent changes than what's on the client. Patches were still applied;
    /// the desktop surfaces this as a non-blocking banner. Only populated
    /// when the connection used the legacy soft-warning path
    /// (`refuse_if_stale: false`); the new D8 strict-mode path returns
    /// `blocked_stale` instead.
    staleness_warning: Option<crate::api::StalenessWarning>,
    /// D8 strict-mode refusal payload: the server's `refs/heads/main` had
    /// advanced past the client's `baseHead` and the call was sent with
    /// `refuseIfStale: true`. When `Some`, `status == "blocked_stale"` and
    /// no patches were applied. `run_upload` collects these across the loop
    /// and bails with a structured `blocked_stale` workspace-level payload.
    blocked_stale: Option<crate::api::BlockedStaleResponse>,
    /// DEV-10316 dirty-gate refusal payload: this connection's `dirty` branch
    /// held unpublished changes vs live `main` and the call was sent with
    /// `refuseIfDirty: true`. When `Some`, `status == "blocked_dirty"` and no
    /// patches were applied. Surfaced count-only.
    blocked_dirty: Option<crate::api::BlockedDirtyResponse>,
    /// DEV-10316 fail-closed check failure: the dirty-gate check itself could
    /// not run (git service down/busy). When `Some`, `status == "check_failed"`
    /// and no patches were applied. Retryable.
    check_failed: Option<crate::api::CheckFailedResponse>,
    /// DEV-10316 publish-time TOCTOU token: the connection's `dirty` HEAD after
    /// this upload's apply-patches job landed (read off the job's
    /// `publicProgress.dirtyHead`). The desktop carries it to
    /// `/publish-v2/plan-job` as `expectedBaseDirtyHead` so the plan build can
    /// abort if the staging area drifts before publish. `None` when the apply
    /// produced no job (no changes) or the server didn't surface a HEAD.
    dirty_head: Option<String>,
}

#[derive(Default)]
struct AcceptAllResult {
    files_accepted: i32,
    accepted_paths: Vec<String>,
}

#[derive(Default)]
struct RejectAllResult {
    files_rejected: i32,
    rejected_paths: Vec<String>,
}

#[derive(Debug, Default)]
struct DiscardAllResult {
    files_discarded: i32,
    discarded_paths: Vec<String>,
    skipped_missing_main: bool,
}

#[derive(Default)]
struct RemoteDiscardResult {
    changed_paths: Vec<String>,
    remote_discarded_paths: Vec<String>,
}

fn revalidate_paths_for_connection_context(
    ctx: &ConnectionContext,
    rel_paths: &[String],
    rebuild: bool,
) -> anyhow::Result<()> {
    let selected_paths = if rebuild || rel_paths.is_empty() {
        None
    } else {
        Some(rel_paths.iter().cloned().collect::<HashSet<_>>())
    };
    if let Err(err) = validators::run_validations(
        &ctx.scratch_dir,
        &ctx.worktree_dir,
        &ctx.workspace_dir,
        &ctx.bare_repo,
        &ctx.db_path,
        rebuild,
        selected_paths.as_ref(),
    ) {
        eprintln!("[validation] error processing {}: {err}", ctx.conn_dir_name);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct RecordChangeEntry {
    #[serde(rename = "connectionName")]
    connection_name: String,
    path: String,
    status: String,
}

pub async fn run(cmd: FilesCommands, server_url: &str, json: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;

    match cmd {
        FilesCommands::Download {
            on_delete,
            skip_folder_index,
        } => run_download(&cwd, server_url, json, on_delete, skip_folder_index).await,
        FilesCommands::AcceptAll {
            folder,
            skip_folder_index,
        } => run_accept_all(&cwd, server_url, folder.as_deref(), json, skip_folder_index),
        FilesCommands::DiscardAll {
            folder,
            skip_folder_index,
        } => run_discard_all(&cwd, server_url, folder.as_deref(), json, skip_folder_index),
        FilesCommands::Discard { paths } => run_discard(&cwd, &paths, json),
        FilesCommands::RejectAll {
            folder,
            skip_folder_index,
        } => run_reject_all(&cwd, server_url, folder.as_deref(), json, skip_folder_index),
        FilesCommands::Accept { paths } => run_accept(&cwd, server_url, &paths, json),
        FilesCommands::AcceptField { folder, field } => {
            run_accept_field(&cwd, &folder, &field, json)
        }
        FilesCommands::Reject { paths } => run_reject(&cwd, &paths, json),
        FilesCommands::RejectField { folder, field } => {
            run_reject_field(&cwd, &folder, &field, json)
        }
        FilesCommands::DiscardField { folder, field } => {
            run_discard_field(&cwd, &folder, &field, json)
        }
        FilesCommands::RestoreDeletedRecord { paths } => {
            run_restore_deleted_record(&cwd, server_url, &paths, json)
        }
        FilesCommands::DiscardCreatedRecord { paths } => {
            run_discard_created_record(&cwd, server_url, &paths, json).await
        }
        FilesCommands::Unreviewed => run_unreviewed(&cwd, server_url, json),
        FilesCommands::GetReviewStats => run_get_review_stats(&cwd, server_url, json),
        FilesCommands::Unpublished => run_unpublished(&cwd, server_url, json),
        FilesCommands::Unpushed => run_unpushed(&cwd, server_url, json),
        FilesCommands::Upload { skip_folder_index } => {
            run_upload(&cwd, server_url, json, skip_folder_index).await
        }
        FilesCommands::Publish => run_publish(&cwd, server_url, json).await,
        FilesCommands::RevertPlan {
            plan_id,
            file_path,
            data_folder_id,
            phase,
            filename,
        } => {
            run_revert_plan(
                &cwd,
                server_url,
                &plan_id,
                file_path.as_deref(),
                data_folder_id.as_deref(),
                phase.as_deref(),
                filename.as_deref(),
                json,
            )
            .await
        }
    }
}

fn get_token(server_url: &str) -> anyhow::Result<String> {
    let creds = crate::config::credentials::get(server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))?;
    if creds.api_token.is_empty() {
        anyhow::bail!("Not authenticated. Run `scratchmd auth login` first.");
    }
    Ok(creds.api_token)
}

async fn run_download(
    cwd: &Path,
    server_url: &str,
    json: bool,
    on_delete: OnDeleteAction,
    skip_folder_index: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (workspace_marker, workspace_dir, _initial_contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url, json)?;
    let token = get_token(&workspace_server_url)?;

    // Workspace-wide advisory lock for the whole pull: sync, pre-flight,
    // fetch, re-anchor, materialize, ref bump. Matches run_upload's
    // discipline; replaces the implicit serialization the three-worktree
    // model used to give us.
    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    // Workspace sync phase: detect structural drift and reconcile
    let sync_result = sync_workspace_structure(
        &workspace_dir,
        &workspace_marker,
        &workspace_server_url,
        &token,
        on_delete,
        json,
    )
    .await?;

    // Re-read marker and rebuild contexts after sync
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, Some(cwd))?;

    let has_sync_changes = !sync_result.connections_added.is_empty()
        || !sync_result.connections_removed.is_empty()
        || !sync_result.connections_detached.is_empty();

    if contexts.is_empty() && !has_sync_changes {
        anyhow::bail!(
            "No connections found in {}. Run `scratchmd workspaces init` first.",
            workspace_dir.display()
        );
    }

    let server_state = fetch_connection_server_state(
        &workspace_server_url,
        &workspace_marker,
        &workspace_marker.workbook.id,
    )
    .await;

    // Refuse the pull if the server restructured a folder layout (DEV-9698) for
    // a connection we're about to download — the recorded structure version no
    // longer matches the server. Bail BEFORE re-anchor/materialize so a stale
    // clone's accepted-patches.json is never mangled by the folder move; the
    // user re-clones (which salvages any un-uploaded edits first). Scoped to the
    // selected `contexts` so working in a healthy connection isn't blocked by an
    // unrelated stale one. Checked ahead of the unreviewed-edits pre-flight
    // because a re-clone supersedes accepting/discarding edits.
    let downloaded_connection_ids: HashSet<&str> =
        contexts.iter().map(|c| c.connection_id.as_str()).collect();
    let structure_drift: Vec<StructureVersionDrift> =
        detect_structure_version_drift(&workspace_marker, &server_state)
            .into_iter()
            .filter(|d| downloaded_connection_ids.contains(d.connection_id.as_str()))
            .collect();
    if !structure_drift.is_empty() {
        print_structure_change_reinit_result(&structure_drift, json)?;
        anyhow::bail!(
            "This workspace's folder structure changed on the server and needs to be reinitialized."
        );
    }

    // Pre-flight: refuse the pull if any connection has unreviewed
    // working-tree edits. All-or-nothing — partial pulls leave the workspace
    // in a confusing mixed state. No fetch happens; the user must
    // `accept-all` or `discard-all` before retrying. See [Slice D in
    // docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md].
    //
    // Uses the gix::status-backed fast path (~210ms warm per connection vs.
    // multi-second tree walks; mr31's helper) so the courtesy check doesn't
    // dominate the pull time when nothing is actually unreviewed — which is
    // the common case, especially when the desktop's "Download and publish"
    // flow chained us straight out of an already-cleared publish modal.
    let mut blocked: Vec<RecordChangeEntry> = Vec::new();
    for ctx in &contexts {
        blocked.extend(
            list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(ctx, false)?,
        );
    }
    if !blocked.is_empty() {
        print_blocked_unreviewed_result(&blocked, started.elapsed().as_millis(), json)?;
        anyhow::bail!(
            "{} unreviewed record(s) — run `scratchmd files accept-all` or `discard-all`, then retry.",
            blocked.len()
        );
    }

    let mut results = Vec::new();
    let mut all_changed_workspace_paths: Vec<String> = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Downloading {}...", ctx.conn_dir_name);
        }
        let folders: &[DataFolder] = server_state
            .get(&ctx.connection_id)
            .map(|s| s.data_folders.as_slice())
            .unwrap_or(&[]);
        let mut download_result = download_single_repo(ctx, &workspace_dir, &token, folders)?;
        // `update_main_worktree_after_pull` is best-effort — failures here shouldn't
        // bubble up because the dirty-side download already succeeded. Fall
        // back to "no master change" on error.
        let master_update = update_main_worktree_after_pull(ctx, &token).unwrap_or_default();
        if master_update.moved {
            // Schema files on master may have moved alongside data files;
            // resync them into ctx.scratch_dir. Gated on `moved` so unchanged
            // connections pay zero cost in the per-ctx loop.
            let _ = sync_schema_files_from_worktree(ctx);
        }
        // Merge the master-side path diff into the download result so the
        // single `changed_paths` field downstream covers any tree the
        // folder_index needs to recompute its bits against.
        if !master_update.changed_paths.is_empty() {
            let mut seen: HashSet<String> = download_result.changed_paths.iter().cloned().collect();
            for path in master_update.changed_paths {
                if seen.insert(path.clone()) {
                    download_result.changed_paths.push(path);
                }
            }
        }
        // Promote to workspace-relative (prefixed with conn_dir_name) so
        // the post-loop folder_index reindex can route each path to the
        // right per-folder table without needing per-ctx attribution.
        for path in &download_result.changed_paths {
            all_changed_workspace_paths.push(format!("{}/{}", ctx.conn_dir_name, path));
        }
        results.push(download_result);
    }

    let wb_name = if workspace_marker.workbook.name.is_empty() {
        workspace_marker.workbook.id.as_str()
    } else {
        workspace_marker.workbook.name.as_str()
    };
    let _ = super::generate_docs::write_docs(&workspace_dir, wb_name);

    // Per-path folder_index reindex. Empty when no connection had any
    // changed files — that's the dominant path for "small publish in a
    // multi-connection workspace" and produces a zero-cost no-op.
    if !skip_folder_index {
        reindex_folder_index_for_changes(&workspace_dir, &all_changed_workspace_paths)?;
    }

    let result = if results.len() == 1 {
        results.into_iter().next().unwrap_or_default()
    } else {
        aggregate_download(&results)
    };

    print_download_result(&sync_result, &result, started.elapsed().as_millis(), json)
}

async fn sync_workspace_structure(
    workspace_dir: &Path,
    workspace_marker: &markers::WorkspaceMarker,
    server_url: &str,
    token: &str,
    on_delete: OnDeleteAction,
    json: bool,
) -> anyhow::Result<WorkspaceSyncResult> {
    let client = crate::api::ApiClient::from_credentials(server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))?;

    let wb: crate::api::Workbook = client
        .get(&format!("workbooks/{}", workspace_marker.workbook.id))
        .await?;

    let local_ids: std::collections::HashSet<&str> = workspace_marker
        .connections
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    let server_ids: std::collections::HashSet<&str> = wb
        .connector_accounts
        .iter()
        .map(|ca| ca.id.as_str())
        .collect();

    let added: Vec<&ConnectorAccount> = wb
        .connector_accounts
        .iter()
        .filter(|ca| !local_ids.contains(ca.id.as_str()))
        .collect();
    let removed: Vec<&markers::ConnectionEntry> = workspace_marker
        .connections
        .iter()
        .filter(|c| !server_ids.contains(c.id.as_str()))
        .collect();

    // If nothing changed, return early
    if added.is_empty() && removed.is_empty() {
        return Ok(WorkspaceSyncResult::default());
    }

    let layout = WorkspaceLayout::for_cli(workspace_dir);
    let mut result = WorkspaceSyncResult::default();

    // If the workspace was initialized with the legacy "<Service> - <DisplayName>"
    // pattern, keep using it for new connections so all folders in the workspace
    // follow a single naming scheme.
    let use_legacy = markers::workspace_uses_legacy_naming(&workspace_marker.connections);
    let dir_name_for = |ca: &ConnectorAccount| -> String {
        if use_legacy {
            markers::connector_dir_name_legacy(&ca.service, &ca.display_name)
        } else {
            markers::connector_dir_name(&ca.display_name)
        }
    };

    // Set up new connections
    for ca in &added {
        let dir_name = dir_name_for(ca);
        if !json {
            println!("Setting up new connection: {}...", dir_name);
        }
        match super::workspaces::setup_connection(ca, &dir_name, &layout, token) {
            Ok(_) => result.connections_added.push(dir_name),
            Err(e) => eprintln!(
                "  Warning: failed to set up connection {}: {e}",
                ca.display_name
            ),
        }
    }

    // Handle removed connections
    for entry in &removed {
        let action = match on_delete {
            // In JSON mode, prompt isn't possible — default to keep
            OnDeleteAction::Prompt if json => OnDeleteAction::Keep,
            other => other,
        };

        match action {
            OnDeleteAction::Remove => {
                if !json {
                    println!("Removing connection: {}...", entry.dir_name);
                }
                super::workspaces::teardown_connection(entry, &layout)?;
                result.connections_removed.push(entry.dir_name.clone());
            }
            OnDeleteAction::Keep => {
                if !json {
                    println!(
                        "Connection \"{}\" detached — files preserved at {}/",
                        entry.display_name,
                        workspace_dir.join(&entry.dir_name).display()
                    );
                }
                super::workspaces::detach_connection(entry, workspace_marker, &layout)?;
                result.connections_detached.push(entry.dir_name.clone());
            }
            OnDeleteAction::Prompt => {
                println!(
                    "Connection \"{}\" was removed from the server.",
                    entry.display_name
                );
                println!("  [d] Delete local files");
                println!("  [k] Keep as detached (files remain, no longer synced)");
                print!("  > ");
                io::stdout().flush()?;
                let mut line = String::new();
                io::stdin().lock().read_line(&mut line)?;
                let response = line.trim().to_lowercase();
                if response == "d" || response == "delete" {
                    super::workspaces::teardown_connection(entry, &layout)?;
                    result.connections_removed.push(entry.dir_name.clone());
                } else {
                    super::workspaces::detach_connection(entry, workspace_marker, &layout)?;
                    result.connections_detached.push(entry.dir_name.clone());
                    println!(
                        "Connection \"{}\" detached — files preserved at {}/",
                        entry.display_name,
                        workspace_dir.join(&entry.dir_name).display()
                    );
                }
            }
        }
    }

    // Update the marker with the new connection list
    let mut updated_connections: Vec<markers::ConnectionEntry> = workspace_marker
        .connections
        .iter()
        .filter(|c| server_ids.contains(c.id.as_str()))
        .cloned()
        .collect();

    // Add newly set up connections
    for ca in &added {
        let dir_name = dir_name_for(ca);
        if result.connections_added.contains(&dir_name) {
            updated_connections.push(markers::ConnectionEntry {
                id: ca.id.clone(),
                display_name: ca.display_name.clone(),
                service: ca.service.clone(),
                repo_path: ca.repo_path.clone(),
                dir_name,
                // A freshly added connection records the server's current
                // structure version, same as a fresh `init` (DEV-9698).
                structure_version: ca.version,
            });
        }
    }

    markers::rewrite_connections(workspace_dir, &updated_connections)?;

    Ok(result)
}

async fn run_upload(
    cwd: &Path,
    server_url: &str,
    json: bool,
    skip_folder_index: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (workspace_marker, workspace_dir, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url, json)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    // Workspace-wide advisory lock: every mutating CLI op holds it for the
    // duration of its work. Released when `_lock` drops at end of scope. The
    // single-worktree design (Phase 5) loses the implicit serialization the
    // three-worktree model had; this restores it ahead of that work.
    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let client = crate::api::ApiClient::new(&workspace_server_url, token.clone());
    let workbook_id = workspace_marker.workbook.id.as_str();

    let verbose = !json;

    // DEV-10316 two-pass upload. Pass 1 probes the dirty gate for EVERY
    // connection that has something to publish (checkOnly + refuseIfDirty),
    // applying nothing. Only if every connection's staging area is clean does
    // pass 2 apply. A single dirty connection blocks the whole publish with
    // nothing uploaded — this matches the existing "you're behind" gate and
    // avoids the half-applied state where one connection's patches land and a
    // later one is refused, leaving the user blocked on their own just-uploaded
    // patches. The server is the source of truth (closing the race where a sync
    // stages a change between probe and apply); there is no other client-side
    // pre-flight.
    let mut dirty_blocked: Vec<BlockedDirtyConnection> = Vec::new();
    let mut check_failed: Vec<CheckFailedConnection> = Vec::new();
    for ctx in &contexts {
        match probe_connection_dirty_gate(ctx, &client, workbook_id).await? {
            DirtyGateProbe::Clean => {}
            DirtyGateProbe::Dirty(dirty) => dirty_blocked.push(BlockedDirtyConnection {
                connection_name: ctx.conn_dir_name.clone(),
                dirty,
            }),
            DirtyGateProbe::CheckFailed(failed) => check_failed.push(CheckFailedConnection {
                connection_name: ctx.conn_dir_name.clone(),
                failed,
            }),
        }
    }
    if !dirty_blocked.is_empty() || !check_failed.is_empty() {
        print_blocked_dirty_result(
            &dirty_blocked,
            &check_failed,
            started.elapsed().as_millis(),
            json,
        )?;
        anyhow::bail!(
            "{} connection(s) refused — resolve unpublished changes on the web, then retry.",
            dirty_blocked.len() + check_failed.len()
        );
    }

    // Pass 2: real apply. The dirty gate is retained here (refuse_if_dirty) so
    // the rare sub-second residual — a sync writing to a connection's dirty
    // branch between its probe and its apply — is still refused rather than
    // applied onto.
    let mut results = Vec::new();
    let mut all_changed_workspace_paths: Vec<String> = Vec::new();
    let mut blocked_stale: Vec<BlockedStaleConnection> = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && verbose {
            println!("Uploading {}...", ctx.conn_dir_name);
        }
        let upload_result =
            upload_single_repo_via_patches(ctx, &client, workbook_id, verbose).await?;
        if let Some(ref dirty) = upload_result.blocked_dirty {
            dirty_blocked.push(BlockedDirtyConnection {
                connection_name: ctx.conn_dir_name.clone(),
                dirty: dirty.clone(),
            });
            break;
        }
        if let Some(ref failed) = upload_result.check_failed {
            check_failed.push(CheckFailedConnection {
                connection_name: ctx.conn_dir_name.clone(),
                failed: failed.clone(),
            });
            break;
        }
        if let Some(ref stale) = upload_result.blocked_stale {
            // D8: fail-fast on first stale connection. Earlier connections
            // in the same upload loop may have already applied their patches
            // server-side, but that's safe — re-running `files upload` after
            // a `files download` is idempotent (the prior connection's patch
            // file still matches what's on dirty, so the re-apply is a no-op
            // git commit). Capture for the structured payload + bail.
            blocked_stale.push(BlockedStaleConnection {
                connection_name: ctx.conn_dir_name.clone(),
                stale: stale.clone(),
            });
            break;
        }
        for path in &upload_result.changed_paths {
            all_changed_workspace_paths.push(format!("{}/{}", ctx.conn_dir_name, path));
        }
        results.push(upload_result);
    }

    // Per-path folder_index reindex. Same shape as download: the local
    // refs that moved during this upload drive a targeted reindex, replacing
    // the workspace-wide sweep the desktop used to do after every push.
    if !skip_folder_index {
        reindex_folder_index_for_changes(&workspace_dir, &all_changed_workspace_paths)?;
    }

    if !dirty_blocked.is_empty() || !check_failed.is_empty() {
        print_blocked_dirty_result(
            &dirty_blocked,
            &check_failed,
            started.elapsed().as_millis(),
            json,
        )?;
        anyhow::bail!(
            "{} connection(s) refused — resolve unpublished changes on the web, then retry.",
            dirty_blocked.len() + check_failed.len()
        );
    }
    if !blocked_stale.is_empty() {
        print_blocked_stale_result(&blocked_stale, started.elapsed().as_millis(), json)?;
        anyhow::bail!(
            "{} connection(s) refused — run `scratchmd files download`, then retry.",
            blocked_stale.len()
        );
    }

    let aggregate = aggregate_upload(&results);
    print_upload_result(&aggregate, &results, started.elapsed().as_millis(), json)
}

/// One entry in the structured `blocked_stale` workspace-level payload.
struct BlockedStaleConnection {
    connection_name: String,
    stale: crate::api::BlockedStaleResponse,
}

/// One entry in the structured `blocked_dirty` workspace-level payload
/// (DEV-10316). Count-only — carries the connection name and the server's
/// pending-change count, nothing per-record.
struct BlockedDirtyConnection {
    connection_name: String,
    dirty: crate::api::BlockedDirtyResponse,
}

/// One entry in the structured `check_failed` workspace-level payload
/// (DEV-10316). The dirty-gate check itself could not run for this connection;
/// retryable.
struct CheckFailedConnection {
    connection_name: String,
    failed: crate::api::CheckFailedResponse,
}

/// Outcome of the pass-1 dirty-gate probe for a single connection.
enum DirtyGateProbe {
    /// Nothing to publish for this connection, or its staging area is clean.
    Clean,
    /// The connection's `dirty` branch holds unpublished changes vs live `main`.
    Dirty(crate::api::BlockedDirtyResponse),
    /// The gate check itself failed (fail-closed; retryable).
    CheckFailed(crate::api::CheckFailedResponse),
}

/// DEV-10316 pass-1 probe: ask the server to run the dirty gate for this
/// connection WITHOUT applying. Skips connections with nothing to publish (an
/// empty `accepted-patches.json`) — a connection the user isn't publishing to
/// must not be gated on its staging-area state. Otherwise it issues an
/// `uploadId` and POSTs `/upload-patch/commit` with `checkOnly + refuseIfDirty`
/// (no payload PUT — the server's checkOnly path never reads it). Staleness is
/// deliberately NOT checked here (decision #5: pending changes are surfaced
/// before staleness); the apply pass enforces it.
async fn probe_connection_dirty_gate(
    ctx: &ConnectionContext,
    client: &crate::api::ApiClient,
    workbook_id: &str,
) -> anyhow::Result<DirtyGateProbe> {
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    if accepted_file.patches.is_empty() {
        return Ok(DirtyGateProbe::Clean);
    }

    let init = client
        .upload_patch_init(workbook_id, &ctx.connection_id)
        .await
        .map_err(|e| anyhow::anyhow!("upload-patch init (check) failed: {e}"))?;
    let commit = client
        .upload_patch_commit(
            workbook_id,
            &ctx.connection_id,
            &init.upload_id,
            None,  // baseHead irrelevant — checkOnly skips the staleness gate
            false, // refuse_if_stale: handled on the apply pass
            true,  // refuse_if_dirty
            true,  // check_only
        )
        .await
        .map_err(|e| anyhow::anyhow!("upload-patch check failed: {e}"))?;

    Ok(match commit {
        crate::api::UploadPatchCommitResult::Applied(_) => DirtyGateProbe::Clean,
        crate::api::UploadPatchCommitResult::BlockedDirty(dirty) => DirtyGateProbe::Dirty(dirty),
        crate::api::UploadPatchCommitResult::CheckFailed(failed) => {
            DirtyGateProbe::CheckFailed(failed)
        }
        // checkOnly returns before the staleness gate, so a stale result can't
        // occur on the probe; treat defensively as clean (the apply pass
        // re-checks staleness).
        crate::api::UploadPatchCommitResult::BlockedStale(_) => DirtyGateProbe::Clean,
    })
}

/// Publish accepted edits to external connectors. Two explicit server calls
/// per connection: `/publish-v2/plan-job` builds the plan (server-side diff
/// of dirty vs main) and `/publish-v2/run-job` dispatches the plan through the
/// connector. The CLI polls each job to completion before moving to the next
/// connection or the next phase. Decoupled from `files upload` so the two
/// concerns — "stage my changes server-side" and "actually publish them" —
/// can be driven independently (scripting, CI, deferred publishing).
/// Per-connection outcome of a publish attempt. The publish loop continues
/// past failures (F8) and post-publish reconcile is non-fatal (F9), so a
/// multi-connection publish can land any combination of these.
#[derive(Debug, Clone)]
enum PublishConnectionOutcome {
    /// Plan + run succeeded and the post-publish reconcile applied cleanly.
    Published { name: String },
    /// Plan + run succeeded server-side, but the post-publish `fetch_origin`
    /// + local-main advance failed (F9). The publish itself landed; the local
    /// `refs/heads/main` simply lags until the next pull or publish. We
    /// surface this as a warning, not a failure — the user's edits made it to
    /// the server, and `scratchmd files download` recovers the local state.
    PublishedWithReconcileWarning { name: String, warning: String },
    /// Plan + run completed server-side, but the destination connector rejected
    /// one or more rows during the run-job (DEV-10243). A VARCHAR overflow /
    /// type mismatch / FK violation is caught by the server's `processBatch`,
    /// recorded as `failed-batch`, and surfaced as `failedCount` on the run-job's
    /// terminal `publicProgress` — but the BullMQ job still reports `completed`,
    /// so `poll_job` returns Ok. We treat this as a non-fatal warning (exit 0,
    /// status stays `published`): the rejected rows did not land, but the
    /// accepted edit survives in `accepted-patches.json` and is listed by
    /// `scratchmd files unpublished`, so the user can recover.
    PublishedWithRowFailures {
        name: String,
        failed_count: u64,
        warning: String,
        /// The per-record rejections the server returned on the run-job
        /// progress (bounded sample), each carrying the connector's own
        /// message. Drives the `failedOperations` detail in `--json` output;
        /// the first one with a message is folded into `warning` for humans.
        failed_operations: Vec<crate::api::JobFailedOperation>,
    },
    /// Plan-job returned no work (server-side diff was empty).
    NoDiff { name: String },
    /// Plan-job / run-job / poll failed before the publish landed. `phase`
    /// identifies which step so callers can show actionable detail.
    Failed {
        name: String,
        phase: &'static str,
        message: String,
    },
}

async fn run_publish(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (workspace_marker, workspace_dir, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url, json)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    // Pre-flight: refuse the publish if any connection has unreviewed
    // working-tree edits. The user must explicitly accept or discard them
    // first — same model as pull's `blocked_unreviewed`, and the same
    // structured payload shape so the desktop modal can pattern-match. Uses
    // the gix::status-backed fast path (~210ms warm per connection).
    let mut blocked: Vec<RecordChangeEntry> = Vec::new();
    for ctx in &contexts {
        blocked.extend(
            list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(ctx, false)?,
        );
    }
    if !blocked.is_empty() {
        print_blocked_unreviewed_result(&blocked, started.elapsed().as_millis(), json)?;
        anyhow::bail!(
            "{} unreviewed record(s) — run `scratchmd files accept-all` or `discard-all`, then retry.",
            blocked.len()
        );
    }

    let client = crate::api::ApiClient::new(&workspace_server_url, token.clone());
    let workbook_id = workspace_marker.workbook.id.as_str();

    let verbose = !json;
    let mut outcomes: Vec<PublishConnectionOutcome> = Vec::with_capacity(contexts.len());

    for ctx in &contexts {
        if contexts.len() > 1 && verbose {
            println!("Publishing {}...", ctx.conn_dir_name);
        }
        outcomes.push(
            publish_single_connection(ctx, &client, workbook_id, &workspace_dir, &token, verbose)
                .await,
        );
    }

    let elapsed_ms = started.elapsed().as_millis();
    print_publish_results(&outcomes, elapsed_ms, json)?;

    let failed_count = outcomes
        .iter()
        .filter(|o| matches!(o, PublishConnectionOutcome::Failed { .. }))
        .count();
    if failed_count > 0 {
        anyhow::bail!(
            "{} of {} connection(s) failed to publish.",
            failed_count,
            outcomes.len()
        );
    }
    Ok(())
}

/// Run the plan + run + reconcile sequence for one connection. Translates each
/// failure into a [`PublishConnectionOutcome`] variant so the caller can
/// continue with the remaining connections (F8) — never returns an error.
/// Post-publish reconcile failure becomes a non-fatal warning (F9), since the
/// publish itself has already landed server-side at that point.
async fn publish_single_connection(
    ctx: &ConnectionContext,
    client: &crate::api::ApiClient,
    workbook_id: &str,
    workspace_dir: &Path,
    token: &str,
    verbose: bool,
) -> PublishConnectionOutcome {
    let name = ctx.conn_dir_name.clone();

    if verbose {
        eprint!("  Planning...");
    }
    let plan = match client
        .publish_plan_build(workbook_id, &ctx.connection_id)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            if verbose {
                eprintln!(" failed");
            }
            return PublishConnectionOutcome::Failed {
                name,
                phase: "plan-job",
                message: e.to_string(),
            };
        }
    };

    let (plan_job_id, pipeline_id) = match (plan.job_id, plan.pipeline_id) {
        (Some(job), Some(pipe)) => (job, pipe),
        _ => {
            if verbose {
                eprintln!(" no changes");
            }
            return PublishConnectionOutcome::NoDiff { name };
        }
    };

    if let Err(e) = crate::api::poll_job(client, &plan_job_id).await {
        if verbose {
            eprintln!(" failed");
        }
        return PublishConnectionOutcome::Failed {
            name,
            phase: "plan-job",
            message: e.to_string(),
        };
    }
    if verbose {
        eprintln!(" done");
        eprint!("  Running...");
    }

    let run = match client.publish_plan_run(workbook_id, &pipeline_id).await {
        Ok(r) => r,
        Err(e) => {
            if verbose {
                eprintln!(" failed");
            }
            return PublishConnectionOutcome::Failed {
                name,
                phase: "run-job",
                message: e.to_string(),
            };
        }
    };
    // Number of rows the destination connector rejected during the run-job
    // (DEV-10243). The run-job still ends `completed` even when every row was
    // rejected, so the only signal is `failedCount` (the count) plus
    // `failedOperations` (the per-record connector messages) on its terminal
    // progress.
    let (run_job_failed_count, run_job_failed_operations) =
        if let Some(run_job_id) = run.job_id.as_deref() {
            match crate::api::poll_job(client, run_job_id).await {
                Ok(progress) => progress
                    .public_progress
                    .map_or((0, Vec::new()), |p| (p.failed_count, p.failed_operations)),
                Err(e) => {
                    if verbose {
                        eprintln!(" failed");
                    }
                    return PublishConnectionOutcome::Failed {
                        name,
                        phase: "run-job",
                        message: e.to_string(),
                    };
                }
            }
        } else {
            (0, Vec::new())
        };
    if verbose {
        eprintln!(" done");
    }

    // After a successful run-job, fetch origin and reconcile the local patch
    // file against the server's view of `main`. Patches whose outcome
    // actually landed in `main` get dropped by re-anchor's no-op detection;
    // patches whose connector batch failed silently (DEV-10175) survive.
    //
    // Reconcile failure here does NOT fail the publish (F9): the user's
    // edits already landed server-side, and the next `scratchmd files
    // download` (or the next publish, which re-attempts the fetch) recovers
    // the local state. Surfacing this as a per-connection warning matches
    // the desktop's fire-and-forget `refreshLocal` policy documented in
    // `scratch-git-2/docs/PULL_AFTER_PUBLISH.md`.
    if let Err(e) = reconcile_accepted_after_publish(ctx, workspace_dir, token) {
        return PublishConnectionOutcome::PublishedWithReconcileWarning {
            name,
            warning: format!("post-publish refresh failed: {e}. Run `scratchmd files download` to sync local state."),
        };
    }

    // DEV-10243: the run-job "completed" but the connector rejected some rows.
    // Surface a non-fatal warning so the publish never reports a clean success
    // when nothing (or only part) of the batch actually landed. Checked AFTER
    // reconcile so the patch-preserving re-anchor still runs (the rejected rows'
    // accepted patches must survive in `accepted-patches.json` — see DEV-10175).
    // On the rare double-fault (reconcile also failed) the reconcile warning
    // above wins; the row-failure state is still recoverable via `files unpublished`.
    if run_job_failed_count > 0 {
        return PublishConnectionOutcome::PublishedWithRowFailures {
            name,
            failed_count: run_job_failed_count,
            warning: format_row_failure_warning(run_job_failed_count, &run_job_failed_operations),
            failed_operations: run_job_failed_operations,
        };
    }

    PublishConnectionOutcome::Published { name }
}

/// `public/Activities/call-nishant.json` → `call-nishant` — a readable record
/// label for the row-failure warning.
fn record_name_from_path(file_path: &str) -> String {
    let base = file_path.rsplit('/').next().unwrap_or(file_path);
    base.strip_suffix(".json").unwrap_or(base).to_string()
}

/// Build the user-facing row-failure warning. Prefers the connector's own
/// per-record message from the run-job's `failedOperations` (e.g. Pipedrive's
/// "'person_id' is a read-only field…") over a bare count, mirroring the
/// desktop modal. `failed_count` is the authoritative total — the operations
/// list is a bounded sample, so "others" is derived from the count.
fn format_row_failure_warning(
    failed_count: u64,
    failed_operations: &[crate::api::JobFailedOperation],
) -> String {
    const RECOVERY: &str =
        "Run `scratchmd files unpublished` to see which records still need publishing.";

    let first_with_error = failed_operations
        .iter()
        .find(|op| op.error.as_deref().is_some_and(|e| !e.is_empty()));

    match first_with_error {
        Some(op) => {
            let record = record_name_from_path(&op.file_path);
            let message = op.error.as_deref().unwrap_or_default();
            let others = failed_count.saturating_sub(1);
            let suffix = if others > 0 {
                format!(
                    " (and {others} other record{} failed)",
                    if others == 1 { "" } else { "s" }
                )
            } else {
                String::new()
            };
            format!("{record}: {message}{suffix} {RECOVERY}")
        }
        None => format!(
            "{failed_count} record(s) were rejected by the destination connector and were not published. {RECOVERY}"
        ),
    }
}

/// Roll records from a publish plan back to their pre-publish blob.
///
/// Reads `preMainCommitSha` (and the affected file list) from the server,
/// then loads the pre-publish tree from the **local bare repo** at that
/// commit — no per-record network call. `preMainCommitSha` is an ancestor
/// of current `main`, so it's reachable locally as long as the workspace
/// has been pulled since the publish landed.
///
/// `single_file_path` skips the records-list fetch entirely — used by the
/// per-record desktop path so the same code drives both flows.
///
/// For each affected record: write the pre-publish blob to the working
/// tree, or delete the working file when there was no blob (record didn't
/// exist pre-publish = Create → reverted by deletion). Then re-snapshot
/// via `re_anchor::compute_entry`. Single atomic write of the patch file
/// at the end + folder-index refresh.
async fn run_revert_plan(
    cwd: &Path,
    server_url: &str,
    plan_id: &str,
    single_file_path: Option<&str>,
    data_folder_id: Option<&str>,
    phase: Option<&str>,
    filename: Option<&str>,
    json: bool,
) -> anyhow::Result<()> {
    use std::collections::HashSet;
    let started = std::time::Instant::now();
    let (workspace_marker, workspace_dir, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url, json)?;
    let token = get_token(&workspace_server_url)?;
    let workbook_id = workspace_marker.workbook.id.clone();
    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    #[derive(serde::Deserialize)]
    struct PlanMeta {
        #[serde(rename = "connectorAccountId")]
        connector_account_id: Option<String>,
        #[serde(rename = "preMainCommitSha")]
        pre_main_commit_sha: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct RecordsPage {
        data: Vec<RecordRow>,
        total: usize,
    }
    #[derive(serde::Deserialize)]
    struct RecordRow {
        #[serde(rename = "filePath")]
        file_path: String,
    }

    let client = crate::api::ApiClient::new(&workspace_server_url, token);

    // 1. Plan metadata (one round trip): connector + the SHA we'll read
    //    blobs at locally. Uses the CLI shim under `/cli/v1/workbooks/...`
    //    (the API client prepends `/cli/v1`).
    let plan_endpoint = format!("workbooks/{workbook_id}/publish-v2/{plan_id}");
    let plan: PlanMeta = client.get(&plan_endpoint).await?;
    let connector_account_id = plan.connector_account_id.ok_or_else(|| {
        anyhow::anyhow!(
            "Plan {plan_id} has no connectorAccountId — cross-connection rollback is not supported. Use --file-path to roll back one record at a time."
        )
    })?;
    let pre_main_sha = plan.pre_main_commit_sha.ok_or_else(|| {
        anyhow::anyhow!(
            "Plan {plan_id} has no preMainCommitSha — it pre-dates the publish-history feature."
        )
    })?;

    let ctx = contexts
        .iter()
        .find(|c| c.connection_id == connector_account_id)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Plan's connector account ({connector_account_id}) is not configured locally"
            )
        })?;

    // 2. Affected paths. Single-file mode skips the records-list call.
    let mut affected: Vec<String> = Vec::new();
    if let Some(p) = single_file_path {
        affected.push(p.to_string());
    } else {
        let records_endpoint = format!("workbooks/{workbook_id}/publish-v2/{plan_id}/records");
        let page_size: usize = 200;
        let mut page: usize = 1;
        loop {
            let mut q_parts: Vec<String> =
                vec![format!("page={page}"), format!("pageSize={page_size}")];
            if let Some(d) = data_folder_id {
                q_parts.push(format!("dataFolderId={}", urlencoding::encode(d)));
            }
            if let Some(ph) = phase {
                q_parts.push(format!("phase={}", urlencoding::encode(ph)));
            }
            if let Some(fname) = filename {
                q_parts.push(format!("filename={}", urlencoding::encode(fname)));
            }
            let page_data: RecordsPage = client
                .get_query(&records_endpoint, &q_parts.join("&"))
                .await?;
            let fetched = page_data.data.len();
            for r in page_data.data {
                affected.push(r.file_path);
            }
            if affected.len() >= page_data.total || fetched < page_size {
                break;
            }
            page += 1;
        }
    }

    // 3. Local read of the pre-publish tree at the recorded SHA.
    let pre_main_map = read_git_tree(&ctx.bare_repo, &pre_main_sha).with_context(|| {
        format!(
            "reading pre-publish tree {pre_main_sha} from local bare repo — run `scratchmd files pull` if the workspace is stale"
        )
    })?;
    let main_map = read_main_branch_contents(&ctx.bare_repo)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;

    let mut written_count = 0usize;
    let mut deleted_count = 0usize;
    let mut reverted_paths: Vec<String> = Vec::new();
    let mut affected_folders: HashSet<String> = HashSet::new();

    for file_path in &affected {
        let rel_path = file_path.trim_start_matches('/').to_string();
        let abs_path = ctx.worktree_dir.join(&rel_path);

        // Decide whether this iteration is a revert-delete (revive). True when
        // the path existed in pre-publish main but no longer exists in current
        // main — i.e., the plan being reverted included a delete for this
        // path. The PK carried by the pre-publish blob is stale (the row is
        // gone; the connector will assign a fresh id on the re-create) and
        // must be stripped from BOTH the worktree file and the resulting
        // Create patch. Two reasons:
        //   1. Patch side — without the strip, post-publish re-anchor would
        //      convert the Create → Update with the old id baked in, and the
        //      no-op check (`apply(new_main, patch) == new_main`) would fail
        //      because `id: 9` clobbers `id: 11`. The patch then lingers
        //      forever and the worktree replay perpetually rewrites the file
        //      with the stale id.
        //   2. Worktree side — if the worktree carries the stale id but the
        //      patch doesn't, the desktop UI's "unreviewed" diff
        //      (working tree vs main+accepted-patch) surfaces a phantom
        //      "needs review" change for the id field, even though there's
        //      nothing the user should review. Stripping the id from the
        //      worktree too aligns the two sides so the UI just shows the
        //      Create patch with the correct field set.
        let pre_blob_raw = pre_main_map.get(rel_path.as_str()).cloned();
        let main_snapshot = parse_json_value_at(&main_map, &rel_path, "refs/heads/main")?;
        let is_revert_delete = pre_blob_raw.is_some() && main_snapshot.is_none();

        // For revert-delete, parse + rewrite the PK to a
        // `scratch_pending_recreate_<old_id>` sentinel + re-serialize via the
        // canonical formatter. Both the worktree file and the eventual Create
        // patch carry the same sentinel, so the desktop UI's
        // worktree-vs-patch diff stays clean. Server parses the sentinel at
        // publish time to (a) strip from connector payload, (b) write the
        // (priorRemoteId → newRemoteId) row to RecreatedIdMap after the
        // connector assigns a new id.
        let pre_blob_for_worktree: Option<Vec<u8>> = if is_revert_delete {
            if let Some(raw) = &pre_blob_raw {
                let parsed = serde_json::from_slice::<JsonValue>(raw).with_context(|| {
                    format!("parsing pre-publish blob at {rel_path} for revert-delete recreate sentinel")
                })?;
                let id_path = load_id_column_remote_id_for_folder(&main_map, &rel_path);
                let with_sentinel = replace_pk_with_recreate_sentinel(&parsed, &id_path);
                let object = with_sentinel.as_object().cloned().ok_or_else(|| {
                    anyhow::anyhow!(
                        "pre-publish blob at {rel_path} is not a JSON object — cannot apply recreate sentinel"
                    )
                })?;
                Some(crate::shared::review_ops::json_object_to_bytes(&object)?)
            } else {
                None
            }
        } else {
            pre_blob_raw.clone()
        };

        // 4a) Bring the working file to the pre-publish state.
        match &pre_blob_for_worktree {
            Some(content) => {
                if let Some(parent) = abs_path.parent() {
                    std::fs::create_dir_all(parent).with_context(|| {
                        format!("creating parent dir for {}", abs_path.display())
                    })?;
                }
                std::fs::write(&abs_path, content)
                    .with_context(|| format!("writing {}", abs_path.display()))?;
                written_count += 1;
            }
            None => {
                if abs_path.exists() {
                    std::fs::remove_file(&abs_path)
                        .with_context(|| format!("deleting {}", abs_path.display()))?;
                }
                deleted_count += 1;
            }
        }

        // 4b) Re-anchor: working vs current main → right approved entry. Since
        // the worktree was written with the PK already stripped (when
        // applicable), parsing it back here gives us the same field set the
        // patch will hold — the desktop UI's working-tree-vs-patch diff is
        // clean.
        let working = if abs_path.exists() {
            let bytes = std::fs::read(&abs_path)
                .with_context(|| format!("reading {}", abs_path.display()))?;
            Some(
                serde_json::from_slice::<JsonValue>(&bytes)
                    .with_context(|| format!("parsing working tree blob at {rel_path}"))?,
            )
        } else {
            None
        };

        match crate::shared::re_anchor::compute_entry(
            &rel_path,
            main_snapshot.as_ref(),
            working.as_ref(),
        ) {
            Some(mut entry) => {
                // Mark revert-delete entries so the publish-time recreate
                // sentinel handling + RecreatedIdMap write fires server-side,
                // and so re-anchor (post-publish) drops the patch
                // unconditionally once the path lands on new main.
                if is_revert_delete {
                    entry.revert = true;
                }
                crate::shared::accepted_patches::upsert_entry(&mut accepted_file, entry);
            }
            None => crate::shared::accepted_patches::remove_entry(&mut accepted_file, &rel_path),
        }

        reverted_paths.push(format!("{}/{}", ctx.conn_dir_name, rel_path));
        if let Some(folder) = std::path::Path::new(&rel_path)
            .parent()
            .and_then(|p| p.to_str())
        {
            if !folder.is_empty() {
                affected_folders.insert(format!("{}/{}", ctx.conn_dir_name, folder));
            }
        }
    }

    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    reindex_folder_index_for_changes(&workspace_dir, &reverted_paths)?;

    let elapsed_ms = started.elapsed().as_millis();
    let total = affected.len();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "reverted",
                "total": total,
                "filesWritten": written_count,
                "filesDeleted": deleted_count,
                "affectedFolders": affected_folders.into_iter().collect::<Vec<_>>(),
                "elapsedMs": elapsed_ms,
            }))?
        );
    } else {
        println!(
            "Reverted {total} record(s) — {written_count} written, {deleted_count} deleted ({elapsed_ms}ms)"
        );
    }
    Ok(())
}

/// Render the per-connection publish outcomes to stdout. JSON mode emits the
/// new structured shape (with `connections`, `failedConnections`, `warnings`)
/// plus the legacy `publishedConnections` + `skippedNoDiff` keys for
/// back-compat with `scratch-cli-tests/tests/publish.spec.ts`.
fn print_publish_results(
    outcomes: &[PublishConnectionOutcome],
    elapsed_ms: u128,
    json: bool,
) -> anyhow::Result<()> {
    let mut published: Vec<&str> = Vec::new();
    let mut skipped_no_diff: Vec<&str> = Vec::new();
    let mut failed: Vec<&PublishConnectionOutcome> = Vec::new();
    let mut warnings: Vec<&PublishConnectionOutcome> = Vec::new();

    for outcome in outcomes {
        match outcome {
            PublishConnectionOutcome::Published { name } => published.push(name.as_str()),
            PublishConnectionOutcome::PublishedWithReconcileWarning { name, .. } => {
                published.push(name.as_str());
                warnings.push(outcome);
            }
            PublishConnectionOutcome::PublishedWithRowFailures { name, .. } => {
                published.push(name.as_str());
                warnings.push(outcome);
            }
            PublishConnectionOutcome::NoDiff { name } => skipped_no_diff.push(name.as_str()),
            PublishConnectionOutcome::Failed { .. } => failed.push(outcome),
        }
    }

    let status = if !failed.is_empty() && published.is_empty() {
        "failed"
    } else if !failed.is_empty() {
        "partial"
    } else if !published.is_empty() {
        "published"
    } else if !skipped_no_diff.is_empty() {
        "no_diff"
    } else {
        "no_changes"
    };

    if json {
        let connections: Vec<serde_json::Value> =
            outcomes.iter().map(publish_outcome_to_json).collect();
        let failed_payload: Vec<serde_json::Value> =
            failed.iter().map(|o| publish_outcome_to_json(o)).collect();
        let warning_payload: Vec<serde_json::Value> = warnings
            .iter()
            .map(|o| publish_outcome_to_json(o))
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": status,
                "connections": connections,
                "publishedConnections": published,
                "skippedNoDiff": skipped_no_diff,
                "failedConnections": failed_payload,
                "warnings": warning_payload,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    let elapsed = format_elapsed(elapsed_ms);
    if outcomes.is_empty() {
        println!("No connections to publish. ({})", elapsed);
        return Ok(());
    }

    if published.is_empty() && failed.is_empty() {
        println!(
            "No changes to publish across {} connection(s). ({})",
            skipped_no_diff.len(),
            elapsed
        );
    } else if failed.is_empty() {
        println!("Published {} connection(s). ({})", published.len(), elapsed);
        for name in &published {
            println!("  {}", name);
        }
        if !skipped_no_diff.is_empty() {
            println!(
                "Skipped {} connection(s) with no changes.",
                skipped_no_diff.len()
            );
        }
    } else {
        println!(
            "Published {} of {} connection(s) with {} failure(s). ({})",
            published.len(),
            outcomes.len(),
            failed.len(),
            elapsed
        );
        if !published.is_empty() {
            println!("Succeeded:");
            for name in &published {
                println!("  {}", name);
            }
        }
        if !skipped_no_diff.is_empty() {
            println!("No changes:");
            for name in &skipped_no_diff {
                println!("  {}", name);
            }
        }
        println!("Failed:");
        for outcome in &failed {
            if let PublishConnectionOutcome::Failed {
                name,
                phase,
                message,
            } = outcome
            {
                println!("  {} ({}): {}", name, phase, message);
            }
        }
    }

    for outcome in &warnings {
        if let PublishConnectionOutcome::PublishedWithReconcileWarning { name, warning } = outcome {
            eprintln!("Warning ({}): {}", name, warning);
        }
        if let PublishConnectionOutcome::PublishedWithRowFailures { name, warning, .. } = outcome {
            eprintln!("Warning ({}): {}", name, warning);
        }
    }

    Ok(())
}

fn publish_outcome_to_json(outcome: &PublishConnectionOutcome) -> serde_json::Value {
    match outcome {
        PublishConnectionOutcome::Published { name } => serde_json::json!({
            "name": name,
            "status": "published",
        }),
        PublishConnectionOutcome::PublishedWithReconcileWarning { name, warning } => {
            serde_json::json!({
                "name": name,
                "status": "published",
                "warning": { "phase": "reconcile", "message": warning },
            })
        }
        PublishConnectionOutcome::PublishedWithRowFailures {
            name,
            failed_count,
            warning,
            failed_operations,
        } => {
            let operations: Vec<serde_json::Value> = failed_operations
                .iter()
                .map(|op| {
                    serde_json::json!({
                        "filePath": op.file_path,
                        "phase": op.phase,
                        "error": op.error,
                    })
                })
                .collect();
            serde_json::json!({
                "name": name,
                "status": "published",
                "warning": {
                    "phase": "run-job",
                    "message": warning,
                    "failedCount": failed_count,
                    "failedOperations": operations,
                },
            })
        }
        PublishConnectionOutcome::NoDiff { name } => serde_json::json!({
            "name": name,
            "status": "no_diff",
        }),
        PublishConnectionOutcome::Failed {
            name,
            phase,
            message,
        } => serde_json::json!({
            "name": name,
            "status": "failed",
            "phase": phase,
            "message": message,
        }),
    }
}

/// Group workspace-relative paths by their parent folder and run
/// `folder_index::reindex_files` for each, so the SQLite folder index stays
/// current after a multi-file mutation without an extra CLI round trip.
fn reindex_folder_index_for_changes(
    workspace_dir: &Path,
    workspace_relative_paths: &[String],
) -> anyhow::Result<()> {
    if workspace_relative_paths.is_empty() {
        return Ok(());
    }
    let mut by_folder: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for path in workspace_relative_paths {
        let Some(last_slash) = path.rfind('/') else {
            continue;
        };
        let folder = &path[..last_slash];
        let filename = path[last_slash + 1..].to_string();
        by_folder.entry(folder).or_default().push(filename);
    }
    for (folder, filenames) in by_folder {
        folder_index::reindex_files(workspace_dir, folder, &filenames, None, false)?;
    }
    Ok(())
}

fn run_discard_all(
    cwd: &Path,
    server_url: &str,
    folder: Option<&Path>,
    json: bool,
    skip_folder_index: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url, json)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let mut discarded_files: Vec<String> = Vec::new();
    let mut total_discarded: i32 = 0;
    let mut skipped_any = false;
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            let result = discard_all_unreviewed_changes_in_connection_repo(
                &ctx,
                &workspace_dir,
                Some(repo_folder.as_str()),
            )?;
            revalidate_paths_for_connection_context(&ctx, &result.discarded_paths, false)?;
            total_discarded += result.files_discarded;
            skipped_any |= result.skipped_missing_main;
            for p in &result.discarded_paths {
                discarded_files.push(format!("{}/{}", ctx.conn_dir_name, p));
            }
        }
        None => {
            for ctx in &contexts {
                if contexts.len() > 1 && !json {
                    println!("Discarding changes in {}...", ctx.conn_dir_name);
                }
                let result =
                    discard_all_unreviewed_changes_in_connection_repo(ctx, &workspace_dir, None)?;
                revalidate_paths_for_connection_context(ctx, &result.discarded_paths, false)?;
                total_discarded += result.files_discarded;
                skipped_any |= result.skipped_missing_main;
                for p in &result.discarded_paths {
                    discarded_files.push(format!("{}/{}", ctx.conn_dir_name, p));
                }
            }
        }
    }
    if !skip_folder_index {
        reindex_folder_index_for_changes(&workspace_dir, &discarded_files)?;
    }
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": if total_discarded == 0 { "no_changes" } else { "discarded" },
                "filesDiscarded": total_discarded,
                "paths": discarded_files,
                "skippedMissingMain": skipped_any,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    if total_discarded == 0 {
        println!(
            "No local changes to discard. ({})",
            format_elapsed(elapsed_ms)
        );
        return Ok(());
    }

    println!(
        "Discarded {} local record change(s). ({})",
        total_discarded,
        format_elapsed(elapsed_ms)
    );
    print_file_list(&discarded_files);
    if skipped_any {
        println!("Note: one or more connections have no published state yet and were skipped.");
    }
    Ok(())
}

fn run_reject_all(
    cwd: &Path,
    server_url: &str,
    folder: Option<&Path>,
    json: bool,
    skip_folder_index: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url, json)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let mut rejected_files: Vec<String> = Vec::new();
    let mut total_rejected: i32 = 0;
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            let result = reject_all_unreviewed_changes_in_connection_repo(
                &ctx,
                &workspace_dir,
                Some(repo_folder.as_str()),
            )?;
            revalidate_paths_for_connection_context(&ctx, &result.rejected_paths, false)?;
            total_rejected += result.files_rejected;
            for p in &result.rejected_paths {
                rejected_files.push(format!("{}/{}", ctx.conn_dir_name, p));
            }
        }
        None => {
            for ctx in &contexts {
                if contexts.len() > 1 && !json {
                    println!("Rejecting changes in {}...", ctx.conn_dir_name);
                }
                let result =
                    reject_all_unreviewed_changes_in_connection_repo(ctx, &workspace_dir, None)?;
                revalidate_paths_for_connection_context(ctx, &result.rejected_paths, false)?;
                total_rejected += result.files_rejected;
                for p in &result.rejected_paths {
                    rejected_files.push(format!("{}/{}", ctx.conn_dir_name, p));
                }
            }
        }
    }
    if !skip_folder_index {
        reindex_folder_index_for_changes(&workspace_dir, &rejected_files)?;
    }
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": if total_rejected == 0 { "no_changes" } else { "rejected" },
                "filesRejected": total_rejected,
                "paths": rejected_files,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    if total_rejected == 0 {
        println!(
            "No unreviewed local changes to reject. ({})",
            format_elapsed(elapsed_ms)
        );
        return Ok(());
    }

    println!(
        "Rejected {} local record change(s). ({})",
        total_rejected,
        format_elapsed(elapsed_ms)
    );
    print_file_list(&rejected_files);
    Ok(())
}

fn run_accept_all(
    cwd: &Path,
    server_url: &str,
    folder: Option<&Path>,
    json: bool,
    skip_folder_index: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url, json)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let mut accepted_files: Vec<String> = Vec::new();
    let mut total_accepted: i32 = 0;
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            let result = accept_all_unreviewed_changes_in_connection_repo(
                &ctx,
                &workspace_dir,
                Some(repo_folder.as_str()),
            )?;
            revalidate_paths_for_connection_context(&ctx, &result.accepted_paths, false)?;
            total_accepted += result.files_accepted;
            for p in &result.accepted_paths {
                accepted_files.push(format!("{}/{}", ctx.conn_dir_name, p));
            }
        }
        None => {
            for ctx in &contexts {
                if contexts.len() > 1 && !json {
                    println!("Accepting changes in {}...", ctx.conn_dir_name);
                }
                let result =
                    accept_all_unreviewed_changes_in_connection_repo(ctx, &workspace_dir, None)?;
                revalidate_paths_for_connection_context(ctx, &result.accepted_paths, false)?;
                total_accepted += result.files_accepted;
                for p in &result.accepted_paths {
                    accepted_files.push(format!("{}/{}", ctx.conn_dir_name, p));
                }
            }
        }
    }
    if !skip_folder_index {
        reindex_folder_index_for_changes(&workspace_dir, &accepted_files)?;
    }
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": if total_accepted == 0 { "no_changes" } else { "accepted" },
                "filesAccepted": total_accepted,
                "paths": accepted_files,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    if total_accepted == 0 {
        println!(
            "No unreviewed local changes to accept. ({})",
            format_elapsed(elapsed_ms)
        );
        return Ok(());
    }

    println!(
        "Accepted {} local record change(s). ({})",
        total_accepted,
        format_elapsed(elapsed_ms)
    );
    print_file_list(&accepted_files);
    Ok(())
}

fn run_accept(
    cwd: &Path,
    _server_url: &str,
    input_paths: &[String],
    json: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);

    // Group input paths by connection. Path format:
    // "<conn-dir-name>/<repo-relative-path>".
    let mut by_conn: HashMap<usize, Vec<(String, String)>> = HashMap::new();
    for input_path in input_paths {
        let found = contexts.iter().enumerate().find_map(|(i, ctx)| {
            let prefix = format!("{}/", ctx.conn_dir_name);
            input_path
                .strip_prefix(&prefix)
                .map(|rest| (i, rest.to_string()))
        });
        match found {
            Some((i, rel_path)) => by_conn
                .entry(i)
                .or_default()
                .push((input_path.clone(), rel_path)),
            None => anyhow::bail!(
                "Path '{}' does not match any connection. Expected format: <connection-name>/<relative-path>",
                input_path
            ),
        }
    }

    let mut all_accepted: Vec<String> = Vec::new();

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];

        // Narrow both reads to just the paths the caller asked about. Without
        // this, `scratchmd files accept <one-path>` paid for a full main-tree
        // read plus a full worktree walk — order of seconds on workspaces with
        // tens of thousands of records.
        let requested_rel_paths: Vec<String> =
            path_pairs.iter().map(|(_, rel)| rel.clone()).collect();
        let requested_rel_paths_set: std::collections::HashSet<&str> =
            requested_rel_paths.iter().map(String::as_str).collect();
        let file_path_to_contents_map_in_main_branch =
            read_main_branch_contents_filtered_by_path(&ctx.bare_repo, |p| {
                requested_rel_paths_set.contains(p)
            })?;
        sync_schema_files_from_worktree(ctx)?;
        let file_path_to_contents_map_in_worktree =
            read_worktree_files_for_record_paths(&ctx.worktree_dir, &requested_rel_paths)?;

        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
        let file_path_to_contents_map_for_approved_state =
            compute_accepted_state(&file_path_to_contents_map_in_main_branch, &accepted_file)?;

        let changes = compute_unreviewed_entries(
            &ctx.conn_dir_name,
            &file_path_to_contents_map_for_approved_state,
            &file_path_to_contents_map_in_worktree,
        );
        let changed_paths: std::collections::HashSet<&str> =
            changes.iter().map(|e| e.path.as_str()).collect();

        // Validate all requested paths have unreviewed changes
        for (input_path, rel_path) in path_pairs {
            if !changed_paths.contains(rel_path.as_str()) {
                anyhow::bail!("No unreviewed local changes for '{}'.", input_path);
            }
        }

        for (_, rel_path) in path_pairs {
            let snapshot = parse_json_value_at(
                &file_path_to_contents_map_in_main_branch,
                rel_path,
                "refs/heads/main",
            )?;
            let working = parse_json_value_at(
                &file_path_to_contents_map_in_worktree,
                rel_path,
                "working tree",
            )?;
            match crate::shared::re_anchor::compute_entry(
                rel_path,
                snapshot.as_ref(),
                working.as_ref(),
            ) {
                Some(entry) => {
                    crate::shared::accepted_patches::upsert_entry(&mut accepted_file, entry);
                }
                None => {
                    // Working == published. The unreviewed change was the
                    // user reverting back to main; accepting it means
                    // dropping any accepted-patches entry for this path.
                    crate::shared::accepted_patches::remove_entry(&mut accepted_file, rel_path);
                }
            }
        }

        crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
        let rel_paths: Vec<String> = path_pairs.iter().map(|(_, rel)| rel.clone()).collect();
        revalidate_paths_for_connection_context(ctx, &rel_paths, path_pairs.len() > 1)?;

        all_accepted.extend(path_pairs.iter().map(|(input_path, _)| input_path.clone()));
    }

    // Refresh folder_index for the paths we just mutated so the desktop grid's
    // approvedChanges / unapprovedChanges bits stay current without a manual
    // `index refresh-folder`. `accept-all` already does this on line 1154; the
    // single-file path missed it before mr29.
    reindex_folder_index_for_changes(&workspace_dir, &all_accepted)?;

    let total = all_accepted.len();
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "accepted",
                "filesAccepted": total,
                "paths": all_accepted,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    println!(
        "Accepted {} local record change{}. ({})",
        total,
        if total == 1 { "" } else { "s" },
        format_elapsed(elapsed_ms)
    );
    print_file_list(&all_accepted);
    Ok(())
}

fn run_reject(cwd: &Path, input_paths: &[String], json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);

    let mut by_conn: HashMap<usize, Vec<(String, String)>> = HashMap::new();
    for input_path in input_paths {
        let found = contexts.iter().enumerate().find_map(|(i, ctx)| {
            let prefix = format!("{}/", ctx.conn_dir_name);
            input_path
                .strip_prefix(&prefix)
                .map(|rest| (i, rest.to_string()))
        });
        match found {
            Some((i, rel_path)) => by_conn
                .entry(i)
                .or_default()
                .push((input_path.clone(), rel_path)),
            None => anyhow::bail!(
                "Path '{}' does not match any connection. Expected format: <connection-name>/<relative-path>",
                input_path
            ),
        }
    }

    let mut all_rejected: Vec<String> = Vec::new();

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];

        // Read only the main blobs we actually need. `read_main_branch_contents_filtered_by_path`
        // still walks `ls-tree` (cheap metadata only) but `cat-file --batch`
        // is scoped to the rel_paths we're rejecting, so a single-record
        // reject pays O(1) blob reads instead of loading the whole connection.
        let wanted: HashSet<String> = path_pairs.iter().map(|(_, rel)| rel.clone()).collect();
        let file_path_to_contents_map_in_main_branch =
            read_main_branch_contents_filtered_by_path(&ctx.bare_repo, |p| wanted.contains(p))?;

        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        let accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;

        // Two-pass to keep all-or-nothing semantics: validate every path in
        // this connection has unreviewed changes before writing anything.
        let mut resolved: Vec<(&str, Option<Vec<u8>>)> = Vec::with_capacity(path_pairs.len());
        for (input_path, rel_path) in path_pairs {
            let approved_bytes = approved_bytes_for_path(
                &file_path_to_contents_map_in_main_branch,
                &accepted_file,
                rel_path,
            )?;
            let working_bytes = match std::fs::read(ctx.worktree_dir.join(rel_path)) {
                Ok(bytes) => Some(review_ops::normalize_crlf(bytes)),
                Err(err) if err.kind() == io::ErrorKind::NotFound => None,
                Err(err) => return Err(err.into()),
            };

            if !json_content_differs(approved_bytes.as_deref(), working_bytes.as_deref()) {
                anyhow::bail!("No unreviewed local changes for '{}'.", input_path);
            }

            resolved.push((rel_path.as_str(), approved_bytes));
        }

        // Restore each working file to its approved bytes. Accepted-patches
        // file is untouched — reject only undoes the unreviewed delta
        // between working and approved.
        for (rel_path, approved_bytes) in &resolved {
            write_or_remove_working_file(ctx, rel_path, approved_bytes.as_deref())?;
        }

        all_rejected.extend(path_pairs.iter().map(|(input_path, _)| input_path.clone()));
    }

    // Refresh folder_index — reject restored the working file to its approved
    // bytes, which flips unapprovedChanges from 1 → 0 for the affected rows.
    reindex_folder_index_for_changes(&workspace_dir, &all_rejected)?;

    let total = all_rejected.len();
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "rejected",
                "filesRejected": total,
                "paths": all_rejected,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    println!(
        "Rejected {} local record change{}. ({})",
        total,
        if total == 1 { "" } else { "s" },
        format_elapsed(elapsed_ms)
    );
    print_file_list(&all_rejected);
    Ok(())
}

fn run_discard(cwd: &Path, input_paths: &[String], json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    // Group input paths by connection (same pattern as run_accept / run_reject).
    let mut by_conn: HashMap<usize, Vec<(String, String)>> = HashMap::new();
    for input_path in input_paths {
        let found = contexts.iter().enumerate().find_map(|(i, ctx)| {
            let prefix = format!("{}/", ctx.conn_dir_name);
            input_path
                .strip_prefix(&prefix)
                .map(|rest| (i, rest.to_string()))
        });
        match found {
            Some((i, rel_path)) => by_conn
                .entry(i)
                .or_default()
                .push((input_path.clone(), rel_path)),
            None => anyhow::bail!(
                "Path '{}' does not match any connection. Expected format: <connection-name>/<relative-path>",
                input_path
            ),
        }
    }

    let mut all_discarded: Vec<String> = Vec::new();
    let mut skipped_any = false;

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];
        let rel_paths: Vec<String> = path_pairs.iter().map(|(_, rel)| rel.clone()).collect();
        let input_by_rel: HashMap<&str, &str> = path_pairs
            .iter()
            .map(|(input, rel)| (rel.as_str(), input.as_str()))
            .collect();

        let result = discard_record_paths_in_connection_repo(ctx, &rel_paths, &input_by_rel)?;
        if result.skipped_missing_main {
            skipped_any = true;
            continue;
        }
        revalidate_paths_for_connection_context(
            ctx,
            &result.discarded_paths,
            path_pairs.len() > 1,
        )?;
        for rel in &result.discarded_paths {
            if let Some(input) = input_by_rel.get(rel.as_str()) {
                all_discarded.push((*input).to_string());
            }
        }
    }

    // Refresh folder_index for the paths we just mutated so the desktop grid's
    // approvedChanges / unapprovedChanges bits stay current without a manual
    // `index refresh-folder`. `discard-all` already does this; the single-file
    // path missed it before mr29.
    reindex_folder_index_for_changes(&workspace_dir, &all_discarded)?;

    let total = all_discarded.len();
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": if total == 0 { "no_changes" } else { "discarded" },
                "filesDiscarded": total,
                "paths": all_discarded,
                "skippedMissingMain": skipped_any,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    if total == 0 {
        println!(
            "No local changes to discard. ({})",
            format_elapsed(elapsed_ms)
        );
    } else {
        println!(
            "Discarded {} local record change{}. ({})",
            total,
            if total == 1 { "" } else { "s" },
            format_elapsed(elapsed_ms)
        );
        print_file_list(&all_discarded);
    }
    if skipped_any {
        println!("Note: one or more connections have no published state yet and were skipped.");
    }
    Ok(())
}

fn run_accept_field(cwd: &Path, folder: &Path, field: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let (ctx, repo_folder, display_folder) =
        resolve_folder_context(&workspace_dir, &contexts, folder)?;

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);

    sync_schema_files_from_worktree(&ctx)?;
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    // Folder-scoped: ls-tree still enumerates the whole main tree because
    // cat-file --batch needs the OIDs (there's no path → OID primitive that
    // skips the walk), but only blobs under `repo_folder` get cat-file'd. On
    // a 38k-record workspace with a 5k-record folder, the cat-file step drops
    // from megabytes to a few hundred KB.
    let (
        file_path_to_contents_map_in_main_branch,
        _approved_state,
        file_path_to_contents_map_in_worktree,
    ) = read_main_local_and_approved_maps_scoped_to_folder(&ctx, &repo_folder, &accepted_file)?;

    let result = accept_field_in_folder(
        &ctx,
        &repo_folder,
        field,
        &file_path_to_contents_map_in_main_branch,
        &mut accepted_file,
        &file_path_to_contents_map_in_worktree,
    )?;
    let elapsed_ms = started.elapsed().as_millis();

    if result.changed_paths.is_empty() {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "no_changes",
                    "field": field,
                    "folder": display_folder,
                    "filesAccepted": 0,
                    "paths": [],
                    "elapsedMs": elapsed_ms,
                }))?
            );
        } else {
            println!(
                "No field changes to approve for '{}' in {}. ({})",
                field,
                display_folder,
                format_elapsed(elapsed_ms)
            );
        }
        return Ok(());
    }

    if result.patches_changed {
        crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    }
    revalidate_paths_for_connection_context(&ctx, &result.changed_paths, true)?;
    // Folder_index reindex for the affected rows. changed_paths is repo-
    // relative; reindex_folder_index_for_changes wants workspace-relative.
    let workspace_relative_paths: Vec<String> = result
        .changed_paths
        .iter()
        .map(|rel| format!("{}/{}", ctx.conn_dir_name, rel))
        .collect();
    reindex_folder_index_for_changes(&workspace_dir, &workspace_relative_paths)?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "accepted",
                "field": field,
                "folder": display_folder,
                "filesAccepted": result.changed_paths.len(),
                "paths": result.changed_paths,
                "elapsedMs": elapsed_ms,
            }))?
        );
    } else {
        println!(
            "Accepted field '{}' in {} file(s) under {}. ({})",
            field,
            result.changed_paths.len(),
            display_folder,
            format_elapsed(elapsed_ms)
        );
        print_file_list(&result.changed_paths);
    }

    Ok(())
}

fn run_reject_field(cwd: &Path, folder: &Path, field: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let (ctx, repo_folder, display_folder) =
        resolve_folder_context(&workspace_dir, &contexts, folder)?;

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);

    sync_schema_files_from_worktree(&ctx)?;
    let accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    // Folder-scoped main + worktree reads; see run_accept_field for why
    // ls-tree still enumerates the whole tree (cat-file needs OIDs) while
    // cat-file is the path that actually narrows.
    let (
        file_path_to_contents_map_in_main_branch,
        _approved_state,
        file_path_to_contents_map_in_worktree,
    ) = read_main_local_and_approved_maps_scoped_to_folder(&ctx, &repo_folder, &accepted_file)?;

    let (next_file_path_to_contents_map_in_worktree, result) = reject_field_in_folder(
        &ctx,
        &repo_folder,
        field,
        &file_path_to_contents_map_in_main_branch,
        &accepted_file,
        &file_path_to_contents_map_in_worktree,
    )?;
    let elapsed_ms = started.elapsed().as_millis();

    if result.changed_paths.is_empty() {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "no_changes",
                    "field": field,
                    "folder": display_folder,
                    "filesRejected": 0,
                    "paths": [],
                    "elapsedMs": elapsed_ms,
                }))?
            );
        } else {
            println!(
                "No field changes to discard for '{}' in {}. ({})",
                field,
                display_folder,
                format_elapsed(elapsed_ms)
            );
        }
        return Ok(());
    }

    apply_changed_working_files(
        &ctx,
        &file_path_to_contents_map_in_worktree,
        &next_file_path_to_contents_map_in_worktree,
        &repo_folder,
    )?;
    revalidate_paths_for_connection_context(&ctx, &result.changed_paths, true)?;
    let workspace_relative_paths: Vec<String> = result
        .changed_paths
        .iter()
        .map(|rel| format!("{}/{}", ctx.conn_dir_name, rel))
        .collect();
    reindex_folder_index_for_changes(&workspace_dir, &workspace_relative_paths)?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "rejected",
                "field": field,
                "folder": display_folder,
                "filesRejected": result.changed_paths.len(),
                "paths": result.changed_paths,
                "elapsedMs": elapsed_ms,
            }))?
        );
    } else {
        println!(
            "Rejected field '{}' in {} file(s) under {}. ({})",
            field,
            result.changed_paths.len(),
            display_folder,
            format_elapsed(elapsed_ms)
        );
        print_file_list(&result.changed_paths);
    }

    Ok(())
}

fn run_discard_field(cwd: &Path, folder: &Path, field: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let (ctx, repo_folder, display_folder) =
        resolve_folder_context(&workspace_dir, &contexts, folder)?;

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);

    sync_schema_files_from_worktree(&ctx)?;
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    // Folder-scoped main + worktree reads; see run_accept_field for why
    // ls-tree still enumerates the whole tree (cat-file needs OIDs) while
    // cat-file is the path that actually narrows.
    let (
        file_path_to_contents_map_in_main_branch,
        _approved_state,
        file_path_to_contents_map_in_worktree,
    ) = read_main_local_and_approved_maps_scoped_to_folder(&ctx, &repo_folder, &accepted_file)?;

    let (next_file_path_to_contents_map_in_worktree, result) = discard_field_in_folder(
        &ctx,
        &repo_folder,
        field,
        &file_path_to_contents_map_in_main_branch,
        &mut accepted_file,
        &file_path_to_contents_map_in_worktree,
    )?;
    let elapsed_ms = started.elapsed().as_millis();

    if result.changed_paths.is_empty() {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "no_changes",
                    "field": field,
                    "folder": display_folder,
                    "filesDiscarded": 0,
                    "paths": [],
                    "elapsedMs": elapsed_ms,
                }))?
            );
        } else {
            println!(
                "No changes to discard for '{}' in {}. ({})",
                field,
                display_folder,
                format_elapsed(elapsed_ms)
            );
        }
        return Ok(());
    }

    apply_changed_working_files(
        &ctx,
        &file_path_to_contents_map_in_worktree,
        &next_file_path_to_contents_map_in_worktree,
        &repo_folder,
    )?;
    if result.patches_changed {
        crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    }
    revalidate_paths_for_connection_context(&ctx, &result.changed_paths, true)?;
    let workspace_relative_paths: Vec<String> = result
        .changed_paths
        .iter()
        .map(|rel| format!("{}/{}", ctx.conn_dir_name, rel))
        .collect();
    reindex_folder_index_for_changes(&workspace_dir, &workspace_relative_paths)?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "discarded",
                "field": field,
                "folder": display_folder,
                "filesDiscarded": result.changed_paths.len(),
                "paths": result.changed_paths,
                "elapsedMs": elapsed_ms,
            }))?
        );
    } else {
        println!(
            "Discarded field '{}' in {} file(s) under {}. ({})",
            field,
            result.changed_paths.len(),
            display_folder,
            format_elapsed(elapsed_ms)
        );
        print_file_list(&result.changed_paths);
    }

    Ok(())
}

// Restore approved deletions by:
// - grouping requested paths by connection
// - copying the main-branch version back into the local working tree and dirty branch
fn run_restore_deleted_record(
    cwd: &Path,
    _server_url: &str,
    input_paths: &[String],
    json: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let by_conn = group_input_paths_by_connection(&contexts, input_paths)?;
    let mut all_restored: Vec<String> = Vec::new();

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];
        let rel_paths: Vec<String> = path_pairs
            .iter()
            .map(|(_, rel_path)| rel_path.clone())
            .collect();
        restore_deleted_record_paths_from_main_branch(ctx, &rel_paths)?;
        revalidate_paths_for_connection_context(ctx, &rel_paths, false)?;
        all_restored.extend(path_pairs.iter().map(|(input_path, _)| input_path.clone()));
    }

    reindex_folder_index_for_changes(&workspace_dir, &all_restored)?;

    let total = all_restored.len();
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "restored",
                "filesRestored": total,
                "paths": all_restored,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    println!(
        "Restored {} approved deletion{}. ({})",
        total,
        if total == 1 { "" } else { "s" },
        format_elapsed(elapsed_ms)
    );
    print_file_list(&all_restored);
    Ok(())
}

// Discard approved creates by:
// - grouping requested paths by connection
// - removing the record from the local working tree and dirty branch
// - also discarding the matching path from the remote dirty branch
async fn run_discard_created_record(
    cwd: &Path,
    server_url: &str,
    input_paths: &[String],
    json: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (workspace_marker, workspace_dir, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url, json)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let client = crate::api::ApiClient::from_credentials(&workspace_server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))?;
    let by_conn = group_input_paths_by_connection(&contexts, input_paths)?;
    let mut result = RemoteDiscardResult::default();

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];
        let rel_paths: Vec<String> = path_pairs
            .iter()
            .map(|(_, rel_path)| rel_path.clone())
            .collect();

        drop_create_patches_and_delete_working_files_for_record_paths(ctx, &rel_paths)?;
        revalidate_paths_for_connection_context(ctx, &rel_paths, false)?;
        result
            .changed_paths
            .extend(path_pairs.iter().map(|(input_path, _)| input_path.clone()));

        for rel_path in &rel_paths {
            discard_created_record_remotely(&client, &workspace_marker.workbook.id, ctx, rel_path)
                .await?;
            result
                .remote_discarded_paths
                .push(format!("{}/{}", ctx.conn_dir_name, rel_path));
        }
    }

    reindex_folder_index_for_changes(&workspace_dir, &result.changed_paths)?;

    let total = result.changed_paths.len();
    let remote_total = result.remote_discarded_paths.len();
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "discarded",
                "filesDiscarded": total,
                "paths": result.changed_paths,
                "remoteDirtyPathsDiscarded": result.remote_discarded_paths,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    println!(
        "Discarded {} approved create{}. ({})",
        total,
        if total == 1 { "" } else { "s" },
        format_elapsed(elapsed_ms)
    );
    if remote_total > 0 {
        println!(
            "Also discarded {} matching path{} from the remote dirty branch.",
            remote_total,
            if remote_total == 1 { "" } else { "s" }
        );
    }
    print_file_list(&result.changed_paths);
    Ok(())
}

fn run_unreviewed(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url, json)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    // Uses the gix::status-backed fast helper so the desktop's pre-publish
    // modal load (which spawns `scratchmd --json files unreviewed`) doesn't
    // pay the multi-second tree-walk cost the old `unreviewed_entries` did.
    let mut entries = Vec::new();
    for ctx in &contexts {
        entries.extend(
            list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(ctx, false)?,
        );
    }
    entries.sort_by(|left, right| {
        left.connection_name
            .cmp(&right.connection_name)
            .then_with(|| left.path.cmp(&right.path))
    });

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "count": entries.len(),
                "entries": entries,
            }))?
        );
        return Ok(());
    }

    if entries.is_empty() {
        println!("No unreviewed local record changes.");
        return Ok(());
    }

    println!("{} unreviewed local record change(s):", entries.len());
    for entry in entries {
        println!(
            "  [{}] {} — {}",
            entry.connection_name, entry.status, entry.path
        );
    }
    Ok(())
}

fn run_get_review_stats(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let (_, workspace_dir, _, _) = resolve_workspace_and_connections(cwd, server_url, json)?;
    let stats = crate::shared::review_stats::collect_review_stats(&workspace_dir)?;

    if json {
        println!("{}", serde_json::to_string(&stats)?);
        return Ok(());
    }

    if stats.is_empty() {
        println!("No folders with pending review changes.");
        return Ok(());
    }

    println!("{} folder(s) with pending review changes:", stats.len());
    for entry in &stats {
        let folder_label = if entry.folder_path.is_empty() {
            entry.connection.clone()
        } else {
            format!("{}/{}", entry.connection, entry.folder_path)
        };
        println!(
            "  {folder_label} — unreviewed={}, approved={}",
            entry.unreviewed, entry.approved
        );
    }
    Ok(())
}

fn run_unpublished(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url, json)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut entries = Vec::new();
    for ctx in &contexts {
        entries.extend(list_unpublished_accepted_patch_entries(ctx)?);
    }
    entries.sort_by(|left, right| {
        left.connection_name
            .cmp(&right.connection_name)
            .then_with(|| left.path.cmp(&right.path))
    });

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "count": entries.len(),
                "entries": entries,
            }))?
        );
        return Ok(());
    }

    if entries.is_empty() {
        println!("No unpublished changes.");
        return Ok(());
    }

    println!("{} unpublished change(s):", entries.len());
    for entry in entries {
        println!(
            "  [{}] {} — {}",
            entry.connection_name, entry.status, entry.path
        );
    }
    Ok(())
}

fn run_unpushed(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url, json)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut entries = Vec::new();
    for ctx in &contexts {
        entries.extend(list_unpublished_accepted_patch_entries(ctx)?);
    }
    entries.sort_by(|a, b| {
        a.connection_name
            .cmp(&b.connection_name)
            .then_with(|| a.path.cmp(&b.path))
    });

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "count": entries.len(),
                "entries": entries,
            }))?
        );
        return Ok(());
    }

    if entries.is_empty() {
        println!("No unpushed changes.");
        return Ok(());
    }

    println!("{} unpushed change(s):", entries.len());
    for entry in entries {
        println!(
            "  [{}] {} — {}",
            entry.connection_name, entry.status, entry.path
        );
    }
    Ok(())
}

pub async fn download_workbook(
    base_url: &str,
    token: &str,
    workbook_id: &str,
) -> anyhow::Result<()> {
    let Some(workspace_dir) = crate::config::find_workspace_dir(workbook_id) else {
        eprintln!("(Workspace not initialized locally — skipping file download)");
        return Ok(());
    };

    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    // Programmatic refresh — intentionally skips `check_workspace_layout_or_bail`.
    // Linked-CLI callers expect a best-effort refresh post-server-mutation;
    // refusing here would fail downstream operations the user didn't directly
    // trigger. Old-layout workspaces show up only on user-initiated commands.
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let server_state =
        fetch_connection_server_state(base_url, &workspace_marker, workbook_id).await;

    // If the server restructured a connection's folders (DEV-9698), skip the
    // best-effort refresh entirely rather than re-anchoring a stale clone onto
    // the moved layout. The action that triggered this refresh already
    // succeeded server-side; the user hits the actionable re-clone prompt on
    // their next explicit `scratchmd files download`. Mirrors the unreviewed-
    // edits skip below — warn, don't fail the caller.
    let downloaded_connection_ids: HashSet<&str> =
        contexts.iter().map(|c| c.connection_id.as_str()).collect();
    let structure_drift: Vec<StructureVersionDrift> =
        detect_structure_version_drift(&workspace_marker, &server_state)
            .into_iter()
            .filter(|d| downloaded_connection_ids.contains(d.connection_id.as_str()))
            .collect();
    if !structure_drift.is_empty() {
        eprintln!(
            "Warning: skipping local refresh — the folder structure for {} connection(s) changed on the server. Re-clone the workspace (`scratchmd workspaces init {} --force`) to continue.",
            structure_drift.len(),
            workbook_id
        );
        return Ok(());
    }

    refresh_workbook_for_contexts(&workspace_dir, &contexts, &server_state, token)
}

/// Inner refresh loop for the programmatic post-server-mutation path. Holds
/// the workspace-wide lock for the duration of pre-flight + materialize so a
/// concurrent `scratchmd files accept-field` (or any other mutating CLI op)
/// can't race against the blobs being written.
///
/// If any connection has unreviewed working-tree edits, the function warns on
/// stderr and returns Ok(()) without touching the worktree. The linked-table
/// action that triggered the refresh already succeeded server-side (its JSON
/// result is on stdout); silently overwriting in-flight typing would be the
/// worse failure mode. The user re-runs `scratchmd files download` explicitly
/// after `accept-all` / `discard-all` to bring local in sync.
fn refresh_workbook_for_contexts(
    workspace_dir: &Path,
    contexts: &[ConnectionContext],
    server_state: &HashMap<String, ConnectionServerState>,
    token: &str,
) -> anyhow::Result<()> {
    let _lock = crate::config::workspace_lock::acquire(workspace_dir)?;

    // Same fast pre-flight as `run_download`: gix::status-backed (~210ms per
    // connection warm) instead of the multi-second per-connection tree walks
    // the slow variant does. The linked-CLI refresh is invoked after every
    // server-side mutation, so the per-call cost is felt repeatedly.
    let mut blocked: Vec<RecordChangeEntry> = Vec::new();
    for ctx in contexts {
        blocked.extend(
            list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(ctx, false)?,
        );
    }
    if !blocked.is_empty() {
        let paths: Vec<String> = blocked
            .iter()
            .map(|e| format!("{}/{}", e.connection_name, e.path))
            .collect();
        eprintln!(
            "Warning: skipping local refresh — {} unreviewed record(s):",
            paths.len()
        );
        let preview_limit = paths.len().min(10);
        for path in &paths[..preview_limit] {
            eprintln!("  {path}");
        }
        if paths.len() > preview_limit {
            eprintln!("  ... and {} more", paths.len() - preview_limit);
        }
        eprintln!(
            "Run `scratchmd files accept-all` or `discard-all`, then `scratchmd files download` to sync."
        );
        return Ok(());
    }

    for ctx in contexts {
        let folders: &[DataFolder] = server_state
            .get(&ctx.connection_id)
            .map(|s| s.data_folders.as_slice())
            .unwrap_or(&[]);
        download_single_repo(ctx, workspace_dir, token, folders)?;
        if update_main_worktree_after_pull(ctx, token).is_ok() {
            let _ = sync_schema_files_from_worktree(ctx);
        }
    }
    Ok(())
}

/// The server's current view of one connection, as needed by download: the
/// fresh DataFolder metadata (to reconcile empty folders after materialization)
/// and the connector's folder-structure version (to detect a server-side
/// restructure that leaves the local clone stale — DEV-9698).
struct ConnectionServerState {
    data_folders: Vec<DataFolder>,
    /// Server `ConnectorAccount.version`. `0` when an older server omits it.
    structure_version: i32,
}

/// Fetch each connection's server-side state (DataFolders + structure version)
/// in a single workbook GET. Best-effort: on any auth or network error, returns
/// an empty map — file merge still proceeds, only the empty-folder reconcile +
/// structure-drift check are skipped.
async fn fetch_connection_server_state(
    base_url: &str,
    workspace_marker: &markers::WorkspaceMarker,
    workbook_id: &str,
) -> HashMap<String, ConnectionServerState> {
    let server_url = if workspace_marker.workbook.server_url.is_empty() {
        base_url
    } else {
        workspace_marker.workbook.server_url.as_str()
    };
    let Some(client) = crate::api::ApiClient::from_credentials(server_url) else {
        return HashMap::new();
    };
    match client
        .get::<crate::api::Workbook>(&format!("workbooks/{}", workbook_id))
        .await
    {
        Ok(wb) => wb
            .connector_accounts
            .into_iter()
            .map(|ca| {
                (
                    ca.id,
                    ConnectionServerState {
                        data_folders: ca.data_folders,
                        structure_version: ca.version,
                    },
                )
            })
            .collect(),
        Err(e) => {
            eprintln!("  Note: could not fetch folder metadata for reconcile: {e}");
            HashMap::new()
        }
    }
}

/// One connection whose locally-recorded folder-structure version no longer
/// matches the server's. Produced by [`detect_structure_version_drift`].
struct StructureVersionDrift {
    /// The connector account id — used to scope the bail to the connections
    /// actually being downloaded.
    connection_id: String,
    /// The connection's worktree directory name (what the user sees on disk).
    connection_dir_name: String,
    #[allow(dead_code)]
    recorded_version: i32,
    #[allow(dead_code)]
    server_version: i32,
}

/// Generic, connector-agnostic detection: compare each connection's recorded
/// folder-structure version (captured in the workspace marker at clone time)
/// against the server's current `ConnectorAccount.version`. A difference means
/// the server restructured this connection's folder layout (e.g. the DEV-9698
/// Webflow flat→nested migration) and the local clone is stale.
///
/// This is purely an integer comparison — the CLI frontend stays free of any
/// connector-specific knowledge of *what* the layout is. `0` on either side is
/// treated as "unknown / not recorded" (a marker written before the field
/// existed, or an older server that doesn't send it) and never trips detection,
/// so it can only fire on a genuine version change between two known values.
fn detect_structure_version_drift(
    marker: &markers::WorkspaceMarker,
    server_state: &HashMap<String, ConnectionServerState>,
) -> Vec<StructureVersionDrift> {
    marker
        .connections
        .iter()
        .filter_map(|c| {
            let recorded = c.structure_version;
            let server = server_state
                .get(&c.id)
                .map(|s| s.structure_version)
                .unwrap_or(0);
            if recorded != 0 && server != 0 && recorded != server {
                Some(StructureVersionDrift {
                    connection_id: c.id.clone(),
                    connection_dir_name: if c.dir_name.is_empty() {
                        c.display_name.clone()
                    } else {
                        c.dir_name.clone()
                    },
                    recorded_version: recorded,
                    server_version: server,
                })
            } else {
                None
            }
        })
        .collect()
}

/// Print the structured `workspace_needs_reinit` result for a folder-structure
/// change (reason `structure_changed`). Mirrors
/// [`print_workspace_needs_reinit_result`] so the desktop pattern-matches the
/// same JSON envelope; only the `reason` + copy differ. Caller bails after.
fn print_structure_change_reinit_result(
    drift: &[StructureVersionDrift],
    json: bool,
) -> anyhow::Result<()> {
    let affected: Vec<String> = drift
        .iter()
        .map(|d| d.connection_dir_name.clone())
        .collect();
    let recommendation = "The folder structure for these connection(s) changed on the server. Run `scratchmd workspaces init <workbook-id> --force` to re-sync your local copy. Edits staged for publish are backed up first; accept or publish any other in-progress changes before re-cloning to keep them.";
    if json {
        let output = serde_json::json!({
            "status": "workspace_needs_reinit",
            "reason": "structure_changed",
            "affectedConnections": affected,
            "recommendation": recommendation,
        });
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }
    println!("This workspace's folder structure changed on the server and needs to be re-synced.");
    println!();
    println!("Affected connection(s):");
    for name in &affected {
        println!("  {name}");
    }
    println!();
    println!("{recommendation}");
    Ok(())
}

/// Refuse to operate on workspaces that were initialized under the
/// pre-slice-F multi-worktree layout (sparse `dirty` worktree + sparse
/// `master` worktree). Prints a structured `workspace_needs_reinit` error
/// (JSON mode) or a human-readable message (otherwise), then bails so the
/// caller exits non-zero. The user's escape hatch is `scratchmd files
/// publish` to drain any pending edits, followed by `workspaces unsync` +
/// `workspaces init` to re-initialize.
///
/// Detection is cheap (≤ 2 stat calls per connection); safe to call on
/// every mutating or listing CLI op. `workspaces show` / `unsync` and
/// programmatic refresh paths (`download_workbook`) intentionally skip this
/// check — the user needs a way to inspect / tear down a stuck workspace.
fn check_workspace_layout_or_bail(
    workspace_dir: &Path,
    marker: &markers::WorkspaceMarker,
    json: bool,
) -> anyhow::Result<()> {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    let dir_names: Vec<&str> = marker
        .connections
        .iter()
        .map(|c| c.dir_name.as_str())
        .collect();
    let detection = layout.detect_old_layout(&dir_names);
    if !detection.is_old_layout() {
        return Ok(());
    }
    print_workspace_needs_reinit_result(&detection, json)?;
    anyhow::bail!(
        "This workspace was created on an older version of Scratch and needs to be reinitialized."
    );
}

/// Print the structured `workspace_needs_reinit` result. Mirrors the
/// `blocked_unreviewed` pattern (slice D): JSON mode emits a machine-readable
/// payload the desktop pattern-matches on; non-JSON mode emits human output.
/// Caller bails immediately after so the trailing `Error:` line still appears.
fn print_workspace_needs_reinit_result(
    detection: &OldLayoutDetection,
    json: bool,
) -> anyhow::Result<()> {
    let affected = detection.affected_connections();
    if json {
        let output = serde_json::json!({
            "status": "workspace_needs_reinit",
            "reason": "old_layout_pre_slice_f",
            "affectedConnections": affected,
            "connectionsWithMasterWorktree": detection.connections_with_master_worktree,
            "connectionsWithSparseCheckout": detection.connections_with_sparse_checkout,
            "recommendation": "Run `scratchmd workspaces init <workbook-id> --force` to reinitialize. Any unpublished edits will be discarded.",
        });
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }
    println!(
        "This workspace was created on an older version of Scratch and needs to be reinitialized."
    );
    println!();
    println!("Affected connection(s):");
    for name in &affected {
        println!("  {name}");
    }
    println!();
    println!("Run `scratchmd workspaces init <workbook-id> --force` to reinitialize.");
    println!("Any unpublished edits will be discarded.");
    Ok(())
}

fn resolve_workspace_and_connections(
    cwd: &Path,
    server_url: &str,
    json: bool,
) -> anyhow::Result<(
    markers::WorkspaceMarker,
    PathBuf,
    Vec<ConnectionContext>,
    String,
)> {
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    check_workspace_layout_or_bail(&workspace_dir, &workspace_marker, json)?;
    let workspace_server_url = if workspace_marker.workbook.server_url.is_empty() {
        server_url.to_string()
    } else {
        workspace_marker.workbook.server_url.clone()
    };
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, Some(cwd))?;
    Ok((
        workspace_marker,
        workspace_dir,
        contexts,
        workspace_server_url,
    ))
}

fn read_workspace_marker(workspace_dir: &Path) -> anyhow::Result<markers::WorkspaceMarker> {
    let marker_path = markers::marker_path(workspace_dir);
    match markers::read(&marker_path) {
        Ok(markers::Marker::Workspace(marker)) => Ok(marker),
        _ => anyhow::bail!(
            "Could not read workspace marker at {}",
            marker_path.display()
        ),
    }
}

fn build_connection_contexts(
    workspace_dir: &Path,
    workspace_marker: &markers::WorkspaceMarker,
    cwd_filter: Option<&Path>,
) -> anyhow::Result<Vec<ConnectionContext>> {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    let selected =
        cwd_filter.and_then(|cwd| detect_selected_connection(workspace_dir, cwd, workspace_marker));

    let contexts = workspace_marker
        .connections
        .iter()
        .filter(|connection| match selected.as_deref() {
            Some(name) => connection.dir_name == name,
            None => true,
        })
        .filter(|connection| !connection.repo_path.is_empty() && !connection.dir_name.is_empty())
        .map(|connection| ConnectionContext {
            connection_id: connection.id.clone(),
            conn_dir_name: connection.dir_name.clone(),
            worktree_dir: layout.worktree_path(&connection.dir_name),
            scratch_dir: layout.connection_scratch_path(&connection.dir_name),
            workspace_dir: layout.workbook_materialization_path(),
            bare_repo: layout.bare_repo_path(&connection.repo_path),
            db_path: layout.index_db_path(&connection.repo_path),
        })
        .collect();

    Ok(contexts)
}

fn group_input_paths_by_connection(
    contexts: &[ConnectionContext],
    input_paths: &[String],
) -> anyhow::Result<HashMap<usize, Vec<(String, String)>>> {
    let mut by_conn: HashMap<usize, Vec<(String, String)>> = HashMap::new();
    for input_path in input_paths {
        let found = contexts.iter().enumerate().find_map(|(i, ctx)| {
            let prefix = format!("{}/", ctx.conn_dir_name);
            input_path
                .strip_prefix(&prefix)
                .map(|rest| (i, rest.to_string()))
        });
        match found {
            Some((i, rel_path)) => by_conn.entry(i).or_default().push((input_path.clone(), rel_path)),
            None => anyhow::bail!(
                "Path '{}' does not match any connection. Expected format: <connection-name>/<relative-path>",
                input_path
            ),
        }
    }
    Ok(by_conn)
}

/// Undo an accepted delete. For each path: error if there's no `Delete` entry
/// in `accepted-patches.json`; error if `refs/heads/main` doesn't have the
/// path. Otherwise: drop the entry, write the main blob to the worktree.
fn restore_deleted_record_paths_from_main_branch(
    ctx: &ConnectionContext,
    rel_paths: &[String],
) -> anyhow::Result<()> {
    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    let requested_rel_paths_set: std::collections::HashSet<&str> =
        rel_paths.iter().map(String::as_str).collect();
    let file_path_to_contents_map_in_main_branch =
        read_main_branch_contents_filtered_by_path(&ctx.bare_repo, |p| {
            requested_rel_paths_set.contains(p)
        })?;

    let mut to_restore: Vec<(String, Vec<u8>)> = Vec::with_capacity(rel_paths.len());
    for rel_path in rel_paths {
        let display_path = format!("{}/{}", ctx.conn_dir_name, rel_path);
        let Some(entry) = crate::shared::accepted_patches::get_entry(&accepted_file, rel_path)
        else {
            anyhow::bail!("'{}' is not an approved deleted record.", display_path);
        };
        if entry.kind != crate::shared::re_anchor::PatchKind::Delete {
            anyhow::bail!("'{}' is not an approved deleted record.", display_path);
        }
        let Some(main_content) = file_path_to_contents_map_in_main_branch.get(rel_path.as_str())
        else {
            anyhow::bail!(
                "'{}' does not exist on main and cannot be restored.",
                display_path
            );
        };
        to_restore.push((rel_path.clone(), main_content.clone()));
    }

    for (rel_path, content) in &to_restore {
        crate::shared::accepted_patches::remove_entry(&mut accepted_file, rel_path);
        write_file(&ctx.worktree_dir.join(rel_path), content)?;
    }
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    Ok(())
}

/// Undo an accepted create. For each path: error if there's no `Create` entry
/// in `accepted-patches.json`; error if `refs/heads/main` already has the
/// path. Otherwise: drop the entry, delete the worktree file.
///
/// The remote-cleanup hack (`discard_created_record_remotely`) is invoked by
/// the caller and stays independent of this routine.
fn drop_create_patches_and_delete_working_files_for_record_paths(
    ctx: &ConnectionContext,
    rel_paths: &[String],
) -> anyhow::Result<()> {
    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    let requested_rel_paths_set: std::collections::HashSet<&str> =
        rel_paths.iter().map(String::as_str).collect();
    let file_path_to_contents_map_in_main_branch =
        read_main_branch_contents_filtered_by_path(&ctx.bare_repo, |p| {
            requested_rel_paths_set.contains(p)
        })?;

    let mut to_discard: Vec<String> = Vec::with_capacity(rel_paths.len());
    for rel_path in rel_paths {
        let display_path = format!("{}/{}", ctx.conn_dir_name, rel_path);
        if file_path_to_contents_map_in_main_branch.contains_key(rel_path.as_str()) {
            anyhow::bail!(
                "'{}' exists on main and cannot be discarded as an approved create.",
                display_path
            );
        }
        let Some(entry) = crate::shared::accepted_patches::get_entry(&accepted_file, rel_path)
        else {
            anyhow::bail!("'{}' is not an approved created record.", display_path);
        };
        if entry.kind != crate::shared::re_anchor::PatchKind::Create {
            anyhow::bail!("'{}' is not an approved created record.", display_path);
        }
        to_discard.push(rel_path.clone());
    }

    for rel_path in &to_discard {
        crate::shared::accepted_patches::remove_entry(&mut accepted_file, rel_path);
        let disk_path = ctx.worktree_dir.join(rel_path);
        if disk_path.exists() {
            std::fs::remove_file(&disk_path).with_context(|| {
                format!("failed to remove working file {}", disk_path.display())
            })?;
        }
    }
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    Ok(())
}

async fn discard_created_record_remotely(
    client: &crate::api::ApiClient,
    workbook_id: &str,
    ctx: &ConnectionContext,
    rel_path: &str,
) -> anyhow::Result<()> {
    // Short-term workaround agreed in a breakout with Ryder, Ivan, and Chris:
    // discarding an approved create should remove the file from the local dirty
    // branch and also attempt to remove it from the remote dirty branch if it
    // was already pushed there as part of a publish. The point of the remote
    // delete is to stop the file from resurfacing on the next pull.
    //
    // Once our upload/download 3-way merge and working-tree rebase logic
    // prioritizes deletes over modifications, we should be able to remove this
    // hack and rely on normal sync behavior instead.
    client
        .discard_remote_dirty_changes(workbook_id, &ctx.connection_id, rel_path)
        .await
        .map_err(|err| {
            anyhow::anyhow!(
                "Discarded '{}/{}' locally, but failed to discard it from the remote dirty branch: {}",
                ctx.conn_dir_name,
                rel_path,
                err
            )
        })
}

fn resolve_folder_context(
    workspace_dir: &Path,
    contexts: &[ConnectionContext],
    folder: &Path,
) -> anyhow::Result<(ConnectionContext, String, String)> {
    let raw_target = if folder.is_absolute() {
        folder.to_path_buf()
    } else {
        workspace_dir.join(folder)
    };
    let target = normalize_path(&raw_target);
    let rel = target.strip_prefix(workspace_dir).map_err(|_| {
        anyhow::anyhow!(
            "Folder '{}' is not inside workspace '{}'.",
            target.display(),
            workspace_dir.display()
        )
    })?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();

    if parts.len() < 2 {
        anyhow::bail!(
            "Folder '{}' must point to a data folder inside a connection.",
            target.display()
        );
    }
    if parts[0].starts_with('.') {
        anyhow::bail!(
            "Folder '{}' is inside Scratch metadata. Pass a data folder under a connection.",
            target.display()
        );
    }

    let conn_name = &parts[0];
    let repo_folder = parts[1..].join("/");
    let ctx = contexts
        .iter()
        .find(|ctx| ctx.conn_dir_name == *conn_name)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("No connection found for '{}'.", conn_name))?;

    Ok((ctx, repo_folder, rel.to_slash_lossy()))
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn detect_selected_connection(
    workspace_dir: &Path,
    cwd: &Path,
    workspace_marker: &markers::WorkspaceMarker,
) -> Option<String> {
    let rel = cwd.strip_prefix(workspace_dir).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();

    if parts.is_empty() {
        return None;
    }

    let candidate = if parts[0] == ".scratch" && parts.len() >= 4 && parts[1] == "connections" {
        match parts[2].as_str() {
            "scratch" | "master" => Some(parts[3].clone()),
            _ => None,
        }
    } else if parts[0].starts_with('.') {
        None
    } else {
        Some(parts[0].clone())
    }?;

    workspace_marker
        .connections
        .iter()
        .find(|connection| connection.dir_name == candidate)
        .map(|connection| connection.dir_name.clone())
}

/// Gix::status-backed unreviewed detector. Index-backed, parallel.
/// ~210ms warm on a 110k-file connection vs. multi-second tree-walks the
/// previous `detect_unreviewed_for_pull` (now deleted) was paying.
///
/// `gix::status` answers "working tree differs from index"; the index reflects
/// `refs/heads/main` after [`worktree_reset_mixed`] (run on init + pull). The
/// byte-level diff is a fast pre-filter — every data path it flags gets a
/// semantic JSON compare in the second pass against its "expected" content:
///
///   - paths in `accepted-patches.json` → expected = `apply(main_blob, entry)`
///   - paths not in `accepted-patches.json` → expected = `main_blob` verbatim
///
/// This collapses what used to be two branches (immediate-flag for unpatched
/// paths; semantic compare for patched paths) into one. Without it, a file
/// that is byte-different from `main` but JSON-equivalent (e.g. trailing
/// newline, key reordering) gets flagged as unreviewed even though there's no
/// semantic change for the user to review — the post-publish refresh in
/// particular hit this when the reconcile dropped the published patch entry
/// and the worktree still held the user's pre-canonical bytes.
///
/// If `short_circuit` is true, returns as soon as the first truly-unreviewed
/// path is found — for the "any?" check that gates the Publish action.
fn list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(
    ctx: &ConnectionContext,
    short_circuit: bool,
) -> anyhow::Result<Vec<RecordChangeEntry>> {
    // Delegates to the shared detector so the CLI's pull / publish / unreviewed
    // gates and the napi `getReviewStats` sidebar dots derive the identical set
    // — one definition of "unreviewed". See
    // `crate::shared::review_ops::list_unreviewed_records_using_gix_status`.
    let records = crate::shared::review_ops::list_unreviewed_records_using_gix_status(
        &ctx.to_paths(),
        short_circuit,
    )?;
    Ok(records
        .into_iter()
        .map(|record| RecordChangeEntry {
            connection_name: ctx.conn_dir_name.clone(),
            path: record.path,
            status: record.status.to_string(),
        })
        .collect())
}

/// Print the structured `blocked_unreviewed` result. Caller bails with
/// non-zero immediately after, so the desktop can pattern-match on the JSON
/// payload while shell users see both the human output and an Error: line.
fn print_blocked_unreviewed_result(
    blocked: &[RecordChangeEntry],
    elapsed_ms: u128,
    json: bool,
) -> anyhow::Result<()> {
    let paths: Vec<String> = blocked
        .iter()
        .map(|e| format!("{}/{}", e.connection_name, e.path))
        .collect();
    if json {
        let output = serde_json::json!({
            "status": "blocked_unreviewed",
            "unreviewedCount": blocked.len(),
            "paths": paths,
            "elapsedMs": elapsed_ms,
        });
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }
    let elapsed = format_elapsed(elapsed_ms);
    println!(
        "Cannot refresh — {} unreviewed record(s) ({}):",
        blocked.len(),
        elapsed
    );
    let preview_limit = paths.len().min(10);
    for path in &paths[..preview_limit] {
        println!("  {path}");
    }
    if paths.len() > preview_limit {
        println!("  ... and {} more", paths.len() - preview_limit);
    }
    println!();
    println!("Run `scratchmd files accept-all` or `scratchmd files discard-all`, then retry.");
    Ok(())
}

/// Print the structured `blocked_stale` result for `files upload` (D8).
/// JSON mode emits a machine-readable payload the desktop pattern-matches
/// on; human mode prints a per-connection summary and a suggestion to run
/// `scratchmd files download`. Caller bails with non-zero exit immediately
/// after.
fn print_blocked_stale_result(
    blocked: &[BlockedStaleConnection],
    elapsed_ms: u128,
    json: bool,
) -> anyhow::Result<()> {
    if json {
        let connections: Vec<serde_json::Value> = blocked
            .iter()
            .map(|b| {
                serde_json::json!({
                    "connectionName": b.connection_name,
                    "baseHead": b.stale.base_head,
                    "currentRemoteHead": b.stale.current_remote_head,
                    "message": b.stale.message,
                })
            })
            .collect();
        let output = serde_json::json!({
            "status": "blocked_stale",
            "blockedCount": blocked.len(),
            "connections": connections,
            "elapsedMs": elapsed_ms,
        });
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }
    let elapsed = format_elapsed(elapsed_ms);
    println!(
        "Cannot upload — server `main` has advanced for {} connection(s) ({}):",
        blocked.len(),
        elapsed
    );
    for b in blocked {
        println!(
            "  {}: local {} → server {}",
            b.connection_name,
            b.stale
                .base_head
                .as_deref()
                .map(short_sha)
                .unwrap_or("<unset>"),
            short_sha(&b.stale.current_remote_head),
        );
    }
    println!();
    println!("Run `scratchmd files download` to refresh local main, then retry.");
    Ok(())
}

/// Print the structured DEV-10316 refusal for `files upload`. JSON mode emits a
/// machine-readable payload the desktop pattern-matches on; human mode prints a
/// per-connection summary and a redirect to the web review screen. A
/// `check_failed` (couldn't verify the server's state) takes precedence over
/// `blocked_dirty` in the top-level `status`: when we couldn't fully verify, the
/// safe move is "try again" (which re-probes everything) rather than a partial
/// dirty redirect. Caller bails with non-zero exit immediately after.
fn print_blocked_dirty_result(
    dirty_blocked: &[BlockedDirtyConnection],
    check_failed: &[CheckFailedConnection],
    elapsed_ms: u128,
    json: bool,
) -> anyhow::Result<()> {
    if json {
        if !check_failed.is_empty() {
            let connections: Vec<serde_json::Value> = check_failed
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "connectionName": c.connection_name,
                        "connectorAccountId": c.failed.connector_account_id,
                        "message": c.failed.message,
                    })
                })
                .collect();
            let output = serde_json::json!({
                "status": "check_failed",
                "blockedCount": check_failed.len(),
                "connections": connections,
                "message": "Couldn't verify the server's state. Try again.",
                "elapsedMs": elapsed_ms,
            });
            println!("{}", serde_json::to_string_pretty(&output)?);
            return Ok(());
        }
        let connections: Vec<serde_json::Value> = dirty_blocked
            .iter()
            .map(|c| {
                serde_json::json!({
                    "connectionName": c.connection_name,
                    "connectorAccountId": c.dirty.connector_account_id,
                    "dirtyCount": c.dirty.dirty_count,
                })
            })
            .collect();
        let output = serde_json::json!({
            "status": "blocked_dirty",
            "blockedCount": dirty_blocked.len(),
            "connections": connections,
            "elapsedMs": elapsed_ms,
        });
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    let elapsed = format_elapsed(elapsed_ms);
    if !check_failed.is_empty() {
        println!(
            "Cannot upload — couldn't verify the server's state for {} connection(s) ({}):",
            check_failed.len(),
            elapsed
        );
        for c in check_failed {
            println!(
                "  {}: {}",
                c.connection_name,
                c.failed.message.as_deref().unwrap_or("check failed"),
            );
        }
        println!();
        println!("This is usually transient — try again.");
        return Ok(());
    }
    println!(
        "Cannot upload — {} connection(s) have unpublished changes on the server ({}):",
        dirty_blocked.len(),
        elapsed
    );
    for c in dirty_blocked {
        println!(
            "  {}: {} unpublished change(s) on the server",
            c.connection_name, c.dirty.dirty_count,
        );
    }
    println!();
    println!("Publish or discard them on the web, then retry.");
    Ok(())
}

/// Resolve the connector's `idColumnRemoteId` (dot path into a record file)
/// for the folder that owns `rel_path`. Reads `.scratch/<folder>/schema.json`
/// from the given on-disk tree map. Returns [`json_path::DEFAULT_ID_PATH`]
/// when the schema is missing or doesn't declare an id column — same fallback
/// as the index builder.
fn load_id_column_remote_id_for_folder(tree_map: &FileMap, rel_path: &str) -> String {
    let folder = std::path::Path::new(rel_path)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("");
    let schema_rel_path = if folder.is_empty() {
        ".scratch/schema.json".to_string()
    } else {
        format!(".scratch/{}/schema.json", folder)
    };
    let Some(schema_bytes) = tree_map.get(schema_rel_path.as_str()) else {
        return crate::shared::json_path::DEFAULT_ID_PATH.to_string();
    };
    let Ok(schema_value) = serde_json::from_slice::<JsonValue>(schema_bytes) else {
        return crate::shared::json_path::DEFAULT_ID_PATH.to_string();
    };
    crate::shared::index::extract_id_path(&schema_value)
        .unwrap_or_else(|| crate::shared::json_path::DEFAULT_ID_PATH.to_string())
}

/// Sentinel prefix written into the PK field of revert-create patches. Server
/// recognizes the prefix in the publish job's create dispatch, parses the
/// trailing `<old_id>`, strips the sentinel before sending to the connector,
/// captures the connector-assigned new id after success, and writes
/// `(folder, prior_remote_id=<old_id>, new_remote_id=<connector id>)` to
/// `RecreatedIdMap`. The map is then consulted at publish time to rewrite FK
/// fields of sibling revert-create records that reference `<old_id>`.
pub const RECREATE_SENTINEL_PREFIX: &str = "scratch_pending_recreate_";

/// Replace the top-level field that owns the PK with the recreate sentinel
/// carrying the prior remote id. For a flat id path (`"id"`) this rewrites the
/// `id` value. For a nested id path (`"id.record_id"`, Attio's id triple) this
/// replaces the entire `id` object with the sentinel string — the triple is
/// server-generated so we can't faithfully preserve its inner shape, and the
/// server's create dispatch handles the sentinel-as-id-object case the same
/// way (parse the trailing old id, strip from outgoing payload).
///
/// Returns the value unchanged if it isn't a JSON object or if the PK field is
/// missing / not a scalar — defensive against malformed pre-publish blobs.
fn replace_pk_with_recreate_sentinel(value: &JsonValue, id_path: &str) -> JsonValue {
    let root = crate::shared::json_path::id_path_root(id_path);
    let JsonValue::Object(map) = value else {
        return value.clone();
    };
    // Use `read_record_id_as_string` which traverses the dot path properly
    // (including nested ids like `id.record_id`) and coerces string|number to
    // a canonical string. Skip the sentinel rewrite if the PK is absent or
    // non-scalar — caller falls through to writing the raw pre-publish blob.
    if !map.contains_key(root) {
        return value.clone();
    }
    let Some(prior_id_str) = crate::shared::json_path::read_record_id_as_string(value, id_path)
    else {
        return value.clone();
    };
    let mut out = map.clone();
    out.insert(
        root.to_string(),
        JsonValue::String(format!("{RECREATE_SENTINEL_PREFIX}{prior_id_str}")),
    );
    JsonValue::Object(out)
}

/// Load the `refs/heads/main` tree as a `FileMap`. Empty map if the ref
/// doesn't exist yet (fresh workspace, never published).
fn read_main_branch_contents(bare_repo: &Path) -> anyhow::Result<FileMap> {
    match git_rev_parse_optional(bare_repo, "refs/heads/main")? {
        Some(hash) => read_git_tree(bare_repo, &hash),
        None => Ok(FileMap::new()),
    }
}

/// Like [`read_main_branch_contents`] but only reads blobs whose path matches `keep`.
/// `ls-tree` still enumerates the whole tree (cheap — metadata only) but
/// `cat-file --batch` only processes the matching subset. Per-path callers
/// (e.g. `files reject <path>`) pass a path-set predicate to avoid loading a
/// 500MB worktree into memory just to touch one record.
fn read_main_branch_contents_filtered_by_path<F>(
    bare_repo: &Path,
    keep: F,
) -> anyhow::Result<FileMap>
where
    F: Fn(&str) -> bool,
{
    match git_rev_parse_optional(bare_repo, "refs/heads/main")? {
        Some(hash) => crate::git_ops::read_tree_files_filtered(bare_repo, &hash, keep),
        None => Ok(FileMap::new()),
    }
}

/// Counterpart of [`read_main_branch_contents_filtered_by_path`] for the
/// worktree side. Reads exactly the requested repo-relative paths from disk
/// and returns them in a [`FileMap`] keyed by `rel_path`. Files that don't
/// exist on disk are silently skipped — the caller's job to interpret an
/// absent key (e.g. "locally deleted").
///
/// Scratch state (`.scratch/*`) is NOT loaded. Callers that need both must
/// either widen this read or use [`read_worktree_files_and_scratch_state`].
fn read_worktree_files_for_record_paths(
    worktree_dir: &Path,
    rel_paths: &[String],
) -> anyhow::Result<FileMap> {
    let mut out = FileMap::new();
    for rel in rel_paths {
        let disk_path = worktree_dir.join(rel);
        match std::fs::read(&disk_path) {
            Ok(bytes) => {
                out.insert(rel.clone(), bytes);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(anyhow::Error::from(err).context(format!(
                    "failed to read working file {}",
                    disk_path.display()
                )));
            }
        }
    }
    Ok(out)
}

/// Candidate repo-relative paths for an `accept-all` / `reject-all` /
/// `discard-all` invocation. The set is the union of:
///
/// - `gix::status` byte-dirty paths (paths whose worktree bytes differ from
///   the git index; since HEAD == main in the dirty branch, these are paths
///   that differ from `refs/heads/main`).
/// - Entries in `accepted-patches.json` (paths where approved differs from
///   main; the user may also have reverted the worktree back to main, which
///   the all-ops need to detect so they can drop the now-stale entry).
///
/// Any path outside this union is at "worktree == main == approved → already
/// at published," with nothing for the all-ops to do. Scoping by folder when
/// `repo_folder` is `Some` shrinks the set further.
///
/// Both inputs matter:
///
/// - A path with a patch entry but no gix-status flag: the user manually
///   reverted to main. accept-all should drop the entry; discard-all should
///   too. Without iterating patch-file paths, this state is missed.
/// - A path with a gix-status flag but no patch entry: a new unreviewed edit.
///   accept-all should fold it in as a new entry; reject-all should restore
///   it. Without iterating gix-status, this is missed.
fn collect_all_ops_candidate_record_paths(
    ctx: &ConnectionContext,
    accepted_file: &crate::shared::accepted_patches::AcceptedPatchesFile,
    repo_folder: Option<&str>,
) -> anyhow::Result<std::collections::HashSet<String>> {
    let scope_filter = |path: &str| match repo_folder {
        Some(folder) => is_data_path_in_folder(path, folder),
        None => is_data_path_in_folder(path, ""),
    };

    let mut candidate_rel_paths: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    let repo = gix::open(&ctx.worktree_dir)
        .with_context(|| format!("failed to open worktree at {}", ctx.worktree_dir.display()))?;
    // Emit untracked files individually. gix defaults to
    // `UntrackedFiles::Collapsed`, which reports a wholly-untracked directory
    // (e.g. a brand-new table folder full of freshly created records) as a
    // single directory entry rather than the individual `.json` files. We
    // enumerate per-record paths below, so a collapsed `widgets/` entry fails
    // the data-path `scope_filter` and every newly created record inside a new
    // folder is silently dropped from the candidate set — leaving accept-all
    // with nothing to do (DEV-10321). `UntrackedFiles::Files` emits each path.
    let platform = repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::Files);
    let iter = platform.into_index_worktree_iter(Vec::<gix::bstr::BString>::new())?;
    for item in iter {
        let item = item?;
        if item.summary().is_none() {
            continue;
        }
        let rel_path: String = String::from_utf8_lossy(item.rela_path()).into_owned();
        if !scope_filter(&rel_path) {
            continue;
        }
        candidate_rel_paths.insert(rel_path);
    }

    for entry in &accepted_file.patches {
        if scope_filter(&entry.path) {
            candidate_rel_paths.insert(entry.path.clone());
        }
    }

    Ok(candidate_rel_paths)
}

/// Load main + approved + worktree maps restricted to a candidate path set.
/// Produces drop-in replacements for the maps the all-ops used to build from
/// full-tree reads, but only the bytes for paths in `candidate_rel_paths` get
/// loaded.
///
/// `accepted_file` is filtered to candidate paths before being overlaid on
/// the narrowed main — without this, an out-of-scope patch (e.g. an
/// `articles/` patch during a `--folder posts` run) would apply against a
/// `None` main blob and synthesize an out-of-scope key in the approved map.
/// That breaks downstream consumers that assume the approved map is bounded
/// to candidates.
fn read_main_approved_worktree_maps_for_candidate_paths(
    ctx: &ConnectionContext,
    accepted_file: &crate::shared::accepted_patches::AcceptedPatchesFile,
    candidate_rel_paths: &std::collections::HashSet<String>,
) -> anyhow::Result<(FileMap, FileMap, FileMap)> {
    let candidate_rel_paths_borrowed: std::collections::HashSet<&str> =
        candidate_rel_paths.iter().map(String::as_str).collect();
    let file_path_to_contents_map_in_main_branch =
        read_main_branch_contents_filtered_by_path(&ctx.bare_repo, |p| {
            candidate_rel_paths_borrowed.contains(p)
        })?;
    let accepted_file_filtered_to_candidate_paths =
        crate::shared::accepted_patches::AcceptedPatchesFile {
            patches: accepted_file
                .patches
                .iter()
                .filter(|patch_entry| {
                    candidate_rel_paths_borrowed.contains(patch_entry.path.as_str())
                })
                .cloned()
                .collect(),
        };
    let file_path_to_contents_map_for_approved_state = compute_accepted_state(
        &file_path_to_contents_map_in_main_branch,
        &accepted_file_filtered_to_candidate_paths,
    )?;
    let candidate_rel_paths_vec: Vec<String> = candidate_rel_paths.iter().cloned().collect();
    let file_path_to_contents_map_in_worktree =
        read_worktree_files_for_record_paths(&ctx.worktree_dir, &candidate_rel_paths_vec)?;
    Ok((
        file_path_to_contents_map_in_main_branch,
        file_path_to_contents_map_for_approved_state,
        file_path_to_contents_map_in_worktree,
    ))
}

/// Per-path equivalent of `compute_accepted_state`: returns the bytes that
/// would appear at `path` in the synthetic approved tree (`main` overlaid with
/// `accepted-patches.json`). `None` means the path is approved-deleted or
/// simply doesn't exist. Caller must have read `file_path_to_contents_map_in_main_branch` with at least
/// `path` included.
fn approved_bytes_for_path(
    file_path_to_contents_map_in_main_branch: &FileMap,
    file: &crate::shared::accepted_patches::AcceptedPatchesFile,
    path: &str,
) -> anyhow::Result<Option<Vec<u8>>> {
    if let Some(entry) = crate::shared::accepted_patches::get_entry(file, path) {
        review_ops::apply_patch_entry_to_blob(
            file_path_to_contents_map_in_main_branch
                .get(path)
                .map(|v| v.as_slice()),
            entry,
        )
    } else {
        Ok(file_path_to_contents_map_in_main_branch.get(path).cloned())
    }
}

/// Build `(file_path_to_contents_map_in_main_branch, file_path_to_contents_map_for_approved_state, file_path_to_contents_map_in_worktree)` scoped to a single folder for
/// the `*-all --folder` commands. `file_path_to_contents_map_in_main_branch` is read via `cat-file --batch`
/// filtered to the folder's blobs only; `file_path_to_contents_map_in_worktree` walks just
/// `<worktree>/<folder>`; `file_path_to_contents_map_for_approved_state` is `file_path_to_contents_map_in_main_branch` overlaid with the
/// in-folder subset of `accepted_file.patches`. Out-of-folder patches in
/// `accepted_file` are intentionally not reflected here — callers that need
/// to mutate the patch file still hold the full `accepted_file` and write
/// it back unchanged outside the folder.
fn read_main_local_and_approved_maps_scoped_to_folder(
    ctx: &ConnectionContext,
    folder: &str,
    accepted_file: &crate::shared::accepted_patches::AcceptedPatchesFile,
) -> anyhow::Result<(FileMap, FileMap, FileMap)> {
    let file_path_to_contents_map_in_main_branch =
        read_main_branch_contents_filtered_by_path(&ctx.bare_repo, |p| {
            is_data_path_in_folder(p, folder)
        })?;
    let mut file_path_to_contents_map_for_approved_state =
        file_path_to_contents_map_in_main_branch.clone();
    for entry in &accepted_file.patches {
        if !is_data_path_in_folder(&entry.path, folder) {
            continue;
        }
        match review_ops::apply_patch_entry_to_blob(
            file_path_to_contents_map_in_main_branch
                .get(entry.path.as_str())
                .map(|v| v.as_slice()),
            entry,
        )? {
            Some(bytes) => {
                file_path_to_contents_map_for_approved_state.insert(entry.path.clone(), bytes);
            }
            None => {
                file_path_to_contents_map_for_approved_state.remove(entry.path.as_str());
            }
        }
    }
    let folder_dir = ctx.worktree_dir.join(folder);
    let mut file_path_to_contents_map_in_worktree = FileMap::new();
    review_ops::load_worktree_into_path_contents_map(
        &ctx.worktree_dir,
        &folder_dir,
        &mut file_path_to_contents_map_in_worktree,
    )?;
    Ok((
        file_path_to_contents_map_in_main_branch,
        file_path_to_contents_map_for_approved_state,
        file_path_to_contents_map_in_worktree,
    ))
}

/// Resolve `<workspace>/.scratch/connections/<conn>` for a context.
///
/// `ctx.workspace_dir` is historically the workbook materialization path
/// (`<workspace>/.scratch/workspace`), not the workspace root, so we derive
/// the root from `ctx.worktree_dir.parent()` (= `<workspace>/<conn>` → parent
/// is `<workspace>`). Callers that need the accepted-patches.json directory
/// (and can't reach the workspace root variable directly) should use this
/// helper.
/// Reconcile `accepted-patches.json` with the server's view of `main` after a
/// successful run-job. Fixes DEV-10175: the prior implementation
/// unconditionally cleared the patch file whenever the run-job reported
/// orchestrator-level success, even though the run-job marks itself
/// "completed" when an underlying connector batch fails (e.g. Airtable 401).
/// Result was that the user's accepted edits were erased locally even though
/// nothing actually landed on `main`.
///
/// Flow:
///   1. Snapshot the pre-fetch `refs/heads/main` (the anchor for the file
///      we hold).
///   2. Fetch origin so `refs/remotes/origin/main` reflects what the server
///      actually committed.
///   3. Re-anchor each patch via [`re_anchor::re_anchor_patches`]:
///        - patches whose intended outcome now matches `new_main` get dropped
///          by [`re_anchor::re_anchor_one`]'s no-op detection (= successful
///          publish);
///        - patches whose connector batch failed survive verbatim (the blob
///          on `new_main` still has the old value, so the patch is still
///          meaningful) and are ready for the next publish attempt.
///   4. Append same-field collisions to `.scratch/conflicts.log`. Possible
///      when an unrelated push advanced `main` between our upload-time apply
///      and the run-job's commit window; user-wins is the policy.
///   5. Save the re-anchored patch file atomically BEFORE advancing the local
///      `main` ref — mirrors [`download_single_repo`]'s crash-recovery
///      ordering (crash between save and ref-advance leaves the file anchored
///      against the new main while the ref still points to the old main; the
///      next pull recomputes and converges).
fn reconcile_accepted_after_publish(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    token: &str,
) -> anyhow::Result<()> {
    let old_main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;
    let new_main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?;

    let file_path_to_contents_map_in_main_branch_before_publish = match old_main_hash.as_deref() {
        Some(h) => read_git_tree(&ctx.bare_repo, h)?,
        None => FileMap::new(),
    };
    let file_path_to_contents_map_in_main_branch_after_publish = match new_main_hash.as_deref() {
        Some(h) => read_git_tree(&ctx.bare_repo, h)?,
        None => FileMap::new(),
    };

    let connection_dir = accepted_patches_dir(ctx);
    let accepted = crate::shared::accepted_patches::load(&connection_dir)?;

    let re_anchored = crate::shared::re_anchor::re_anchor_patches(
        &accepted.patches,
        |path| {
            parse_json_value_at(
                &file_path_to_contents_map_in_main_branch_before_publish,
                path,
                "refs/heads/main (pre-publish)",
            )
        },
        |path| {
            parse_json_value_at(
                &file_path_to_contents_map_in_main_branch_after_publish,
                path,
                "refs/remotes/origin/main (post-publish)",
            )
        },
    )?;

    for conflict in &re_anchored.conflicts {
        let entry = crate::config::conflicts_log::ConflictEntry {
            ts: crate::config::conflicts_log::now_rfc3339(),
            connector_account_id: ctx.connection_id.clone(),
            path: conflict.path.clone(),
            conflicting_keys: conflict.conflicting_keys.clone(),
        };
        if let Err(err) = crate::config::conflicts_log::append(workspace_dir, &entry) {
            eprintln!(
                "Warning: failed to append conflict for {} to conflicts.log: {err}",
                conflict.path
            );
        }
    }

    let new_accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: re_anchored.patches,
    };

    // Snap the worktree to the post-publish canonical state: successfully
    // published paths get `new_main` bytes; failed-publish paths get
    // `apply(new_main, surviving_patch)`. Mirrors the same materialize step
    // `download_single_repo` runs after re-anchor — without it, the CLI
    // publish flow leaves the worktree byte-different from `main` (no
    // subsequent `files download` re-canonicalizes because main has already
    // advanced and the "up to date" short-circuit fires). Only meaningful
    // when there is actually a worktree on disk; tests that exercise
    // reconcile against a bare-only fixture skip this branch.
    if ctx.worktree_dir.join(".git").exists() {
        let file_path_to_contents_map_for_approved_state_after_publish = compute_accepted_state(
            &file_path_to_contents_map_in_main_branch_after_publish,
            &new_accepted,
        )?;
        let file_path_to_contents_map_in_worktree = read_worktree_files_and_scratch_state(ctx)?;
        materialize_local_repo(
            ctx,
            &file_path_to_contents_map_for_approved_state_after_publish,
            &file_path_to_contents_map_in_worktree,
        )?;
    }

    crate::shared::accepted_patches::save_atomic(&connection_dir, &new_accepted)?;

    if let Some(hash) = new_main_hash.as_deref() {
        git_update_ref(&ctx.bare_repo, "refs/heads/main", hash)?;
        // Advancing the ref leaves the gix index pointing at the old main, so
        // list_unreviewed_entries_using_gix_status_then_disambiguate_against_main would see modifications until we reset it.
        // The mixed reset is harmless when materialize has already aligned
        // the worktree (the next index/worktree diff is empty) and necessary
        // when there were no path-level changes for materialize to make.
        if ctx.worktree_dir.join(".git").exists() {
            crate::git_ops::worktree_reset_mixed(&ctx.worktree_dir, hash)?;
        }
    }

    Ok(())
}

/// Pull the latest server state for one connection.
///
/// Pre-fetch invariant: the caller has already verified the connection has no
/// unreviewed working-tree edits (see [`run_download`]'s pre-flight pass).
/// Without that, replaying the new `main` blobs would silently overwrite
/// in-flight user typing.
///
/// Flow:
///   1. Read the pre-fetch `refs/heads/main` tree + `accepted-patches.json`
///      (the user's accepted-pending-publish edits, anchored against old main).
///   2. Fetch origin and resolve the new `main` hash. No-op if unchanged.
///   3. Re-anchor each accepted patch from (old_main_blob → new_main_blob) via
///      `re_anchor::re_anchor_patches`. Same-field collisions log to
///      `.scratch/conflicts.log` (user wins).
///   4. Compute the new approved map = `apply(new_main, re_anchored_patches)`
///      and materialize it to the worktree, replacing the three-way merge.
///   5. Persist the re-anchored patch file BEFORE advancing the local ref so
///      a mid-flight crash leaves us anchored against the still-current old
///      main and the next run converges (idempotent).
fn download_single_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    token: &str,
    data_folders: &[DataFolder],
) -> anyhow::Result<DownloadResult> {
    // Fetch first, then short-circuit if `main` didn't move. Connections that
    // haven't advanced server-side pay only the (incremental, ~50ms) fetch —
    // not the multi-second `read_main_branch_contents` + `read_worktree_files_and_scratch_state` tree
    // walks that the re-anchor path needs. In the common "1 of N connections
    // moved" case this is the difference between O(N × worktree) and
    // O(N × fetch + 1 × worktree).
    crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;

    let Some(new_main_hash) = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
    else {
        // Fresh repo with nothing published yet — nothing to pull.
        return Ok(DownloadResult {
            status: "up_to_date".to_string(),
            ..Default::default()
        });
    };
    let old_main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    if old_main_hash.as_deref() == Some(new_main_hash.as_str()) {
        return Ok(DownloadResult {
            status: "up_to_date".to_string(),
            ..Default::default()
        });
    }

    // Past the short-circuit: this connection's `main` actually moved. Load
    // the accepted patches + read both trees + the materialized worktree.
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    let file_path_to_contents_map_in_main_branch_before_publish =
        read_main_branch_contents(&ctx.bare_repo)?;
    let file_path_to_contents_map_in_worktree = read_worktree_files_and_scratch_state(ctx)?;

    let file_path_to_contents_map_in_main_branch_after_publish =
        read_git_tree(&ctx.bare_repo, &new_main_hash)?;

    // Re-anchor preserves the user's RFC 7396 patch verbatim wherever
    // possible; only file-lifecycle changes (server deleted what user
    // updated, etc.) rewrite the entry shape. See decisions in
    // `re_anchor.rs`.
    let re_anchored = crate::shared::re_anchor::re_anchor_patches(
        &accepted_file.patches,
        |path| {
            parse_json_value_at(
                &file_path_to_contents_map_in_main_branch_before_publish,
                path,
                "refs/heads/main (pre-fetch)",
            )
        },
        |path| {
            parse_json_value_at(
                &file_path_to_contents_map_in_main_branch_after_publish,
                path,
                "refs/remotes/origin/main (post-fetch)",
            )
        },
    )?;

    // User-wins is the policy, so the patches are unchanged; the log
    // captures what we silently overrode. Append failures are non-fatal —
    // we'd rather complete the pull than refuse on log I/O.
    for conflict in &re_anchored.conflicts {
        let entry = crate::config::conflicts_log::ConflictEntry {
            ts: crate::config::conflicts_log::now_rfc3339(),
            connector_account_id: ctx.connection_id.clone(),
            path: conflict.path.clone(),
            conflicting_keys: conflict.conflicting_keys.clone(),
        };
        if let Err(err) = crate::config::conflicts_log::append(workspace_dir, &entry) {
            eprintln!(
                "Warning: failed to append conflict for {} to conflicts.log: {err}",
                conflict.path
            );
        }
    }

    let new_accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: re_anchored.patches,
    };
    let file_path_to_contents_map_for_approved_state_after_publish = compute_accepted_state(
        &file_path_to_contents_map_in_main_branch_after_publish,
        &new_accepted,
    )?;

    // file_path_to_contents_map_in_worktree is the snapshot we read above; pass it so materialize can
    // skip rewriting files whose content didn't move (preserves mtimes so
    // find_stale_files doesn't see every file as stale next page load).
    materialize_local_repo(
        ctx,
        &file_path_to_contents_map_for_approved_state_after_publish,
        &file_path_to_contents_map_in_worktree,
    )?;
    reconcile_data_folder_dirs(&ctx.worktree_dir, data_folders)?;

    // Save BEFORE advancing main: a crash between these two steps leaves
    // us with the file still anchored against old main, so the next pull
    // recomputes and converges. Inverse order would orphan the file against
    // a stale anchor.
    crate::shared::accepted_patches::save_atomic(&connection_dir, &new_accepted)?;
    git_update_ref(&ctx.bare_repo, "refs/heads/main", &new_main_hash)?;

    // Summary counts come from the actual file_path_to_contents_map_in_worktree → file_path_to_contents_map_for_approved_state_after_publish
    // delta, so they match exactly what changed on disk for the user.
    let changed_paths = file_map_changed_data_paths(
        &file_path_to_contents_map_in_worktree,
        &file_path_to_contents_map_for_approved_state_after_publish,
    );
    let mut result = DownloadResult {
        status: "downloaded".to_string(),
        conflicts_auto_resolved: re_anchored.conflicts.len() as i32,
        changed_paths,
        ..Default::default()
    };
    for path in &result.changed_paths {
        let was_present = file_path_to_contents_map_in_worktree.contains_key(path.as_str());
        let now_present =
            file_path_to_contents_map_for_approved_state_after_publish.contains_key(path.as_str());
        match (was_present, now_present) {
            (false, true) => result.files_created += 1,
            (true, true) => result.files_updated += 1,
            (true, false) => result.files_deleted += 1,
            (false, false) => {}
        }
    }

    Ok(result)
}

/// Upload the connection's accepted edits to the server. Reads
/// `accepted-patches.json` (which IS the wire format), PUTs it to a presigned
/// GCS URL, then POSTs `/upload-patch/commit` so the server applies the
/// patches to its dirty branch as a single commit. No publish is triggered —
/// the caller runs `scratchmd files publish` separately.
///
/// Skips entirely (no network, no tree walks) when there's nothing to upload.
/// `baseHead` is the local `refs/heads/main` SHA: the snapshot the accepted
/// patches were anchored against. The server uses it for the staleness
/// signal (returned in `stalenessWarning`).
async fn upload_single_repo_via_patches(
    ctx: &ConnectionContext,
    client: &crate::api::ApiClient,
    workbook_id: &str,
    verbose: bool,
) -> anyhow::Result<UploadResult> {
    // Cheap read first — skip the rest if nothing to upload.
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    if accepted_file.patches.is_empty() {
        return Ok(UploadResult {
            connection_name: ctx.conn_dir_name.clone(),
            status: "no_changes".to_string(),
            ..Default::default()
        });
    }

    // baseHead = the local snapshot the user's accepted patches were anchored
    // against. Server compares it against its own `main` to populate
    // `stalenessWarning`. Pre-cleanup we ran `fetch_origin` here first; that
    // made baseHead equal the server's main by construction, so the staleness
    // check could never fire. Dropped.
    let main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;

    use crate::shared::re_anchor::PatchKind as AnchoredKind;
    let files_created = accepted_file
        .patches
        .iter()
        .filter(|p| p.kind == AnchoredKind::Create)
        .count() as i32;
    let files_updated = accepted_file
        .patches
        .iter()
        .filter(|p| p.kind == AnchoredKind::Update)
        .count() as i32;
    let files_deleted = accepted_file
        .patches
        .iter()
        .filter(|p| p.kind == AnchoredKind::Delete)
        .count() as i32;
    let created_paths: Vec<String> = accepted_file
        .patches
        .iter()
        .filter(|p| p.kind == AnchoredKind::Create)
        .map(|p| format!("{}/{}", ctx.conn_dir_name, p.path))
        .collect();
    let updated_paths: Vec<String> = accepted_file
        .patches
        .iter()
        .filter(|p| p.kind == AnchoredKind::Update)
        .map(|p| format!("{}/{}", ctx.conn_dir_name, p.path))
        .collect();
    let deleted_paths: Vec<String> = accepted_file
        .patches
        .iter()
        .filter(|p| p.kind == AnchoredKind::Delete)
        .map(|p| format!("{}/{}", ctx.conn_dir_name, p.path))
        .collect();
    let changed_paths: Vec<String> = accepted_file
        .patches
        .iter()
        .map(|p| p.path.clone())
        .collect();

    // `accepted-patches.json` IS the wire format. Ship it verbatim, carrying the
    // explicit `kind` (so the server's delete signal is `kind == delete`, not a
    // magic null), the format `version` (so the server can track dialect
    // prevalence during rollout), and the per-entry `revert` flag so the server
    // can persist it to `UploadPatchMeta` and the plan-build pass4 step can route
    // FK fields through the BACKFILL phase for revert-creates.
    let payload = crate::api::UploadPatchPayload {
        version: crate::shared::accepted_patches::FORMAT_VERSION,
        patches: accepted_file
            .patches
            .iter()
            .map(|p| crate::api::UploadPatchEntry {
                path: p.path.clone(),
                kind: p.kind,
                patch: p.patch.clone(),
                revert: p.revert,
            })
            .collect(),
    };

    if verbose {
        eprint!("  Uploading...");
    }
    let init = client
        .upload_patch_init(workbook_id, &ctx.connection_id)
        .await
        .map_err(|e| anyhow::anyhow!("upload-patch init failed: {e}"))?;
    client
        .upload_patch_put(&init.presigned_url, &payload)
        .await
        .map_err(|e| anyhow::anyhow!("upload-patch PUT failed: {e}"))?;
    // Apply pass. `refuse_if_stale: true` (D8): the server compares `baseHead`
    // against its current `refs/heads/main` and aborts with HTTP 409 +
    // structured `blocked_stale` body if they diverge. `refuse_if_dirty: true`
    // (DEV-10316) is retained on the apply pass too — pass 1 already probed
    // every connection's dirty gate, but a sub-second sync write between the
    // probe and this apply can re-create a non-clean staging area, so we
    // re-check here rather than apply onto it. The CLI surfaces each refusal
    // as a typed UploadResult that `run_upload` bails on.
    let commit = client
        .upload_patch_commit(
            workbook_id,
            &ctx.connection_id,
            &init.upload_id,
            main_hash.as_deref(),
            true,  // refuse_if_stale
            true,  // refuse_if_dirty
            false, // check_only (this is the real apply)
        )
        .await
        .map_err(|e| anyhow::anyhow!("upload-patch commit failed: {e}"))?;

    let applied = match commit {
        crate::api::UploadPatchCommitResult::Applied(applied) => applied,
        crate::api::UploadPatchCommitResult::BlockedStale(stale) => {
            if verbose {
                eprintln!(" stale");
            }
            return Ok(UploadResult {
                connection_name: ctx.conn_dir_name.clone(),
                status: "blocked_stale".to_string(),
                blocked_stale: Some(stale),
                ..Default::default()
            });
        }
        crate::api::UploadPatchCommitResult::BlockedDirty(dirty) => {
            if verbose {
                eprintln!(" dirty");
            }
            return Ok(UploadResult {
                connection_name: ctx.conn_dir_name.clone(),
                status: "blocked_dirty".to_string(),
                blocked_dirty: Some(dirty),
                ..Default::default()
            });
        }
        crate::api::UploadPatchCommitResult::CheckFailed(failed) => {
            if verbose {
                eprintln!(" check-failed");
            }
            return Ok(UploadResult {
                connection_name: ctx.conn_dir_name.clone(),
                status: "check_failed".to_string(),
                check_failed: Some(failed),
                ..Default::default()
            });
        }
    };
    if verbose {
        eprintln!(" done");
    }

    // Surface a warning if the user has on-disk edits that haven't been
    // accepted yet — those don't ride along with this upload. Uses the
    // gix::status-backed fast path (~210ms warm) so the courtesy check
    // doesn't dominate the upload time.
    let mut messages = Vec::new();
    let local_unreviewed =
        list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(ctx, false)?;
    if !local_unreviewed.is_empty() {
        messages.push(format!(
            "{} record(s) have unreviewed local changes and were not uploaded. Run `scratchmd files accept-all` first.",
            local_unreviewed.len()
        ));
    }
    // `applied.staleness_warning` only arrives when `refuse_if_stale: false`,
    // so on the strict-mode path (D8) it stays None and we leave the message
    // list alone. Kept for forward-compat if a future caller flips the flag
    // back off.
    if let Some(staleness) = &applied.staleness_warning {
        messages.push(format!(
            "The server has more recent changes ({}) than what's on your computer. Patches were still applied; run `scratchmd files download` to refresh.",
            short_sha(&staleness.new_head),
        ));
    }

    // Poll the apply-patches job to completion. The job's "done" state means
    // the server's `dirty` branch has the new commit; the publish pipeline is
    // NOT triggered by this endpoint anymore — the caller must run
    // `scratchmd files publish` afterwards. DEV-10316: capture the post-apply
    // dirty HEAD off the completed job so the desktop can use it as the
    // publish-time TOCTOU token (`expectedBaseDirtyHead`).
    let mut dirty_head: Option<String> = None;
    if let Some(job_id) = applied.job_id.as_deref() {
        if verbose {
            eprint!("  Applying...");
        }
        let final_progress = crate::api::poll_job(client, job_id)
            .await
            .map_err(|e| anyhow::anyhow!("apply-patches job failed: {e}"))?;
        dirty_head = final_progress.public_progress.and_then(|p| p.dirty_head);
        if verbose {
            eprintln!(" done");
        }
    }

    Ok(UploadResult {
        connection_name: ctx.conn_dir_name.clone(),
        status: "uploaded".to_string(),
        files_created,
        files_updated,
        files_deleted,
        created_paths,
        updated_paths,
        deleted_paths,
        changed_paths,
        messages,
        staleness_warning: applied.staleness_warning,
        dirty_head,
        ..Default::default()
    })
}

fn short_sha(sha: &str) -> &str {
    sha.get(..7.min(sha.len())).unwrap_or(sha)
}

/// `scratchmd files discard-all [<folder>]`.
///
/// "Discard" rolls every in-scope path all the way back to published — drops
/// any accepted-patches entry AND writes the worktree from `refs/heads/main`.
/// In-scope paths are the union of (a) paths with an `accepted-patches.json`
/// entry and (b) paths whose working file differs from approved (unreviewed
/// edits).
///
/// Pre-B this routine had a `_scoped_via_index` fast path that queried
/// `folder_index` for files-with-changes; that's gone for now (sub-slice B
/// decision). The full-scan path runs hundreds of ms warm on the Stripe
/// connector — well below user-perceptible. Slice E reintroduces an
/// index-aware path once `folder_index`'s `approvedChanges` /
/// `unapprovedChanges` columns are populated from `accepted-patches.json`.
fn discard_all_unreviewed_changes_in_connection_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<DiscardAllResult> {
    let _ = workspace_dir; // retained for caller-site parity with accept_all/reject_all.
    sync_schema_files_from_worktree(ctx)?;
    if git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?.is_none() {
        return Ok(DiscardAllResult {
            skipped_missing_main: true,
            ..Default::default()
        });
    }

    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;

    // Candidate path set = gix::status (byte-dirty) ∪ accepted-patches.json
    // entries, scoped to `repo_folder` when set. Pre-§5.1 this routine read
    // the entire main tree + worktree to discover candidates; the candidate
    // set is bounded by the size of the unreviewed working set, not by
    // workspace size.
    let candidate_rel_paths =
        collect_all_ops_candidate_record_paths(ctx, &accepted_file, repo_folder)?;
    if candidate_rel_paths.is_empty() {
        return Ok(DiscardAllResult::default());
    }
    let (
        file_path_to_contents_map_in_main_branch,
        file_path_to_contents_map_for_approved_state,
        file_path_to_contents_map_in_worktree,
    ) = read_main_approved_worktree_maps_for_candidate_paths(
        ctx,
        &accepted_file,
        &candidate_rel_paths,
    )?;

    let unreviewed = compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &file_path_to_contents_map_for_approved_state,
        &file_path_to_contents_map_in_worktree,
    );

    // Union of (paths with patch entries) and (paths with unreviewed working
    // edits). Either makes the path "non-published" and therefore in scope for
    // discard-back-to-main. The candidate set is the bounding superset; we
    // still filter by patch-entry / unreviewed status to drop gix-flagged
    // paths whose worktree turns out to be JSON-equivalent to approved.
    let mut affected_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in &accepted_file.patches {
        if candidate_rel_paths.contains(&entry.path) {
            affected_paths.insert(entry.path.clone());
        }
    }
    for entry in &unreviewed {
        affected_paths.insert(entry.path.clone());
    }

    if affected_paths.is_empty() {
        return Ok(DiscardAllResult::default());
    }

    let mut patches_changed = false;
    for path in &affected_paths {
        if crate::shared::accepted_patches::get_entry(&accepted_file, path).is_some() {
            crate::shared::accepted_patches::remove_entry(&mut accepted_file, path);
            patches_changed = true;
        }
        write_or_remove_working_file(
            ctx,
            path,
            file_path_to_contents_map_in_main_branch
                .get(path.as_str())
                .map(|v| v.as_slice()),
        )?;
    }

    if patches_changed {
        crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    }

    Ok(DiscardAllResult {
        files_discarded: affected_paths.len() as i32,
        discarded_paths: affected_paths.into_iter().collect(),
        skipped_missing_main: false,
    })
}

/// Discard a specific set of repo-relative paths. For each path, drop any
/// accepted-patches entry AND restore the working file to its
/// `refs/heads/main` content. Paths that are at published state with no
/// accepted entry and no unreviewed working edit cause an error.
fn discard_record_paths_in_connection_repo(
    ctx: &ConnectionContext,
    rel_paths: &[String],
    input_by_rel: &HashMap<&str, &str>,
) -> anyhow::Result<DiscardAllResult> {
    let main_hash_opt = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    if main_hash_opt.is_none() {
        return Ok(DiscardAllResult {
            skipped_missing_main: true,
            ..Default::default()
        });
    }
    // Narrow main + worktree reads to just `rel_paths`. The downstream check
    // ("is this path actually a discard target?") only inspects the requested
    // paths, so a narrowed map produces identical results.
    let requested_rel_paths_set: std::collections::HashSet<&str> =
        rel_paths.iter().map(String::as_str).collect();
    let file_path_to_contents_map_in_main_branch =
        read_main_branch_contents_filtered_by_path(&ctx.bare_repo, |p| {
            requested_rel_paths_set.contains(p)
        })?;

    sync_schema_files_from_worktree(ctx)?;
    let file_path_to_contents_map_in_worktree =
        read_worktree_files_for_record_paths(&ctx.worktree_dir, rel_paths)?;

    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    let file_path_to_contents_map_for_approved_state =
        compute_accepted_state(&file_path_to_contents_map_in_main_branch, &accepted_file)?;

    // A path is "discardable" if it has a patch entry (approved differs
    // from published) or an unreviewed edit (working differs from
    // approved). The discard target is the same either way: reset to
    // published.
    let entry_paths: std::collections::HashSet<String> = accepted_file
        .patches
        .iter()
        .map(|e| e.path.clone())
        .collect();
    let unreviewed = compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &file_path_to_contents_map_for_approved_state,
        &file_path_to_contents_map_in_worktree,
    );
    let unreviewed_paths: std::collections::HashSet<&str> =
        unreviewed.iter().map(|e| e.path.as_str()).collect();

    let mut targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for rel in rel_paths {
        let has_change = entry_paths.contains(rel) || unreviewed_paths.contains(rel.as_str());
        if !has_change {
            let input = input_by_rel
                .get(rel.as_str())
                .copied()
                .unwrap_or(rel.as_str());
            anyhow::bail!("No local changes to discard for '{}'.", input);
        }
        targets.insert(rel.clone());
    }

    for rel in &targets {
        crate::shared::accepted_patches::remove_entry(&mut accepted_file, rel);
        write_or_remove_working_file(
            ctx,
            rel,
            file_path_to_contents_map_in_main_branch
                .get(rel.as_str())
                .map(|v| v.as_slice()),
        )?;
    }

    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;

    Ok(DiscardAllResult {
        files_discarded: targets.len() as i32,
        discarded_paths: targets.into_iter().collect(),
        skipped_missing_main: false,
    })
}

/// `scratchmd files accept-all [<folder>]`.
///
/// "Accept" promotes every unreviewed working-tree edit in scope into an
/// `accepted-patches.json` entry. The working tree is untouched; the patch
/// file is mutated. Each path's new entry is computed via
/// `re_anchor::compute_entry(main, working)` so the Create/Update/Delete
/// shape decision matches what single-path accept and accept-field produce.
///
/// Pre-B's `_scoped_via_index` fast path is gone (sub-slice B decision); the
/// full-scan version is the only path. See sub-slice E for the index-aware
/// reintroduction once `folder_index`'s columns repopulate from
/// `accepted-patches.json`.
fn accept_all_unreviewed_changes_in_connection_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<AcceptAllResult> {
    let _ = workspace_dir;
    sync_schema_files_from_worktree(ctx)?;
    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;

    // Candidate path set = gix::status ∪ accepted-patches.json entries,
    // scoped to `repo_folder` when set. See
    // `collect_all_ops_candidate_record_paths` for the reasoning. Out-of-set
    // paths are already at "worktree == main == approved" → nothing for
    // accept-all to do. Out-of-folder patch entries are left untouched in
    // the saved file at the end (only candidate entries get upserted/removed
    // below).
    let candidate_rel_paths =
        collect_all_ops_candidate_record_paths(ctx, &accepted_file, repo_folder)?;
    if candidate_rel_paths.is_empty() {
        return Ok(AcceptAllResult::default());
    }
    let (
        file_path_to_contents_map_in_main_branch,
        file_path_to_contents_map_for_approved_state,
        file_path_to_contents_map_in_worktree,
    ) = read_main_approved_worktree_maps_for_candidate_paths(
        ctx,
        &accepted_file,
        &candidate_rel_paths,
    )?;

    let changes = compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &file_path_to_contents_map_for_approved_state,
        &file_path_to_contents_map_in_worktree,
    );

    if changes.is_empty() {
        return Ok(AcceptAllResult::default());
    }

    for entry in &changes {
        let snapshot = parse_json_value_at(
            &file_path_to_contents_map_in_main_branch,
            &entry.path,
            "refs/heads/main",
        )?;
        let working = parse_json_value_at(
            &file_path_to_contents_map_in_worktree,
            &entry.path,
            "working tree",
        )?;
        match crate::shared::re_anchor::compute_entry(
            &entry.path,
            snapshot.as_ref(),
            working.as_ref(),
        ) {
            Some(new_entry) => {
                crate::shared::accepted_patches::upsert_entry(&mut accepted_file, new_entry);
            }
            None => {
                // No-op accept (working == main with no patch needed). Drop any
                // stale entry so the file ends up genuinely at published.
                crate::shared::accepted_patches::remove_entry(&mut accepted_file, &entry.path);
            }
        }
    }

    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;

    Ok(AcceptAllResult {
        files_accepted: changes.len() as i32,
        accepted_paths: changes.into_iter().map(|entry| entry.path).collect(),
    })
}

/// `scratchmd files reject-all [<folder>]`.
///
/// "Reject" undoes every unreviewed working-tree edit in scope by writing the
/// worktree back to the approved state. The accepted-patches file is **not**
/// touched (decision 35). No-op once a file is already approved — discard-all
/// is the operation that rolls approved back to published.
fn reject_all_unreviewed_changes_in_connection_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<RejectAllResult> {
    let _ = workspace_dir;
    sync_schema_files_from_worktree(ctx)?;
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;

    // Candidate path set = gix::status ∪ accepted-patches.json entries; see
    // `collect_all_ops_candidate_record_paths`. reject-all only writes the
    // worktree back to approved for paths where worktree != approved, so it
    // genuinely only needs paths in this set.
    let candidate_rel_paths =
        collect_all_ops_candidate_record_paths(ctx, &accepted_file, repo_folder)?;
    if candidate_rel_paths.is_empty() {
        return Ok(RejectAllResult::default());
    }
    let (
        _file_path_to_contents_map_in_main_branch,
        file_path_to_contents_map_for_approved_state,
        file_path_to_contents_map_in_worktree,
    ) = read_main_approved_worktree_maps_for_candidate_paths(
        ctx,
        &accepted_file,
        &candidate_rel_paths,
    )?;

    let changes = compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &file_path_to_contents_map_for_approved_state,
        &file_path_to_contents_map_in_worktree,
    );

    if changes.is_empty() {
        return Ok(RejectAllResult::default());
    }

    for entry in &changes {
        write_or_remove_working_file(
            ctx,
            &entry.path,
            file_path_to_contents_map_for_approved_state
                .get(entry.path.as_str())
                .map(|v| v.as_slice()),
        )?;
    }

    Ok(RejectAllResult {
        files_rejected: changes.len() as i32,
        rejected_paths: changes.into_iter().map(|entry| entry.path).collect(),
    })
}

/// Files with an entry in `accepted-patches.json` — i.e. approved but not
/// yet published. One RecordChangeEntry per patch entry; status comes from the
/// patch kind.
fn list_unpublished_accepted_patch_entries(
    ctx: &ConnectionContext,
) -> anyhow::Result<Vec<RecordChangeEntry>> {
    use crate::shared::re_anchor::PatchKind;
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::shared::accepted_patches::load(&connection_dir)?;
    Ok(accepted_file
        .patches
        .iter()
        .map(|entry| RecordChangeEntry {
            connection_name: ctx.conn_dir_name.clone(),
            path: entry.path.clone(),
            status: match entry.kind {
                PatchKind::Create => "added",
                PatchKind::Update => "modified",
                PatchKind::Delete => "deleted",
            }
            .to_string(),
        })
        .collect())
}

#[cfg(test)]
fn git_rev_parse(bare_repo: &Path, rev: &str) -> anyhow::Result<String> {
    crate::git_ops::rev_parse_to_string(bare_repo, rev)
}

fn git_rev_parse_optional(bare_repo: &Path, rev: &str) -> anyhow::Result<Option<String>> {
    crate::git_ops::rev_parse_optional_to_string(bare_repo, rev)
}

fn git_update_ref(bare_repo: &Path, refname: &str, object: &str) -> anyhow::Result<()> {
    crate::git_ops::update_ref(bare_repo, refname, object)
}

fn read_git_tree(bare_repo: &Path, hash: &str) -> anyhow::Result<FileMap> {
    crate::git_ops::read_tree_files(bare_repo, hash)
}

/// Reconcile the on-disk state of `ctx.worktree_dir` (user working tree) and
/// `ctx.scratch_dir` (per-connection schema/validation/publish-plan files)
/// with `target_map`.
///
/// **Diff-aware.** Files whose content matches `current_map` are left alone
/// — their mtime is preserved. Only paths whose content differs are
/// rewritten; only paths present in `current_map` but missing from
/// `target_map` are deleted. Anything outside `current_map` (hidden files,
/// the `syncs/` subdir, anything `load_worktree_into_path_contents_map` / `load_connection_scratch_into_path_contents_map`
/// chose to skip) is untouched.
///
/// Why this matters: `folder_index::find_stale_files` flags a file as
/// stale whenever its working-tree mtime drifts from the stored value.
/// A wholesale clear-and-rewrite (the previous behavior) bumped every
/// file's mtime on every download, defeating the per-path index updates
/// downstream.
///
/// `current_map` is the snapshot the caller already obtained from
/// `read_worktree_files_and_scratch_state`. Passing it in avoids re-walking the
/// filesystem here.
fn materialize_local_repo(
    ctx: &ConnectionContext,
    target_map: &FileMap,
    current_map: &FileMap,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(&ctx.worktree_dir)?;
    std::fs::create_dir_all(&ctx.scratch_dir)?;

    // Resolve a rel_path into its on-disk path under either `worktree_dir` or
    // `scratch_dir`. Returns `None` for `.scratch` (bare, no trailing slash)
    // and similar oddities — those don't materialize to a real file.
    let resolve_disk_path = |rel_path: &str| -> Option<PathBuf> {
        if let Some(scratch_rel) = rel_path.strip_prefix(".scratch/") {
            Some(ctx.scratch_dir.join(scratch_rel))
        } else if !rel_path.starts_with(".scratch") {
            Some(ctx.worktree_dir.join(rel_path))
        } else {
            None
        }
    };

    // Write any entry whose bytes differ from what's currently on disk. New
    // entries (not in current_map) fall through to the catch-all `_` arm and
    // get written. Files whose content matches keep their mtime.
    for (rel_path, target_content) in target_map {
        let Some(disk_path) = resolve_disk_path(rel_path) else {
            continue;
        };
        match current_map.get(rel_path) {
            Some(current_content) if current_content == target_content => continue,
            _ => write_file(&disk_path, target_content)?,
        }
    }

    // Delete files that were on disk before but aren't in target_map any more.
    // Empty parent dirs are pruned later by `reconcile_data_folder_dirs`.
    for rel_path in current_map.keys() {
        if target_map.contains_key(rel_path) {
            continue;
        }
        let Some(disk_path) = resolve_disk_path(rel_path) else {
            continue;
        };
        if disk_path.exists() {
            std::fs::remove_file(&disk_path)?;
        }
    }

    Ok(())
}

/// Reconcile on-disk folders under `worktree_dir` with the server's folder list.
///
/// 1. Creates a directory for every folder path (parents included).
/// 2. Prunes any local directory not in the server set, but only if empty —
///    non-empty dirs are owned by the record-file merge path.
pub fn reconcile_data_folder_dirs(
    worktree_dir: &Path,
    data_folders: &[DataFolder],
) -> anyhow::Result<()> {
    if !worktree_dir.exists() {
        return Ok(());
    }

    let mut wanted: HashSet<PathBuf> = HashSet::new();
    for df in data_folders {
        let Some(path) = df.path.as_deref() else {
            continue;
        };
        let trimmed = path.trim_start_matches('/');
        if trimmed.is_empty() {
            continue;
        }
        let target = worktree_dir.join(trimmed);
        std::fs::create_dir_all(&target)
            .with_context(|| format!("create empty data folder dir {}", target.display()))?;
        // Mark every ancestor up to worktree_dir as wanted so the pruner leaves
        // the chain of intermediate folders alone, even when they are not
        // themselves separate DataFolder entries.
        for ancestor in target.ancestors() {
            if ancestor == worktree_dir {
                break;
            }
            wanted.insert(ancestor.to_path_buf());
        }
    }

    prune_empty_unknown_dirs(worktree_dir, &wanted)?;
    Ok(())
}

fn prune_empty_unknown_dirs(dir: &Path, wanted: &HashSet<PathBuf>) -> anyhow::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = entry.with_context(|| format!("read entry in {}", dir.display()))?;
        let path = entry.path();
        let ft = entry.file_type()?;
        if !ft.is_dir() {
            continue;
        }
        // Skip CLI-owned entries like .scratch / .scratchmd.
        if entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.starts_with('.'))
        {
            continue;
        }
        prune_empty_unknown_dirs(&path, wanted)?;
        if wanted.contains(&path) {
            continue;
        }
        let is_empty = std::fs::read_dir(&path)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        if is_empty {
            std::fs::remove_dir(&path)
                .with_context(|| format!("remove empty dir {}", path.display()))?;
        }
    }
    Ok(())
}

fn is_scratch_path(path: &str) -> bool {
    path.starts_with(".scratch/")
}

fn data_only_map(map: &FileMap) -> FileMap {
    map.iter()
        .filter(|(path, _)| !is_scratch_path(path))
        .map(|(path, value)| (path.clone(), value.clone()))
        .collect()
}

/// Compare two optional byte slices that may be JSON records. Returns `true`
/// if they semantically differ — i.e. presence diff, or both parseable and
/// `serde_json::Value` inequality. Falls back to byte equality when either
/// side fails to parse, so unparseable garbage still surfaces as a change.
///
/// Used by the scoped accept-all / discard-all fast paths to cross-check
/// folder-index candidates against the in-memory git tree. Keeping this
/// semantic mirrors `reindex_files`'s bit computation, which means a
/// whitespace- or key-order-only edit that the user has since reverted
/// won't be treated as a real change here either.
fn json_content_differs(a: Option<&[u8]>, b: Option<&[u8]>) -> bool {
    match (a, b) {
        (None, None) => false,
        (None, Some(_)) | (Some(_), None) => true,
        (Some(a), Some(b)) => match (
            serde_json::from_slice::<JsonValue>(a),
            serde_json::from_slice::<JsonValue>(b),
        ) {
            (Ok(va), Ok(vb)) => va != vb,
            _ => a != b,
        },
    }
}

fn compute_unreviewed_entries(
    connection_name: &str,
    base_map: &FileMap,
    file_path_to_contents_map_in_worktree: &FileMap,
) -> Vec<RecordChangeEntry> {
    let base_data = data_only_map(base_map);
    let local_data = data_only_map(file_path_to_contents_map_in_worktree);
    let mut all_paths: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();

    for key in base_data.keys() {
        all_paths.insert(key);
    }
    for key in local_data.keys() {
        all_paths.insert(key);
    }

    let mut entries = Vec::new();
    for path in all_paths {
        let base = base_data.get(path);
        let local = local_data.get(path);
        match (base, local) {
            (None, Some(_)) => entries.push(RecordChangeEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "added".to_string(),
            }),
            (Some(_), None) => entries.push(RecordChangeEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "deleted".to_string(),
            }),
            // JSON-compare so whitespace/key-order drift between the
            // synthesized approved state and the worktree's actual file
            // bytes doesn't show up as a spurious modification.
            (Some(base), Some(local))
                if json_content_differs(Some(base.as_slice()), Some(local.as_slice())) =>
            {
                entries.push(RecordChangeEntry {
                    connection_name: connection_name.to_string(),
                    path: path.to_string(),
                    status: "modified".to_string(),
                })
            }
            _ => {}
        }
    }

    entries
}

/// Repo-relative data paths whose content differs between `old` and `new`.
/// Includes adds (in `new` only), deletes (in `old` only), and modifications.
/// Filters out `.scratch/` and non-`.json` entries — the folder_index only
/// tracks record data files.
fn file_map_changed_data_paths(old: &FileMap, new: &FileMap) -> Vec<String> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut changed: Vec<String> = Vec::new();

    for (path, new_content) in new {
        seen.insert(path.as_str());
        match old.get(path) {
            Some(old_content) if old_content == new_content => continue,
            _ => {
                if is_data_path_in_folder(path, "") {
                    changed.push(path.clone());
                }
            }
        }
    }
    for path in old.keys() {
        if seen.contains(path.as_str()) {
            continue;
        }
        if is_data_path_in_folder(path, "") {
            changed.push(path.clone());
        }
    }

    changed
}

fn aggregate_download(results: &[DownloadResult]) -> DownloadResult {
    let mut agg = DownloadResult {
        status: "up_to_date".to_string(),
        ..Default::default()
    };
    for result in results {
        if result.status == "downloaded" {
            agg.status = "downloaded".to_string();
        }
        agg.files_updated += result.files_updated;
        agg.files_created += result.files_created;
        agg.files_deleted += result.files_deleted;
        agg.files_merged += result.files_merged;
        agg.conflicts_auto_resolved += result.conflicts_auto_resolved;
        agg.messages.extend(result.messages.iter().cloned());
    }
    agg
}

fn aggregate_upload(results: &[UploadResult]) -> UploadResult {
    let mut agg = UploadResult {
        status: "no_changes".to_string(),
        ..Default::default()
    };
    for result in results {
        if result.status == "uploaded" {
            agg.status = "uploaded".to_string();
        }
        if result.status == "up_to_date" && agg.status == "no_changes" {
            agg.status = "up_to_date".to_string();
        }
        agg.files_created += result.files_created;
        agg.files_updated += result.files_updated;
        agg.files_merged += result.files_merged;
        agg.files_deleted += result.files_deleted;
        agg.files_plan += result.files_plan;
        agg.conflicts_auto_resolved += result.conflicts_auto_resolved;
        agg.retries += result.retries;
        agg.messages.extend(result.messages.iter().cloned());
        agg.created_paths
            .extend(result.created_paths.iter().cloned());
        agg.updated_paths
            .extend(result.updated_paths.iter().cloned());
        agg.merged_paths.extend(result.merged_paths.iter().cloned());
        agg.deleted_paths
            .extend(result.deleted_paths.iter().cloned());
        // Take the last connection's staleness warning as the workspace-wide
        // signal — they're all the same when present (server's `main`).
        if let Some(staleness) = &result.staleness_warning {
            agg.staleness_warning = Some(staleness.clone());
        }
    }
    agg
}

fn print_file_list(paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let limit = paths.len().min(10);
    for path in &paths[..limit] {
        println!("  {}", path);
    }
    if paths.len() > 10 {
        println!("  ... and {} more", paths.len() - 10);
    }
}

fn print_download_result(
    sync: &WorkspaceSyncResult,
    result: &DownloadResult,
    elapsed_ms: u128,
    json: bool,
) -> anyhow::Result<()> {
    let has_sync_changes = !sync.connections_added.is_empty()
        || !sync.connections_removed.is_empty()
        || !sync.connections_detached.is_empty();

    if json {
        let mut output = serde_json::json!({
            "status": result.status,
            "filesUpdated": result.files_updated,
            "filesCreated": result.files_created,
            "filesDeleted": result.files_deleted,
            "filesMerged": result.files_merged,
            "conflictsAutoResolved": result.conflicts_auto_resolved,
            "messages": result.messages,
            "elapsedMs": elapsed_ms,
        });
        if has_sync_changes {
            output["connectionsAdded"] = serde_json::json!(sync.connections_added);
            output["connectionsRemoved"] = serde_json::json!(sync.connections_removed);
            output["connectionsDetached"] = serde_json::json!(sync.connections_detached);
        }
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    let total =
        result.files_created + result.files_updated + result.files_merged + result.files_deleted;
    let elapsed = format_elapsed(elapsed_ms);
    if total == 0 && !has_sync_changes {
        println!(
            "{} ({})",
            if result.status == "up_to_date" {
                "Already up to date."
            } else {
                "No changes."
            },
            elapsed
        );
        return Ok(());
    }

    println!();
    let mut parts = Vec::new();
    if !sync.connections_added.is_empty() {
        parts.push(format!(
            "{} connection(s) added",
            sync.connections_added.len()
        ));
    }
    if !sync.connections_removed.is_empty() {
        parts.push(format!(
            "{} connection(s) removed",
            sync.connections_removed.len()
        ));
    }
    if !sync.connections_detached.is_empty() {
        parts.push(format!(
            "{} connection(s) detached",
            sync.connections_detached.len()
        ));
    }
    if result.files_created > 0 {
        parts.push(format!("{} added", result.files_created));
    }
    if result.files_updated > 0 {
        parts.push(format!("{} modified", result.files_updated));
    }
    if result.files_merged > 0 {
        parts.push(format!("{} merged", result.files_merged));
    }
    if result.files_deleted > 0 {
        parts.push(format!("{} deleted", result.files_deleted));
    }
    println!("{} ({})", parts.join(", "), elapsed);
    for message in &result.messages {
        println!("Warning: {}", message);
    }
    Ok(())
}

fn print_upload_result(
    aggregate: &UploadResult,
    per_connection: &[UploadResult],
    elapsed_ms: u128,
    json: bool,
) -> anyhow::Result<()> {
    if json {
        let connections: Vec<serde_json::Value> = per_connection
            .iter()
            .map(|c| {
                serde_json::json!({
                    "connectionName": c.connection_name,
                    "status": c.status,
                    "filesCreated": c.files_created,
                    "filesUpdated": c.files_updated,
                    "filesDeleted": c.files_deleted,
                    "createdPaths": c.created_paths,
                    "updatedPaths": c.updated_paths,
                    "deletedPaths": c.deleted_paths,
                    "messages": c.messages,
                    // DEV-10316: post-apply dirty HEAD, carried to publish as the
                    // `expectedBaseDirtyHead` TOCTOU token. Omitted when absent.
                    "dirtyHead": c.dirty_head,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": aggregate.status,
                "filesCreated": aggregate.files_created,
                "filesUpdated": aggregate.files_updated,
                "filesDeleted": aggregate.files_deleted,
                "filesMerged": aggregate.files_merged,
                "filesPlan": aggregate.files_plan,
                "conflictsAutoResolved": aggregate.conflicts_auto_resolved,
                "retries": aggregate.retries,
                "messages": aggregate.messages,
                "createdPaths": aggregate.created_paths,
                "updatedPaths": aggregate.updated_paths,
                "deletedPaths": aggregate.deleted_paths,
                "stalenessWarning": aggregate.staleness_warning,
                "connections": connections,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    let elapsed = format_elapsed(elapsed_ms);
    if aggregate.status == "no_changes" {
        println!("No local changes to upload. ({})", elapsed);
        for message in &aggregate.messages {
            println!("Warning: {}", message);
        }
        return Ok(());
    }
    if aggregate.status == "up_to_date" {
        println!("Remote already has all local changes. ({})", elapsed);
        for message in &aggregate.messages {
            println!("Warning: {}", message);
        }
        return Ok(());
    }

    let total = aggregate.files_created
        + aggregate.files_updated
        + aggregate.files_merged
        + aggregate.files_deleted;
    if total == 0 && aggregate.files_plan == 0 {
        println!("No changes. ({})", elapsed);
        return Ok(());
    }

    println!();
    let mut parts = Vec::new();
    if aggregate.files_created > 0 {
        parts.push(format!("{} added", aggregate.files_created));
    }
    if aggregate.files_updated > 0 {
        parts.push(format!("{} modified", aggregate.files_updated));
    }
    if aggregate.files_merged > 0 {
        parts.push(format!("{} merged", aggregate.files_merged));
    }
    if aggregate.files_deleted > 0 {
        parts.push(format!("{} deleted", aggregate.files_deleted));
    }
    if aggregate.files_plan > 0 {
        parts.push(format!("{} plan files pushed", aggregate.files_plan));
    }
    println!("{} ({})", parts.join(", "), elapsed);
    print_file_list(&aggregate.created_paths);
    print_file_list(&aggregate.updated_paths);
    print_file_list(&aggregate.merged_paths);
    print_file_list(&aggregate.deleted_paths);
    for message in &aggregate.messages {
        println!("Warning: {}", message);
    }
    Ok(())
}

fn format_elapsed(ms: u128) -> String {
    if ms < 1000 {
        format!("{}ms", ms)
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

/// Outcome of `update_main_worktree_after_pull` for a single connection.
/// Callers use `moved` to gate work that only matters when main actually
/// advanced (sync_schema_files_from_worktree) and `changed_paths` to drive a
/// targeted folder_index reindex.
#[derive(Default)]
struct MasterUpdateResult {
    /// `true` iff `refs/heads/main` advanced from its previous tip during
    /// this call (or was created from scratch).
    moved: bool,
    /// Repo-relative data paths whose blob OID changed between the old and
    /// new main tree. Empty when `moved` is false. Excludes `.scratch/`.
    changed_paths: Vec<String>,
}

/// Post-pull bookkeeping: fetch origin, advance `refs/heads/main` to match,
/// refresh the user worktree's index + tracked `.scratch/` content, and
/// compute the per-path diff for folder_index updates.
///
/// Pre-slice-F maintained a second sparse `master` worktree at
/// `<workspace>/.scratch/connections/master/<conn>/` as the read source for
/// schemas. Slice F retires that worktree — the single non-sparse worktree
/// on `main` carries schemas natively. This helper now refreshes the user
/// worktree directly:
///
/// 1. `worktree_reset_mixed` syncs the index without touching the working
///    tree (record JSONs were already written by `download_single_repo`'s
///    `materialize_local_repo`).
/// 2. `worktree_checkout_path(_, _, ".scratch")` re-checks-out only the
///    `.scratch/` subtree so schema files reflect the new HEAD without
///    overwriting user record edits.
fn update_main_worktree_after_pull(
    ctx: &ConnectionContext,
    _token: &str,
) -> anyhow::Result<MasterUpdateResult> {
    // No fetch here: the caller (`download_single_repo` /
    // `refresh_workbook_for_contexts`) just fetched origin for this same
    // bare repo. `refs/remotes/origin/main` is fresh. Removing this redundant
    // network round-trip eliminates a per-connection cost paid even when
    // `main` didn't move.
    let Some(new_main_hash) = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
    else {
        return Ok(MasterUpdateResult::default());
    };
    let old_main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    let moved = old_main_hash.as_deref() != Some(new_main_hash.as_str());

    // Always run the worktree-update steps — they're idempotent when main is
    // already up to date, and they recover from a state where the ref moved
    // earlier but materialization didn't complete.
    git_update_ref(&ctx.bare_repo, "refs/heads/main", &new_main_hash)?;
    if ctx.worktree_dir.join(".git").exists() {
        crate::git_ops::worktree_reset_mixed(&ctx.worktree_dir, &new_main_hash)?;
        // Re-check-out only the tracked `.scratch/` so the next
        // `sync_schema_files_from_worktree` reads fresh schemas. Skips
        // record files — `materialize_local_repo` already wrote those.
        crate::git_ops::worktree_checkout_path(&ctx.worktree_dir, &new_main_hash, ".scratch")?;
    }

    let mut changed_paths = Vec::new();
    if moved {
        match old_main_hash.as_deref() {
            Some(old_hash) => {
                // Cheap path-only diff via `git diff --name-status` — avoids
                // pulling every blob across the wire like read_git_tree
                // would. The helper already strips `.scratch/` entries.
                let diffs =
                    crate::git_ops::diff_name_status(&ctx.bare_repo, old_hash, &new_main_hash)?;
                for (_status, path) in diffs {
                    if is_data_path_in_folder(&path, "") {
                        changed_paths.push(path);
                    }
                }
            }
            None => {
                // First materialization: every data path in the new tree is
                // a "change" from nothing. Falls back to read_git_tree
                // because there's no prior ref to diff against.
                let new_tree = read_git_tree(&ctx.bare_repo, &new_main_hash)?;
                for path in new_tree.keys() {
                    if is_data_path_in_folder(path, "") {
                        changed_paths.push(path.clone());
                    }
                }
            }
        }
    }

    Ok(MasterUpdateResult {
        moved,
        changed_paths,
    })
}

trait ToSlashLossy {
    fn to_slash_lossy(&self) -> String;
}

impl ToSlashLossy for Path {
    fn to_slash_lossy(&self) -> String {
        self.to_string_lossy().replace('\\', "/")
    }
}

#[cfg(test)]
#[path = "tests/files.rs"]
mod tests;
