use std::io::{self, BufRead, Write as IoWrite};
use std::path::PathBuf;

use clap::Subcommand;

use crate::api::{self, ApiClient, Sync};
use crate::config;

#[derive(Subcommand)]
pub enum SyncsCommands {
    /// List sync configurations
    List,
    /// Show sync details
    Show {
        /// Sync ID
        id: String,
    },
    /// Create a new sync from a JSON config (file path or inline JSON)
    Create {
        /// JSON config: file path or inline JSON string
        #[arg(long)]
        config: String,
    },
    /// Update a sync from a JSON config
    Update {
        /// Sync ID
        id: String,
        /// JSON config: file path or inline JSON string
        #[arg(long)]
        config: String,
    },
    /// Delete a sync
    Delete {
        /// Sync ID
        id: String,
        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
    /// Execute a sync and wait for completion
    Run {
        /// Sync ID
        id: String,
        /// Return immediately with job ID instead of waiting
        #[arg(long)]
        no_wait: bool,
    },
    /// Download sync configs as JSON files to a local directory
    Download {
        /// Download a specific sync by ID (default: all syncs)
        #[arg(long)]
        id: Option<String>,
        /// Output directory (default: syncs/ inside the workspace directory)
        #[arg(long, short = 'o')]
        output: Option<String>,
    },
}

pub async fn run(
    cmd: SyncsCommands,
    client: &ApiClient,
    workspace: Option<&str>,
    json: bool,
) -> anyhow::Result<()> {
    let workbook_id = config::resolve_workspace_id(workspace)?;
    match cmd {
        SyncsCommands::List => list(client, &workbook_id, json).await,
        SyncsCommands::Show { id } => show(client, &workbook_id, &id, json).await,
        SyncsCommands::Create { config } => create(client, &workbook_id, &config, json).await,
        SyncsCommands::Update { id, config } => update(client, &workbook_id, &id, &config, json).await,
        SyncsCommands::Delete { id, yes } => delete(client, &workbook_id, &id, yes, json).await,
        SyncsCommands::Run { id, no_wait } => run_sync(client, &workbook_id, &id, no_wait, json).await,
        SyncsCommands::Download { id, output } => {
            download(client, &workbook_id, id.as_deref(), output.as_deref(), json).await
        }
    }
}

async fn list(client: &ApiClient, workbook_id: &str, json: bool) -> anyhow::Result<()> {
    let syncs = client.list_syncs(workbook_id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&syncs)?);
        return Ok(());
    }

    if syncs.is_empty() {
        println!("No syncs found in this workspace.");
        println!();
        println!("Create one with: scratchmd2 syncs create --config sync-config.json");
        return Ok(());
    }

    println!();
    println!("Found {} sync(s):", syncs.len());
    println!();
    for s in &syncs {
        let name = if s.display_name.is_empty() { "(unnamed)" } else { &s.display_name };
        println!("  Name:    {}", name);
        println!("  ID:      {}", s.id);
        if !s.sync_state.is_empty() {
            println!("  State:   {}", s.sync_state);
        }
        if let Some(t) = &s.last_sync_time {
            println!("  Last:    {}", t);
        }
        println!("  Pairs:   {}", s.sync_table_pairs.len());
        println!();
    }
    Ok(())
}

async fn show(client: &ApiClient, workbook_id: &str, id: &str, json: bool) -> anyhow::Result<()> {
    let raw: serde_json::Value = client.get_sync_raw(workbook_id, id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&raw)?);
        return Ok(());
    }

    println!();
    pretty_print(&raw, 1);
    Ok(())
}

fn pretty_print(v: &serde_json::Value, indent: usize) {
    let prefix = "  ".repeat(indent);
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&str> = map.keys().map(|s| s.as_str()).collect();
            keys.sort_by(|a, b| key_rank(a).cmp(&key_rank(b)).then(a.cmp(b)));
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
                            match item {
                                serde_json::Value::Object(_) => {
                                    if i > 0 {
                                        println!();
                                    }
                                    println!("{}[{}]", &(prefix.clone() + "  "), i + 1);
                                    pretty_print(item, indent + 2);
                                }
                                _ => println!("{}- {}", &(prefix.clone() + "  "), item),
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

fn key_rank(k: &str) -> u8 {
    match k.to_lowercase().as_str() {
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
        } else if c.is_uppercase() {
            result.push(' ');
            result.push(c);
        } else {
            result.push(c);
        }
    }
    result
}

fn load_config_value(config: &str) -> anyhow::Result<serde_json::Value> {
    // Try as file path first
    if std::path::Path::new(config).exists() {
        let data = std::fs::read_to_string(config)?;
        return Ok(serde_json::from_str(&data)?);
    }
    // Treat as inline JSON
    Ok(serde_json::from_str(config)
        .map_err(|_| anyhow::anyhow!("config value is not valid JSON and is not a readable file path"))?)
}

async fn create(client: &ApiClient, workbook_id: &str, config: &str, json: bool) -> anyhow::Result<()> {
    let body = load_config_value(config)?;
    let sync = client.create_sync(workbook_id, &body).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&sync)?);
        return Ok(());
    }

    let name = if sync.display_name.is_empty() { "(unnamed)" } else { &sync.display_name };
    println!();
    println!("Sync \"{}\" created successfully.", name);
    println!("  ID: {}", sync.id);
    println!();
    Ok(())
}

