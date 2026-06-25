use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Path, PathBuf};

use clap::Subcommand;

use crate::api::{ApiClient, ConnectorAccount, Workbook, WorkbookListResponse};
use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;

const MAIN_BRANCH: &str = "main";

/// RAII timer that prints elapsed time on drop when `SCRATCHMD_PROFILE=1`.
/// Used to profile `scratchmd workspaces init` phases.
struct PhaseTimer {
    label: String,
    start: std::time::Instant,
}

impl PhaseTimer {
    fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            start: std::time::Instant::now(),
        }
    }
}

impl Drop for PhaseTimer {
    fn drop(&mut self) {
        if std::env::var("SCRATCHMD_PROFILE").as_deref() == Ok("1") {
            let ms = self.start.elapsed().as_millis();
            eprintln!("[profile] {:>6} ms  {}", ms, self.label);
        }
    }
}

/// JSON output shape matching the Go CLI exactly.
/// Includes a null `dataFolders` at workbook level (Go always serializes this as null).
#[derive(serde::Serialize)]
struct WorkbookOutput {
    /// null when server omits the field (list endpoint), populated on show endpoint — matches Go nil-slice behaviour.
    #[serde(rename = "connectorAccounts")]
    connector_accounts: Option<Vec<ConnectorAccount>>,
    #[serde(rename = "createdAt")]
    created_at: String,
    /// Always null — Go CLI includes this field but the server never populates it at workbook level.
    #[serde(rename = "dataFolders")]
    data_folders: Option<Vec<serde_json::Value>>,
    #[serde(rename = "gitUrl")]
    git_url: String,
    id: String,
    name: String,
    #[serde(rename = "tableCount")]
    table_count: i32,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    version: i32,
}

#[derive(serde::Serialize)]
struct WorkbookListOutput {
    workbooks: Vec<WorkbookOutput>,
}

impl From<Workbook> for WorkbookOutput {
    fn from(wb: Workbook) -> Self {
        Self {
            connector_accounts: if wb.connector_accounts.is_empty() {
                None
            } else {
                Some(wb.connector_accounts)
            },
            created_at: wb.created_at,
            data_folders: None,
            git_url: wb.git_url,
            id: wb.id,
            name: wb.name,
            table_count: wb.table_count,
            updated_at: wb.updated_at,
            version: wb.version,
        }
    }
}

#[derive(Subcommand)]
pub enum WorkspacesCommands {
    /// List all workspaces
    List {
        /// Sort by field (name, createdAt, updatedAt)
        #[arg(long, default_value = "createdAt")]
        sort_by: String,
        /// Sort order (asc, desc)
        #[arg(long, default_value = "desc")]
        sort_order: String,
    },
    /// Create a new workspace
    Create {
        /// Workspace name
        name: String,
    },
    /// Show workspace details
    Show {
        /// Workspace ID
        id: String,
    },
    /// Delete a workspace
    Delete {
        /// Workspace ID
        id: String,
    },
    /// Remove a local workspace checkout and unregister it from ~/.scratchmd/workspaces.yaml
    Unsync {
        /// Workspace ID (auto-detected from the current workspace if omitted)
        id: Option<String>,
        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
    /// Initialize a local copy of a workspace (clone git repos)
    Init {
        /// Workspace ID
        id: String,
        /// Output directory (default: current directory)
        #[arg(long, short = 'o', default_value = ".")]
        output: String,
        /// Overwrite existing local copy
        #[arg(long)]
        force: bool,
    },
}

pub async fn run(cmd: WorkspacesCommands, server_url: &str, json: bool) -> anyhow::Result<()> {
    match cmd {
        WorkspacesCommands::List {
            sort_by,
            sort_order,
        } => list(server_url, &sort_by, &sort_order, json).await,
        WorkspacesCommands::Create { name } => create(server_url, &name, json).await,
        WorkspacesCommands::Show { id } => show(server_url, &id, json).await,
        WorkspacesCommands::Delete { id } => delete(server_url, &id).await,
        WorkspacesCommands::Unsync { id, yes } => unsync(id.as_deref(), yes, json),
        WorkspacesCommands::Init { id, output, force } => {
            init(server_url, &id, &output, force, json).await
        }
    }
}

fn get_client(server_url: &str) -> anyhow::Result<ApiClient> {
    ApiClient::from_credentials(server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))
}

