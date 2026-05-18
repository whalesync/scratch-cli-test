use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use clap::Subcommand;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::api::{ConnectorAccount, DataFolder};
use crate::config::markers;
use crate::shared::folder_index;
use crate::shared::layout::WorkspaceLayout;
use crate::shared::validators;

type FileMap = HashMap<String, Vec<u8>>;

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
    /// Download remote changes and three-way merge with local edits
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
    /// Commit all current working-tree record changes into the local dirty branch
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
    /// Discard every unreviewed working-tree change, restoring records to their last accepted (dirty-branch) state
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
    /// Commit one or more working-tree changes into the local dirty branch in a single commit
    Accept {
        /// Paths to accept, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        /// Multiple paths are committed together in a single commit per connection.
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Accept one field across all records in a folder, committing only that field into dirty
    #[command(name = "accept-field")]
    AcceptField {
        /// Folder path relative to the workspace root, or absolute path to a folder inside the workspace
        #[arg(long)]
        folder: PathBuf,
        /// Dot-separated field path to accept (for example: "name" or "author.name")
        #[arg(long)]
        field: String,
    },
    /// Discard working-tree changes for one or more files, restoring the dirty-branch version
    Reject {
        /// Paths to reject, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Discard one field across all records in a folder, restoring only that field from dirty
    #[command(name = "reject-field")]
    RejectField {
        /// Folder path relative to the workspace root, or absolute path to a folder inside the workspace
        #[arg(long)]
        folder: PathBuf,
        /// Dot-separated field path to reject (for example: "name" or "author.name")
        #[arg(long)]
        field: String,
    },
    /// Restore one or more approved deletions by copying the main-branch version back into working and dirty
    #[command(name = "restore-deleted-record")]
    RestoreDeletedRecord {
        /// Paths to restore, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Discard one or more approved creates by removing them from working and dirty
    #[command(name = "discard-created-record")]
    DiscardCreatedRecord {
        /// Paths to discard, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// List record changes that exist only in the working tree and have not been accepted locally
    Unreviewed,
    /// List record changes between dirty and master branches (accepted but not yet published)
    Unpublished,
    /// List record changes accepted locally but not yet published (dirty vs master)
    Unpushed,
    /// Upload locally accepted changes to the server's dirty branch (no publish).
    ///
    /// Computes the diff between local `main` and local `dirty`, emits one
    /// RFC 7396 merge patch per data file, and POSTs the payload to
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
    /// Force-push local state to the server, skipping merge (fast)
    #[command(name = "force-upload")]
    ForceUpload,
    /// Find the actual git merge base of local dirty and origin/dirty for each connection
    #[command(name = "find-merge-base", alias = "merge-base")]
    FindMergeBase,
}

#[derive(Clone)]
struct ConnectionContext {
    connection_id: String,
    conn_dir_name: String,
    dirty_dir: PathBuf,
    scratch_dir: PathBuf,
    workspace_dir: PathBuf,
    master_dir: PathBuf,
    reviewed_dirty_dir: PathBuf,
    bare_repo: PathBuf,
    db_path: PathBuf,
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
    /// Repo-relative data paths whose dirty branch moved during this
    /// upload (locally — i.e. from `local_dirty_hash` to either `remote_hash`
    /// in the fast-forward case or `new_dirty_hash` in the merge-commit
    /// case). Drives the caller's per-path folder_index reindex.
    changed_paths: Vec<String>,
    status: String,
    files_uploaded: i32,
    files_merged: i32,
    files_deleted: i32,
    files_plan: i32,
    conflicts_auto_resolved: i32,
    retries: i32,
    messages: Vec<String>,
    uploaded_paths: Vec<String>,
    merged_paths: Vec<String>,
    deleted_paths: Vec<String>,
}

#[derive(serde::Serialize)]
struct MergeBaseResult {
    #[serde(rename = "connectionName")]
    connection_name: String,
    #[serde(rename = "masterHash")]
    master_hash: Option<String>,
    #[serde(rename = "dirtyHash")]
    dirty_hash: Option<String>,
    #[serde(rename = "originDirtyHash")]
    origin_dirty_hash: Option<String>,
    #[serde(rename = "mergeBaseHash")]
    merge_base_hash: Option<String>,
    #[serde(rename = "equalsLocalMaster")]
    equals_local_master: bool,
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
struct FieldCommandResult {
    changed_paths: Vec<String>,
    dirty_changed: bool,
}

#[derive(Default)]
struct RemoteDiscardResult {
    changed_paths: Vec<String>,
    remote_discarded_paths: Vec<String>,
}

fn refresh_problem_record_index_for_ctx(
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
        &ctx.dirty_dir,
        &ctx.workspace_dir,
        &ctx.master_dir,
        &ctx.db_path,
        rebuild,
        selected_paths.as_ref(),
    ) {
        eprintln!("[validation] error processing {}: {err}", ctx.conn_dir_name);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct UnreviewedEntry {
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
        FilesCommands::RestoreDeletedRecord { paths } => {
            run_restore_deleted_record(&cwd, server_url, &paths, json)
        }
        FilesCommands::DiscardCreatedRecord { paths } => {
            run_discard_created_record(&cwd, server_url, &paths, json).await
        }
        FilesCommands::Unreviewed => run_unreviewed(&cwd, server_url, json),
        FilesCommands::Unpublished => run_unpublished(&cwd, server_url, json),
        FilesCommands::Unpushed => run_unpushed(&cwd, server_url, json),
        FilesCommands::Upload { skip_folder_index } => {
            run_upload(&cwd, server_url, json, skip_folder_index).await
        }
        FilesCommands::Publish => run_publish(&cwd, server_url, json).await,
        FilesCommands::ForceUpload => run_force_upload(&cwd, server_url, json),
        FilesCommands::FindMergeBase => run_find_merge_base(&cwd, server_url, json),
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
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

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

    let folders_by_conn = fetch_folders_by_connection(
        &workspace_server_url,
        &workspace_marker,
        &workspace_marker.workbook.id,
    )
    .await;

    let mut results = Vec::new();
    let mut all_changed_workspace_paths: Vec<String> = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Downloading {}...", ctx.conn_dir_name);
        }
        let empty = Vec::new();
        let folders = folders_by_conn.get(&ctx.connection_id).unwrap_or(&empty);
        let mut download_result = download_single_repo(ctx, &token, folders)?;
        // `update_master_worktree` is best-effort — failures here shouldn't
        // bubble up because the dirty-side download already succeeded. Fall
        // back to "no master change" on error.
        let master_update = update_master_worktree(ctx, &token).unwrap_or_default();
        if master_update.moved {
            // Schema files on master may have moved alongside data files;
            // resync them into ctx.scratch_dir. file_index for cross-record
            // remote_id lookups is also master-derived, so rebuild it here.
            // Both are gated on `moved` so unchanged connections pay zero
            // cost in the per-ctx loop.
            let _ = sync_schema_files_from_master(ctx);
            rebuild_index_for_conn(ctx, json);
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
        resolve_workspace_and_connections(cwd, server_url)?;
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
    let mut results = Vec::new();
    let mut all_changed_workspace_paths: Vec<String> = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && verbose {
            println!("Uploading {}...", ctx.conn_dir_name);
        }
        let upload_result =
            upload_single_repo_via_patches(ctx, &client, &token, workbook_id, verbose).await?;
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

    let result = if results.len() == 1 {
        results.into_iter().next().unwrap_or_default()
    } else {
        aggregate_upload(&results)
    };

    print_upload_result(&result, started.elapsed().as_millis(), json)
}

/// Publish accepted edits to external connectors. Two explicit server calls
/// per connection: `/publish-v2/plan-job` builds the plan (server-side diff
/// of dirty vs main) and `/publish-v2/run-job` dispatches the plan through the
/// connector. The CLI polls each job to completion before moving to the next
/// connection or the next phase. Decoupled from `files upload` so the two
/// concerns — "stage my changes server-side" and "actually publish them" —
/// can be driven independently (scripting, CI, deferred publishing).
async fn run_publish(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (workspace_marker, workspace_dir, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let _lock = crate::config::workspace_lock::acquire(&workspace_dir)?;

    let client = crate::api::ApiClient::new(&workspace_server_url, token.clone());
    let workbook_id = workspace_marker.workbook.id.as_str();

    let verbose = !json;
    let mut published_connections: Vec<String> = Vec::new();
    let mut skipped_no_diff: Vec<String> = Vec::new();

    for ctx in &contexts {
        if contexts.len() > 1 && verbose {
            println!("Publishing {}...", ctx.conn_dir_name);
        }

        if verbose {
            eprint!("  Planning...");
        }
        let plan = client
            .publish_plan_build(workbook_id, &ctx.connection_id)
            .await
            .map_err(|e| anyhow::anyhow!("plan-job failed for {}: {e}", ctx.conn_dir_name))?;

        let (plan_job_id, pipeline_id) = match (plan.job_id, plan.pipeline_id) {
            (Some(job), Some(pipe)) => (job, pipe),
            _ => {
                if verbose {
                    eprintln!(" no changes");
                }
                skipped_no_diff.push(ctx.conn_dir_name.clone());
                continue;
            }
        };

        crate::api::poll_job(&client, &plan_job_id)
            .await
            .map_err(|e| anyhow::anyhow!("plan-job poll failed for {}: {e}", ctx.conn_dir_name))?;
        if verbose {
            eprintln!(" done");
        }

        if verbose {
            eprint!("  Running...");
        }
        let run = client
            .publish_plan_run(workbook_id, &pipeline_id)
            .await
            .map_err(|e| anyhow::anyhow!("run-job failed for {}: {e}", ctx.conn_dir_name))?;
        if let Some(run_job_id) = run.job_id.as_deref() {
            crate::api::poll_job(&client, run_job_id)
                .await
                .map_err(|e| anyhow::anyhow!("run-job poll failed for {}: {e}", ctx.conn_dir_name))?;
        }
        if verbose {
            eprintln!(" done");
        }

        // After a successful publish, the server's `main` has advanced for
        // this connector. Fetch + advance the local `main` ref so the next
        // `files upload` correctly sees no diff against `dirty`.
        crate::git_ops::fetch_origin(&ctx.bare_repo, &token)?;
        if let Some(new_main_hash) =
            git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
        {
            git_update_ref(&ctx.bare_repo, "refs/heads/main", &new_main_hash)?;
        }

        published_connections.push(ctx.conn_dir_name.clone());
    }

    let elapsed_ms = started.elapsed().as_millis();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": if published_connections.is_empty() && skipped_no_diff.is_empty() { "no_changes" }
                          else if published_connections.is_empty() { "no_diff" }
                          else { "published" },
                "publishedConnections": published_connections,
                "skippedNoDiff": skipped_no_diff,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    let elapsed = format_elapsed(elapsed_ms);
    if published_connections.is_empty() && skipped_no_diff.is_empty() {
        println!("No connections to publish. ({})", elapsed);
    } else if published_connections.is_empty() {
        println!(
            "No changes to publish across {} connection(s). ({})",
            skipped_no_diff.len(),
            elapsed
        );
    } else {
        println!(
            "Published {} connection(s). ({})",
            published_connections.len(),
            elapsed
        );
        for name in &published_connections {
            println!("  {}", name);
        }
        if !skipped_no_diff.is_empty() {
            println!(
                "Skipped {} connection(s) with no changes.",
                skipped_no_diff.len()
            );
        }
    }
    Ok(())
}

fn run_find_merge_base(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let (_, _, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut results = Vec::new();
    for ctx in &contexts {
        crate::git_ops::fetch_origin(&ctx.bare_repo, &token)?;

        let master_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
        let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
        let origin_dirty_hash =
            git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/dirty")?;

        let merge_base_hash = if dirty_hash.is_some() && origin_dirty_hash.is_some() {
            crate::git_ops::merge_base_to_string(
                &ctx.bare_repo,
                "refs/heads/dirty",
                "refs/remotes/origin/dirty",
            )?
        } else {
            None
        };

        let equals_local_master = match (&merge_base_hash, &master_hash) {
            (Some(merge_base), Some(master)) => merge_base == master,
            _ => false,
        };

        results.push(MergeBaseResult {
            connection_name: ctx.conn_dir_name.clone(),
            master_hash,
            dirty_hash,
            origin_dirty_hash,
            merge_base_hash,
            equals_local_master,
        });
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&results)?);
        return Ok(());
    }

    for result in results {
        println!("{}", result.connection_name);
        println!(
            "  dirty:        {}",
            result.dirty_hash.as_deref().unwrap_or("(missing)")
        );
        println!(
            "  origin/dirty: {}",
            result.origin_dirty_hash.as_deref().unwrap_or("(missing)")
        );
        println!(
            "  merge-base:   {}",
            result.merge_base_hash.as_deref().unwrap_or("(none)")
        );
        println!(
            "  master:       {}",
            result.master_hash.as_deref().unwrap_or("(missing)")
        );
        println!(
            "  merge-base == local master: {}",
            if result.equals_local_master {
                "yes"
            } else {
                "no"
            }
        );
    }

    Ok(())
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
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut discarded_files: Vec<String> = Vec::new();
    let mut total_discarded: i32 = 0;
    let mut skipped_any = false;
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            let result = discard_all_single_repo(&ctx, &workspace_dir, Some(repo_folder.as_str()))?;
            refresh_problem_record_index_for_ctx(&ctx, &result.discarded_paths, false)?;
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
                let result = discard_all_single_repo(ctx, &workspace_dir, None)?;
                refresh_problem_record_index_for_ctx(ctx, &result.discarded_paths, false)?;
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
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut rejected_files: Vec<String> = Vec::new();
    let mut total_rejected: i32 = 0;
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            let result = reject_all_single_repo(&ctx, &workspace_dir, Some(repo_folder.as_str()))?;
            refresh_problem_record_index_for_ctx(&ctx, &result.rejected_paths, false)?;
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
                let result = reject_all_single_repo(ctx, &workspace_dir, None)?;
                refresh_problem_record_index_for_ctx(ctx, &result.rejected_paths, false)?;
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
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut accepted_files: Vec<String> = Vec::new();
    let mut total_accepted: i32 = 0;
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            let result = accept_all_single_repo(&ctx, &workspace_dir, Some(repo_folder.as_str()))?;
            refresh_problem_record_index_for_ctx(&ctx, &result.accepted_paths, false)?;
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
                let result = accept_all_single_repo(ctx, &workspace_dir, None)?;
                refresh_problem_record_index_for_ctx(ctx, &result.accepted_paths, false)?;
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
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    // Group input paths by connection. Each group produces one commit.
    // Path format: "<conn-dir-name>/<repo-relative-path>"
    let mut by_conn: HashMap<usize, Vec<(String, String)>> = HashMap::new(); // ctx index → [(input_path, rel_path)]
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

    let mut all_accepted: Vec<String> = Vec::new();

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];

        let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
        let base_map = match base_hash.as_deref() {
            Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
            None => HashMap::new(),
        };
        sync_schema_files_from_master(ctx)?;
        let local_map = read_materialized_repo(ctx)?;

        let changes = compute_unreviewed_entries(&ctx.conn_dir_name, &base_map, &local_map);
        let changed_paths: std::collections::HashSet<&str> =
            changes.iter().map(|e| e.path.as_str()).collect();

        // Validate all requested paths have unreviewed changes
        for (input_path, rel_path) in path_pairs {
            if !changed_paths.contains(rel_path.as_str()) {
                anyhow::bail!("No unreviewed local changes for '{}'.", input_path);
            }
        }

        // Build accepted_map: start from dirty branch, apply all requested files in one go
        let mut accepted_map = base_map.clone();
        for (_, rel_path) in path_pairs {
            match local_map.get(rel_path.as_str()) {
                Some(content) => {
                    accepted_map.insert(rel_path.clone(), content.clone());
                }
                None => {
                    accepted_map.remove(rel_path.as_str());
                }
            }
        }

        let msg = if path_pairs.len() == 1 {
            format!("Accept local change: {}", path_pairs[0].1)
        } else {
            format!("Accept {} local changes", path_pairs.len())
        };

        let new_dirty_hash = commit_file_map_to_dirty_ref(
            &ctx.bare_repo,
            base_hash.as_deref(),
            &accepted_map,
            &msg,
        )?;
        update_dirty_worktree_index(ctx, &new_dirty_hash)?;
        update_reviewed_dirty(ctx, &new_dirty_hash)?;
        let rel_paths: Vec<String> = path_pairs.iter().map(|(_, rel)| rel.clone()).collect();
        refresh_problem_record_index_for_ctx(ctx, &rel_paths, path_pairs.len() > 1)?;

        all_accepted.extend(path_pairs.iter().map(|(input_path, _)| input_path.clone()));
    }

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
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    // Group input paths by connection (same pattern as run_accept)
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

    let mut all_rejected: Vec<String> = Vec::new();

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];

        let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
        let base_map = match base_hash.as_deref() {
            Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
            None => HashMap::new(),
        };
        sync_schema_files_from_master(ctx)?;
        let local_map = read_materialized_repo(ctx)?;

        let changes = compute_unreviewed_entries(&ctx.conn_dir_name, &base_map, &local_map);
        let changed_paths: std::collections::HashSet<&str> =
            changes.iter().map(|e| e.path.as_str()).collect();

        // Validate all requested paths have unreviewed changes
        for (input_path, rel_path) in path_pairs {
            if !changed_paths.contains(rel_path.as_str()) {
                anyhow::bail!("No unreviewed local changes for '{}'.", input_path);
            }
        }

        // Restore dirty-branch version to working tree
        for (_, rel_path) in path_pairs {
            let disk_path = ctx.dirty_dir.join(rel_path);
            match base_map.get(rel_path.as_str()) {
                Some(content) => {
                    // File exists on dirty branch — restore it
                    write_file(&disk_path, content)?;
                }
                None => {
                    // File does not exist on dirty branch (added locally) — delete it
                    if disk_path.exists() {
                        std::fs::remove_file(&disk_path)?;
                    }
                }
            }
        }

        all_rejected.extend(path_pairs.iter().map(|(input_path, _)| input_path.clone()));
    }

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
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

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

        let result = discard_paths_single_repo(ctx, &rel_paths, &input_by_rel)?;
        if result.skipped_missing_main {
            skipped_any = true;
            continue;
        }
        refresh_problem_record_index_for_ctx(ctx, &result.discarded_paths, path_pairs.len() > 1)?;
        for rel in &result.discarded_paths {
            if let Some(input) = input_by_rel.get(rel.as_str()) {
                all_discarded.push((*input).to_string());
            }
        }
    }

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
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let (ctx, repo_folder, display_folder) =
        resolve_folder_context(&workspace_dir, &contexts, folder)?;

    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(&ctx)?;
    let local_map = read_materialized_repo(&ctx)?;

    let (accepted_map, result) =
        accept_field_in_folder(&ctx, &repo_folder, field, &base_map, &local_map)?;
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

    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &accepted_map,
        &format!("Accept field '{}' in {}", field, repo_folder),
    )?;
    update_dirty_worktree_index(&ctx, &new_dirty_hash)?;
    update_reviewed_dirty(&ctx, &new_dirty_hash)?;
    refresh_problem_record_index_for_ctx(&ctx, &result.changed_paths, true)?;

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
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let (ctx, repo_folder, display_folder) =
        resolve_folder_context(&workspace_dir, &contexts, folder)?;

    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    let master_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    let master_map = match master_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(&ctx)?;
    let local_map = read_materialized_repo(&ctx)?;

    let (next_local_map, next_dirty_map, result) = reject_field_in_folder(
        &ctx,
        &repo_folder,
        field,
        &base_map,
        &local_map,
        &master_map,
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

    apply_changed_working_files(&ctx, &local_map, &next_local_map, &repo_folder)?;

    if result.dirty_changed {
        let new_dirty_hash = commit_file_map_to_dirty_ref(
            &ctx.bare_repo,
            base_hash.as_deref(),
            &next_dirty_map,
            &format!("Reject field '{}' in {}", field, repo_folder),
        )?;
        update_dirty_worktree_index(&ctx, &new_dirty_hash)?;
        update_reviewed_dirty(&ctx, &new_dirty_hash)?;
    }
    refresh_problem_record_index_for_ctx(&ctx, &result.changed_paths, true)?;

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

// Restore approved deletions by:
// - grouping requested paths by connection
// - copying the main-branch version back into the local working tree and dirty branch
// - updating the hidden reviewed-dirty checkout for the affected connection
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
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let by_conn = group_input_paths_by_connection(&contexts, input_paths)?;
    let mut all_restored: Vec<String> = Vec::new();

    for (ctx_idx, path_pairs) in &by_conn {
        let ctx = &contexts[*ctx_idx];
        let rel_paths: Vec<String> = path_pairs
            .iter()
            .map(|(_, rel_path)| rel_path.clone())
            .collect();
        restore_deleted_records_locally(ctx, &rel_paths)?;
        refresh_problem_record_index_for_ctx(ctx, &rel_paths, false)?;
        all_restored.extend(path_pairs.iter().map(|(input_path, _)| input_path.clone()));
    }

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
// - updating the hidden reviewed-dirty checkout for the affected connection
// - also discarding the matching path from the remote dirty branch
async fn run_discard_created_record(
    cwd: &Path,
    server_url: &str,
    input_paths: &[String],
    json: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (workspace_marker, _workspace_dir, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

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

        discard_created_records_locally(ctx, &rel_paths)?;
        refresh_problem_record_index_for_ctx(ctx, &rel_paths, false)?;
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
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut entries = Vec::new();
    for ctx in &contexts {
        entries.extend(unreviewed_entries(ctx)?);
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

fn run_unpublished(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut entries = Vec::new();
    for ctx in &contexts {
        entries.extend(unpublished_entries(ctx)?);
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
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut entries = Vec::new();
    for ctx in &contexts {
        entries.extend(unpushed_entries(ctx)?);
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

fn unpushed_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    let master_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;

    let (from, to) = match (master_hash.as_deref(), dirty_hash.as_deref()) {
        (Some(m), Some(d)) => (m, d),
        _ => return Ok(vec![]),
    };

    let diffs = crate::git_ops::diff_name_status(&ctx.bare_repo, from, to)?;
    Ok(diffs
        .into_iter()
        .map(|(status, path)| UnreviewedEntry {
            connection_name: ctx.conn_dir_name.clone(),
            path,
            status,
        })
        .collect())
}

fn run_force_upload(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, _, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut any_pushed = false;
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Force-uploading {}...", ctx.conn_dir_name);
        }
        if force_upload_single_repo(ctx, &token)? {
            any_pushed = true;
        }
    }

    let elapsed = started.elapsed().as_millis();
    if json {
        println!(
            "{}",
            serde_json::json!({ "pushed": any_pushed, "elapsedMs": elapsed })
        );
    } else if any_pushed {
        println!("Force-pushed. ({})", format_elapsed(elapsed));
    } else {
        println!("Nothing to push. ({})", format_elapsed(elapsed));
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
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let folders_by_conn =
        fetch_folders_by_connection(base_url, &workspace_marker, workbook_id).await;

    for ctx in &contexts {
        let empty = Vec::new();
        let folders = folders_by_conn.get(&ctx.connection_id).unwrap_or(&empty);
        download_single_repo(ctx, token, folders)?;
        if update_master_worktree(ctx, token).is_ok() {
            let _ = sync_schema_files_from_master(ctx);
            rebuild_index_for_conn(ctx, true);
        }
    }
    Ok(())
}

/// Fetch fresh DataFolder metadata for each connection so download can
/// reconcile empty folders after materialization. Best-effort: on any auth or
/// network error, returns an empty map — file merge still proceeds, only the
/// empty-folder reconcile is skipped.
async fn fetch_folders_by_connection(
    base_url: &str,
    workspace_marker: &markers::WorkspaceMarker,
    workbook_id: &str,
) -> HashMap<String, Vec<DataFolder>> {
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
            .map(|ca| (ca.id, ca.data_folders))
            .collect(),
        Err(e) => {
            eprintln!("  Note: could not fetch folder metadata for reconcile: {e}");
            HashMap::new()
        }
    }
}

fn resolve_workspace_and_connections(
    cwd: &Path,
    server_url: &str,
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
            dirty_dir: layout.dirty_checkout_path(&connection.dir_name),
            scratch_dir: layout.connection_scratch_path(&connection.dir_name),
            workspace_dir: layout.workbook_materialization_path(),
            master_dir: layout.master_worktree_path(&connection.dir_name),
            reviewed_dirty_dir: layout.reviewed_dirty_checkout_path(&connection.dir_name),
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

fn restore_deleted_records_locally(
    ctx: &ConnectionContext,
    rel_paths: &[String],
) -> anyhow::Result<()> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    let master_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    let master_map = match master_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };

    let mut next_dirty_map = base_map.clone();
    for rel_path in rel_paths {
        let display_path = format!("{}/{}", ctx.conn_dir_name, rel_path);
        if base_map.contains_key(rel_path.as_str()) {
            anyhow::bail!("'{}' is not an approved deleted record.", display_path);
        }
        let Some(master_content) = master_map.get(rel_path.as_str()) else {
            anyhow::bail!(
                "'{}' does not exist on main and cannot be restored.",
                display_path
            );
        };
        write_file(&ctx.dirty_dir.join(rel_path), master_content)?;
        next_dirty_map.insert(rel_path.clone(), master_content.clone());
    }

    let message = if rel_paths.len() == 1 {
        format!("Restore approved delete: {}", rel_paths[0])
    } else {
        format!("Restore {} approved deletes", rel_paths.len())
    };
    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &next_dirty_map,
        &message,
    )?;
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    update_reviewed_dirty(ctx, &new_dirty_hash)?;
    Ok(())
}

fn discard_created_records_locally(
    ctx: &ConnectionContext,
    rel_paths: &[String],
) -> anyhow::Result<()> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    let master_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    let master_map = match master_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };

    let mut next_dirty_map = base_map.clone();
    for rel_path in rel_paths {
        let display_path = format!("{}/{}", ctx.conn_dir_name, rel_path);
        if master_map.contains_key(rel_path.as_str()) {
            anyhow::bail!(
                "'{}' exists on main and cannot be discarded as an approved create.",
                display_path
            );
        }
        if !base_map.contains_key(rel_path.as_str()) {
            anyhow::bail!("'{}' is not an approved created record.", display_path);
        }
        if ctx.dirty_dir.join(rel_path).exists() {
            std::fs::remove_file(ctx.dirty_dir.join(rel_path))?;
        }
        next_dirty_map.remove(rel_path.as_str());
    }

    let message = if rel_paths.len() == 1 {
        format!("Discard approved create: {}", rel_paths[0])
    } else {
        format!("Discard {} approved creates", rel_paths.len())
    };
    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &next_dirty_map,
        &message,
    )?;
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    update_reviewed_dirty(ctx, &new_dirty_hash)?;
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

