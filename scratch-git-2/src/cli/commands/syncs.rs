use std::collections::HashMap;
use std::io::{self, BufRead, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use clap::Subcommand;
use serde::Deserialize;

use crate::api::{self, ApiClient, Sync};
use crate::config;
use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;

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
        /// Output directory (default: .scratch/workspace/syncs/ inside the workspace directory)
        #[arg(long, short = 'o')]
        output: Option<String>,
    },
    /// Validate local sync configs (checks connections/folders exist)
    #[command(name = "validate-local")]
    ValidateLocal {
        /// Path to a specific sync config file (default: all in .scratch/workspace/syncs/)
        #[arg(long)]
        sync: Option<String>,
    },
    /// Run a sync locally against files on disk
    #[command(name = "run-local")]
    RunLocal {
        /// Path to a specific sync config file (default: all in .scratch/workspace/syncs/)
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
        println!("Create one with: scratchmd syncs create --config sync-config.json");
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
        // Default: .scratch/workspace/syncs/ inside the workspace directory
        match config::find_workspace_dir(workbook_id) {
            Some(wb_dir) => workbook_syncs_dir(&wb_dir),
            None => anyhow::bail!(
                "Workspace {} is not initialized locally. Run 'scratchmd workspaces init {}' first, \
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
        println!("  scratchmd syncs update <sync-id> --config <file>");
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
// Local sync config types — matches NestJS sync mapping format 1:1.
// Exception: sourceDataFolderId / destinationDataFolderId are workspace-relative
// folder paths (e.g. "AIRTABLE - Airtable/MyBase/Posts") instead of dfd_ IDs.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSyncConfig {
    #[allow(dead_code)]
    version: u32,
    table_mappings: Vec<TableMapping>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableMapping {
    /// Workspace-relative path, e.g. "AIRTABLE - Airtable/MyBase/Posts"
    source_data_folder_id: String,
    /// Workspace-relative path, e.g. "WEBFLOW - Webflow/MySite/Posts"
    destination_data_folder_id: String,
    column_mappings: Vec<ColumnMapping>,
    record_matching: Option<RecordMatching>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColumnMapping {
    source_column_id: String,
    destination_column_id: String,
    /// Single transformer (convenience form).
    #[serde(default)]
    transformer: Option<TransformerConfig>,
    /// Pipeline of transformers applied in order. Takes precedence over `transformer`.
    #[serde(default)]
    transformers: Option<Vec<TransformerConfig>>,
}

/// Matches NestJS TransformerConfig: `{ "type": "...", "options": { ... } }`
#[derive(Debug, Deserialize)]
struct TransformerConfig {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    options: serde_json::Value,
}

/// Options for `string_to_number` — deserialized from `transformer.options`.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StringToNumberOptions {
    #[serde(default)]
    strip_currency: bool,
    #[serde(default)]
    parse_integer: bool,
}

/// Options for `auto_convert` — deserialized from `transformer.options`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoConvertOptions {
    #[serde(default = "default_string_type")]
    target_type: String,
}

fn default_string_type() -> String {
    "string".to_string()
}

impl Default for AutoConvertOptions {
    fn default() -> Self {
        Self { target_type: "string".to_string() }
    }
}

/// Options for `rhai` — deserialized from `transformer.options`.
#[derive(Debug, Deserialize)]
struct RhaiOptions {
    /// Script filename relative to `wb_dir/transformers/`.
    script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordMatching {
    source_column_id: String,
    destination_column_id: String,
}

// ---------------------------------------------------------------------------
// validate-local
// ---------------------------------------------------------------------------

fn validate_local(sync_path: Option<&str>, _json: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let wb_dir = markers::find_nearest_workspace(&cwd)
        .ok_or_else(|| anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory."))?;

    let syncs_dir = workbook_syncs_dir(&wb_dir);
    if !syncs_dir.exists() {
        anyhow::bail!(
            "syncs directory not found at {}. Run `scratchmd files download` first.",
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

    for (ti, tm) in config.table_mappings.iter().enumerate() {
        let (src_conn, src_folder) = split_connection_folder(&tm.source_data_folder_id);
        let (dst_conn, dst_folder) = split_connection_folder(&tm.destination_data_folder_id);

        let source_schema = load_local_schema(workspace, src_conn, src_folder);
        let dest_schema = load_local_schema(workspace, dst_conn, dst_folder);

        // Check source folder exists
        if !workspace.join(&tm.source_data_folder_id).exists() {
            errors.push(SyncValidationError {
                table_mapping_index: Some(ti),
                field_mapping_index: None,
                error_msg: format!("source folder not found: {}", tm.source_data_folder_id),
                error_type: LocalErrorType::InvalidField,
            });
        }

        // Check destination folder exists
        if !workspace.join(&tm.destination_data_folder_id).exists() {
            errors.push(SyncValidationError {
                table_mapping_index: Some(ti),
                field_mapping_index: None,
                error_msg: format!("destination folder not found: {}", tm.destination_data_folder_id),
                error_type: LocalErrorType::InvalidField,
            });
        }

        // Validate each column mapping against schemas
        for (i, cm) in tm.column_mappings.iter().enumerate() {
            if let Some(schema) = &source_schema {
                if !local_schema_has_path(schema, &cm.source_column_id) {
                    errors.push(SyncValidationError {
                        table_mapping_index: Some(ti),
                        field_mapping_index: Some(FieldMappingRef::Index(i)),
                        error_msg: format!(
                            "sourceColumnId '{}' not found in source schema ({})",
                            cm.source_column_id, tm.source_data_folder_id
                        ),
                        error_type: LocalErrorType::InvalidField,
                    });
                }
            }
            if let Some(schema) = &dest_schema {
                if !local_schema_has_path(schema, &cm.destination_column_id) {
                    errors.push(SyncValidationError {
                        table_mapping_index: Some(ti),
                        field_mapping_index: Some(FieldMappingRef::Index(i)),
                        error_msg: format!(
                            "destinationColumnId '{}' not found in destination schema ({})",
                            cm.destination_column_id, tm.destination_data_folder_id
                        ),
                        error_type: LocalErrorType::InvalidField,
                    });
                }
            }
        }

        // Validate recordMatching fields
        if let Some(rm) = &tm.record_matching {
            if let Some(schema) = &source_schema {
                if !local_schema_has_path(schema, &rm.source_column_id) {
                    errors.push(SyncValidationError {
                        table_mapping_index: Some(ti),
                        field_mapping_index: Some(FieldMappingRef::Matching("matching".into())),
                        error_msg: format!(
                            "recordMatching.sourceColumnId '{}' not found in source schema ({})",
                            rm.source_column_id, tm.source_data_folder_id
                        ),
                        error_type: LocalErrorType::InvalidField,
                    });
                }
            }
            if let Some(schema) = &dest_schema {
                if !local_schema_has_path(schema, &rm.destination_column_id) {
                    errors.push(SyncValidationError {
                        table_mapping_index: Some(ti),
                        field_mapping_index: Some(FieldMappingRef::Matching("matching".into())),
                        error_msg: format!(
                            "recordMatching.destinationColumnId '{}' not found in destination schema ({})",
                            rm.destination_column_id, tm.destination_data_folder_id
                        ),
                        error_type: LocalErrorType::InvalidField,
                    });
                }
            }
        }
    }

    errors
}

/// Splits "Connection Name/Base/Folder" into ("Connection Name", "Base/Folder").
fn split_connection_folder(folder_id: &str) -> (&str, &str) {
    match folder_id.find('/') {
        Some(i) => (&folder_id[..i], &folder_id[i + 1..]),
        None => (folder_id, ""),
    }
}

fn load_local_schema(workspace: &Path, connection: &str, folder: &str) -> Option<serde_json::Value> {
    let path = WorkspaceLayout::for_cli(workspace)
        .connection_scratch_path(connection)
        .join(folder)
        .join("schema.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let outer: serde_json::Value = serde_json::from_str(&raw).ok()?;
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

    let syncs_dir = workbook_syncs_dir(&wb_dir);
    if !syncs_dir.exists() {
        anyhow::bail!(
            "syncs directory not found at {}. Run `scratchmd files download` first.",
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
        let elapsed = format!("{:.3}s", elapsed_ms as f64 / 1000.0);
        println!("Done ({})", elapsed);
    }
    Ok(())
}

struct SyncResult {
    updated: usize,
    created: usize,
}

// ---------------------------------------------------------------------------
// Rhai context — compiled scripts shared across the parallel record loop
// ---------------------------------------------------------------------------

struct RhaiContext {
    engine: rhai::Engine,
    scripts: HashMap<String, rhai::AST>,
}

/// Builds a sandboxed Rhai engine and pre-compiles every unique script referenced
/// in `cfg`. Fails fast if any script is missing or has a syntax error.
fn build_rhai_context(wb_dir: &Path, cfg: &LocalSyncConfig) -> anyhow::Result<RhaiContext> {
    let mut engine = rhai::Engine::new();
    engine.set_max_modules(0);
    engine.on_print(|_| {});
    engine.on_debug(|_, _, _| {});

    let transformers_dir = workbook_transformers_dir(wb_dir);
    let mut scripts: HashMap<String, rhai::AST> = HashMap::new();

    for tm in &cfg.table_mappings {
        for cm in &tm.column_mappings {
            for tc in get_transformer_configs(cm) {
                if tc.kind == "rhai" {
                    let opts: RhaiOptions = serde_json::from_value(tc.options.clone())
                        .map_err(|e| anyhow::anyhow!("rhai transformer missing 'script' option: {e}"))?;
                    if scripts.contains_key(&opts.script) {
                        continue;
                    }
                    let script_path = transformers_dir.join(&opts.script);
                    let ast = engine.compile_file(script_path.clone()).map_err(|e| {
                        anyhow::anyhow!("Rhai compile error in {}: {e}", script_path.display())
                    })?;
                    scripts.insert(opts.script, ast);
                }
            }
        }
    }

    Ok(RhaiContext { engine, scripts })
}

fn workbook_syncs_dir(workspace_dir: &Path) -> PathBuf {
    WorkspaceLayout::for_cli(workspace_dir)
        .workbook_materialization_path()
        .join("syncs")
}

fn workbook_transformers_dir(workspace_dir: &Path) -> PathBuf {
    WorkspaceLayout::for_cli(workspace_dir)
        .workbook_materialization_path()
        .join("transformers")
}

fn apply_sync(wb_dir: &Path, cfg: &LocalSyncConfig, json: bool) -> anyhow::Result<SyncResult> {
    use rayon::prelude::*;

    let rhai_ctx = build_rhai_context(wb_dir, cfg)?;

    let mut total_updated = 0usize;
    let mut total_created = 0usize;

    for tm in &cfg.table_mappings {
        let src_dir = wb_dir.join(&tm.source_data_folder_id);
        let dst_dir = wb_dir.join(&tm.destination_data_folder_id);

        if !src_dir.exists() {
            anyhow::bail!("source folder not found: {}", tm.source_data_folder_id);
        }
        if !dst_dir.exists() {
            anyhow::bail!("destination folder not found: {}", tm.destination_data_folder_id);
        }

        // Pass 1: index destination records as match_key -> path only (no full parse in memory)
        let pass1_start = std::time::Instant::now();
        let dst_index: HashMap<String, PathBuf> = if let Some(rm) = &tm.record_matching {
            let dst_entries: Vec<_> = std::fs::read_dir(&dst_dir)?
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
                .collect();
            dst_entries
                .par_iter()
                .filter_map(|entry| {
                    let path = entry.path();
                    let data = std::fs::read_to_string(&path).ok()?;
                    let val = serde_json::from_str::<serde_json::Value>(&data).ok()?;
                    let key = get_dot(&val, &rm.destination_column_id)?;
                    Some((json_to_string(&key), path))
                })
                .collect()
        } else {
            HashMap::new()
        };
        if !json {
            let ms = pass1_start.elapsed().as_millis();
            let elapsed = format!("{:.3}s", ms as f64 / 1000.0);
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

            let match_key = tm
                .record_matching
                .as_ref()
                .and_then(|rm| get_dot(&src_val, &rm.source_column_id))
                .map(|v| json_to_string(&v));

            if let Some(dst_path) = match_key.as_ref().and_then(|k| dst_index.get(k)) {
                // Re-read destination file, apply column mappings, write back
                let dst_data = std::fs::read_to_string(dst_path)?;
                let mut dst_val: serde_json::Value = serde_json::from_str(&dst_data)?;
                for cm in &tm.column_mappings {
                    if let Some(src_v) = get_dot(&src_val, &cm.source_column_id) {
                        let transformed =
                            apply_transformer_pipeline(src_v, &get_transformer_configs(cm), &rhai_ctx);
                        set_dot(&mut dst_val, &cm.destination_column_id, transformed);
                    }
                }
                std::fs::write(dst_path, format!("{}\n", serde_json::to_string_pretty(&dst_val)?))?;
                updated.fetch_add(1, Ordering::Relaxed);
            } else {
                // No match — create pending record
                let mut pending: serde_json::Value = serde_json::json!({});
                for cm in &tm.column_mappings {
                    if let Some(src_v) = get_dot(&src_val, &cm.source_column_id) {
                        let transformed =
                            apply_transformer_pipeline(src_v, &get_transformer_configs(cm), &rhai_ctx);
                        set_dot(&mut pending, &cm.destination_column_id, transformed);
                    }
                }
                let hash = {
                    use std::hash::{Hash, Hasher};
                    let mut h = std::collections::hash_map::DefaultHasher::new();
                    path.hash(&mut h);
                    format!("{:x}", h.finish())
                };
                let pending_path =
                    dst_dir.join(format!("scratch_pending_{}.json", &hash[..8]));
                std::fs::write(
                    &pending_path,
                    format!("{}\n", serde_json::to_string_pretty(&pending)?),
                )?;
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

        total_updated += updated.into_inner();
        total_created += created.into_inner();
    }

    Ok(SyncResult { updated: total_updated, created: total_created })
}

/// Normalizes a ColumnMapping's transformer config(s) into a slice, mirroring
/// NestJS `getTransformerConfigs`: `transformers` array takes precedence over
/// the singular `transformer`; returns empty if neither is set.
fn get_transformer_configs(mapping: &ColumnMapping) -> Vec<&TransformerConfig> {
    if let Some(list) = &mapping.transformers {
        list.iter().collect()
    } else if let Some(t) = &mapping.transformer {
        vec![t]
    } else {
        vec![]
    }
}

/// Applies a pipeline of transformers in order, feeding each output as the next input.
/// Options are deserialized from `config.options` matching the NestJS format.
fn apply_transformer_pipeline(
    value: serde_json::Value,
    transformers: &[&TransformerConfig],
    rhai_ctx: &RhaiContext,
) -> serde_json::Value {
    let mut current = value;
    for t in transformers {
        current = match t.kind.as_str() {
            "string_to_number" => {
                let opts: StringToNumberOptions =
                    serde_json::from_value(t.options.clone()).unwrap_or_default();
                apply_string_to_number(current, &opts)
            }
            "auto_convert" => {
                let opts: AutoConvertOptions =
                    serde_json::from_value(t.options.clone()).unwrap_or_default();
                apply_auto_convert(current, &opts)
            }
            "rhai" => {
                let script_name = t.options.get("script").and_then(|v| v.as_str()).unwrap_or("");
                match rhai_ctx.scripts.get(script_name) {
                    Some(ast) => apply_rhai(&rhai_ctx.engine, ast, current.clone()).unwrap_or(current),
                    None => current,
                }
            }
            _ => current, // unknown transformer type, pass through
        };
    }
    current
}

fn apply_string_to_number(value: serde_json::Value, opts: &StringToNumberOptions) -> serde_json::Value {
    use serde_json::Value;
    match &value {
        Value::Number(n) => {
            if opts.parse_integer {
                return Value::Number(serde_json::Number::from(n.as_f64().unwrap_or(0.0).trunc() as i64));
            }
            value
        }
        Value::String(s) => {
            let mut cleaned = s.trim().to_string();
            if opts.strip_currency {
                cleaned = cleaned
                    .replace(['$', '€', '£', '¥', '₹', '₽', '₩', '₴', '₪', '฿', '₫', '₦'], "")
                    .replace(',', "");
                cleaned = cleaned.trim().to_string();
            }
            if cleaned.is_empty() {
                return Value::Null;
            }
            if opts.parse_integer {
                if let Ok(n) = cleaned.parse::<i64>() {
                    return Value::Number(n.into());
                }
                // Try float then truncate
                if let Ok(f) = cleaned.parse::<f64>() {
                    return Value::Number(serde_json::Number::from(f.trunc() as i64));
                }
            } else if let Ok(f) = cleaned.parse::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(f) {
                    return Value::Number(n);
                }
            }
            value // parse failed, pass through
        }
        Value::Null => Value::Null,
        _ => value, // unsupported type, pass through
    }
}

fn apply_auto_convert(value: serde_json::Value, opts: &AutoConvertOptions) -> serde_json::Value {
    use serde_json::Value;
    if value.is_null() {
        return Value::Null;
    }
    match opts.target_type.as_str() {
        "string" => match &value {
            Value::String(_) => value,
            Value::Number(n) => Value::String(n.to_string()),
            Value::Bool(b) => Value::String(b.to_string()),
            Value::Array(arr) if arr.len() == 1 => {
                apply_auto_convert(arr[0].clone(), opts)
            }
            Value::Array(arr) => Value::String(
                arr.iter()
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
            ),
            _ => value,
        },
        "number" | "integer" => {
            let as_f64 = match &value {
                Value::Number(n) => n.as_f64(),
                Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
                Value::String(s) => s.trim().parse::<f64>().ok(),
                Value::Array(arr) if arr.len() == 1 => {
                    return apply_auto_convert(arr[0].clone(), opts);
                }
                _ => None,
            };
            match as_f64 {
                Some(f) => {
                    let n = if opts.target_type == "integer" { f.trunc() } else { f };
                    serde_json::Number::from_f64(n).map(Value::Number).unwrap_or(value)
                }
                None => value,
            }
        }
        "boolean" => match &value {
            Value::Bool(_) => value,
            Value::Number(n) => Value::Bool(n.as_f64().unwrap_or(0.0) != 0.0),
            Value::String(s) => match s.trim().to_lowercase().as_str() {
                "true" | "yes" | "1" => Value::Bool(true),
                "false" | "no" | "0" => Value::Bool(false),
                _ => value,
            },
            _ => value,
        },
        "array" => match value {
            Value::Array(_) => value,
            _ => Value::Array(vec![value]),
        },
        _ => value,
    }
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

// ---------------------------------------------------------------------------
// Rhai evaluation
// ---------------------------------------------------------------------------

fn apply_rhai(engine: &rhai::Engine, ast: &rhai::AST, value: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let mut scope = rhai::Scope::new();
    scope.push("value", json_to_dynamic(value));
    let result: rhai::Dynamic = engine.eval_ast_with_scope(&mut scope, ast)?;
    Ok(dynamic_to_json(result))
}

fn json_to_dynamic(value: serde_json::Value) -> rhai::Dynamic {
    use rhai::Dynamic;
    match value {
        serde_json::Value::Null => Dynamic::UNIT,
        serde_json::Value::Bool(b) => Dynamic::from(b),
        serde_json::Value::Number(n) => Dynamic::from(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => Dynamic::from(s),
        serde_json::Value::Array(arr) => {
            let v: rhai::Array = arr.into_iter().map(json_to_dynamic).collect();
            Dynamic::from(v)
        }
        serde_json::Value::Object(map) => {
            let m: rhai::Map = map.into_iter().map(|(k, v)| (k.into(), json_to_dynamic(v))).collect();
            Dynamic::from(m)
        }
    }
}

fn dynamic_to_json(value: rhai::Dynamic) -> serde_json::Value {
    if value.is_unit() {
        return serde_json::Value::Null;
    }
    if let Some(b) = value.clone().try_cast::<bool>() {
        return serde_json::Value::Bool(b);
    }
    if let Some(i) = value.clone().try_cast::<i64>() {
        return serde_json::Value::Number(i.into());
    }
    if let Some(f) = value.clone().try_cast::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(f) {
            return serde_json::Value::Number(n);
        }
    }
    if let Some(s) = value.clone().try_cast::<String>() {
        return serde_json::Value::String(s);
    }
    if let Some(arr) = value.clone().try_cast::<rhai::Array>() {
        return serde_json::Value::Array(arr.into_iter().map(dynamic_to_json).collect());
    }
    if let Some(map) = value.try_cast::<rhai::Map>() {
        return serde_json::Value::Object(
            map.into_iter().map(|(k, v)| (k.to_string(), dynamic_to_json(v))).collect(),
        );
    }
    serde_json::Value::Null
}
