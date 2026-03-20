use std::collections::HashMap;
use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use clap::Subcommand;
use serde::Deserialize;

use crate::api::{self, ApiClient, Sync};
use crate::config;
use crate::config::markers;

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
    /// Validate local sync configs (checks connections/folders exist)
    #[command(name = "validate-local")]
    ValidateLocal {
        /// Path to a specific sync config file (default: all in .scratch/workbook/syncs/)
        #[arg(long)]
        sync: Option<String>,
    },
    /// Run a sync locally against files on disk
    #[command(name = "run-local")]
    RunLocal {
        /// Path to a specific sync config file (default: all in .scratch/workbook/syncs/)
        #[arg(long)]
        sync: Option<String>,
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
        // Local commands are handled before client creation in main.rs
        SyncsCommands::ValidateLocal { .. } | SyncsCommands::RunLocal { .. } => unreachable!(),
    }
}

pub fn run_local_cmd(cmd: SyncsCommands, json: bool) -> anyhow::Result<()> {
    match cmd {
        SyncsCommands::ValidateLocal { sync } => validate_local(sync.as_deref(), json),
        SyncsCommands::RunLocal { sync } => run_local(sync.as_deref(), json),
        _ => unreachable!(),
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

// ---------------------------------------------------------------------------
// Local sync output types (mirrors experimental/scratch-v4-backend)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SyncValidationError {
    #[serde(skip_serializing_if = "Option::is_none")]
    table_mapping_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    field_mapping_index: Option<FieldMappingRef>,
    error_msg: String,
    #[serde(rename = "type")]
    error_type: LocalErrorType,
}

#[derive(serde::Serialize, Debug)]
#[serde(untagged)]
enum FieldMappingRef {
    Index(usize),
    Matching(String),
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "snake_case")]
enum LocalErrorType {
    InvalidJson,
    InvalidStructure,
    InvalidField,
}

#[derive(serde::Serialize, Debug)]
struct ValidationResult {
    sync: String,
    errors: Vec<SyncValidationError>,
}

// ---------------------------------------------------------------------------
// Local sync config types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSyncConfig {
    #[allow(dead_code)]
    version: u32,
    source: LocalSyncEndpoint,
    destination: LocalSyncEndpoint,
    field_mappings: Vec<FieldMapping>,
    record_matching: Option<RecordMatching>,
}

#[derive(Debug, Deserialize)]
struct LocalSyncEndpoint {
    connection: String,
    folder: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldMapping {
    source_field: String,
    dest_field: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordMatching {
    source_field: String,
    dest_field: String,
}

// ---------------------------------------------------------------------------
// validate-local
// ---------------------------------------------------------------------------

fn validate_local(sync_path: Option<&str>, _json: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let wb_dir = markers::find_nearest_workspace(&cwd)
        .ok_or_else(|| anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory."))?;

    let syncs_dir = wb_dir.join(".scratch/workbook/syncs");
    if !syncs_dir.exists() {
        anyhow::bail!(
            "syncs directory not found at {}. Run `scratchmd2 files download` first.",
            syncs_dir.display()
        );
    }

    let sync_files = collect_local_sync_files(&syncs_dir, sync_path)?;
    if sync_files.is_empty() {
        println!("No sync configs found in {}", syncs_dir.display());
        return Ok(());
    }

    let mut all_results: Vec<ValidationResult> = Vec::new();
    let mut any_errors = false;

    for sync_file in &sync_files {
        let name = sync_file.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let errors = validate_sync_file(sync_file, &wb_dir);
        if !errors.is_empty() {
            any_errors = true;
        }
        all_results.push(ValidationResult { sync: name, errors });
    }

    println!("{}", serde_json::to_string_pretty(&all_results)?);

    if any_errors {
        std::process::exit(1);
    }
    Ok(())
}

fn validate_sync_file(path: &Path, workspace: &Path) -> Vec<SyncValidationError> {
    let mut errors: Vec<SyncValidationError> = Vec::new();

    // Check 1: valid JSON
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            errors.push(SyncValidationError {
                table_mapping_index: None,
                field_mapping_index: None,
                error_msg: format!("cannot read file: {e}"),
                error_type: LocalErrorType::InvalidJson,
            });
            return errors;
        }
    };

    let json_value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            errors.push(SyncValidationError {
                table_mapping_index: None,
                field_mapping_index: None,
                error_msg: format!("invalid JSON: {e}"),
                error_type: LocalErrorType::InvalidJson,
            });
            return errors;
        }
    };

    // Check 2: valid structure
    let config: LocalSyncConfig = match serde_json::from_value(json_value) {
        Ok(c) => c,
        Err(e) => {
            errors.push(SyncValidationError {
                table_mapping_index: None,
                field_mapping_index: None,
                error_msg: format!("invalid sync structure: {e}"),
                error_type: LocalErrorType::InvalidStructure,
            });
            return errors;
        }
    };

    // Check 3: tables and fields exist (including schema key validation)
    errors.extend(validate_sync_fields(&config, workspace));

    errors
}

