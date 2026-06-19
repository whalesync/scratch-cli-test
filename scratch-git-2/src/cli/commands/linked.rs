use std::io::{self, BufRead, Write as IoWrite};

use clap::Subcommand;

use crate::api::{self, ApiClient, CreateLinkedTableRequest};
use crate::config;

/// Pull mode for `linked pull` / `linked pull-all`.
#[derive(Clone, Copy, clap::ValueEnum)]
pub enum PullMode {
    /// Full scan (default) — fetch every record and detect deletions
    Full,
    /// Incremental — only records changed since the last pull (connectors that
    /// support it; falls back to full when unsupported or not yet bootstrapped)
    Incremental,
}

impl PullMode {
    fn as_str(self) -> &'static str {
        match self {
            PullMode::Full => "full",
            PullMode::Incremental => "incremental",
        }
    }
}

#[derive(Subcommand)]
pub enum LinkedCommands {
    /// List available tables from a connection (or list connections if no ID given)
    Available {
        /// Connection ID (optional — lists connections if omitted)
        connection_id: Option<String>,
        /// Force refresh from connector (accepted for compatibility; server decides caching)
        #[arg(long)]
        refresh: bool,
    },
    /// List linked tables in the workspace
    List,
    /// Link a new table to the workspace
    Add {
        /// Connection ID
        #[arg(long)]
        connection_id: String,
        /// Table ID(s) to link (repeatable)
        #[arg(long = "table-id")]
        table_ids: Vec<String>,
        /// Name for the linked table
        #[arg(long, default_value = "")]
        name: String,
        /// Connector filter expression (JSON string)
        #[arg(long, default_value = "")]
        filter: String,
    },
    /// Remove a linked table from the workspace
    Remove {
        /// Data folder ID (auto-detected from .scratchmd if not set)
        id: Option<String>,
        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
    /// Show linked table details including pending changes
    Show {
        /// Data folder ID (auto-detected from .scratchmd if not set)
        id: Option<String>,
    },
    /// Pull CRM changes into the workspace
    Pull {
        /// Data folder ID (auto-detected from .scratchmd if not set)
        id: Option<String>,
        /// Pull specific file(s) by path instead of full table (repeatable)
        #[arg(long = "file")]
        files: Vec<String>,
        /// Pull mode (ignored when --file is used). Default: full
        #[arg(long, value_enum, default_value = "full")]
        mode: PullMode,
    },
    /// Publish workspace changes to the CRM
    Publish {
        /// Data folder ID (auto-detected from .scratchmd if not set)
        id: Option<String>,
    },
    /// Pull all linked tables and return job IDs without waiting
    PullAll {
        /// Pull mode applied to every linked table. Default: full
        #[arg(long, value_enum, default_value = "full")]
        mode: PullMode,
    },
}

pub async fn run(
    cmd: LinkedCommands,
    client: &ApiClient,
    workspace: Option<&str>,
    json: bool,
) -> anyhow::Result<()> {
    let workbook_id = config::resolve_workspace_id(workspace)?;
    match cmd {
        LinkedCommands::Available {
            connection_id,
            refresh: _,
        } => available(client, &workbook_id, connection_id.as_deref(), json).await,
        LinkedCommands::List => list(client, &workbook_id, json).await,
        LinkedCommands::Add {
            connection_id,
            table_ids,
            name,
            filter,
        } => {
            add(
                client,
                &workbook_id,
                &connection_id,
                &table_ids,
                &name,
                &filter,
                json,
            )
            .await
        }
        LinkedCommands::Remove { id, yes } => {
            let folder_id = config::resolve_data_folder_id(id.as_deref())?;
            remove(client, &workbook_id, &folder_id, yes, json).await
        }
        LinkedCommands::Show { id } => {
            let folder_id = config::resolve_data_folder_id(id.as_deref())?;
            show(client, &workbook_id, &folder_id, json).await
        }
        LinkedCommands::Pull { id, files, mode } => {
            let folder_id = config::resolve_data_folder_id(id.as_deref())?;
            pull(client, &workbook_id, &folder_id, &files, mode, json).await
        }
        LinkedCommands::Publish { id } => {
            let folder_id = config::resolve_data_folder_id(id.as_deref())?;
            publish(client, &workbook_id, &folder_id, json).await
        }
        LinkedCommands::PullAll { mode } => pull_all(client, &workbook_id, mode).await,
    }
}

async fn available(
    client: &ApiClient,
    workbook_id: &str,
    connection_id: Option<&str>,
    json: bool,
) -> anyhow::Result<()> {
    if connection_id.is_none() {
        // List connections so user can pick one
        let connections = client.list_connections(workbook_id).await?;
        if json {
            println!("{}", serde_json::to_string_pretty(&connections)?);
            return Ok(());
        }
        if connections.is_empty() {
            println!("No connections found in this workspace.");
            println!();
            println!("Add a connection in your workspace first.");
            return Ok(());
        }
        println!();
        println!("Connections in this workspace:");
        for c in &connections {
            println!("  - {} ({})  ID: {}", c.display_name, c.service, c.id);
        }
        println!();
        println!(
            "To list tables for a connection, run: scratchmd linked available <connection-id>"
        );
        return Ok(());
    }

    let conn_id = connection_id.unwrap();
    let table_list = client.list_connection_tables(workbook_id, conn_id).await?;

    if table_list.discovery_mode == "SEARCH" {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({ "discoveryMode": "SEARCH" }))?
            );
        } else {
            println!();
            println!("This connection uses search-based table discovery.");
            println!("Use `scratchmd linked add` to interactively link tables.");
            println!();
        }
        return Ok(());
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&table_list.tables)?);
        return Ok(());
    }

    if table_list.tables.is_empty() {
        println!("No tables found for this connection.");
        return Ok(());
    }

    println!();
    for t in &table_list.tables {
        if t.disabled {
            println!("  - {} (not available)", t.display_name);
        } else if t.disabled_creates {
            println!(
                "  - {} (ID: {}) (creates not supported)",
                t.display_name, t.id
            );
        } else {
            println!("  - {} (ID: {})", t.display_name, t.id);
        }
    }
    println!();
    Ok(())
}

