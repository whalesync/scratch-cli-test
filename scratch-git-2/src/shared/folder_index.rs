#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Context;
use rusqlite::{params, types::ToSql, Connection, TransactionBehavior};
use serde::Serialize;

use crate::shared::validators::{run_validators_dry, ValidatorEntry};

// ─────────────────────────────────────────────────────────────────────────────
// Schema versioning
// ─────────────────────────────────────────────────────────────────────────────

/// Bumped whenever any `CREATE TABLE` definition in this file changes.
/// Tables are physically named with the `__v<N>` suffix; on version change the
/// sweep in `open_conn` drops everything that doesn't match, and the next
/// pagination request rebuilds cold from the JSON files on disk. The index is
/// derivative — JSON is authoritative — so cold rebuild is always safe.
const INDEX_SCHEMA_VERSION: u32 = 2;

fn version_suffix() -> String {
    format!("__v{INDEX_SCHEMA_VERSION}")
}

/// Versioned name for the shared validation_results table.
fn validation_results_table() -> String {
    format!("validation_results{}", version_suffix())
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum FilterSpec {
    HasWorking,
    HasDirty,
    HasMaster,
    ApprovedChanges,
    UnapprovedChanges,
    HasErrors,
    Field {
        column: String,
        op: FieldOp,
        value: String,
    },
}

#[derive(Debug, Clone)]
pub enum FieldOp {
    Eq,
    Lt,
    Gt,
    Contains,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SortOrder {
    Asc,
    Desc,
}

#[derive(Debug)]
pub struct QueryOptions {
    pub workspace: PathBuf,
    /// Workspace-relative folder path, e.g. "connection/posts" or "/connection/posts".
    pub folder: String,
    pub offset: i64,
    pub limit: i64,
    /// "filename" | "approvedChanges" | "unapprovedChanges" | json path like "fields.title"
    pub sort_by: String,
    pub sort_order: SortOrder,
    pub filters: Vec<FilterSpec>,
    pub db_path_override: Option<PathBuf>,
    pub reindex: bool,
    pub debug: bool,
    /// When true, validate stale records on the current page and return per-row errors.
    pub validate: bool,
}

#[derive(Debug, Serialize)]
pub struct ValidationError {
    pub field_path: String,
    pub validator_kind: String,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub fixable: bool,
}

#[derive(Debug, Serialize)]
pub struct ReadRecordsResult {
    pub filenames: Vec<String>,
    pub filtered_total: i64,
    pub summary: FolderSummary,
    pub parse_errors: Vec<ParseError>,
    /// Number of records on this page whose validation is stale (before this call's validation run).
    pub stale_count: i64,
    /// Validation errors per filename for records on this page. Empty when validate=false or no errors.
    pub row_errors: HashMap<String, Vec<ValidationError>>,
    /// Total records across the whole table that have has_errors=1.
    pub total_error_count: i64,
    /// Total records across the whole table with stale validation. 0 when validate=false.
    pub total_problems_stale_count: i64,
}

#[derive(Debug, Serialize)]
pub struct FolderSummary {
    pub total: i64,
    pub approved_changes: i64,
    pub unapproved_changes: i64,
    /// In working tree only — not in dirty or master.
    pub working_only: i64,
    /// In dirty branch only — not in working tree or master.
    pub dirty_only: i64,
    /// In master branch only — not in working tree or dirty.
    pub master_only: i64,
}

#[derive(Debug, Serialize)]
pub struct ParseError {
    pub filename: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub stale: i64,
    pub total: i64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic SQL parameter type
// ─────────────────────────────────────────────────────────────────────────────

enum DynParam {
    Text(String),
    Int(i64),
}

impl ToSql for DynParam {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        match self {
            DynParam::Text(s) => s.to_sql(),
            DynParam::Int(i) => i.to_sql(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

struct FolderPaths {
    working: PathBuf,
    dirty: PathBuf,
    master: PathBuf,
}

fn resolve_folder_paths(workspace: &Path, folder: &str) -> FolderPaths {
    let normalized = folder.trim_start_matches('/');
    let (conn_name, sub_path) = match normalized.find('/') {
        Some(idx) => (&normalized[..idx], &normalized[idx + 1..]),
        None => (normalized, ""),
    };

    let working = if sub_path.is_empty() {
        workspace.join(conn_name)
    } else {
        workspace.join(conn_name).join(sub_path)
    };

    let dirty_base = workspace
        .join(".scratch")
        .join("connections")
        .join("dirty")
        .join(conn_name);
    let dirty = if sub_path.is_empty() {
        dirty_base
    } else {
        dirty_base.join(sub_path)
    };

    let master_base = workspace
        .join(".scratch")
        .join("connections")
        .join("master")
        .join(conn_name);
    let master = if sub_path.is_empty() {
        master_base
    } else {
        master_base.join(sub_path)
    };

    FolderPaths {
        working,
        dirty,
        master,
    }
}

/// Returns the path to the `schema.json` file for the given folder.
/// Schema files live at `<workspace>/.scratch/connections/scratch/<conn>/<sub_path>/schema.json`.
fn resolve_folder_schema_path(workspace: &Path, folder: &str) -> PathBuf {
    let normalized = folder.trim_start_matches('/');
    let (conn_name, sub_path) = match normalized.find('/') {
        Some(idx) => (&normalized[..idx], &normalized[idx + 1..]),
        None => (normalized, ""),
    };
    let base = workspace
        .join(".scratch")
        .join("connections")
        .join("scratch")
        .join(conn_name);
    let dir = if sub_path.is_empty() {
        base
    } else {
        base.join(sub_path)
    };
    dir.join("schema.json")
}

/// Load the folder's `schema.json` if present and parseable.
fn load_folder_schema(workspace: &Path, folder: &str) -> Option<serde_json::Value> {
    let path = resolve_folder_schema_path(workspace, folder);
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// True if a JSON Schema property node represents a numeric type.
/// Handles `"type": "number" | "integer"`, the array form `"type": ["number", "null"]`,
/// and the nullable wrapper forms `anyOf` / `oneOf` (e.g. `[{type: number}, {type: null}]`).
fn schema_node_is_numeric(node: &serde_json::Value) -> bool {
    if let Some(t) = node.get("type") {
        if let Some(s) = t.as_str() {
            return matches!(s, "number" | "integer");
        }
        if let Some(arr) = t.as_array() {
            return arr
                .iter()
                .filter_map(|v| v.as_str())
                .any(|s| matches!(s, "number" | "integer"));
        }
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(branches) = node.get(key).and_then(|v| v.as_array()) {
            if branches.iter().any(schema_node_is_numeric) {
                return true;
            }
        }
    }
    false
}

/// True if a dot-separated json path (e.g. `"fields.price"`) resolves to a
/// numeric property in `schema_doc`. The document may wrap the schema under a
/// top-level `"schema"` key (the format produced by the publish pipeline).
fn schema_path_is_numeric(schema_doc: &serde_json::Value, json_path: &str) -> bool {
    let root = schema_doc.get("schema").unwrap_or(schema_doc);
    let mut current = root;
    for part in json_path.split('.') {
        let Some(props) = current.get("properties") else {
            return false;
        };
        let Some(next) = props.get(part) else {
            return false;
        };
        current = next;
    }
    schema_node_is_numeric(current)
}

/// Convenience wrapper: load the folder schema and check the given column.
/// Returns `false` if no schema is found — keeping TEXT affinity is the safe default.
fn folder_column_is_numeric(workspace: &Path, folder: &str, column: &str) -> bool {
    match load_folder_schema(workspace, folder) {
        Some(doc) => schema_path_is_numeric(&doc, column),
        None => false,
    }
}

/// Extract the connection name (first path component) from a folder path.
fn conn_name_from_folder(folder: &str) -> &str {
    let normalized = folder.trim_start_matches('/');
    match normalized.find('/') {
        Some(idx) => &normalized[..idx],
        None => normalized,
    }
}

/// Derive a SQL table name from the subfolder portion of a folder path.
/// Appends the schema version suffix so old/incompatible tables get swept on bump.
/// e.g. "conn/public/posts" → "public_posts__v1", "conn" → "root__v1"
pub fn table_name_from_folder(folder: &str) -> String {
    let normalized = folder.trim_start_matches('/');
    let sub = match normalized.find('/') {
        Some(idx) => &normalized[idx + 1..],
        None => "",
    };
    let base = if sub.is_empty() {
        "root".to_string()
    } else {
        // Replace path separators and sanitize to alphanumeric + underscore.
        // Prefix with 't_' if the first char is not a letter (SQL safety).
        let slug: String = sub
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if slug.starts_with(|c: char| c.is_ascii_digit()) {
            format!("t_{slug}")
        } else {
            slug
        }
    };
    format!("{base}{}", version_suffix())
}

fn resolve_db_path(workspace: &Path, folder: &str, override_path: Option<&Path>) -> PathBuf {
    if let Some(p) = override_path {
        return p.to_path_buf();
    }
    let conn = conn_name_from_folder(folder);
    workspace.join(".repos").join(format!("{conn}.db"))
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite connection helpers
// ─────────────────────────────────────────────────────────────────────────────

fn open_conn(db_path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory {}", parent.display()))?;
    }
    let conn = Connection::open(db_path)
        .with_context(|| format!("failed to open database {}", db_path.display()))?;
    // WAL mode for concurrent readers; 5 s busy timeout before returning error.
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .context("failed to set WAL pragmas")?;
    sweep_stale_version_tables(&conn)?;
    Ok(conn)
}

/// Drop any user table that doesn't end with the current `__v<N>` suffix.
/// Skips `sqlite_*` (built-in) and `_`-prefixed tables (reserved for future metadata).
/// The next `ensure_schema` call recreates the current-version tables fresh.
fn sweep_stale_version_tables(conn: &Connection) -> anyhow::Result<()> {
    let suffix = version_suffix();
    let names: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name NOT LIKE 'sqlite_%'
               AND name NOT LIKE '\\_%' ESCAPE '\\'",
        )?;
        let rows: Vec<rusqlite::Result<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        rows.into_iter().collect::<Result<_, _>>()?
    };
    for name in names {
        if name.ends_with(&suffix) {
            continue;
        }
        let quoted = name.replace('"', "\"\"");
        conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{quoted}\";"))
            .with_context(|| format!("failed to drop stale-version table {name}"))?;
    }
    Ok(())
}

fn ensure_schema(conn: &Connection, table: &str) -> anyhow::Result<()> {
    let tq = quote_ident(table);

    // Tables are versioned via `__v<N>` suffix and the sweep in `open_conn`
    // drops anything that doesn't match, so we always create at the current schema.
    // No incremental ALTER migrations — bump INDEX_SCHEMA_VERSION instead.
    // Drop the obsolete record_index tables. The per-folder tables created
    // below carry the same (folder, filename) set that record_index_v1 used to
    // hold, so cleanup_stale_results queries those directly now.
    conn.execute_batch(
        "DROP TABLE IF EXISTS record_index_v1;
         DROP TABLE IF EXISTS record_index;",
    )
    .context("failed to drop legacy record_index tables")?;

    let vr_tq = quote_ident(&validation_results_table());
    let approved_idx = quote_ident(&format!("{table}_approved_changes_idx"));
    let unapproved_idx = quote_ident(&format!("{table}_unapproved_changes_idx"));
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {tq} (
            filename                  TEXT PRIMARY KEY,
            working_mtime             INTEGER,
            working_size              INTEGER,
            dirty_mtime               INTEGER,
            dirty_size                INTEGER,
            master_mtime              INTEGER,
            master_size               INTEGER,
            approvedChanges           INTEGER NOT NULL DEFAULT 0,
            unapprovedChanges         INTEGER NOT NULL DEFAULT 0,
            parse_error               TEXT,
            has_errors                INTEGER NOT NULL DEFAULT 0,
            validated_mtime_working   INTEGER,
            validated_mtime_master    INTEGER,
            validated_mtime_validator INTEGER
        );
        CREATE INDEX IF NOT EXISTS {approved_idx} ON {tq} (filename) WHERE approvedChanges = 1;
        CREATE INDEX IF NOT EXISTS {unapproved_idx} ON {tq} (filename) WHERE unapprovedChanges = 1;
        CREATE TABLE IF NOT EXISTS {vr_tq} (
            folder_path    TEXT NOT NULL,
            filename       TEXT NOT NULL,
            field_path     TEXT NOT NULL,
            validator_kind TEXT NOT NULL,
            level          TEXT NOT NULL,
            message        TEXT,
            description    TEXT,
            fixable        INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (folder_path, filename, field_path, validator_kind)
        );"
    ))
    .context("failed to ensure schema")?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// File stat / directory scan helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Returns (mtime_nanoseconds, size_bytes) or None if the file does not exist.
fn file_mtime_size(path: &Path) -> Option<(i64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos() as i64;
    let size = meta.len() as i64;
    Some((mtime_ns, size))
}

/// Collect all `.json` filenames in `dir`. Returns an empty set if the directory
/// does not exist or cannot be read.
fn scan_json_files(dir: &Path) -> HashSet<String> {
    let mut result = HashSet::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return result;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                result.insert(name.to_string());
            }
        }
    }
    result
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON helpers
// ─────────────────────────────────────────────────────────────────────────────

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let bytes = fs::read(path).map_err(|e| format!("read error: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse error: {e}"))
}