async fn list(server_url: &str, sort_by: &str, sort_order: &str, json: bool) -> anyhow::Result<()> {
    let client = get_client(server_url)?;
    let query = format!("sortBy={}&sortOrder={}", sort_by, sort_order);
    let resp: WorkbookListResponse = client.get_query("workbooks", &query).await?;

    if json {
        let output = WorkbookListOutput {
            workbooks: resp
                .workbooks
                .into_iter()
                .map(WorkbookOutput::from)
                .collect(),
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    if resp.workbooks.is_empty() {
        println!("No workspaces found.");
        return Ok(());
    }

    println!();
    println!("Found {} workspace(s):", resp.workbooks.len());
    println!();
    for wb in &resp.workbooks {
        let name = if wb.name.is_empty() {
            "(unnamed)"
        } else {
            &wb.name
        };
        println!("  Name:    {}", name);
        println!("  ID:      {}", wb.id);
        println!("  Created: {}", wb.created_at);
        println!();
    }
    Ok(())
}

async fn create(server_url: &str, name: &str, json: bool) -> anyhow::Result<()> {
    let client = get_client(server_url)?;
    let body = serde_json::json!({ "name": name });
    let wb: Workbook = client.post("workbooks", &body).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&wb)?);
        return Ok(());
    }

    println!();
    println!("Workspace created successfully!");
    println!();
    let name = if wb.name.is_empty() {
        "(unnamed)"
    } else {
        &wb.name
    };
    println!("  ID:      {}", wb.id);
    println!("  Name:    {}", name);
    println!("  Created: {}", wb.created_at);
    println!();
    Ok(())
}

async fn show(server_url: &str, id: &str, json: bool) -> anyhow::Result<()> {
    let client = get_client(server_url)?;
    let wb: Workbook = client.get(&format!("workbooks/{}", id)).await?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&WorkbookOutput::from(wb))?
        );
        return Ok(());
    }

    println!("ID:      {}", wb.id);
    println!("Name:    {}", wb.name);
    println!("Version: {}", wb.version);
    for ca in &wb.connector_accounts {
        println!("  Connector: {} ({})", ca.display_name, ca.service);
        for df in &ca.data_folders {
            println!("    Table: {}", df.name);
        }
    }
    Ok(())
}

async fn delete(server_url: &str, id: &str) -> anyhow::Result<()> {
    let client = get_client(server_url)?;
    let _: serde_json::Value = client.delete(&format!("workbooks/{}", id)).await?;
    println!("Deleted workspace {}", id);
    Ok(())
}

fn unsync(id: Option<&str>, yes: bool, json: bool) -> anyhow::Result<()> {
    let started_total = std::time::Instant::now();

    let started_lookup = std::time::Instant::now();
    let workbook_id = crate::config::resolve_workspace_id(id)?;
    let Some(workspace_path) = crate::config::workspaces::get(&workbook_id) else {
        anyhow::bail!(
            "Workspace {} is not registered locally in ~/.scratchmd/workspaces.yaml",
            workbook_id
        );
    };
    eprintln!(
        "[unsync] registry lookup: {:.0}ms",
        started_lookup.elapsed().as_secs_f64() * 1000.0
    );

    if !yes && !json {
        println!("This will remove the local workspace files only.");
        println!("The remote repo and remote workspace will stay unchanged.");
        println!("  Local path: {}", workspace_path.display());
        print!("Continue? [y/N]: ");
        io::stdout().flush()?;
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        let response = line.trim().to_lowercase();
        if response != "y" && response != "yes" {
            println!("Cancelled.");
            return Ok(());
        }
    }

    if workspace_path.exists() {
        let started_remove = std::time::Instant::now();
        std::fs::remove_dir_all(&workspace_path)?;
        eprintln!(
            "[unsync] remove_dir_all: {:.0}ms ({})",
            started_remove.elapsed().as_secs_f64() * 1000.0,
            workspace_path.display()
        );
    } else {
        eprintln!(
            "[unsync] remove_dir_all: skipped (path missing: {})",
            workspace_path.display()
        );
    }

    let started_registry = std::time::Instant::now();
    crate::config::workspaces::remove(&workbook_id)?;
    eprintln!(
        "[unsync] registry write: {:.0}ms",
        started_registry.elapsed().as_secs_f64() * 1000.0
    );

    eprintln!(
        "[unsync] total: {:.0}ms",
        started_total.elapsed().as_secs_f64() * 1000.0
    );

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "workbookId": workbook_id,
                "removedPath": workspace_path.display().to_string(),
            }))?
        );
    } else {
        println!("Removed local workspace {}", workspace_path.display());
        println!("Remote workspace {} was not changed.", workbook_id);
    }

    Ok(())
}