async fn update(
    client: &ApiClient,
    workbook_id: &str,
    id: &str,
    config: &str,
    json: bool,
) -> anyhow::Result<()> {
    let body = load_config_value(config)?;
    let sync = client.update_sync(workbook_id, id, &body).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&sync)?);
        return Ok(());
    }

    let name = if sync.display_name.is_empty() { "(unnamed)" } else { &sync.display_name };
    println!();
    println!("Sync \"{}\" updated successfully.", name);
    println!();
    Ok(())
}

async fn delete(
    client: &ApiClient,
    workbook_id: &str,
    id: &str,
    yes: bool,
    json: bool,
) -> anyhow::Result<()> {
    let sync = client.get_sync(workbook_id, id).await?;
    let name = display_name(&sync);

    if !yes && !json {
        print!("Are you sure you want to delete sync \"{}\" ({})? [y/N] ", name, id);
        io::stdout().flush()?;
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        let response = line.trim().to_lowercase();
        if response != "y" && response != "yes" {
            println!("Cancelled.");
            return Ok(());
        }
    }

    client.delete_sync(workbook_id, id).await?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "success": true,
                "id": id,
                "name": name,
            }))?
        );
    } else {
        println!("Sync \"{}\" deleted successfully.", name);
    }
    Ok(())
}

async fn run_sync(
    client: &ApiClient,
    workbook_id: &str,
    id: &str,
    no_wait: bool,
    json: bool,
) -> anyhow::Result<()> {
    let resp = client.run_sync(workbook_id, id).await?;

    if no_wait {
        if json {
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "jobId": resp.job_id }))?);
        } else {
            println!("Sync job queued (job ID: {}).", resp.job_id);
        }
        return Ok(());
    }

    eprint!("Sync job started (job ID: {}). Waiting for completion", resp.job_id);
    api::poll_job(client, &resp.job_id).await?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "success": true,
                "jobId": resp.job_id,
                "message": "Sync completed successfully"
            }))?
        );
    } else {
        println!("Sync completed successfully.");
    }
    Ok(())
}

async fn download(
    client: &ApiClient,
    workbook_id: &str,
    sync_id: Option<&str>,
    output: Option<&str>,
    json: bool,
) -> anyhow::Result<()> {
    // Resolve output directory
    let output_dir: PathBuf = if let Some(o) = output {
        PathBuf::from(o)
    } else {
        // Default: syncs/ inside the workspace directory
        match config::find_workspace_dir(workbook_id) {
            Some(wb_dir) => wb_dir.join("syncs"),
            None => anyhow::bail!(
                "Workspace {} is not initialized locally. Run 'scratchmd2 workspaces init {}' first, \
                 or use --output to specify a directory.",
                workbook_id,
                workbook_id
            ),
        }
    };

    let configs = if let Some(id) = sync_id {
        client.export_sync(workbook_id, id).await?
    } else {
        client.export_syncs(workbook_id).await?
    };

    if configs.is_empty() {
        if json {
            println!("[]");
        } else {
            println!("No syncs found in this workspace.");
        }
        return Ok(());
    }

    std::fs::create_dir_all(&output_dir)?;

    let mut written: Vec<String> = Vec::new();
    for cfg in &configs {
        let data = format!("{}\n", serde_json::to_string_pretty(cfg)?);
        let filename = sync_config_filename(&cfg.display_name, &cfg.id);
        let file_path = output_dir.join(&filename);
        std::fs::write(&file_path, data.as_bytes())?;
        written.push(file_path.display().to_string());
    }

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "success": true,
                "count": written.len(),
                "files": written,
                "output": output_dir.display().to_string(),
            }))?
        );
    } else {
        println!();
        println!("Downloaded {} sync config(s) to {}/", written.len(), output_dir.display());
        println!();
        for f in &written {
            println!("  {}", f);
        }
        println!();
        println!("To update a sync from a downloaded config:");
        println!("  scratchmd2 syncs update <sync-id> --config <file>");
        println!();
    }
    Ok(())
}

fn display_name(s: &Sync) -> &str {
    if s.display_name.is_empty() { "(unnamed)" } else { &s.display_name }
}

fn sync_config_filename(display_name: &str, sync_id: &str) -> String {
    let name = if display_name.is_empty() { sync_id } else { display_name };
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            ' ' => '-',
            other => other,
        })
        .collect();
    format!("{}.json", sanitized.to_lowercase())
}