async fn list(client: &ApiClient, workbook_id: &str, json: bool) -> anyhow::Result<()> {
    let groups = client.list_linked_tables(workbook_id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&groups)?);
        return Ok(());
    }

    let total: usize = groups.iter().map(|g| g.data_folders.len()).sum();
    if total == 0 {
        println!("No linked tables found in this workspace.");
        println!();
        println!("Link a table with: scratchmd linked add --connection-id <id> --table-id <id> --name <name>");
        return Ok(());
    }

    println!();
    for group in &groups {
        let service = group
            .service
            .as_deref()
            .map(|s| format!(" ({})", s))
            .unwrap_or_default();
        println!("  {}{}", group.name, service);
        for df in &group.data_folders {
            let lock = df
                .lock
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" [{}]", s))
                .unwrap_or_default();
            println!("    - {}  (ID: {}){}", df.name, df.id, lock);
        }
        println!();
    }
    Ok(())
}

async fn add(
    client: &ApiClient,
    workbook_id: &str,
    connection_id: &str,
    table_ids: &[String],
    name: &str,
    filter: &str,
    json: bool,
) -> anyhow::Result<()> {
    if table_ids.is_empty() {
        anyhow::bail!(
            "No table IDs provided. Use --table-id <id> (repeatable).\n\
             Run `scratchmd linked available {}` to list tables.",
            connection_id
        );
    }

    // Fetch the available tables once: used both for the disabled check and to
    // default the folder name to the table's human display name when --name is omitted.
    let table_list = client
        .list_connection_tables(workbook_id, connection_id)
        .await
        .ok();

    let requested = table_ids.join(",");
    if let Some(list) = &table_list {
        for t in &list.tables {
            if t.id.to_string() == requested && t.disabled {
                anyhow::bail!("Table \"{}\" is not available for linking.", t.display_name);
            }
        }
    }

    let display_name = if !name.is_empty() {
        name.to_string()
    } else {
        // Default to the table's display name (e.g. a Framer collection name like
        // "Field Types") rather than its opaque remote id, so the folder isn't
        // labeled by an id in the UI. Fall back to the id only if the lookup fails.
        table_list
            .as_ref()
            .and_then(|list| list.tables.iter().find(|t| t.id.to_string() == requested))
            .map(|t| t.display_name.clone())
            .unwrap_or_else(|| table_ids[0].clone())
    };

    let req = CreateLinkedTableRequest {
        name: display_name,
        connector_account_id: connection_id.to_string(),
        table_id: table_ids.to_vec(),
        filter: filter.to_string(),
    };

    let result = client.create_linked_table(workbook_id, &req).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!("\nLinked table '{}' created successfully.", result.name);
        println!("  ID: {}", result.id);
        println!("Downloading files...");
    }

    // Trigger files download
    super::files::download_workbook(client.base_url(), client.token(), workbook_id).await
}