fn update_dirty_worktree_index(ctx: &ConnectionContext, hash: &str) -> anyhow::Result<()> {
    crate::git_ops::worktree_reset_mixed(&ctx.dirty_dir, hash)
}

/// Ensure reviewed_dirty_dir is set up as a sparse worktree and reset it to the given dirty hash.
fn update_reviewed_dirty(ctx: &ConnectionContext, hash: &str) -> anyhow::Result<()> {
    crate::git_ops::ensure_sparse_worktree(
        &ctx.bare_repo,
        &ctx.reviewed_dirty_dir,
        "refs/heads/dirty",
    )?;
    crate::git_ops::worktree_reset_hard(&ctx.reviewed_dirty_dir, hash)
}

fn download_single_repo(
    ctx: &ConnectionContext,
    token: &str,
    data_folders: &[DataFolder],
) -> anyhow::Result<DownloadResult> {
    crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;

    let local_dirty_hash = git_rev_parse(&ctx.bare_repo, "refs/heads/dirty")?;
    let remote_hash = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/dirty")?;

    if local_dirty_hash == remote_hash {
        return Ok(DownloadResult {
            status: "up_to_date".to_string(),
            ..Default::default()
        });
    }

    let local_dirty_map = read_git_tree(&ctx.bare_repo, &local_dirty_hash)?;
    let remote_map = read_git_tree(&ctx.bare_repo, &remote_hash)?;
    let merge_base_hash = crate::git_ops::merge_base_to_string(
        &ctx.bare_repo,
        "refs/heads/dirty",
        "refs/remotes/origin/dirty",
    )?
    .ok_or_else(|| anyhow::anyhow!("No merge base found between local dirty and origin/dirty"))?;
    let merge_base_map = read_git_tree(&ctx.bare_repo, &merge_base_hash)?;
    let (merged_dirty_map, _, mut messages) =
        prepare_upload_merge(&merge_base_map, &local_dirty_map, &remote_map, 0);

    let new_dirty_hash = if maps_equal(&merged_dirty_map, &remote_map) {
        git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &remote_hash)?;
        remote_hash.clone()
    } else {
        commit_file_map_to_dirty_ref(
            &ctx.bare_repo,
            Some(remote_hash.as_str()),
            &merged_dirty_map,
            "Download from Scratch CLI",
        )?
    };

    let local_map = read_materialized_repo(ctx)?;
    let actions = compute_merge_actions(&local_dirty_map, &local_map, &merged_dirty_map);

    let mut result = DownloadResult {
        status: "downloaded".to_string(),
        messages: std::mem::take(&mut messages),
        ..Default::default()
    };
    let mut target_map = merged_dirty_map.clone();

    for act in &actions {
        match act {
            MergeAction::KeepLocal { path, content, .. } => match content {
                Some(content) => {
                    target_map.insert(path.clone(), content.clone());
                }
                None => {
                    target_map.remove(path.as_str());
                }
            },
            MergeAction::WriteRemote { path, content } => {
                if let Some(content) = content {
                    if local_dirty_map.contains_key(path.as_str()) {
                        result.files_updated += 1;
                    } else {
                        result.files_created += 1;
                    }
                    target_map.insert(path.clone(), content.clone());
                } else {
                    result.files_deleted += 1;
                    target_map.remove(path.as_str());
                }
            }
            MergeAction::Delete { path, warning } => {
                result.files_deleted += 1;
                target_map.remove(path.as_str());
                if let Some(warning) = warning {
                    result.messages.push(warning.clone());
                }
            }
            MergeAction::Merge {
                path,
                base,
                local,
                remote,
            } => {
                let merged = merge_content(path, Some(base), Some(local), Some(remote));
                target_map.insert(path.clone(), merged);
                result.files_merged += 1;
                result.conflicts_auto_resolved += 1;
            }
        }
    }

    // Compute the set of data paths whose content actually moved on either
    // tree we care about for the folder_index:
    //   - dirty branch: `local_dirty_map` → `merged_dirty_map`
    //   - working tree: `local_map`       → `target_map`
    // MergeActions over-count here because compute_merge_actions emits
    // `WriteRemote` even when remote == base (no actual content move);
    // diffing the maps directly avoids that false positive.
    let mut changed_paths_set: HashSet<String> = HashSet::new();
    for path in file_map_changed_data_paths(&local_dirty_map, &merged_dirty_map) {
        changed_paths_set.insert(path);
    }
    for path in file_map_changed_data_paths(&local_map, &target_map) {
        changed_paths_set.insert(path);
    }
    result.changed_paths = changed_paths_set.into_iter().collect();

    // local_map is the snapshot we read earlier; pass it so materialize can
    // skip rewriting files whose content didn't move (preserves mtimes so
    // find_stale_files doesn't see every file as stale next page load).
    materialize_local_repo(ctx, &target_map, &local_map)?;
    reconcile_data_folder_dirs(&ctx.dirty_dir, data_folders)?;
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    update_reviewed_dirty(ctx, &new_dirty_hash)?;
    // Validators are NOT run inline. The dead `validators::run_validations`
    // pipeline writes to validation_results_v1 which nothing in production
    // reads — the grid's validation results come from the folder_index
    // pipeline (validate_page_records, writing validation_results__v1).
    // After the per-path folder_index reindex the caller does next, our
    // affected rows will have working_mtime moved and stale validation,
    // so the next paginate-records --validate re-runs validators lazily
    // for whatever page the user actually views.

    Ok(result)
}