/// Read a file and (best-effort) parse it as JSON. Returns the raw bytes in all
/// cases the file is present, plus the parsed value or a parse error message.
/// Used by the indexers so the diff bit can compare bytes while column values
/// and `parse_error` come from the parsed form.
fn read_bytes_and_json(
    path: &Path,
) -> (Option<Vec<u8>>, Option<serde_json::Value>, Option<String>) {
    if !path.exists() {
        return (None, None, None);
    }
    match fs::read(path) {
        Err(e) => (None, None, Some(format!("read error: {e}"))),
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(v) => (Some(bytes), Some(v), None),
            Err(e) => (Some(bytes), None, Some(format!("parse error: {e}"))),
        },
    }
}

/// Extract a value at a dot-separated json path (e.g. "fields.title") from a
/// parsed JSON value. Returns `None` for missing paths AND for JSON `null`, so
/// nullable fields land as SQL NULL (which sorts predictably) rather than the
/// literal string "null".
fn extract_json_field(val: &serde_json::Value, json_path: &str) -> Option<String> {
    // Convert "fields.title" → "/fields/title" for JSON Pointer.
    let pointer = format!("/{}", json_path.replace('.', "/"));
    val.pointer(&pointer).and_then(|v| match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Index refresh
// ─────────────────────────────────────────────────────────────────────────────

struct StoredRow {
    working_mtime: Option<i64>,
    working_size: Option<i64>,
    dirty_mtime: Option<i64>,
    dirty_size: Option<i64>,
    master_mtime: Option<i64>,
    master_size: Option<i64>,
}

fn load_stored_rows(conn: &Connection, table: &str) -> anyhow::Result<HashMap<String, StoredRow>> {
    let tq = quote_ident(table);
    let mut stmt = conn.prepare(&format!(
        "SELECT filename, working_mtime, working_size, dirty_mtime, dirty_size,
                master_mtime, master_size
         FROM {tq}"
    ))?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            StoredRow {
                working_mtime: row.get(1)?,
                working_size: row.get(2)?,
                dirty_mtime: row.get(3)?,
                dirty_size: row.get(4)?,
                master_mtime: row.get(5)?,
                master_size: row.get(6)?,
            },
        ))
    })?;
    let mut map = HashMap::new();
    for item in rows {
        let (name, row) = item?;
        map.insert(name, row);
    }
    Ok(map)
}

/// Returns true if a version's current stat differs from what is stored.
fn version_changed(
    current: Option<(i64, i64)>,
    stored_mt: Option<i64>,
    stored_sz: Option<i64>,
) -> bool {
    match current {
        Some((mt, sz)) => stored_mt != Some(mt) || stored_sz != Some(sz),
        None => stored_mt.is_some(), // file vanished but DB thinks it existed
    }
}

/// Refresh the index for this folder: insert new files, update stale ones,
/// delete files no longer present in any of the three directory trees.
/// All mutations are wrapped in a single BEGIN IMMEDIATE transaction.
fn refresh_index(conn: &mut Connection, paths: &FolderPaths, table: &str) -> anyhow::Result<()> {
    let working_files = scan_json_files(&paths.working);
    let dirty_files = scan_json_files(&paths.dirty);
    let master_files = scan_json_files(&paths.master);

    let all_on_disk: HashSet<String> = working_files
        .iter()
        .chain(dirty_files.iter())
        .chain(master_files.iter())
        .cloned()
        .collect();

    let stored = load_stored_rows(conn, table)?;

    let mut to_upsert: Vec<String> = Vec::new();
    let mut to_delete: Vec<String> = Vec::new();

    // Files in DB but gone from every directory → delete.
    for filename in stored.keys() {
        if !all_on_disk.contains(filename) {
            to_delete.push(filename.clone());
        }
    }

    // All on-disk files: new or stale?
    for filename in &all_on_disk {
        let working_stat = file_mtime_size(&paths.working.join(filename));
        let dirty_stat = file_mtime_size(&paths.dirty.join(filename));
        let master_stat = file_mtime_size(&paths.master.join(filename));

        match stored.get(filename) {
            None => to_upsert.push(filename.clone()),
            Some(row) => {
                if version_changed(working_stat, row.working_mtime, row.working_size)
                    || version_changed(dirty_stat, row.dirty_mtime, row.dirty_size)
                    || version_changed(master_stat, row.master_mtime, row.master_size)
                {
                    to_upsert.push(filename.clone());
                }
            }
        }
    }

    if to_upsert.is_empty() && to_delete.is_empty() {
        return Ok(());
    }

    let tq = quote_ident(table);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    for filename in &to_delete {
        tx.execute(
            &format!("DELETE FROM {tq} WHERE filename = ?1"),
            params![filename],
        )?;
    }

    for filename in &to_upsert {
        let working_path = paths.working.join(filename);
        let dirty_path = paths.dirty.join(filename);
        let master_path = paths.master.join(filename);

        let working_stat = file_mtime_size(&working_path);
        let dirty_stat = file_mtime_size(&dirty_path);
        let master_stat = file_mtime_size(&master_path);

        let mut parse_error: Option<String> = None;

        let (_working_bytes, working_json, working_err) = read_bytes_and_json(&working_path);
        if let Some(e) = working_err {
            parse_error = Some(format!("working: {e}"));
        }
        let (_dirty_bytes, dirty_json, dirty_err) = read_bytes_and_json(&dirty_path);
        if let Some(e) = dirty_err {
            if parse_error.is_none() {
                parse_error = Some(format!("dirty: {e}"));
            }
        }
        let (_master_bytes, master_json, master_err) = read_bytes_and_json(&master_path);
        if let Some(e) = master_err {
            if parse_error.is_none() {
                parse_error = Some(format!("master: {e}"));
            }
        }

        // approvedChanges/unapprovedChanges flip on presence diff (add/delete)
        // OR on semantic JSON content diff. Using `serde_json::Value` equality
        // (rather than raw bytes) means a whitespace- or key-order-only edit
        // followed by a revert correctly clears the bit even when the editor
        // doesn't reproduce the exact original byte stream.
        let approved_changes: i32 = if working_stat.is_some() != dirty_stat.is_some() {
            1
        } else {
            match (&working_json, &dirty_json) {
                (Some(w), Some(d)) => i32::from(w != d),
                _ => 0,
            }
        };
        let unapproved_changes: i32 = if dirty_stat.is_some() != master_stat.is_some() {
            1
        } else {
            match (&dirty_json, &master_json) {
                (Some(d), Some(m)) => i32::from(d != m),
                _ => 0,
            }
        };

        tx.execute(
            &format!(
                "INSERT INTO {tq} (
                    filename,
                    working_mtime, working_size,
                    dirty_mtime,   dirty_size,
                    master_mtime,  master_size,
                    approvedChanges, unapprovedChanges, parse_error
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(filename) DO UPDATE SET
                    working_mtime    = excluded.working_mtime,
                    working_size     = excluded.working_size,
                    dirty_mtime      = excluded.dirty_mtime,
                    dirty_size       = excluded.dirty_size,
                    master_mtime     = excluded.master_mtime,
                    master_size      = excluded.master_size,
                    approvedChanges  = excluded.approvedChanges,
                    unapprovedChanges= excluded.unapprovedChanges,
                    parse_error      = excluded.parse_error"
            ),
            params![
                filename,
                working_stat.map(|(m, _)| m),
                working_stat.map(|(_, s)| s),
                dirty_stat.map(|(m, _)| m),
                dirty_stat.map(|(_, s)| s),
                master_stat.map(|(m, _)| m),
                master_stat.map(|(_, s)| s),
                approved_changes,
                unapproved_changes,
                parse_error,
            ],
        )?;
    }

    tx.commit()?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// On-demand field columns
// ─────────────────────────────────────────────────────────────────────────────

/// Validate that a json path used as a column name contains only safe characters.
/// Allowed: alphanumeric, `_`, `.`, `[`, `]`, `-`.
pub fn validate_json_path(column: &str) -> anyhow::Result<()> {
    if column.is_empty() {
        anyhow::bail!("field column name cannot be empty");
    }
    for ch in column.chars() {
        if !matches!(ch, 'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '.' | '[' | ']' | '-') {
            anyhow::bail!(
                "invalid character '{ch}' in field name '{column}'; \
                 only alphanumeric, _, ., [, ], - are allowed"
            );
        }
    }
    Ok(())
}

/// Double-quote a column name for use as a SQL identifier, escaping embedded quotes.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Sanitize a column name into a valid SQL identifier suffix (for index names).
fn sanitize_for_index_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> anyhow::Result<bool> {
    let count: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = ?1",
            table.replace('\'', "''")
        ),
        params![column],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Ensure the three columns for an on-demand field exist, then refresh any stale values.
/// Create the column + :mt + :sz columns and an index if they don't already exist.
/// Does NOT populate any values — data population is handled by reindex_files_columns.
///
/// When `is_numeric` is true the value column is declared with REAL affinity, so
/// SQLite stores numeric-looking text as INTEGER/REAL and `ORDER BY` produces a
/// numeric ordering (1, 2, 10) instead of a lexical one (1, 10, 2). Existing
/// TEXT columns from older indexes are left untouched — drop the SQLite db or
/// run `--reindex` to pick up the new affinity.
fn add_field_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    is_numeric: bool,
) -> anyhow::Result<()> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    let tq = quote_ident(table);
    let col_q = quote_ident(column);
    let mt_q = quote_ident(&format!("{column}:mt"));
    let sz_q = quote_ident(&format!("{column}:sz"));
    let idx_name = format!(
        "idx_{}_{}",
        sanitize_for_index_name(table),
        sanitize_for_index_name(column)
    );
    let col_type = if is_numeric { "REAL" } else { "TEXT" };
    conn.execute_batch(&format!(
        "ALTER TABLE {tq} ADD COLUMN {col_q} {col_type};
         ALTER TABLE {tq} ADD COLUMN {mt_q} INTEGER;
         ALTER TABLE {tq} ADD COLUMN {sz_q} INTEGER;
         CREATE INDEX IF NOT EXISTS \"{idx_name}\" ON {tq} ({col_q});"
    ))
    .with_context(|| format!("failed to add on-demand column {column}"))?;
    Ok(())
}

fn ensure_field_column(
    conn: &mut Connection,
    table: &str,
    column: &str,
    working_dir: &Path,
    workspace: &Path,
    folder: &str,
) -> anyhow::Result<()> {
    validate_json_path(column)?;
    let mt_col = format!("{column}:mt");
    let sz_col = format!("{column}:sz");
    let is_numeric = folder_column_is_numeric(workspace, folder, column);
    add_field_column_if_missing(conn, table, column, is_numeric)?;
    update_stale_field_values(conn, table, column, &mt_col, &sz_col, working_dir)?;
    Ok(())
}

