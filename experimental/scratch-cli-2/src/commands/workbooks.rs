use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Args, Subcommand};
use serde::Serialize;

use crate::cli::Cli;
use crate::commands::helpers::*;

#[derive(Args)]
pub struct WorkbooksCommand {
    #[command(subcommand)]
    pub action: WorkbooksAction,
}

#[derive(Subcommand)]
pub enum WorkbooksAction {
    /// List all workbooks
    List {
        #[arg(long, default_value = "createdAt")]
        sort_by: Option<String>,
        #[arg(long, default_value = "desc")]
        sort_order: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Create a new workbook
    Create {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Show workbook details
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete a workbook
    Delete {
        id: String,
        #[arg(long)]
        yes: bool,
    },
    /// Clone workbook files to local directory
    Init {
        id: String,
        #[arg(short, long, default_value = ".")]
        output: PathBuf,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        json: bool,
    },
}

impl WorkbooksCommand {
    pub fn run(&self, cli: &Cli) -> Result<()> {
        match &self.action {
            WorkbooksAction::List {
                sort_by,
                sort_order,
                json,
            } => run_list(cli, sort_by.as_deref(), sort_order.as_deref(), *json),
            WorkbooksAction::Create { name, json } => run_create(cli, name.as_deref(), *json),
            WorkbooksAction::Show { id, json } => run_show(cli, id, *json),
            WorkbooksAction::Delete { id, yes } => run_delete(cli, id, *yes),
            WorkbooksAction::Init {
                id,
                output,
                force,
                json,
            } => run_init(cli, id, output, *force, *json),
        }
    }
}

fn run_list(cli: &Cli, sort_by: Option<&str>, sort_order: Option<&str>, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let result = client.list_workbooks(sort_by, sort_order)?;

    if json_output {
        return print_json(&result);
    }

    if result.workbooks.is_empty() {
        println!("No workbooks found.");
        println!();
        println!("Create one with: scratchmd workbooks create --name \"My Workbook\"");
        return Ok(());
    }

    println!();
    println!("Found {} workbook(s):", result.workbooks.len());
    println!();

    for wb in &result.workbooks {
        let name = if wb.name.is_empty() { "(unnamed)" } else { &wb.name };
        println!("  Name:    {}", name);
        println!("  ID:      {}", wb.id);
        println!("  Created: {}", wb.created_at);
        println!();
    }

    Ok(())
}

fn run_create(cli: &Cli, name: Option<&str>, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook = client.create_workbook(name)?;

    if json_output {
        return print_json(&workbook);
    }

    let display_name = if workbook.name.is_empty() {
        "(unnamed)"
    } else {
        &workbook.name
    };

    println!();
    println!("Workbook created successfully!");
    println!();
    println!("  ID:      {}", workbook.id);
    println!("  Name:    {}", display_name);
    println!("  Created: {}", workbook.created_at);
    println!();

    Ok(())
}

fn run_show(cli: &Cli, id: &str, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook = client.get_workbook(id)?;

    if json_output {
        return print_json(&workbook);
    }

    let display_name = if workbook.name.is_empty() {
        "(unnamed)"
    } else {
        &workbook.name
    };

    println!();
    println!("  ID:      {}", workbook.id);
    println!("  Name:    {}", display_name);
    println!("  Tables:  {}", workbook.table_count);
    println!("  Created: {}", workbook.created_at);
    println!("  Updated: {}", workbook.updated_at);
    println!();

    Ok(())
}

fn run_delete(cli: &Cli, id: &str, yes: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook = client.get_workbook(id)?;

    let display_name = if workbook.name.is_empty() {
        "(unnamed)".to_string()
    } else {
        workbook.name.clone()
    };

    if !yes {
        if !confirm(&format!(
            "Are you sure you want to delete workbook \"{}\" ({})? [y/N] ",
            display_name, id
        ))? {
            println!("Cancelled.");
            return Ok(());
        }
    }

    client.delete_workbook(id)?;
    println!("Workbook \"{}\" deleted successfully.", display_name);
    Ok(())
}

#[derive(Serialize)]
struct InitResult {
    #[serde(rename = "workbookId")]
    workbook_id: String,
    #[serde(rename = "workbookName")]
    workbook_name: String,
    directory: String,
    #[serde(rename = "fileCount")]
    file_count: i32,
}

fn run_init(cli: &Cli, workbook_id: &str, output_dir: &Path, force: bool, json_output: bool) -> Result<()> {
    let server_url = get_server_url(cli);
    let creds = crate::credentials::load_credentials(&server_url)?;
    if creds.api_token.is_empty() {
        bail!("not logged in. Run 'scratchmd auth login' first");
    }

    let client = crate::api::Client::new(&server_url, Some(&creds.api_token), cli.verbose)?;

    // Check for existing workbook marker
    if let Some(existing_dir) = find_existing_workbook_marker(output_dir, workbook_id) {
        if force {
            std::fs::remove_dir_all(&existing_dir)
                .context("failed to remove existing directory")?;
        } else if json_output {
            bail!(
                "workbook {} is already initialized at {} (use --force to overwrite)",
                workbook_id,
                existing_dir.display()
            );
        } else {
            println!(
                "\nWorkbook is already initialized at {:?}.",
                existing_dir
            );
            if !confirm("Overwrite with fresh files? [y/N]: ")? {
                println!("Cancelled.");
                return Ok(());
            }
            std::fs::remove_dir_all(&existing_dir)
                .context("failed to remove existing directory")?;
        }
    }

    // Get workbook metadata
    let workbook = client.get_workbook(workbook_id)?;
    let workbook_name = if workbook.name.is_empty() {
        workbook_id.to_string()
    } else {
        workbook.name.clone()
    };
    let target_dir = output_dir.join(&workbook_name);

    if workbook.version >= 2 {
        init_v2_workbook(&workbook, &target_dir, &server_url, &creds.api_token, json_output)
    } else {
        init_v1_workbook(&workbook, &target_dir, &server_url, &creds.api_token, json_output)
    }
}

fn init_v1_workbook(
    workbook: &crate::api::workbooks::Workbook,
    target_dir: &Path,
    server_url: &str,
    api_token: &str,
    json_output: bool,
) -> Result<()> {
    if workbook.git_url.is_empty() {
        bail!("server did not return git URL for workbook");
    }

    // Clone via gitoxide
    clone_repo(&workbook.git_url, target_dir, api_token)?;

    // Write workbook marker
    write_workbook_marker(target_dir, workbook, server_url)?;

    // Create data folder markers
    create_data_folder_markers(target_dir, &workbook.data_folders)?;

    let file_count = count_files(target_dir);

    if json_output {
        return print_json(&InitResult {
            workbook_id: workbook.id.clone(),
            workbook_name: workbook.name.clone(),
            directory: target_dir.to_string_lossy().to_string(),
            file_count,
        });
    }

    println!();
    if file_count >= 0 {
        println!(
            "Initialized workbook '{}' ({} files)",
            workbook.name, file_count
        );
    } else {
        println!("Initialized workbook '{}'", workbook.name);
    }
    println!("  Directory: {}", target_dir.display());
    println!();
    Ok(())
}

fn init_v2_workbook(
    workbook: &crate::api::workbooks::Workbook,
    target_dir: &Path,
    server_url: &str,
    api_token: &str,
    json_output: bool,
) -> Result<()> {
    std::fs::create_dir_all(target_dir).context("failed to create workbook directory")?;

    // Write workbook marker
    write_workbook_marker(target_dir, workbook, server_url)?;

    if workbook.connector_accounts.is_empty() {
        if json_output {
            return print_json(&InitResult {
                workbook_id: workbook.id.clone(),
                workbook_name: workbook.name.clone(),
                directory: target_dir.to_string_lossy().to_string(),
                file_count: 0,
            });
        }
        println!();
        println!(
            "Initialized workbook '{}' (no connections yet)",
            workbook.name
        );
        println!("  Directory: {}", target_dir.display());
        println!();
        println!("Add a connection in the web app, then run 'scratchmd workbooks init' again.");
        return Ok(());
    }

    let mut total_files = 0;

    for ca in &workbook.connector_accounts {
        let conn_dir_name = sanitize_filename(&format!("{} - {}", ca.service, ca.display_name));
        let conn_dir = target_dir.join(&conn_dir_name);

        if ca.git_url.is_empty() {
            println!("  Skipping connector {} (no git URL)", ca.display_name);
            continue;
        }

        clone_repo(&ca.git_url, &conn_dir, api_token)?;

        // Write connector marker
        let marker = format!(
            "version: \"2\"\nworkbook:\n  id: \"{}\"\n  name: \"{}\"\nconnector:\n  id: \"{}\"\n  displayName: \"{}\"\n  service: \"{}\"\n",
            workbook.id, workbook.name, ca.id, ca.display_name, ca.service
        );
        std::fs::write(conn_dir.join(".scratchmd"), marker)
            .context("failed to write connector marker")?;

        create_data_folder_markers(&conn_dir, &ca.data_folders)?;

        let fc = count_files(&conn_dir);
        if fc > 0 {
            total_files += fc;
        }
    }

    if json_output {
        return print_json(&InitResult {
            workbook_id: workbook.id.clone(),
            workbook_name: workbook.name.clone(),
            directory: target_dir.to_string_lossy().to_string(),
            file_count: total_files,
        });
    }

    println!();
    println!(
        "Initialized workbook '{}' ({} files, {} connectors)",
        workbook.name,
        total_files,
        workbook.connector_accounts.len()
    );
    println!("  Directory: {}", target_dir.display());
    for ca in &workbook.connector_accounts {
        let conn_dir_name = sanitize_filename(&format!("{} - {}", ca.service, ca.display_name));
        println!("    {}/", conn_dir_name);
    }
    println!();
    Ok(())
}

fn clone_repo(git_url: &str, target_dir: &Path, api_token: &str) -> Result<()> {
    let header = format!("http.extraHeader=Authorization: API-Token {}", api_token);
    let status = std::process::Command::new("git")
        .args([
            "-c",
            &header,
            "clone",
            "--single-branch",
            "--branch",
            "dirty",
            git_url,
            &target_dir.to_string_lossy(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status()
        .context("failed to run git clone")?;

    if !status.success() {
        bail!("git clone failed with exit code {}", status.code().unwrap_or(-1));
    }
    Ok(())
}

fn write_workbook_marker(
    target_dir: &Path,
    workbook: &crate::api::workbooks::Workbook,
    server_url: &str,
) -> Result<()> {
    let version = if workbook.version >= 2 { "2" } else { "1" };
    let marker = format!(
        "version: \"{}\"\nworkbook:\n  id: \"{}\"\n  name: \"{}\"\n  serverUrl: \"{}\"\n  initializedAt: \"{}\"\n",
        version,
        workbook.id,
        workbook.name,
        server_url,
        chrono::Utc::now().to_rfc3339()
    );
    std::fs::write(target_dir.join(".scratchmd"), marker)
        .context("failed to write marker file")?;
    Ok(())
}

fn create_data_folder_markers(
    target_dir: &Path,
    data_folders: &[crate::api::workbooks::DataFolder],
) -> Result<()> {
    let entries = match std::fs::read_dir(target_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    let folder_map: std::collections::HashMap<&str, &crate::api::workbooks::DataFolder> =
        data_folders.iter().map(|df| (df.name.as_str(), df)).collect();

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if let Some(df) = folder_map.get(name_str.as_ref()) {
            let marker = format!(
                "version: \"1\"\ndataFolder:\n  id: \"{}\"\n  name: \"{}\"\n",
                df.id, df.name
            );
            std::fs::write(entry.path().join(".scratchmd"), marker)
                .with_context(|| format!("failed to write marker for {}", name_str))?;
        }
    }

    Ok(())
}

fn count_files(dir: &Path) -> i32 {
    let mut count = 0i32;
    let walker = walkdir::WalkDir::new(dir).into_iter();
    for entry in walker.filter_entry(|e| e.file_name() != ".git") {
        if let Ok(e) = entry {
            if e.file_type().is_file() {
                count += 1;
            }
        }
    }
    count
}