async fn init(
    server_url: &str,
    workbook_id: &str,
    output_dir: &str,
    force: bool,
    json: bool,
) -> anyhow::Result<()> {
    let client = get_client(server_url)?;
    let token = client.token().to_string();

    let wb: Workbook = client.get(&format!("workbooks/{}", workbook_id)).await?;
    let wb_name = if wb.name.is_empty() {
        workbook_id.to_string()
    } else {
        wb.name.clone()
    };
    let target_dir = PathBuf::from(output_dir).join(&wb_name);

    // Check if already initialized. A forced re-clone NEVER silently destroys
    // un-uploaded work — `clear_existing_workspace_preserving_pending_edits`
    // moves a workspace with pending accepted edits aside instead of deleting
    // it, and returns where (reported below).
    let mut salvaged_to: Option<PathBuf> = None;
    if let Some(existing) = find_existing_workspace(output_dir, workbook_id) {
        if force {
            salvaged_to = clear_existing_workspace_preserving_pending_edits(&existing)?;
        } else if json {
            anyhow::bail!(
                "Workspace {} is already initialized at {} (use --force to overwrite)",
                workbook_id,
                existing.display()
            );
        } else {
            println!("\nWorkspace is already initialized at {:?}.", existing);
            print!("Overwrite with fresh files? [y/N]: ");
            io::stdout().flush()?;
            let mut line = String::new();
            io::stdin().lock().read_line(&mut line)?;
            let response = line.trim().to_lowercase();
            if response != "y" && response != "yes" {
                println!("Cancelled.");
                return Ok(());
            }
            salvaged_to = clear_existing_workspace_preserving_pending_edits(&existing)?;
        }
        if let Some(salvage_path) = &salvaged_to {
            // To stderr so it surfaces in both human and `--json` modes without
            // corrupting the JSON document on stdout.
            eprintln!(
                "Preserved your previous local workspace (it had un-uploaded edits) at:\n  {}\nYour accepted-but-unpublished edits are in {}/.scratch/connections/<connection>/accepted-patches.json",
                salvage_path.display(),
                salvage_path.display()
            );
        }
    }

    let started = std::time::Instant::now();
    let total_files = init_v2(&wb, &target_dir, server_url, &token)?;
    crate::config::workspaces::upsert(&wb.id, &target_dir)?;
    let elapsed_ms = started.elapsed().as_millis();
    let elapsed = if elapsed_ms < 1000 {
        format!("{}ms", elapsed_ms)
    } else {
        format!("{:.1}s", elapsed_ms as f64 / 1000.0)
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "workbookId": wb.id,
                "workbookName": wb.name,
                "directory": target_dir.display().to_string(),
                "fileCount": total_files,
                "elapsedMs": elapsed_ms,
                // Where the previous workspace's un-uploaded edits were preserved
                // before this re-clone, if any (DEV-9698 non-destructive salvage).
                "salvagedTo": salvaged_to.as_ref().map(|p| p.display().to_string()),
            }))?
        );
    } else {
        println!();
        println!(
            "Initialized workspace '{}' ({} files, {})",
            wb.name, total_files, elapsed
        );
        println!("  Directory: {}", target_dir.display());
        println!("    .repos/");
        println!("    .scratch/");
        println!("      connections/");
        println!("      workspace/");
        for ca in &wb.connector_accounts {
            let dir_name = connector_dir_name(&ca.display_name);
            println!("    {}/", dir_name);
        }
        if let Some(salvage_path) = &salvaged_to {
            println!();
            println!(
                "  Note: your previous workspace had un-uploaded edits — preserved at {}",
                salvage_path.display()
            );
        }
        println!();
    }
    Ok(())
}