/// Phase 1 of the upload-patch flow. Publishes the local connection's
/// accepted state by:
///
///   1. Fetching origin so `refs/remotes/origin/main` reflects the server's
///      current view of published state.
///   2. Computing per-file RFC 7396 merge patches between local `main` (the
///      last-fetched server state) and local `dirty` (the user's locally
///      accepted edits).
///   3. Uploading the patch payload via `/upload-patch/init` → presigned GCS
///      PUT → `/upload-patch/commit`. The server applies the patches to its
///      dirty branch as one commit, then triggers the existing publish-v2
///      plan-job + run-job pipeline.
///   4. Polling the publish job to completion (or surfacing its failure).
///   5. Fetching again so the local `main` ref advances to include the
///      just-published commit. Without this, the user would see "no_changes"
///      based on stale local state on the next run.
///
/// Replaces the legacy local-merge-and-push path (which built publish plans
/// client-side and pushed them to `refs/heads/dirty`). The local `dirty`
/// branch is no longer authoritative for what gets published — the diff
/// against local `main` is. Local refs are left alone except for advancing
/// `main` after a successful publish.
async fn upload_single_repo_via_patches(
    ctx: &ConnectionContext,
    client: &crate::api::ApiClient,
    token: &str,
    workbook_id: &str,
    verbose: bool,
) -> anyhow::Result<UploadResult> {
    if verbose {
        eprint!("  Fetching remote changes...");
    }
    crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;
    if verbose {
        eprintln!(" done");
    }

    let local_unreviewed = unreviewed_entries(ctx)?;

    let main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
        .or(git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?);
    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;

    let main_map = match main_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => FileMap::new(),
    };
    let dirty_map = match dirty_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => FileMap::new(),
    };

    if verbose {
        eprint!("  Computing patches...");
    }
    let patches = compute_upload_patches(&main_map, &dirty_map, &ctx.conn_dir_name)?;
    if verbose {
        eprintln!(" done ({} file(s))", patches.len());
    }

    if patches.is_empty() {
        let mut messages = Vec::new();
        if !local_unreviewed.is_empty() {
            messages.push(format!(
                "{} record(s) have unreviewed local changes and will not be uploaded. Run `scratchmd files accept-all` first.",
                local_unreviewed.len()
            ));
        }
        return Ok(UploadResult {
            status: "no_changes".to_string(),
            messages,
            ..Default::default()
        });
    }

    let files_uploaded = patches.iter().filter(|p| !p.patch.is_null()).count() as i32;
    let files_deleted = patches.iter().filter(|p| p.patch.is_null()).count() as i32;
    let uploaded_paths: Vec<String> = patches
        .iter()
        .filter(|p| !p.patch.is_null())
        .map(|p| format!("{}/{}", ctx.conn_dir_name, p.path))
        .collect();
    let deleted_paths: Vec<String> = patches
        .iter()
        .filter(|p| p.patch.is_null())
        .map(|p| format!("{}/{}", ctx.conn_dir_name, p.path))
        .collect();
    // The dirty branch didn't move on this upload (server is authoritative
    // now), but the caller still wants paths to drive folder_index reindex
    // after `main` advances below — feed it the same set we touched.
    let changed_paths: Vec<String> = patches.iter().map(|p| p.path.clone()).collect();

    let payload = crate::api::UploadPatchPayload {
        patches: patches
            .into_iter()
            .map(|p| crate::api::UploadPatchEntry {
                path: p.path,
                patch: p.patch,
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
    let commit = client
        .upload_patch_commit(
            workbook_id,
            &ctx.connection_id,
            &init.upload_id,
            main_hash.as_deref(),
        )
        .await
        .map_err(|e| anyhow::anyhow!("upload-patch commit failed: {e}"))?;
    if verbose {
        eprintln!(" done");
    }

    let mut messages = Vec::new();
    if !local_unreviewed.is_empty() {
        messages.push(format!(
            "{} record(s) have unreviewed local changes and were not uploaded. Run `scratchmd files accept-all` first.",
            local_unreviewed.len()
        ));
    }
    if let Some(staleness) = &commit.staleness_warning {
        messages.push(format!(
            "The server has more recent changes ({}) than what's on your computer. Patches were still applied; run `scratchmd files download` to refresh.",
            short_sha(&staleness.new_head),
        ));
    }

    // Poll the apply-patches job to completion. The job's "done" state means
    // the server's `dirty` branch has the new commit; the publish pipeline is
    // NOT triggered by this endpoint anymore — the caller must run
    // `scratchmd files publish` afterwards.
    if let Some(job_id) = commit.job_id.as_deref() {
        if verbose {
            eprint!("  Applying...");
        }
        crate::api::poll_job(client, job_id)
            .await
            .map_err(|e| anyhow::anyhow!("apply-patches job failed: {e}"))?;
        if verbose {
            eprintln!(" done");
        }
    }

    Ok(UploadResult {
        status: "uploaded".to_string(),
        files_uploaded,
        files_deleted,
        uploaded_paths,
        deleted_paths,
        changed_paths,
        messages,
        ..Default::default()
    })
}

/// Local diff producer: between the local `main` tree (server's last-known
/// state) and the local `dirty` tree (user's accepted edits), emit one
/// `UploadPatchEntry` per data file that differs. Skips non-data paths
/// (`.scratch/*`, non-JSON) so we don't accidentally publish the local
/// publish-plan scratch files that the legacy flow used to push.
fn compute_upload_patches(
    main_map: &FileMap,
    dirty_map: &FileMap,
    conn_dir_name: &str,
) -> anyhow::Result<Vec<ComputedUploadPatch>> {
    let mut all_paths: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for path in main_map.keys() {
        if is_data_path_in_folder(path, "") {
            all_paths.insert(path.as_str());
        }
    }
    for path in dirty_map.keys() {
        if is_data_path_in_folder(path, "") {
            all_paths.insert(path.as_str());
        }
    }

    let mut patches: Vec<ComputedUploadPatch> = Vec::new();
    for path in all_paths {
        let main_bytes = main_map.get(path);
        let dirty_bytes = dirty_map.get(path);
        let patch_value = match (main_bytes, dirty_bytes) {
            (Some(m), Some(d)) if m == d => continue,
            (None, None) => continue,
            (Some(_), None) => serde_json::Value::Null,
            (None, Some(d)) => parse_json_value(d, path, conn_dir_name)?,
            (Some(m), Some(d)) => {
                let main_value = parse_json_value(m, path, conn_dir_name)?;
                let dirty_value = parse_json_value(d, path, conn_dir_name)?;
                match crate::commands::merge_patch::diff(&main_value, &dirty_value) {
                    Some(patch) => patch,
                    None => continue,
                }
            }
        };
        patches.push(ComputedUploadPatch {
            path: path.to_string(),
            patch: patch_value,
        });
    }
    Ok(patches)
}

#[derive(Debug)]
struct ComputedUploadPatch {
    path: String,
    patch: serde_json::Value,
}

fn parse_json_value(
    bytes: &[u8],
    path: &str,
    conn_dir_name: &str,
) -> anyhow::Result<serde_json::Value> {
    serde_json::from_slice(bytes).map_err(|err| {
        anyhow::anyhow!(
            "Failed to parse JSON in '{}/{}': {}. Aborting upload to avoid sending malformed patches.",
            conn_dir_name,
            path,
            err
        )
    })
}

fn short_sha(sha: &str) -> &str {
    sha.get(..7.min(sha.len())).unwrap_or(sha)
}

fn discard_all_single_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<DiscardAllResult> {
    sync_schema_files_from_master(ctx)?;
    // Scoped + non-empty folder: drive the affected-file set from the SQLite
    // folder index (matches accept-all's optimization). Unscoped path still does
    // the full byte-diff so it can cross every folder in the connection.
    if let Some(folder) = repo_folder.filter(|f| !f.is_empty()) {
        return discard_all_scoped_via_index(ctx, workspace_dir, folder);
    }
    discard_all_full_scan(ctx, repo_folder)
}

fn discard_all_full_scan(
    ctx: &ConnectionContext,
    repo_folder: Option<&str>,
) -> anyhow::Result<DiscardAllResult> {
    let main_hash = match git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")? {
        Some(hash) => hash,
        None => {
            return Ok(DiscardAllResult {
                skipped_missing_main: true,
                ..Default::default()
            });
        }
    };
    let main_map = read_git_tree(&ctx.bare_repo, &main_hash)?;

    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let dirty_map = match dirty_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    let local_map = read_materialized_repo(ctx)?;

    let all_pending = compute_unreviewed_entries(&ctx.conn_dir_name, &dirty_map, &local_map);
    let all_approved = compute_unreviewed_entries(&ctx.conn_dir_name, &main_map, &dirty_map);

    let path_in_scope = |path: &str| match repo_folder {
        Some(folder) => is_data_path_in_folder(path, folder),
        None => true,
    };

    let mut affected_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in &all_pending {
        if path_in_scope(&entry.path) {
            affected_paths.insert(entry.path.clone());
        }
    }
    for entry in &all_approved {
        if path_in_scope(&entry.path) {
            affected_paths.insert(entry.path.clone());
        }
    }

    if affected_paths.is_empty() {
        return Ok(DiscardAllResult {
            ..Default::default()
        });
    }

    // Build a new dirty tree. Scoped case: start from current dirty and overlay only
    // the folder's data files from main. Unscoped case: keep dirty's .scratch/*
    // entries and overlay every non-scratch file from main (previous behavior).
    let discarded_map = match repo_folder {
        Some(folder) => {
            let mut map = dirty_map.clone();
            let to_remove: Vec<String> = dirty_map
                .keys()
                .filter(|path| is_data_path_in_folder(path, folder))
                .cloned()
                .collect();
            for path in to_remove {
                map.remove(&path);
            }
            for (path, value) in &main_map {
                if is_data_path_in_folder(path, folder) {
                    map.insert(path.clone(), value.clone());
                }
            }
            map
        }
        None => {
            let mut map = scratch_only_map(&dirty_map);
            for (path, value) in &main_map {
                if !is_scratch_path(path) {
                    map.insert(path.clone(), value.clone());
                }
            }
            map
        }
    };

    let commit_msg = match repo_folder {
        Some(folder) if !folder.is_empty() => format!("Discard all local changes in {}", folder),
        _ => "Discard all local changes".to_string(),
    };
    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        dirty_hash.as_deref(),
        &discarded_map,
        &commit_msg,
    )?;
    // Update the dirty worktree's HEAD/index to the new commit, then revert ONLY
    // the affected paths on disk. A full `reset --hard` would blow away pending
    // edits in folders outside the scoped --folder.
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    for path in &affected_paths {
        let disk_path = ctx.dirty_dir.join(path);
        match discarded_map.get(path.as_str()) {
            Some(content) => write_file(&disk_path, content)?,
            None => {
                if disk_path.exists() {
                    std::fs::remove_file(&disk_path)?;
                }
            }
        }
    }
    update_reviewed_dirty(ctx, &new_dirty_hash)?;

    Ok(DiscardAllResult {
        files_discarded: affected_paths.len() as i32,
        discarded_paths: affected_paths.into_iter().collect(),
        skipped_missing_main: false,
    })
}

