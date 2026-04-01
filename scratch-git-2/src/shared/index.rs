#![allow(dead_code)]
//! SQLite file index for a connector (master-branch state).
//!
//! Transitional path helpers live here so older CLI call sites can migrate to
//! [`WorkspaceLayout`] incrementally.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::Value;

use super::layout::WorkspaceLayout;

// ── Path helpers ─────────────────────────────────────────────────────────────

pub fn scratch_dir_for_layout(layout: &WorkspaceLayout) -> PathBuf {
    layout.scratch_root().join("connections").join("scratch")
}

pub fn conn_scratch_dir_for_layout(layout: &WorkspaceLayout, conn_dir_name: &str) -> PathBuf {
    layout.connection_scratch_path(conn_dir_name)
}

pub fn master_dir_for_layout(layout: &WorkspaceLayout, conn_dir_name: &str) -> PathBuf {
    layout.master_worktree_path(conn_dir_name)
}

pub fn db_path_for_layout(layout: &WorkspaceLayout, repo_id: &str) -> PathBuf {
    layout.index_db_path(repo_id)
}

pub fn scratch_dir(workspace_dir: &Path) -> PathBuf {
    scratch_dir_for_layout(&WorkspaceLayout::for_cli(workspace_dir))
}

pub fn conn_scratch_dir(workspace_dir: &Path, conn_dir_name: &str) -> PathBuf {
    conn_scratch_dir_for_layout(&WorkspaceLayout::for_cli(workspace_dir), conn_dir_name)
}

pub fn master_dir(workspace_dir: &Path, conn_dir_name: &str) -> PathBuf {
    master_dir_for_layout(&WorkspaceLayout::for_cli(workspace_dir), conn_dir_name)
}

pub fn db_path(workspace_dir: &Path, conn_dir_name: &str) -> PathBuf {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    match repo_id_for_conn_dir(workspace_dir, conn_dir_name) {
        Some(repo_id) => db_path_for_layout(&layout, &repo_id),
        None => workspace_dir
            .join(".scratch")
            .join("connections")
            .join(conn_dir_name)
            .join("index.db"),
    }
}

#[derive(Debug, Deserialize)]
struct WorkspaceMarkerConnections {
    #[serde(default)]
    connections: Vec<WorkspaceMarkerConnection>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceMarkerConnection {
    #[serde(rename = "dirName", default)]
    dir_name: String,
    #[serde(rename = "repoPath", default)]
    repo_path: String,
}

fn repo_id_for_conn_dir(workspace_dir: &Path, conn_dir_name: &str) -> Option<String> {
    let marker_path = workspace_dir.join(".scratch").join(".scratchmd");
    let content = std::fs::read_to_string(marker_path).ok()?;
    let marker: WorkspaceMarkerConnections = serde_yaml::from_str(&content).ok()?;
    marker
        .connections
        .into_iter()
        .find(|conn| conn.dir_name == conn_dir_name && !conn.repo_path.is_empty())
        .map(|conn| conn.repo_path)
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
/// Schema format: `{ "schema": { "properties": { "fields": { "properties": { "authors": { "x-scratch-foreign-key": { "linkedTableId": "..." } } } } } } }`
/// Falls back to reading `properties` directly if there is no `schema` wrapper.
/// Recurses into nested `properties` objects, building dot-notation paths (e.g. `"fields.authors"`).
pub fn extract_fk_fields(outer: &Value) -> Vec<FkField> {
    let mut result = Vec::new();
    let json_schema = outer.get("schema").unwrap_or(outer);
    extract_fk_fields_rec(json_schema, "", &mut result);
    result
}

fn extract_fk_fields_rec(schema: &Value, prefix: &str, out: &mut Vec<FkField>) {
    let Some(props) = schema.get("properties").and_then(|v| v.as_object()) else {
        return;
    };
    for (field_name, field_val) in props {
        let path = if prefix.is_empty() {
            field_name.clone()
        } else {
            format!("{}.{}", prefix, field_name)
        };
        if let Some(fk) = field_val.get("x-scratch-foreign-key") {
            if let Some(target_table_id) = fk.get("linkedTableId").and_then(|v| v.as_str()) {
                out.push(FkField {
                    field_path: path.clone(),
                    target_table_id: target_table_id.to_string(),
                });
            }
        }
        extract_fk_fields_rec(field_val, &path, out);
    }
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

    conn.execute_batch("BEGIN")
        .map_err(|e| anyhow::anyhow!("failed to begin transaction: {e}"))?;

    let fk_map = load_fk_map(master_dir)?;
    let mut count = 0usize;
    index_dir(master_dir, master_dir, &conn, &fk_map, &mut count)?;

    conn.execute_batch("COMMIT")
        .map_err(|e| anyhow::anyhow!("failed to commit transaction: {e}"))?;

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

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| anyhow::anyhow!("failed to begin transaction: {e}"))?;

    for (folder, filename, remote_id) in file_entries {
        tx.execute(
            "INSERT OR REPLACE INTO file_index (folder, filename, remote_id) VALUES (?1, ?2, ?3)",
            params![folder, filename, remote_id],
        )
        .map_err(|e| anyhow::anyhow!("failed to upsert {}/{}: {e}", folder, filename))?;
    }

    for (src_folder, src_filename, target_table_id, target_remote_id) in ref_entries {
        tx.execute(
            "INSERT INTO file_references \
             (source_folder, source_filename, target_table_id, target_remote_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![src_folder, src_filename, target_table_id, target_remote_id],
        )
        .map_err(|e| {
            anyhow::anyhow!("failed to insert reference for {}/{}: {e}", src_folder, src_filename)
        })?;
    }

    tx.commit()
        .map_err(|e| anyhow::anyhow!("failed to commit index transaction: {e}"))?;

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

// ── Incremental update ────────────────────────────────────────────────────────

/// Create the index tables if they don't exist yet.
/// Safe to call on every write — is a no-op if tables are present.
fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
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
        );",
    )
    .map_err(|e| anyhow::anyhow!("failed to ensure index schema: {e}"))
}