fn init_v2(wb: &Workbook, target_dir: &Path, server_url: &str, token: &str) -> anyhow::Result<i64> {
    let _t = PhaseTimer::new("init_v2 (total)");
    std::fs::create_dir_all(target_dir)?;
    // Canonicalize so all derived layout paths are absolute. dunce avoids the
    // Windows `\\?\` verbatim prefix that std::fs::canonicalize emits — those
    // paths flow into `git clone --bare` below, and Git-for-Windows can't write
    // into a verbatim path (fails creating HEAD).
    let target_dir = dunce::canonicalize(target_dir)?;
    let target_dir = target_dir.as_path();
    let layout = WorkspaceLayout::for_cli(target_dir);
    let connections: Vec<markers::ConnectionEntry> = wb
        .connector_accounts
        .iter()
        .map(|ca| markers::ConnectionEntry {
            id: ca.id.clone(),
            display_name: ca.display_name.clone(),
            service: ca.service.clone(),
            repo_path: ca.repo_path.clone(),
            dir_name: connector_dir_name(&ca.display_name),
            // Snapshot the connector's folder-structure version at clone time so a
            // later server-side restructure (DEV-9698) is detectable on download.
            structure_version: ca.version,
        })
        .collect();
    let org_id = derive_workbook_org_id(wb);
    {
        let _t = PhaseTimer::new("write workspace marker");
        markers::write_workspace(
            target_dir,
            &wb.id,
            &wb.name,
            &org_id,
            server_url,
            &connections,
        )?;
    }

    let mut total = 0i64;
    {
        let _t = PhaseTimer::new("init_workbook_repo (config repo)");
        total += init_workbook_repo(wb, &layout, token)?;
    }

    {
        let _t = PhaseTimer::new(format!(
            "all connections ({} total, parallel)",
            wb.connector_accounts.len()
        ));

        use rayon::prelude::*;

        // Each connection writes to its own bare repo + worktree + scratch
        // cache (disjoint paths per connection), so parallel setup has no
        // shared mutable state. Rayon's default thread pool fans out the
        // network-bound `git clone --bare` calls; wall time is dominated by
        // the slowest connection instead of the sum.
        let results: Vec<(String, anyhow::Result<i64>)> = wb
            .connector_accounts
            .par_iter()
            .zip(connections.par_iter())
            .map(|(ca, entry)| {
                let _t = PhaseTimer::new(format!("  connection: {}", ca.display_name));
                let result = setup_connection(ca, &entry.dir_name, &layout, token);
                (ca.display_name.clone(), result)
            })
            .collect();

        let connection_count = results.len();
        let mut success_count = 0usize;
        for (name, result) in results {
            match result {
                Ok(file_count) => {
                    total += file_count;
                    success_count += 1;
                }
                Err(e) => eprintln!("  Warning: failed to set up connection {name}: {e}"),
            }
        }

        // 1/N failure: warn + continue (user gets a partial-but-usable
        // workspace). 0/N: bail so the user knows nothing got set up.
        if connection_count > 0 && success_count == 0 {
            anyhow::bail!("all {connection_count} connection(s) failed to initialize");
        }
    }

    let wb_name = if wb.name.is_empty() {
        wb.id.as_str()
    } else {
        wb.name.as_str()
    };
    {
        let _t = PhaseTimer::new("generate_docs::write_docs");
        let _ = super::generate_docs::write_docs(target_dir, wb_name);
    }

    Ok(total)
}

fn init_workbook_repo(wb: &Workbook, layout: &WorkspaceLayout, token: &str) -> anyhow::Result<i64> {
    let workbook_dir = layout.workbook_materialization_path();
    std::fs::create_dir_all(workbook_dir.join("syncs"))?;
    std::fs::create_dir_all(workbook_dir.join("transformers"))?;

    let Some(repo_id) = derive_workbook_repo_id(wb) else {
        eprintln!("  Note: could not derive workbook repo id; leaving .scratch/workspace as local directories only");
        return Ok(count_files(&workbook_dir));
    };

    if wb.git_url.is_empty() {
        eprintln!("  Note: workbook config git URL missing; leaving .scratch/workspace as local directories only");
        return Ok(count_files(&workbook_dir));
    }

    let bare_repo = layout.bare_repo_path(&repo_id);

    {
        let _t = PhaseTimer::new("    workbook git_clone_bare");
        if let Err(err) = git_clone_bare(&wb.git_url, &bare_repo, token) {
            let _ = std::fs::remove_dir_all(&bare_repo);
            eprintln!(
                "  Note: workbook config repo clone failed ({err}); leaving .scratch/workspace as local directories only"
            );
            return Ok(count_files(&workbook_dir));
        }
    }

    {
        let _t = PhaseTimer::new("    workbook materialize_workbook_checkout");
        materialize_workbook_checkout(&bare_repo, &workbook_dir)?;
    }

    let _t = PhaseTimer::new("    workbook count_files");
    Ok(count_files(&workbook_dir))
}

fn materialize_workbook_checkout(
    bare_repo: &Path,
    work_tree: &Path,
) -> anyhow::Result<&'static str> {
    // Slice F.5 retired the `dirty` fallback — the workbook config repo
    // lives on `main`. If `main` can't be checked out, surface the error
    // rather than silently checking out a stale (or non-existent) branch.
    git_checkout_branch_from_bare(bare_repo, MAIN_BRANCH, work_tree)?;
    Ok(MAIN_BRANCH)
}

fn git_clone_bare(url: &str, target_dir: &Path, token: &str) -> anyhow::Result<()> {
    crate::git_ops::clone_bare(url, target_dir, token)
}

