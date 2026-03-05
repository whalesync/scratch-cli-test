use std::path::Path;

use anyhow::Result;
use clap::{Args, Subcommand};

use crate::cli::Cli;
use crate::commands::helpers::*;

#[derive(Args)]
pub struct SyncsCommand {
    #[command(subcommand)]
    pub action: SyncsAction,

    /// Override workbook auto-detection
    #[arg(long)]
    pub workbook: Option<String>,
}

#[derive(Subcommand)]
pub enum SyncsAction {
    /// List sync configurations
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show sync details
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Create a new sync configuration
    Create {
        /// JSON config (file path or inline)
        #[arg(long)]
        config: String,
        #[arg(long)]
        json: bool,
    },
    /// Update a sync configuration
    Update {
        id: String,
        /// JSON config (file path or inline)
        #[arg(long)]
        config: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete a sync
    Delete {
        id: String,
        #[arg(long)]
        yes: bool,
    },
    /// Execute a sync
    Run {
        id: String,
        #[arg(long)]
        no_wait: bool,
        #[arg(long)]
        json: bool,
    },
}

impl SyncsCommand {
    pub fn run(&self, cli: &Cli) -> Result<()> {
        match &self.action {
            SyncsAction::List { json } => run_list(cli, self.workbook.as_deref(), *json),
            SyncsAction::Show { id, json } => run_show(cli, self.workbook.as_deref(), id, *json),
            SyncsAction::Create { config, json } => {
                run_create(cli, self.workbook.as_deref(), config, *json)
            }
            SyncsAction::Update { id, config, json } => {
                run_update(cli, self.workbook.as_deref(), id, config, *json)
            }
            SyncsAction::Delete { id, yes } => run_delete(cli, self.workbook.as_deref(), id, *yes),
            SyncsAction::Run { id, no_wait, json } => {
                run_run(cli, self.workbook.as_deref(), id, *no_wait, *json)
            }
        }
    }
}

/// Load --config value as either a file path or inline JSON.
fn load_config_flag(config_value: &str) -> Result<serde_json::Value> {
    // Check if it's a file path
    if Path::new(config_value).exists() {
        let data = std::fs::read_to_string(config_value)?;
        let value: serde_json::Value =
            serde_json::from_str(&data).map_err(|_| anyhow::anyhow!("config file does not contain valid JSON"))?;
        return Ok(value);
    }

    // Treat as inline JSON
    let value: serde_json::Value = serde_json::from_str(config_value)
        .map_err(|_| anyhow::anyhow!("config value is not valid JSON and is not a readable file path"))?;
    Ok(value)
}

fn run_list(cli: &Cli, workbook_flag: Option<&str>, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let syncs = client.list_syncs(&workbook_id)?;

    if json_output {
        return print_json(&syncs);
    }

    if syncs.is_empty() {
        println!("No syncs found in this workbook.");
        println!();
        println!("Create one with: scratchmd syncs create --config sync-config.json");
        return Ok(());
    }

    println!();
    println!("Found {} sync(s):", syncs.len());
    println!();

    for s in &syncs {
        let name = if s.display_name.is_empty() {
            "(unnamed)"
        } else {
            &s.display_name
        };
        println!("  Name:    {}", name);
        println!("  ID:      {}", s.id);
        if !s.sync_state.is_empty() {
            println!("  State:   {}", s.sync_state);
        }
        if let Some(ref t) = s.last_sync_time {
            println!("  Last:    {}", t);
        }
        println!("  Pairs:   {}", s.sync_table_pairs.len());
        println!();
    }

    Ok(())
}

fn run_show(cli: &Cli, workbook_flag: Option<&str>, sync_id: &str, json_output: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;

    if json_output {
        let sync = client.get_sync(&workbook_id, sync_id)?;
        return print_json(&sync);
    }

    let raw = client.get_sync_raw(&workbook_id, sync_id)?;
    println!();
    pretty_print(&raw, 1);
    Ok(())
}

/// Recursively pretty-print a JSON value.
fn pretty_print(v: &serde_json::Value, indent: usize) {
    let prefix = "  ".repeat(indent);
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| {
                let ra = key_rank(a);
                let rb = key_rank(b);
                ra.cmp(&rb).then_with(|| a.cmp(b))
            });
            for key in keys {
                let child = &map[key];
                let label = camel_to_title(key);
                match child {
                    serde_json::Value::Object(_) => {
                        println!("{}{}:", prefix, label);
                        pretty_print(child, indent + 1);
                    }
                    serde_json::Value::Array(arr) => {
                        println!("{}{}:", prefix, label);
                        for (i, item) in arr.iter().enumerate() {
                            if i > 0 {
                                println!();
                            }
                            if item.is_object() {
                                println!("{}  [{}]", prefix, i + 1);
                                pretty_print(item, indent + 2);
                            } else {
                                println!("{}  - {}", prefix, item);
                            }
                        }
                    }
                    serde_json::Value::Null => println!("{}{}: -", prefix, label),
                    _ => println!("{}{}: {}", prefix, label, child),
                }
            }
        }
        _ => println!("{}{}", prefix, v),
    }
}