fn validate_sync_fields(config: &LocalSyncConfig, workspace: &Path) -> Vec<SyncValidationError> {
    let mut errors = Vec::new();

    let source_schema = load_local_schema(workspace, &config.source.connection, &config.source.folder);
    let dest_schema = load_local_schema(workspace, &config.destination.connection, &config.destination.folder);

    // Check source folder exists
    let source_dir = workspace.join(&config.source.connection).join(&config.source.folder);
    if !source_dir.exists() {
        errors.push(SyncValidationError {
            table_mapping_index: Some(0),
            field_mapping_index: None,
            error_msg: format!(
                "source folder not found: {}/{}",
                config.source.connection, config.source.folder
            ),
            error_type: LocalErrorType::InvalidField,
        });
    }

    // Check destination folder exists
    let dest_dir = workspace.join(&config.destination.connection).join(&config.destination.folder);
    if !dest_dir.exists() {
        errors.push(SyncValidationError {
            table_mapping_index: Some(1),
            field_mapping_index: None,
            error_msg: format!(
                "destination folder not found: {}/{}",
                config.destination.connection, config.destination.folder
            ),
            error_type: LocalErrorType::InvalidField,
        });
    }

    // Validate each field mapping against schemas
    for (i, mapping) in config.field_mappings.iter().enumerate() {
        if let Some(schema) = &source_schema {
            if !local_schema_has_path(schema, &mapping.source_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Index(i)),
                    error_msg: format!(
                        "sourceField '{}' not found in source schema ({}/{})",
                        mapping.source_field, config.source.connection, config.source.folder
                    ),
                    error_type: LocalErrorType::InvalidField,
                });
            }
        }
        if let Some(schema) = &dest_schema {
            if !local_schema_has_path(schema, &mapping.dest_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Index(i)),
                    error_msg: format!(
                        "destField '{}' not found in destination schema ({}/{})",
                        mapping.dest_field, config.destination.connection, config.destination.folder
                    ),
                    error_type: LocalErrorType::InvalidField,
                });
            }
        }
    }

    // Validate recordMatching fields
    if let Some(rm) = &config.record_matching {
        if let Some(schema) = &source_schema {
            if !local_schema_has_path(schema, &rm.source_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Matching("matching".into())),
                    error_msg: format!(
                        "recordMatching.sourceField '{}' not found in source schema ({}/{})",
                        rm.source_field, config.source.connection, config.source.folder
                    ),
                    error_type: LocalErrorType::InvalidField,
                });
            }
        }
        if let Some(schema) = &dest_schema {
            if !local_schema_has_path(schema, &rm.dest_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Matching("matching".into())),
                    error_msg: format!(
                        "recordMatching.destField '{}' not found in destination schema ({}/{})",
                        rm.dest_field, config.destination.connection, config.destination.folder
                    ),
                    error_type: LocalErrorType::InvalidField,
                });
            }
        }
    }

    errors
}