fn git_checkout_branch_from_bare(
    bare_repo: &Path,
    branch: &str,
    work_tree: &Path,
) -> anyhow::Result<()> {
    crate::git_ops::setup_sparse_worktree(bare_repo, work_tree, branch)
}

/// Idempotently materialize the user-facing non-sparse worktree on `main`.
/// If the worktree already exists and is valid (`.git` gitlink + `HEAD`
/// resolves), this is a no-op. Broken worktree dirs fail loudly so the user
/// can `workspaces unsync` to clear them rather than silently nuking state.
///
/// The companion per-connection scratch cache directory
/// (`<workspace>/.scratch/connections/scratch/<conn>/`) is created so the
/// subsequent `sync_schema_files_from_worktree_paths` write can succeed.
fn materialize_main_worktree(
    bare_repo: &Path,
    worktree_dir: &Path,
    scratch_dir: &Path,
) -> anyhow::Result<()> {
    crate::git_ops::ensure_full_worktree(bare_repo, worktree_dir, MAIN_BRANCH)?;
    std::fs::create_dir_all(scratch_dir)?;
    Ok(())
}

/// Count non-dot files recursively (excluding .git directories).
fn count_files(dir: &Path) -> i64 {
    let mut count = 0i64;
    walk_count(dir, &mut count);
    count
}

fn walk_count(dir: &Path, count: &mut i64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if name_str != ".git" {
                walk_count(&entry.path(), count);
            }
        } else if ft.is_file() && !name_str.starts_with('.') {
            *count += 1;
        }
    }
}

/// Find an existing initialized workspace directory in `output_dir` matching the workbook ID.
fn find_existing_workspace(output_dir: &str, workbook_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(output_dir).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        // A preserved (salvaged) workspace backup keeps a valid marker with the
        // same workbook id; never return it as the live workspace, or a second
        // `init --force` would clear the backup and clone into the still-occupied
        // live directory.
        if entry
            .file_name()
            .to_string_lossy()
            .contains(SALVAGE_DIR_INFIX)
        {
            continue;
        }
        let marker_path = markers::marker_path(&entry.path());
        let content = std::fs::read_to_string(&marker_path).ok()?;
        let value: serde_yaml::Value = serde_yaml::from_str(&content).ok()?;
        // Skip connector markers
        if value.get("connector").is_some() {
            continue;
        }
        let id = value.get("workbook")?.get("id")?.as_str()?;
        if id == workbook_id {
            return Some(entry.path());
        }
    }
    None
}

fn connector_dir_name(display_name: &str) -> String {
    markers::sanitize_filename(display_name)
}

/// Clear an existing workspace to make room for a fresh `init --force` clone —
/// but NEVER silently destroy un-uploaded work. If any connection has accepted-
/// but-not-yet-published edits (a non-empty `accepted-patches.json`), the whole
/// workspace is *moved* aside to `<name>.salvaged-<timestamp>` instead of being
/// deleted. A single atomic rename preserves everything (worktree edits **and**
/// the accepted patches, which ARE the upload wire format), so the user can
/// recover. Returns the salvage path when it preserved, `None` when it
/// plain-removed (nothing pending to lose).
///
/// This is what makes the DEV-9698 forced re-clone non-destructive: a stale
/// clone whose folders moved server-side must be re-cloned, and re-clone must
/// not throw away edits the user staged before the migration.
fn clear_existing_workspace_preserving_pending_edits(
    existing: &Path,
) -> anyhow::Result<Option<PathBuf>> {
    if !workspace_has_pending_accepted_edits(existing) {
        std::fs::remove_dir_all(existing)?;
        return Ok(None);
    }
    let salvage_path = choose_salvage_path(existing);
    std::fs::rename(existing, &salvage_path).map_err(|e| {
        anyhow::anyhow!(
            "failed to preserve existing workspace at {} (move to {}): {e}",
            existing.display(),
            salvage_path.display()
        )
    })?;
    Ok(Some(salvage_path))
}

/// Infix marking a directory as a preserved (salvaged) workspace backup, not a
/// live workspace. `find_existing_workspace` skips dirs containing it so a
/// second `init --force` can never pick a backup as the workspace to re-clone.
const SALVAGE_DIR_INFIX: &str = ".salvaged-";

