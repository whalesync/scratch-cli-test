//! `scratchmd run-sync` — apply sync configs to local materialized worktrees.
//!
//! Reads sync JSON from `.scratch/workbook/syncs/*.json`, reads source records
//! from the master worktree of the source connection, applies field mappings,
//! and writes transformed records to the dirty worktree of the destination connection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
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
        if !source_value.is_object() {
            tracing::warn!("skipping {source_filename}: not a JSON object");
            continue;
        }

        // Find matching dest record (load full existing JSON as base)
        let (out_filename, mut dest_value) = match &config.record_matching {
            Some(rm) => {
                let source_match_value = get_by_path(&source_value, &rm.source_field)
                    .and_then(|v| v.as_str());
                match source_match_value.and_then(|v| dest_index.get(v)) {
                    Some((dest_filename, existing_json)) => {
                        // Found a match — reuse filename and all existing fields
                        (dest_filename.clone(), existing_json.clone())
                    }
                    None => {
                        // No match — new record with a pending name
                        let hash = pending_hash();
                        (format!("scratch_pending_{hash}.json"), Value::Object(serde_json::Map::new()))
                    }
                }
            }
            None => {
                let hash = pending_hash();
                (format!("scratch_pending_{hash}.json"), Value::Object(serde_json::Map::new()))
            }
        };

        // Apply field mappings via dot-notation paths on both sides
        for mapping in &config.field_mappings {
            if let Some(v) = get_by_path(&source_value, &mapping.source_field) {
                set_by_path(&mut dest_value, &mapping.dest_field, v.clone());
            }
        }

        let out_path = dest_dir.join(&out_filename);
        let content = serde_json::to_string_pretty(&dest_value)?;
        std::fs::write(&out_path, content)?;

        if dest_value.get("id").and_then(|v| v.as_str()).is_some() {
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
/// Uses dot-notation path to find the match field in each dest record.
fn build_dest_index(
    dest_files: &JsonFiles,
    record_matching: Option<&RecordMatching>,
) -> Result<HashMap<String, (String, Value)>> {
    let mut index = HashMap::new();
    let rm = match record_matching {
        Some(rm) => rm,
        None => return Ok(index),
    };
    for (filename, value) in dest_files {
        if let Some(match_val) = get_by_path(value, &rm.dest_field).and_then(|v| v.as_str()) {
            index.insert(match_val.to_string(), (filename.clone(), value.clone()));
        }
    }
    Ok(index)
}

/// Resolve a dot-notation path on a JSON value (e.g. "fields.views" → value["fields"]["views"]).
fn get_by_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').fold(Some(value), |acc, key| acc?.as_object()?.get(key))
}

/// Set a value at a dot-notation path, creating intermediate objects as needed.
fn set_by_path(value: &mut Value, path: &str, v: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = value;
    for part in &parts[..parts.len() - 1] {
        if let Value::Object(map) = current {
            map.entry(*part).or_insert_with(|| Value::Object(serde_json::Map::new()));
            current = map.get_mut(*part).unwrap();
        } else {
            return;
        }
    }
    if let Value::Object(map) = current {
        map.insert(parts[parts.len() - 1].to_string(), v);
    }
}

/// Generate an 8-character hex string from the current time for pending filenames.
fn pending_hash() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos)
}