fn update_stale_field_values(
    conn: &mut Connection,
    table: &str,
    column: &str,
    mt_col: &str,
    sz_col: &str,
    working_dir: &Path,
) -> anyhow::Result<()> {
    let tq = quote_ident(table);
    let col_q = quote_ident(column);
    let mt_q = quote_ident(mt_col);
    let sz_q = quote_ident(sz_col);

    // Find rows whose working file exists but the field value is outdated.
    let stale_query = format!(
        "SELECT filename, working_mtime, working_size
         FROM {tq}
         WHERE working_mtime IS NOT NULL
           AND ({mt_q} IS NULL OR {mt_q} != working_mtime OR {sz_q} != working_size)"
    );
    let stale_rows: Vec<(String, i64, i64)> = {
        let mut stmt = conn.prepare(&stale_query)?;
        let rows: Vec<rusqlite::Result<(String, i64, i64)>> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect();
        rows.into_iter().collect::<Result<_, _>>()?
    };

    // Find rows where working is gone but the column still has a value.
    let null_query =
        format!("SELECT filename FROM {tq} WHERE working_mtime IS NULL AND {col_q} IS NOT NULL");
    let null_rows: Vec<String> = {
        let mut stmt = conn.prepare(&null_query)?;
        let rows: Vec<rusqlite::Result<String>> = stmt.query_map([], |row| row.get(0))?.collect();
        rows.into_iter().collect::<Result<_, _>>()?
    };

    if stale_rows.is_empty() && null_rows.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    for filename in &null_rows {
        tx.execute(
            &format!(
                "UPDATE {tq} SET {col_q} = NULL, {mt_q} = NULL, {sz_q} = NULL WHERE filename = ?1"
            ),
            params![filename],
        )?;
    }

    for (filename, mtime, size) in &stale_rows {
        let path = working_dir.join(filename);
        let value = if path.exists() {
            read_json(&path)
                .ok()
                .and_then(|json| extract_json_field(&json, column))
        } else {
            None
        };
        tx.execute(
            &format!("UPDATE {tq} SET {col_q} = ?1, {mt_q} = ?2, {sz_q} = ?3 WHERE filename = ?4"),
            params![value, mtime, size, filename],
        )?;
    }

    tx.commit()?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Query building
// ─────────────────────────────────────────────────────────────────────────────

fn build_where_clause(filters: &[FilterSpec]) -> anyhow::Result<(String, Vec<DynParam>)> {
    if filters.is_empty() {
        return Ok((String::new(), vec![]));
    }

    let mut clauses: Vec<String> = Vec::new();
    let mut bind_params: Vec<DynParam> = Vec::new();

    for filter in filters {
        match filter {
            FilterSpec::HasWorking => clauses.push("working_mtime IS NOT NULL".into()),
            FilterSpec::HasDirty => clauses.push("dirty_mtime IS NOT NULL".into()),
            FilterSpec::HasMaster => clauses.push("master_mtime IS NOT NULL".into()),
            FilterSpec::ApprovedChanges => clauses.push("approvedChanges = 1".into()),
            FilterSpec::UnapprovedChanges => clauses.push("unapprovedChanges = 1".into()),
            FilterSpec::HasErrors => clauses.push("has_errors = 1".into()),
            FilterSpec::Field { column, op, value } => {
                let col_q = quote_ident(column);
                match op {
                    FieldOp::Eq => {
                        clauses.push(format!("{col_q} = ?"));
                        bind_params.push(DynParam::Text(value.clone()));
                    }
                    FieldOp::Lt => {
                        clauses.push(format!("CAST({col_q} AS REAL) < CAST(? AS REAL)"));
                        bind_params.push(DynParam::Text(value.clone()));
                    }
                    FieldOp::Gt => {
                        clauses.push(format!("CAST({col_q} AS REAL) > CAST(? AS REAL)"));
                        bind_params.push(DynParam::Text(value.clone()));
                    }
                    FieldOp::Contains => {
                        // SQLite LIKE is case-insensitive for ASCII by default.
                        clauses.push(format!("{col_q} LIKE '%' || ? || '%'"));
                        bind_params.push(DynParam::Text(value.clone()));
                    }
                }
            }
        }
    }

    Ok((format!("WHERE {}", clauses.join(" AND ")), bind_params))
}

/// Return the SQL column name for the requested sort key, creating an on-demand
/// field column if the sort_by value is a json path.
fn resolve_sort_column(
    sort_by: &str,
    conn: &mut Connection,
    table: &str,
    working_dir: &Path,
    workspace: &Path,
    folder: &str,
) -> anyhow::Result<String> {
    match sort_by {
        "filename" | "approvedChanges" | "unapprovedChanges" => Ok(sort_by.to_string()),
        _ => {
            ensure_field_column(conn, table, sort_by, working_dir, workspace, folder)?;
            Ok(sort_by.to_string())
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query execution helpers
// ─────────────────────────────────────────────────────────────────────────────

fn query_filenames(
    conn: &Connection,
    sql: &str,
    where_params: &[DynParam],
    limit: i64,
    offset: i64,
) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;

    // Build the full param list: WHERE bindings + LIMIT + OFFSET.
    let mut all_refs: Vec<&dyn ToSql> = where_params.iter().map(|p| p as &dyn ToSql).collect();
    let limit_param = DynParam::Int(limit);
    let offset_param = DynParam::Int(offset);
    all_refs.push(&limit_param as &dyn ToSql);
    all_refs.push(&offset_param as &dyn ToSql);

    let filenames = stmt
        .query_map(all_refs.as_slice(), |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(filenames)
}

fn query_count(conn: &Connection, sql: &str, where_params: &[DynParam]) -> anyhow::Result<i64> {
    let params_ref: Vec<&dyn ToSql> = where_params.iter().map(|p| p as &dyn ToSql).collect();
    let mut stmt = conn.prepare(sql)?;
    let count: i64 = stmt.query_row(params_ref.as_slice(), |row| row.get(0))?;
    Ok(count)
}

fn query_summary(conn: &Connection, table: &str) -> anyhow::Result<FolderSummary> {
    let tq = quote_ident(table);
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {tq}"), [], |r| r.get(0))?;
    let approved_changes: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {tq} WHERE approvedChanges = 1"),
        [],
        |r| r.get(0),
    )?;
    let unapproved_changes: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {tq} WHERE unapprovedChanges = 1"),
        [],
        |r| r.get(0),
    )?;
    let working_only: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM {tq}
             WHERE working_mtime IS NOT NULL AND dirty_mtime IS NULL AND master_mtime IS NULL"
        ),
        [],
        |r| r.get(0),
    )?;
    let dirty_only: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM {tq}
             WHERE dirty_mtime IS NOT NULL AND working_mtime IS NULL AND master_mtime IS NULL"
        ),
        [],
        |r| r.get(0),
    )?;
    let master_only: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM {tq}
             WHERE master_mtime IS NOT NULL AND working_mtime IS NULL AND dirty_mtime IS NULL"
        ),
        [],
        |r| r.get(0),
    )?;

    Ok(FolderSummary {
        total,
        approved_changes,
        unapproved_changes,
        working_only,
        dirty_only,
        master_only,
    })
}

