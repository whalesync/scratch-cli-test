use std::collections::HashMap;
use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Component, Path, PathBuf};

use clap::Subcommand;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::api::ConnectorAccount;
use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;

type FileMap = HashMap<String, Vec<u8>>;

/// Cache for `read_git_tree` results keyed by commit/tree hash. Avoids redundant
/// blob reads when the same tree is needed multiple times during an upload.
struct TreeCache {
    entries: HashMap<String, FileMap>,
}

impl TreeCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn get_or_read(&mut self, bare_repo: &Path, hash: &str) -> anyhow::Result<&FileMap> {
        if !self.entries.contains_key(hash) {
            let map = read_git_tree(bare_repo, hash)?;
            self.entries.insert(hash.to_string(), map);
        }
        Ok(&self.entries[hash])
    }
}

fn cached_read_git_tree<'c>(
    cache: &'c mut TreeCache,
    bare_repo: &Path,
    hash: &str,
) -> anyhow::Result<&'c FileMap> {
    cache.get_or_read(bare_repo, hash)
}

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
    },
    /// Commit all current working-tree record changes into the local dirty branch
    #[command(name = "accept-all")]
    AcceptAll {
        /// Optional folder to scope the accept to (e.g. "ConnectionName/folder").
        /// When unset, accepts across every connection in the workspace.
        #[arg(long)]
        folder: Option<PathBuf>,
    },
    /// Discard every pending and approved-but-unpublished change, reverting records to their last published state
    #[command(name = "discard-all")]
    DiscardAll {
        /// Optional folder to scope the discard to (e.g. "ConnectionName/folder").
        /// When unset, discards across every connection in the workspace.
        #[arg(long)]
        folder: Option<PathBuf>,
    },
    /// Discard pending and approved-but-unpublished changes for one or more specific paths, reverting them to their last published state
    Discard {
        /// Paths to discard, relative to the workspace root (e.g. "ConnectionName/folder/record.json").
        #[arg(required = true)]
        paths: Vec<String>,
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
    /// List record changes that exist only in the working tree and have not been accepted locally
    Unreviewed,
    /// List record changes between dirty and master branches (accepted but not yet published)
    Unpublished,
    /// List record changes accepted locally but not yet published (dirty vs master)
    Unpushed,
    /// Upload local changes to the server
    Upload,
    /// Force-push local state to the server, skipping merge (fast)
    #[command(name = "force-upload")]
    ForceUpload,
    /// Find the actual git merge base of local dirty and origin/dirty for each connection
    #[command(name = "find-merge-base", alias = "merge-base")]
    FindMergeBase,
}

#[derive(Clone)]
struct ConnectionContext {
    conn_dir_name: String,
    dirty_dir: PathBuf,
    scratch_dir: PathBuf,
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
}

#[derive(Default)]
struct UploadResult {
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
        FilesCommands::Download { on_delete } => {
            run_download(&cwd, server_url, json, on_delete).await
        }
        FilesCommands::AcceptAll { folder } => {
            run_accept_all(&cwd, server_url, folder.as_deref(), json)
        }
        FilesCommands::DiscardAll { folder } => {
            run_discard_all(&cwd, server_url, folder.as_deref(), json)
        }
        FilesCommands::Discard { paths } => run_discard(&cwd, &paths, json),
        FilesCommands::Accept { paths } => run_accept(&cwd, server_url, &paths, json),
        FilesCommands::AcceptField { folder, field } => {
            run_accept_field(&cwd, &folder, &field, json)
        }
        FilesCommands::Reject { paths } => run_reject(&cwd, &paths, json),
        FilesCommands::RejectField { folder, field } => {
            run_reject_field(&cwd, &folder, &field, json)
        }
        FilesCommands::Unreviewed => run_unreviewed(&cwd, server_url, json),
        FilesCommands::Unpublished => run_unpublished(&cwd, server_url, json),
        FilesCommands::Unpushed => run_unpushed(&cwd, server_url, json),
        FilesCommands::Upload => run_upload(&cwd, server_url, json),
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