/// True when any connection in the workspace has a non-empty
/// `accepted-patches.json` — i.e. accepted edits the user has not yet published.
/// Conservative on every uncertainty (preserve, never delete): an unreadable
/// marker, or an `accepted-patches.json` that fails to load (corrupt, or written
/// by a newer scratchmd) is treated as "might have pending work".
fn workspace_has_pending_accepted_edits(existing: &Path) -> bool {
    let marker_path = markers::marker_path(existing);
    let marker = match markers::read(&marker_path) {
        Ok(markers::Marker::Workspace(m)) => m,
        _ => return existing.join(".scratch").exists(),
    };
    let layout = WorkspaceLayout::for_cli(existing);
    marker.connections.iter().any(|c| {
        if c.dir_name.is_empty() {
            return false;
        }
        let conn_dir = layout.connection_root_path(&c.dir_name);
        // `load` returns Ok(empty) for a missing/empty file; it only errors on a
        // genuinely unparseable / too-new file — exactly the case where we can't
        // be sure there's no pending work, so preserve (`unwrap_or(true)`).
        crate::shared::accepted_patches::load(&conn_dir)
            .map(|f| !f.patches.is_empty())
            .unwrap_or(true)
    })
}

/// Pick a non-colliding salvage path next to the existing workspace:
/// `<name>.salvaged-<YYYYMMDD-HHMMSS>`, suffixed `-1`, `-2`, … on collision
/// (two re-clones within the same second).
fn choose_salvage_path(existing: &Path) -> PathBuf {
    let parent = existing.parent().unwrap_or_else(|| Path::new("."));
    let base_name = existing
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut candidate = parent.join(format!("{base_name}{SALVAGE_DIR_INFIX}{stamp}"));
    let mut counter = 1;
    while candidate.exists() {
        candidate = parent.join(format!("{base_name}{SALVAGE_DIR_INFIX}{stamp}-{counter}"));
        counter += 1;
    }
    candidate
}

fn derive_workbook_repo_id(wb: &Workbook) -> Option<String> {
    let mut prefixes = wb
        .connector_accounts
        .iter()
        .filter_map(|ca| repo_path_prefix(&ca.repo_path));
    let first = prefixes.next()?;
    if prefixes.all(|prefix| prefix == first) {
        Some(format!("{}/{}", first, wb.id))
    } else {
        None
    }
}

