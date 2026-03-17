//! `scratchmd run-sync` — apply sync configs to local materialized worktrees.
//!
//! Reads sync JSON from `.scratch/workbook/syncs/*.json`, reads source records
//! from the master worktree of the source connection, applies field mappings,
//! and writes transformed records to the dirty worktree of the destination connection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Result};
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: current directory)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,

    /// Run only the named sync file (without .json extension). Runs all syncs if omitted.
    #[arg(long)]
    pub sync: Option<String>,
}

// ---------------------------------------------------------------------------
// Sync config types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SyncConfig {
    #[allow(dead_code)]
    version: u32,
    display_name: String,
    source: SyncEndpoint,
    destination: SyncEndpoint,
    field_mappings: Vec<FieldMapping>,
    record_matching: Option<RecordMatching>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SyncEndpoint {
    /// Directory name of the connection under .scratch/connections/ (master) or workspace root (dirty).
    connection: String,
    /// Relative folder path within the connection, e.g. "MyBase/Posts"
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
// Destination file format (Webflow native)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct DestRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    field_data: HashMap<String, Value>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;

    let syncs_dir = workspace.join(".scratch/workbook/syncs");
    if !syncs_dir.exists() {
        return Err(Error::Other(format!(
            "syncs directory not found at {}. Run `scratchmd pull` first.",
            syncs_dir.display()
        )));
    }

    // Collect sync files to run
    let sync_files = collect_sync_files(&syncs_dir, args.sync.as_deref())?;
    if sync_files.is_empty() {
        println!("No sync configs found in {}", syncs_dir.display());
        return Ok(());
    }

    println!("Running {} sync(s)...", sync_files.len());

    for sync_path in &sync_files {
        let name = sync_path.file_stem().unwrap_or_default().to_string_lossy();
        let raw = std::fs::read_to_string(sync_path)?;
        let config: SyncConfig = serde_json::from_str(&raw).map_err(|e| {
            Error::Other(format!("failed to parse sync {}: {e}", sync_path.display()))
        })?;
        println!("\n  sync: {} ({})", name, config.display_name);
        run_sync(&workspace, &config)?;
    }

    println!("\nDone.");
    Ok(())
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
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            if stem != name {
                continue;
            }
        }
        files.push(path);
    }
    files.sort();
    Ok(files)
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

fn run_sync(workspace: &Path, config: &SyncConfig) -> Result<()> {
    // Source: dirty worktree of source connection (top-level connection directory)
    let source_dir = workspace
        .join(&config.source.connection)
        .join(&config.source.folder);

    // Destination: dirty worktree of dest connection
    let dest_dir = workspace
        .join(&config.destination.connection)
        .join(&config.destination.folder);

    if !source_dir.exists() {
        return Err(Error::Other(format!(
            "source directory not found: {}. Check connection name '{}' and folder '{}'.",
            source_dir.display(),
            config.source.connection,
            config.source.folder,
        )));
    }

    // Read all source files
    let source_files = read_json_files(&source_dir)?;
    println!(
        "    source: {} ({} files)",
        source_dir.display(),
        source_files.len()
    );

    // Read existing dest files (for record matching)
    let existing_dest = if dest_dir.exists() {
        read_json_files(&dest_dir)?
    } else {
        std::fs::create_dir_all(&dest_dir)?;
        Vec::new()
    };

    println!(
        "    dest:   {} ({} existing files)",
        dest_dir.display(),
        existing_dest.len()
    );

    // Build lookup: dest match field value -> (filename, DestRecord)
    let dest_index = build_dest_index(&existing_dest, config.record_matching.as_ref())?;

    let mut created = 0usize;
    let mut updated = 0usize;

    for (source_filename, source_value) in &source_files {
        let source_obj = match source_value.as_object() {
            Some(o) => o,
            None => {
                tracing::warn!("skipping {source_filename}: not a JSON object");
                continue;
            }
        };

        // Apply field mappings to build fieldData
        let mut field_data: HashMap<String, Value> = HashMap::new();
        for mapping in &config.field_mappings {
            if let Some(v) = source_obj.get(&mapping.source_field) {
                field_data.insert(mapping.dest_field.clone(), v.clone());
            }
        }

        // Find matching dest record
        let (out_filename, existing_id, base_field_data) = match &config.record_matching {
            Some(rm) => {
                let source_match_value = source_obj.get(&rm.source_field).and_then(|v| v.as_str());
                match source_match_value.and_then(|v| dest_index.get(v)) {
                    Some((dest_filename, dest_record)) => {
                        // Found a match — reuse filename, preserve id and existing fields
                        (dest_filename.clone(), dest_record.id.clone(), dest_record.field_data.clone())
                    }
                    None => {
                        // No match — new record, use source filename
                        (source_filename.clone(), None, HashMap::new())
                    }
                }
            }
            None => {
                // No matching configured — use source filename, no id
                (source_filename.clone(), None, HashMap::new())
            }
        };

        // Merge: start from existing fieldData, then overlay mapped fields
        let mut merged_field_data = base_field_data;
        merged_field_data.extend(field_data);

        let dest_record = DestRecord {
            id: existing_id,
            field_data: merged_field_data,
        };

        let out_path = dest_dir.join(&out_filename);
        let content = serde_json::to_string_pretty(&dest_record)?;
        std::fs::write(&out_path, content)?;

        if dest_record.id.is_some() {
            updated += 1;
        } else {
            created += 1;
        }
    }

    println!("    result: {created} new, {updated} updated");
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonFiles = Vec<(String, Value)>;

fn read_json_files(dir: &Path) -> Result<JsonFiles> {
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let filename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let raw = std::fs::read_to_string(&path)?;
        let value: Value = serde_json::from_str(&raw).map_err(|e| {
            Error::Other(format!("failed to parse {}: {e}", path.display()))
        })?;
        files.push((filename, value));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

/// Build an index of dest files keyed by the record-matching field value.
/// Key: value of `fieldData[recordMatching.destField]` as string
/// Value: (filename, parsed DestRecord)
fn build_dest_index(
    dest_files: &JsonFiles,
    record_matching: Option<&RecordMatching>,
) -> Result<HashMap<String, (String, DestRecord)>> {
    let mut index = HashMap::new();
    let rm = match record_matching {
        Some(rm) => rm,
        None => return Ok(index),
    };

    for (filename, value) in dest_files {
        // Try to parse as DestRecord
        let dest_record: DestRecord = match serde_json::from_value(value.clone()) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Some(match_val) = dest_record.field_data.get(&rm.dest_field) {
            if let Some(s) = match_val.as_str() {
                index.insert(s.to_string(), (filename.clone(), dest_record));
            }
        }
    }
    Ok(index)
}
