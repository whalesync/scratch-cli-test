#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Context;
use rusqlite::{params, types::ToSql, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::shared::validators::{run_validators_dry, ValidatorEntry};

// ─────────────────────────────────────────────────────────────────────────────
// Schema versioning
// ─────────────────────────────────────────────────────────────────────────────

/// Bumped whenever any `CREATE TABLE` definition in this file changes.
/// Tables are physically named with the `__v<N>` suffix; on version change the
/// sweep in `open_conn` drops everything that doesn't match, and the next
/// pagination request rebuilds cold from the JSON files on disk. The index is
/// derivative — JSON is authoritative — so cold rebuild is always safe.
const INDEX_SCHEMA_VERSION: u32 = 4;

fn version_suffix() -> String {
    format!("__v{INDEX_SCHEMA_VERSION}")
}

/// Versioned name for the shared validation_results table.
pub fn validation_results_table() -> String {
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
    /// Records with any pending change: approved-not-yet-published OR
    /// unreviewed working-tree edits — i.e. `approvedChanges = 1 OR
    /// unapprovedChanges = 1`. Powers the review surface's "Pending" pill.
    Pending,
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
    /// Path has a patch entry in `accepted-patches.json` (approved ≠ published).
    pub approved_changes: i64,
    /// Working file differs from `apply(refs/heads/main blob, patch_entry_or_empty)`.
    pub unapproved_changes: i64,
    /// Records with any pending change (`approvedChanges = 1 OR unapprovedChanges
    /// = 1`) — the de-duplicated union of the two counts above.
    pub pending_changes: i64,
    /// Row-status bucket counts, computed from `(working_mtime, master_present,
    /// accepted_kind, unapprovedChanges, parse_error)` — see `query_summary` for
    /// the CASE discriminator. Mirrors the desktop's `DiffGridSummary` shape so
    /// V2 can adopt full-folder counts without per-row work.
    ///
    /// `added` includes both "working differs from approved on a new record"
    /// AND "approved-deleted but the working file still exists" (matches the
    /// TS `compareRecordSnapshots` 'added' branch where approved is null).
    pub added: i64,
    /// Subset of "new records" where working == approved (= a `Create` patch
    /// whose content matches the working file). Counts the row as still under
    /// `added` so totals don't double-count.
    pub added_approved: i64,
    pub modified: i64,
    pub unpublished: i64,
    /// Working file missing while approved is non-null (working-tree deletion
    /// the user hasn't accepted yet) — counts include `deleted_approved` rows.
    pub deleted: i64,
    /// Subset of `deleted` rows where a `Delete` patch entry already exists
    /// (= approved-deleted, pending publish).
    pub deleted_approved: i64,
    /// Working JSON failed to parse. The TS-side V1 path also flagged invalid
    /// approved/published; SQL only tracks `parse_error` for the working file,
    /// so this is a slight undercount for the rare case where main carries
    /// invalid JSON. Practical workloads only hit invalid JSON on the working
    /// side (user editing).
    pub invalid_json: i64,
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
// Accepted-patches index (Phase 5 / Slice E)
// ─────────────────────────────────────────────────────────────────────────────

/// Kind of patch entry in `accepted-patches.json`. Matches the wire format
/// (lowercase enum names in serde) of `cli::commands::re_anchor::PatchKind`.
/// folder_index keeps its own copy rather than importing the cli/ type so
/// shared/ doesn't take a dependency on cli/.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcceptedKind {
    Create,
    Update,
    Delete,
}

#[derive(Debug)]
struct AcceptedEntry {
    kind: AcceptedKind,
    patch: serde_json::Value,
}

/// Snapshot of `accepted-patches.json` for one connection, keyed by
/// repo-relative path. `patch_mtime` is the file's mtime in nanoseconds, or
/// `None` if the file doesn't exist; `find_stale_files` uses it to flag rows
/// whose cached approvedChanges / unapprovedChanges bits predate the latest
/// accept / reject / discard.
#[derive(Debug, Default)]
struct PatchIndex {
    patch_mtime: Option<i64>,
    entries: HashMap<String, AcceptedEntry>,
}

fn resolve_accepted_patches_path(workspace: &Path, folder: &str) -> PathBuf {
    let conn = conn_name_from_folder(folder);
    workspace
        .join(".scratch")
        .join("connections")
        .join(conn)
        .join("accepted-patches.json")
}

fn folder_sub_path(folder: &str) -> &str {
    let normalized = folder.trim_start_matches('/');
    match normalized.find('/') {
        Some(idx) => &normalized[idx + 1..],
        None => "",
    }
}

/// Build the repo-relative path that `accepted-patches.json` would use for a
/// given filename within a folder. Folder `"MyConn/Companies"` + filename
/// `"rec_1.json"` → `"Companies/rec_1.json"`.
fn repo_relative_path_for_filename(folder: &str, filename: &str) -> String {
    let sub = folder_sub_path(folder);
    if sub.is_empty() {
        filename.to_string()
    } else {
        format!("{sub}/{filename}")
    }
}

/// Read `accepted-patches.json` for the connection and index entries by path.
/// Returns an empty index (with mtime captured) if the file is missing,
/// empty, or malformed — folder_index is best-effort here; the CLI's
/// accept / discard paths validate before write.
fn load_patch_index(workspace: &Path, folder: &str) -> PatchIndex {
    let path = resolve_accepted_patches_path(workspace, folder);
    let patch_mtime = file_mtime_size(&path).map(|(m, _)| m);

    let bytes = match fs::read(&path) {
        Ok(b) if !b.is_empty() => b,
        _ => {
            return PatchIndex {
                patch_mtime,
                entries: HashMap::new(),
            };
        }
    };
    let root: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            return PatchIndex {
                patch_mtime,
                entries: HashMap::new(),
            };
        }
    };
    let Some(arr) = root.get("patches").and_then(|v| v.as_array()) else {
        return PatchIndex {
            patch_mtime,
            entries: HashMap::new(),
        };
    };

    let mut entries = HashMap::new();
    for entry in arr {
        let Some(entry_path) = entry.get("path").and_then(|v| v.as_str()) else {
            continue;
        };
        let kind = match entry.get("kind").and_then(|v| v.as_str()) {
            Some("create") => AcceptedKind::Create,
            Some("update") => AcceptedKind::Update,
            Some("delete") => AcceptedKind::Delete,
            _ => continue,
        };
        let patch = entry
            .get("patch")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        entries.insert(entry_path.to_string(), AcceptedEntry { kind, patch });
    }
    PatchIndex {
        patch_mtime,
        entries,
    }
}

/// Synthesize the "approved" JSON value for one record file:
///   - no entry → published (`main_json`, or `None` if the path isn't on `main`)
///   - `Delete`   → `None` (the file is approved-deleted)
///   - `Create`   → `entry.patch` (full content)
///   - `Update`   → `apply(main_json_or_null, entry.patch)` via the dual-read
///     bridge (RFC 6902 op array or legacy RFC 7396 merge patch, by shape)
fn approved_json_for_entry(
    main_json: Option<&serde_json::Value>,
    entry: Option<&AcceptedEntry>,
) -> Option<serde_json::Value> {
    match entry {
        None => main_json.cloned(),
        Some(e) => match e.kind {
            AcceptedKind::Delete => None,
            AcceptedKind::Create => Some(e.patch.clone()),
            AcceptedKind::Update => {
                let base = main_json.cloned().unwrap_or(serde_json::Value::Null);
                // Best-effort: a malformed 6902 patch falls back to `base`, which
                // keeps the row flagged as needs-review (working != approved)
                // rather than crashing the index — consistent with this module's
                // "never silently green" policy.
                Some(crate::shared::json_patch::apply_update_patch(&base, &e.patch).unwrap_or(base))
            }
        },
    }
}

/// SQL-side string for an `AcceptedKind`, matching the wire format the patch
/// file uses (`"create"` | `"update"` | `"delete"`). Stored in the per-folder
/// table's `accepted_kind` column so `query_summary` can discriminate the
/// `addedUnpublished` / `unpublished` / `deletedUnpublished` row buckets via
/// SQL alone (no patch-file re-read at summary time).
fn accepted_kind_sql(kind: AcceptedKind) -> &'static str {
    match kind {
        AcceptedKind::Create => "create",
        AcceptedKind::Update => "update",
        AcceptedKind::Delete => "delete",
    }
}

