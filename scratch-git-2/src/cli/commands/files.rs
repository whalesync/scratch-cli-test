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
    /// the desktop surfaces this as a non-blocking banner.
    staleness_warning: Option<crate::api::StalenessWarning>,
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
    /// True iff the call mutated `accepted-patches.json`. Caller decides
    /// whether to save_atomic. Reject leaves this false (reject never writes
    /// to the patch file — see decision 35); accept and discard set it when
    /// they upsert or remove an entry.
    patches_changed: bool,
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
            // resync them into ctx.scratch_dir. Gated on `moved` so unchanged
            // connections pay zero cost in the per-ctx loop.
            let _ = sync_schema_files_from_master(ctx);
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

    let aggregate = aggregate_upload(&results);
    print_upload_result(&aggregate, &results, started.elapsed().as_millis(), json)
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
                .map_err(|e| {
                    anyhow::anyhow!("run-job poll failed for {}: {e}", ctx.conn_dir_name)
                })?;
        }
        if verbose {
            eprintln!(" done");
        }

        // After a successful publish, the server's `main` has advanced for
        // this connector. Fetch + advance the local `main` ref so the next
        // `files upload` correctly sees no diff against the local patch file.
        crate::git_ops::fetch_origin(&ctx.bare_repo, &token)?;
        if let Some(new_main_hash) =
            git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
        {
            git_update_ref(&ctx.bare_repo, "refs/heads/main", &new_main_hash)?;
        }

        // Patches that drove this publish are now reflected in `refs/heads/
        // main`, so the local accepted-patches file should be empty going
        // forward. (Single-user assumption: the user doesn't `accept` more
        // changes between `upload` and `publish`. If they did, those entries
        // are lost — slice D's pull re-anchor will reintroduce a tighter
        // model later.)
        let layout = WorkspaceLayout::for_cli(&workspace_dir);
        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        crate::config::accepted_patches::clear(&connection_dir)?;

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

        let main_map = read_main_tree(&ctx.bare_repo)?;
        sync_schema_files_from_master(ctx)?;
        let local_map = read_materialized_repo(ctx)?;

        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
        let approved_map = compute_accepted_state(&main_map, &accepted_file)?;

        let changes = compute_unreviewed_entries(&ctx.conn_dir_name, &approved_map, &local_map);
        let changed_paths: std::collections::HashSet<&str> =
            changes.iter().map(|e| e.path.as_str()).collect();

        // Validate all requested paths have unreviewed changes
        for (input_path, rel_path) in path_pairs {
            if !changed_paths.contains(rel_path.as_str()) {
                anyhow::bail!("No unreviewed local changes for '{}'.", input_path);
            }
        }

        for (_, rel_path) in path_pairs {
            let snapshot = parse_json_value_at(&main_map, rel_path, "refs/heads/main")?;
            let working = parse_json_value_at(&local_map, rel_path, "working tree")?;
            match crate::commands::re_anchor::compute_entry(
                rel_path,
                snapshot.as_ref(),
                working.as_ref(),
            ) {
                Some(entry) => {
                    crate::config::accepted_patches::upsert_entry(&mut accepted_file, entry);
                }
                None => {
                    // Working == published. The unreviewed change was the
                    // user reverting back to main; accepting it means
                    // dropping any accepted-patches entry for this path.
                    crate::config::accepted_patches::remove_entry(&mut accepted_file, rel_path);
                }
            }
        }

        crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
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

        let main_map = read_main_tree(&ctx.bare_repo)?;
        sync_schema_files_from_master(ctx)?;
        let local_map = read_materialized_repo(ctx)?;

        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        let accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
        let approved_map = compute_accepted_state(&main_map, &accepted_file)?;

        let changes = compute_unreviewed_entries(&ctx.conn_dir_name, &approved_map, &local_map);
        let changed_paths: std::collections::HashSet<&str> =
            changes.iter().map(|e| e.path.as_str()).collect();

        for (input_path, rel_path) in path_pairs {
            if !changed_paths.contains(rel_path.as_str()) {
                anyhow::bail!("No unreviewed local changes for '{}'.", input_path);
            }
        }

        // Restore working file to its approved bytes. Accepted-patches
        // file is untouched — reject only undoes the unreviewed delta
        // between working and approved.
        for (_, rel_path) in path_pairs {
            write_or_remove_working_file(
                ctx,
                rel_path,
                approved_map.get(rel_path.as_str()).map(|v| v.as_slice()),
            )?;
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

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);

    let main_map = read_main_tree(&ctx.bare_repo)?;
    sync_schema_files_from_master(&ctx)?;
    let local_map = read_materialized_repo(&ctx)?;
    let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;

    let result = accept_field_in_folder(
        &ctx,
        &repo_folder,
        field,
        &main_map,
        &mut accepted_file,
        &local_map,
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
        crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    }
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

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);

    let main_map = read_main_tree(&ctx.bare_repo)?;
    sync_schema_files_from_master(&ctx)?;
    let local_map = read_materialized_repo(&ctx)?;
    let accepted_file = crate::config::accepted_patches::load(&connection_dir)?;

    let (next_local_map, result) = reject_field_in_folder(
        &ctx,
        &repo_folder,
        field,
        &main_map,
        &accepted_file,
        &local_map,
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

fn run_discard_field(cwd: &Path, folder: &Path, field: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    let (ctx, repo_folder, display_folder) =
        resolve_folder_context(&workspace_dir, &contexts, folder)?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);

    let main_map = read_main_tree(&ctx.bare_repo)?;
    sync_schema_files_from_master(&ctx)?;
    let local_map = read_materialized_repo(&ctx)?;
    let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;

    let (next_local_map, result) = discard_field_in_folder(
        &ctx,
        &repo_folder,
        field,
        &main_map,
        &mut accepted_file,
        &local_map,
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

    apply_changed_working_files(&ctx, &local_map, &next_local_map, &repo_folder)?;
    if result.patches_changed {
        crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    }
    refresh_problem_record_index_for_ctx(&ctx, &result.changed_paths, true)?;

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

/// Post-B "unpushed" and "unpublished" mean the same thing — both surface
/// what's in `accepted-patches.json`. The two CLI commands are kept for
/// back-compat with users / scripts that grew up around the pre-B layout
/// (`unpushed` = local dirty vs local main, `unpublished` = local dirty vs
/// remote main). Once the desktop migrates over, drop one of them.
fn unpushed_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    unpublished_entries(ctx)
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
fn restore_deleted_records_locally(
    ctx: &ConnectionContext,
    rel_paths: &[String],
) -> anyhow::Result<()> {
    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
    let main_map = read_main_tree(&ctx.bare_repo)?;

    let mut to_restore: Vec<(String, Vec<u8>)> = Vec::with_capacity(rel_paths.len());
    for rel_path in rel_paths {
        let display_path = format!("{}/{}", ctx.conn_dir_name, rel_path);
        let Some(entry) = crate::config::accepted_patches::get_entry(&accepted_file, rel_path)
        else {
            anyhow::bail!("'{}' is not an approved deleted record.", display_path);
        };
        if entry.kind != crate::commands::re_anchor::PatchKind::Delete {
            anyhow::bail!("'{}' is not an approved deleted record.", display_path);
        }
        let Some(main_content) = main_map.get(rel_path.as_str()) else {
            anyhow::bail!(
                "'{}' does not exist on main and cannot be restored.",
                display_path
            );
        };
        to_restore.push((rel_path.clone(), main_content.clone()));
    }

    for (rel_path, content) in &to_restore {
        crate::config::accepted_patches::remove_entry(&mut accepted_file, rel_path);
        write_file(&ctx.dirty_dir.join(rel_path), content)?;
    }
    crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
    Ok(())
}

/// Undo an accepted create. For each path: error if there's no `Create` entry
/// in `accepted-patches.json`; error if `refs/heads/main` already has the
/// path. Otherwise: drop the entry, delete the worktree file.
///
/// The remote-cleanup hack (`discard_created_record_remotely`) is invoked by
/// the caller and stays independent of this routine.
fn discard_created_records_locally(
    ctx: &ConnectionContext,
    rel_paths: &[String],
) -> anyhow::Result<()> {
    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
    let main_map = read_main_tree(&ctx.bare_repo)?;

    let mut to_discard: Vec<String> = Vec::with_capacity(rel_paths.len());
    for rel_path in rel_paths {
        let display_path = format!("{}/{}", ctx.conn_dir_name, rel_path);
        if main_map.contains_key(rel_path.as_str()) {
            anyhow::bail!(
                "'{}' exists on main and cannot be discarded as an approved create.",
                display_path
            );
        }
        let Some(entry) = crate::config::accepted_patches::get_entry(&accepted_file, rel_path)
        else {
            anyhow::bail!("'{}' is not an approved created record.", display_path);
        };
        if entry.kind != crate::commands::re_anchor::PatchKind::Create {
            anyhow::bail!("'{}' is not an approved created record.", display_path);
        }
        to_discard.push(rel_path.clone());
    }

    for rel_path in &to_discard {
        crate::config::accepted_patches::remove_entry(&mut accepted_file, rel_path);
        let disk_path = ctx.dirty_dir.join(rel_path);
        if disk_path.exists() {
            std::fs::remove_file(&disk_path).with_context(|| {
                format!("failed to remove working file {}", disk_path.display())
            })?;
        }
    }
    crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
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

/// Load the `refs/heads/main` tree as a `FileMap`. Empty map if the ref
/// doesn't exist yet (fresh workspace, never published).
fn read_main_tree(bare_repo: &Path) -> anyhow::Result<FileMap> {
    match git_rev_parse_optional(bare_repo, "refs/heads/main")? {
        Some(hash) => read_git_tree(bare_repo, &hash),
        None => Ok(FileMap::new()),
    }
}

/// Resolve `<workspace>/.scratch/connections/<conn>` for a context.
///
/// `ctx.workspace_dir` is historically the workbook materialization path
/// (`<workspace>/.scratch/workspace`), not the workspace root, so we derive
/// the root from `ctx.dirty_dir.parent()` (= `<workspace>/<conn>` → parent
/// is `<workspace>`). Callers that need the accepted-patches.json directory
/// (and can't reach the workspace root variable directly) should use this
/// helper.
fn accepted_patches_dir(ctx: &ConnectionContext) -> PathBuf {
    let workspace_root = ctx.dirty_dir.parent().unwrap_or(Path::new("."));
    WorkspaceLayout::for_cli(workspace_root).connection_root_path(&ctx.conn_dir_name)
}

/// Pull a value from a `FileMap` and parse it as JSON, attaching the
/// source name (`refs/heads/main`, `working tree`, …) to any error so the
/// user can see WHICH copy failed to parse.
fn parse_json_value_at(
    map: &FileMap,
    rel_path: &str,
    source: &str,
) -> anyhow::Result<Option<JsonValue>> {
    match map.get(rel_path) {
        Some(bytes) => Ok(Some(serde_json::from_slice(bytes).with_context(|| {
            format!("failed to parse {source} blob at {rel_path} as JSON")
        })?)),
        None => Ok(None),
    }
}

/// Write a single working-tree file, or remove it if `bytes` is `None`.
/// Used by reject / discard to restore approved / published state.
fn write_or_remove_working_file(
    ctx: &ConnectionContext,
    rel_path: &str,
    bytes: Option<&[u8]>,
) -> anyhow::Result<()> {
    let disk_path = ctx.dirty_dir.join(rel_path);
    match bytes {
        Some(content) => write_file(&disk_path, content)?,
        None => {
            if disk_path.exists() {
                std::fs::remove_file(&disk_path).with_context(|| {
                    format!("failed to remove working file {}", disk_path.display())
                })?;
            }
        }
    }
    Ok(())
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
    let (merged_dirty_map, mut messages) =
        prepare_upload_merge(&merge_base_map, &local_dirty_map, &remote_map);

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

    // baseHead is the local `main` for staleness detection on the server —
    // unchanged semantics from the dirty-branch flow.
    let main_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
        .or(git_rev_parse_optional(&ctx.bare_repo, "refs/heads/main")?);

    // Working-tree unreviewed check stays — surface a warning if the user has
    // local edits that aren't accepted yet (those won't be uploaded).
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::config::accepted_patches::load(&connection_dir)?;

    let main_map = read_main_tree(&ctx.bare_repo)?;
    let approved_map = compute_accepted_state(&main_map, &accepted_file)?;
    let local_map = read_materialized_repo(ctx)?;
    let local_unreviewed =
        compute_unreviewed_entries(&ctx.conn_dir_name, &approved_map, &local_map);

    if accepted_file.patches.is_empty() {
        let mut messages = Vec::new();
        if !local_unreviewed.is_empty() {
            messages.push(format!(
                "{} record(s) have unreviewed local changes and will not be uploaded. Run `scratchmd files accept-all` first.",
                local_unreviewed.len()
            ));
        }
        return Ok(UploadResult {
            connection_name: ctx.conn_dir_name.clone(),
            status: "no_changes".to_string(),
            messages,
            ..Default::default()
        });
    }

    use crate::commands::re_anchor::PatchKind as AnchoredKind;
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

    // `accepted-patches.json` IS the wire format (minus the local `kind`
    // tag, which the server infers from the patch shape). Ship it verbatim.
    let payload = crate::api::UploadPatchPayload {
        patches: accepted_file
            .patches
            .iter()
            .map(|p| crate::api::UploadPatchEntry {
                path: p.path.clone(),
                patch: p.patch.clone(),
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
        staleness_warning: commit.staleness_warning,
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
fn discard_all_single_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<DiscardAllResult> {
    let _ = workspace_dir; // retained for caller-site parity with accept_all/reject_all.
    sync_schema_files_from_master(ctx)?;
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

    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;

    let local_map = read_materialized_repo(ctx)?;
    let approved_map = compute_accepted_state(&main_map, &accepted_file)?;
    let unreviewed = compute_unreviewed_entries(&ctx.conn_dir_name, &approved_map, &local_map);

    let path_in_scope = |path: &str| match repo_folder {
        Some(folder) => is_data_path_in_folder(path, folder),
        None => is_data_path_in_folder(path, ""),
    };

    // Union of (paths with patch entries) and (paths with unreviewed working
    // edits). Either makes the path "non-published" and therefore in scope for
    // discard-back-to-main.
    let mut affected_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in &accepted_file.patches {
        if path_in_scope(&entry.path) {
            affected_paths.insert(entry.path.clone());
        }
    }
    for entry in &unreviewed {
        if path_in_scope(&entry.path) {
            affected_paths.insert(entry.path.clone());
        }
    }

    if affected_paths.is_empty() {
        return Ok(DiscardAllResult::default());
    }

    let mut patches_changed = false;
    for path in &affected_paths {
        if crate::config::accepted_patches::get_entry(&accepted_file, path).is_some() {
            crate::config::accepted_patches::remove_entry(&mut accepted_file, path);
            patches_changed = true;
        }
        write_or_remove_working_file(ctx, path, main_map.get(path.as_str()).map(|v| v.as_slice()))?;
    }

    if patches_changed {
        crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;
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
fn discard_paths_single_repo(
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
    let main_map = read_main_tree(&ctx.bare_repo)?;

    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;

    let connection_dir = accepted_patches_dir(ctx);
    let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
    let approved_map = compute_accepted_state(&main_map, &accepted_file)?;

    // A path is "discardable" if it has a patch entry (approved differs
    // from published) or an unreviewed edit (working differs from
    // approved). The discard target is the same either way: reset to
    // published.
    let entry_paths: std::collections::HashSet<String> = accepted_file
        .patches
        .iter()
        .map(|e| e.path.clone())
        .collect();
    let unreviewed = compute_unreviewed_entries(&ctx.conn_dir_name, &approved_map, &local_map);
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
        crate::config::accepted_patches::remove_entry(&mut accepted_file, rel);
        write_or_remove_working_file(ctx, rel, main_map.get(rel.as_str()).map(|v| v.as_slice()))?;
    }

    crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;

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
fn accept_all_single_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<AcceptAllResult> {
    let _ = workspace_dir;
    sync_schema_files_from_master(ctx)?;
    accept_all_full_scan(ctx, repo_folder)
}

fn accept_all_full_scan(
    ctx: &ConnectionContext,
    repo_folder: Option<&str>,
) -> anyhow::Result<AcceptAllResult> {
    let connection_dir = accepted_patches_dir(ctx);

    let main_map = read_main_tree(&ctx.bare_repo)?;
    let mut accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
    let approved_map = compute_accepted_state(&main_map, &accepted_file)?;
    let local_map = read_materialized_repo(ctx)?;

    let all_changes = compute_unreviewed_entries(&ctx.conn_dir_name, &approved_map, &local_map);
    let changes: Vec<UnreviewedEntry> = match repo_folder {
        Some(folder) => all_changes
            .into_iter()
            .filter(|entry| is_data_path_in_folder(&entry.path, folder))
            .collect(),
        None => all_changes,
    };

    if changes.is_empty() {
        return Ok(AcceptAllResult::default());
    }

    for entry in &changes {
        let snapshot = parse_json_value_at(&main_map, &entry.path, "refs/heads/main")?;
        let working = parse_json_value_at(&local_map, &entry.path, "working tree")?;
        match crate::commands::re_anchor::compute_entry(
            &entry.path,
            snapshot.as_ref(),
            working.as_ref(),
        ) {
            Some(new_entry) => {
                crate::config::accepted_patches::upsert_entry(&mut accepted_file, new_entry);
            }
            None => {
                // No-op accept (working == main with no patch needed). Drop any
                // stale entry so the file ends up genuinely at published.
                crate::config::accepted_patches::remove_entry(&mut accepted_file, &entry.path);
            }
        }
    }

    crate::config::accepted_patches::save_atomic(&connection_dir, &accepted_file)?;

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
fn reject_all_single_repo(
    ctx: &ConnectionContext,
    workspace_dir: &Path,
    repo_folder: Option<&str>,
) -> anyhow::Result<RejectAllResult> {
    let _ = workspace_dir;
    sync_schema_files_from_master(ctx)?;
    reject_all_full_scan(ctx, repo_folder)
}

fn reject_all_full_scan(
    ctx: &ConnectionContext,
    repo_folder: Option<&str>,
) -> anyhow::Result<RejectAllResult> {
    let connection_dir = accepted_patches_dir(ctx);

    let main_map = read_main_tree(&ctx.bare_repo)?;
    let accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
    let approved_map = compute_accepted_state(&main_map, &accepted_file)?;
    let local_map = read_materialized_repo(ctx)?;

    let all_changes = compute_unreviewed_entries(&ctx.conn_dir_name, &approved_map, &local_map);
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

    for entry in &changes {
        write_or_remove_working_file(
            ctx,
            &entry.path,
            approved_map.get(entry.path.as_str()).map(|v| v.as_slice()),
        )?;
    }

    Ok(RejectAllResult {
        files_rejected: changes.len() as i32,
        rejected_paths: changes.into_iter().map(|entry| entry.path).collect(),
    })
}

/// Files whose working content differs from approved (= what's in
/// `apply(main, accepted-patches.json)`). These are local edits that haven't
/// been accepted yet.
fn unreviewed_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
    let main_map = read_main_tree(&ctx.bare_repo)?;
    let approved_map = compute_accepted_state(&main_map, &accepted_file)?;
    let local_map = read_materialized_repo(ctx)?;
    Ok(compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &approved_map,
        &local_map,
    ))
}

/// Files with an entry in `accepted-patches.json` — i.e. approved but not
/// yet published. One UnreviewedEntry per patch entry; status comes from the
/// patch kind.
fn unpublished_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    use crate::commands::re_anchor::PatchKind;
    let connection_dir = accepted_patches_dir(ctx);
    let accepted_file = crate::config::accepted_patches::load(&connection_dir)?;
    Ok(accepted_file
        .patches
        .iter()
        .map(|entry| UnreviewedEntry {
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

/// Folder-scoped, field-level accept. For each file in `repo_folder` where
/// `local[field] != approved[field]`, fold that field's local value into the
/// file's `accepted-patches.json` entry (creating, updating, or removing the
/// entry as the new approved state demands). Working files are NOT touched —
/// accept moves the patch, not the worktree.
///
/// The approved state for a path is `apply(main_blob, patch_entry)` when an
/// entry exists, else `main_blob` itself. The new patch entry comes from
/// `re_anchor::compute_entry(path, main, next_approved)`, which produces the
/// right `Create` / `Update` / `Delete` shape automatically.
///
/// Whole-file deletes (`local` missing, anything in approved) are skipped —
/// field-level accept doesn't apply to a file that no longer exists locally.
fn accept_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    main_map: &FileMap,
    file: &mut crate::config::accepted_patches::AcceptedPatchesFile,
    local_map: &FileMap,
) -> anyhow::Result<FieldCommandResult> {
    let mut result = FieldCommandResult::default();
    let paths = field_paths_in_folder(main_map, local_map, file, repo_folder);

    for path in paths {
        let Some(local_content) = local_map.get(path.as_str()) else {
            // Locally deleted: whole-file delete is not a field-level target.
            continue;
        };
        let local_obj = parse_json_object_bytes(local_content, path.as_str())?;

        let approved_obj_opt = approved_object_for_path(main_map, file, &path)?;
        let approved_value = approved_obj_opt
            .as_ref()
            .and_then(|obj| read_nested_json_value(obj, field));
        let local_value = read_nested_json_value(&local_obj, field);

        if local_value == approved_value {
            continue;
        }

        // Compose the new approved object: existing approved (or empty if
        // missing) with `field ← local_value` applied.
        let mut next_approved = approved_obj_opt.unwrap_or_default();
        apply_nested_json_value(&mut next_approved, field, local_value);

        let main_parsed = parse_json_value_at(main_map, path.as_str(), "refs/heads/main")?;
        let next_approved_value = if next_approved.is_empty() && main_parsed.is_none() {
            // Both ends agree the file shouldn't exist — drop any entry.
            None
        } else {
            Some(JsonValue::Object(next_approved))
        };

        match crate::commands::re_anchor::compute_entry(
            path.as_str(),
            main_parsed.as_ref(),
            next_approved_value.as_ref(),
        ) {
            Some(new_entry) => {
                crate::config::accepted_patches::upsert_entry(file, new_entry);
            }
            None => {
                crate::config::accepted_patches::remove_entry(file, path.as_str());
            }
        }

        result
            .changed_paths
            .push(format!("{}/{}", ctx.conn_dir_name, path));
        result.patches_changed = true;
    }

    Ok(result)
}

/// Folder-scoped, field-level reject. For each file in `repo_folder` where
/// `local[field] != approved[field]`, restore the working file's field to its
/// approved value. The accepted-patches file is **not** touched — reject only
/// undoes the unreviewed delta between working and approved (decision 35).
///
/// Pre-B `reject_field` had a hybrid second branch that also rolled the dirty
/// branch back to master when a field was already approved. That behavior is
/// now exclusively `discard_field_in_folder`'s job; reject is a no-op on an
/// already-approved field.
fn reject_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    main_map: &FileMap,
    file: &crate::config::accepted_patches::AcceptedPatchesFile,
    local_map: &FileMap,
) -> anyhow::Result<(FileMap, FieldCommandResult)> {
    let mut next_local_map = local_map.clone();
    let mut result = FieldCommandResult::default();
    let paths = field_paths_in_folder(main_map, local_map, file, repo_folder);

    for path in paths {
        let Some(local_content) = local_map.get(path.as_str()) else {
            // Locally deleted: field-level reject doesn't apply.
            continue;
        };
        let local_obj = parse_json_object_bytes(local_content, path.as_str())?;

        let approved_obj_opt = approved_object_for_path(main_map, file, &path)?;
        let approved_value = approved_obj_opt
            .as_ref()
            .and_then(|obj| read_nested_json_value(obj, field));
        let local_value = read_nested_json_value(&local_obj, field);

        if local_value == approved_value {
            continue;
        }

        let mut next_local_obj = local_obj;
        apply_nested_json_value(&mut next_local_obj, field, approved_value);
        if next_local_obj.is_empty() {
            // Restoring the only field of a created-only file to "approved =
            // doesn't exist" means the working file shouldn't exist either.
            next_local_map.remove(path.as_str());
        } else {
            next_local_map.insert(path.clone(), json_object_to_bytes(&next_local_obj)?);
        }

        result
            .changed_paths
            .push(format!("{}/{}", ctx.conn_dir_name, path));
    }

    Ok((next_local_map, result))
}

/// Enumerate in-folder paths that any of (main, local, patch entries) cares
/// about. Field-level commands walk this union so a path that exists only in
/// the patch (locally deleted but with an accepted edit, say) still gets
/// considered.
fn field_paths_in_folder(
    main_map: &FileMap,
    local_map: &FileMap,
    file: &crate::config::accepted_patches::AcceptedPatchesFile,
    repo_folder: &str,
) -> Vec<String> {
    let mut paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for key in main_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    for key in local_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    for entry in &file.patches {
        if is_data_path_in_folder(&entry.path, repo_folder) {
            paths.insert(entry.path.clone());
        }
    }
    paths.into_iter().collect()
}

/// Return the parsed "approved" object for a path: the per-file
/// `apply(main_blob, patch_entry)` if an entry exists, else the parsed main
/// blob, else `None` (path is approved-deleted or simply doesn't exist).
fn approved_object_for_path(
    main_map: &FileMap,
    file: &crate::config::accepted_patches::AcceptedPatchesFile,
    path: &str,
) -> anyhow::Result<Option<JsonMap<String, JsonValue>>> {
    if let Some(entry) = crate::config::accepted_patches::get_entry(file, path) {
        match apply_patch_entry_to_blob(main_map.get(path).map(|v| v.as_slice()), entry)? {
            Some(bytes) => Ok(Some(parse_json_object_bytes(&bytes, path)?)),
            None => Ok(None),
        }
    } else if let Some(bytes) = main_map.get(path) {
        Ok(Some(parse_json_object_bytes(bytes, path)?))
    } else {
        Ok(None)
    }
}

/// Folder-scoped, field-level discard. Per file in `repo_folder`, drop the
/// named field from any accepted-patches entry AND restore the working
/// file's value for that field to whatever `refs/heads/main` says.
///
/// Three outputs:
///   - `next_local_map` — the working tree's content after the discard
///     (caller writes it back via [`apply_changed_working_files`]).
///   - `result.changed_paths` — workspace-prefixed paths the operation
///     touched (caller surfaces these and reindexes the folder index).
///   - `result.patches_changed` — true iff the call mutated
///     `accepted-patches.json`. Caller decides whether to save_atomic.
///
/// Special handling for the lifecycle edge: stripping the last field from
/// a `Create` entry drops the entry AND removes the working file, since
/// "discard back to published" for a never-published record means "the
/// record no longer exists." `Delete` entries are no-ops — use
/// `restore-deleted-record` to undo a whole-file delete.
fn discard_field_in_folder(
    ctx: &ConnectionContext,
    repo_folder: &str,
    field: &str,
    main_map: &FileMap,
    file: &mut crate::config::accepted_patches::AcceptedPatchesFile,
    local_map: &FileMap,
) -> anyhow::Result<(FileMap, FieldCommandResult)> {
    use crate::commands::re_anchor::PatchKind;

    let mut next_local_map = local_map.clone();
    let mut result = FieldCommandResult::default();
    let mut entries_to_drop: Vec<String> = Vec::new();

    let paths = field_paths_in_folder(main_map, local_map, file, repo_folder);

    for path in paths {
        let published_value = match main_map.get(path.as_str()) {
            Some(bytes) => {
                let obj = parse_json_object_bytes(bytes, path.as_str())?;
                read_nested_json_value(&obj, field)
            }
            None => None,
        };
        let main_has_path = main_map.contains_key(path.as_str());

        let mut patch_action = PatchAction::Untouched;
        if let Some(entry) = file.patches.iter_mut().find(|e| e.path == path) {
            match entry.kind {
                PatchKind::Update => {
                    if let JsonValue::Object(map) = &mut entry.patch {
                        if patch_object_mentions_field(map, field) {
                            apply_nested_json_value(map, field, None);
                            if map.is_empty() {
                                entries_to_drop.push(path.clone());
                                patch_action = PatchAction::Dropped;
                            } else {
                                patch_action = PatchAction::Modified;
                            }
                        }
                    }
                }
                PatchKind::Create => {
                    if let JsonValue::Object(map) = &mut entry.patch {
                        if patch_object_mentions_field(map, field) {
                            apply_nested_json_value(map, field, None);
                            if map.is_empty() {
                                entries_to_drop.push(path.clone());
                                patch_action = PatchAction::DroppedCreate;
                            } else {
                                patch_action = PatchAction::Modified;
                            }
                        }
                    }
                }
                PatchKind::Delete => {
                    // Field-level discard on a Delete entry is a no-op.
                    continue;
                }
            }
        }

        // Update the working file's view of this field. If we just emptied
        // a Create, the file no longer exists at the approved state and
        // should be removed from the worktree.
        let working_touched = match patch_action {
            PatchAction::DroppedCreate => {
                next_local_map.remove(path.as_str());
                true
            }
            _ => {
                let current = local_map.get(path.as_str());
                match current {
                    Some(bytes) => {
                        let mut obj = parse_json_object_bytes(bytes, path.as_str())?;
                        let current_field = read_nested_json_value(&obj, field);
                        if current_field == published_value
                            && matches!(patch_action, PatchAction::Untouched)
                        {
                            // Nothing actually moves for this path.
                            false
                        } else {
                            apply_nested_json_value(&mut obj, field, published_value);
                            next_local_map.insert(path.clone(), json_object_to_bytes(&obj)?);
                            true
                        }
                    }
                    None => {
                        // Working file is absent. If main has the file
                        // (we just dropped an Update entry, say), the
                        // worktree should now mirror main for this path.
                        if main_has_path && !matches!(patch_action, PatchAction::Untouched) {
                            if let Some(main_bytes) = main_map.get(path.as_str()) {
                                let mut obj = parse_json_object_bytes(main_bytes, path.as_str())?;
                                apply_nested_json_value(&mut obj, field, published_value);
                                next_local_map.insert(path.clone(), json_object_to_bytes(&obj)?);
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    }
                }
            }
        };

        if working_touched || !matches!(patch_action, PatchAction::Untouched) {
            result
                .changed_paths
                .push(format!("{}/{}", ctx.conn_dir_name, path));
            if !matches!(patch_action, PatchAction::Untouched) {
                result.patches_changed = true;
            }
        }
    }

    for path in entries_to_drop {
        file.patches.retain(|e| e.path != path);
    }

    Ok((next_local_map, result))
}

enum PatchAction {
    Untouched,
    Modified,
    Dropped,
    /// Like `Dropped`, but originated from a `Create` entry — the working
    /// file should be removed since `published` has no such record.
    DroppedCreate,
}

/// True iff the patch object's "logical" keys include `field` (supports
/// dotted nested keys like `metadata.author`). Walks the object tree the
/// same way `read_nested_json_value` does so the field-mention check
/// agrees with what would actually be read at lookup time.
fn patch_object_mentions_field(object: &JsonMap<String, JsonValue>, field: &str) -> bool {
    read_nested_json_value(object, field).is_some()
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
        let base = base_data.get(path);
        let local = local_data.get(path);
        match (base, local) {
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
            // JSON-compare so whitespace/key-order drift between the
            // synthesized approved state and the worktree's actual file
            // bytes doesn't show up as a spurious modification.
            (Some(base), Some(local))
                if json_content_differs(Some(base.as_slice()), Some(local.as_slice())) =>
            {
                entries.push(UnreviewedEntry {
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

/// Synthesize the "approved" `FileMap` for a connection by overlaying the
/// per-file patches from `accepted-patches.json` on top of the current
/// `refs/heads/main` tree.
///
/// Replaces the pre-B `base_map = read_git_tree(refs/heads/dirty)` reads in
/// every accept/reject/discard pathway. The shape stays the same — keyed by
/// repo-relative path → pretty-printed JSON bytes — so downstream consumers
/// like `compute_unreviewed_entries` are unchanged.
fn compute_accepted_state(
    main_map: &FileMap,
    file: &crate::config::accepted_patches::AcceptedPatchesFile,
) -> anyhow::Result<FileMap> {
    let mut out = main_map.clone();
    for entry in &file.patches {
        match apply_patch_entry_to_blob(
            main_map.get(entry.path.as_str()).map(|b| b.as_slice()),
            entry,
        )? {
            Some(bytes) => {
                out.insert(entry.path.clone(), bytes);
            }
            None => {
                out.remove(entry.path.as_str());
            }
        }
    }
    Ok(out)
}

/// Per-file analogue of [`compute_accepted_state`]. Returns the approved
/// blob bytes for a single path, or `None` when the entry says the path is
/// approved-deleted.
///
/// - `Create`: `entry.patch` is the full file content; serialize it.
/// - `Update`: parse the `main` blob (or treat as `null` if missing — this
///   is a pathological state caused by something earlier in the pipeline;
///   `re_anchor` converts server-side deletes to `Create` at pull time so
///   `Update` against `None` shouldn't normally occur) and apply the RFC
///   7396 patch.
/// - `Delete`: returns `None` so callers can `out.remove(path)`.
fn apply_patch_entry_to_blob(
    main_blob: Option<&[u8]>,
    entry: &crate::commands::re_anchor::AnchoredPatch,
) -> anyhow::Result<Option<Vec<u8>>> {
    use crate::commands::re_anchor::PatchKind;
    match entry.kind {
        PatchKind::Delete => Ok(None),
        PatchKind::Create => Ok(Some(serde_json::to_vec_pretty(&entry.patch).with_context(
            || {
                format!(
                    "failed to serialize accepted Create patch for {}",
                    entry.path
                )
            },
        )?)),
        PatchKind::Update => {
            let base: JsonValue = match main_blob {
                Some(bytes) => serde_json::from_slice(bytes).with_context(|| {
                    format!(
                        "failed to parse refs/heads/main blob at {} as JSON",
                        entry.path
                    )
                })?,
                None => JsonValue::Null,
            };
            let merged = crate::commands::merge_patch::apply(&base, &entry.patch);
            Ok(Some(serde_json::to_vec_pretty(&merged).with_context(
                || format!("failed to serialize accepted Update for {}", entry.path),
            )?))
        }
    }
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

/// Three-way merge helper used by the download flow. Returns the merged
/// `FileMap` plus any per-action human-readable warnings. The legacy upload
/// flow that originally produced an `UploadResult` here was deleted in the
/// upload-patch rewrite; only the download caller remains and it discards
/// everything except the merged map and warnings.
fn prepare_upload_merge(
    base_map: &FileMap,
    local_map: &FileMap,
    remote_map: &FileMap,
) -> (FileMap, Vec<String>) {
    let actions = compute_merge_actions(base_map, local_map, remote_map);

    let mut merged = remote_map.clone();
    let mut messages = Vec::new();

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
                    }
                    None => {
                        merged.remove(path.as_str());
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
            }
        }
    }

    (merged, messages)
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

/// Outcome of `update_master_worktree` for a single connection. Callers use
/// `moved` to gate work that only matters when master actually advanced
/// (sync_schema_files_from_master) and `changed_paths` to drive a targeted
/// folder_index reindex.
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