fn discard_all_scoped_via_index(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: &str,
) -> anyhow::Result<DiscardAllResult> {
    let main_hash = match git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")? {
        Some(hash) => hash,
        None => {
            return Ok(DiscardAllResult {
                skipped_missing_main: true,
                ..Default::default()
            });
        }
    };
    let main_map = read_git_tree(&ctx.bare_repo, &main_hash)?;

    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let dirty_map = match dirty_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };

    let workspace_folder = format!("{}/{}", ctx.conn_dir_name, repo_folder);

    // Refresh stale rows so the bits reflect the current working tree.
    let stale = folder_index::find_stale_files(workspace_dir, &workspace_folder, None)?;
    if !stale.is_empty() {
        folder_index::reindex_files(workspace_dir, &workspace_folder, &stale, None, false)?;
    }

    // Pre-filter set of files that *might* need discarding — anything the index
    // flags, plus dirty/main entries with no matching disk file (belt and
    // suspenders for fresh-workspace cases where the index lacks a row).
    let mut candidate_paths: std::collections::BTreeSet<String> =
        folder_index::select_files_with_local_changes(workspace_dir, &workspace_folder, None)?
            .into_iter()
            .map(|filename| format!("{}/{}", repo_folder, filename))
            .collect();
    for path in dirty_map.keys() {
        if !is_data_path_in_folder(path, repo_folder) {
            continue;
        }
        candidate_paths.insert(path.clone());
    }
    for path in main_map.keys() {
        if !is_data_path_in_folder(path, repo_folder) {
            continue;
        }
        candidate_paths.insert(path.clone());
    }

    // Confirm each candidate semantically differs from main (working OR dirty
    // side) — a stale index bit or a whitespace-only edit-then-revert can't
    // produce a spurious commit. Matches `reindex_files`'s bit semantic.
    let mut affected_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for path in &candidate_paths {
        let dirty_content = dirty_map.get(path.as_str());
        let main_content = main_map.get(path.as_str());
        let working_content = match std::fs::read(ctx.dirty_dir.join(path)) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return Err(anyhow::Error::from(err).context(format!(
                    "failed to read {}",
                    ctx.dirty_dir.join(path).display()
                )))
            }
        };
        let working_differs = json_content_differs(
            working_content.as_deref(),
            main_content.map(|v| v.as_slice()),
        );
        let dirty_differs = json_content_differs(
            dirty_content.map(|v| v.as_slice()),
            main_content.map(|v| v.as_slice()),
        );
        if working_differs || dirty_differs {
            affected_paths.insert(path.clone());
        }
    }

    if affected_paths.is_empty() {
        return Ok(DiscardAllResult::default());
    }

    // Build the new dirty tree: clone dirty_map and replace each affected entry
    // with its main version (or remove it if main doesn't have it).
    let mut discarded_map = dirty_map;
    for path in &affected_paths {
        match main_map.get(path.as_str()) {
            Some(content) => {
                discarded_map.insert(path.clone(), content.clone());
            }
            None => {
                discarded_map.remove(path);
            }
        }
    }

    let commit_msg = format!("Discard all local changes in {}", repo_folder);
    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        dirty_hash.as_deref(),
        &discarded_map,
        &commit_msg,
    )?;
    // Update dirty worktree HEAD/index, then revert only the affected paths on
    // disk — a full reset would blow away pending edits in other folders.
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    for path in &affected_paths {
        let disk_path = ctx.dirty_dir.join(path);
        match discarded_map.get(path.as_str()) {
            Some(content) => write_file(&disk_path, content)?,
            None => {
                if disk_path.exists() {
                    std::fs::remove_file(&disk_path)?;
                }
            }
        }
    }
    update_reviewed_dirty(ctx, &new_dirty_hash)?;

    Ok(DiscardAllResult {
        files_discarded: affected_paths.len() as i32,
        discarded_paths: affected_paths.into_iter().collect(),
        skipped_missing_main: false,
    })
}