fn query_parse_errors(conn: &Connection, table: &str) -> anyhow::Result<Vec<ParseError>> {
    let tq = quote_ident(table);
    let mut stmt = conn.prepare(&format!(
        "SELECT filename, parse_error FROM {tq} WHERE parse_error IS NOT NULL ORDER BY filename",
    ))?;
    let errors = stmt
        .query_map([], |row| {
            Ok(ParseError {
                filename: row.get(0)?,
                error: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(errors)
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Returns the path to the `validation.json` file for the given folder.
/// The file lives in `.scratch/connections/scratch/<conn>/<sub_path>/validation.json`.
fn resolve_validation_json_path(workspace: &Path, folder: &str) -> PathBuf {
    let normalized = folder.trim_start_matches('/');
    let (conn_name, sub_path) = match normalized.find('/') {
        Some(idx) => (&normalized[..idx], &normalized[idx + 1..]),
        None => (normalized, ""),
    };
    let base = workspace
        .join(".scratch")
        .join("connections")
        .join("scratch")
        .join(conn_name);
    if sub_path.is_empty() {
        base.join("validation.json")
    } else {
        base.join(sub_path).join("validation.json")
    }
}

fn resolve_workspace_dir(workspace: &Path) -> PathBuf {
    workspace.join(".scratch").join("workspace")
}

struct ValidationStateRow {
    working_mtime: Option<i64>,
    master_mtime: Option<i64>,
    validated_mtime_working: Option<i64>,
    validated_mtime_master: Option<i64>,
    validated_mtime_validator: Option<i64>,
}

fn load_validation_state(
    conn: &Connection,
    table: &str,
    filenames: &[String],
) -> anyhow::Result<HashMap<String, ValidationStateRow>> {
    if filenames.is_empty() {
        return Ok(HashMap::new());
    }
    let tq = quote_ident(table);
    let placeholders = filenames.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT filename, working_mtime, master_mtime,
                validated_mtime_working, validated_mtime_master, validated_mtime_validator
         FROM {tq}
         WHERE filename IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn ToSql> = filenames.iter().map(|s| s as &dyn ToSql).collect();
    let rows = stmt
        .query_map(params_ref.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                ValidationStateRow {
                    working_mtime: row.get(1)?,
                    master_mtime: row.get(2)?,
                    validated_mtime_working: row.get(3)?,
                    validated_mtime_master: row.get(4)?,
                    validated_mtime_validator: row.get(5)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().collect())
}

fn is_validation_stale(row: &ValidationStateRow, current_validator_mtime: Option<i64>) -> bool {
    // Deleted records (no working file) are never stale — we don't validate them.
    if row.working_mtime.is_none() {
        return false;
    }
    // Never validated.
    if row.validated_mtime_working.is_none() {
        return true;
    }
    // Working file changed.
    if row.working_mtime != row.validated_mtime_working {
        return true;
    }
    // Master file changed (affects readonly validators).
    if row.master_mtime != row.validated_mtime_master {
        return true;
    }
    // Validator file changed (or appeared/disappeared).
    if current_validator_mtime != row.validated_mtime_validator {
        return true;
    }
    false
}

fn query_page_errors(
    conn: &Connection,
    folder: &str,
    filenames: &[String],
) -> anyhow::Result<HashMap<String, Vec<ValidationError>>> {
    if filenames.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = filenames.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let vr_tq = quote_ident(&validation_results_table());
    let sql = format!(
        "SELECT filename, field_path, validator_kind, level, message, description, fixable
         FROM {vr_tq}
         WHERE folder_path = ? AND filename IN ({placeholders})
         ORDER BY filename, field_path, validator_kind"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut params_ref: Vec<&dyn ToSql> = vec![&folder as &dyn ToSql];
    params_ref.extend(filenames.iter().map(|s| s as &dyn ToSql));
    let rows = stmt
        .query_map(params_ref.as_slice(), |row| {
            let filename: String = row.get(0)?;
            let err = ValidationError {
                field_path: row.get(1)?,
                validator_kind: row.get(2)?,
                level: row.get(3)?,
                message: row.get(4)?,
                description: row.get(5)?,
                fixable: row.get::<_, i64>(6).map(|v| v != 0)?,
            };
            Ok((filename, err))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut map: HashMap<String, Vec<ValidationError>> = HashMap::new();
    for (filename, error) in rows {
        map.entry(filename).or_default().push(error);
    }
    Ok(map)
}

/// Validate records on the current page whose validation state is stale.
/// Returns `(stale_count, row_errors)`:
/// - `stale_count`: number of records that were stale at the start of this call.
/// - `row_errors`: map from filename → errors for all filenames on this page.
///
/// When `validate` is false, returns (0, {}) immediately — no DB queries, no validation runs.
/// When `validate` is true, runs validators on stale records and returns errors for the full page.
fn validate_page_records(
    conn: &mut Connection,
    table: &str,
    filenames: &[String],
    paths: &FolderPaths,
    workspace: &Path,
    folder: &str,
    validate: bool,
    debug: bool,
) -> anyhow::Result<(i64, HashMap<String, Vec<ValidationError>>)> {
    if !validate {
        return Ok((0, HashMap::new()));
    }

    let tq = quote_ident(table);

    let validation_json_path = resolve_validation_json_path(workspace, folder);
    let current_validator_mtime = file_mtime_size(&validation_json_path).map(|(m, _)| m);

    let state_rows = load_validation_state(conn, table, filenames)?;

    // Classify page records into stale / not-stale.
    let mut stale_count: i64 = 0;
    let mut stale_filenames: Vec<String> = Vec::new();
    for filename in filenames {
        let stale = match state_rows.get(filename) {
            Some(row) => is_validation_stale(row, current_validator_mtime),
            // Row missing from DB — treat as stale if working file exists.
            None => paths.working.join(filename).exists(),
        };
        if stale {
            stale_count += 1;
            if validate {
                stale_filenames.push(filename.clone());
            }
        }
    }

    if validate && !stale_filenames.is_empty() {
        // Load validator config once.
        let config: Vec<ValidatorEntry> = if validation_json_path.exists() {
            let bytes = std::fs::read(&validation_json_path)
                .with_context(|| format!("failed to read {}", validation_json_path.display()))?;
            serde_json::from_slice(&bytes).unwrap_or_default()
        } else {
            vec![]
        };
        let workspace_dir = resolve_workspace_dir(workspace);
        let total = stale_filenames.len();
        let mut done = 0usize;
        let vr_tq = quote_ident(&validation_results_table());

        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        for filename in &stale_filenames {
            let working_path = paths.working.join(filename);
            let master_path = paths.master.join(filename);
            let working_stat = file_mtime_size(&working_path);
            let master_stat = file_mtime_size(&master_path);

            // Clear old errors for this record.
            tx.execute(
                &format!("DELETE FROM {vr_tq} WHERE folder_path = ?1 AND filename = ?2"),
                params![folder, filename],
            )?;

            if !working_path.exists() {
                // Deleted record — clear errors and mark validated.
                tx.execute(
                    &format!(
                        "UPDATE {tq} SET has_errors = 0, validated_mtime_working = NULL,
                         validated_mtime_master = NULL, validated_mtime_validator = ?1
                         WHERE filename = ?2"
                    ),
                    params![current_validator_mtime, filename],
                )?;
                done += 1;
                continue;
            }

            let working_json = match read_json(&working_path) {
                Ok(v) => v,
                Err(_) => {
                    // Invalid JSON — can't validate; mark with current mtimes so it's not re-tried every page.
                    tx.execute(
                        &format!(
                            "UPDATE {tq} SET validated_mtime_working = ?1,
                             validated_mtime_master = ?2, validated_mtime_validator = ?3
                             WHERE filename = ?4"
                        ),
                        params![
                            working_stat.map(|(m, _)| m),
                            master_stat.map(|(m, _)| m),
                            current_validator_mtime,
                            filename,
                        ],
                    )?;
                    done += 1;
                    continue;
                }
            };
            let master_json = if master_path.exists() {
                read_json(&master_path).ok()
            } else {
                None
            };

            let violations = if config.is_empty() {
                vec![]
            } else {
                run_validators_dry(
                    filename,
                    &working_json,
                    master_json.as_ref(),
                    None,
                    &config,
                    &workspace_dir,
                )?
            };

            let has_errors = !violations.is_empty();
            for v in &violations {
                tx.execute(
                    &format!(
                        "INSERT OR REPLACE INTO {vr_tq}
                         (folder_path, filename, field_path, validator_kind, level, message, description, fixable)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
                    ),
                    params![
                        folder,
                        filename,
                        v.field_path,
                        v.validator_kind,
                        v.level,
                        v.message,
                        v.description,
                        if v.fixable { 1i64 } else { 0i64 },
                    ],
                )?;
            }

            tx.execute(
                &format!(
                    "UPDATE {tq} SET has_errors = ?1, validated_mtime_working = ?2,
                     validated_mtime_master = ?3, validated_mtime_validator = ?4
                     WHERE filename = ?5"
                ),
                params![
                    if has_errors { 1i64 } else { 0i64 },
                    working_stat.map(|(m, _)| m),
                    master_stat.map(|(m, _)| m),
                    current_validator_mtime,
                    filename,
                ],
            )?;

            done += 1;
            if debug {
                eprintln!("[validate]   {done}/{total}");
            }
        }

        tx.commit()?;
    }

    let row_errors = query_page_errors(conn, folder, filenames)?;
    Ok((stale_count, row_errors))
}

// ─────────────────────────────────────────────────────────────────────────────
// Check-only mode (count stale without mutating)
// ─────────────────────────────────────────────────────────────────────────────

fn count_stale(conn: &Connection, paths: &FolderPaths, table: &str) -> anyhow::Result<i64> {
    let stored = load_stored_rows(conn, table)?;

    let working_files = scan_json_files(&paths.working);
    let dirty_files = scan_json_files(&paths.dirty);
    let master_files = scan_json_files(&paths.master);

    let all_on_disk: HashSet<String> = working_files
        .iter()
        .chain(dirty_files.iter())
        .chain(master_files.iter())
        .cloned()
        .collect();

    let mut stale: i64 = 0;

    for filename in &all_on_disk {
        let w = file_mtime_size(&paths.working.join(filename));
        let d = file_mtime_size(&paths.dirty.join(filename));
        let m = file_mtime_size(&paths.master.join(filename));

        match stored.get(filename) {
            None => stale += 1,
            Some(row) => {
                if version_changed(w, row.working_mtime, row.working_size)
                    || version_changed(d, row.dirty_mtime, row.dirty_size)
                    || version_changed(m, row.master_mtime, row.master_size)
                {
                    stale += 1;
                }
            }
        }
    }

    // Rows in DB that no longer exist on disk.
    for filename in stored.keys() {
        if !all_on_disk.contains(filename) {
            stale += 1;
        }
    }

    Ok(stale)
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ClearFolderIndexResult {
    pub rows_cleared: i64,
}

/// Clear the SQLite folder index for the given folder: counts current rows, then
/// atomically drops all data and dynamically-added field columns by recreating the
/// table with the core schema only. Returns the number of rows that were cleared.
pub fn clear_folder_index(
    workspace: &Path,
    folder: &str,
    db_path_override: Option<&Path>,
) -> anyhow::Result<ClearFolderIndexResult> {
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    if !db_path.exists() {
        return Ok(ClearFolderIndexResult { rows_cleared: 0 });
    }

    let mut conn = open_conn(&db_path)?;
    let table = table_name_from_folder(folder);
    let tq = quote_ident(&table);

    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![table],
        |row| row.get(0),
    )?;
    if table_exists == 0 {
        return Ok(ClearFolderIndexResult { rows_cleared: 0 });
    }

    let rows_cleared: i64 =
        conn.query_row(&format!("SELECT COUNT(*) FROM {tq}"), [], |row| row.get(0))?;

    // Rename → recreate → drop: atomically clears all data and all dynamically-added
    // field columns (including their :mt/:sz companions and indexes) in one transaction.
    let tmp = format!("{}__clrtmp", table);
    let tq_tmp = quote_ident(&tmp);
    let vr_tq = quote_ident(&validation_results_table());
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        &format!("DELETE FROM {vr_tq} WHERE folder_path = ?1"),
        params![folder],
    )
    .context("failed to clear validation_results for folder")?;
    tx.execute_batch(&format!(
        "ALTER TABLE {tq} RENAME TO {tq_tmp};
         CREATE TABLE {tq} (
             filename             TEXT PRIMARY KEY,
             working_mtime        INTEGER,
             working_size         INTEGER,
             dirty_mtime          INTEGER,
             dirty_size           INTEGER,
             master_mtime         INTEGER,
             master_size          INTEGER,
             approvedChanges      INTEGER NOT NULL DEFAULT 0,
             unapprovedChanges    INTEGER NOT NULL DEFAULT 0,
             parse_error          TEXT,
             has_errors           INTEGER NOT NULL DEFAULT 0,
             validated_mtime_working   INTEGER,
             validated_mtime_master    INTEGER,
             validated_mtime_validator INTEGER
         );
         DROP TABLE {tq_tmp};"
    ))
    .context("failed to clear folder index")?;
    tx.commit()?;

    Ok(ClearFolderIndexResult { rows_cleared })
}

const INDEX_FIELD_BATCH_SIZE: usize = 1000;

/// Populate (or refresh) the index for a single JSON-path column in a folder.
///
/// Three timed phases, all reporting to stderr:
///
/// **Phase 1 — base sync**: stat every working-tree JSON file; upsert rows for
/// files that are new or whose mtime/size changed. Does not read JSON content
/// (approvedChanges stays at its previous value; run `refresh-record-index` for
/// full correctness). Deleted files are removed from the index.
///
/// **Phase 2 — discovery**: count rows whose column value is stale or missing.
///
/// **Phase 3 — indexing**: read each stale file's JSON, extract the field, and
/// write the value in batches of `INDEX_FIELD_BATCH_SIZE`. Prints progress after
/// every batch and a final rec/s throughput figure.
/// Remove a field column (and its :mt/:sz companions) from the folder index table.
/// Returns the number of rows that had a non-NULL value in that column.
#[derive(serde::Serialize)]
pub struct ClearColumnIndexResult {
    pub column: String,
    pub rows_cleared: usize,
}

pub fn clear_column_index(
    workspace: &Path,
    folder: &str,
    column: &str,
    db_path_override: Option<&Path>,
) -> anyhow::Result<ClearColumnIndexResult> {
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    if !db_path.exists() {
        return Ok(ClearColumnIndexResult {
            column: column.to_string(),
            rows_cleared: 0,
        });
    }

    let conn = open_conn(&db_path)?;
    let table = table_name_from_folder(folder);
    ensure_schema(&conn, &table)?;

    if !column_exists(&conn, &table, column)? {
        return Ok(ClearColumnIndexResult {
            column: column.to_string(),
            rows_cleared: 0,
        });
    }

    let tq = quote_ident(&table);
    let col_q = quote_ident(column);
    let mt_col = format!("{column}:mt");
    let sz_col = format!("{column}:sz");
    let mt_q = quote_ident(&mt_col);
    let sz_q = quote_ident(&sz_col);

    // Count rows that had a value before clearing.
    let rows_cleared: usize = conn.query_row(
        &format!("SELECT COUNT(*) FROM {tq} WHERE {col_q} IS NOT NULL"),
        [],
        |row| row.get::<_, i64>(0),
    )? as usize;

    // SQLite doesn't support DROP COLUMN before 3.35.0, and even then it's limited.
    // NULL out the values instead — this frees storage and makes the column invisible
    // to the stale-detection query without requiring schema migration.
    conn.execute_batch(&format!(
        "UPDATE {tq} SET {col_q} = NULL, {mt_q} = NULL, {sz_q} = NULL;"
    ))?;

    Ok(ClearColumnIndexResult {
        column: column.to_string(),
        rows_cleared,
    })
}

pub fn index_field_with_progress(
    workspace: &Path,
    folder: &str,
    column: &str,
    db_path_override: Option<&Path>,
    debug: bool,
) -> anyhow::Result<()> {
    validate_json_path(column)?;

    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let paths = resolve_folder_paths(workspace, folder);
    let table = table_name_from_folder(folder);
    let mt_col = format!("{column}:mt");
    let sz_col = format!("{column}:sz");

    let mut conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    // ── Phase 1: base sync (stat only, no JSON read) ─────────────────────────
    if debug {
        eprintln!("[base sync]  Scanning working tree...");
    }
    let t_base = std::time::Instant::now();

    let working_files = scan_json_files(&paths.working);
    let total_on_disk = working_files.len();
    let stored = load_stored_rows(&conn, &table)?;

    let mut new_files: Vec<String> = Vec::new();
    let mut stale_files: Vec<String> = Vec::new();
    let mut to_delete: Vec<String> = Vec::new();

    for filename in stored.keys() {
        if !working_files.contains(filename) {
            to_delete.push(filename.clone());
        }
    }
    for filename in &working_files {
        let stat = file_mtime_size(&paths.working.join(filename));
        match stored.get(filename) {
            None => new_files.push(filename.clone()),
            Some(row) => {
                if version_changed(stat, row.working_mtime, row.working_size) {
                    stale_files.push(filename.clone());
                }
            }
        }
    }

    let n_new = new_files.len();
    let n_updated = stale_files.len();
    let n_deleted = to_delete.len();

    if n_new > 0 || n_updated > 0 || n_deleted > 0 {
        let tq = quote_ident(&table);
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for filename in &to_delete {
            tx.execute(
                &format!("DELETE FROM {tq} WHERE filename = ?1"),
                params![filename],
            )?;
        }
        for filename in new_files.iter().chain(stale_files.iter()) {
            let stat = file_mtime_size(&paths.working.join(filename));
            tx.execute(
                &format!(
                    "INSERT INTO {tq} (filename, working_mtime, working_size)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(filename) DO UPDATE SET
                         working_mtime = excluded.working_mtime,
                         working_size  = excluded.working_size"
                ),
                params![filename, stat.map(|(m, _)| m), stat.map(|(_, s)| s)],
            )?;
        }
        tx.commit()?;
    }

    let elapsed_base = t_base.elapsed();
    if debug {
        eprintln!(
            "[base sync]  {} files on disk | {} new, {} updated, {} deleted | took {:.2}s",
            total_on_disk,
            n_new,
            n_updated,
            n_deleted,
            elapsed_base.as_secs_f64()
        );
    }

    // ── Phase 2: discovery ────────────────────────────────────────────────────
    let t_disc = std::time::Instant::now();

    if !column_exists(&conn, &table, column)? {
        let tq = quote_ident(&table);
        let col_q = quote_ident(column);
        let mt_q = quote_ident(&mt_col);
        let sz_q = quote_ident(&sz_col);
        let idx_name = format!(
            "idx_{}_{}",
            sanitize_for_index_name(&table),
            sanitize_for_index_name(column)
        );
        let col_type = if folder_column_is_numeric(workspace, folder, column) {
            "REAL"
        } else {
            "TEXT"
        };
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(&format!(
            "ALTER TABLE {tq} ADD COLUMN {col_q} {col_type};
             ALTER TABLE {tq} ADD COLUMN {mt_q} INTEGER;
             ALTER TABLE {tq} ADD COLUMN {sz_q} INTEGER;
             CREATE INDEX IF NOT EXISTS \"{idx_name}\" ON {tq} ({col_q});"
        ))
        .with_context(|| format!("failed to add on-demand column {column}"))?;
        tx.commit()?;
    }

    let tq = quote_ident(&table);
    let col_q = quote_ident(column);
    let mt_q = quote_ident(&mt_col);
    let sz_q = quote_ident(&sz_col);

    let stale_count: usize = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM {tq}
             WHERE working_mtime IS NOT NULL
               AND ({mt_q} IS NULL OR {mt_q} != working_mtime OR {sz_q} != working_size)"
        ),
        [],
        |row| row.get::<_, i64>(0),
    )? as usize;

    let null_count: usize = conn.query_row(
        &format!("SELECT COUNT(*) FROM {tq} WHERE working_mtime IS NULL AND {col_q} IS NOT NULL"),
        [],
        |row| row.get::<_, i64>(0),
    )? as usize;

    let total_stale = stale_count + null_count;
    let elapsed_disc = t_disc.elapsed();
    if debug {
        eprintln!(
            "[discovery]  {} records need column indexing ({} stale, {} to clear) | took {:.1}ms",
            total_stale,
            stale_count,
            null_count,
            elapsed_disc.as_secs_f64() * 1000.0
        );
    }

    if total_stale == 0 {
        if debug {
            eprintln!("[done]       '{}' is fully indexed.", column);
        }
        return Ok(());
    }

    // ── Phase 3: indexing ─────────────────────────────────────────────────────
    if debug {
        eprintln!(
            "[indexing]   {} records | batch size: {}",
            total_stale, INDEX_FIELD_BATCH_SIZE
        );
    }
    let t_idx = std::time::Instant::now();

    // Null-out rows whose working file has disappeared.
    if null_count > 0 {
        let null_rows: Vec<String> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT filename FROM {tq} WHERE working_mtime IS NULL AND {col_q} IS NOT NULL"
            ))?;
            let rows: Vec<rusqlite::Result<String>> =
                stmt.query_map([], |row| row.get(0))?.collect();
            rows.into_iter().collect::<Result<_, _>>()?
        };
        let mut done = 0usize;
        for chunk in null_rows.chunks(INDEX_FIELD_BATCH_SIZE) {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for filename in chunk {
                tx.execute(
                    &format!(
                        "UPDATE {tq} SET {col_q} = NULL, {mt_q} = NULL, {sz_q} = NULL \
                         WHERE filename = ?1"
                    ),
                    params![filename],
                )?;
            }
            tx.commit()?;
            done += chunk.len();
            if debug {
                eprintln!("             {done}/{total_stale}  (clearing)");
            }
        }
    }

    // Read JSON and extract the field value for each stale row.
    let stale_rows: Vec<(String, i64, i64)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT filename, working_mtime, working_size FROM {tq}
             WHERE working_mtime IS NOT NULL
               AND ({mt_q} IS NULL OR {mt_q} != working_mtime OR {sz_q} != working_size)"
        ))?;
        let rows: Vec<rusqlite::Result<(String, i64, i64)>> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect();
        rows.into_iter().collect::<Result<_, _>>()?
    };

    let mut done = null_count;
    for chunk in stale_rows.chunks(INDEX_FIELD_BATCH_SIZE) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (filename, mtime, size) in chunk {
            let path = paths.working.join(filename);
            let value = if path.exists() {
                read_json(&path)
                    .ok()
                    .and_then(|json| extract_json_field(&json, column))
            } else {
                None
            };
            tx.execute(
                &format!(
                    "UPDATE {tq} SET {col_q} = ?1, {mt_q} = ?2, {sz_q} = ?3 \
                     WHERE filename = ?4"
                ),
                params![value, mtime, size, filename],
            )?;
        }
        tx.commit()?;
        done += chunk.len();
        if debug {
            eprintln!("             {done}/{total_stale}");
        }
    }

    let elapsed_idx = t_idx.elapsed();
    let rec_per_s = total_stale as f64 / elapsed_idx.as_secs_f64().max(0.001);
    if debug {
        eprintln!(
            "[done]       {} records indexed in {:.2}s  ({:.0} rec/s)",
            total_stale,
            elapsed_idx.as_secs_f64(),
            rec_per_s
        );
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale detection and reindex operations
// ─────────────────────────────────────────────────────────────────────────────

const CORE_COLUMNS: &[&str] = &[
    "filename",
    "working_mtime",
    "working_size",
    "dirty_mtime",
    "dirty_size",
    "master_mtime",
    "master_size",
    "approvedChanges",
    "unapprovedChanges",
    "parse_error",
    "has_errors",
    "validated_mtime_working",
    "validated_mtime_master",
    "validated_mtime_validator",
];

/// Return the base field column names (excludes core columns and :mt/:sz companions).
fn get_non_core_columns(conn: &Connection, table: &str) -> anyhow::Result<Vec<String>> {
    let core: HashSet<&str> = CORE_COLUMNS.iter().copied().collect();
    let mut stmt = conn.prepare(&format!(
        "SELECT name FROM pragma_table_info('{}')",
        table.replace('\'', "''")
    ))?;
    let rows: Vec<rusqlite::Result<String>> = stmt.query_map([], |row| row.get(0))?.collect();
    let cols: Vec<String> = rows.into_iter().collect::<Result<_, _>>()?;
    Ok(cols
        .into_iter()
        .filter(|c| !core.contains(c.as_str()) && !c.ends_with(":mt") && !c.ends_with(":sz"))
        .collect())
}

/// Scan the working tree and return filenames whose mtime/size differs from the
/// stored value, plus files on disk with no row yet, plus rows whose working
/// file has disappeared (working_mtime not null but file gone).
///
/// **Hot path** (table already has rows): working-tree only. Dirty/master changes
/// are controlled by the desktop, which calls `index rebuild-folder` explicitly after
/// any accept/reject/pull/push operation.
///
/// **Cold path** (table is empty or DB doesn't exist yet): scans all three trees
/// so the initial index is seeded completely, including dirty/master-only records.
pub fn find_stale_files(
    workspace: &Path,
    folder: &str,
    db_path_override: Option<&Path>,
) -> anyhow::Result<Vec<String>> {
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let paths = resolve_folder_paths(workspace, folder);
    let table = table_name_from_folder(folder);
    let tq = quote_ident(&table);

    if !db_path.exists() {
        // No DB file yet — seed from all three trees.
        let all: HashSet<String> = scan_json_files(&paths.working)
            .into_iter()
            .chain(scan_json_files(&paths.dirty))
            .chain(scan_json_files(&paths.master))
            .collect();
        return Ok(all.into_iter().collect());
    }

    let conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    // Empty table = cold start (e.g. run_query created the schema but hasn't indexed yet).
    // Seed from all three trees so dirty/master-only records are included.
    let row_count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {tq}"), [], |r| r.get(0))?;
    if row_count == 0 {
        let all: HashSet<String> = scan_json_files(&paths.working)
            .into_iter()
            .chain(scan_json_files(&paths.dirty))
            .chain(scan_json_files(&paths.master))
            .collect();
        return Ok(all.into_iter().collect());
    }

    let working_files = scan_json_files(&paths.working);
    let stored = load_stored_rows(&conn, &table)?;

    let mut stale: HashSet<String> = HashSet::new();

    // Working files: new or mtime changed.
    for filename in &working_files {
        let stat = file_mtime_size(&paths.working.join(filename));
        let needs_reindex = match stored.get(filename) {
            None => true,
            Some(row) => version_changed(stat, row.working_mtime, row.working_size),
        };
        if needs_reindex {
            stale.insert(filename.clone());
        }
    }
    // Rows that claim a working file but it's gone.
    for (filename, row) in &stored {
        if row.working_mtime.is_some() && !working_files.contains(filename) {
            stale.insert(filename.clone());
        }
    }
    Ok(stale.into_iter().collect())
}

/// Return filenames whose stored column value is stale relative to working_mtime.
/// If `columns` is empty, all non-core columns present in the table are checked.
pub fn find_column_stale_files(
    workspace: &Path,
    folder: &str,
    columns: &[String],
    db_path_override: Option<&Path>,
) -> anyhow::Result<Vec<String>> {
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let table = table_name_from_folder(folder);

    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    let active: Vec<String> = if columns.is_empty() {
        get_non_core_columns(&conn, &table)?
    } else {
        columns.to_vec()
    };

    if active.is_empty() {
        return Ok(vec![]);
    }

    let tq = quote_ident(&table);
    // Build WHERE: any column whose :mt differs from working_mtime
    let clauses: Vec<String> = active
        .iter()
        .map(|col| {
            let mt_q = quote_ident(&format!("{col}:mt"));
            format!("({mt_q} IS NULL OR {mt_q} != working_mtime)")
        })
        .collect();
    let where_clause = clauses.join(" OR ");

    let mut stmt = conn.prepare(&format!(
        "SELECT filename FROM {tq} WHERE working_mtime IS NOT NULL AND ({where_clause})"
    ))?;
    let rows: Vec<rusqlite::Result<String>> = stmt.query_map([], |row| row.get(0))?.collect();
    rows.into_iter()
        .collect::<Result<_, _>>()
        .map_err(Into::into)
}

/// Two non-overlapping sets of files that need reindexing.
/// - `base_stale`: working-tree mtime changed → reindex_files_full (reads all 3 versions)
/// - `column_stale`: base row is valid but active column values are stale → reindex_files_columns (working only)
#[derive(Debug, serde::Serialize)]
pub struct StaleReport {
    pub base_stale: Vec<String>,
    pub column_stale: Vec<String>,
}

/// Classify stale files into two non-overlapping sets.
/// If `columns` is empty, all active (non-core) columns in the table are checked.
pub fn find_stale(
    workspace: &Path,
    folder: &str,
    columns: &[String],
    db_path_override: Option<&Path>,
) -> anyhow::Result<StaleReport> {
    let base_stale = find_stale_files(workspace, folder, db_path_override)?;
    let base_set: HashSet<&str> = base_stale.iter().map(|s| s.as_str()).collect();
    // Exclude base_stale files from column_stale — they'll be handled by reindex_files_full.
    let column_stale = find_column_stale_files(workspace, folder, columns, db_path_override)?
        .into_iter()
        .filter(|f| !base_set.contains(f.as_str()))
        .collect();
    Ok(StaleReport {
        base_stale,
        column_stale,
    })
}

/// Return filenames where `approvedChanges = 1` — i.e. the working tree differs
/// from the dirty branch for this folder. Backed by a partial index on the bit,
/// so it's O(changed-files) on tables created with the current schema.
pub fn select_files_with_approved_changes(
    workspace: &Path,
    folder: &str,
    db_path_override: Option<&Path>,
) -> anyhow::Result<Vec<String>> {
    select_filenames_where(workspace, folder, db_path_override, "approvedChanges = 1")
}

/// Return filenames where the working+dirty state diverges from master — the set
/// of records `discard-all` needs to revert. Matches rows with either bit set
/// (`approvedChanges = 1 OR unapprovedChanges = 1`). The partial indexes cover
/// each branch of the OR.
pub fn select_files_with_local_changes(
    workspace: &Path,
    folder: &str,
    db_path_override: Option<&Path>,
) -> anyhow::Result<Vec<String>> {
    select_filenames_where(
        workspace,
        folder,
        db_path_override,
        "approvedChanges = 1 OR unapprovedChanges = 1",
    )
}

fn select_filenames_where(
    workspace: &Path,
    folder: &str,
    db_path_override: Option<&Path>,
    where_clause: &str,
) -> anyhow::Result<Vec<String>> {
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    if !db_path.exists() {
        return Ok(vec![]);
    }
    let table = table_name_from_folder(folder);
    let conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;
    let tq = quote_ident(&table);
    let mut stmt = conn.prepare(&format!("SELECT filename FROM {tq} WHERE {where_clause}"))?;
    let rows: Vec<rusqlite::Result<String>> = stmt.query_map([], |row| row.get(0))?.collect();
    rows.into_iter()
        .collect::<Result<_, _>>()
        .map_err(Into::into)
}

/// Reindex specific files: reads all three versions (working/dirty/master),
/// computes approvedChanges/unapprovedChanges, updates the base row, and
/// refreshes the value for every active field column.
/// Pass `debug = true` to print per-batch progress to stderr.
pub fn reindex_files(
    workspace: &Path,
    folder: &str,
    filenames: &[String],
    db_path_override: Option<&Path>,
    debug: bool,
) -> anyhow::Result<()> {
    if filenames.is_empty() {
        return Ok(());
    }
    // Up-front signal so callers (e.g. the desktop app) can react before the first
    // batch finishes — the per-batch progress below only fires every 1000 files.
    eprintln!("[reindex] Reindexing {} file(s)...", filenames.len());
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let paths = resolve_folder_paths(workspace, folder);
    let table = table_name_from_folder(folder);

    let mut conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    let active_cols = get_non_core_columns(&conn, &table)?;
    let tq = quote_ident(&table);
    let total = filenames.len();
    let mut done = 0usize;

    for chunk in filenames.chunks(INDEX_FIELD_BATCH_SIZE) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for filename in chunk {
            let working_path = paths.working.join(filename);
            let dirty_path = paths.dirty.join(filename);
            let master_path = paths.master.join(filename);

            let working_stat = file_mtime_size(&working_path);
            let dirty_stat = file_mtime_size(&dirty_path);
            let master_stat = file_mtime_size(&master_path);

            let mut parse_error: Option<String> = None;
            let (_working_bytes, working_json, working_err) = read_bytes_and_json(&working_path);
            if let Some(e) = working_err {
                parse_error = Some(format!("working: {e}"));
            }
            let (_dirty_bytes, dirty_json, dirty_err) = read_bytes_and_json(&dirty_path);
            if let Some(e) = dirty_err {
                if parse_error.is_none() {
                    parse_error = Some(format!("dirty: {e}"));
                }
            }
            let (_master_bytes, master_json, master_err) = read_bytes_and_json(&master_path);
            if let Some(e) = master_err {
                if parse_error.is_none() {
                    parse_error = Some(format!("master: {e}"));
                }
            }

            // Semantic JSON diff — see refresh_index for the rationale.
            let approved: i32 = if working_stat.is_some() != dirty_stat.is_some() {
                1
            } else {
                match (&working_json, &dirty_json) {
                    (Some(w), Some(d)) => i32::from(w != d),
                    _ => 0,
                }
            };
            let unapproved: i32 = if dirty_stat.is_some() != master_stat.is_some() {
                1
            } else {
                match (&dirty_json, &master_json) {
                    (Some(d), Some(m)) => i32::from(d != m),
                    _ => 0,
                }
            };

            // If the file is gone from all three trees, remove it from the index.
            if working_stat.is_none() && dirty_stat.is_none() && master_stat.is_none() {
                tx.execute(
                    &format!("DELETE FROM {tq} WHERE filename = ?1"),
                    params![filename],
                )?;
                continue;
            }

            tx.execute(
                &format!(
                    "INSERT INTO {tq} (filename,
                        working_mtime, working_size, dirty_mtime, dirty_size,
                        master_mtime, master_size, approvedChanges, unapprovedChanges, parse_error)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                     ON CONFLICT(filename) DO UPDATE SET
                        working_mtime=excluded.working_mtime, working_size=excluded.working_size,
                        dirty_mtime=excluded.dirty_mtime,   dirty_size=excluded.dirty_size,
                        master_mtime=excluded.master_mtime, master_size=excluded.master_size,
                        approvedChanges=excluded.approvedChanges,
                        unapprovedChanges=excluded.unapprovedChanges,
                        parse_error=excluded.parse_error"
                ),
                params![
                    filename,
                    working_stat.map(|(m, _)| m),
                    working_stat.map(|(_, s)| s),
                    dirty_stat.map(|(m, _)| m),
                    dirty_stat.map(|(_, s)| s),
                    master_stat.map(|(m, _)| m),
                    master_stat.map(|(_, s)| s),
                    approved,
                    unapproved,
                    parse_error,
                ],
            )?;

            if let Some(ref json) = working_json {
                for col in &active_cols {
                    let value = extract_json_field(json, col);
                    let col_q = quote_ident(col);
                    let mt_q = quote_ident(&format!("{col}:mt"));
                    let sz_q = quote_ident(&format!("{col}:sz"));
                    tx.execute(
                        &format!(
                            "UPDATE {tq} SET {col_q}=?1, {mt_q}=?2, {sz_q}=?3 WHERE filename=?4"
                        ),
                        params![
                            value,
                            working_stat.map(|(m, _)| m),
                            working_stat.map(|(_, s)| s),
                            filename
                        ],
                    )?;
                }
            }
        }
        tx.commit()?;
        done += chunk.len();
        if debug {
            eprintln!("[full] Upgrading index {done}/{total}");
        }
    }
    Ok(())
}

