//! `scratchmdv4 validate-sync` — validate sync config files against workspace schemas.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Result};
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: auto-detected)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,

    /// Validate only the named sync file (without .json extension). Validates all syncs if omitted.
    #[arg(long)]
    pub sync: Option<String>,
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncValidationError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table_mapping_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_mapping_index: Option<FieldMappingRef>,
    pub error_msg: String,
    #[serde(rename = "type")]
    pub error_type: ErrorType,
}

#[derive(Serialize, Debug)]
#[serde(untagged)]
pub enum FieldMappingRef {
    Index(usize),
    Matching(String),
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ErrorType {
    InvalidJson,
    InvalidStructure,
    InvalidField,
    CompileTimeType, // placeholder — always passes for now
    RunTimeError,    // placeholder — always passes for now
}

#[derive(Serialize, Debug)]
pub struct ValidationResult {
    pub sync: String,
    pub errors: Vec<SyncValidationError>,
}

// ---------------------------------------------------------------------------
// Sync config types (mirrors run_sync.rs)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SyncConfig {
    #[allow(dead_code)]
    version: u32,
    source: SyncEndpoint,
    destination: SyncEndpoint,
    field_mappings: Vec<FieldMapping>,
    record_matching: Option<RecordMatching>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SyncEndpoint {
    connection: String,
    folder: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct FieldMapping {
    source_field: String,
    dest_field: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct RecordMatching {
    source_field: String,
    dest_field: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;

    let syncs_dir = workspace.join(".scratch/workbook/syncs");
    if !syncs_dir.exists() {
        return Err(Error::Other(format!(
            "syncs directory not found at {}. Run `scratchmdv4 pull` first.",
            syncs_dir.display()
        )));
    }

    let sync_files = collect_sync_files(&syncs_dir, args.sync.as_deref())?;
    if sync_files.is_empty() {
        println!("No sync configs found in {}", syncs_dir.display());
        return Ok(());
    }

    let mut all_results: Vec<ValidationResult> = Vec::new();
    let mut any_errors = false;

    for sync_path in &sync_files {
        let name = sync_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let errors = validate_sync_file(sync_path, &workspace);
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
                error_type: ErrorType::InvalidJson,
            });
            return errors;
        }
    };

    let json_value: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            errors.push(SyncValidationError {
                table_mapping_index: None,
                field_mapping_index: None,
                error_msg: format!("invalid JSON: {e}"),
                error_type: ErrorType::InvalidJson,
            });
            return errors;
        }
    };

    // Check 2: valid structure
    let config: SyncConfig = match serde_json::from_value(json_value) {
        Ok(c) => c,
        Err(e) => {
            errors.push(SyncValidationError {
                table_mapping_index: None,
                field_mapping_index: None,
                error_msg: format!("invalid sync structure: {e}"),
                error_type: ErrorType::InvalidStructure,
            });
            return errors;
        }
    };

    // Check 3: tables and fields exist
    errors.extend(validate_fields(&config, workspace));

    // Check 4: compile-time type tracing — placeholder, always passes
    // Check 5: runtime check — placeholder, always passes

    errors
}

fn validate_fields(config: &SyncConfig, workspace: &Path) -> Vec<SyncValidationError> {
    let mut errors = Vec::new();

    // Load source schema
    let source_schema = load_schema(workspace, &config.source.connection, &config.source.folder);
    let dest_schema = load_schema(workspace, &config.destination.connection, &config.destination.folder);

    // Check source table/folder exists
    let source_dir = workspace.join(&config.source.connection).join(&config.source.folder);
    if !source_dir.exists() {
        errors.push(SyncValidationError {
            table_mapping_index: Some(0),
            field_mapping_index: None,
            error_msg: format!(
                "source folder not found: {}/{}", config.source.connection, config.source.folder
            ),
            error_type: ErrorType::InvalidField,
        });
    }

    // Check dest table/folder exists
    let dest_dir = workspace.join(&config.destination.connection).join(&config.destination.folder);
    if !dest_dir.exists() {
        errors.push(SyncValidationError {
            table_mapping_index: Some(1),
            field_mapping_index: None,
            error_msg: format!(
                "destination folder not found: {}/{}", config.destination.connection, config.destination.folder
            ),
            error_type: ErrorType::InvalidField,
        });
    }

    // Validate each field mapping
    for (i, mapping) in config.field_mappings.iter().enumerate() {
        if let Some(schema) = &source_schema {
            if !schema_has_path(schema, &mapping.source_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Index(i)),
                    error_msg: format!(
                        "sourceField '{}' not found in source schema ({}/{})",
                        mapping.source_field, config.source.connection, config.source.folder
                    ),
                    error_type: ErrorType::InvalidField,
                });
            }
        }
        if let Some(schema) = &dest_schema {
            if !schema_has_path(schema, &mapping.dest_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Index(i)),
                    error_msg: format!(
                        "destField '{}' not found in destination schema ({}/{})",
                        mapping.dest_field, config.destination.connection, config.destination.folder
                    ),
                    error_type: ErrorType::InvalidField,
                });
            }
        }
    }

    // Validate recordMatching fields
    if let Some(rm) = &config.record_matching {
        if let Some(schema) = &source_schema {
            if !schema_has_path(schema, &rm.source_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Matching("matching".into())),
                    error_msg: format!(
                        "recordMatching.sourceField '{}' not found in source schema ({}/{})",
                        rm.source_field, config.source.connection, config.source.folder
                    ),
                    error_type: ErrorType::InvalidField,
                });
            }
        }
        if let Some(schema) = &dest_schema {
            if !schema_has_path(schema, &rm.dest_field) {
                errors.push(SyncValidationError {
                    table_mapping_index: None,
                    field_mapping_index: Some(FieldMappingRef::Matching("matching".into())),
                    error_msg: format!(
                        "recordMatching.destField '{}' not found in destination schema ({}/{})",
                        rm.dest_field, config.destination.connection, config.destination.folder
                    ),
                    error_type: ErrorType::InvalidField,
                });
            }
        }
    }

    errors
}

/// Load schema.json for a connection/folder from the dirty worktree.
/// Schema path: workspace/{connection}/.scratch/{folder}/schema.json
fn load_schema(workspace: &Path, connection: &str, folder: &str) -> Option<Value> {
    let path = workspace
        .join(connection)
        .join(".scratch")
        .join(folder)
        .join("schema.json");

    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Check whether a dot-notation path exists in a JSON Schema by traversing `properties`.
/// e.g. "fields.Name" → schema.properties.fields.properties.Name
fn schema_has_path(schema: &Value, path: &str) -> bool {
    let mut current = schema;
    for key in path.split('.') {
        current = match current.get("properties").and_then(|p| p.get(key)) {
            Some(v) => v,
            None => return false,
        };
    }
    true
}

fn collect_sync_files(syncs_dir: &Path, filter: Option<&str>) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(syncs_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(name) = filter {
            if path.file_stem().unwrap_or_default().to_string_lossy() != name {
                continue;
            }
        }
        files.push(path);
    }
    files.sort();
    Ok(files)
}
