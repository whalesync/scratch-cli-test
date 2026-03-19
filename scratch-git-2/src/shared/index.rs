#![allow(dead_code)]
//! SQLite file index for a connector (master-branch state).
//!
//! Layout on disk:
//!   {workspace}/.scratch/connections/{connDirName}/master/   ← git worktree of main branch
//!   {workspace}/.scratch/connections/{connDirName}/index.db  ← SQLite index

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json::Value;

// ── Path helpers ─────────────────────────────────────────────────────────────

pub fn scratch_dir(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(".scratch")
}

pub fn conn_scratch_dir(workspace_dir: &Path, conn_dir_name: &str) -> PathBuf {
    workspace_dir.join(".scratch/connections").join(conn_dir_name)
}

pub fn master_dir(workspace_dir: &Path, conn_dir_name: &str) -> PathBuf {
    conn_scratch_dir(workspace_dir, conn_dir_name).join("master")
}

pub fn db_path(workspace_dir: &Path, conn_dir_name: &str) -> PathBuf {
    conn_scratch_dir(workspace_dir, conn_dir_name).join("index.db")
}

// ── FK schema helpers ─────────────────────────────────────────────────────────

pub struct FkField {
    /// Dot-notation path to the field in the record, e.g. "fields.Author".
    pub field_path: String,
    /// The `linkedTableId` from `x-scratch-foreign-key`.
    pub target_table_id: String,
}

/// Load FK field definitions from schema.json files stored in master_dir/.scratch/{folder}/schema.json.
/// Returns a map from relative folder path (e.g. "public/posts") to FK fields.
fn load_fk_map(master_dir: &Path) -> anyhow::Result<HashMap<String, Vec<FkField>>> {
    let mut map: HashMap<String, Vec<FkField>> = HashMap::new();
    let scratch_dir = master_dir.join(".scratch");
    if !scratch_dir.exists() {
        return Ok(map);
    }
    collect_fk_fields(&scratch_dir, &scratch_dir, &mut map)?;
    Ok(map)
}

fn collect_fk_fields(
    scratch_root: &Path,
    dir: &Path,
    map: &mut HashMap<String, Vec<FkField>>,
) -> anyhow::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
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
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            let Ok(schema) = serde_json::from_str::<Value>(&raw) else { continue };
            let fk_fields = extract_fk_fields(&schema);
            if !fk_fields.is_empty() {
                map.insert(folder_rel, fk_fields);
            }
        }
    }
    Ok(())
}

/// Extract FK field definitions from a schema.json object.
///
/// Schema format: `{ "schema": { "properties": { "fieldName": { "x-scratch-foreign-key": { "linkedTableId": "..." } } } } }`
/// Falls back to reading `properties` directly if there is no `schema` wrapper.
pub fn extract_fk_fields(outer: &Value) -> Vec<FkField> {
    let mut result = Vec::new();
    // Navigate to the JSON Schema object (may be under a "schema" key)
    let json_schema = outer.get("schema").unwrap_or(outer);
    let Some(props) = json_schema.get("properties").and_then(|v| v.as_object()) else {
        return result;
    };
    for (field_name, field_val) in props {
        if let Some(fk) = field_val.get("x-scratch-foreign-key") {
            if let Some(target_table_id) = fk.get("linkedTableId").and_then(|v| v.as_str()) {
                result.push(FkField {
                    field_path: field_name.clone(),
                    target_table_id: target_table_id.to_string(),
                });
            }
        }
    }
    result
}

pub fn get_by_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for key in path.split('.') {
        current = current.get(key)?;
    }
    Some(current)
}

// ── Index build ───────────────────────────────────────────────────────────────

/// Build (or rebuild) the SQLite file index for a connector.
///
/// `master_dir` — path to the master worktree (main-branch checkout).
/// `db_path`    — where to write index.db (parent dir must exist).
///
/// Returns the number of record files indexed.
pub fn build(master_dir: &Path, db_path: &Path) -> anyhow::Result<usize> {
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

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
        DELETE FROM file_index;
        DELETE FROM file_references;",
    )
    .map_err(|e| anyhow::anyhow!("failed to initialise tables: {e}"))?;

    let fk_map = load_fk_map(master_dir)?;
    let mut count = 0usize;
    index_dir(master_dir, master_dir, &conn, &fk_map, &mut count)?;
    Ok(count)
}