/// Incrementally upsert one file into the index.
///
/// - Opens (or creates) `db_path`
/// - Upserts one row in `file_index`
/// - Deletes + re-inserts `file_references` rows for this file
/// - Never touches other rows
///
/// `fk_fields` — FK field definitions for this file's folder (pass empty slice if none).
pub fn upsert_single_file(
    db_path: &Path,
    folder: &str,
    filename: &str,
    json_content: &str,
    fk_fields: &[FkField],
) -> anyhow::Result<()> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;
    ensure_schema(&conn)?;

    let value: Value = serde_json::from_str(json_content)
        .map_err(|e| anyhow::anyhow!("failed to parse JSON for {}/{}: {e}", folder, filename))?;

    let remote_id = value
        .get("id")
        .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string())));

    conn.execute(
        "INSERT OR REPLACE INTO file_index (folder, filename, remote_id) VALUES (?1, ?2, ?3)",
        params![folder, filename, remote_id],
    )
    .map_err(|e| anyhow::anyhow!("failed to upsert index row for {}/{}: {e}", folder, filename))?;

    // Delete old references for this file, then re-insert
    conn.execute(
        "DELETE FROM file_references WHERE source_folder = ?1 AND source_filename = ?2",
        params![folder, filename],
    )
    .map_err(|e| anyhow::anyhow!("failed to delete old references for {}/{}: {e}", folder, filename))?;

    for fk in fk_fields {
        if let Some(ref_val) = get_by_path(&value, &fk.field_path) {
            let targets: Vec<String> = match ref_val {
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
            for target_id in targets {
                conn.execute(
                    "INSERT INTO file_references \
                     (source_folder, source_filename, target_table_id, target_remote_id) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![folder, filename, fk.target_table_id, target_id],
                )
                .map_err(|e| {
                    anyhow::anyhow!("failed to insert reference for {}/{}: {e}", folder, filename)
                })?;
            }
        }
    }

    Ok(())
}

/// Remove a file from the index (called when a file is deleted from main).
pub fn remove_single_file(db_path: &Path, folder: &str, filename: &str) -> anyhow::Result<()> {
    if !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;
    conn.execute(
        "DELETE FROM file_index WHERE folder = ?1 AND filename = ?2",
        params![folder, filename],
    )?;
    conn.execute(
        "DELETE FROM file_references WHERE source_folder = ?1 AND source_filename = ?2",
        params![folder, filename],
    )?;
    Ok(())
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/// Upsert a batch of `(folder, filename, remote_id)` entries into the index.
///
/// Creates the index tables if they don't exist yet (safe to call before a full build).
pub fn upsert_entries(
    db_path: &Path,
    entries: &[(String, String, Option<String>)],
) -> anyhow::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow::anyhow!("failed to create index dir: {e}"))?;
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;
    ensure_schema(&conn)?;

    for (folder, filename, remote_id) in entries {
        conn.execute(
            "INSERT OR REPLACE INTO file_index (folder, filename, remote_id) VALUES (?1, ?2, ?3)",
            params![folder, filename, remote_id],
        )
        .map_err(|e| anyhow::anyhow!("failed to upsert {}/{}: {e}", folder, filename))?;
    }
    Ok(())
}

/// Delete a batch of `(folder, filename)` entries from the index and their FK references.
pub fn delete_entries(db_path: &Path, entries: &[(String, String)]) -> anyhow::Result<()> {
    if entries.is_empty() || !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

    for (folder, filename) in entries {
        conn.execute(
            "DELETE FROM file_index WHERE folder = ?1 AND filename = ?2",
            params![folder, filename],
        )
        .map_err(|e| anyhow::anyhow!("failed to delete {}/{}: {e}", folder, filename))?;
        conn.execute(
            "DELETE FROM file_references WHERE source_folder = ?1 AND source_filename = ?2",
            params![folder, filename],
        )
        .map_err(|e| {
            anyhow::anyhow!("failed to delete references for {}/{}: {e}", folder, filename)
        })?;
    }
    Ok(())
}

// ── Lookups ───────────────────────────────────────────────────────────────────

