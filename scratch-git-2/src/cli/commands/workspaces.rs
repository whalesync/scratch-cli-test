use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Subcommand;

use crate::api::{ApiClient, ConnectorAccount, Workbook, WorkbookListResponse};
use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;

const DIRTY_BRANCH: &str = "dirty";
const MAIN_BRANCH: &str = "main";

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
            connector_accounts: if wb.connector_accounts.is_empty() { None } else { Some(wb.connector_accounts) },
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
        WorkspacesCommands::List { sort_by, sort_order } => list(server_url, &sort_by, &sort_order, json).await,
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
            workbooks: resp.workbooks.into_iter().map(WorkbookOutput::from).collect(),
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
        let name = if wb.name.is_empty() { "(unnamed)" } else { &wb.name };
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
    let name = if wb.name.is_empty() { "(unnamed)" } else { &wb.name };
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
        println!("{}", serde_json::to_string_pretty(&WorkbookOutput::from(wb))?);
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
    let wb_name = if wb.name.is_empty() { workbook_id.to_string() } else { wb.name.clone() };
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
    let total_files = if wb.version >= 2 {
        init_v2(&wb, &target_dir, server_url, &token)?
    } else {
        init_v1(&wb, &target_dir, server_url, &token)?
    };
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
        println!("Initialized workspace '{}' ({} files, {})", wb.name, total_files, elapsed);
        println!("  Directory: {}", target_dir.display());
        if wb.version >= 2 {
            println!("    .repos/");
            println!("    .scratch/");
            println!("      connections/");
            println!("      workspace/");
            for ca in &wb.connector_accounts {
                let dir_name = connector_dir_name(&ca.service, &ca.display_name);
                println!("    {}/", dir_name);
            }
        }
        println!();
    }
    Ok(())
}

fn init_v1(wb: &Workbook, target_dir: &Path, server_url: &str, token: &str) -> anyhow::Result<i64> {
    if wb.git_url.is_empty() {
        anyhow::bail!("Server did not return git URL for workspace");
    }

    git_clone(&wb.git_url, target_dir, token)?;
    let org_id = derive_workbook_org_id(wb);
    markers::write_workspace(target_dir, &wb.id, &wb.name, &org_id, server_url, &[])?;

    // Write data folder markers for matching subdirectories
    let all_folders: Vec<_> = wb.connector_accounts.iter()
        .flat_map(|ca| ca.data_folders.iter())
        .collect();
    for df in all_folders {
        let dir = target_dir.join(&df.name);
        if dir.exists() {
            // TODO: remove once root .scratchmd owns all metadata.
            let _ = (dir, &df.id, &df.name);
        }
    }

    Ok(count_files(target_dir))
}

fn init_v2(wb: &Workbook, target_dir: &Path, server_url: &str, token: &str) -> anyhow::Result<i64> {
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
            dir_name: connector_dir_name(&ca.service, &ca.display_name),
        })
        .collect();
    let org_id = derive_workbook_org_id(wb);
    markers::write_workspace(target_dir, &wb.id, &wb.name, &org_id, server_url, &connections)?;

    let mut total = 0i64;
    total += init_workbook_repo(wb, &layout, token)?;

    for ca in &wb.connector_accounts {
        let dir_name = connector_dir_name(&ca.service, &ca.display_name);

        if ca.git_url.is_empty() {
            eprintln!("  Skipping connector {} (no git URL)", ca.display_name);
            continue;
        }
        if ca.repo_path.is_empty() {
            eprintln!("  Skipping connector {} (no repoPath)", ca.display_name);
            continue;
        }

        let bare_repo = layout.bare_repo_path(&ca.repo_path);
        let dirty_dir = layout.dirty_checkout_path(&dir_name);
        let dirty_scratch_dir = layout.connection_scratch_path(&dir_name);
        let master_dir = layout.master_worktree_path(&dir_name);
        let db_path = layout.index_db_path(&ca.repo_path);

        git_clone_bare(&ca.git_url, &bare_repo, token)?;
        materialize_dirty_checkout(&bare_repo, &dirty_dir, &dirty_scratch_dir)?;

        match git_checkout_branch_from_bare(&bare_repo, MAIN_BRANCH, &master_dir) {
            Ok(()) => {
                if let Some(parent) = db_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                if let Err(e) = crate::shared::index::build(&master_dir, &db_path) {
                    eprintln!("  Warning: failed to build index for {}: {e}", dir_name);
                }
            }
            Err(_) => {
                eprintln!("  Note: could not create master checkout for {} (main branch may not exist)", dir_name);
            }
        }

        total += count_files(&dirty_dir);
    }

    let wb_name = if wb.name.is_empty() { wb.id.as_str() } else { wb.name.as_str() };
    let _ = super::generate_docs::write_docs(target_dir, wb_name);

    Ok(total)
}