/// Discard a specific set of repo-relative paths. For each path, revert both
/// unapproved working-tree edits and approved-but-unpublished edits by replacing
/// the entry with its content on `refs/heads/main`. Paths not present in either
/// the pending or approved sets cause an error (the caller already knows which
/// input path they came from via `input_by_rel`).
fn discard_paths_single_repo(
    ctx: &ConnectionContext,
    rel_paths: &[String],
    input_by_rel: &HashMap<&str, &str>,
) -> anyhow::Result<DiscardAllResult> {
    let main_hash = match git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")? {
        Some(hash) => hash,
        None => {
            return Ok(DiscardAllResult {
                skipped_missing_main: true,
                ..Default::default()
            });
        }
    };
    let main_map = read_git_tree(&ctx.bare_repo, &main_hash)?;

    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let dirty_map = match dirty_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;

    let all_pending = compute_unreviewed_entries(&ctx.conn_dir_name, &dirty_map, &local_map);
    let all_approved = compute_unreviewed_entries(&ctx.conn_dir_name, &main_map, &dirty_map);

    let mut changed: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in &all_pending {
        changed.insert(entry.path.clone());
    }
    for entry in &all_approved {
        changed.insert(entry.path.clone());
    }

    let mut targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for rel in rel_paths {
        if !changed.contains(rel) {
            let input = input_by_rel
                .get(rel.as_str())
                .copied()
                .unwrap_or(rel.as_str());
            anyhow::bail!("No local changes to discard for '{}'.", input);
        }
        targets.insert(rel.clone());
    }

    // Build the new dirty tree: start from current dirty, then for each target
    // path replace it with main's version (or remove it if main doesn't have it).
    let mut discarded_map = dirty_map.clone();
    for rel in &targets {
        match main_map.get(rel.as_str()) {
            Some(content) => {
                discarded_map.insert(rel.clone(), content.clone());
            }
            None => {
                discarded_map.remove(rel.as_str());
            }
        }
    }

    let commit_msg = if targets.len() == 1 {
        let only = targets.iter().next().unwrap();
        format!("Discard local changes in {}", only)
    } else {
        format!("Discard local changes in {} files", targets.len())
    };
    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        dirty_hash.as_deref(),
        &discarded_map,
        &commit_msg,
    )?;
    // Update only the targeted files on disk so unrelated pending edits in
    // other files are preserved.
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    for rel in &targets {
        let disk_path = ctx.dirty_dir.join(rel);
        match discarded_map.get(rel.as_str()) {
            Some(content) => write_file(&disk_path, content)?,
            None => {
                if disk_path.exists() {
                    std::fs::remove_file(&disk_path)?;
                }
            }
        }
    }
    update_reviewed_dirty(ctx, &new_dirty_hash)?;

    Ok(DiscardAllResult {
        files_discarded: targets.len() as i32,
        discarded_paths: targets.into_iter().collect(),
        skipped_missing_main: false,
    })
}

fn accept_all_single_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<AcceptAllResult> {
    sync_schema_files_from_master(ctx)?;

    // Scoped + non-empty folder: drive the changed-file set from the SQLite folder
    // index instead of byte-diffing the entire working tree against the entire
    // dirty tree. The unscoped path still does the full diff — it's the rare
    // terminal-CLI shape and crosses every folder in the connection.
    if let Some(folder) = repo_folder.filter(|f| !f.is_empty()) {
        return accept_all_scoped_via_index(ctx, workspace_dir, folder);
    }
    accept_all_full_scan(ctx, repo_folder)
}

fn accept_all_full_scan(
    ctx: &ConnectionContext,
    repo_folder: Option<&str>,
) -> anyhow::Result<AcceptAllResult> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    let local_map = read_materialized_repo(ctx)?;
    let all_changes = compute_unreviewed_entries(&ctx.conn_dir_name, &base_map, &local_map);

    let changes: Vec<UnreviewedEntry> = match repo_folder {
        Some(folder) => all_changes
            .into_iter()
            .filter(|entry| is_data_path_in_folder(&entry.path, folder))
            .collect(),
        None => all_changes,
    };

    if changes.is_empty() {
        return Ok(AcceptAllResult {
            ..Default::default()
        });
    }

    // When scoped to a folder, only overlay that folder's files from local_map.
    // Otherwise overlay every non-scratch file, matching the previous behavior.
    let mut accepted_map = base_map.clone();
    match repo_folder {
        Some(folder) => {
            for (path, value) in &local_map {
                if is_data_path_in_folder(path, folder) {
                    accepted_map.insert(path.clone(), value.clone());
                }
            }
            // Drop base entries that no longer exist locally within the folder
            // (handles locally-deleted records inside the scoped folder).
            let to_remove: Vec<String> = base_map
                .keys()
                .filter(|path| {
                    is_data_path_in_folder(path, folder) && !local_map.contains_key(path.as_str())
                })
                .cloned()
                .collect();
            for path in to_remove {
                accepted_map.remove(&path);
            }
        }
        None => {
            accepted_map = scratch_only_map(&base_map);
            for (path, value) in &local_map {
                if !is_scratch_path(path) {
                    accepted_map.insert(path.clone(), value.clone());
                }
            }
        }
    }

    let commit_msg = match repo_folder {
        Some(folder) if !folder.is_empty() => format!("Accept all local changes in {}", folder),
        _ => "Accept all local changes".to_string(),
    };
    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &accepted_map,
        &commit_msg,
    )?;
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    update_reviewed_dirty(ctx, &new_dirty_hash)?;

    Ok(AcceptAllResult {
        files_accepted: changes.len() as i32,
        accepted_paths: changes.into_iter().map(|entry| entry.path).collect(),
    })
}

fn reject_all_single_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<RejectAllResult> {
    sync_schema_files_from_master(ctx)?;
    if let Some(folder) = repo_folder.filter(|f| !f.is_empty()) {
        return reject_all_scoped_via_index(ctx, workspace_dir, folder);
    }
    reject_all_full_scan(ctx, repo_folder)
}

fn reject_all_full_scan(
    ctx: &ConnectionContext,
    repo_folder: Option<&str>,
) -> anyhow::Result<RejectAllResult> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    let local_map = read_materialized_repo(ctx)?;
    let all_changes = compute_unreviewed_entries(&ctx.conn_dir_name, &base_map, &local_map);

    let changes: Vec<UnreviewedEntry> = match repo_folder {
        Some(folder) => all_changes
            .into_iter()
            .filter(|entry| is_data_path_in_folder(&entry.path, folder))
            .collect(),
        None => all_changes,
    };

    if changes.is_empty() {
        return Ok(RejectAllResult::default());
    }

    // Restore working tree from dirty branch for each changed path. No git commit
    // is needed — we're only resetting working state to match dirty.
    for entry in &changes {
        let disk_path = ctx.dirty_dir.join(&entry.path);
        match base_map.get(entry.path.as_str()) {
            Some(content) => write_file(&disk_path, content)?,
            None => {
                if disk_path.exists() {
                    std::fs::remove_file(&disk_path)?;
                }
            }
        }
    }

    Ok(RejectAllResult {
        files_rejected: changes.len() as i32,
        rejected_paths: changes.into_iter().map(|entry| entry.path).collect(),
    })
}