    let mut results = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Downloading {}...", ctx.conn_dir_name);
        }
        results.push(download_single_repo(ctx, &token)?);
        if update_master_worktree(ctx, &token).is_ok() {
            let _ = sync_schema_files_from_master(ctx);
            rebuild_index_for_conn(ctx, json);
        }
    }

    let wb_name = if workspace_marker.workbook.name.is_empty() {
        workspace_marker.workbook.id.as_str()
    } else {
        workspace_marker.workbook.name.as_str()
    };
    let _ = super::generate_docs::write_docs(&workspace_dir, wb_name);

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

    // Set up new connections
    for ca in &added {
        let dir_name = markers::connector_dir_name(&ca.service, &ca.display_name);
        if !json {
            println!("Setting up new connection: {}...", dir_name);
        }
        match super::workspaces::setup_connection(ca, &layout, token) {
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
        let dir_name = markers::connector_dir_name(&ca.service, &ca.display_name);
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

fn run_upload(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, _, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let verbose = !json;
    let mut results = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && verbose {
            println!("Uploading {}...", ctx.conn_dir_name);
        }
        results.push(upload_single_repo(ctx, &token, verbose)?);
    }

    let result = if results.len() == 1 {
        results.into_iter().next().unwrap_or_default()
    } else {
        aggregate_upload(&results)
    };

    print_upload_result(&result, started.elapsed().as_millis(), json)
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

fn run_discard_all(
    cwd: &Path,
    server_url: &str,
    folder: Option<&Path>,
    json: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut results = Vec::new();
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            results.push(discard_all_single_repo(&ctx, Some(repo_folder.as_str()))?);
        }
        None => {
            for ctx in &contexts {
                if contexts.len() > 1 && !json {
                    println!("Discarding changes in {}...", ctx.conn_dir_name);
                }
                results.push(discard_all_single_repo(ctx, None)?);
            }
        }
    }

    let discarded_files: Vec<String> = results
        .iter()
        .flat_map(|result| result.discarded_paths.iter().cloned())
        .collect();
    let total_discarded: i32 = results.iter().map(|result| result.files_discarded).sum();
    let skipped_any = results.iter().any(|result| result.skipped_missing_main);
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

fn run_accept_all(
    cwd: &Path,
    server_url: &str,
    folder: Option<&Path>,
    json: bool,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, workspace_dir, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut results = Vec::new();
    match folder {
        Some(folder) => {
            let (ctx, repo_folder, _) = resolve_folder_context(&workspace_dir, &contexts, folder)?;
            results.push(accept_all_single_repo(&ctx, Some(repo_folder.as_str()))?);
        }
        None => {
            for ctx in &contexts {
                if contexts.len() > 1 && !json {
                    println!("Accepting changes in {}...", ctx.conn_dir_name);
                }
                results.push(accept_all_single_repo(ctx, None)?);
            }
        }
    }

    let accepted_files: Vec<String> = results
        .iter()
        .flat_map(|result| result.accepted_paths.iter().cloned())
        .collect();
    let total_accepted: i32 = results.iter().map(|result| result.files_accepted).sum();
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
    _base_url: &str,
    token: &str,
    workbook_id: &str,
) -> anyhow::Result<()> {
    let Some(workspace_dir) = crate::config::find_workspace_dir(workbook_id) else {
        eprintln!("(Workspace not initialized locally — skipping file download)");
        return Ok(());
    };

    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    for ctx in &contexts {
        download_single_repo(ctx, token)?;
        if update_master_worktree(ctx, token).is_ok() {
            let _ = sync_schema_files_from_master(ctx);
            rebuild_index_for_conn(ctx, true);
        }
    }
    Ok(())
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
            conn_dir_name: connection.dir_name.clone(),
            dirty_dir: layout.dirty_checkout_path(&connection.dir_name),
            scratch_dir: layout.connection_scratch_path(&connection.dir_name),
            master_dir: layout.master_worktree_path(&connection.dir_name),
            reviewed_dirty_dir: layout.reviewed_dirty_checkout_path(&connection.dir_name),
            bare_repo: layout.bare_repo_path(&connection.repo_path),
            db_path: layout.index_db_path(&connection.repo_path),
        })
        .collect();

    Ok(contexts)
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