/// Clone a git repo into `target_dir`, checking out the `dirty` branch.
fn git_clone(url: &str, target_dir: &Path, token: &str) -> anyhow::Result<()> {
    let auth_header = format!("Authorization: API-Token {}", token);
    let status = Command::new("git")
        .args([
            "-c",
            &format!("http.extraHeader={}", auth_header),
            "clone",
            "--quiet",
            "--branch",
            "dirty",
            "--single-branch",
            url,
            target_dir.to_str().unwrap_or("."),
        ])
        .status()?;

    if !status.success() {
        anyhow::bail!("git clone failed for {}", url);
    }
    Ok(())
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

    if let Err(err) = git_clone_bare(&wb.git_url, &bare_repo, token) {
        let _ = std::fs::remove_dir_all(&bare_repo);
        eprintln!(
            "  Note: workbook config repo clone failed ({err}); leaving .scratch/workspace as local directories only"
        );
        return Ok(count_files(&workbook_dir));
    }

    materialize_workbook_checkout(&bare_repo, &workbook_dir)?;

    Ok(count_files(&workbook_dir))
}

fn materialize_workbook_checkout(bare_repo: &Path, work_tree: &Path) -> anyhow::Result<&'static str> {
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
    if let Some(parent) = target_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let auth_header = format!("Authorization: API-Token {}", token);
    let output = Command::new("git")
        .args([
            "-c",
            &format!("http.extraHeader={}", auth_header),
            "clone",
            "--bare",
            "--quiet",
            url,
            target_dir.to_str().unwrap_or("."),
        ])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git clone --bare failed for {}: {}", url, stderr.trim());
    }
    Ok(())
}

fn git_checkout_branch_from_bare(bare_repo: &Path, branch: &str, work_tree: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(work_tree)?;

    let output = Command::new("git")
        .current_dir(work_tree)
        .arg(format!("--git-dir={}", bare_repo.display()))
        .arg(format!("--work-tree={}", work_tree.display()))
        .args(["checkout", branch, "--", "."])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("pathspec '.' did not match any file(s) known to git")
            && branch_is_empty(bare_repo, branch)?
        {
            return Ok(());
        }
        anyhow::bail!(
            "git checkout {} failed for {}: {}",
            branch,
            bare_repo.display(),
            stderr.trim()
        );
    }

    Ok(())
}

fn branch_is_empty(bare_repo: &Path, branch: &str) -> anyhow::Result<bool> {
    let output = Command::new("git")
        .arg(format!("--git-dir={}", bare_repo.display()))
        .args(["ls-tree", "-r", "--name-only", branch])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "git ls-tree {} failed for {}: {}",
            branch,
            bare_repo.display(),
            stderr.trim()
        );
    }

    Ok(output.stdout.is_empty())
}

fn materialize_dirty_checkout(bare_repo: &Path, dirty_dir: &Path, scratch_dir: &Path) -> anyhow::Result<()> {
    git_checkout_branch_from_bare(bare_repo, DIRTY_BRANCH, dirty_dir)?;
    move_dirty_scratch_to_layout(dirty_dir, scratch_dir)
}

fn move_dirty_scratch_to_layout(dirty_dir: &Path, scratch_dir: &Path) -> anyhow::Result<()> {
    let source = dirty_dir.join(".scratch");

    if let Some(parent) = scratch_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if source.exists() {
        if scratch_dir.exists() {
            std::fs::remove_dir_all(scratch_dir)?;
        }
        std::fs::rename(&source, scratch_dir)?;
    } else {
        std::fs::create_dir_all(scratch_dir)?;
    }

    Ok(())
}

/// Count non-dot files recursively (excluding .git directories).
fn count_files(dir: &Path) -> i64 {
    let mut count = 0i64;
    walk_count(dir, &mut count);
    count
}