/// Run validators for specific files and update `has_errors` + `validation_results`.
/// Intended to be called after `reindex_files` when immediate validation feedback is needed.
pub fn validate_files(
    workspace: &Path,
    folder: &str,
    filenames: &[String],
    db_path_override: Option<&Path>,
    debug: bool,
) -> anyhow::Result<()> {
    if filenames.is_empty() {
        return Ok(());
    }
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let paths = resolve_folder_paths(workspace, folder);
    let table = table_name_from_folder(folder);
    let mut conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;
    validate_page_records(
        &mut conn, &table, filenames, &paths, workspace, folder, true, debug,
    )?;
    Ok(())
}

/// List files in the folder whose validation state is stale — i.e. either the working
/// file, master file, or `validation.json` config has changed (or appeared/disappeared)
/// since validators last ran. Mirrors `is_validation_stale`. Deleted records (no
/// working file) are excluded.
pub fn find_validation_stale_files(
    workspace: &Path,
    folder: &str,
    db_path_override: Option<&Path>,
) -> anyhow::Result<Vec<String>> {
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    if !db_path.exists() {
        return Ok(vec![]);
    }
    let validation_json_path = resolve_validation_json_path(workspace, folder);
    let current_validator_mtime = file_mtime_size(&validation_json_path).map(|(m, _)| m);

    let conn = open_conn(&db_path)?;
    let table = table_name_from_folder(folder);
    ensure_schema(&conn, &table)?;
    let tq = quote_ident(&table);

    // `IS NOT` is null-safe equality in SQLite (NULL IS NOT NULL → false).
    let sql = format!(
        "SELECT filename FROM {tq}
         WHERE working_mtime IS NOT NULL AND (
            validated_mtime_working IS NOT working_mtime
            OR validated_mtime_master IS NOT master_mtime
            OR validated_mtime_validator IS NOT ?1
         )"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<rusqlite::Result<String>> = stmt
        .query_map(params![current_validator_mtime], |row| row.get(0))?
        .collect();
    rows.into_iter()
        .collect::<Result<_, _>>()
        .map_err(Into::into)
}

/// Result of `refresh_folder`. Each field is the number of files that work was performed on.
/// `validated` is `None` when `validate = false` was passed.
#[derive(Debug, serde::Serialize)]
pub struct RefreshFolderResult {
    pub base_refreshed: usize,
    pub columns_refreshed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validated: Option<usize>,
}

/// Smart, mtime-aware refresh of one folder's index. Skips files that are already fresh.
///
/// Order of operations:
///   1. `find_stale_files` → `reindex_files` for files whose base row is stale.
///   2. `find_column_stale_files` → `reindex_files_columns` for files whose column values
///      are stale but base row is fresh (excludes files already covered by step 1).
///   3. If `validate = true`: `find_validation_stale_files` → `validate_files` for files
///      whose validation state is stale (working/master/validator config changed).
///
/// On a fully-fresh folder this is effectively a no-op.
pub fn refresh_folder(
    workspace: &Path,
    folder: &str,
    validate: bool,
    debug: bool,
) -> anyhow::Result<RefreshFolderResult> {
    let base_stale = find_stale_files(workspace, folder, None)?;
    if !base_stale.is_empty() {
        reindex_files(workspace, folder, &base_stale, None, debug)?;
    }

    let all_column_stale = find_column_stale_files(workspace, folder, &[], None)?;
    let base_set: std::collections::HashSet<&String> = base_stale.iter().collect();
    let column_only: Vec<String> = all_column_stale
        .into_iter()
        .filter(|f| !base_set.contains(f))
        .collect();
    if !column_only.is_empty() {
        reindex_files_columns(workspace, folder, &column_only, None, debug)?;
    }

    let validated = if validate {
        let stale = find_validation_stale_files(workspace, folder, None)?;
        if !stale.is_empty() {
            validate_files(workspace, folder, &stale, None, debug)?;
        }
        Some(stale.len())
    } else {
        None
    };

    Ok(RefreshFolderResult {
        base_refreshed: base_stale.len(),
        columns_refreshed: column_only.len(),
        validated,
    })
}

/// Reindex specific files using only the working-tree version.
/// Updates all active field column values (col, col:mt, col:sz) but does NOT
/// touch the base row (approvedChanges, unapprovedChanges, dirty_*, master_*).
/// Use this when the base row is known to be valid and only field values are stale.
/// Pass `debug = true` to print per-batch progress to stderr.
pub fn reindex_files_columns(
    workspace: &Path,
    folder: &str,
    filenames: &[String],
    db_path_override: Option<&Path>,
    debug: bool,
) -> anyhow::Result<()> {
    if filenames.is_empty() {
        return Ok(());
    }
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let paths = resolve_folder_paths(workspace, folder);
    let table = table_name_from_folder(folder);

    let mut conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    let active_cols = get_non_core_columns(&conn, &table)?;
    if active_cols.is_empty() {
        return Ok(());
    }

    // Up-front signal so callers (e.g. the desktop app) can react before the first
    // batch finishes — the per-batch progress below only fires every 1000 files.
    eprintln!(
        "[reindex] Reindexing {} column value(s)...",
        filenames.len()
    );

    let tq = quote_ident(&table);
    let total = filenames.len();
    let mut done = 0usize;

    for chunk in filenames.chunks(INDEX_FIELD_BATCH_SIZE) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for filename in chunk {
            let working_path = paths.working.join(filename);
            let stat = file_mtime_size(&working_path);
            let json = if working_path.exists() {
                read_json(&working_path).ok()
            } else {
                None
            };
            for col in &active_cols {
                let col_q = quote_ident(col);
                let mt_q = quote_ident(&format!("{col}:mt"));
                let sz_q = quote_ident(&format!("{col}:sz"));
                let value = json.as_ref().and_then(|j| extract_json_field(j, col));
                tx.execute(
                    &format!("UPDATE {tq} SET {col_q}=?1, {mt_q}=?2, {sz_q}=?3 WHERE filename=?4"),
                    params![value, stat.map(|(m, _)| m), stat.map(|(_, s)| s), filename],
                )?;
            }
        }
        tx.commit()?;
        done += chunk.len();
        if debug {
            eprintln!("Indexing columns {done}/{total}");
        }
    }
    Ok(())
}