fn reject_all_scoped_via_index(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: &str,
) -> anyhow::Result<RejectAllResult> {
    let workspace_folder = format!("{}/{}", ctx.conn_dir_name, repo_folder);

    // Refresh any stale approvedChanges bits before we trust the index query.
    let stale = folder_index::find_stale_files(workspace_dir, &workspace_folder, None)?;
    if !stale.is_empty() {
        folder_index::reindex_files(workspace_dir, &workspace_folder, &stale, None, false)?;
    }

    let candidate_rel_paths: std::collections::BTreeSet<String> =
        folder_index::select_files_with_approved_changes(workspace_dir, &workspace_folder, None)?
            .into_iter()
            .map(|filename| format!("{}/{}", repo_folder, filename))
            .collect();

    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };

    if candidate_rel_paths.is_empty() {
        return Ok(RejectAllResult::default());
    }

    let mut rejected_paths: Vec<String> = Vec::with_capacity(candidate_rel_paths.len());
    for rel_path in candidate_rel_paths {
        let disk_path = ctx.dirty_dir.join(&rel_path);
        let working_content = match std::fs::read(&disk_path) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return Err(anyhow::Error::from(err)
                    .context(format!("failed to read {}", disk_path.display())));
            }
        };
        let dirty_content = base_map.get(rel_path.as_str());
        // Cross-check semantically — skip files where working already matches dirty.
        if !json_content_differs(
            working_content.as_deref(),
            dirty_content.map(|v| v.as_slice()),
        ) {
            continue;
        }
        match dirty_content {
            Some(content) => write_file(&disk_path, content)?,
            None => {
                if disk_path.exists() {
                    std::fs::remove_file(&disk_path)?;
                }
            }
        }
        rejected_paths.push(rel_path);
    }

    Ok(RejectAllResult {
        files_rejected: rejected_paths.len() as i32,
        rejected_paths,
    })
}

fn accept_all_scoped_via_index(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: &str,
) -> anyhow::Result<AcceptAllResult> {
    let workspace_folder = format!("{}/{}", ctx.conn_dir_name, repo_folder);

    // Make sure approvedChanges reflects the latest working-tree state — if the
    // user edited a file since the grid last refreshed, the bit may be stale.
    let stale = folder_index::find_stale_files(workspace_dir, &workspace_folder, None)?;
    if !stale.is_empty() {
        folder_index::reindex_files(workspace_dir, &workspace_folder, &stale, None, false)?;
    }

    let mut candidate_rel_paths: std::collections::BTreeSet<String> =
        folder_index::select_files_with_approved_changes(workspace_dir, &workspace_folder, None)?
            .into_iter()
            .map(|filename| format!("{}/{}", repo_folder, filename))
            .collect();

    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };

    // Belt-and-suspenders: pick up deletions that the index might not have a row
    // for yet (e.g. a fresh workspace where this record was never seeded into
    // the SQLite cache, but the file was removed from disk). Anything in dirty's
    // folder that's missing from the working tree is a candidate deletion.
    for path in base_map.keys() {
        if !is_data_path_in_folder(path, repo_folder) {
            continue;
        }
        if candidate_rel_paths.contains(path) {
            continue;
        }
        if !ctx.dirty_dir.join(path).exists() {
            candidate_rel_paths.insert(path.clone());
        }
    }

    if candidate_rel_paths.is_empty() {
        return Ok(AcceptAllResult::default());
    }

    // Move base_map into accepted_map and apply only the changed entries. Cross-
    // check each candidate semantically against base_map so a stale index bit
    // or a whitespace-only edit-then-revert can't produce a spurious commit.
    let mut accepted_map = base_map;
    let mut accepted_paths: Vec<String> = Vec::with_capacity(candidate_rel_paths.len());
    for rel_path in candidate_rel_paths {
        let working_path = ctx.dirty_dir.join(&rel_path);
        let working_content = match std::fs::read(&working_path) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return Err(anyhow::Error::from(err)
                    .context(format!("failed to read {}", working_path.display())))
            }
        };
        let dirty_content = accepted_map.get(rel_path.as_str());
        if !json_content_differs(
            working_content.as_deref(),
            dirty_content.map(|v| v.as_slice()),
        ) {
            continue;
        }
        match working_content {
            Some(bytes) => {
                accepted_map.insert(rel_path.clone(), bytes);
            }
            None => {
                accepted_map.remove(&rel_path);
            }
        }
        accepted_paths.push(rel_path);
    }
    if accepted_paths.is_empty() {
        return Ok(AcceptAllResult::default());
    }

    let commit_msg = format!("Accept all local changes in {}", repo_folder);
    let new_dirty_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &accepted_map,
        &commit_msg,
    )?;
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    update_reviewed_dirty(ctx, &new_dirty_hash)?;

    Ok(AcceptAllResult {
        files_accepted: accepted_paths.len() as i32,
        accepted_paths,
    })
}

fn unreviewed_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    unreviewed_entries_from_status(ctx)
}

fn unreviewed_entries_from_status(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    let status_entries = crate::git_ops::worktree_status_entries(&ctx.dirty_dir)?;
    let mut entries = Vec::new();
    for entry in status_entries {
        if entry.path.starts_with(".scratch/") {
            continue;
        }
        let status = if entry.x == b'?' && entry.y == b'?' {
            "added"
        } else if entry.y == b'M' {
            "modified"
        } else if entry.y == b'D' {
            "deleted"
        } else {
            continue;
        };
        entries.push(UnreviewedEntry {
            connection_name: ctx.conn_dir_name.clone(),
            path: entry.path,
            status: status.to_string(),
        });
    }
    Ok(entries)
}

fn unpublished_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let dirty_map = match dirty_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    let main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    let main_map = match main_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    // Reuse the same diff logic: main is the base, dirty is the "local" side
    Ok(compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &main_map,
        &dirty_map,
    ))
}

fn force_upload_single_repo(ctx: &ConnectionContext, token: &str) -> anyhow::Result<bool> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;

    if maps_equal(&base_map, &local_map) {
        return Ok(false);
    }

    commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &local_map,
        "Force-upload from Scratch CLI",
    )?;
    crate::git_ops::force_push_origin_dirty(&ctx.bare_repo, token)?;
    Ok(true)
}

fn git_rev_parse(bare_repo: &Path, rev: &str) -> anyhow::Result<String> {
    crate::git_ops::rev_parse_to_string(bare_repo, rev)
}

fn git_rev_parse_optional(bare_repo: &Path, rev: &str) -> anyhow::Result<Option<String>> {
    crate::git_ops::rev_parse_optional_to_string(bare_repo, rev)
}

fn git_update_ref(bare_repo: &Path, refname: &str, object: &str) -> anyhow::Result<()> {
    crate::git_ops::update_ref(bare_repo, refname, object)
}

fn commit_file_map_to_dirty_ref(
    bare_repo: &Path,
    parent_hash: Option<&str>,
    files: &FileMap,
    message: &str,
) -> anyhow::Result<String> {
    crate::git_ops::commit_file_map_to_ref(
        bare_repo,
        "refs/heads/dirty",
        parent_hash,
        files,
        message,
    )
}

fn read_git_tree(bare_repo: &Path, hash: &str) -> anyhow::Result<FileMap> {
    crate::git_ops::read_tree_files(bare_repo, hash)
}

fn read_materialized_repo(ctx: &ConnectionContext) -> anyhow::Result<FileMap> {
    let mut map = FileMap::new();
    read_dirty_disk(&ctx.dirty_dir, &ctx.dirty_dir, &mut map)?;
    read_scratch_disk(&ctx.scratch_dir, &ctx.scratch_dir, &mut map)?;
    Ok(map)
}

fn accept_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    base_map: &FileMap,
    local_map: &FileMap,
) -> anyhow::Result<(FileMap, FieldCommandResult)> {
    let mut next_dirty_map = base_map.clone();
    let mut result = FieldCommandResult::default();

    for path in iter_data_paths_in_folder(base_map, local_map, None, repo_folder) {
        let Some(local_content) = local_map.get(path.as_str()) else {
            continue;
        };
        let base_content = base_map.get(path.as_str());

        if let Some(base_content) = base_content {
            let local_obj = parse_json_object_bytes(local_content, path.as_str())?;
            let base_obj = parse_json_object_bytes(base_content, path.as_str())?;
            let local_value = read_nested_json_value(&local_obj, field);
            let base_value = read_nested_json_value(&base_obj, field);

            if local_value == base_value {
                continue;
            }

            let mut accepted_obj = base_obj;
            apply_nested_json_value(&mut accepted_obj, field, local_value);
            next_dirty_map.insert(path.clone(), json_object_to_bytes(&accepted_obj)?);
        } else {
            let local_obj = parse_json_object_bytes(local_content, path.as_str())?;
            let Some(local_value) = read_nested_json_value(&local_obj, field) else {
                continue;
            };

            let mut accepted_obj = JsonMap::new();
            apply_nested_json_value(&mut accepted_obj, field, Some(local_value));
            next_dirty_map.insert(path.clone(), json_object_to_bytes(&accepted_obj)?);
        }

        result
            .changed_paths
            .push(format!("{}/{}", ctx.conn_dir_name, path));
        result.dirty_changed = true;
    }

    Ok((next_dirty_map, result))
}