fn walk_count(dir: &Path, count: &mut i64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
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

fn connector_dir_name(service: &str, display_name: &str) -> String {
    markers::sanitize_filename(&format!("{} - {}", service, display_name))
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::process::Command;

    fn workbook_with_repo_paths(repo_paths: &[&str]) -> Workbook {
        Workbook {
            id: "wkb_test".to_string(),
            name: "Test".to_string(),
            org_id: "org123".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            table_count: 0,
            version: 2,
            connector_accounts: repo_paths
                .iter()
                .enumerate()
                .map(|(i, repo_path)| ConnectorAccount {
                    id: format!("ca_{i}"),
                    display_name: format!("Conn {i}"),
                    service: "AIRTABLE".to_string(),
                    repo_path: (*repo_path).to_string(),
                    git_url: String::new(),
                    data_folders: vec![],
                })
                .collect(),
            git_url: String::new(),
        }
    }

    #[test]
    fn derive_workbook_repo_id_uses_shared_repo_prefix() {
        let wb = workbook_with_repo_paths(&["org123/wkb_test/ca_1", "org123/wkb_test/ca_2"]);
        assert_eq!(derive_workbook_repo_id(&wb).as_deref(), Some("org123/wkb_test/wkb_test"));
    }

    #[test]
    fn derive_workbook_org_id_prefers_workbook_field_then_repo_path_prefix() {
        let explicit = workbook_with_repo_paths(&["org123/wkb_test/ca_1"]);
        assert_eq!(derive_workbook_org_id(&explicit), "org123");

        let mut derived = workbook_with_repo_paths(&["org999/wkb_test/ca_1"]);
        derived.org_id.clear();
        assert_eq!(derive_workbook_org_id(&derived), "org999");
    }

    #[test]
    fn move_dirty_scratch_to_layout_extracts_scratch_from_user_dir() {
        let tmp = TempDir::new().unwrap();
        let dirty_dir = tmp.path().join("conn");
        let scratch_dir = tmp.path().join(".scratch/connections/scratch/conn");

        std::fs::create_dir_all(dirty_dir.join(".scratch/posts")).unwrap();
        std::fs::write(dirty_dir.join(".scratch/posts/schema.json"), "{}").unwrap();
        std::fs::write(dirty_dir.join("posts.json"), "{}").unwrap();

        move_dirty_scratch_to_layout(&dirty_dir, &scratch_dir).unwrap();

        assert!(dirty_dir.join("posts.json").exists());
        assert!(!dirty_dir.join(".scratch").exists());
        assert!(scratch_dir.join("posts/schema.json").exists());
    }

    #[test]
    fn git_checkout_branch_from_bare_allows_empty_branch_tree() {
        if !git_available() {
            eprintln!("skipping git-dependent test: git executable not available");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let repo_dir = tmp.path().join("repo");
        let bare_dir = tmp.path().join("repo.git");
        let work_tree = tmp.path().join("checkout");

        run_git(tmp.path(), &["init", "repo"]);
        run_git(&repo_dir, &["checkout", "-b", "dirty"]);
        run_git(
            &repo_dir,
            &["-c", "user.name=Scratch", "-c", "user.email=scratch@example.com", "commit", "--allow-empty", "-m", "empty"],
        );
        run_git(tmp.path(), &["init", "--bare", "repo.git"]);
        run_git(&repo_dir, &["remote", "add", "origin", bare_dir.to_str().unwrap()]);
        run_git(&repo_dir, &["push", "origin", "dirty:dirty"]);

        git_checkout_branch_from_bare(&bare_dir, "dirty", &work_tree).unwrap();

        assert!(work_tree.exists());
        assert!(std::fs::read_dir(&work_tree).unwrap().next().is_none());
    }

    #[test]
    fn materialize_workbook_checkout_prefers_main_when_dirty_is_empty() {
        if !git_available() {
            eprintln!("skipping git-dependent test: git executable not available");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let repo_dir = tmp.path().join("repo");
        let bare_dir = tmp.path().join("repo.git");
        let work_tree = tmp.path().join("workspace");

        run_git(tmp.path(), &["init", "repo"]);
        run_git(&repo_dir, &["checkout", "-b", "main"]);
        std::fs::create_dir_all(repo_dir.join("syncs")).unwrap();
        std::fs::write(repo_dir.join("syncs/a.json"), "{}").unwrap();
        run_git(&repo_dir, &["add", "syncs/a.json"]);
        run_git(
            &repo_dir,
            &[
                "-c",
                "user.name=Scratch",
                "-c",
                "user.email=scratch@example.com",
                "commit",
                "-m",
                "main content",
            ],
        );
        run_git(&repo_dir, &["checkout", "--orphan", "dirty"]);
        run_git(&repo_dir, &["rm", "-rf", "."]);
        run_git(
            &repo_dir,
            &[
                "-c",
                "user.name=Scratch",
                "-c",
                "user.email=scratch@example.com",
                "commit",
                "--allow-empty",
                "-m",
                "empty dirty",
            ],
        );
        run_git(tmp.path(), &["init", "--bare", "repo.git"]);
        run_git(&repo_dir, &["remote", "add", "origin", bare_dir.to_str().unwrap()]);
        run_git(&repo_dir, &["push", "origin", "main:main"]);
        run_git(&repo_dir, &["push", "origin", "dirty:dirty"]);

        let branch = materialize_workbook_checkout(&bare_dir, &work_tree).unwrap();

        assert_eq!(branch, "main");
        assert!(work_tree.join("syncs/a.json").exists());
    }

    #[test]
    fn find_existing_workspace_reads_marker_from_scratch_dir() {
        let tmp = TempDir::new().unwrap();
        let workspace_dir = tmp.path().join("My Workspace");
        std::fs::create_dir_all(workspace_dir.join(".scratch")).unwrap();
        std::fs::write(
            workspace_dir.join(".scratch/.scratchmd"),
            r#"version: "3"
workbook:
  id: wkb_test
  name: Test
  serverUrl: http://localhost
  initializedAt: "2026-01-01T00:00:00Z"
connections: []
"#,
        )
        .unwrap();

        assert_eq!(
            find_existing_workspace(tmp.path().to_str().unwrap(), "wkb_test"),
            Some(workspace_dir)
        );
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}