/// Schema path in V2: workspace/{connection}/.scratch/{folder}/schema.json
/// (matches how scratch-git-2 stores schemas in the git repo: .scratch/{folder}/schema.json)
/// The file wraps the JSON Schema under a "schema" key — we extract that inner object.
fn load_local_schema(workspace: &Path, connection: &str, folder: &str) -> Option<serde_json::Value> {
    let path = workspace
        .join(connection)
        .join(".scratch")
        .join(folder)
        .join("schema.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let outer: serde_json::Value = serde_json::from_str(&raw).ok()?;
    // The actual JSON Schema is nested under the "schema" key
    outer.get("schema").cloned()
}

/// Check whether a dot-notation path exists in a JSON Schema by traversing `properties`.
/// e.g. "fields.Name" → schema.properties.fields.properties.Name
fn local_schema_has_path(schema: &serde_json::Value, path: &str) -> bool {
    let mut current = schema;
    for key in path.split('.') {
        current = match current.get("properties").and_then(|p| p.get(key)) {
            Some(v) => v,
            None => return false,
        };
    }
    true
}

fn collect_local_sync_files(syncs_dir: &Path, filter: Option<&str>) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(syncs_dir)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(name) = filter {
            // Support both with and without .json extension
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            let full = path.file_name().unwrap_or_default().to_string_lossy();
            if stem != name && full != name {
                continue;
            }
        }
        files.push(path);
    }
    files.sort();
    Ok(files)
}

// ---------------------------------------------------------------------------
// run-local
// ---------------------------------------------------------------------------

fn run_local(sync_path: Option<&str>, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let cwd = std::env::current_dir()?;
    let wb_dir = markers::find_nearest_workspace(&cwd)
        .ok_or_else(|| anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory."))?;

    let syncs_dir = wb_dir.join(".scratch/workbook/syncs");
    if !syncs_dir.exists() {
        anyhow::bail!(
            "syncs directory not found at {}. Run `scratchmd2 files download` first.",
            syncs_dir.display()
        );
    }

    let sync_files = collect_local_sync_files(&syncs_dir, sync_path)?;
    if sync_files.is_empty() {
        println!("No sync configs found in {}", syncs_dir.display());
        return Ok(());
    }

    let mut all_results: Vec<serde_json::Value> = Vec::new();

    for sync_file in &sync_files {
        let name = sync_file.file_stem().unwrap_or_default().to_string_lossy().to_string();
        if !json { println!("Running sync: {}", name); }

        let cfg: LocalSyncConfig = match std::fs::read_to_string(sync_file)
            .map_err(anyhow::Error::from)
            .and_then(|s| serde_json::from_str(&s).map_err(anyhow::Error::from))
        {
            Ok(c) => c,
            Err(e) => {
                if json {
                    all_results.push(serde_json::json!({ "sync": name, "error": e.to_string() }));
                } else {
                    println!("  Error loading config: {}", e);
                }
                continue;
            }
        };

        match apply_sync(&wb_dir, &cfg, json) {
            Ok(result) => {
                if json {
                    all_results.push(serde_json::json!({ "sync": name, "updated": result.updated, "created": result.created }));
                } else {
                    println!("  {} updated, {} created (pending)", result.updated, result.created);
                }
            }
            Err(e) => {
                if json {
                    all_results.push(serde_json::json!({ "sync": name, "error": e.to_string() }));
                } else {
                    println!("  Error: {}", e);
                }
            }
        }
    }

    let elapsed_ms = started.elapsed().as_millis();
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "results": all_results,
            "elapsedMs": elapsed_ms,
        }))?);
    } else {
        let elapsed = if elapsed_ms < 1000 {
            format!("{}ms", elapsed_ms)
        } else {
            format!("{:.1}s", elapsed_ms as f64 / 1000.0)
        };
        println!("Done ({})", elapsed);
    }
    Ok(())
}

struct SyncResult {
    updated: usize,
    created: usize,
}