/// Drop all rows from the folder's table (preserving column structure), rebuild
/// every row from the three filesystem versions, and repopulate all active field
/// columns. Returns the number of rows written.
pub fn reindex_table(
    workspace: &Path,
    folder: &str,
    db_path_override: Option<&Path>,
    debug: bool,
) -> anyhow::Result<usize> {
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let paths = resolve_folder_paths(workspace, folder);
    let table = table_name_from_folder(folder);

    let mut conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    // Clear stale validation results for this folder so they don't linger after a full rebuild.
    let vr_tq = quote_ident(&validation_results_table());
    conn.execute(
        &format!("DELETE FROM {vr_tq} WHERE folder_path = ?1"),
        rusqlite::params![folder],
    )
    .context("failed to clear validation_results before reindex")?;

    // Capture active field columns before clearing rows.
    let active_cols = get_non_core_columns(&conn, &table)?;

    // Delete all rows (keep table structure + field columns).
    let tq = quote_ident(&table);
    conn.execute_batch(&format!("DELETE FROM {tq};"))
        .context("failed to clear rows before reindex")?;

    // Rebuild base rows from all three versions (reads JSON for approvedChanges).
    if debug {
        eprintln!("[reindex]    rebuilding base rows (all 3 versions)...");
    }
    refresh_index(&mut conn, &paths, &table)?;
    if debug {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {tq}"), [], |r| r.get(0))?;
        eprintln!("[reindex]    {n} base rows written");
    }

    // Repopulate each field column for all newly inserted rows.
    for col in &active_cols {
        if debug {
            eprintln!("[reindex]    indexing column '{col}'...");
        }
        let mt_col = format!("{col}:mt");
        let sz_col = format!("{col}:sz");
        update_stale_field_values(&mut conn, &table, col, &mt_col, &sz_col, &paths.working)?;
        if debug {
            eprintln!("[reindex]    column '{col}' done");
        }
    }

    let count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {tq}"), [], |row| row.get(0))?;
    Ok(count as usize)
}

// ─────────────────────────────────────────────────────────────────────────────