fn is_sparse_worktree(path: &Path) -> bool {
    path.join(".git").is_file()
}

/// Update dirty_dir's git index to match the new dirty commit (leaves working tree unchanged).
/// No-op if dirty_dir is not a sparse worktree (backward compat).
fn update_dirty_worktree_index(ctx: &ConnectionContext, hash: &str) -> anyhow::Result<()> {
    if !is_sparse_worktree(&ctx.dirty_dir) {
        return Ok(());
    }
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

fn download_single_repo(ctx: &ConnectionContext, token: &str) -> anyhow::Result<DownloadResult> {
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

    materialize_local_repo(ctx, &target_map)?;
    update_dirty_worktree_index(ctx, &new_dirty_hash)?;
    update_reviewed_dirty(ctx, &new_dirty_hash)?;

    Ok(result)
}

fn upload_single_repo(
    ctx: &ConnectionContext,
    token: &str,
    verbose: bool,
) -> anyhow::Result<UploadResult> {
    let mut tree_cache = TreeCache::new();

    if verbose {
        eprint!("  Reading local state...");
    }
    let local_dirty_hash = git_rev_parse(&ctx.bare_repo, "refs/heads/dirty")?;
    // Clone local_dirty_map out of the cache so we can continue mutating the cache for
    // remote tree reads without holding a borrow.
    let local_dirty_map =
        cached_read_git_tree(&mut tree_cache, &ctx.bare_repo, &local_dirty_hash)?.clone();
    sync_schema_files_from_master(ctx)?;
    let local_unreviewed = unreviewed_entries_cached(&mut tree_cache, ctx)?;
    let local_plan_map = read_local_publish_plan_map(ctx)?;
    if verbose {
        eprintln!(" done");
    }

    if local_unreviewed.is_empty() && local_plan_map.is_empty() {
        if verbose {
            eprint!("  Fetching remote changes...");
        }
        crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;
        if verbose {
            eprintln!(" done");
        }

        let remote_hash = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/dirty")?;
        let remote_map = cached_read_git_tree(&mut tree_cache, &ctx.bare_repo, &remote_hash)?;
        if maps_equal(&local_dirty_map, remote_map) {
            return Ok(UploadResult {
                status: "no_changes".to_string(),
                ..Default::default()
            });
        }
    }

    const MAX_RETRIES: i32 = 5;
    for attempt in 0..MAX_RETRIES {
        if verbose {
            eprint!("  Fetching remote changes...");
        }
        crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;
        if verbose {
            eprintln!(" done");
        }

        let remote_hash = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/dirty")?;
        let remote_map =
            cached_read_git_tree(&mut tree_cache, &ctx.bare_repo, &remote_hash)?.clone();
        let merge_base_hash = crate::git_ops::merge_base_to_string(
            &ctx.bare_repo,
            "refs/heads/dirty",
            "refs/remotes/origin/dirty",
        )?
        .ok_or_else(|| {
            anyhow::anyhow!("No merge base found between local dirty and origin/dirty")
        })?;
        let merge_base_map =
            cached_read_git_tree(&mut tree_cache, &ctx.bare_repo, &merge_base_hash)?.clone();

        if verbose {
            eprint!("  Merging...");
        }
        let (mut merged, mut result, mut messages) =
            prepare_upload_merge(&merge_base_map, &local_dirty_map, &remote_map, attempt);
        if verbose {
            eprintln!(" done");
        }

        strip_publish_plan_files(&mut merged);
        let plan_file_count = local_plan_map.len() as i32;
        for (path, value) in &local_plan_map {
            merged.insert(path.clone(), value.clone());
        }

        if !local_unreviewed.is_empty() {
            messages.push(format!(
                "{} record(s) have unreviewed local changes and will not be uploaded. Run `scratchmd files accept-all` first.",
                local_unreviewed.len()
            ));
        }

        if maps_equal(&merged, &remote_map) {
            git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &remote_hash)?;
            sync_schema_files_from_master(ctx)?;
            apply_remote_changes_to_working_copy(ctx, &local_dirty_map, &remote_map)?;
            update_dirty_worktree_index(ctx, &remote_hash)?;
            update_reviewed_dirty(ctx, &remote_hash)?;
            return Ok(UploadResult {
                status: "up_to_date".to_string(),
                messages,
                ..Default::default()
            });
        }

        let new_dirty_hash = commit_file_map_to_dirty_ref(
            &ctx.bare_repo,
            Some(remote_hash.as_str()),
            &merged,
            "Upload from Scratch CLI",
        )?;

        if verbose {
            eprint!("  Pushing...");
        }
        match crate::git_ops::push_origin_dirty(&ctx.bare_repo, token) {
            Ok(()) => {
                if verbose {
                    eprintln!(" done");
                }
                sync_schema_files_from_master(ctx)?;
                apply_remote_changes_to_working_copy(ctx, &local_dirty_map, &merged)?;
                update_dirty_worktree_index(ctx, &new_dirty_hash)?;
                update_reviewed_dirty(ctx, &new_dirty_hash)?;
                result.files_plan = plan_file_count;
                result.messages = messages;
                return Ok(result);
            }
            Err(err) => {
                if verbose {
                    eprintln!(" retrying");
                }
                if err.to_string().contains("non-fast-forward")
                    || err.to_string().contains("rejected")
                {
                    git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &local_dirty_hash)?;
                    continue;
                }
                return Err(err);
            }
        }
    }

    anyhow::bail!(
        "Upload failed after {} attempts due to concurrent changes on the server",
        MAX_RETRIES
    )
}

