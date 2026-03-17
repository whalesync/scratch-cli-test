//! `scratchmdv4 build-index` — build a SQLite file index for each connection.
//!
//! Walks the master worktree of each connection, extracts the top-level `id`
//! field from every JSON file, and upserts it into:
//!   workspace/.scratch/connections/{ConnName}/index.db
//!
//! Also builds a `file_references` table in the same pass by inspecting each
//! folder's schema.json for `x-scratch-foreign-key` annotations and extracting
//! the referenced remote IDs from each record.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::{Error, Result};
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: auto-detected)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,
}

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;
    let connections_dir = workspace.join(".scratch/connections");

    if !connections_dir.exists() {
        return Err(Error::Other(format!(
            "connections directory not found at {}. Run `scratchmdv4 pull` first.",
            connections_dir.display()
        )));
    }

    let mut total_indexed = 0usize;
    let mut total_connections = 0usize;

    for entry in std::fs::read_dir(&connections_dir)? {
        let entry = entry?;
        let conn_dir = entry.path();
        if !conn_dir.is_dir() {
            continue;
        }

        let master_dir = conn_dir.join("master");
        if !master_dir.exists() {
            continue;
        }

        let conn_name = conn_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        let db_path = conn_dir.join("index.db");

        let count = index_connection(&master_dir, &db_path, &conn_name)?;
        println!("  {conn_name}: indexed {count} file(s) → {}", db_path.display());
        total_indexed += count;
        total_connections += 1;
    }

    println!("\nDone. Indexed {total_indexed} file(s) across {total_connections} connection(s).");
    Ok(())
}

// ── FK schema helpers ──────────────────────────────────────────────────────

/// A foreign key field extracted from a schema: dot-notation path + target table ID.
struct FkField {
    /// Dot-notation path to the field in the record, e.g. "fields.Author" or "fieldData.author-ref".
    field_path: String,
    /// The `linkedTableId` from `x-scratch-foreign-key`.
    target_table_id: String,
}

/// Load FK field definitions from all schema.json files under `master_dir/.scratch/`.
/// Returns a map from relative folder path (e.g. "Transformers Test/posts") to FK fields.
fn load_fk_map(master_dir: &std::path::Path) -> Result<HashMap<String, Vec<FkField>>> {
    let mut map: HashMap<String, Vec<FkField>> = HashMap::new();
    let scratch_dir = master_dir.join(".scratch");
    if !scratch_dir.exists() {
        return Ok(map);
    }
    collect_fk_fields(&scratch_dir, &scratch_dir, &mut map)?;
    Ok(map)
}

fn collect_fk_fields(
    scratch_root: &std::path::Path,
    dir: &std::path::Path,
    map: &mut HashMap<String, Vec<FkField>>,
) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_fk_fields(scratch_root, &path, map)?;
        } else if path.file_name().map(|n| n == "schema.json").unwrap_or(false) {
            let parent = path.parent().unwrap_or(scratch_root);
            let folder_rel = parent
                .strip_prefix(scratch_root)
                .unwrap_or(parent)
                .to_string_lossy()
                .to_string();

            let raw = std::fs::read_to_string(&path)?;
            let schema: Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let fk_fields = extract_fk_fields(&schema);
            if !fk_fields.is_empty() {
                map.insert(folder_rel, fk_fields);
            }
        }
    }
    Ok(())
}

/// Walk `properties.*.properties.*` in the schema, collecting fields with `x-scratch-foreign-key`.
fn extract_fk_fields(schema: &Value) -> Vec<FkField> {
    let mut result = Vec::new();
    let Some(top_props) = schema.get("properties").and_then(|v| v.as_object()) else {
        return result;
    };
    for (top_key, top_val) in top_props {
        let Some(nested_props) = top_val.get("properties").and_then(|v| v.as_object()) else {
            continue;
        };
        for (field_name, field_val) in nested_props {
            if let Some(fk) = field_val.get("x-scratch-foreign-key") {
                if let Some(target_table_id) = fk.get("linkedTableId").and_then(|v| v.as_str()) {
                    result.push(FkField {
                        field_path: format!("{top_key}.{field_name}"),
                        target_table_id: target_table_id.to_string(),
                    });
                }
            }
        }
    }
    result
}

fn get_by_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for key in path.split('.') {
        current = current.get(key)?;
    }
    Some(current)
}

// ── Indexing ───────────────────────────────────────────────────────────────

fn index_connection(master_dir: &std::path::Path, db_path: &std::path::Path, conn_name: &str) -> Result<usize> {
    let conn = Connection::open(db_path)
        .map_err(|e| Error::Other(format!("failed to open index.db for {conn_name}: {e}")))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS file_index (
            folder    TEXT NOT NULL,
            filename  TEXT NOT NULL,
            remote_id TEXT,
            PRIMARY KEY (folder, filename)
        );
        CREATE TABLE IF NOT EXISTS file_references (
            source_folder    TEXT NOT NULL,
            source_filename  TEXT NOT NULL,
            target_table_id  TEXT NOT NULL,
            target_remote_id TEXT NOT NULL
        );
        DELETE FROM file_references;",
    )
    .map_err(|e| Error::Other(format!("failed to create tables: {e}")))?;

    let fk_map = load_fk_map(master_dir)?;

    let mut count = 0usize;
    index_dir(master_dir, master_dir, &conn, &fk_map, &mut count)?;

    tracing::info!("indexed {count} files for connection at {}", master_dir.display());
    Ok(count)
}

fn index_dir(
    root: &std::path::Path,
    dir: &std::path::Path,
    conn: &Connection,
    fk_map: &HashMap<String, Vec<FkField>>,
    count: &mut usize,
) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            // Skip .scratch metadata dirs
            if path.file_name().map(|n| n == ".scratch").unwrap_or(false) {
                continue;
            }
            index_dir(root, &path, conn, fk_map, count)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            index_file(root, &path, conn, fk_map, count)?;
        }
    }
    Ok(())
}

fn index_file(
    root: &std::path::Path,
    path: &std::path::Path,
    conn: &Connection,
    fk_map: &HashMap<String, Vec<FkField>>,
    count: &mut usize,
) -> Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let value: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(()), // skip non-JSON
    };

    let remote_id = value.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

    // Compute folder as the relative path from root to the file's parent
    let parent = path.parent().unwrap_or(root);
    let folder = parent
        .strip_prefix(root)
        .unwrap_or(parent)
        .to_string_lossy()
        .to_string();

    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    conn.execute(
        "INSERT OR REPLACE INTO file_index (folder, filename, remote_id) VALUES (?1, ?2, ?3)",
        params![folder, filename, remote_id],
    )
    .map_err(|e| Error::Other(format!("failed to upsert {}/{}: {e}", folder, filename)))?;

    // Insert file references for FK fields defined in this folder's schema
    if let Some(fk_fields) = fk_map.get(&folder) {
        for fk in fk_fields {
            if let Some(ref_val) = get_by_path(&value, &fk.field_path) {
                let refs: Vec<&str> = match ref_val {
                    Value::String(s) => vec![s.as_str()],
                    Value::Array(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
                    _ => vec![],
                };
                for target_remote_id in refs {
                    conn.execute(
                        "INSERT INTO file_references (source_folder, source_filename, target_table_id, target_remote_id) VALUES (?1, ?2, ?3, ?4)",
                        params![folder, filename, fk.target_table_id, target_remote_id],
                    )
                    .map_err(|e| Error::Other(format!("failed to insert reference for {}/{}: {e}", folder, filename)))?;
                }
            }
        }
    }

    *count += 1;
    Ok(())
}