pub fn run_query(opts: &QueryOptions) -> anyhow::Result<ReadRecordsResult> {
    let db_path = resolve_db_path(
        &opts.workspace,
        &opts.folder,
        opts.db_path_override.as_deref(),
    );
    let paths = resolve_folder_paths(&opts.workspace, &opts.folder);
    let table = table_name_from_folder(&opts.folder);
    let tq = quote_ident(&table);

    let mut conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    if opts.reindex {
        // Full rebuild: drop all rows and rebuild from all three versions.
        drop(conn);
        reindex_table(
            &opts.workspace,
            &opts.folder,
            opts.db_path_override.as_deref(),
            opts.debug,
        )?;
        conn = open_conn(&db_path)?;
        ensure_schema(&conn, &table)?;
    } else {
        // 1. Ensure sort/filter columns exist (schema only — no data population).
        let sort_col_name = match opts.sort_by.as_str() {
            "filename" | "approvedChanges" | "unapprovedChanges" => None,
            col => Some(col),
        };
        if let Some(col) = sort_col_name {
            validate_json_path(col)?;
            let is_numeric = folder_column_is_numeric(&opts.workspace, &opts.folder, col);
            add_field_column_if_missing(&conn, &table, col, is_numeric)?;
        }
        for filter in &opts.filters {
            if let FilterSpec::Field { column, .. } = filter {
                validate_json_path(column)?;
                let is_numeric = folder_column_is_numeric(&opts.workspace, &opts.folder, column);
                add_field_column_if_missing(&conn, &table, column, is_numeric)?;
            }
        }

        // 2. Classify stale files into two non-overlapping sets.
        let report = find_stale(
            &opts.workspace,
            &opts.folder,
            &[],
            opts.db_path_override.as_deref(),
        )?;

        // 3. Full reindex for files whose working mtime changed (reads all 3 versions).
        if !report.base_stale.is_empty() {
            drop(conn);
            reindex_files(
                &opts.workspace,
                &opts.folder,
                &report.base_stale,
                opts.db_path_override.as_deref(),
                opts.debug,
            )?;
            conn = open_conn(&db_path)?;
            ensure_schema(&conn, &table)?;
        }

        // 4. Column-only reindex for files with stale field values (working JSON only).
        if !report.column_stale.is_empty() {
            drop(conn);
            reindex_files_columns(
                &opts.workspace,
                &opts.folder,
                &report.column_stale,
                opts.db_path_override.as_deref(),
                opts.debug,
            )?;
            conn = open_conn(&db_path)?;
            ensure_schema(&conn, &table)?;
        }
    }

    let sort_col = resolve_sort_column(
        &opts.sort_by,
        &mut conn,
        &table,
        &paths.working,
        &opts.workspace,
        &opts.folder,
    )?;

    let (where_clause, where_params) = build_where_clause(&opts.filters)?;
    let order_str = match opts.sort_order {
        SortOrder::Asc => "ASC",
        SortOrder::Desc => "DESC",
    };

    let data_sql = format!(
        "SELECT filename FROM {tq} {} ORDER BY {} {} LIMIT ? OFFSET ?",
        where_clause,
        quote_ident(&sort_col),
        order_str,
    );
    let count_sql = format!("SELECT COUNT(*) FROM {tq} {}", where_clause);

    let filenames = query_filenames(&conn, &data_sql, &where_params, opts.limit, opts.offset)?;
    let filtered_total = query_count(&conn, &count_sql, &where_params)?;
    let summary = query_summary(&conn, &table)?;
    let parse_errors = query_parse_errors(&conn, &table)?;

    let (stale_count, row_errors) = validate_page_records(
        &mut conn,
        &table,
        &filenames,
        &paths,
        &opts.workspace,
        &opts.folder,
        opts.validate,
        opts.debug,
    )?;

    // Total records with errors across the whole table (not just this page).
    let total_error_count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {tq} WHERE has_errors = 1"),
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Total records with stale validation across the whole table. Only computed when validate=true.
    let total_validation_stale_count: i64 = if opts.validate {
        let validation_json_path = resolve_validation_json_path(&opts.workspace, &opts.folder);
        let current_validator_mtime: i64 = file_mtime_size(&validation_json_path)
            .map(|(m, _)| m)
            .unwrap_or(-1);
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM {tq} WHERE \
                 validated_mtime_working IS NULL \
                 OR working_mtime != validated_mtime_working \
                 OR master_mtime != validated_mtime_master \
                 OR COALESCE(validated_mtime_validator, -1) != ?1"
            ),
            rusqlite::params![current_validator_mtime],
            |r| r.get(0),
        )
        .unwrap_or(0)
    } else {
        0
    };

    Ok(ReadRecordsResult {
        filenames,
        filtered_total,
        summary,
        parse_errors,
        stale_count,
        row_errors,
        total_error_count,
        total_problems_stale_count: total_validation_stale_count,
    })
}