fn discard_all_single_repo(
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
    sync_schema_files_from_master(ctx)?;
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
    repo_folder: Option<&str>,
) -> anyhow::Result<AcceptAllResult> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
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

fn unreviewed_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    if is_sparse_worktree(&ctx.dirty_dir) {
        return unreviewed_entries_from_status(ctx);
    }
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;
    Ok(compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &base_map,
        &local_map,
    ))
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

/// Like `unreviewed_entries` but reuses a tree cache to avoid redundant blob reads.
fn unreviewed_entries_cached(
    cache: &mut TreeCache,
    ctx: &ConnectionContext,
) -> anyhow::Result<Vec<UnreviewedEntry>> {
    if is_sparse_worktree(&ctx.dirty_dir) {
        return unreviewed_entries_from_status(ctx);
    }
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map: FileMap = match base_hash.as_deref() {
        Some(hash) => cached_read_git_tree(cache, &ctx.bare_repo, hash)?.clone(),
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;
    Ok(compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &base_map,
        &local_map,
    ))
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

pub(crate) fn has_unreviewed_record_changes(
    bare_repo: &Path,
    dirty_dir: &Path,
) -> anyhow::Result<bool> {
    if dirty_dir.join(".git").is_file() {
        let entries = crate::git_ops::worktree_status_entries(dirty_dir)?;
        return Ok(entries.iter().any(|e| {
            !e.path.starts_with(".scratch/")
                && ((e.x == b'?' && e.y == b'?') || e.y == b'M' || e.y == b'D')
        }));
    }
    let base_hash = git_rev_parse_optional(bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(bare_repo, hash)?,
        None => HashMap::new(),
    };
    let mut working_tree_map = FileMap::new();
    read_dirty_disk(dirty_dir, dirty_dir, &mut working_tree_map)?;
    Ok(!maps_equal(
        &data_only_map(&base_map),
        &data_only_map(&working_tree_map),
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

pub(crate) fn materialize_treeish_to_worktree(
    bare_repo: &Path,
    treeish: &str,
    work_tree: &Path,
) -> anyhow::Result<()> {
    clear_dir_contents(work_tree, true)?;
    std::fs::create_dir_all(work_tree)?;
    crate::git_ops::materialize_treeish_to_directory(bare_repo, treeish, work_tree)
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

fn materialize_local_repo(ctx: &ConnectionContext, map: &FileMap) -> anyhow::Result<()> {
    clear_dir_contents(&ctx.dirty_dir, false)?;
    clear_dir_contents(&ctx.scratch_dir, true)?;
    std::fs::create_dir_all(&ctx.dirty_dir)?;
    std::fs::create_dir_all(&ctx.scratch_dir)?;

    for (rel_path, content) in map {
        if let Some(scratch_rel) = rel_path.strip_prefix(".scratch/") {
            write_file(&ctx.scratch_dir.join(scratch_rel), content)?;
        } else if !rel_path.starts_with(".scratch") {
            write_file(&ctx.dirty_dir.join(rel_path), content)?;
        }
    }

    Ok(())
}

/// Rebase the current working tree from `old_map` to `new_map`, treating the
/// working tree as local edits on top of `old_map`.
fn apply_remote_changes_to_working_copy(
    ctx: &ConnectionContext,
    old_map: &FileMap,
    new_map: &FileMap,
) -> anyhow::Result<()> {
    let old_data_map = data_only_map(old_map);
    let new_data_map = data_only_map(new_map);

    let mut working_tree_map = FileMap::new();
    read_dirty_disk(&ctx.dirty_dir, &ctx.dirty_dir, &mut working_tree_map)?;

    let actions = compute_merge_actions(&old_data_map, &working_tree_map, &new_data_map);

    for act in actions {
        let (path, next_content) = match act {
            MergeAction::KeepLocal { path, content, .. } => (path, content),
            MergeAction::WriteRemote { path, content } => (path, content),
            MergeAction::Delete { path, .. } => (path, None),
            MergeAction::Merge {
                path,
                base,
                local,
                remote,
            } => (
                path.clone(),
                Some(merge_content(
                    &path,
                    Some(&base),
                    Some(&local),
                    Some(&remote),
                )),
            ),
        };

        let current_content = working_tree_map.get(path.as_str());
        if current_content == next_content.as_ref() {
            continue;
        }

        match next_content {
            Some(content) => write_file(&ctx.dirty_dir.join(&path), &content)?,
            None => {
                let _ = std::fs::remove_file(ctx.dirty_dir.join(&path));
            }
        }
    }

    Ok(())
}

fn read_local_publish_plan_map(ctx: &ConnectionContext) -> anyhow::Result<FileMap> {
    let mut scratch_map = FileMap::new();
    read_scratch_disk(&ctx.scratch_dir, &ctx.scratch_dir, &mut scratch_map)?;
    Ok(scratch_map
        .into_iter()
        .filter(|(path, _)| is_publish_plan_file(path))
        .collect())
}

fn is_scratch_path(path: &str) -> bool {
    path.starts_with(".scratch/")
}

fn is_publish_plan_file(path: &str) -> bool {
    path.strip_prefix(".scratch/")
        .map(|rest| rest.starts_with(".publish-plans/") || rest.contains("/publish-plan-"))
        .unwrap_or(false)
}

fn strip_publish_plan_files(map: &mut FileMap) {
    map.retain(|path, _| !is_publish_plan_file(path));
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

fn clear_dir_contents(dir: &Path, remove_hidden: bool) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !remove_hidden && name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(path)?;
        } else {
            std::fs::remove_file(path)?;
        }
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

fn update_master_worktree(ctx: &ConnectionContext, token: &str) -> anyhow::Result<()> {
    let _ = crate::git_ops::fetch_origin(&ctx.bare_repo, token);
    let Some(main_hash) = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
    else {
        return Ok(());
    };
    // Keep refs/heads/main pointing at the fetched tip
    git_update_ref(&ctx.bare_repo, "refs/heads/main", &main_hash)?;
    crate::git_ops::ensure_sparse_worktree(&ctx.bare_repo, &ctx.master_dir, "refs/heads/main")?;
    crate::git_ops::worktree_reset_hard(&ctx.master_dir, &main_hash)
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