/// Build (or rebuild) the SQLite index from pre-processed entries.
///
/// Used by the git service, which reads file content directly from git objects
/// rather than the filesystem.
///
/// `file_entries` — `(folder, filename, remote_id)` tuples
/// `ref_entries`  — `(source_folder, source_filename, target_table_id, target_remote_id)` tuples
/// `db_path`      — where to write `index.db` (parent dir is created if missing)
pub fn build_from_entries(
    file_entries: &[(String, String, Option<String>)],
    ref_entries: &[(String, String, String, String)],
    db_path: &Path,
) -> anyhow::Result<()> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow::anyhow!("failed to create index dir: {e}"))?;
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

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
        DELETE FROM file_index;
        DELETE FROM file_references;",
    )
    .map_err(|e| anyhow::anyhow!("failed to initialise tables: {e}"))?;

    for (folder, filename, remote_id) in file_entries {
        conn.execute(
            "INSERT OR REPLACE INTO file_index (folder, filename, remote_id) VALUES (?1, ?2, ?3)",
            params![folder, filename, remote_id],
        )
        .map_err(|e| anyhow::anyhow!("failed to upsert {}/{}: {e}", folder, filename))?;
    }

    for (src_folder, src_filename, target_table_id, target_remote_id) in ref_entries {
        conn.execute(
            "INSERT INTO file_references \
             (source_folder, source_filename, target_table_id, target_remote_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![src_folder, src_filename, target_table_id, target_remote_id],
        )
        .map_err(|e| {
            anyhow::anyhow!("failed to insert reference for {}/{}: {e}", src_folder, src_filename)
        })?;
    }

    Ok(())
}

fn index_dir(
    root: &Path,
    dir: &Path,
    conn: &Connection,
    fk_map: &HashMap<String, Vec<FkField>>,
    count: &mut usize,
) -> anyhow::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            index_dir(root, &path, conn, fk_map, count)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name == "schema.json" {
                continue;
            }
            index_file(root, &path, conn, fk_map, count)?;
        }
    }
    Ok(())
}

fn index_file(
    root: &Path,
    path: &Path,
    conn: &Connection,
    fk_map: &HashMap<String, Vec<FkField>>,
    count: &mut usize,
) -> anyhow::Result<()> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };

    let remote_id = value.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

    let parent = path.parent().unwrap_or(root);
    let folder = parent
        .strip_prefix(root)
        .unwrap_or(parent)
        .to_string_lossy()
        .to_string();
    let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();

    conn.execute(
        "INSERT OR REPLACE INTO file_index (folder, filename, remote_id) VALUES (?1, ?2, ?3)",
        params![folder, filename, remote_id],
    )
    .map_err(|e| anyhow::anyhow!("failed to upsert {}/{}: {e}", folder, filename))?;

    if let Some(fk_fields) = fk_map.get(&folder) {
        for fk in fk_fields {
            if let Some(ref_val) = get_by_path(&value, &fk.field_path) {
                // Collect FK values as strings; numbers are coerced (e.g. Postgres integer IDs)
                let owned: Vec<String> = match ref_val {
                    Value::String(s) => vec![s.clone()],
                    Value::Number(n) => vec![n.to_string()],
                    Value::Array(arr) => arr
                        .iter()
                        .filter_map(|v| match v {
                            Value::String(s) => Some(s.clone()),
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        })
                        .collect(),
                    _ => vec![],
                };
                for target_remote_id in &owned {
                    conn.execute(
                        "INSERT INTO file_references \
                         (source_folder, source_filename, target_table_id, target_remote_id) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![folder, filename, fk.target_table_id, target_remote_id],
                    )
                    .map_err(|e| {
                        anyhow::anyhow!("failed to insert reference for {}/{}: {e}", folder, filename)
                    })?;
                }
            }
        }
    }

    *count += 1;
    Ok(())
}

// ── Index dump ────────────────────────────────────────────────────────────────

pub struct IndexRow {
    pub folder: String,
    pub filename: String,
    pub remote_id: Option<String>,
}

pub struct ReferenceRow {
    pub source_folder: String,
    pub source_filename: String,
    pub target_table_id: String,
    pub target_remote_id: String,
}

pub fn read_index(db_path: &Path) -> anyhow::Result<Vec<IndexRow>> {
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;
    let mut stmt = conn
        .prepare("SELECT folder, filename, remote_id FROM file_index ORDER BY folder, filename")
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(IndexRow {
                folder: row.get(0)?,
                filename: row.get(1)?,
                remote_id: row.get(2)?,
            })
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(rows)
}

pub fn read_references(db_path: &Path) -> anyhow::Result<Vec<ReferenceRow>> {
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='file_references'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if !table_exists {
        return Ok(vec![]);
    }
    let mut stmt = conn
        .prepare(
            "SELECT source_folder, source_filename, target_table_id, target_remote_id \
             FROM file_references ORDER BY source_folder, source_filename",
        )
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ReferenceRow {
                source_folder: row.get(0)?,
                source_filename: row.get(1)?,
                target_table_id: row.get(2)?,
                target_remote_id: row.get(3)?,
            })
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(rows)
}
