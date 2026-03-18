use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Subcommand;

use crate::api::{ApiClient, Workbook, WorkbookListResponse};
use crate::config::markers;

/// JSON output shape matching the Go CLI exactly.
/// The Go CLI omits `version` and `connectorAccounts`, and includes a null `dataFolders`.
#[derive(serde::Serialize)]
struct WorkbookOutput {
    id: String,
    name: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "tableCount")]
    table_count: i32,
    #[serde(rename = "dataFolders")]
    data_folders: Option<Vec<serde_json::Value>>,
    #[serde(rename = "gitUrl")]
    git_url: String,
}

#[derive(serde::Serialize)]
struct WorkbookListOutput {
    workbooks: Vec<WorkbookOutput>,
}

impl From<Workbook> for WorkbookOutput {
    fn from(wb: Workbook) -> Self {
        Self {
            id: wb.id,
            name: wb.name,
            created_at: wb.created_at,
            updated_at: wb.updated_at,
            table_count: wb.table_count,
            data_folders: None,
            git_url: wb.git_url,
        }
    }
}

#[derive(Subcommand)]
pub enum WorkspacesCommands {
    /// List all workspaces
    List,
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
        WorkspacesCommands::List => list(server_url, json).await,
        WorkspacesCommands::Create { name } => create(server_url, &name, json).await,
        WorkspacesCommands::Show { id } => show(server_url, &id, json).await,
        WorkspacesCommands::Delete { id } => delete(server_url, &id).await,
        WorkspacesCommands::Init { id, output, force } => {
            init(server_url, &id, &output, force, json).await
        }
    }
}

fn get_client(server_url: &str) -> anyhow::Result<ApiClient> {
    ApiClient::from_credentials(server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd2 auth login` first."))
}

async fn list(server_url: &str, json: bool) -> anyhow::Result<()> {
    let client = get_client(server_url)?;
    let resp: WorkbookListResponse = client.get("workbooks").await?;

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

    let total_files = if wb.version >= 2 {
        init_v2(&wb, &target_dir, server_url, &token)?
    } else {
        init_v1(&wb, &target_dir, server_url, &token)?
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "workbookId": wb.id,
                "workbookName": wb.name,
                "directory": target_dir.display().to_string(),
                "fileCount": total_files,
            }))?
        );
    } else {
        println!();
        println!("Initialized workspace '{}' ({} files)", wb.name, total_files);
        println!("  Directory: {}", target_dir.display());
        if wb.version >= 2 {
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
    markers::write_workspace(target_dir, &wb.id, &wb.name, server_url)?;

    // Write data folder markers for matching subdirectories
    let all_folders: Vec<_> = wb.connector_accounts.iter()
        .flat_map(|ca| ca.data_folders.iter())
        .collect();
    for df in all_folders {
        let dir = target_dir.join(&df.name);
        if dir.exists() {
            let _ = markers::write_data_folder(&dir, &df.id, &df.name);
        }
    }

    Ok(count_files(target_dir))
}

fn init_v2(wb: &Workbook, target_dir: &Path, server_url: &str, token: &str) -> anyhow::Result<i64> {
    std::fs::create_dir_all(target_dir)?;
    markers::write_workspace(target_dir, &wb.id, &wb.name, server_url)?;

    if wb.connector_accounts.is_empty() {
        return Ok(0);
    }

    let mut total = 0i64;
    for ca in &wb.connector_accounts {
        let dir_name = connector_dir_name(&ca.service, &ca.display_name);
        let conn_dir = target_dir.join(&dir_name);

        if ca.git_url.is_empty() {
            eprintln!("  Skipping connector {} (no git URL)", ca.display_name);
            continue;
        }

        git_clone(&ca.git_url, &conn_dir, token)?;

        markers::write_connector(
            &conn_dir,
            &wb.id,
            &wb.name,
            &ca.id,
            &ca.display_name,
            &ca.service,
            &ca.repo_path,
        )?;

        for df in &ca.data_folders {
            let df_dir = conn_dir.join(&df.name);
            if df_dir.exists() {
                let _ = markers::write_data_folder(&df_dir, &df.id, &df.name);
            }
        }

        total += count_files(&conn_dir);
    }
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
        let marker_path = entry.path().join(".scratchmd");
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