fn apply_sync(wb_dir: &Path, cfg: &LocalSyncConfig, json: bool) -> anyhow::Result<SyncResult> {
    let src_dir = wb_dir.join(&cfg.source.connection).join(&cfg.source.folder);
    let dst_dir = wb_dir.join(&cfg.destination.connection).join(&cfg.destination.folder);

    if !src_dir.exists() {
        anyhow::bail!("source folder not found: {}", src_dir.display());
    }
    if !dst_dir.exists() {
        anyhow::bail!("destination folder not found: {}", dst_dir.display());
    }

    // Pass 1: index destination records as match_key -> path only (no full parse in memory)
    use rayon::prelude::*;
    let pass1_start = std::time::Instant::now();
    let dst_index: HashMap<String, PathBuf> = if let Some(rm) = &cfg.record_matching {
        let dst_entries: Vec<_> = std::fs::read_dir(&dst_dir)?
            .flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
            .collect();
        dst_entries.par_iter()
            .filter_map(|entry| {
                let path = entry.path();
                let data = std::fs::read_to_string(&path).ok()?;
                let val = serde_json::from_str::<serde_json::Value>(&data).ok()?;
                let key = get_dot(&val, &rm.dest_field)?;
                Some((json_to_string(&key), path))
            })
            .collect()
    } else {
        HashMap::new()
    };
    if !json {
        let ms = pass1_start.elapsed().as_millis();
        let elapsed = if ms < 1000 { format!("{}ms", ms) } else { format!("{:.1}s", ms as f64 / 1000.0) };
        println!("  {} destination records indexed ({})", dst_index.len(), elapsed);
    }

    // Collect source files upfront to know total count for progress reporting
    let src_files: Vec<_> = std::fs::read_dir(&src_dir)?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    let total = src_files.len();
    let show_progress = !json && total >= 1000;

    // Pass 2: parallel — each source file operates on a different destination file, no shared writes
    let updated = AtomicUsize::new(0);
    let created = AtomicUsize::new(0);
    let processed = AtomicUsize::new(0);

    let result: anyhow::Result<()> = src_files.par_iter().try_for_each(|entry| {
        let path = entry.path();
        let data = std::fs::read_to_string(&path)?;
        let src_val: serde_json::Value = serde_json::from_str(&data)?;

        let match_key = cfg.record_matching.as_ref()
            .and_then(|rm| get_dot(&src_val, &rm.source_field))
            .map(|v| json_to_string(&v));

        if let Some(dst_path) = match_key.as_ref().and_then(|k| dst_index.get(k)) {
            // Re-read destination file, apply field mappings, write back
            let dst_data = std::fs::read_to_string(dst_path)?;
            let mut dst_val: serde_json::Value = serde_json::from_str(&dst_data)?;
            for fm in &cfg.field_mappings {
                if let Some(src_v) = get_dot(&src_val, &fm.source_field) {
                    set_dot(&mut dst_val, &fm.dest_field, src_v);
                }
            }
            std::fs::write(dst_path, format!("{}\n", serde_json::to_string_pretty(&dst_val)?))?;
            updated.fetch_add(1, Ordering::Relaxed);
        } else {
            // No match — create pending record
            let mut pending: serde_json::Value = serde_json::json!({});
            for fm in &cfg.field_mappings {
                if let Some(src_v) = get_dot(&src_val, &fm.source_field) {
                    set_dot(&mut pending, &fm.dest_field, src_v);
                }
            }
            let hash = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                path.hash(&mut h);
                format!("{:x}", h.finish())
            };
            let pending_path = dst_dir.join(format!("scratch_pending_{}.json", &hash[..8]));
            std::fs::write(&pending_path, format!("{}\n", serde_json::to_string_pretty(&pending)?))?;
            created.fetch_add(1, Ordering::Relaxed);
        }

        if show_progress {
            let prev = processed.fetch_add(1, Ordering::Relaxed);
            if (prev + 1) % 1000 == 0 {
                println!("  {} / {} processed...", prev + 1, total);
            }
        }

        Ok(())
    });
    result?;

    Ok(SyncResult {
        updated: updated.into_inner(),
        created: created.into_inner(),
    })
}

/// Get a value from a JSON object using dot-notation path (e.g. "fields.Name").
fn get_dot(val: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    let mut cur = val;
    for part in path.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur.clone())
}

/// Set a value in a JSON object using dot-notation path, creating intermediate objects as needed.
fn set_dot(val: &mut serde_json::Value, path: &str, new_val: serde_json::Value) {
    let parts: Vec<&str> = path.splitn(2, '.').collect();
    if parts.len() == 1 {
        if let Some(obj) = val.as_object_mut() {
            obj.insert(parts[0].to_string(), new_val);
        }
    } else {
        if let Some(obj) = val.as_object_mut() {
            let child = obj.entry(parts[0]).or_insert_with(|| serde_json::json!({}));
            set_dot(child, parts[1], new_val);
        }
    }
}

fn json_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