fn key_rank(key: &str) -> u8 {
    match key.to_lowercase().as_str() {
        "id" => 0,
        "name" | "displayname" => 1,
        _ => 2,
    }
}

fn camel_to_title(s: &str) -> String {
    let mut result = String::new();
    for (i, c) in s.chars().enumerate() {
        if i == 0 {
            result.extend(c.to_uppercase());
        } else {
            if c.is_uppercase() {
                result.push(' ');
            }
            result.push(c);
        }
    }
    result
}

fn run_create(
    cli: &Cli,
    workbook_flag: Option<&str>,
    config_value: &str,
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let config_data = load_config_flag(config_value)?;
    let sync = client.create_sync(&workbook_id, &config_data)?;

    if json_output {
        return print_json(&sync);
    }

    let name = if sync.display_name.is_empty() {
        "(unnamed)"
    } else {
        &sync.display_name
    };
    println!();
    println!("Sync \"{}\" created successfully.", name);
    println!("  ID: {}", sync.id);
    println!();
    Ok(())
}

fn run_update(
    cli: &Cli,
    workbook_flag: Option<&str>,
    sync_id: &str,
    config_value: &str,
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let config_data = load_config_flag(config_value)?;
    let sync = client.update_sync(&workbook_id, sync_id, &config_data)?;

    if json_output {
        return print_json(&sync);
    }

    let name = if sync.display_name.is_empty() {
        "(unnamed)"
    } else {
        &sync.display_name
    };
    println!();
    println!("Sync \"{}\" updated successfully.", name);
    println!();
    Ok(())
}

fn run_delete(cli: &Cli, workbook_flag: Option<&str>, sync_id: &str, yes: bool) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let sync = client.get_sync(&workbook_id, sync_id)?;

    let name = if sync.display_name.is_empty() {
        "(unnamed)".to_string()
    } else {
        sync.display_name.clone()
    };

    if !yes {
        if !confirm(&format!(
            "Are you sure you want to delete sync \"{}\" ({})? [y/N] ",
            name, sync_id
        ))? {
            println!("Cancelled.");
            return Ok(());
        }
    }

    client.delete_sync(&workbook_id, sync_id)?;
    println!("Sync \"{}\" deleted successfully.", name);
    Ok(())
}

fn run_run(
    cli: &Cli,
    workbook_flag: Option<&str>,
    sync_id: &str,
    no_wait: bool,
    json_output: bool,
) -> Result<()> {
    let client = get_authenticated_client(cli)?;
    let workbook_id = resolve_workbook_context(workbook_flag)?;
    let resp = client.run_sync(&workbook_id, sync_id)?;

    if json_output && no_wait {
        return print_json(&resp);
    }

    if no_wait {
        println!("Sync job queued (job ID: {}).", resp.job_id);
        return Ok(());
    }

    eprint!(
        "Sync job started (job ID: {}). Waiting for completion",
        resp.job_id
    );
    poll_job_until_done(&client, &resp.job_id)?;

    if json_output {
        return print_json(&serde_json::json!({
            "success": true,
            "jobId": resp.job_id,
            "message": "Sync completed successfully"
        }));
    }

    println!("Sync completed successfully.");
    Ok(())
}