fn reject_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    base_map: &FileMap,
    local_map: &FileMap,
    master_map: &FileMap,
) -> anyhow::Result<(FileMap, FileMap, FieldCommandResult)> {
    let mut next_local_map = local_map.clone();
    let mut next_dirty_map = base_map.clone();
    let mut result = FieldCommandResult::default();

    for path in iter_data_paths_in_folder(base_map, local_map, Some(master_map), repo_folder) {
        let local_content = local_map.get(path.as_str());
        let base_content = base_map.get(path.as_str());
        let master_content = master_map.get(path.as_str());

        if local_content.is_none() && base_content.is_some() {
            // Deleted locally: field-level reject is a no-op for deleted files.
            continue;
        }

        if base_content.is_none() && local_content.is_none() {
            // Master-only file (for example an unpublished deletion): not a field-level target.
            continue;
        }

        let changed = match (local_content, base_content) {
            (Some(local_content), Some(base_content)) => {
                let local_obj = parse_json_object_bytes(local_content, path.as_str())?;
                let base_obj = parse_json_object_bytes(base_content, path.as_str())?;
                let master_obj = match master_content {
                    Some(content) => Some(parse_json_object_bytes(content, path.as_str())?),
                    None => None,
                };

                let local_value = read_nested_json_value(&local_obj, field);
                let base_value = read_nested_json_value(&base_obj, field);
                let master_value = master_obj
                    .as_ref()
                    .and_then(|obj| read_nested_json_value(obj, field));

                if local_value != base_value {
                    let mut next_local_obj = local_obj;
                    apply_nested_json_value(&mut next_local_obj, field, base_value);
                    next_local_map.insert(path.clone(), json_object_to_bytes(&next_local_obj)?);
                    true
                } else if base_value != master_value {
                    let mut next_local_obj = local_obj;
                    let mut next_dirty_obj = base_obj;
                    apply_nested_json_value(&mut next_local_obj, field, master_value.clone());
                    apply_nested_json_value(&mut next_dirty_obj, field, master_value);
                    next_local_map.insert(path.clone(), json_object_to_bytes(&next_local_obj)?);
                    next_dirty_map.insert(path.clone(), json_object_to_bytes(&next_dirty_obj)?);
                    result.dirty_changed = true;
                    true
                } else {
                    false
                }
            }
            (Some(local_content), None) => {
                let local_obj = parse_json_object_bytes(local_content, path.as_str())?;
                let local_value = read_nested_json_value(&local_obj, field);
                if local_value.is_none() {
                    false
                } else {
                    let mut next_local_obj = local_obj;
                    apply_nested_json_value(&mut next_local_obj, field, None);
                    if next_local_obj.is_empty() {
                        next_local_map.remove(path.as_str());
                    } else {
                        next_local_map.insert(path.clone(), json_object_to_bytes(&next_local_obj)?);
                    }
                    true
                }
            }
            (None, None) => false,
            (None, Some(_)) => false,
        };

        if changed {
            result
                .changed_paths
                .push(format!("{}/{}", ctx.conn_dir_name, path));
        }
    }

    Ok((next_local_map, next_dirty_map, result))
}

fn iter_data_paths_in_folder(
    base_map: &FileMap,
    local_map: &FileMap,
    master_map: Option<&FileMap>,
    repo_folder: &str,
) -> Vec<String> {
    let mut paths = std::collections::BTreeSet::new();

    for key in base_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    for key in local_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    if let Some(master_map) = master_map {
        for key in master_map.keys() {
            if is_data_path_in_folder(key, repo_folder) {
                paths.insert(key.clone());
            }
        }
    }

    paths.into_iter().collect()
}

fn is_data_path_in_folder(path: &str, repo_folder: &str) -> bool {
    !path.starts_with(".scratch/")
        && path.ends_with(".json")
        && (repo_folder.is_empty() || path.starts_with(&format!("{repo_folder}/")))
}

fn parse_json_object_bytes(
    content: &[u8],
    path: &str,
) -> anyhow::Result<JsonMap<String, JsonValue>> {
    let parsed: JsonValue = serde_json::from_slice(content)
        .map_err(|err| anyhow::anyhow!("Failed to parse JSON in '{}': {}", path, err))?;
    match parsed {
        JsonValue::Object(obj) => Ok(obj),
        _ => anyhow::bail!(
            "JSON record '{}' must have an object at the top level.",
            path
        ),
    }
}

fn json_object_to_bytes(object: &JsonMap<String, JsonValue>) -> anyhow::Result<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(&JsonValue::Object(
        object.clone(),
    ))?)
}

fn read_nested_json_value(object: &JsonMap<String, JsonValue>, field: &str) -> Option<JsonValue> {
    let mut current = object.get(field.split('.').next()?)?;
    let mut parts = field.split('.');
    parts.next()?;

    for part in parts {
        current = current.as_object()?.get(part)?;
    }

    Some(current.clone())
}

fn apply_nested_json_value(
    object: &mut JsonMap<String, JsonValue>,
    field: &str,
    value: Option<JsonValue>,
) {
    let parts: Vec<&str> = field.split('.').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return;
    }
    apply_nested_json_value_parts(object, &parts, value);
}

fn apply_nested_json_value_parts(
    object: &mut JsonMap<String, JsonValue>,
    parts: &[&str],
    value: Option<JsonValue>,
) -> bool {
    if parts.len() == 1 {
        match value {
            Some(value) => {
                object.insert(parts[0].to_string(), value);
            }
            None => {
                object.remove(parts[0]);
            }
        }
        return object.is_empty();
    }

    let key = parts[0].to_string();
    let child = object
        .entry(key.clone())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if !child.is_object() {
        *child = JsonValue::Object(JsonMap::new());
    }
    let should_prune =
        apply_nested_json_value_parts(child.as_object_mut().unwrap(), &parts[1..], value);
    if should_prune {
        object.remove(&key);
    }
    object.is_empty()
}

fn apply_changed_working_files(
    ctx: &ConnectionContext,
    previous_local_map: &FileMap,
    next_local_map: &FileMap,
    repo_folder: &str,
) -> anyhow::Result<()> {
    for path in iter_data_paths_in_folder(previous_local_map, next_local_map, None, repo_folder) {
        let before = previous_local_map.get(path.as_str());
        let after = next_local_map.get(path.as_str());
        if before == after {
            continue;
        }

        let disk_path = ctx.dirty_dir.join(&path);
        match after {
            Some(content) => write_file(&disk_path, content)?,
            None => {
                if disk_path.exists() {
                    std::fs::remove_file(&disk_path)?;
                }
            }
        }
    }

    Ok(())
}

fn read_dirty_disk(root: &Path, dir: &Path, map: &mut FileMap) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;

        if ft.is_dir() {
            match name_str.as_ref() {
                "syncs" => continue,
                value if value.starts_with('.') => continue,
                _ => read_dirty_disk(root, &entry.path(), map)?,
            }
        } else if ft.is_file() {
            if name_str.starts_with('.') {
                continue;
            }
            let rel = entry.path().strip_prefix(root)?.to_slash_lossy();
            let content = normalize_crlf(std::fs::read(entry.path())?);
            map.insert(rel, content);
        }
    }

    Ok(())
}

fn read_scratch_disk(root: &Path, dir: &Path, map: &mut FileMap) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;

        if ft.is_dir() {
            if name_str.starts_with('.') && name_str != ".publish-plans" {
                continue;
            }
            read_scratch_disk(root, &entry.path(), map)?;
        } else if ft.is_file() {
            if name_str.starts_with('.') {
                continue;
            }
            let rel = entry.path().strip_prefix(root)?.to_slash_lossy();
            let content = normalize_crlf(std::fs::read(entry.path())?);
            map.insert(format!(".scratch/{rel}"), content);
        }
    }

    Ok(())
}

/// Reconcile the on-disk state of `ctx.dirty_dir` (user working tree) and
/// `ctx.scratch_dir` (per-connection schema/validation/publish-plan files)
/// with `target_map`.
///
/// **Diff-aware.** Files whose content matches `current_map` are left alone
/// — their mtime is preserved. Only paths whose content differs are
/// rewritten; only paths present in `current_map` but missing from
/// `target_map` are deleted. Anything outside `current_map` (hidden files,
/// the `syncs/` subdir, anything `read_dirty_disk` / `read_scratch_disk`
/// chose to skip) is untouched.
///
/// Why this matters: `folder_index::find_stale_files` flags a file as
/// stale whenever its working-tree mtime drifts from the stored value.
/// A wholesale clear-and-rewrite (the previous behavior) bumped every
/// file's mtime on every download, defeating the per-path index updates
/// downstream.
///
/// `current_map` is the snapshot the caller already obtained from
/// `read_materialized_repo`. Passing it in avoids re-walking the
/// filesystem here.
fn materialize_local_repo(
    ctx: &ConnectionContext,
    target_map: &FileMap,
    current_map: &FileMap,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(&ctx.dirty_dir)?;
    std::fs::create_dir_all(&ctx.scratch_dir)?;

    // Resolve a rel_path into its on-disk path under either `dirty_dir` or
    // `scratch_dir`. Returns `None` for `.scratch` (bare, no trailing slash)
    // and similar oddities — those don't materialize to a real file.
    let resolve_disk_path = |rel_path: &str| -> Option<PathBuf> {
        if let Some(scratch_rel) = rel_path.strip_prefix(".scratch/") {
            Some(ctx.scratch_dir.join(scratch_rel))
        } else if !rel_path.starts_with(".scratch") {
            Some(ctx.dirty_dir.join(rel_path))
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

/// Reconcile on-disk folders under `dirty_dir` with the server's folder list.
///
/// 1. Creates a directory for every folder path (parents included).
/// 2. Prunes any local directory not in the server set, but only if empty —
///    non-empty dirs are owned by the record-file merge path.
pub fn reconcile_data_folder_dirs(
    dirty_dir: &Path,
    data_folders: &[DataFolder],
) -> anyhow::Result<()> {
    if !dirty_dir.exists() {
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
        let target = dirty_dir.join(trimmed);
        std::fs::create_dir_all(&target)
            .with_context(|| format!("create empty data folder dir {}", target.display()))?;
        // Mark every ancestor up to dirty_dir as wanted so the pruner leaves
        // the chain of intermediate folders alone, even when they are not
        // themselves separate DataFolder entries.
        for ancestor in target.ancestors() {
            if ancestor == dirty_dir {
                break;
            }
            wanted.insert(ancestor.to_path_buf());
        }
    }

    prune_empty_unknown_dirs(dirty_dir, &wanted)?;
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

/// Rebase the current working tree from `old_map` to `new_map`, treating the
/// working tree as local edits on top of `old_map`.
fn is_scratch_path(path: &str) -> bool {
    path.starts_with(".scratch/")
}

fn scratch_only_map(map: &FileMap) -> FileMap {
    map.iter()
        .filter(|(path, _)| is_scratch_path(path))
        .map(|(path, value)| (path.clone(), value.clone()))
        .collect()
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
    local_map: &FileMap,
) -> Vec<UnreviewedEntry> {
    let base_data = data_only_map(base_map);
    let local_data = data_only_map(local_map);
    let mut all_paths: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();

    for key in base_data.keys() {
        all_paths.insert(key);
    }
    for key in local_data.keys() {
        all_paths.insert(key);
    }

    let mut entries = Vec::new();
    for path in all_paths {
        match (base_data.get(path), local_data.get(path)) {
            (None, Some(_)) => entries.push(UnreviewedEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "added".to_string(),
            }),
            (Some(_), None) => entries.push(UnreviewedEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "deleted".to_string(),
            }),
            (Some(base), Some(local)) if base != local => entries.push(UnreviewedEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "modified".to_string(),
            }),
            _ => {}
        }
    }

    entries
}

fn sync_schema_files_from_master(ctx: &ConnectionContext) -> anyhow::Result<()> {
    let master_scratch_dir = ctx.master_dir.join(".scratch");
    sync_schema_files_dir(&master_scratch_dir, &master_scratch_dir, &ctx.scratch_dir)
}

fn sync_schema_files_dir(root: &Path, dir: &Path, scratch_dir: &Path) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            sync_schema_files_dir(root, &path, scratch_dir)?;
            continue;
        }

        if !ft.is_file() || entry.file_name() != "schema.json" {
            continue;
        }

        let rel = path.strip_prefix(root)?;
        write_file(&scratch_dir.join(rel), &std::fs::read(&path)?)?;
    }

    Ok(())
}