fn derive_workbook_org_id(wb: &Workbook) -> String {
    if !wb.org_id.is_empty() {
        return wb.org_id.clone();
    }

    wb.connector_accounts
        .iter()
        .filter_map(|ca| ca.repo_path.split('/').next())
        .find(|segment| !segment.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn repo_path_prefix(repo_path: &str) -> Option<&str> {
    repo_path
        .rsplit_once('/')
        .map(|(prefix, _)| prefix)
        .filter(|prefix| !prefix.is_empty())
}

// ── Connection lifecycle helpers ───────────────────────────────────────────

/// Set up a single connection's local git infrastructure: one bare repo + one
/// non-sparse worktree on `main` + the per-connection schema cache. Returns
/// the number of files in the worktree.
///
/// Idempotent: re-running on a workspace where the bare repo or worktree
/// already exists succeeds without duplicate work. Broken state (e.g. a
/// worktree dir that isn't a valid git worktree) fails loudly so the user
/// can `workspaces unsync` to clear it rather than silently nuking state.
///
/// Slice F retired the previous two-worktree model (sparse `dirty` worktree
/// + sparse `master` worktree) along with the `sync_schema_files_from_master`
/// init-time copy — non-sparse `main` carries schemas + views natively.
pub fn setup_connection(
    ca: &ConnectorAccount,
    dir_name: &str,
    layout: &WorkspaceLayout,
    token: &str,
) -> anyhow::Result<i64> {
    if ca.git_url.is_empty() {
        anyhow::bail!("no git URL");
    }
    if ca.repo_path.is_empty() {
        anyhow::bail!("no repoPath");
    }

    let bare_repo = layout.bare_repo_path(&ca.repo_path);
    let worktree_dir = layout.worktree_path(&dir_name);
    let scratch_dir = layout.connection_scratch_path(&dir_name);

    {
        let _t = PhaseTimer::new(format!("    [{}] git_clone_bare", dir_name));
        // Idempotent: skip the (slow) network clone if a valid-looking bare
        // repo already exists. Re-running init shouldn't re-download.
        if !bare_repo.exists() {
            git_clone_bare(&ca.git_url, &bare_repo, token)?;
        }
    }
    {
        // Slice F.5: delete the local `refs/heads/dirty` ref the server-side
        // clone carried in. Nothing local reads it after slices F+F.5; the
        // server's own `dirty` branch (publish working area) is untouched.
        // Idempotent: error means the ref already doesn't exist, which is fine.
        let _t = PhaseTimer::new(format!("    [{}] prune local refs/heads/dirty", dir_name));
        let _ = crate::shared::git_exec::git_command()
            .arg(format!("--git-dir={}", bare_repo.display()))
            .args(["update-ref", "-d", "refs/heads/dirty"])
            .output();
    }
    {
        let _t = PhaseTimer::new(format!(
            "    [{}] materialize_main_worktree (non-sparse: main)",
            dir_name
        ));
        materialize_main_worktree(&bare_repo, &worktree_dir, &scratch_dir)?;
    }
    {
        let _t = PhaseTimer::new(format!("    [{}] reconcile_data_folder_dirs", dir_name));
        super::files::reconcile_data_folder_dirs(&worktree_dir, &ca.data_folders)?;
    }
    {
        let _t = PhaseTimer::new(format!(
            "    [{}] sync_schema_files_from_worktree",
            dir_name
        ));
        crate::shared::review_ops::sync_schema_files_from_worktree_paths(
            &worktree_dir,
            &scratch_dir,
        )?;
    }

    let _t = PhaseTimer::new(format!("    [{}] count_files (worktree)", dir_name));
    Ok(count_files(&worktree_dir))
}

/// Whether a connection's bare repo on disk is present and usable.
///
/// A usable bare repo is what `git --git-dir=<repo> fetch` needs: the directory
/// exists and carries the git internals a `git clone --bare` lays down (the
/// `HEAD` file and the `objects/` store). Returns `false` when the directory is
/// missing entirely OR exists but is missing those internals (a half-written /
/// corrupted clone) — both of which make a later `fetch` abort with
/// "fatal: not a git repository". Cheap (≤ 2 stat calls) so the download path
/// can probe every marker connection on each run.
pub fn bare_repo_is_initialized(bare_repo: &Path) -> bool {
    bare_repo.join("HEAD").is_file() && bare_repo.join("objects").is_dir()
}

/// Recover a connection whose local git infrastructure is missing or broken by
/// clearing the broken remnants and re-running [`setup_connection`] from a clean
/// slate.
///
/// Used by the download self-heal (see `sync_workspace_structure`) when the
/// workspace marker lists a connection whose bare repo never cloned — `init`
/// writes the marker with every connector account *before* running the
/// per-connection clones, and a single clone failure is only warn-and-continue,
/// so the marker can permanently reference a `.repos/<repo>.git` that doesn't
/// exist. Every later `files download` then `git fetch`es that missing repo and
/// aborts with "git fetch failed ... not a git repository".
///
/// Non-destructive (the "default to non-destructive, reversible" principle):
/// with the bare repo missing/corrupt we cannot diff the worktree to separate
/// reviewed content from unreviewed local edits (the DEV-10523 stash-and-reapply
/// path the normal download uses needs the bare repo), so a *populated* worktree
/// is moved aside to a salvage backup rather than deleted — bounding any data
/// loss to the case where there is genuinely nothing on disk. The reported case
/// (init's clone failed before any worktree materialized) hits exactly that path:
/// no worktree, clean re-clone. The remaining removed paths hold no un-uploaded
/// user data — the bare repo is broken/missing (nothing committed to lose) and
/// the index db + schema cache are regenerable. Accepted-but-unpublished edits
/// live in `accepted-patches.json` under the connection root (untouched here),
/// so they also survive.
///
/// Returns where the previous worktree was preserved (`Some`), or `None` when it
/// was absent/empty and there was nothing to save (the reported failure mode).
pub fn repair_connection_local_repo(
    ca: &ConnectorAccount,
    dir_name: &str,
    layout: &WorkspaceLayout,
    token: &str,
) -> anyhow::Result<Option<PathBuf>> {
    let bare_repo = layout.bare_repo_path(&ca.repo_path);

    // Preserve, never destroy, a worktree that still holds files. Clears only an
    // absent/empty worktree so the re-clone below has a clean destination.
    let salvaged_worktree_to =
        salvage_worktree_if_populated(&layout.worktree_path(dir_name), dir_name, layout)?;

    // Clear the broken/partial git plumbing so the re-clone starts clean.
    prune_worktrees(&bare_repo);
    remove_path(&bare_repo);
    remove_path(&layout.index_db_path(&ca.repo_path));
    remove_path(&layout.connection_scratch_path(dir_name));

    setup_connection(ca, dir_name, layout, token)?;
    Ok(salvaged_worktree_to)
}

/// Move a populated worktree aside to a non-colliding salvage backup under
/// `.scratch/salvaged/` and return its path; return `None` (removing any empty
/// shell) when the worktree is absent or empty and there's nothing to preserve.
///
/// Backs [`repair_connection_local_repo`]'s non-destructive guarantee. The
/// backup lives under `.scratch/` so it stays out of the user-facing
/// data-folder tree (the desktop renders that tree from a disk scan) while
/// remaining recoverable on disk. An atomic `rename` preserves the worktree's
/// record files (including any unreviewed local edits) wholesale.
fn salvage_worktree_if_populated(
    worktree_dir: &Path,
    dir_name: &str,
    layout: &WorkspaceLayout,
) -> anyhow::Result<Option<PathBuf>> {
    let is_populated = std::fs::read_dir(worktree_dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if !is_populated {
        remove_path(worktree_dir);
        return Ok(None);
    }

    let salvage_dir = layout.scratch_root().join("salvaged");
    std::fs::create_dir_all(&salvage_dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut salvage_path = salvage_dir.join(format!("{dir_name}-{stamp}"));
    let mut counter = 1;
    while salvage_path.exists() {
        salvage_path = salvage_dir.join(format!("{dir_name}-{stamp}-{counter}"));
        counter += 1;
    }
    std::fs::rename(worktree_dir, &salvage_path).map_err(|e| {
        anyhow::anyhow!(
            "failed to preserve worktree at {} (move to {}): {e}",
            worktree_dir.display(),
            salvage_path.display()
        )
    })?;
    Ok(Some(salvage_path))
}

/// Remove all local artifacts for a connection (bare repo, worktree, index DB,
/// connection scratch cache).
///
/// Pre-slice-F workspaces additionally had `.scratch/connections/master/<conn>/`
/// and `.scratch/connections/dirty/<conn>/` directories. F.1 refuses to
/// operate on those workspaces, so the user must `workspaces unsync` to clear
/// them — which removes the whole workspace tree from disk, picking up any
/// legacy directories en route. No explicit cleanup needed here.
pub fn teardown_connection(
    entry: &markers::ConnectionEntry,
    layout: &WorkspaceLayout,
) -> anyhow::Result<()> {
    let bare_repo = layout.bare_repo_path(&entry.repo_path);
    let worktree_dir = layout.worktree_path(&entry.dir_name);
    let scratch_dir = layout.connection_scratch_path(&entry.dir_name);
    let db_path = layout.index_db_path(&entry.repo_path);

    // Prune worktrees before removing the bare repo
    prune_worktrees(&bare_repo);

    remove_path(&bare_repo);
    remove_path(&db_path);
    remove_path(&worktree_dir);
    remove_path(&scratch_dir);

    Ok(())
}

/// Mark a connection as detached: preserve dirty checkout files but remove git infrastructure.
pub fn detach_connection(
    entry: &markers::ConnectionEntry,
    workspace_marker: &markers::WorkspaceMarker,
    layout: &WorkspaceLayout,
) -> anyhow::Result<()> {
    let worktree_dir = layout.worktree_path(&entry.dir_name);

    // Write a detached connector marker into the connection directory
    let connector_marker = markers::ConnectorMarker {
        version: "2".to_string(),
        detached: true,
        workbook: markers::ConnectorWorkbookRef {
            id: workspace_marker.workbook.id.clone(),
            name: workspace_marker.workbook.name.clone(),
        },
        connector: markers::ConnectorRef {
            id: entry.id.clone(),
            display_name: entry.display_name.clone(),
            service: entry.service.clone(),
            repo_path: entry.repo_path.clone(),
        },
    };
    let marker_content = serde_yaml::to_string(&connector_marker)
        .map_err(|e| anyhow::anyhow!("failed to serialize detached marker: {e}"))?;
    let marker_path = worktree_dir.join(".scratchmd");
    std::fs::write(&marker_path, marker_content)?;

    // Remove git infrastructure while preserving the user-facing worktree
    // directory. Pre-slice-F sparse-worktree paths under
    // `.scratch/connections/{master,dirty}/<conn>/` aren't present on any
    // workspace that init-ed post-slice-F; F.1 refuses pre-F workspaces, so
    // they reach this path only after the user re-init'd (and the legacy
    // paths are gone).
    let bare_repo = layout.bare_repo_path(&entry.repo_path);
    let scratch_dir = layout.connection_scratch_path(&entry.dir_name);
    let db_path = layout.index_db_path(&entry.repo_path);

    prune_worktrees(&bare_repo);

    remove_path(&bare_repo);
    remove_path(&db_path);
    remove_path(&scratch_dir);

    Ok(())
}

fn prune_worktrees(bare_repo: &Path) {
    if bare_repo.exists() {
        let _ = crate::shared::git_exec::git_command()
            .args(["-C", &bare_repo.to_string_lossy(), "worktree", "prune"])
            .output();
    }
}

fn remove_path(path: &Path) {
    if !path.exists() {
        return;
    }
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
#[path = "tests/workspaces.rs"]
mod tests;