/// Resolve a batch of filenames in a given folder to their remote IDs.
///
/// Returns a map of `filename → remote_id` for entries that exist in the index.
/// Missing filenames are silently omitted.
pub fn lookup_filenames_to_remote_ids(
    db_path: &Path,
    folder: &str,
    filenames: &[String],
) -> anyhow::Result<HashMap<String, String>> {
    if filenames.is_empty() || !db_path.exists() {
        return Ok(HashMap::new());
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

    let placeholders: String = filenames
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT filename, remote_id FROM file_index \
         WHERE folder = ?1 AND filename IN ({placeholders}) AND remote_id IS NOT NULL"
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| anyhow::anyhow!("prepare failed: {e}"))?;

    use rusqlite::types::ToSql;
    let folder_val: &dyn ToSql = &folder;
    let fn_vals: Vec<Box<dyn ToSql>> =
        filenames.iter().map(|s| Box::new(s.clone()) as Box<dyn ToSql>).collect();
    let mut all_params: Vec<&dyn ToSql> = vec![folder_val];
    for v in &fn_vals {
        all_params.push(v.as_ref());
    }

    let mut map = HashMap::new();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(all_params.iter().copied()), |row| {
            let filename: String = row.get(0)?;
            let remote_id: String = row.get(1)?;
            Ok((filename, remote_id))
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;

    for row in rows {
        let (filename, remote_id) = row.map_err(|e| anyhow::anyhow!("{e}"))?;
        map.insert(filename, remote_id);
    }

    Ok(map)
}

/// Resolve a batch of remote IDs in a given folder to their filenames.
///
/// Returns a map of `remote_id → filename` for IDs that exist in the index.
/// Missing IDs are silently omitted.
pub fn lookup_by_remote_ids(
    db_path: &Path,
    folder: &str,
    remote_ids: &[String],
) -> anyhow::Result<HashMap<String, String>> {
    if remote_ids.is_empty() {
        return Ok(HashMap::new());
    }
    if !db_path.exists() {
        return Ok(HashMap::new());
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

    // Build parameterized IN clause: (?2, ?3, ...)
    let placeholders: String = remote_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT remote_id, filename FROM file_index WHERE folder = ?1 AND remote_id IN ({placeholders})"
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| anyhow::anyhow!("prepare failed: {e}"))?;

    // Build params: folder first, then each remote_id
    use rusqlite::types::ToSql;
    let folder_val: &dyn ToSql = &folder;
    let id_vals: Vec<Box<dyn ToSql>> =
        remote_ids.iter().map(|s| Box::new(s.clone()) as Box<dyn ToSql>).collect();
    let mut all_params: Vec<&dyn ToSql> = vec![folder_val];
    for v in &id_vals {
        all_params.push(v.as_ref());
    }

    let mut map = HashMap::new();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(all_params.iter().copied()), |row| {
            let remote_id: String = row.get(0)?;
            let filename: String = row.get(1)?;
            Ok((remote_id, filename))
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;

    for row in rows {
        let (remote_id, filename) = row.map_err(|e| anyhow::anyhow!("{e}"))?;
        map.insert(remote_id, filename);
    }

    Ok(map)
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

#[cfg(test)]
mod tests {
    use super::{conn_scratch_dir, db_path, master_dir, scratch_dir};
    use tempfile::TempDir;

    #[test]
    fn wrappers_follow_new_cli_layout_when_v3_connections_are_available() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".scratch")).unwrap();
        std::fs::write(
            root.join(".scratch/.scratchmd"),
            r#"version: "3"
workbook:
  id: wkb_test
  name: Test
  serverUrl: http://localhost
  initializedAt: "2026-01-01T00:00:00Z"
connections:
  - id: conn_1
    displayName: My Conn
    service: AIRTABLE
    repoPath: org123/wkb_test/conn_1
    dirName: AIRTABLE - My Conn
"#,
        )
        .unwrap();

        assert_eq!(
            scratch_dir(root),
            root.join(".scratch").join("connections").join("scratch")
        );
        assert_eq!(
            conn_scratch_dir(root, "AIRTABLE - My Conn"),
            root.join(".scratch").join("connections").join("scratch").join("AIRTABLE - My Conn")
        );
        assert_eq!(
            master_dir(root, "AIRTABLE - My Conn"),
            root.join(".scratch").join("connections").join("master").join("AIRTABLE - My Conn")
        );
        assert_eq!(
            db_path(root, "AIRTABLE - My Conn"),
            root.join(".repos").join("conn_1.db")
        );
    }

    #[test]
    fn db_path_falls_back_to_legacy_location_without_v3_connection_mapping() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".scratch")).unwrap();
        std::fs::write(
            root.join(".scratch/.scratchmd"),
            r#"version: "2"
workbook:
  id: wkb_test
  name: Test
  serverUrl: http://localhost
  initializedAt: "2026-01-01T00:00:00Z"
"#,
        )
        .unwrap();

        assert_eq!(
            db_path(root, "legacy-conn"),
            root.join(".scratch").join("connections").join("legacy-conn").join("index.db")
        );
    }
}