async fn remove(
    client: &ApiClient,
    workbook_id: &str,
    folder_id: &str,
    yes: bool,
    json: bool,
) -> anyhow::Result<()> {
    let detail = client.get_linked_table(workbook_id, folder_id).await?;
    let name = &detail.table.name;

    if !yes && !json {
        print!(
            "Are you sure you want to unlink \"{}\" ({})? [y/N] ",
            name, folder_id
        );
        io::stdout().flush()?;
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        let response = line.trim().to_lowercase();
        if response != "y" && response != "yes" {
            println!("Cancelled.");
            return Ok(());
        }
    }

    client.delete_linked_table(workbook_id, folder_id).await?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "success": true,
                "id": folder_id,
                "name": name,
            }))?
        );
    } else {
        println!("Linked table \"{}\" removed successfully.", name);
        println!("Downloading files...");
    }

    super::files::download_workbook(client.base_url(), client.token(), workbook_id).await
}

async fn show(
    client: &ApiClient,
    workbook_id: &str,
    folder_id: &str,
    json: bool,
) -> anyhow::Result<()> {
    let detail = client.get_linked_table(workbook_id, folder_id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&detail)?);
        return Ok(());
    }

    println!();
    println!("  Name:      {}", detail.table.name);
    println!("  ID:        {}", detail.table.id);
    if let Some(s) = &detail.table.connector_service {
        println!("  Service:   {}", s);
    }
    if let Some(n) = &detail.table.connector_display_name {
        println!("  Connector: {}", n);
    }
    if let Some(t) = &detail.table.last_sync_time {
        println!("  Last Sync: {}", t);
    }
    if let Some(lock) = &detail.table.lock {
        if !lock.is_empty() {
            println!("  Lock:      {}", lock);
        }
    }

    println!();
    if detail.has_changes {
        println!("  Pending changes:");
        if detail.creates > 0 {
            println!("    {} new record(s)", detail.creates);
        }
        if detail.updates > 0 {
            println!("    {} updated record(s)", detail.updates);
        }
        if detail.deletes > 0 {
            println!("    {} deleted record(s)", detail.deletes);
        }
    } else {
        println!("  No pending changes.");
    }
    println!();
    Ok(())
}

async fn pull(
    client: &ApiClient,
    workbook_id: &str,
    folder_id: &str,
    file_paths: &[String],
    mode: PullMode,
    json: bool,
) -> anyhow::Result<()> {
    let resp = if file_paths.is_empty() {
        client
            .pull_linked_table(workbook_id, folder_id, mode.as_str())
            .await?
    } else {
        client
            .pull_linked_table_files(workbook_id, folder_id, file_paths)
            .await?
    };

    if !json {
        eprint!(
            "Pull job started (job ID: {}). Waiting for completion",
            resp.job_id
        );
    }

    api::poll_job(client, &resp.job_id).await?;

    if !json {
        println!("Pull completed. Downloading files...");
    }

    super::files::download_workbook(client.base_url(), client.token(), workbook_id).await
}

async fn publish(
    client: &ApiClient,
    workbook_id: &str,
    folder_id: &str,
    json: bool,
) -> anyhow::Result<()> {
    let resp = client.publish_linked_table(workbook_id, folder_id).await?;

    if !json {
        eprint!(
            "Publish job started (job ID: {}). Waiting for completion",
            resp.job_id
        );
    }

    api::poll_job(client, &resp.job_id).await?;

    if !json {
        println!("Publish completed. Downloading files...");
    }

    super::files::download_workbook(client.base_url(), client.token(), workbook_id).await
}

async fn pull_all(client: &ApiClient, workbook_id: &str, mode: PullMode) -> anyhow::Result<()> {
    let resp = client
        .pull_all_linked_tables(workbook_id, mode.as_str())
        .await?;
    println!("{}", serde_json::to_string(&resp)?);
    Ok(())
}