fn write_file(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

enum MergeAction {
    KeepLocal {
        path: String,
        content: Option<Vec<u8>>,
        warning: Option<String>,
    },
    WriteRemote {
        path: String,
        content: Option<Vec<u8>>,
    },
    Delete {
        path: String,
        warning: Option<String>,
    },
    Merge {
        path: String,
        base: Vec<u8>,
        local: Vec<u8>,
        remote: Vec<u8>,
    },
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

fn compute_merge_actions(base: &FileMap, local: &FileMap, remote: &FileMap) -> Vec<MergeAction> {
    let mut all_paths: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for key in base.keys() {
        all_paths.insert(key);
    }
    for key in local.keys() {
        all_paths.insert(key);
    }
    for key in remote.keys() {
        all_paths.insert(key);
    }

    let mut actions = Vec::new();

    for path in all_paths {
        let base_content = base.get(path);
        let local_content = local.get(path);
        let remote_content = remote.get(path);

        let local_changed = local_content != base_content;
        let remote_changed = remote_content != base_content;

        if !local_changed {
            match remote_content {
                Some(content) => actions.push(MergeAction::WriteRemote {
                    path: path.to_string(),
                    content: Some(content.clone()),
                }),
                None if base_content.is_some() => actions.push(MergeAction::Delete {
                    path: path.to_string(),
                    warning: None,
                }),
                None => {}
            }
        } else if !remote_changed {
            match local_content {
                Some(content) => actions.push(MergeAction::KeepLocal {
                    path: path.to_string(),
                    content: Some(content.clone()),
                    warning: None,
                }),
                None => actions.push(MergeAction::Delete {
                    path: path.to_string(),
                    warning: None,
                }),
            }
        } else {
            match (local_content, remote_content) {
                (Some(local_content), Some(remote_content)) => {
                    if let Some(base_content) = base_content {
                        actions.push(MergeAction::Merge {
                            path: path.to_string(),
                            base: base_content.clone(),
                            local: local_content.clone(),
                            remote: remote_content.clone(),
                        });
                    } else {
                        // Both sides added the same path with no merge base. This happens
                        // after publish creates a remote record from a local new file:
                        // the remote copy is the authoritative enriched version (for
                        // example with server-assigned IDs/timestamps), so prefer it.
                        actions.push(MergeAction::WriteRemote {
                            path: path.to_string(),
                            content: Some(remote_content.clone()),
                        });
                    }
                }
                (Some(local_content), None) => actions.push(MergeAction::KeepLocal {
                    path: path.to_string(),
                    content: Some(local_content.clone()),
                    warning: Some(format!(
                        "Remote deleted {} but local has changes; keeping local version",
                        path
                    )),
                }),
                (None, Some(remote_content)) => actions.push(MergeAction::WriteRemote {
                    path: path.to_string(),
                    content: Some(remote_content.clone()),
                }),
                (None, None) => actions.push(MergeAction::Delete {
                    path: path.to_string(),
                    warning: None,
                }),
            }
        }
    }

    actions
}

fn prepare_upload_merge(
    base_map: &FileMap,
    local_map: &FileMap,
    remote_map: &FileMap,
    attempt: i32,
) -> (FileMap, UploadResult, Vec<String>) {
    let actions = compute_merge_actions(base_map, local_map, remote_map);

    let mut merged = remote_map.clone();
    let mut messages = Vec::new();
    let mut result = UploadResult {
        status: "uploaded".to_string(),
        retries: attempt,
        ..Default::default()
    };

    for act in &actions {
        match act {
            MergeAction::KeepLocal {
                path,
                content,
                warning,
            } => {
                match content {
                    Some(content) => {
                        merged.insert(path.clone(), content.clone());
                        if remote_map
                            .get(path.as_str())
                            .map(|remote| remote != content)
                            .unwrap_or(true)
                        {
                            result.files_uploaded += 1;
                            result.uploaded_paths.push(path.clone());
                        }
                    }
                    None => {
                        merged.remove(path.as_str());
                        if remote_map.contains_key(path.as_str()) {
                            result.files_deleted += 1;
                            result.deleted_paths.push(path.clone());
                        }
                    }
                }
                if let Some(warning) = warning {
                    messages.push(warning.clone());
                }
            }
            MergeAction::WriteRemote { path, content } => match content {
                Some(content) => {
                    merged.insert(path.clone(), content.clone());
                }
                None => {
                    merged.remove(path.as_str());
                }
            },
            MergeAction::Delete { path, warning } => {
                merged.remove(path.as_str());
                if remote_map.contains_key(path.as_str()) {
                    result.files_deleted += 1;
                    result.deleted_paths.push(path.clone());
                }
                if let Some(warning) = warning {
                    messages.push(warning.clone());
                }
            }
            MergeAction::Merge {
                path,
                base,
                local,
                remote,
            } => {
                let content = merge_content(path, Some(base), Some(local), Some(remote));
                merged.insert(path.clone(), content);
                result.files_merged += 1;
                result.merged_paths.push(path.clone());
                result.conflicts_auto_resolved += 1;
            }
        }
    }

    (merged, result, messages)
}

fn merge_content(
    _path: &str,
    base: Option<&Vec<u8>>,
    local: Option<&Vec<u8>>,
    remote: Option<&Vec<u8>>,
) -> Vec<u8> {
    if local.map(|value| is_binary(value)).unwrap_or(false)
        || remote.map(|value| is_binary(value)).unwrap_or(false)
    {
        return local.or(remote).cloned().unwrap_or_default();
    }

    let base_str = base
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .unwrap_or_default();
    let local_str = local
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .unwrap_or_default();
    let remote_str = remote
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .unwrap_or_default();

    match crate::shared::merge::merge_file_contents(&base_str, &local_str, &remote_str) {
        Ok(merged) => merged.into_bytes(),
        Err(_) => local.cloned().unwrap_or_default(),
    }
}

fn is_binary(data: &[u8]) -> bool {
    data.contains(&0)
}

fn normalize_crlf(data: Vec<u8>) -> Vec<u8> {
    if !data.contains(&b'\r') || is_binary(&data) {
        return data;
    }

    let mut out = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        if data[index] == b'\r' && index + 1 < data.len() && data[index + 1] == b'\n' {
            index += 1;
        } else {
            out.push(data[index]);
        }
        index += 1;
    }
    out
}

fn maps_equal(left: &FileMap, right: &FileMap) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .all(|(key, value)| right.get(key).map(|other| other == value).unwrap_or(false))
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
        agg.files_uploaded += result.files_uploaded;
        agg.files_merged += result.files_merged;
        agg.files_deleted += result.files_deleted;
        agg.files_plan += result.files_plan;
        agg.conflicts_auto_resolved += result.conflicts_auto_resolved;
        agg.retries += result.retries;
        agg.messages.extend(result.messages.iter().cloned());
        agg.uploaded_paths
            .extend(result.uploaded_paths.iter().cloned());
        agg.merged_paths.extend(result.merged_paths.iter().cloned());
        agg.deleted_paths
            .extend(result.deleted_paths.iter().cloned());
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

fn print_upload_result(result: &UploadResult, elapsed_ms: u128, json: bool) -> anyhow::Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": result.status,
                "filesUploaded": result.files_uploaded,
                "filesMerged": result.files_merged,
                "filesDeleted": result.files_deleted,
                "filesPlan": result.files_plan,
                "conflictsAutoResolved": result.conflicts_auto_resolved,
                "retries": result.retries,
                "messages": result.messages,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    let elapsed = format_elapsed(elapsed_ms);
    if result.status == "no_changes" {
        println!("No local changes to upload. ({})", elapsed);
        for message in &result.messages {
            println!("Warning: {}", message);
        }
        return Ok(());
    }
    if result.status == "up_to_date" {
        println!("Remote already has all local changes. ({})", elapsed);
        for message in &result.messages {
            println!("Warning: {}", message);
        }
        return Ok(());
    }

    let total = result.files_uploaded + result.files_merged + result.files_deleted;
    if total == 0 && result.files_plan == 0 {
        println!("No changes. ({})", elapsed);
        return Ok(());
    }

    println!();
    let mut parts = Vec::new();
    if result.files_uploaded > 0 {
        parts.push(format!("{} uploaded", result.files_uploaded));
    }
    if result.files_merged > 0 {
        parts.push(format!("{} merged", result.files_merged));
    }
    if result.files_deleted > 0 {
        parts.push(format!("{} deleted", result.files_deleted));
    }
    if result.files_plan > 0 {
        parts.push(format!("{} plan files pushed", result.files_plan));
    }
    println!("{} ({})", parts.join(", "), elapsed);
    print_file_list(&result.uploaded_paths);
    print_file_list(&result.merged_paths);
    print_file_list(&result.deleted_paths);
    for message in &result.messages {
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

fn rebuild_index_for_conn(ctx: &ConnectionContext, quiet: bool) {
    if !ctx.master_dir.exists() {
        return;
    }
    if let Some(parent) = ctx.db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !quiet {
        eprint!("  Rebuilding index for {}... ", ctx.conn_dir_name);
    }
    match crate::shared::index::build(&ctx.master_dir, &ctx.db_path) {
        Ok(count) => {
            if !quiet {
                eprintln!("{count} file(s)");
            }
        }
        Err(err) => {
            if !quiet {
                eprintln!("warning: index rebuild failed: {err}");
            }
        }
    }
}

/// Outcome of `update_master_worktree` for a single connection. Callers use
/// `moved` to gate work that only matters when master actually advanced
/// (sync_schema_files_from_master, rebuild_index_for_conn) and
/// `changed_paths` to drive a targeted folder_index reindex.
#[derive(Default)]
struct MasterUpdateResult {
    /// `true` iff `refs/heads/main` advanced from its previous tip during
    /// this call (or was created from scratch).
    moved: bool,
    /// Repo-relative data paths whose blob OID changed between the old and
    /// new master tree. Empty when `moved` is false. Excludes `.scratch/`.
    changed_paths: Vec<String>,
}

fn update_master_worktree(
    ctx: &ConnectionContext,
    token: &str,
) -> anyhow::Result<MasterUpdateResult> {
    let _ = crate::git_ops::fetch_origin(&ctx.bare_repo, token);
    let Some(new_main_hash) = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
    else {
        return Ok(MasterUpdateResult::default());
    };
    let old_main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?;
    let moved = old_main_hash.as_deref() != Some(new_main_hash.as_str());

    // Always run the worktree-update steps — they're idempotent when master
    // is already up to date, and they recover from a state where the ref
    // moved earlier but materialization didn't complete.
    git_update_ref(&ctx.bare_repo, "refs/heads/main", &new_main_hash)?;
    crate::git_ops::ensure_sparse_worktree(&ctx.bare_repo, &ctx.master_dir, "refs/heads/main")?;
    crate::git_ops::worktree_reset_hard(&ctx.master_dir, &new_main_hash)?;

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
