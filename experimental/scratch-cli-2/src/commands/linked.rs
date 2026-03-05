use anyhow::{bail, Result};
use clap::{Args, Subcommand};
use dialoguer::{Input, MultiSelect, Select};

use crate::cli::Cli;
use crate::commands::helpers::*;

#[derive(Args)]
pub struct LinkedCommand {
    #[command(subcommand)]
    pub action: LinkedAction,

    /// Override workbook auto-detection
    #[arg(long)]
    pub workbook: Option<String>,
}

#[derive(Subcommand)]
pub enum LinkedAction {
    /// List available tables from connections
    Available {
        /// Connection ID (optional — lists connections if omitted)
        id: Option<String>,
        #[arg(long)]
        refresh: bool,
        #[arg(long)]
        json: bool,
    },
    /// List linked tables in a workbook
    List {
        #[arg(long)]
        json: bool,
    },
    /// Link a new table to a workbook
    Add {
        #[arg(long)]
        connection_id: Option<String>,
        #[arg(long)]
        table_id: Vec<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        filter: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Unlink a table from a workbook
    Remove {
        id: Option<String>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
    /// Show linked table details
    Show {
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Pull CRM changes into the workbook
    Pull {
        id: Option<String>,
        #[arg(long)]
        file: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    /// Publish workbook changes to the CRM
    Publish {
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

impl LinkedCommand {
    pub fn run(&self, cli: &Cli) -> Result<()> {
        match &self.action {
            LinkedAction::Available { id, json, .. } => {
                run_available(cli, self.workbook.as_deref(), id.as_deref(), *json)
            }
            LinkedAction::List { json } => run_list(cli, self.workbook.as_deref(), *json),
            LinkedAction::Add {
                connection_id,
                table_id,
                name,
                filter,
                json,
            } => run_add(
                cli,
                self.workbook.as_deref(),
                connection_id.as_deref(),
                table_id,
                name.as_deref(),
                filter.as_deref(),
                *json,
            ),
            LinkedAction::Remove { id, yes, json } => {
                run_remove(cli, self.workbook.as_deref(), id.as_deref(), *yes, *json)
            }
            LinkedAction::Show { id, json } => {
                run_show(cli, self.workbook.as_deref(), id.as_deref(), *json)
            }
            LinkedAction::Pull { id, file, json } => {
                run_pull(cli, self.workbook.as_deref(), id.as_deref(), file, *json)
            }
            LinkedAction::Publish { id, json } => {
                run_publish(cli, self.workbook.as_deref(), id.as_deref(), *json)
            }
        }
    }
}

fn run_available(
    cli: &Cli,
    workbook_flag: Option<&str>,
    connection_id: Option<&str>,
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;

    if connection_id.is_none() {
        let connections = client.list_connections(&workbook_id)?;
        if json_output {
            return print_json(&connections);
        }
        if connections.is_empty() {
            println!("No connections found in this workbook.");
            println!();
            println!("Add a connection in your workbook at https://app.scratch.md to see available tables.");
            return Ok(());
        }
        println!();
        println!("Connections in this workbook:");
        for conn in &connections {
            println!("  - {} ({})  ID: {}", conn.display_name, conn.service, conn.id);
        }
        println!();
        println!("To list tables for a connection, run: scratchmd linked available <connection-id>");
        return Ok(());
    }

    let conn_id = connection_id.unwrap();
    let table_list = client.list_connection_tables(&workbook_id, conn_id)?;

    if table_list.discovery_mode == "SEARCH" {
        if json_output {
            return print_json(&table_list);
        }
        println!();
        println!("This connection uses search-based table discovery.");
        println!("Use `scratchmd linked add` to interactively search for and link tables.");
        println!();
        return Ok(());
    }

    if json_output {
        return print_json(&table_list.tables);
    }

    if table_list.tables.is_empty() {
        println!("No tables found for this connection.");
        return Ok(());
    }

    println!();
    for table in &table_list.tables {
        if table.disabled {
            println!("  - {} (not available)", table.display_name);
        } else if table.disabled_creates {
            println!("  - {} (ID: {}) (creates not supported)", table.display_name, table.id);
        } else {
            println!("  - {} (ID: {})", table.display_name, table.id);
        }
    }
    println!();
    Ok(())
}

fn run_list(cli: &Cli, workbook_flag: Option<&str>, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let groups = client.list_linked_tables(&workbook_id)?;

    if json_output {
        return print_json(&groups);
    }

    let total: usize = groups.iter().map(|g| g.data_folders.len()).sum();
    if total == 0 {
        println!("No linked tables found in this workbook.");
        println!();
        println!("Link a table with: scratchmd linked add");
        return Ok(());
    }

    println!();
    for group in &groups {
        let service = group
            .service
            .as_ref()
            .map(|s| format!(" ({})", s))
            .unwrap_or_default();
        println!("  {}{}", group.name, service);
        for df in &group.data_folders {
            let lock = df
                .lock
                .as_ref()
                .filter(|l| !l.is_empty())
                .map(|l| format!(" [{}]", l))
                .unwrap_or_default();
            println!("    - {}  (ID: {}){}", df.name, df.id, lock);
        }
        println!();
    }
    Ok(())
}

fn run_add(
    cli: &Cli,
    workbook_flag: Option<&str>,
    connection_id: Option<&str>,
    table_ids: &[String],
    name: Option<&str>,
    _filter: Option<&str>,
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;

    if let (Some(conn_id), true) = (connection_id, !table_ids.is_empty()) {
        // Non-interactive mode
        let link_name = name.unwrap_or(&table_ids[0]).to_string();
        let result = client.create_linked_table(
            &workbook_id,
            &link_name,
            conn_id,
            table_ids.to_vec(),
        )?;

        if json_output {
            return print_json(&result);
        }
        println!("\nLinked table '{}' created successfully.", result.name);
        println!("  ID: {}", result.id);
        println!();
        return Ok(());
    }

    // Interactive mode
    let connections = client.list_connections(&workbook_id)?;
    if connections.is_empty() {
        bail!("no connections found in this workbook. Add a connection in your workbook at https://app.scratch.md first");
    }

    let selected_connection = if connections.len() == 1 {
        println!("Using connection: {} ({})", connections[0].display_name, connections[0].service);
        &connections[0]
    } else {
        let options: Vec<String> = connections
            .iter()
            .map(|c| format!("{} ({})", c.display_name, c.service))
            .collect();
        let idx = Select::new()
            .with_prompt("Select a connection")
            .items(&options)
            .interact()?;
        &connections[idx]
    };

    let table_list = client.list_connection_tables(&workbook_id, &selected_connection.id)?;

    let tables = if table_list.discovery_mode == "SEARCH" {
        let search_term: String = Input::new()
            .with_prompt("Search for a table")
            .interact_text()?;
        if search_term.is_empty() {
            bail!("search term is required");
        }
        let search_result = client.search_connection_tables(
            &workbook_id,
            &selected_connection.id,
            &search_term,
        )?;
        if search_result.has_more {
            println!(
                "Showing first {} results. Refine your search for more specific results.",
                search_result.tables.len()
            );
        }
        search_result.tables
    } else {
        table_list.tables
    };

    if tables.is_empty() {
        bail!("no tables found for connection '{}'", selected_connection.display_name);
    }

    let options: Vec<String> = tables
        .iter()
        .map(|t| {
            if t.disabled {
                format!("{} (not available)", t.display_name)
            } else if t.disabled_creates {
                format!("{} (creates not supported)", t.display_name)
            } else {
                format!("{} (ID: {})", t.display_name, t.id)
            }
        })
        .collect();

    let selected_idxs = MultiSelect::new()
        .with_prompt("Select table(s) to link")
        .items(&options)
        .interact()?;

    if selected_idxs.is_empty() {
        bail!("no tables selected");
    }

    for &idx in &selected_idxs {
        if tables[idx].disabled {
            bail!("table {:?} is not available for linking", tables[idx].display_name);
        }
    }

    // Collect table IDs — the id field is a serde_json::Value (can be string or structured)
    let mut selected_table_ids = Vec::new();
    for &idx in &selected_idxs {
        match &tables[idx].id {
            serde_json::Value::String(s) => {
                for part in s.split(',') {
                    selected_table_ids.push(part.to_string());
                }
            }
            serde_json::Value::Object(obj) => {
                if let Some(serde_json::Value::Array(arr)) = obj.get("remoteId") {
                    for v in arr {
                        if let serde_json::Value::String(s) = v {
                            selected_table_ids.push(s.clone());
                        }
                    }
                }
            }
            _ => {
                selected_table_ids.push(tables[idx].id.to_string());
            }
        }
    }

    let default_name = &tables[selected_idxs[0]].display_name;
    let folder_name: String = Input::new()
        .with_prompt("Name for the linked table")
        .default(default_name.clone())
        .interact_text()?;
    let folder_name = if folder_name.is_empty() {
        default_name.clone()
    } else {
        folder_name
    };

    let result = client.create_linked_table(
        &workbook_id,
        &folder_name,
        &selected_connection.id,
        selected_table_ids,
    )?;

    if json_output {
        return print_json(&result);
    }
    println!("\nLinked table '{}' created successfully.", result.name);
    println!("  ID: {}", result.id);
    println!();
    Ok(())
}

fn run_remove(cli: &Cli, workbook_flag: Option<&str>, id: Option<&str>, yes: bool, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let (workbook_id, folder_id) = resolve_linked_context(workbook_flag, id)?;

    let detail = client.get_linked_table(&workbook_id, &folder_id)?;

    if !yes && !json_output {
        if !confirm(&format!(
            "Are you sure you want to unlink \"{}\" ({})? [y/N] ",
            detail.linked_table.name, detail.linked_table.id
        ))? {
            println!("Cancelled.");
            return Ok(());
        }
    }

    client.delete_linked_table(&workbook_id, &folder_id)?;

    if json_output {
        return print_json(&serde_json::json!({
            "success": true,
            "id": detail.linked_table.id,
            "name": detail.linked_table.name,
        }));
    }

    println!(
        "Linked table \"{}\" removed successfully.",
        detail.linked_table.name
    );
    Ok(())
}

fn run_show(cli: &Cli, workbook_flag: Option<&str>, id: Option<&str>, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let (workbook_id, folder_id) = resolve_linked_context(workbook_flag, id)?;

    let detail = client.get_linked_table(&workbook_id, &folder_id)?;

    if json_output {
        return print_json(&detail);
    }

    println!();
    println!("  Name:      {}", detail.linked_table.name);
    println!("  ID:        {}", detail.linked_table.id);
    if let Some(ref s) = detail.linked_table.connector_service {
        println!("  Service:   {}", s);
    }
    if let Some(ref n) = detail.linked_table.connector_display_name {
        println!("  Connector: {}", n);
    }
    if let Some(ref t) = detail.linked_table.last_sync_time {
        println!("  Last Sync: {}", t);
    }
    if let Some(ref l) = detail.linked_table.lock {
        if !l.is_empty() {
            println!("  Lock:      {}", l);
        }
    }

    if detail.has_changes {
        println!();
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
        println!();
        println!("  No pending changes.");
    }
    println!();
    Ok(())
}

fn run_pull(
    cli: &Cli,
    workbook_flag: Option<&str>,
    id: Option<&str>,
    file_paths: &[String],
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let (workbook_id, folder_id) = resolve_linked_context(workbook_flag, id)?;

    let resp = if !file_paths.is_empty() {
        client.pull_linked_table_files(&workbook_id, &folder_id, file_paths)?
    } else {
        client.pull_linked_table(&workbook_id, &folder_id)?
    };

    if !json_output {
        eprint!(
            "Pull job started (job ID: {}). Waiting for completion",
            resp.job_id
        );
    }

    poll_job_until_done(&client, &resp.job_id)?;

    if json_output {
        return print_json(&serde_json::json!({
            "success": true,
            "jobId": resp.job_id,
            "message": "Pull completed successfully"
        }));
    }

    println!("Pull completed.");
    // Note: In the full implementation, this would trigger files download
    Ok(())
}

fn run_publish(
    cli: &Cli,
    workbook_flag: Option<&str>,
    id: Option<&str>,
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let (workbook_id, folder_id) = resolve_linked_context(workbook_flag, id)?;

    let resp = client.publish_linked_table(&workbook_id, &folder_id)?;

    if !json_output {
        eprint!(
            "Publish job started (job ID: {}). Waiting for completion",
            resp.job_id
        );
    }

    poll_job_until_done(&client, &resp.job_id)?;

    if json_output {
        return print_json(&serde_json::json!({
            "success": true,
            "jobId": resp.job_id,
            "message": "Publish completed successfully"
        }));
    }

    println!("Publish completed.");
    // Note: In the full implementation, this would trigger files download
    Ok(())
}