/// Compute the (approvedChanges, unapprovedChanges) bit pair for a single file.
///
///   - `approvedChanges = 1` iff the path has an entry in `accepted-patches.json`.
///   - `unapprovedChanges = 1` iff the working file differs from the approved
///     value (= `apply(main, patch_entry_or_empty)`). Presence mismatch (file
///     missing on one side, present on the other) counts as differing. A
///     present-but-unparseable working file also counts as differing — the bit
///     stays "true" so the row doesn't silently green.
fn compute_review_bits(
    patch_entry: Option<&AcceptedEntry>,
    working_stat: Option<(i64, i64)>,
    working_json: Option<&serde_json::Value>,
    master_json: Option<&serde_json::Value>,
) -> (i32, i32) {
    let approved_changes: i32 = i32::from(patch_entry.is_some());

    let approved_json = approved_json_for_entry(master_json, patch_entry);

    let unapproved_changes: i32 = match (working_stat.is_some(), &approved_json) {
        (false, None) => 0,
        (false, Some(_)) | (true, None) => 1,
        (true, Some(a)) => match working_json {
            Some(w) => i32::from(w != a),
            // Working file present on disk but failed to parse — treat as a
            // change so parse_error rows show up in the unapproved list rather
            // than silently passing.
            None => 1,
        },
    };

    (approved_changes, unapproved_changes)
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

struct FolderPaths {
    working: PathBuf,
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

    FolderPaths { working }
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

/// SHA-256 (lowercase hex) of the folder's synced `schema.json` bytes, or `None` if the file is
/// absent or unreadable. Hashes the exact file `enforce_schema` loads (`resolve_folder_schema_path`)
/// so the hash reflects what validation saw. Raw bytes, no canonicalization —
/// `sync_schema_files_from_worktree` copies the server's schema verbatim, so identical server
/// content yields an identical hash (the reason DEV-10518 hashes content rather than trusting mtime,
/// which the per-download rewrite always bumps).
fn compute_schema_hash(workspace: &Path, folder: &str) -> Option<String> {
    let path = resolve_folder_schema_path(workspace, folder);
    let bytes = fs::read(&path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
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

/// Name of the persisted per-folder schema-hash table (DEV-10518). Underscore-prefixed so the
/// version sweep in `open_conn` deliberately preserves it across `INDEX_SCHEMA_VERSION` bumps
/// (see `sweep_stale_version_tables`) — the schema hash is independent of the index table schema,
/// so it should survive a cold rebuild of the versioned tables.
const FOLDER_SCHEMA_HASHES_TABLE: &str = "_folder_schema_hashes";

/// Create the `_folder_schema_hashes` metadata table if absent. Maps a `folder_path` to the
/// SHA-256 of the `schema.json` it was last reconciled against, so a later download can detect a
/// schema change and clear stale `enforce_schema` results (DEV-10518).
fn ensure_folder_schema_hash_table(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {FOLDER_SCHEMA_HASHES_TABLE} (
            folder_path TEXT PRIMARY KEY,
            schema_hash TEXT NOT NULL
        );"
    ))
    .context("failed to ensure _folder_schema_hashes table")?;
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
            master_present            INTEGER NOT NULL DEFAULT 0,
            accepted_kind             TEXT,
            approvedChanges           INTEGER NOT NULL DEFAULT 0,
            unapprovedChanges         INTEGER NOT NULL DEFAULT 0,
            accepted_patches_mtime    INTEGER,
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

    ensure_folder_schema_hash_table(conn)?;

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
///
/// Uses a literal `.ends_with(".json")` check rather than `Path::extension()`
/// because `Path::extension()` returns `None` for filenames whose first char
/// is `.` (e.g. the literal `.json` produced by the server slug bug for
/// non-ASCII records — DEV-10144 follow-up D1). Without this we'd miss such
/// files on the working-tree scan, producing a spurious "orphan stored row"
/// → forced reindex on every warm refresh of folders that contain one.
fn scan_json_files(dir: &Path) -> HashSet<String> {
    let mut result = HashSet::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return result;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.ends_with(".json") {
            result.insert(name);
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

/// Parse already-loaded blob bytes into a JSON value. Used for master content
/// sourced from `refs/heads/main` (where we have bytes in memory, not a path).
fn parse_blob_to_json(
    bytes: Option<&Vec<u8>>,
) -> (Option<Vec<u8>>, Option<serde_json::Value>, Option<String>) {
    match bytes {
        None => (None, None, None),
        Some(b) => match serde_json::from_slice::<serde_json::Value>(b) {
            Ok(v) => (Some(b.clone()), Some(v), None),
            Err(e) => (Some(b.clone()), None, Some(format!("parse error: {e}"))),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-tree sourcing for the folder index (Slice F follow-up)
// ─────────────────────────────────────────────────────────────────────────────

/// Workspace marker shape — minimum subset needed to resolve a connection's
/// dirName → repo_path. Matches `<workspace>/.scratch/.scratchmd`.
#[derive(serde::Deserialize)]
struct FolderIndexMarker {
    #[serde(default)]
    connections: Vec<FolderIndexMarkerConnection>,
}

#[derive(serde::Deserialize)]
struct FolderIndexMarkerConnection {
    #[serde(rename = "repoPath", default)]
    repo_path: String,
    #[serde(rename = "dirName", default)]
    dir_name: String,
}

/// Resolve the bare repo path for a connection by name. Mirrors what
/// `shared::review_ops::resolve_connection_paths` does, but with a minimal
/// surface that doesn't drag in `ReviewOpError`.
///
/// Returns `Ok(None)` when the workspace marker is missing — pre-init
/// scenarios and the in-crate test suite (`make_workspace` doesn't seed a
/// marker). A missing marker is structurally indistinguishable from an
/// empty/uninitialized workspace; callers treat the resulting empty
/// `main_blobs` as "no master tree yet". Genuine corruption (marker present
/// but malformed YAML, connection name absent from a present marker, empty
/// `repo_path`) still errors so real misconfigurations surface.
fn bare_repo_for_connection(
    workspace: &Path,
    connection_dir_name: &str,
) -> anyhow::Result<Option<PathBuf>> {
    let marker_path = workspace.join(".scratch").join(".scratchmd");
    let content = match std::fs::read_to_string(&marker_path) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(err)
                .with_context(|| format!("read workspace marker at {}", marker_path.display()));
        }
    };
    let marker: FolderIndexMarker = serde_yaml::from_str(&content)
        .with_context(|| format!("parse workspace marker at {}", marker_path.display()))?;
    let entry = marker
        .connections
        .into_iter()
        .find(|c| c.dir_name == connection_dir_name)
        .with_context(|| format!("connection '{connection_dir_name}' not in marker"))?;
    if entry.repo_path.is_empty() {
        anyhow::bail!("connection '{connection_dir_name}' has empty repo_path");
    }
    let layout = crate::shared::layout::WorkspaceLayout::for_cli(workspace);
    Ok(Some(layout.bare_repo_path(&entry.repo_path)))
}

/// Read main-tree blobs for the records directly inside `<folder>`, returning
/// a `HashMap<filename, blob_bytes>`. "Directly inside" = non-recursive — the
/// folder's immediate `.json` children only. Returns an empty map when `main`
/// doesn't yet exist (no commits) or when the folder is missing in the tree.
///
/// Post-Slice-F replacement for the deleted `.scratch/connections/master/<conn>`
/// disk read. Slice E switched the column compute to use `accepted-patches.json`
/// for the approved side but kept the master source as the deleted worktree —
/// this fixes that gap.
fn read_main_blobs_for_folder(
    workspace: &Path,
    folder: &str,
) -> anyhow::Result<HashMap<String, Vec<u8>>> {
    read_main_blobs_for_folder_inner(workspace, folder, None)
}

/// Like [`read_main_blobs_for_folder`] but only reads blobs whose filename
/// is in `filenames`. Pushes the filter through to `git ls-tree → cat-file`
/// so we don't pull the whole folder's content when only a few files need
/// reindexing. For `reindex_files` with one stale file this is the
/// difference between 1s and a few ms on a 9k-file folder.
fn read_main_blobs_for_folder_filtered(
    workspace: &Path,
    folder: &str,
    filenames: &std::collections::HashSet<String>,
) -> anyhow::Result<HashMap<String, Vec<u8>>> {
    if filenames.is_empty() {
        return Ok(HashMap::new());
    }
    read_main_blobs_for_folder_inner(workspace, folder, Some(filenames))
}

fn read_main_blobs_for_folder_inner(
    workspace: &Path,
    folder: &str,
    filter: Option<&std::collections::HashSet<String>>,
) -> anyhow::Result<HashMap<String, Vec<u8>>> {
    let normalized = folder.trim_matches('/');
    let (conn_name, sub_path) = match normalized.find('/') {
        Some(idx) => (&normalized[..idx], &normalized[idx + 1..]),
        None => (normalized, ""),
    };

    // Test-only escape hatch: when `<workspace>/.scratch/_test_main/<conn>/
    // <sub_path>/` exists on disk, read JSON blobs from there instead of the
    // bare repo. Lets the in-crate tests below simulate `refs/heads/main`
    // content without spinning up a real git repo. The branch is gated on
    // `#[cfg(test)]` so production builds skip it entirely.
    #[cfg(test)]
    {
        let test_main_root = workspace.join(".scratch").join("_test_main");
        if test_main_root.exists() {
            let folder_dir = if sub_path.is_empty() {
                test_main_root.join(conn_name)
            } else {
                test_main_root.join(conn_name).join(sub_path)
            };
            let mut out = HashMap::new();
            if folder_dir.exists() {
                for entry in std::fs::read_dir(&folder_dir)?.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.ends_with(".json") {
                        continue;
                    }
                    if let Some(f) = filter {
                        if !f.contains(&name) {
                            continue;
                        }
                    }
                    out.insert(name, std::fs::read(entry.path())?);
                }
            }
            return Ok(out);
        }
    }

    let Some(bare_repo) = bare_repo_for_connection(workspace, conn_name)? else {
        // Pre-init workspace (no marker) or test fixture without a marker —
        // treat as "no main tree", same as a freshly initialized repo with
        // no commits.
        return Ok(HashMap::new());
    };
    let head_hash = match crate::shared::git_local::rev_parse_optional_to_string(
        &bare_repo,
        "refs/heads/main",
    )? {
        Some(h) => h,
        None => return Ok(HashMap::new()),
    };

    let folder_prefix = if sub_path.is_empty() {
        String::new()
    } else {
        format!("{sub_path}/")
    };

    // Path predicate matches the filtering we'd otherwise do after reading
    // every blob — pushing it down to `cat-file --batch` means we never
    // even ask for blobs we'd discard.
    let folder_prefix_for_keep = folder_prefix.clone();
    let keep_path = |path: &str| -> bool {
        let Some(rest) = path.strip_prefix(folder_prefix_for_keep.as_str()) else {
            return false;
        };
        if rest.contains('/') {
            return false;
        }
        if !rest.ends_with(".json") {
            return false;
        }
        match filter {
            None => true,
            Some(f) => f.contains(rest),
        }
    };
    let tree =
        crate::shared::git_local::read_tree_files_filtered(&bare_repo, &head_hash, keep_path)?;

    let mut out = HashMap::new();
    for (path, blob) in tree {
        let Some(rest) = path.strip_prefix(folder_prefix.as_str()) else {
            continue;
        };
        out.insert(rest.to_string(), blob);
    }
    Ok(out)
}

/// Extract a value at a dot-separated json path (e.g. "fields.title") from a
/// parsed JSON value. Returns `None` for missing paths AND for JSON `null`, so
/// nullable fields land as SQL NULL (which sorts predictably) rather than the
/// literal string "null".
fn extract_json_field(val: &serde_json::Value, json_path: &str) -> Option<String> {
    // Split on '.' (the dot-path nesting separator), RFC 6901-escape each
    // segment so a literal '/' or '~' in a field name addresses the right key
    // (e.g. "fields.Date/heure" → "/fields/Date~1heure"), then join. For the
    // common chars this is byte-identical to the old `replace('.', "/")`.
    let pointer: String = json_path
        .split('.')
        .map(|segment| {
            format!(
                "/{}",
                crate::shared::json_patch::encode_pointer_token(segment)
            )
        })
        .collect();
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
    accepted_patches_mtime: Option<i64>,
}

fn load_stored_rows(conn: &Connection, table: &str) -> anyhow::Result<HashMap<String, StoredRow>> {
    let tq = quote_ident(table);
    let mut stmt = conn.prepare(&format!(
        "SELECT filename, working_mtime, working_size, dirty_mtime, dirty_size,
                master_mtime, master_size, accepted_patches_mtime
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
                accepted_patches_mtime: row.get(7)?,
            },
        ))
    })?;
    // Note: master_present + accepted_kind are derived during refresh, not
    // tracked for staleness — they're invalidated transitively via
    // accepted_patches_mtime (kind changes flip with the patch file) and via
    // working/master mtime checks (master_present changes only when the
    // refs/heads/main advance fires the patch_mtime check or working file
    // staleness).
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
/// delete files no longer present in either filesystem tree.
/// All mutations are wrapped in a single BEGIN IMMEDIATE transaction.
///
/// Slice E (2026-05-20) replaces the three-worktree comparison with a compute
/// driven by `accepted-patches.json`:
///   - `approvedChanges = 1` iff the path appears in the patch file.
///   - `unapprovedChanges = 1` iff the working file differs from
///     `apply(refs/heads/main blob, patch_entry_or_empty)`.
/// The `dirty_mtime` / `dirty_size` columns are now written as NULL — the
/// old "reviewed-dirty" worktree at `<ws>/.scratch/connections/dirty/<conn>`
/// is dead post-Phase-3 and removed entirely by Slice F.
fn refresh_index(
    conn: &mut Connection,
    workspace: &Path,
    folder: &str,
    paths: &FolderPaths,
    table: &str,
) -> anyhow::Result<()> {
    let patch_index = load_patch_index(workspace, folder);

    let working_files = scan_json_files(&paths.working);
    let stored = load_stored_rows(conn, table)?;

    // ─── Fast pre-check (no main read) ───────────────────────────────────────
    //
    // Building `read_main_blobs_for_folder` walks 22–38k blobs through
    // `git ls-tree | cat-file --batch` and costs ~1–2s on the Monorepo's
    // big folders. Skip it when nothing has changed: working-file stats
    // match, patch file mtime matches, and no stored row's working file
    // has vanished. This is the hot path the desktop hits on every page
    // navigation. Cuts warm refresh from ~3s to ~500ms on Stripe/Charges
    // (38k records, release build).
    let working_set: std::collections::HashSet<&str> =
        working_files.iter().map(String::as_str).collect();
    let mut any_working_stale = false;
    let mut any_patch_invalidated = false;
    for filename in &working_files {
        let working_stat = file_mtime_size(&paths.working.join(filename));
        match stored.get(filename) {
            None => {
                any_working_stale = true;
                break;
            }
            Some(row) => {
                if version_changed(working_stat, row.working_mtime, row.working_size) {
                    any_working_stale = true;
                    break;
                }
                if row.accepted_patches_mtime != patch_index.patch_mtime {
                    any_patch_invalidated = true;
                }
            }
        }
    }
    let has_orphan_stored_rows = stored
        .keys()
        .any(|filename| !working_set.contains(filename.as_str()));

    if !any_working_stale && !any_patch_invalidated && !has_orphan_stored_rows {
        return Ok(());
    }

    // ─── Slow path — need master content ────────────────────────────────────
    //
    // Either some working file is stale, the patch file advanced, or there
    // are stored rows whose working file has vanished (possible delete OR
    // main-only row). All three cases need master content to decide
    // outcomes per file.
    let file_name_to_contents_map_in_main_branch_for_folder =
        read_main_blobs_for_folder(workspace, folder)?;
    let master_files: HashSet<String> = file_name_to_contents_map_in_main_branch_for_folder
        .keys()
        .cloned()
        .collect();

    let all_known: HashSet<String> = working_files
        .iter()
        .chain(master_files.iter())
        .cloned()
        .collect();

    let mut to_upsert: Vec<String> = Vec::new();
    let mut to_delete: Vec<String> = Vec::new();

    // Files in DB but gone from both working tree and main → delete.
    for filename in stored.keys() {
        if !all_known.contains(filename) {
            to_delete.push(filename.clone());
        }
    }

    // All known files: new or stale?
    for filename in &all_known {
        let working_stat = file_mtime_size(&paths.working.join(filename));
        // master_stat is always None post-Slice-F (no on-disk master tree).
        // Staleness for the master side is driven instead by the workspace's
        // refs/heads/main advance, which `materialize_local_repo` /
        // `download_single_repo` couple with a `paths.master_mtime_marker` —
        // here we rely on `accepted_patches_mtime` mismatches and explicit
        // `rebuild-folder` calls to invalidate.
        let master_stat: Option<(i64, i64)> = None;

        match stored.get(filename) {
            None => to_upsert.push(filename.clone()),
            Some(row) => {
                if version_changed(working_stat, row.working_mtime, row.working_size)
                    || version_changed(master_stat, row.master_mtime, row.master_size)
                    || row.accepted_patches_mtime != patch_index.patch_mtime
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

        let working_stat = file_mtime_size(&working_path);
        // master_stat is always None post-Slice-F: see the staleness loop above
        // for the rationale.
        let master_stat: Option<(i64, i64)> = None;

        let mut parse_error: Option<String> = None;

        let (_working_bytes, working_json, working_err) = read_bytes_and_json(&working_path);
        if let Some(e) = working_err {
            parse_error = Some(format!("working: {e}"));
        }
        let (_master_bytes, master_json, master_err) =
            parse_blob_to_json(file_name_to_contents_map_in_main_branch_for_folder.get(filename));
        if let Some(e) = master_err {
            if parse_error.is_none() {
                parse_error = Some(format!("master: {e}"));
            }
        }

        let rel_path = repo_relative_path_for_filename(folder, filename);
        let patch_entry = patch_index.entries.get(&rel_path);
        let (approved_changes, unapproved_changes) = compute_review_bits(
            patch_entry,
            working_stat,
            working_json.as_ref(),
            master_json.as_ref(),
        );
        let master_present_bit: i32 =
            i32::from(file_name_to_contents_map_in_main_branch_for_folder.contains_key(filename));
        let accepted_kind_str: Option<&'static str> =
            patch_entry.map(|e| accepted_kind_sql(e.kind));

        tx.execute(
            &format!(
                "INSERT INTO {tq} (
                    filename,
                    working_mtime, working_size,
                    dirty_mtime,   dirty_size,
                    master_mtime,  master_size,
                    master_present, accepted_kind,
                    approvedChanges, unapprovedChanges,
                    accepted_patches_mtime, parse_error
                 ) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(filename) DO UPDATE SET
                    working_mtime          = excluded.working_mtime,
                    working_size           = excluded.working_size,
                    dirty_mtime            = NULL,
                    dirty_size             = NULL,
                    master_mtime           = excluded.master_mtime,
                    master_size            = excluded.master_size,
                    master_present         = excluded.master_present,
                    accepted_kind          = excluded.accepted_kind,
                    approvedChanges        = excluded.approvedChanges,
                    unapprovedChanges      = excluded.unapprovedChanges,
                    accepted_patches_mtime = excluded.accepted_patches_mtime,
                    parse_error            = excluded.parse_error"
            ),
            params![
                filename,
                working_stat.map(|(m, _)| m),
                working_stat.map(|(_, s)| s),
                master_stat.map(|(m, _)| m),
                master_stat.map(|(_, s)| s),
                master_present_bit,
                accepted_kind_str,
                approved_changes,
                unapproved_changes,
                patch_index.patch_mtime,
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

/// Validate a JSON path used both as a JSON Pointer source and as a SQLite
/// column identifier. The path is only ever interpolated into SQL via
/// `quote_ident` (double-quoted, `"`→`""`) or as a bound parameter, so a
/// double-quoted identifier safely holds spaces, `/`, `~`, `'`, `;`, and
/// Unicode. We reject only what is genuinely unsafe for that path: the empty
/// string, control characters (incl. NUL, which would truncate the C/SQL
/// string), and the double-quote that `quote_ident` escapes — the last as
/// defense-in-depth against a future callsite that forgets `quote_ident`.
pub fn validate_json_path(column: &str) -> anyhow::Result<()> {
    if column.is_empty() {
        anyhow::bail!("field column name cannot be empty");
    }
    for ch in column.chars() {
        if ch == '"' || ch.is_control() {
            anyhow::bail!(
                "invalid character {ch:?} in field name '{column}'; \
                 control characters, NUL, and double-quotes are not allowed"
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
            // Parenthesized so the OR composes safely with the AND-joined clause list.
            FilterSpec::Pending => {
                clauses.push("(approvedChanges = 1 OR unapprovedChanges = 1)".into())
            }
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

/// Single-scan summary: groups every row into a row-status bucket and counts
/// each in one query, then folds the result into a `FolderSummary`. The bucket
/// discriminator mirrors the TS `compareRecordSnapshots` branches so the
/// desktop's `DiffGridSummary` numbers match a V1-style full-folder diff
/// without loading any blobs.
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
    // Union count (not approved_changes + unapproved_changes, which double-counts a
    // record changed on both axes) — the honest total behind the "Pending" pill.
    let pending_changes: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {tq} WHERE approvedChanges = 1 OR unapprovedChanges = 1"),
        [],
        |r| r.get(0),
    )?;

    // Bucket discriminator. Order matters: every row matches exactly one CASE
    // branch. Keep in sync with `compareRecordSnapshots` in
    // scratch-desktop/src/main/local-files.ts.
    let bucket_sql = format!(
        "SELECT
            CASE
                WHEN parse_error IS NOT NULL THEN 'invalidJson'
                -- working missing
                WHEN working_mtime IS NULL AND accepted_kind = 'delete' THEN 'deletedUnpublished'
                WHEN working_mtime IS NULL THEN 'deleted'
                -- working exists, approved missing (= Delete patch but working still on disk)
                WHEN accepted_kind = 'delete' THEN 'added'
                -- working exists, master absent (new record)
                WHEN master_present = 0 AND unapprovedChanges = 1 THEN 'added'
                WHEN master_present = 0 THEN 'addedApproved'
                -- working exists, master present
                WHEN unapprovedChanges = 1 THEN 'modified'
                WHEN accepted_kind IS NOT NULL THEN 'unpublished'
                ELSE 'unchanged'
            END AS bucket,
            COUNT(*)
         FROM {tq}
         GROUP BY bucket"
    );
    let mut stmt = conn.prepare(&bucket_sql)?;
    let mut added: i64 = 0;
    let mut added_approved: i64 = 0;
    let mut modified: i64 = 0;
    let mut unpublished: i64 = 0;
    let mut deleted: i64 = 0;
    let mut deleted_approved: i64 = 0;
    let mut invalid_json: i64 = 0;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for entry in rows {
        let (bucket, count) = entry?;
        match bucket.as_str() {
            "added" => added += count,
            "addedApproved" => {
                added += count;
                added_approved += count;
            }
            "modified" => modified += count,
            "unpublished" => unpublished += count,
            "deleted" => deleted += count,
            "deletedUnpublished" => {
                deleted += count;
                deleted_approved += count;
            }
            "invalidJson" => invalid_json += count,
            "unchanged" => {} // not surfaced in the summary
            _ => {}           // forward-compat: ignore unknown buckets
        }
    }

    Ok(FolderSummary {
        total,
        approved_changes,
        unapproved_changes,
        pending_changes,
        added,
        added_approved,
        modified,
        unpublished,
        deleted,
        deleted_approved,
        invalid_json,
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

/// Maximum number of filenames bound into a single `WHERE filename IN (...)` query.
///
/// SQLite caps the number of bound parameters in one statement at
/// `SQLITE_MAX_VARIABLE_NUMBER` (999 on legacy builds, 32766 on modern ones). A folder
/// with tens of thousands of stale records — e.g. a Stripe `Charges` table after seeding —
/// would otherwise build a single `IN (?, ?, … 40k times)` clause and fail with
/// "too many SQL variables". 900 stays under even the legacy limit and leaves headroom for
/// an extra leading bind (see `query_page_errors`).
const SQL_IN_CLAUSE_FILENAME_CHUNK_SIZE: usize = 900;

fn load_validation_state(
    conn: &Connection,
    table: &str,
    filenames: &[String],
) -> anyhow::Result<HashMap<String, ValidationStateRow>> {
    if filenames.is_empty() {
        return Ok(HashMap::new());
    }
    let tq = quote_ident(table);
    let mut filename_to_validation_state_row: HashMap<String, ValidationStateRow> = HashMap::new();
    // Chunk the `IN (...)` lookup so we never bind more placeholders than SQLite allows.
    for filename_chunk in filenames.chunks(SQL_IN_CLAUSE_FILENAME_CHUNK_SIZE) {
        let placeholders = filename_chunk
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT filename, working_mtime, master_mtime,
                    validated_mtime_working, validated_mtime_master, validated_mtime_validator
             FROM {tq}
             WHERE filename IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let params_ref: Vec<&dyn ToSql> = filename_chunk.iter().map(|s| s as &dyn ToSql).collect();
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
        filename_to_validation_state_row.extend(rows);
    }
    Ok(filename_to_validation_state_row)
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
    let vr_tq = quote_ident(&validation_results_table());
    let mut filename_to_validation_errors: HashMap<String, Vec<ValidationError>> = HashMap::new();
    // Chunk the `IN (...)` lookup to stay under SQLite's bound-parameter limit; see
    // `SQL_IN_CLAUSE_FILENAME_CHUNK_SIZE`. The leading `folder_path` bind takes one slot,
    // which the chunk size already accounts for.
    for filename_chunk in filenames.chunks(SQL_IN_CLAUSE_FILENAME_CHUNK_SIZE) {
        let placeholders = filename_chunk
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT filename, field_path, validator_kind, level, message, description, fixable
             FROM {vr_tq}
             WHERE folder_path = ? AND filename IN ({placeholders})
             ORDER BY filename, field_path, validator_kind"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params_ref: Vec<&dyn ToSql> = vec![&folder as &dyn ToSql];
        params_ref.extend(filename_chunk.iter().map(|s| s as &dyn ToSql));
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
        for (filename, error) in rows {
            filename_to_validation_errors
                .entry(filename)
                .or_default()
                .push(error);
        }
    }
    Ok(filename_to_validation_errors)
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
        // Load the folder schema once, alongside the validator config. Record-scoped validators
        // (notably `enforce_schema`) need it to check JSONSchema conformance, required fields, and
        // read-only edits; passing `None` here silently disables them — the validator hits its
        // `ctx.schema.get("schema")` guard and returns no violations. The schema lives next to
        // `validation.json` in the same `.scratch` folder. A missing or unparseable schema falls
        // back to `None`, preserving the no-op behavior for schema-less folders.
        let folder_schema: Option<serde_json::Value> =
            std::fs::read(validation_json_path.with_file_name("schema.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let workspace_dir = resolve_workspace_dir(workspace);
        // Master content comes from refs/heads/main post-Slice-F. Read only the blobs for
        // this page's stale records — the map is consulted solely inside the stale_filenames
        // loop below. The unfiltered read pulls the WHOLE folder's main content into a
        // folder-sized map, which is both wasted work on a small page and, now that
        // `validate_files` batches its pages, a full main-tree read per batch. Filtering keeps
        // the read and the allocation proportional to the batch (mirrors `reindex_files`).
        let stale_filename_filter: std::collections::HashSet<String> =
            stale_filenames.iter().cloned().collect();
        let file_name_to_contents_map_in_main_branch_for_folder =
            read_main_blobs_for_folder_filtered(workspace, folder, &stale_filename_filter)
                .unwrap_or_default();
        let total = stale_filenames.len();
        let mut done = 0usize;
        let vr_tq = quote_ident(&validation_results_table());

        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        for filename in &stale_filenames {
            let working_path = paths.working.join(filename);
            let working_stat = file_mtime_size(&working_path);
            // master_stat is None post-Slice-F; master_present comes from main_blobs.
            let master_stat: Option<(i64, i64)> = None;
            let master_present =
                file_name_to_contents_map_in_main_branch_for_folder.contains_key(filename);

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
            let master_json = if master_present {
                file_name_to_contents_map_in_main_branch_for_folder
                    .get(filename)
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
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
                    folder_schema.as_ref(),
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

fn count_stale(
    conn: &Connection,
    paths: &FolderPaths,
    workspace: &Path,
    folder: &str,
    table: &str,
) -> anyhow::Result<i64> {
    let stored = load_stored_rows(conn, table)?;

    let working_files = scan_json_files(&paths.working);
    // Master files are sourced from refs/heads/main post-Slice-F (the on-disk
    // master tree at `.scratch/connections/master/<conn>` is dead). The dirty
    // tree at `.scratch/connections/dirty/<conn>` is also dead.
    let file_name_to_contents_map_in_main_branch_for_folder =
        read_main_blobs_for_folder(workspace, folder).unwrap_or_default();
    let master_files: HashSet<String> = file_name_to_contents_map_in_main_branch_for_folder
        .keys()
        .cloned()
        .collect();

    let all_known: HashSet<String> = working_files
        .iter()
        .chain(master_files.iter())
        .cloned()
        .collect();

    let mut stale: i64 = 0;

    for filename in &all_known {
        let w = file_mtime_size(&paths.working.join(filename));
        // dirty_stat / master_stat are None post-Slice-F (no on-disk trees);
        // master staleness is driven by accepted_patches_mtime mismatches +
        // explicit rebuild-folder calls.
        let d: Option<(i64, i64)> = None;
        let m: Option<(i64, i64)> = None;

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

    // Rows in DB that no longer exist in either working tree or main.
    for filename in stored.keys() {
        if !all_known.contains(filename) {
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

    // Drop the table and any dynamically-added field columns / indexes in one
    // shot, then call `ensure_schema` to recreate with the canonical schema +
    // partial indexes. Previously this function recreated the table inline
    // with a hand-written column list, which drifted from `ensure_schema`
    // (e.g. it forgot `accepted_patches_mtime` and the two partial indexes).
    // Drift left the folder with a `__v<N>`-suffixed table whose name matched
    // the current schema version but whose columns didn't — every subsequent
    // refresh hit `no such column` errors. Delegating to `ensure_schema`
    // makes this function impossible to drift again.
    let vr_tq = quote_ident(&validation_results_table());
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        &format!("DELETE FROM {vr_tq} WHERE folder_path = ?1"),
        params![folder],
    )
    .context("failed to clear validation_results for folder")?;
    tx.execute_batch(&format!("DROP TABLE IF EXISTS {tq};"))
        .context("failed to drop folder index table")?;
    tx.commit()?;
    ensure_schema(&conn, &table)?;

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
    "master_present",
    "accepted_kind",
    "approvedChanges",
    "unapprovedChanges",
    "accepted_patches_mtime",
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

    // Lazy: only read main blobs in the cold-start branches that actually use
    // the filename set. The hot path (warm DB, paginate-records on each
    // navigation) doesn't need them — working stats + patch mtime are enough
    // to decide staleness, and reading 22-38k blobs via git ls-tree + cat-file
    // would cost ~1-2s per call otherwise.
    let read_main_filenames = || -> HashSet<String> {
        read_main_blobs_for_folder(workspace, folder)
            .unwrap_or_default()
            .into_keys()
            .collect()
    };

    if !db_path.exists() {
        // No DB file yet — seed from working tree + main.
        let main_filenames = read_main_filenames();
        let all: HashSet<String> = scan_json_files(&paths.working)
            .into_iter()
            .chain(main_filenames.into_iter())
            .collect();
        return Ok(all.into_iter().collect());
    }

    let conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    // Empty table = cold start (e.g. run_query created the schema but hasn't indexed yet).
    // Seed from working tree + main so main-only records are included.
    let row_count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {tq}"), [], |r| r.get(0))?;
    if row_count == 0 {
        let main_filenames = read_main_filenames();
        let all: HashSet<String> = scan_json_files(&paths.working)
            .into_iter()
            .chain(main_filenames.into_iter())
            .collect();
        return Ok(all.into_iter().collect());
    }

    let working_files = scan_json_files(&paths.working);
    let stored = load_stored_rows(&conn, &table)?;

    // accepted-patches.json mtime: any row whose cached mtime predates the
    // current file mtime needs its approvedChanges/unapprovedChanges bits
    // recomputed. Coarse — the whole table refreshes when the file changes —
    // but that matches the patch file's per-connection scope, and the
    // per-row reindex hot path is small (working + master read + 1 upsert).
    let current_patch_mtime =
        file_mtime_size(&resolve_accepted_patches_path(workspace, folder)).map(|(m, _)| m);

    let mut stale: HashSet<String> = HashSet::new();

    // Working files: new or mtime changed.
    for filename in &working_files {
        let stat = file_mtime_size(&paths.working.join(filename));
        let needs_reindex = match stored.get(filename) {
            None => true,
            Some(row) => {
                version_changed(stat, row.working_mtime, row.working_size)
                    || row.accepted_patches_mtime != current_patch_mtime
            }
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
    // Rows whose working file no longer exists AND whose patch-mtime is out
    // of date (e.g. an Update entry was discarded → row should flip its bits
    // even though the working file is unchanged-because-still-absent).
    for (filename, row) in &stored {
        if row.accepted_patches_mtime != current_patch_mtime && !stale.contains(filename) {
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

/// Reindex specific files: reads the working file + `refs/heads/main` blob
/// (via the master worktree) + the connection's `accepted-patches.json`,
/// computes approvedChanges/unapprovedChanges per Slice E, updates the base
/// row, and refreshes the value for every active field column.
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
    // Up-front signal so interactive callers see progress before the first
    // batch finishes (the per-batch progress below only fires every 1000
    // files). Gated on stderr being a TTY so we don't pollute stderr when
    // the CLI is piped (`cmd 2>&1 | jq` is a common pattern with --json) or
    // spawned from the desktop, which captures stdio.
    {
        use std::io::IsTerminal;
        if std::io::stderr().is_terminal() {
            eprintln!("[reindex] Reindexing {} file(s)...", filenames.len());
        }
    }
    let db_path = resolve_db_path(workspace, folder, db_path_override);
    let paths = resolve_folder_paths(workspace, folder);
    let table = table_name_from_folder(folder);
    let patch_index = load_patch_index(workspace, folder);
    // Master content is sourced from `refs/heads/main` post-Slice-F. Read
    // only the blobs we're about to reindex — reading the whole folder
    // costs ~1s on 9k records but contributes nothing when only 1 file is
    // stale (the desktop's hot path).
    let filename_filter: std::collections::HashSet<String> = filenames.iter().cloned().collect();
    let file_name_to_contents_map_in_main_branch_for_folder =
        read_main_blobs_for_folder_filtered(workspace, folder, &filename_filter)?;

    let mut conn = open_conn(&db_path)?;
    ensure_schema(&conn, &table)?;

    let active_cols = get_non_core_columns(&conn, &table)?;
    let tq = quote_ident(&table);
    let total = filenames.len();
    let mut done = 0usize;

    // Per-file work that doesn't touch SQLite — file read, JSON parse, bit
    // compute, column-value extraction — is the hot loop on cold builds. Fan
    // it out across cores with rayon so a 36k-record cold build doesn't pin
    // a single CPU. The SQLite upsert stays serial within each chunk's
    // transaction (rusqlite Connections aren't Sync).
    use rayon::prelude::*;

    struct ParsedRow {
        filename: String,
        working_stat: Option<(i64, i64)>,
        master_present: bool,
        parse_error: Option<String>,
        approved: i32,
        unapproved: i32,
        accepted_kind: Option<&'static str>,
        column_values: Vec<Option<String>>, // parallel to `active_cols`
        // If true, the row should be DELETEd rather than upserted.
        should_delete: bool,
    }

    for chunk in filenames.chunks(INDEX_FIELD_BATCH_SIZE) {
        // Phase 1: parse + compute, in parallel.
        let parsed: Vec<ParsedRow> = chunk
            .par_iter()
            .map(|filename| {
                let working_path = paths.working.join(filename);
                let working_stat = file_mtime_size(&working_path);
                let master_present =
                    file_name_to_contents_map_in_main_branch_for_folder.contains_key(filename);

                let mut parse_error: Option<String> = None;
                let (_working_bytes, working_json, working_err) =
                    read_bytes_and_json(&working_path);
                if let Some(e) = working_err {
                    parse_error = Some(format!("working: {e}"));
                }
                let (_master_bytes, master_json, master_err) = parse_blob_to_json(
                    file_name_to_contents_map_in_main_branch_for_folder.get(filename),
                );
                if let Some(e) = master_err {
                    if parse_error.is_none() {
                        parse_error = Some(format!("master: {e}"));
                    }
                }

                let rel_path = repo_relative_path_for_filename(folder, filename);
                let patch_entry = patch_index.entries.get(&rel_path);

                let should_delete =
                    working_stat.is_none() && !master_present && patch_entry.is_none();
                let (approved, unapproved) = if should_delete {
                    (0, 0)
                } else {
                    compute_review_bits(
                        patch_entry,
                        working_stat,
                        working_json.as_ref(),
                        master_json.as_ref(),
                    )
                };
                let accepted_kind: Option<&'static str> = if should_delete {
                    None
                } else {
                    patch_entry.map(|e| accepted_kind_sql(e.kind))
                };

                let column_values: Vec<Option<String>> = match working_json.as_ref() {
                    Some(json) if !should_delete => active_cols
                        .iter()
                        .map(|col| extract_json_field(json, col))
                        .collect(),
                    _ => vec![None; active_cols.len()],
                };

                ParsedRow {
                    filename: filename.clone(),
                    working_stat,
                    master_present,
                    parse_error,
                    approved,
                    unapproved,
                    accepted_kind,
                    column_values,
                    should_delete,
                }
            })
            .collect();

        // Phase 2: serial SQLite writes inside one transaction.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // master_stat is None post-Slice-F (no on-disk master tree); whether
        // the file exists in main is derived from `file_name_to_contents_map_in_main_branch_for_folder` presence.
        let master_stat: Option<(i64, i64)> = None;
        for row in &parsed {
            if row.should_delete {
                tx.execute(
                    &format!("DELETE FROM {tq} WHERE filename = ?1"),
                    params![row.filename],
                )?;
                continue;
            }
            tx.execute(
                &format!(
                    "INSERT INTO {tq} (filename,
                        working_mtime, working_size, dirty_mtime, dirty_size,
                        master_mtime, master_size, master_present, accepted_kind,
                        approvedChanges, unapprovedChanges,
                        accepted_patches_mtime, parse_error)
                     VALUES (?1,?2,?3,NULL,NULL,?4,?5,?6,?7,?8,?9,?10,?11)
                     ON CONFLICT(filename) DO UPDATE SET
                        working_mtime=excluded.working_mtime, working_size=excluded.working_size,
                        dirty_mtime=NULL, dirty_size=NULL,
                        master_mtime=excluded.master_mtime, master_size=excluded.master_size,
                        master_present=excluded.master_present,
                        accepted_kind=excluded.accepted_kind,
                        approvedChanges=excluded.approvedChanges,
                        unapprovedChanges=excluded.unapprovedChanges,
                        accepted_patches_mtime=excluded.accepted_patches_mtime,
                        parse_error=excluded.parse_error"
                ),
                params![
                    row.filename,
                    row.working_stat.map(|(m, _)| m),
                    row.working_stat.map(|(_, s)| s),
                    master_stat.map(|(m, _)| m),
                    master_stat.map(|(_, s)| s),
                    i32::from(row.master_present),
                    row.accepted_kind,
                    row.approved,
                    row.unapproved,
                    patch_index.patch_mtime,
                    row.parse_error,
                ],
            )?;

            for (col, value) in active_cols.iter().zip(row.column_values.iter()) {
                let col_q = quote_ident(col);
                let mt_q = quote_ident(&format!("{col}:mt"));
                let sz_q = quote_ident(&format!("{col}:sz"));
                tx.execute(
                    &format!("UPDATE {tq} SET {col_q}=?1, {mt_q}=?2, {sz_q}=?3 WHERE filename=?4"),
                    params![
                        value,
                        row.working_stat.map(|(m, _)| m),
                        row.working_stat.map(|(_, s)| s),
                        row.filename
                    ],
                )?;
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
///
/// Validates in bounded batches (`INDEX_FIELD_BATCH_SIZE`), each committed in its own
/// `validate_page_records` transaction. A folder with tens of thousands of stale records
/// (e.g. a Stripe `Charges` table after seeding) otherwise validates in a single giant
/// transaction; batching keeps memory bounded and makes the work resumable — validation is
/// mtime-idempotent, so a crashed run re-checks only the files in batches that hadn't yet
/// committed.
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
    let total = filenames.len();
    let mut done = 0usize;
    for filename_batch in filenames.chunks(INDEX_FIELD_BATCH_SIZE) {
        validate_page_records(
            &mut conn,
            &table,
            filename_batch,
            &paths,
            workspace,
            folder,
            true,
            debug,
        )?;
        done += filename_batch.len();
        if debug {
            eprintln!("[validate] batch {done}/{total}");
        }
    }
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

/// Result of `revalidate_folder`. Mirrors [`RefreshFolderResult`], but `validated` is always
/// present (a revalidate always runs validators) rather than `Option`.
#[derive(Debug, serde::Serialize)]
pub struct RevalidateFolderResult {
    pub base_refreshed: usize,
    pub columns_refreshed: usize,
    pub validated: usize,
}

/// Force re-run ALL validators for every live record in `folder` against the CURRENT index,
/// non-destructively. Unlike `clear_folder_index` (`index clear-folder`), this preserves the
/// folder's index rows and dynamic columns — it only re-runs validation and refreshes the
/// stored `validation_results`.
///
/// Mechanism: `validate_page_records` (reached via `refresh_folder(validate=true)`) skips
/// records whose validation watermarks are already fresh, so a plain refresh is a no-op on an
/// up-to-date folder. To force every record to revalidate we first NULL the three
/// `validated_mtime_*` watermark columns — which makes `is_validation_stale` treat every live
/// record as stale — then delegate to the existing `refresh_folder` machinery (which deletes
/// stale results, re-runs validators, reinserts violations, and updates watermarks +
/// `has_errors`).
///
/// This relies on `reindex_files` NOT writing the `validated_mtime_*` columns, so the NULLs we
/// set survive `refresh_folder`'s base/column reindex steps and are only re-populated by the
/// validation step. (If that invariant ever changes, the revalidate tests will catch it.)
pub fn revalidate_folder(
    workspace: &Path,
    folder: &str,
    debug: bool,
) -> anyhow::Result<RevalidateFolderResult> {
    // Mark every live record validation-stale by clearing its watermarks. A never-indexed
    // folder has no db yet — skip the UPDATE; `refresh_folder`'s cold reindex below inserts
    // rows with NULL watermarks, so they validate anyway. The connection is dropped at the end
    // of this block, before `refresh_folder` opens its own.
    let db_path = resolve_db_path(workspace, folder, None);
    if db_path.exists() {
        let conn = open_conn(&db_path)?;
        let table = table_name_from_folder(folder);
        ensure_schema(&conn, &table)?;
        let tq = quote_ident(&table);
        // Scope to live records (working_mtime IS NOT NULL) to mirror is_validation_stale's
        // deleted-record guard; deleted records are excluded from revalidation regardless.
        conn.execute(
            &format!(
                "UPDATE {tq} SET validated_mtime_working = NULL, \
                 validated_mtime_master = NULL, validated_mtime_validator = NULL \
                 WHERE working_mtime IS NOT NULL"
            ),
            [],
        )?;
    }

    let refreshed = refresh_folder(workspace, folder, true, debug)?;
    Ok(RevalidateFolderResult {
        base_refreshed: refreshed.base_refreshed,
        columns_refreshed: refreshed.columns_refreshed,
        validated: refreshed.validated.unwrap_or(0),
    })
}

/// True if a table named `table` exists in this database.
fn table_exists(conn: &Connection, table: &str) -> anyhow::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Recompute the denormalized `has_errors` flag for every record in `folder`'s index table from
/// the current validation_results rows: a record has errors iff at least one result row remains
/// for its filename. Used after selectively deleting one validator's results (e.g. `enforce_schema`)
/// so records that still violate other validators keep `has_errors = 1` while records whose only
/// violations were cleared flip to 0. No-op when the folder's index table doesn't exist yet.
fn recompute_has_errors_for_folder(
    tx: &rusqlite::Transaction<'_>,
    folder: &str,
    vr_tq: &str,
) -> anyhow::Result<()> {
    let table = table_name_from_folder(folder);
    if !table_exists(tx, &table)? {
        return Ok(());
    }
    let tq = quote_ident(&table);
    tx.execute(
        &format!(
            "UPDATE {tq} SET has_errors = CASE WHEN EXISTS (
                 SELECT 1 FROM {vr_tq} vr
                 WHERE vr.folder_path = ?1 AND vr.filename = {tq}.filename
             ) THEN 1 ELSE 0 END"
        ),
        params![folder],
    )?;
    Ok(())
}

/// Result of [`reconcile_enforce_schema_results_after_schema_change`].
#[derive(Debug, Default, serde::Serialize)]
pub struct SchemaHashReconcileResult {
    /// Folders whose `schema.json` hash changed since the last reconcile, whose `enforce_schema`
    /// validation results were therefore cleared.
    pub folders_with_changed_schema: Vec<String>,
}

/// DEV-10518: after a download, clear stale `enforce_schema` validation results for data folders
/// whose `schema.json` content changed.
///
/// For each folder we compare the freshly computed `schema.json` hash against the hash stored in
/// `_folder_schema_hashes`. When they differ AND a prior hash existed, we (1) delete that folder's
/// `enforce_schema` rows from the validation_results table and (2) recompute each record's
/// `has_errors` flag (other validators' rows may remain). The new hash is always recorded so the
/// next download compares against it. The first time we see a folder (no stored hash) we only record
/// the baseline — never clearing on first sight means rolling this out doesn't wipe every folder's
/// warnings on the next pull.
///
/// This only clears results; it does not re-run validation. Cleared `enforce_schema` warnings
/// repopulate on the next validation trigger (a record edit, an accept/reject, a desktop folder
/// refresh). To also re-run immediately, feed `folders_with_changed_schema` into [`revalidate_folder`].
///
/// `folders` may span connections; each folder's `.repos/<conn>.db` is resolved via
/// [`resolve_db_path`] (honoring `db_path_override`) and folders are grouped per database so each is
/// opened once. A cold workspace missing the validation_results or per-folder tables is tolerated
/// (nothing to clear) — the baseline hash is still recorded.
pub fn reconcile_enforce_schema_results_after_schema_change(
    workspace: &Path,
    folders: &[String],
    db_path_override: Option<&Path>,
) -> anyhow::Result<SchemaHashReconcileResult> {
    use std::collections::BTreeMap;

    // Group folders by the database they live in so each connection DB is opened once.
    let mut folders_by_db: BTreeMap<PathBuf, Vec<&String>> = BTreeMap::new();
    for folder in folders {
        let db_path = resolve_db_path(workspace, folder, db_path_override);
        folders_by_db.entry(db_path).or_default().push(folder);
    }

    let vr_table = validation_results_table();
    let vr_tq = quote_ident(&vr_table);
    let mut result = SchemaHashReconcileResult::default();

    for (db_path, db_folders) in folders_by_db {
        let mut conn = open_conn(&db_path)?;
        ensure_folder_schema_hash_table(&conn)?;
        let validation_results_exists = table_exists(&conn, &vr_table)?;

        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for folder in db_folders {
            let new_hash = compute_schema_hash(workspace, folder);
            let old_hash: Option<String> = tx
                .query_row(
                    &format!(
                        "SELECT schema_hash FROM {FOLDER_SCHEMA_HASHES_TABLE} WHERE folder_path = ?1"
                    ),
                    params![folder],
                    |row| row.get(0),
                )
                .optional()?;

            // Only clear when we have a prior hash to compare against and it actually moved.
            if old_hash.is_some() && old_hash != new_hash {
                if validation_results_exists {
                    tx.execute(
                        &format!(
                            "DELETE FROM {vr_tq} WHERE folder_path = ?1 AND validator_kind = 'enforce_schema'"
                        ),
                        params![folder],
                    )?;
                    recompute_has_errors_for_folder(&tx, folder, &vr_tq)?;
                }
                result.folders_with_changed_schema.push(folder.clone());
            }

            // Record the new baseline (or drop the row if the schema vanished).
            match &new_hash {
                Some(hash) => tx.execute(
                    &format!(
                        "INSERT OR REPLACE INTO {FOLDER_SCHEMA_HASHES_TABLE} (folder_path, schema_hash) VALUES (?1, ?2)"
                    ),
                    params![folder, hash],
                )?,
                None => tx.execute(
                    &format!("DELETE FROM {FOLDER_SCHEMA_HASHES_TABLE} WHERE folder_path = ?1"),
                    params![folder],
                )?,
            };
        }
        tx.commit()?;
    }

    Ok(result)
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

    // Rebuild base rows from working + master + accepted-patches.json.
    if debug {
        eprintln!("[reindex]    rebuilding base rows...");
    }
    refresh_index(&mut conn, workspace, folder, &paths, &table)?;
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

    // COLLATE NOCASE on the sort column gives case-insensitive ordering for
    // text values; SQLite ignores the collation for numeric comparisons, so
    // REAL-affinity field columns and the 0/1 status columns keep their
    // numeric ordering.
    let data_sql = format!(
        "SELECT filename FROM {tq} {} ORDER BY {} COLLATE NOCASE {} LIMIT ? OFFSET ?",
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
    let stale = count_stale(&conn, &paths, &opts.workspace, &opts.folder, &table)?;

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

    /// Write `<ws>/.scratch/connections/<conn>/accepted-patches.json` with the
    /// supplied entries. Slice E's compute reads this file to populate
    /// approvedChanges / unapprovedChanges.
    fn seed_patch_file(ws: &Path, conn: &str, patches: serde_json::Value) {
        let conn_dir = ws.join(".scratch").join("connections").join(conn);
        fs::create_dir_all(&conn_dir).unwrap();
        let body = serde_json::json!({ "patches": patches });
        fs::write(
            conn_dir.join("accepted-patches.json"),
            serde_json::to_string_pretty(&body).unwrap(),
        )
        .unwrap();
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
        // No accepted-patches entry, master_present = 0, working differs from
        // approved (= null) → the working file is an orphan-on-disk → 'added'
        // bucket in compareRecordSnapshots; SQL summary mirrors.
        assert_eq!(result.summary.added, 1);
        assert_eq!(result.summary.added_approved, 0);
        // No accepted-patches entry → not approved-pending-publish.
        assert_eq!(result.summary.approved_changes, 0);
        // Working file exists but approved value is None (no patch entry, no
        // master) → working differs from approved → unreviewed.
        assert_eq!(result.summary.unapproved_changes, 1);
        assert!(result.parse_errors.is_empty());
    }

    #[test]
    fn test_approved_changes_flag() {
        // approvedChanges = 1 iff the path appears in accepted-patches.json.
        // Setup: a Create patch for rec1.json, working file matches the patch
        // content exactly → approved-pending-publish, no unreviewed delta.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(&working_dir, "rec1.json", r#"{"title":"new"}"#);
        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([{
                "path": "posts/rec1.json",
                "kind": "create",
                "patch": { "title": "new" },
            }]),
        );

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.summary.approved_changes, 1);
        assert_eq!(result.summary.unapproved_changes, 0);
    }

    #[test]
    fn test_unapproved_changes_flag() {
        // unapprovedChanges = 1 iff working differs from apply(main, patch_or_empty).
        // Setup: master has a published value, working has a local edit, NO
        // patch entry → approved == published, working ≠ approved.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        let master_dir = ws
            .join(".scratch")
            .join("connections")
            .join("master")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "rec1.json", r#"{"title":"draft"}"#);
        write_json(&master_dir, "rec1.json", r#"{"title":"published"}"#);

        let result = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(result.summary.approved_changes, 0);
        assert_eq!(result.summary.unapproved_changes, 1);
    }

    #[test]
    fn test_pending_filter_is_union_of_approved_and_unapproved() {
        // Pending = approvedChanges OR unapprovedChanges. Set up one approved-only record and one
        // unapproved-only record: each single-axis filter isolates its own record, while Pending
        // returns their union and `pending_changes` counts the de-duplicated union.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        // rec1: approved-only (Create patch, working matches the patch content exactly).
        write_json(&working_dir, "rec1.json", r#"{"title":"new"}"#);
        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([{
                "path": "posts/rec1.json",
                "kind": "create",
                "patch": { "title": "new" },
            }]),
        );
        // rec2: unapproved-only (a working-only edit with no patch entry).
        write_json(&working_dir, "rec2.json", r#"{"title":"draft"}"#);

        let filenames_for = |filter: FilterSpec| -> Vec<String> {
            let mut filtered_opts = opts(&ws, "conn/posts");
            filtered_opts.filters = vec![filter];
            run_query(&filtered_opts).unwrap().filenames
        };

        assert_eq!(
            filenames_for(FilterSpec::ApprovedChanges),
            vec!["rec1.json"]
        );
        assert_eq!(
            filenames_for(FilterSpec::UnapprovedChanges),
            vec!["rec2.json"]
        );
        assert_eq!(
            filenames_for(FilterSpec::Pending),
            vec!["rec1.json", "rec2.json"]
        );

        // The folder-wide count de-duplicates the union of the two axes.
        assert_eq!(
            run_query(&opts(&ws, "conn/posts"))
                .unwrap()
                .summary
                .pending_changes,
            2
        );
    }

    /// DEV-10518: a changed schema.json hash clears only the folder's `enforce_schema` results,
    /// leaves other validators' results alone, recomputes `has_errors`, and is a no-op when the
    /// schema is unchanged or seen for the first time.
    #[test]
    fn test_schema_hash_change_clears_only_enforce_schema_results() {
        use rusqlite::params;

        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let folder = "conn/posts";

        // Write the initial schema.json where the validator (and the hasher) read it.
        let schema_path = resolve_folder_schema_path(&ws, folder);
        fs::create_dir_all(schema_path.parent().unwrap()).unwrap();
        fs::write(&schema_path, r#"{"type":"object","required":["title"]}"#).unwrap();

        // Seed the index DB directly: two live records flagged has_errors=1, an `enforce_schema`
        // result for each, plus a `required` result on rec2 that must survive the clear.
        let db_path = resolve_db_path(&ws, folder, None);
        let table = table_name_from_folder(folder);
        {
            let conn = open_conn(&db_path).unwrap();
            ensure_schema(&conn, &table).unwrap();
            let tq = quote_ident(&table);
            let vrq = quote_ident(&validation_results_table());
            for filename in ["rec1.json", "rec2.json"] {
                conn.execute(
                    &format!(
                        "INSERT INTO {tq} (filename, working_mtime, has_errors) VALUES (?1, 1, 1)"
                    ),
                    params![filename],
                )
                .unwrap();
                conn.execute(
                    &format!(
                        "INSERT INTO {vrq} (folder_path, filename, field_path, validator_kind, level, message, description, fixable)
                         VALUES (?1, ?2, 'fields.title', 'enforce_schema', 'warning', 'missing', NULL, 0)"
                    ),
                    params![folder, filename],
                )
                .unwrap();
            }
            conn.execute(
                &format!(
                    "INSERT INTO {vrq} (folder_path, filename, field_path, validator_kind, level, message, description, fixable)
                     VALUES (?1, 'rec2.json', 'fields.title', 'required', 'error', 'required', NULL, 0)"
                ),
                params![folder],
            )
            .unwrap();
        }

        let count_kind = |kind: &str| -> i64 {
            let conn = open_conn(&db_path).unwrap();
            let vrq = quote_ident(&validation_results_table());
            conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {vrq} WHERE folder_path = ?1 AND validator_kind = ?2"
                ),
                params![folder, kind],
                |r| r.get(0),
            )
            .unwrap()
        };
        let has_errors = |filename: &str| -> i64 {
            let conn = open_conn(&db_path).unwrap();
            let tq = quote_ident(&table_name_from_folder(folder));
            conn.query_row(
                &format!("SELECT has_errors FROM {tq} WHERE filename = ?1"),
                params![filename],
                |r| r.get(0),
            )
            .unwrap()
        };

        let folders = vec![folder.to_string()];

        // First reconcile: no stored hash → record baseline, clear nothing.
        let r1 = reconcile_enforce_schema_results_after_schema_change(&ws, &folders, None).unwrap();
        assert!(
            r1.folders_with_changed_schema.is_empty(),
            "first sight records a baseline, never clears"
        );
        // The baseline must persist a hash row — an empty `_folder_schema_hashes` was the
        // DEV-10518 symptom, and a missing baseline means a later change can never be detected.
        {
            let conn = open_conn(&db_path).unwrap();
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM _folder_schema_hashes WHERE folder_path = ?1",
                    params![folder],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                n, 1,
                "baseline reconcile must write a _folder_schema_hashes row"
            );
        }
        assert_eq!(count_kind("enforce_schema"), 2);
        assert_eq!(count_kind("required"), 1);

        // Change the schema content → enforce_schema results cleared, required survives,
        // has_errors recomputed per record.
        fs::write(&schema_path, r#"{"type":"object","required":[]}"#).unwrap();
        let r2 = reconcile_enforce_schema_results_after_schema_change(&ws, &folders, None).unwrap();
        assert_eq!(r2.folders_with_changed_schema, vec![folder.to_string()]);
        assert_eq!(
            count_kind("enforce_schema"),
            0,
            "enforce_schema rows cleared"
        );
        assert_eq!(count_kind("required"), 1, "other validators untouched");
        assert_eq!(has_errors("rec1.json"), 0, "rec1 had only enforce_schema");
        assert_eq!(
            has_errors("rec2.json"),
            1,
            "rec2 still has the required error"
        );

        // Unchanged schema → no-op.
        let r3 = reconcile_enforce_schema_results_after_schema_change(&ws, &folders, None).unwrap();
        assert!(
            r3.folders_with_changed_schema.is_empty(),
            "unchanged schema is a no-op"
        );
        assert_eq!(count_kind("required"), 1);
    }

    #[test]
    fn test_validation_state_and_errors_chunk_past_sqlite_variable_limit() {
        use rusqlite::params;

        // Regression for "too many SQL variables": a folder with far more stale
        // records than SQLite's bound-parameter limit (32766 on modern builds, 999
        // on legacy) must not build a single `WHERE filename IN (?, ?, …)` clause.
        // load_validation_state / query_page_errors now chunk the lookup.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let folder = "conn/charges";
        let db_path = resolve_db_path(&ws, folder, None);
        let table = table_name_from_folder(folder);

        let conn = open_conn(&db_path).unwrap();
        ensure_schema(&conn, &table).unwrap();
        let tq = quote_ident(&table);
        let vrq = quote_ident(&validation_results_table());

        // Two real rows present in the index; one carries a validation error.
        conn.execute(
            &format!(
                "INSERT INTO {tq} (filename, working_mtime, validated_mtime_working, has_errors)
                 VALUES ('present_a.json', 11, 11, 1)"
            ),
            [],
        )
        .unwrap();
        conn.execute(
            &format!(
                "INSERT INTO {tq} (filename, working_mtime, validated_mtime_working, has_errors)
                 VALUES ('present_b.json', 22, 22, 0)"
            ),
            [],
        )
        .unwrap();
        conn.execute(
            &format!(
                "INSERT INTO {vrq} (folder_path, filename, field_path, validator_kind, level, message, description, fixable)
                 VALUES (?1, 'present_a.json', 'fields.amount', 'enforce_schema', 'error', 'bad', NULL, 0)"
            ),
            params![folder],
        )
        .unwrap();

        // A filename slice well above the parameter limit: the two present rows plus
        // tens of thousands of absent ones (mirrors the 40k-record Charges crash).
        let mut filenames: Vec<String> =
            vec!["present_a.json".to_string(), "present_b.json".to_string()];
        filenames.extend((0..40_000).map(|i| format!("absent_{i:05}.json")));
        assert!(filenames.len() > SQL_IN_CLAUSE_FILENAME_CHUNK_SIZE);

        // Pre-fix this errored with "too many SQL variables".
        let state = load_validation_state(&conn, &table, &filenames).unwrap();
        assert_eq!(state.len(), 2, "only the present rows come back");
        assert_eq!(state.get("present_a.json").unwrap().working_mtime, Some(11));
        assert_eq!(
            state.get("present_b.json").unwrap().validated_mtime_working,
            Some(22)
        );

        let errors = query_page_errors(&conn, folder, &filenames).unwrap();
        assert_eq!(errors.len(), 1, "only present_a has an error row");
        assert_eq!(errors.get("present_a.json").unwrap().len(), 1);
        assert_eq!(
            errors.get("present_a.json").unwrap()[0].validator_kind,
            "enforce_schema"
        );
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
        // ApprovedChanges filter returns paths present in accepted-patches.json.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(&working_dir, "changed.json", r#"{"title":"v2"}"#);
        write_json(&working_dir, "same.json", r#"{"title":"v1"}"#);
        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([{
                "path": "posts/changed.json",
                "kind": "create",
                "patch": { "title": "v2" },
            }]),
        );

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

    /// Sorting on a text field is case-insensitive — mixed-case values
    /// interleave by letter rather than splitting all uppercase before
    /// all lowercase (the SQLite default BINARY collation).
    #[test]
    fn test_text_field_sort_is_case_insensitive() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(&working_dir, "a.json", r#"{"fields":{"title":"ALPHA"}}"#);
        write_json(&working_dir, "b.json", r#"{"fields":{"title":"AMINO"}}"#);
        write_json(&working_dir, "c.json", r#"{"fields":{"title":"Alpha"}}"#);
        write_json(&working_dir, "d.json", r#"{"fields":{"title":"Amino"}}"#);
        write_json(&working_dir, "e.json", r#"{"fields":{"title":"alpha"}}"#);

        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "fields.title".to_string();
        let result = run_query(&o).unwrap();

        // The three "alpha" variants must collate together before the two
        // "amino" variants, regardless of case.
        let positions: Vec<usize> = ["a.json", "c.json", "e.json", "b.json", "d.json"]
            .iter()
            .map(|fn_| result.filenames.iter().position(|f| f == fn_).unwrap())
            .collect();
        assert!(
            positions[0] < positions[3]
                && positions[1] < positions[3]
                && positions[2] < positions[3]
                && positions[0] < positions[4]
                && positions[1] < positions[4]
                && positions[2] < positions[4],
            "alpha variants must sort before amino variants: {:?}",
            result.filenames
        );
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
            // `_`-prefixed metadata tables (e.g. `_folder_schema_hashes`) are intentionally
            // preserved by the sweep — only versioned tables must carry the current suffix.
            if name.starts_with('_') {
                continue;
            }
            assert!(
                name.ends_with(&suffix),
                "found stale-version table after sweep: {name}"
            );
        }
        // And the new versioned validation_results table exists.
        let expected_vr = format!("validation_results{suffix}");
        assert!(table_names.iter().any(|n| n == &expected_vr));
        // The `_`-prefixed schema-hash metadata table is created by ensure_schema and survives
        // the sweep (it carries no version suffix; DEV-10518).
        assert!(table_names.iter().any(|n| n == "_folder_schema_hashes"));
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
        // Long-standing allowed shapes.
        assert!(validate_json_path("fields.title").is_ok());
        assert!(validate_json_path("fields[0].name").is_ok());
        assert!(validate_json_path("a-b").is_ok());

        // DEV-10127: field names with '/', '~', spaces, apostrophes, ';' and
        // non-ASCII are now accepted — they reach SQL only via quote_ident.
        assert!(validate_json_path("Date/heure de création").is_ok());
        assert!(validate_json_path("fields.Date/heure de création").is_ok());
        assert!(validate_json_path("Date d'expiration").is_ok()); // French apostrophe
        assert!(validate_json_path("a~b").is_ok());
        assert!(validate_json_path("Größe").is_ok()); // umlaut
        assert!(validate_json_path("名前").is_ok()); // non-ASCII script
        assert!(validate_json_path("a; b").is_ok());

        // Still rejected: empty, embedded double-quote, and control chars / NUL.
        assert!(validate_json_path("").is_err());
        assert!(validate_json_path("fields\"; DROP TABLE records;--").is_err());
        assert!(validate_json_path("a\"b").is_err());
        assert!(validate_json_path("a\0b").is_err());
        assert!(validate_json_path("a\nb").is_err());
    }

    /// DEV-10127: `extract_json_field` RFC 6901-escapes each segment, so a field
    /// whose name literally contains `/`, `~`, a space, or non-ASCII resolves to
    /// the right key instead of walking the wrong sub-tree.
    #[test]
    fn test_extract_json_field_escapes_special_chars() {
        let val = serde_json::json!({
            "fields": {
                "Date/heure de création": "2026-01-02",
                "a~b": "tilde",
                "with space": "spaced",
                "Größe": "groß",
            },
            "Date/heure de création": "top-level",
        });

        assert_eq!(
            extract_json_field(&val, "fields.Date/heure de création").as_deref(),
            Some("2026-01-02"),
        );
        assert_eq!(
            extract_json_field(&val, "fields.a~b").as_deref(),
            Some("tilde")
        );
        assert_eq!(
            extract_json_field(&val, "fields.with space").as_deref(),
            Some("spaced"),
        );
        assert_eq!(
            extract_json_field(&val, "fields.Größe").as_deref(),
            Some("groß")
        );
        assert_eq!(
            extract_json_field(&val, "Date/heure de création").as_deref(),
            Some("top-level"),
        );

        // Regression: ordinary dot/bracket paths resolve exactly as before.
        let plain = serde_json::json!({"fields": {"title": "hello"}});
        assert_eq!(
            extract_json_field(&plain, "fields.title").as_deref(),
            Some("hello")
        );
        assert_eq!(extract_json_field(&plain, "missing.path"), None);
    }

    /// DEV-10127 end-to-end: sort and filter on a field whose name contains a
    /// `/`, a space, and non-ASCII. Exercises add_field_column_if_missing →
    /// quote_ident → real SQLite, proving the identifier path round-trips.
    #[test]
    fn test_field_sort_and_filter_with_special_char_name() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(
            &working_dir,
            "a.json",
            r#"{"Date/heure de création":"banana"}"#,
        );
        write_json(
            &working_dir,
            "b.json",
            r#"{"Date/heure de création":"apple"}"#,
        );

        // Sort on the special-char field.
        let mut o = opts(&ws, "conn/posts");
        o.sort_by = "Date/heure de création".to_string();
        let sorted = run_query(&o).unwrap();
        assert_eq!(sorted.filenames, vec!["b.json", "a.json"]); // apple < banana

        // Filter on the same field.
        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::Field {
            column: "Date/heure de création".to_string(),
            op: FieldOp::Eq,
            value: "apple".to_string(),
        }];
        let filtered = run_query(&o).unwrap();
        assert_eq!(filtered.filenames, vec!["b.json"]);
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
        let worktree_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "in_working.json", r#"{"x":1}"#);
        write_json(&worktree_dir, "dirty_only.json", r#"{"x":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::HasWorking];
        let result = run_query(&o).unwrap();
        assert_eq!(result.filenames, vec!["in_working.json"]);
        assert_eq!(result.filtered_total, 1);
    }

    #[test]
    fn test_filter_has_dirty_returns_nothing_post_slice_e() {
        // The HasDirty filter and the `dirty_mtime/dirty_size` columns are
        // dead since Slice E stopped writing the dirty filesystem tree.
        // Filter still parses but returns nothing — Slice F removes the
        // columns and filter entirely.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        write_json(&working_dir, "working_only.json", r#"{"x":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::HasDirty];
        let result = run_query(&o).unwrap();
        assert!(result.filenames.is_empty());
    }

    #[test]
    fn test_filter_has_master_returns_nothing_post_slice_f() {
        // HasMaster filters by `master_mtime IS NOT NULL`. Pre-F, the master
        // tree was on disk and we recorded its mtime/size. Slice F routed
        // master through `refs/heads/main`; without a bare repo (test
        // fixture), `master_mtime` is NULL for every row, so the filter is
        // permanently empty in tests. Mirrors `test_filter_has_dirty_returns
        // _nothing_post_slice_e`. Slice F follow-up will drop the filter +
        // column together.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        write_json(&working_dir, "no_master.json", r#"{"x":1}"#);

        let mut o = opts(&ws, "conn/posts");
        o.filters = vec![FilterSpec::HasMaster];
        let result = run_query(&o).unwrap();
        assert!(result.filenames.is_empty());
    }

    #[test]
    fn test_filter_unapproved_changes() {
        // UnapprovedChanges filter returns paths where working ≠ approved.
        // pending.json: working diverges from master, no patch entry → unreviewed.
        // clean.json:   working matches master → reviewed.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        // Test escape hatch — see `read_main_blobs_for_folder`.
        let master_dir = ws
            .join(".scratch")
            .join("_test_main")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "pending.json", r#"{"v":2}"#);
        write_json(&master_dir, "pending.json", r#"{"v":1}"#);
        write_json(&working_dir, "clean.json", r#"{"v":1}"#);
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
        // ApprovedChanges (= has patch entry) AND status=published.
        // Three records, two with patch entries, one of those matches status.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");

        write_json(
            &working_dir,
            "pub_changed.json",
            r#"{"status":"published"}"#,
        );
        write_json(&working_dir, "draft_changed.json", r#"{"status":"draft"}"#);
        write_json(&working_dir, "pub_clean.json", r#"{"status":"published"}"#);

        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([
                { "path": "posts/pub_changed.json",   "kind": "create", "patch": { "status": "published" } },
                { "path": "posts/draft_changed.json", "kind": "create", "patch": { "status": "draft" } },
            ]),
        );

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

    // ── Summary bucket counts (V2 full-folder, no blob reads) ─────────────────
    //
    // Each test exercises exactly one row-status bucket of the
    // `query_summary` CASE discriminator. Tests use the `_test_main` escape
    // hatch to seed master content without a real bare repo.

    fn test_main_dir<'a>(ws: &Path, conn: &'a str, sub: &'a str) -> PathBuf {
        let mut p = ws.join(".scratch").join("_test_main").join(conn);
        if !sub.is_empty() {
            p = p.join(sub);
        }
        p
    }

    #[test]
    fn test_summary_bucket_added_when_orphan_working_file() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(&ws.join("conn").join("posts"), "rec.json", r#"{"v":1}"#);
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r.summary.added, 1);
        assert_eq!(r.summary.added_approved, 0);
        assert_eq!(r.summary.modified, 0);
        assert_eq!(r.summary.total, 1);
    }

    #[test]
    fn test_summary_bucket_added_approved_when_working_matches_create_patch() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working = ws.join("conn").join("posts");
        write_json(&working, "new.json", r#"{"title":"hi"}"#);
        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([
                { "path": "posts/new.json", "kind": "create", "patch": { "title": "hi" } },
            ]),
        );
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        // addedApproved counts as a subset of added — total `added` is also 1.
        assert_eq!(r.summary.added, 1);
        assert_eq!(r.summary.added_approved, 1);
        assert_eq!(r.summary.unapproved_changes, 0);
        assert_eq!(r.summary.approved_changes, 1);
    }

    #[test]
    fn test_summary_bucket_modified_when_working_differs_from_main() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working = ws.join("conn").join("posts");
        let main = test_main_dir(&ws, "conn", "posts");
        write_json(&working, "rec.json", r#"{"v":2}"#);
        write_json(&main, "rec.json", r#"{"v":1}"#);
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r.summary.modified, 1);
        assert_eq!(r.summary.added, 0);
        assert_eq!(r.summary.unapproved_changes, 1);
    }

    #[test]
    fn test_summary_bucket_unpublished_when_working_matches_update_patch() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working = ws.join("conn").join("posts");
        let main = test_main_dir(&ws, "conn", "posts");
        write_json(&working, "rec.json", r#"{"v":2}"#);
        write_json(&main, "rec.json", r#"{"v":1}"#);
        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([
                { "path": "posts/rec.json", "kind": "update", "patch": { "v": 2 } },
            ]),
        );
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r.summary.unpublished, 1);
        assert_eq!(r.summary.modified, 0);
        assert_eq!(r.summary.unapproved_changes, 0);
        assert_eq!(r.summary.approved_changes, 1);
    }

    #[test]
    fn test_summary_bucket_unchanged_when_working_matches_main_no_patch() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working = ws.join("conn").join("posts");
        let main = test_main_dir(&ws, "conn", "posts");
        write_json(&working, "rec.json", r#"{"v":1}"#);
        write_json(&main, "rec.json", r#"{"v":1}"#);
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        // 'unchanged' isn't surfaced in FolderSummary — every other bucket is 0.
        assert_eq!(r.summary.total, 1);
        assert_eq!(r.summary.added, 0);
        assert_eq!(r.summary.added_approved, 0);
        assert_eq!(r.summary.modified, 0);
        assert_eq!(r.summary.unpublished, 0);
        assert_eq!(r.summary.deleted, 0);
        assert_eq!(r.summary.invalid_json, 0);
        assert_eq!(r.summary.unapproved_changes, 0);
        assert_eq!(r.summary.approved_changes, 0);
    }

    #[test]
    fn test_summary_bucket_deleted_when_working_missing_no_patch() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let main = test_main_dir(&ws, "conn", "posts");
        write_json(&main, "rec.json", r#"{"v":1}"#);
        // Working tree dir exists but doesn't contain rec.json.
        std::fs::create_dir_all(ws.join("conn").join("posts")).unwrap();
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r.summary.deleted, 1);
        assert_eq!(r.summary.deleted_approved, 0);
        assert_eq!(r.summary.unapproved_changes, 1);
    }

    #[test]
    fn test_summary_bucket_deleted_approved_when_delete_patch_and_no_working() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let main = test_main_dir(&ws, "conn", "posts");
        write_json(&main, "rec.json", r#"{"v":1}"#);
        std::fs::create_dir_all(ws.join("conn").join("posts")).unwrap();
        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([
                { "path": "posts/rec.json", "kind": "delete", "patch": null },
            ]),
        );
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r.summary.deleted, 1);
        assert_eq!(r.summary.deleted_approved, 1);
        assert_eq!(r.summary.unapproved_changes, 0);
        assert_eq!(r.summary.approved_changes, 1);
    }

    #[test]
    fn test_summary_bucket_invalid_json_on_working_parse_error() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(&ws.join("conn").join("posts"), "bad.json", "{not json");
        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r.summary.invalid_json, 1);
        // invalidJson trumps every other bucket — the row isn't double-counted.
        assert_eq!(r.summary.added, 0);
        assert_eq!(r.summary.modified, 0);
    }

    #[test]
    fn test_summary_buckets_mixed_folder() {
        // Three rows across three distinct buckets in the same folder; verify
        // counts don't cross-pollinate.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working = ws.join("conn").join("posts");
        let main = test_main_dir(&ws, "conn", "posts");

        // Bucket: modified
        write_json(&working, "edited.json", r#"{"v":2}"#);
        write_json(&main, "edited.json", r#"{"v":1}"#);
        // Bucket: unpublished
        write_json(&working, "ready.json", r#"{"v":9}"#);
        write_json(&main, "ready.json", r#"{"v":8}"#);
        // Bucket: added (orphan working file, no patch, no main)
        write_json(&working, "fresh.json", r#"{"v":0}"#);

        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([
                { "path": "posts/ready.json", "kind": "update", "patch": { "v": 9 } },
            ]),
        );

        let r = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r.summary.total, 3);
        assert_eq!(r.summary.modified, 1);
        assert_eq!(r.summary.unpublished, 1);
        assert_eq!(r.summary.added, 1);
        assert_eq!(r.summary.added_approved, 0);
        assert_eq!(r.summary.deleted, 0);
        assert_eq!(r.summary.invalid_json, 0);
    }

    // ── Incremental updates ───────────────────────────────────────────────────

    #[test]
    fn test_file_content_change_updates_index() {
        // Editing the working file should flip unapprovedChanges from 0 to 1
        // (working diverges from approved). Verifies the mtime-based
        // staleness path picks up working-file edits.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        // Test escape hatch — see `read_main_blobs_for_folder`.
        let master_dir = ws
            .join(".scratch")
            .join("_test_main")
            .join("conn")
            .join("posts");

        // Initial: working == master → approved == published, no unreviewed delta.
        write_json(&working_dir, "rec.json", r#"{"title":"same"}"#);
        write_json(&master_dir, "rec.json", r#"{"title":"same"}"#);

        let r1 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r1.summary.unapproved_changes, 0);

        // Sleep briefly to ensure mtime changes on systems with 1-second resolution.
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_json(&working_dir, "rec.json", r#"{"title":"edited"}"#);

        let r2 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r2.summary.unapproved_changes, 1);
    }

    #[test]
    fn test_patch_file_change_invalidates_rows() {
        // Slice E: when accepted-patches.json changes, the per-row
        // approvedChanges / unapprovedChanges bits must be recomputed on the
        // next refresh — even though the working file's mtime is unchanged.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        // Test escape hatch — see `read_main_blobs_for_folder`. This stands
        // in for `refs/heads/main` content without a real bare repo.
        let master_dir = ws
            .join(".scratch")
            .join("_test_main")
            .join("conn")
            .join("posts");

        // Initial: working == master, no patch entry → fully published.
        write_json(&working_dir, "rec.json", r#"{"title":"hi"}"#);
        write_json(&master_dir, "rec.json", r#"{"title":"hi"}"#);

        let r1 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r1.summary.approved_changes, 0);
        assert_eq!(r1.summary.unapproved_changes, 0);

        // Seed an Update entry. The working file is untouched but the patch
        // file's mtime advances — the row should re-evaluate to approved=1
        // (entry exists) and unapproved=1 (working ≠ apply(master, patch)).
        std::thread::sleep(std::time::Duration::from_millis(10));
        seed_patch_file(
            &ws,
            "conn",
            serde_json::json!([{
                "path": "posts/rec.json",
                "kind": "update",
                "patch": { "title": "renamed" },
            }]),
        );

        let r2 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r2.summary.approved_changes, 1);
        assert_eq!(r2.summary.unapproved_changes, 1);

        // Remove the patch entry (= the user discarded). Working still
        // untouched but the row should flip back.
        std::thread::sleep(std::time::Duration::from_millis(10));
        seed_patch_file(&ws, "conn", serde_json::json!([]));

        let r3 = run_query(&opts(&ws, "conn/posts")).unwrap();
        assert_eq!(r3.summary.approved_changes, 0);
        assert_eq!(r3.summary.unapproved_changes, 0);
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
        let worktree_dir = ws
            .join(".scratch")
            .join("connections")
            .join("dirty")
            .join("conn")
            .join("posts");

        write_json(&working_dir, "rec.json", r#"{"a":1}"#);
        write_json(&worktree_dir, "rec.json", r#"{"a":1}"#);

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

    #[test]
    fn null_field_6902_update_converges_unapproved_bit() {
        // DEV-10237: a working file holding `status: null` with a 6902 Update
        // patch `add /status null` reconstructs to approved `status: null`, so
        // unapprovedChanges clears (working == approved).
        let master = serde_json::json!({"name": "Acme", "status": "active"});
        let working = serde_json::json!({"name": "Acme", "status": null});
        let entry = AcceptedEntry {
            kind: AcceptedKind::Update,
            patch: serde_json::json!([{"op": "add", "path": "/status", "value": null}]),
        };
        let (approved_changes, unapproved_changes) =
            compute_review_bits(Some(&entry), Some((1, 1)), Some(&working), Some(&master));
        assert_eq!(
            approved_changes, 1,
            "an entry exists, so approvedChanges is set"
        );
        assert_eq!(
            unapproved_changes, 0,
            "6902 reconstructs the null, so working == approved and the row is not stuck"
        );
    }

    #[test]
    fn null_field_legacy_7396_update_cannot_converge() {
        // The exact bug being fixed, documented via the legacy dialect: a 7396
        // merge patch `{"status": null}` *deletes* the key on apply, so the
        // reconstructed approved value is `{name}` while the working file is
        // `{name, status: null}` — they can never agree (stuck "needs review").
        // Dual-read still applies the v1 body correctly (as a delete); the point
        // is that the legacy *representation* could not express set-null at all.
        let master = serde_json::json!({"name": "Acme", "status": "active"});
        let working = serde_json::json!({"name": "Acme", "status": null});
        let entry = AcceptedEntry {
            kind: AcceptedKind::Update,
            patch: serde_json::json!({"status": null}),
        };
        let (_approved, unapproved_changes) =
            compute_review_bits(Some(&entry), Some((1, 1)), Some(&working), Some(&master));
        assert_eq!(
            unapproved_changes, 1,
            "legacy 7396 strips the null on reconstruct — the stuck state we migrated away from"
        );
    }

    // ── revalidate_folder ────────────────────────────────────────────────────

    /// Write a `validation.json` for `folder` (`<connection>/<subfolder>`) with the given
    /// JSON array of validator entries, e.g. `[{"validator":"required","field":"title"}]`.
    fn write_validation_json(ws: &Path, folder: &str, entries_json: &str) {
        let path = resolve_validation_json_path(ws, folder);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, entries_json).unwrap();
    }

    /// Count `validation_results` rows for a folder. Returns 0 if the db doesn't exist.
    fn count_validation_results(ws: &Path, folder: &str) -> i64 {
        let conn_name = conn_name_from_folder(folder);
        let db_path = ws.join(".repos").join(format!("{conn_name}.db"));
        if !db_path.exists() {
            return 0;
        }
        let conn = Connection::open(&db_path).unwrap();
        let table = validation_results_table();
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE folder_path = ?1"),
            params![folder],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Count index rows with `has_errors = 1` for a folder's table.
    fn count_has_errors(ws: &Path, folder: &str) -> i64 {
        let conn_name = conn_name_from_folder(folder);
        let db_path = ws.join(".repos").join(format!("{conn_name}.db"));
        if !db_path.exists() {
            return 0;
        }
        let conn = Connection::open(&db_path).unwrap();
        let tq = quote_ident(&table_name_from_folder(folder));
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {tq} WHERE has_errors = 1"),
            [],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Delete all `validation_results` rows for a folder, leaving index watermarks intact —
    /// simulates externally-lost results so a follow-up refresh-vs-revalidate can be compared.
    fn clear_validation_results(ws: &Path, folder: &str) {
        let conn_name = conn_name_from_folder(folder);
        let db_path = ws.join(".repos").join(format!("{conn_name}.db"));
        let conn = Connection::open(&db_path).unwrap();
        let table = validation_results_table();
        conn.execute(
            &format!("DELETE FROM {table} WHERE folder_path = ?1"),
            params![folder],
        )
        .unwrap();
    }

    #[test]
    fn test_revalidate_after_rule_change() {
        // Headline: a config-only change (no data-file edit) is reflected after revalidation.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(
            &ws.join("conn").join("posts"),
            "rec1.json",
            r#"{"title":""}"#,
        );

        // No rules yet → revalidation produces no problems.
        revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(count_validation_results(&ws, "conn/posts"), 0);
        assert_eq!(count_has_errors(&ws, "conn/posts"), 0);

        // Add a rule the existing record violates — WITHOUT touching the data file.
        write_validation_json(
            &ws,
            "conn/posts",
            r#"[{"validator":"required","field":"title"}]"#,
        );
        let result = revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(result.validated, 1);
        assert_eq!(count_validation_results(&ws, "conn/posts"), 1);
        assert_eq!(count_has_errors(&ws, "conn/posts"), 1);
    }

    #[test]
    fn test_revalidate_spanning_multiple_batches() {
        // validate_files processes filenames in batches of INDEX_FIELD_BATCH_SIZE, each
        // committed in its own transaction. A folder larger than one batch must still have
        // every record validated — nothing dropped at a batch boundary. Records with an
        // empty title violate the `required` rule; the rest pass.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let folder = "conn/posts";
        let posts_dir = ws.join("conn").join("posts");

        let record_count = INDEX_FIELD_BATCH_SIZE * 2 + 7; // spans 3 batches
        let mut expected_error_count = 0i64;
        for i in 0..record_count {
            let fails_required = i % 2 == 0;
            if fails_required {
                expected_error_count += 1;
            }
            let title = if fails_required { "" } else { "ok" };
            write_json(
                &posts_dir,
                &format!("rec{i:05}.json"),
                &format!(r#"{{"title":"{title}"}}"#),
            );
        }
        write_validation_json(&ws, folder, r#"[{"validator":"required","field":"title"}]"#);

        // Pre-fix the whole folder validated in one transaction; here it spans 3 batches.
        let result = revalidate_folder(&ws, folder, false).unwrap();
        assert_eq!(
            result.validated, record_count,
            "every record across all batches must be validated"
        );
        assert_eq!(count_validation_results(&ws, folder), expected_error_count);
        assert_eq!(count_has_errors(&ws, folder), expected_error_count);

        // Re-running is a no-op (mtime-idempotent) — nothing is re-validated.
        let again = revalidate_folder(&ws, folder, false).unwrap();
        assert_eq!(
            count_has_errors(&ws, folder),
            expected_error_count,
            "error count is stable across reruns"
        );
        // revalidate_folder forces a re-check of every live record, so `validated` counts
        // them all again — what matters is the result set is unchanged.
        assert_eq!(again.validated, record_count);
    }

    #[test]
    fn test_validate_filtered_main_read_surfaces_master_content() {
        // The validate path reads published (main-branch) content via the FILTERED helper,
        // scoped to the page's stale records, to bound per-batch memory. This must still
        // surface a stale file's master blob: the `enforce_schema` readonly check compares
        // the working value against master and only fires when master is present. Guards
        // against the filter dropping content the validators depend on.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let folder = "conn/posts";

        // Working record: the readonly `id` field changed away from its published value.
        write_json(
            &ws.join("conn").join("posts"),
            "rec.json",
            r#"{"id":"CHANGED","title":"Hello"}"#,
        );
        // Published (refs/heads/main) content via the `_test_main` escape hatch.
        write_json(
            &test_main_dir(&ws, "conn", "posts"),
            "rec.json",
            r#"{"id":"original","title":"Hello"}"#,
        );

        // schema.json marks `id` readonly; validation.json enables enforce_schema.
        let schema_path = resolve_folder_schema_path(&ws, folder);
        fs::create_dir_all(schema_path.parent().unwrap()).unwrap();
        fs::write(
            &schema_path,
            r#"{"schema":{"type":"object","properties":{"id":{"type":"string","x-scratch-readonly":true},"title":{"type":"string"}}}}"#,
        )
        .unwrap();
        write_validation_json(
            &ws,
            folder,
            r#"[{"validator":"enforce_schema","params":{}}]"#,
        );

        revalidate_folder(&ws, folder, false).unwrap();

        // Exactly one violation: a readonly warning on `id`, reachable only if the filtered
        // main read returned rec.json's published content.
        assert_eq!(count_validation_results(&ws, folder), 1);
        assert_eq!(count_has_errors(&ws, folder), 1);

        let conn_name = conn_name_from_folder(folder);
        let db_path = ws.join(".repos").join(format!("{conn_name}.db"));
        let conn = Connection::open(&db_path).unwrap();
        let vrt = validation_results_table();
        let (field_path, level, message): (String, String, String) = conn
            .query_row(
                &format!(
                    "SELECT field_path, level, COALESCE(message, '') FROM {vrt} \
                     WHERE folder_path = ?1 AND filename = 'rec.json'"
                ),
                params![folder],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            field_path, "id",
            "readonly violation is on the changed field"
        );
        assert_eq!(level, "warning", "readonly violations are warnings");
        assert!(
            message.to_lowercase().contains("readonly")
                || message.to_lowercase().contains("read-only"),
            "expected readonly mention in message, got: {message}"
        );
    }

    #[test]
    fn test_revalidate_forces_fresh_files() {
        // Proves the force mechanism: a plain refresh skips a fresh file, but revalidate
        // re-runs validators on it even when nothing on disk changed.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(
            &ws.join("conn").join("posts"),
            "rec1.json",
            r#"{"title":""}"#,
        );
        write_validation_json(
            &ws,
            "conn/posts",
            r#"[{"validator":"required","field":"title"}]"#,
        );

        revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(count_validation_results(&ws, "conn/posts"), 1);

        // Simulate externally-lost results; index watermarks remain "fresh".
        clear_validation_results(&ws, "conn/posts");
        assert_eq!(count_validation_results(&ws, "conn/posts"), 0);

        // A plain refresh sees the file as fresh and does NOT re-validate.
        refresh_folder(&ws, "conn/posts", true, false).unwrap();
        assert_eq!(
            count_validation_results(&ws, "conn/posts"),
            0,
            "refresh_folder must skip a validation-fresh file"
        );

        // revalidate FORCES re-validation, repopulating the result.
        revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(
            count_validation_results(&ws, "conn/posts"),
            1,
            "revalidate_folder must re-run validators on a fresh file"
        );
    }

    #[test]
    fn test_revalidate_clears_when_rules_removed() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(
            &ws.join("conn").join("posts"),
            "rec1.json",
            r#"{"title":""}"#,
        );
        write_validation_json(
            &ws,
            "conn/posts",
            r#"[{"validator":"required","field":"title"}]"#,
        );

        revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(count_validation_results(&ws, "conn/posts"), 1);
        assert_eq!(count_has_errors(&ws, "conn/posts"), 1);

        // Remove all rules → revalidation clears the stored problems.
        write_validation_json(&ws, "conn/posts", "[]");
        revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(count_validation_results(&ws, "conn/posts"), 0);
        assert_eq!(count_has_errors(&ws, "conn/posts"), 0);
    }

    #[test]
    fn test_revalidate_idempotent() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(
            &ws.join("conn").join("posts"),
            "rec1.json",
            r#"{"title":""}"#,
        );
        write_validation_json(
            &ws,
            "conn/posts",
            r#"[{"validator":"required","field":"title"}]"#,
        );

        revalidate_folder(&ws, "conn/posts", false).unwrap();
        let first = count_validation_results(&ws, "conn/posts");
        revalidate_folder(&ws, "conn/posts", false).unwrap();
        let second = count_validation_results(&ws, "conn/posts");
        assert_eq!(first, 1);
        assert_eq!(second, 1, "revalidate must not duplicate result rows");
    }

    #[test]
    fn test_revalidate_never_indexed_folder() {
        // First operation on the folder is a revalidate — it cold-builds the index and flags.
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        write_json(
            &ws.join("conn").join("posts"),
            "rec1.json",
            r#"{"title":""}"#,
        );
        write_validation_json(
            &ws,
            "conn/posts",
            r#"[{"validator":"required","field":"title"}]"#,
        );

        let result = revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(result.validated, 1);
        assert_eq!(count_validation_results(&ws, "conn/posts"), 1);
        assert_eq!(count_has_errors(&ws, "conn/posts"), 1);
    }

    #[test]
    fn test_revalidate_deleted_record_excluded() {
        let tmp = TempDir::new().unwrap();
        let ws = make_workspace(&tmp);
        let working_dir = ws.join("conn").join("posts");
        write_json(&working_dir, "rec1.json", r#"{"title":""}"#);
        write_validation_json(
            &ws,
            "conn/posts",
            r#"[{"validator":"required","field":"title"}]"#,
        );

        revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(count_has_errors(&ws, "conn/posts"), 1);

        // Delete the working file: revalidation must not re-process the now-absent record.
        fs::remove_file(working_dir.join("rec1.json")).unwrap();
        let result = revalidate_folder(&ws, "conn/posts", false).unwrap();
        assert_eq!(
            result.validated, 0,
            "a deleted record is excluded from revalidation"
        );
    }
}
