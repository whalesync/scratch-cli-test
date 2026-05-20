use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Path, PathBuf};

use clap::Subcommand;

use crate::api::{ApiClient, ConnectorAccount, Workbook, WorkbookListResponse};
use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;

const DIRTY_BRANCH: &str = "dirty";
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
    let workbook_id = crate::config::resolve_workspace_id(id)?;
    let Some(workspace_path) = crate::config::workspaces::get(&workbook_id) else {
        anyhow::bail!(
            "Workspace {} is not registered locally in ~/.scratchmd/workspaces.yaml",
            workbook_id
        );
    };

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
        std::fs::remove_dir_all(&workspace_path)?;
    }
    crate::config::workspaces::remove(&workbook_id)?;

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

    // Check if already initialized
    if let Some(existing) = find_existing_workspace(output_dir, workbook_id) {
        if force {
            std::fs::remove_dir_all(&existing)?;
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
            std::fs::remove_dir_all(&existing)?;
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
        println!();
    }
    Ok(())
}

fn init_v2(wb: &Workbook, target_dir: &Path, server_url: &str, token: &str) -> anyhow::Result<i64> {
    let _t = PhaseTimer::new("init_v2 (total)");
    std::fs::create_dir_all(target_dir)?;
    // Canonicalize so all derived layout paths are absolute.
    let target_dir = target_dir.canonicalize()?;
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
            "all connections ({} total, sequential)",
            wb.connector_accounts.len()
        ));
        for (ca, entry) in wb.connector_accounts.iter().zip(connections.iter()) {
            let _t = PhaseTimer::new(format!("  connection: {}", ca.display_name));
            match setup_connection(ca, &entry.dir_name, &layout, token) {
                Ok(file_count) => total += file_count,
                Err(e) => eprintln!(
                    "  Warning: failed to set up connection {}: {e}",
                    ca.display_name
                ),
            }
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
    match git_checkout_branch_from_bare(bare_repo, MAIN_BRANCH, work_tree) {
        Ok(()) => Ok(MAIN_BRANCH),
        Err(main_err) => {
            eprintln!(
                "  Note: main branch checkout failed for workbook config repo ({main_err}); trying dirty"
            );
            git_checkout_branch_from_bare(bare_repo, DIRTY_BRANCH, work_tree)?;
            Ok(DIRTY_BRANCH)
        }
    }
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

/// Remove all local artifacts for a connection (bare repo, worktree, index DB,
/// connection scratch cache). The legacy pre-slice-F sparse-worktree paths
/// (`master_worktree_path`, `reviewed_worktree_path`) are best-effort cleaned
/// for back-compat — slice F.3 retires them entirely.
pub fn teardown_connection(
    entry: &markers::ConnectionEntry,
    layout: &WorkspaceLayout,
) -> anyhow::Result<()> {
    let bare_repo = layout.bare_repo_path(&entry.repo_path);
    let worktree_dir = layout.worktree_path(&entry.dir_name);
    let scratch_dir = layout.connection_scratch_path(&entry.dir_name);
    let legacy_master_dir = layout.master_worktree_path(&entry.dir_name);
    let legacy_reviewed_dir = layout.reviewed_worktree_path(&entry.dir_name);
    let db_path = layout.index_db_path(&entry.repo_path);

    // Prune worktrees before removing the bare repo
    prune_worktrees(&bare_repo);

    remove_path(&bare_repo);
    remove_path(&db_path);
    remove_path(&worktree_dir);
    remove_path(&scratch_dir);
    remove_path(&legacy_master_dir);
    remove_path(&legacy_reviewed_dir);

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
    // directory. Legacy pre-slice-F sparse-worktree paths are best-effort
    // cleaned for back-compat — slice F.3 retires them.
    let bare_repo = layout.bare_repo_path(&entry.repo_path);
    let scratch_dir = layout.connection_scratch_path(&entry.dir_name);
    let legacy_master_dir = layout.master_worktree_path(&entry.dir_name);
    let legacy_reviewed_dir = layout.reviewed_worktree_path(&entry.dir_name);
    let db_path = layout.index_db_path(&entry.repo_path);

    prune_worktrees(&bare_repo);

    remove_path(&bare_repo);
    remove_path(&db_path);
    remove_path(&scratch_dir);
    remove_path(&legacy_master_dir);
    remove_path(&legacy_reviewed_dir);

    Ok(())
}

fn prune_worktrees(bare_repo: &Path) {
    if bare_repo.exists() {
        let _ = std::process::Command::new("git")
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