pub fn run_check(opts: &QueryOptions) -> anyhow::Result<CheckResult> {
    let db_path = resolve_db_path(
        &opts.workspace,
        &opts.folder,
        opts.db_path_override.as_deref(),
    );
    let paths = resolve_folder_paths(&opts.workspace, &opts.folder);
    let table = table_name_from_folder(&opts.folder);
    let tq = quote_ident(&table);

    let conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {tq}"), [], |r| r.get(0))?;
    let stale = count_stale(&conn, &paths, &table)?;

    Ok(CheckResult { stale, total })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_workspace(tmp: &TempDir) -> PathBuf {
        tmp.path().to_path_buf()
    }

    fn write_json(dir: &Path, filename: &str, content: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(filename), content).unwrap();
    }

    fn opts(workspace: &Path, folder: &str) -> QueryOptions {
        QueryOptions {
            workspace: workspace.to_path_buf(),
            folder: folder.to_string(),
            offset: 0,
            limit: 100,
            sort_by: "filename".to_string(),
            sort_order: SortOrder::Asc,
            filters: vec![],
            db_path_override: None,
            reindex: false,
            debug: false,
            validate: false,
        }
    }

    #[test]
    fn test_empty_folder_returns_empty_success() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.filenames, Vec::<String>::new());
        assert_eq!(result.filtered_total, 0);
        assert_eq!(result.summary.total, 0);
        assert!(result.parse_errors.is_empty());
    }

    #[test]
    fn test_working_only_file_appears() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(
            &ws.join("conn").join("posts"),
            "rec1.json",
            r#"{"title":"hello"}"#,
        );

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.filenames, vec!["rec1.json"]);
        assert_eq!(result.summary.total, 1);
        assert_eq!(result.summary.working_only, 1);
        // working present + dirty absent flips approvedChanges (the file is a
        // pending local addition).
        assert_eq!(result.summary.approved_changes, 1);
        assert!(result.parse_errors.is_empty());
    }

    #[test]
    fn test_approved_changes_flag() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "rec1.json", r#"{"title":"new"}"#);
        write_json(&dirty_dir, "rec1.json", r#"{"title":"old"}"#);

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.summary.approved_changes, 1);
        // dirty present + master absent flips unapprovedChanges (the record exists
        // in the accepted branch but not yet in the published one).
        assert_eq!(result.summary.unapproved_changes, 1);
    }

    #[test]
    fn test_unapproved_changes_flag() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");
        let master_dir = ws
            .join(".scratch")
            .join("connections")
            .join("master")
            .join("conn")
            .join("posts");

        write_json(&dirty_dir, "rec1.json", r#"{"title":"draft"}"#);
        write_json(&master_dir, "rec1.json", r#"{"title":"published"}"#);

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.summary.unapproved_changes, 1);
    }

    #[test]
    fn test_malformed_json_in_parse_errors() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(&ws.join("conn").join("posts"), "bad.json", "not json!!");

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.filenames, vec!["bad.json"]);
        assert_eq!(result.parse_errors.len(), 1);
        assert_eq!(result.parse_errors[0].filename, "bad.json");
    }

    #[test]
    fn test_filter_approved_changes() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "changed.json", r#"{"title":"v2"}"#);
        write_json(&dirty_dir, "changed.json", r#"{"title":"v1"}"#);
        write_json(&working_dir, "same.json", r#"{"title":"v1"}"#);
        write_json(&dirty_dir, "same.json", r#"{"title":"v1"}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::ApprovedChanges];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["changed.json"]);
        assert_eq!(result.filtered_total, 1);
    }

    #[test]
    fn test_on_demand_field_column() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(&working_dir, "a.json", r#"{"fields":{"title":"banana"}}"#);
        write_json(&working_dir, "b.json", r#"{"fields":{"title":"apple"}}"#);

        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "fields.title".to_string();
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["b.json", "a.json"]); // apple < banana
    }

    /// When schema.json declares a field as `"type": "number"`, the index column
    /// must use REAL affinity so sorting produces 1, 2, 10 rather than the lexical
    /// 1, 10, 2.
    #[test]
    fn test_numeric_field_sorts_numerically() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let schema_dir = ws
            .join(".scratch")
            .join("connections")
            .join("scratch")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "a.json", r#"{"fields":{"price":10}}"#);
        write_json(&working_dir, "b.json", r#"{"fields":{"price":2}}"#);
        write_json(&working_dir, "c.json", r#"{"fields":{"price":1}}"#);
        write_json(
            &schema_dir,
            "schema.json",
            r#"{"schema":{"properties":{"fields":{"properties":{"price":{"type":"number"}}}}}}"#,
        );

        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "fields.price".to_string();
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["c.json", "b.json", "a.json"]); // 1 < 2 < 10
    }

    /// Same as above but with the nullable form `anyOf: [{number}, {null}]`.
    /// JSON null values must land as SQL NULL (sorting first in ASC) — not as
    /// the literal string "null".
    #[test]
    fn test_nullable_numeric_field_sorts_numerically() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let schema_dir = ws
            .join(".scratch")
            .join("connections")
            .join("scratch")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "a.json", r#"{"fields":{"price":10}}"#);
        write_json(&working_dir, "b.json", r#"{"fields":{"price":null}}"#);
        write_json(&working_dir, "c.json", r#"{"fields":{"price":2}}"#);
        write_json(
            &schema_dir,
            "schema.json",
            r#"{"schema":{"properties":{"fields":{"properties":{"price":{"anyOf":[{"type":"number"},{"type":"null"}]}}}}}}"#,
        );

        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "fields.price".to_string();
        let result = run_query(&o).unwrap();
        // NULL first, then 2, then 10
        assert_eq!(result.filenames, vec!["b.json", "c.json", "a.json"]);
    }

    /// Sanity check: without a schema.json the column stays TEXT and sorts lexically.
    /// Documents the fallback behavior so a future schema-format change doesn't
    /// silently regress non-schema folders.
    #[test]
    fn test_no_schema_falls_back_to_text_sort() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(&working_dir, "a.json", r#"{"fields":{"price":10}}"#);
        write_json(&working_dir, "b.json", r#"{"fields":{"price":2}}"#);
        write_json(&working_dir, "c.json", r#"{"fields":{"price":1}}"#);

        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "fields.price".to_string();
        let result = run_query(&o).unwrap();
        // Lexical: "1" < "10" < "2"
        assert_eq!(result.filenames, vec!["c.json", "a.json", "b.json"]);
    }

    /// Pre-existing tables without the `__v<N>` suffix (legacy DBs) must be
    /// dropped on `open_conn`. The next query rebuilds at the current version.
    #[test]
    fn test_sweep_drops_stale_version_tables() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        write_json(&working_dir, "a.json", r#"{"title":"hello"}"#);

        // Pre-create a legacy DB with an unversioned `validation_results` (missing
        // `folder_path` so it would normally explode) plus a stray legacy data table.
        let db_path = ws.join(".repos").join("conn.db");
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let legacy = rusqlite::Connection::open(&db_path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE validation_results (
                     filename TEXT,
                     field_path TEXT,
                     validator_kind TEXT,
                     message TEXT
                 );
                 CREATE TABLE posts (filename TEXT PRIMARY KEY, junk TEXT);
                 INSERT INTO posts (filename, junk) VALUES ('a.json', 'stale');",
            )
            .unwrap();
        drop(legacy);

        // Running a query triggers open_conn → sweep → fresh ensure_schema.
        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.filenames, vec!["a.json"]);

        // The legacy tables must be gone; only current-version tables remain.
        let suffix = version_suffix();
        let verify = rusqlite::Connection::open(&db_path).unwrap();
        let table_names: Vec<String> = verify
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for name in &table_names {
            assert!(
                name.ends_with(&suffix),
                "found stale-version table after sweep: {name}"
            );
        }
        // And the new versioned validation_results table exists.
        let expected_vr = format!("validation_results{suffix}");
        assert!(table_names.iter().any(|n| n == &expected_vr));
    }

    #[test]
    fn test_field_filter_eq() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(&working_dir, "pub.json", r#"{"status":"published"}"#);
        write_json(&working_dir, "dra.json", r#"{"status":"draft"}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::Field {
            column: "status".to_string(),
            op: FieldOp::Eq,
            value: "published".to_string(),
        }];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["pub.json"]);
    }

    #[test]
    fn test_reindex_clears_and_rebuilds() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        write_json(&working_dir, "rec1.json", r#"{"title":"hello"}"#);

        let _ = run_query(&opts(&ws, "conn/posts")).unwrap();

        // Delete file, then reindex
        fs::remove_file(working_dir.join("rec1.json")).unwrap();
        let mut o = opts(&ws, "conn/posts");
        o.reindex = true;
        let result = run_query(&o).unwrap();
        assert_eq!(result.summary.total, 0);
    }

    #[test]
    fn test_check_mode() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        write_json(&working_dir, "rec1.json", r#"{"title":"hello"}"#);

        // First check: nothing indexed yet → 1 stale.
        let o = opts(&ws, "conn/posts");
        let check = run_check(&o).unwrap();
        assert_eq!(check.stale, 1);
        assert_eq!(check.total, 0);

        // After indexing, warm check → 0 stale.
        let _ = run_query(&o).unwrap();
        let check2 = run_check(&o).unwrap();
        assert_eq!(check2.stale, 0);
        assert_eq!(check2.total, 1);
    }

    #[test]
    fn test_validate_json_path_rejects_dangerous_chars() {
        assert!(validate_json_path("fields.title").is_ok());
        assert!(validate_json_path("fields[0].name").is_ok());
        assert!(validate_json_path("a-b").is_ok());
        assert!(validate_json_path("fields\"; DROP TABLE records;--").is_err());
        assert!(validate_json_path("").is_err());
    }

    #[test]
    fn test_leading_slash_folder_normalized() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(&ws.join("conn").join("posts"), "rec1.json", r#"{"x":1}"#);

        // Both with and without leading slash should find the same file.
        let r1 = run_query(&opts(&ws, "conn/posts")).unwrap();
        let r2 = run_query(&opts(&ws, "/conn/posts")).unwrap();
        assert_eq!(r1.filenames, r2.filenames);
    }

    #[test]
    fn test_db_path_override() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let db = tmp.path().join("custom.db");

        let mut o = opts(&ws, "conn/posts");
        o.db_path_override = Some(db.clone());
        let _ = run_query(&o).unwrap();
        assert!(db.exists());
    }

    // ── Pagination ──────────────────────────────────────────────────────────

    #[test]
    fn test_pagination_offset_limit() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dir = ws.join("conn").join("posts");
        for i in 1..=5u8 {
            write_json(&dir, &format!("rec{i}.json"), r#"{"x":1}"#);
        }

        // Page 1: first 2
        let mut o = opts(&ws, "conn/posts");
        o.limit = 2;
        o.offset = 0;
        let r1 = run_query(&o).unwrap();
        assert_eq!(r1.filenames.len(), 2);
        assert_eq!(r1.filtered_total, 5);

        // Page 2: next 2
        o.offset = 2;
        let r2 = run_query(&o).unwrap();
        assert_eq!(r2.filenames.len(), 2);

        // Page 3: last 1
        o.offset = 4;
        let r3 = run_query(&o).unwrap();
        assert_eq!(r3.filenames.len(), 1);

        // Pages don't overlap
        let all: Vec<_> = r1
            .filenames
            .iter()
            .chain(r2.filenames.iter())
            .chain(r3.filenames.iter())
            .cloned()
            .collect();
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), 5);
    }

    #[test]
    fn test_sort_order_desc() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dir = ws.join("conn").join("posts");
        write_json(&dir, "a.json", r#"{"x":1}"#);
        write_json(&dir, "b.json", r#"{"x":1}"#);
        write_json(&dir, "c.json", r#"{"x":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.sort_order = SortOrder::Desc;
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["c.json", "b.json", "a.json"]);
    }

    // ── Presence filters ─────────────────────────────────────────────────────

    #[test]
    fn test_filter_has_working() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "in_working.json", r#"{"x":1}"#);
        write_json(&dirty_dir, "dirty_only.json", r#"{"x":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::HasWorking];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["in_working.json"]);
        assert_eq!(result.filtered_total, 1);
    }

    #[test]
    fn test_filter_has_dirty() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "working_only.json", r#"{"x":1}"#);
        write_json(&dirty_dir, "has_dirty.json", r#"{"x":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::HasDirty];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["has_dirty.json"]);
    }

    #[test]
    fn test_filter_has_master() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let master_dir = ws
            .join(".scratch")
            .join("connections")
            .join("master")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "no_master.json", r#"{"x":1}"#);
        write_json(&master_dir, "has_master.json", r#"{"x":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::HasMaster];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["has_master.json"]);
    }

    #[test]
    fn test_filter_unapproved_changes() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");
        let master_dir = ws
            .join(".scratch")
            .join("connections")
            .join("master")
            .join("conn")
            .join("posts");

        // dirty != master → unapproved
        write_json(&dirty_dir, "pending.json", r#"{"v":2}"#);
        write_json(&master_dir, "pending.json", r#"{"v":1}"#);
        // dirty == master → not unapproved
        write_json(&dirty_dir, "clean.json", r#"{"v":1}"#);
        write_json(&master_dir, "clean.json", r#"{"v":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::UnapprovedChanges];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["pending.json"]);
    }

    // ── Field filters (contains / lt / gt) ───────────────────────────────────

    #[test]
    fn test_field_filter_contains() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dir = ws.join("conn").join("posts");
        write_json(&dir, "rust_post.json", r#"{"title":"Rust tips"}"#);
        write_json(&dir, "go_post.json", r#"{"title":"Go concurrency"}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::Field {
            column: "title".to_string(),
            op: FieldOp::Contains,
            value: "Rust".to_string(),
        }];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["rust_post.json"]);
    }

    #[test]
    fn test_field_filter_lt_gt() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dir = ws.join("conn").join("posts");
        write_json(&dir, "low.json", r#"{"score":"10"}"#);
        write_json(&dir, "mid.json", r#"{"score":"50"}"#);
        write_json(&dir, "high.json", r#"{"score":"90"}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::Field {
            column: "score".to_string(),
            op: FieldOp::Gt,
            value: "10".to_string(),
        }];
        let result = run_query(&o).unwrap();
        assert!(result.filenames.contains(&"mid.json".to_string()));
        assert!(result.filenames.contains(&"high.json".to_string()));
        assert!(!result.filenames.contains(&"low.json".to_string()));

        // Lt
        o.filters = vec![FilterSpec::Field {
            column: "score".to_string(),
            op: FieldOp::Lt,
            value: "90".to_string(),
        }];
        let result2 = run_query(&o).unwrap();
        assert!(result2.filenames.contains(&"low.json".to_string()));
        assert!(result2.filenames.contains(&"mid.json".to_string()));
        assert!(!result2.filenames.contains(&"high.json".to_string()));
    }

    // ── Combined filters (AND semantics) ─────────────────────────────────────

    #[test]
    fn test_combined_filters_and_semantics() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        // approved change AND status=published
        write_json(
            &working_dir,
            "pub_changed.json",
            r#"{"status":"published"}"#,
        );
        write_json(&dirty_dir, "pub_changed.json", r#"{"status":"draft"}"#);

        // approved change BUT status=draft
        write_json(&working_dir, "draft_changed.json", r#"{"status":"draft"}"#);
        write_json(&dirty_dir, "draft_changed.json", r#"{"status":"old"}"#);

        // status=published but no change
        write_json(&working_dir, "pub_clean.json", r#"{"status":"published"}"#);
        write_json(&dirty_dir, "pub_clean.json", r#"{"status":"published"}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![
            FilterSpec::ApprovedChanges,
            FilterSpec::Field {
                column: "status".to_string(),
                op: FieldOp::Eq,
                value: "published".to_string(),
            },
        ];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["pub_changed.json"]);
    }

    // ── Summary bucket counts ─────────────────────────────────────────────────

    #[test]
    fn test_summary_master_only() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let master_dir = ws
            .join(".scratch")
            .join("connections")
            .join("master")
            .join("conn")
            .join("posts");

        write_json(&master_dir, "deleted.json", r#"{"x":1}"#);

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.summary.master_only, 1);
        assert_eq!(result.summary.working_only, 0);
        assert_eq!(result.summary.dirty_only, 0);
        assert_eq!(result.summary.total, 1);
    }

    #[test]
    fn test_summary_dirty_only() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&dirty_dir, "review_only.json", r#"{"x":1}"#);

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.summary.dirty_only, 1);
        assert_eq!(result.summary.total, 1);
    }

    // ── Incremental updates ───────────────────────────────────────────────────

    #[test]
    fn test_file_content_change_updates_index() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        // Initial: working == dirty → no approved change
        write_json(&working_dir, "rec.json", r#"{"title":"same"}"#);
        write_json(&dirty_dir, "rec.json", r#"{"title":"same"}"#);

        let r1 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r1.summary.approved_changes, 0);

        // Simulate edit: working diverges from dirty
        // Sleep briefly to ensure mtime changes on systems with 1-second resolution
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_json(&working_dir, "rec.json", r#"{"title":"edited"}"#);

        let r2 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r2.summary.approved_changes, 1);
    }

    #[test]
    fn test_deleted_file_removed_from_index() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        write_json(&working_dir, "gone.json", r#"{"x":1}"#);
        write_json(&working_dir, "stays.json", r#"{"x":2}"#);

        let r1 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r1.summary.total, 2);

        fs::remove_file(working_dir.join("gone.json")).unwrap();

        let r2 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r2.summary.total, 1);
        assert!(!r2.filenames.contains(&"gone.json".to_string()));
    }

    // ── File-type filtering ───────────────────────────────────────────────────

    #[test]
    fn test_non_json_files_ignored() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dir = ws.join("conn").join("posts");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("readme.md"), "# hello").unwrap();
        fs::write(dir.join("image.png"), b"\x89PNG").unwrap();
        write_json(&dir, "real.json", r#"{"x":1}"#);

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.filenames, vec!["real.json"]);
        assert_eq!(result.summary.total, 1);
    }

    // ── Nested sub-folder ────────────────────────────────────────────────────

    #[test]
    fn test_nested_subfolder() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        // Folder at conn/blog/en
        let dir = ws.join("conn").join("blog").join("en");
        write_json(&dir, "post.json", r#"{"lang":"en"}"#);

        let result = run_query(&opts(&ws, "conn/blog/en")).unwrap();
        assert_eq!(result.filenames, vec!["post.json"]);

        // DB lives at .repos/<conn-name>.db with table "blog_en"
        let db_path = ws.join(".repos").join("conn.db");
        assert!(db_path.exists());
    }

    // ── NULL / missing field sort ─────────────────────────────────────────────

    #[test]
    fn test_sort_by_field_missing_in_some_records() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dir = ws.join("conn").join("posts");
        write_json(&dir, "has_score.json", r#"{"score":"5"}"#);
        write_json(&dir, "no_score.json", r#"{"title":"no score here"}"#);

        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "score".to_string();
        // Should not error — NULLs sort last in SQLite ASC
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames.len(), 2);
        // SQLite sorts NULLs first in ASC order
        assert_eq!(result.filenames[0], "no_score.json");
        assert_eq!(result.filenames[1], "has_score.json");
    }

    // ── Idempotency ───────────────────────────────────────────────────────────

    #[test]
    fn test_identical_file_content_no_change_to_flags() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let dirty_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "rec.json", r#"{"a":1}"#);
        write_json(&dirty_dir, "rec.json", r#"{"a":1}"#);

        // Run twice — second run reads from index without changing flags
        let r1 = run_query(&opts(&ws, "conn/posts")).unwrap();
        let r2 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r1.summary.approved_changes, r2.summary.approved_changes);
        assert_eq!(r1.summary.unapproved_changes, r2.summary.unapproved_changes);
    }

    // ── Field column staleness ────────────────────────────────────────────────

    #[test]
    fn test_field_column_updates_when_file_changes() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let dir = ws.join("conn").join("posts");
        write_json(&dir, "rec.json", r#"{"status":"draft"}"#);

        // Prime the index with a field sort (creates the on-demand column)
        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "status".to_string();
        let r1 = run_query(&o).unwrap();
        assert_eq!(r1.filenames, vec!["rec.json"]);

        // Mutate the field, then query again — column value must update
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_json(&dir, "rec.json", r#"{"status":"published"}"#);

        o.filters = vec![FilterSpec::Field {
            column: "status".to_string(),
            op: FieldOp::Eq,
            value: "published".to_string(),
        }];
        let r2 = run_query(&o).unwrap();
        assert_eq!(r2.filenames, vec!["rec.json"]);
    }
}
