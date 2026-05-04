#![allow(dead_code)] // slice 7 (materialized-page-index) will wire up the refresh pipeline

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::Context;
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const PROCESSOR_VERSION: &str = "record-index-v1";
pub const RECORD_INDEX_TABLE: &str = "record_index_v1";
const LEGACY_RECORD_INDEX_TABLE: &str = "record_index";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RecordKey {
    folder_path: String,
    file_name: String,
}

impl RecordKey {
    fn from_rel_path(rel_path: &str) -> anyhow::Result<Self> {
        let normalized = crate::shared::git_path::normalize_logical_git_path(rel_path)
            .map_err(|e| anyhow::anyhow!(e))?;
        let path = Path::new(&normalized);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow::anyhow!("invalid record filename in path {rel_path}"))?
            .to_string();
        let folder_path = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        Ok(Self {
            folder_path,
            file_name,
        })
    }

    fn to_rel_path(&self) -> String {
        if self.folder_path.is_empty() {
            self.file_name.clone()
        } else {
            format!("{}/{}", self.folder_path, self.file_name)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordIndexRow {
    pub folder_path: String,
    pub file_name: String,
    pub content_hash: String,
    pub processor_version: String,
    pub mtime_ns: i64,
    pub file_size_bytes: i64,
}

#[derive(Debug, Clone)]
pub struct StatusCandidate {
    pub path: String,
    pub original_path: Option<String>,
    pub is_rename: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RefreshOptions {
    pub rebuild: bool,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct RefreshSummary {
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub unchanged: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StaleRecord {
    pub path: String,
    pub reasons: Vec<String>,
}

struct RefreshPlan {
    existing_rows: HashMap<RecordKey, RecordIndexRow>,
    upsert_candidates: HashSet<RecordKey>,
    delete_candidates: HashSet<RecordKey>,
    unchanged_candidates: usize,
    skipped: usize,
    stale_records: Vec<StaleRecord>,
}

#[derive(Debug, Clone, Copy)]
struct FileFingerprint {
    mtime_ns: i64,
    file_size_bytes: i64,
}

pub fn refresh(
    worktree_root: &Path,
    db_path: &Path,
    status_candidates: &[StatusCandidate],
    options: RefreshOptions,
    selected_paths: Option<&HashSet<String>>,
) -> anyhow::Result<RefreshSummary> {
    let conn = open_db(db_path)?;

    let plan = build_refresh_plan(
        worktree_root,
        &conn,
        status_candidates,
        options,
        selected_paths,
    )?;
    let mut summary = RefreshSummary {
        unchanged: plan.unchanged_candidates,
        skipped: plan.skipped,
        ..RefreshSummary::default()
    };

    for key in &plan.delete_candidates {
        delete_row(&conn, key)?;
        summary.deleted += 1;
    }

    for key in plan.upsert_candidates {
        let rel_path = key.to_rel_path();
        let full_path = worktree_root.join(&rel_path);
        if !full_path.exists() {
            continue;
        }

        let fingerprint = fingerprint_for_path(&full_path)?;
        let bytes = fs::read(&full_path)
            .with_context(|| format!("failed to read record file {}", full_path.display()))?;
        let content_hash = hash_bytes(&bytes);

        match plan.existing_rows.get(&key) {
            Some(row)
                if row.content_hash == content_hash
                    && row.processor_version == PROCESSOR_VERSION
                    && row.mtime_ns == fingerprint.mtime_ns
                    && row.file_size_bytes == fingerprint.file_size_bytes =>
            {
                // already counted in the planner
            }
            Some(_) => {
                upsert_row(&conn, &key, &content_hash, fingerprint)?;
                summary.updated += 1;
            }
            None => {
                upsert_row(&conn, &key, &content_hash, fingerprint)?;
                summary.inserted += 1;
            }
        }
    }

    Ok(summary)
}

pub fn inspect(
    worktree_root: &Path,
    db_path: &Path,
    status_candidates: &[StatusCandidate],
    options: RefreshOptions,
    selected_paths: Option<&HashSet<String>>,
) -> anyhow::Result<Vec<StaleRecord>> {
    let conn = open_db(db_path)?;

    let plan = build_refresh_plan(
        worktree_root,
        &conn,
        status_candidates,
        options,
        selected_paths,
    )?;
    Ok(plan.stale_records)
}

#[allow(dead_code)]
pub fn read_index(db_path: &Path) -> anyhow::Result<Vec<RecordIndexRow>> {
    let conn = open_db(db_path)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT folder_path, file_name, content_hash, processor_version, mtime_ns, file_size_bytes \
             FROM {RECORD_INDEX_TABLE} ORDER BY folder_path, file_name"
        ))
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RecordIndexRow {
                folder_path: row.get(0)?,
                file_name: row.get(1)?,
                content_hash: row.get(2)?,
                processor_version: row.get(3)?,
                mtime_ns: row.get(4)?,
                file_size_bytes: row.get(5)?,
            })
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(rows)
}

pub fn create_index_tables(db_path: &Path) -> anyhow::Result<()> {
    let conn = open_raw_db(db_path)?;
    create_index_tables_on_conn(&conn)
}

pub fn drop_index_tables(db_path: &Path) -> anyhow::Result<()> {
    let conn = open_raw_db(db_path)?;
    drop_index_tables_on_conn(&conn)
}

pub fn assert_index_tables_exist(db_path: &Path) -> anyhow::Result<()> {
    let conn = open_raw_db(db_path)?;
    assert_index_tables_exist_on_conn(&conn)
}

fn create_index_tables_on_conn(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {RECORD_INDEX_TABLE} (
            folder_path       TEXT NOT NULL,
            file_name         TEXT NOT NULL,
            content_hash      TEXT NOT NULL,
            processor_version TEXT NOT NULL,
            mtime_ns          INTEGER NOT NULL DEFAULT 0,
            file_size_bytes   INTEGER NOT NULL DEFAULT -1,
            PRIMARY KEY (folder_path, file_name)
        );"
    ))
    .map_err(|e| anyhow::anyhow!("failed to ensure record index schema: {e}"))?;
    crate::shared::validators::create_validation_schema(conn)?;
    Ok(())
}

fn drop_index_tables_on_conn(conn: &Connection) -> anyhow::Result<()> {
    crate::shared::validators::drop_validation_schema(conn)?;
    conn.execute_batch(&format!("DROP TABLE IF EXISTS {RECORD_INDEX_TABLE};"))
        .map_err(|e| anyhow::anyhow!("failed to drop record_index schema: {e}"))?;
    Ok(())
}

fn assert_index_tables_exist_on_conn(conn: &Connection) -> anyhow::Result<()> {
    if record_index_schema_exists(conn)?
        && crate::shared::validators::validation_schema_exists(conn)?
    {
        return Ok(());
    }

    // These tables are derived caches. On any partial/mismatched schema, clear
    // all index tables and recreate a coherent set; callers then reindex.
    drop_index_tables_on_conn(conn)?;
    create_index_tables_on_conn(conn)?;
    Ok(())
}

fn open_raw_db(db_path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create record index dir {}", parent.display()))?;
    }

    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;
    Ok(conn)
}

fn open_db(db_path: &Path) -> anyhow::Result<Connection> {
    let conn = open_raw_db(db_path)?;
    assert_index_tables_exist_on_conn(&conn)?;
    migrate_legacy_record_index_if_needed(db_path, &conn)?;
    Ok(conn)
}

fn read_rows_map(conn: &Connection) -> anyhow::Result<HashMap<RecordKey, RecordIndexRow>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT folder_path, file_name, content_hash, processor_version, mtime_ns, file_size_bytes \
             FROM {RECORD_INDEX_TABLE}"
        ))
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let folder_path: String = row.get(0)?;
            let file_name: String = row.get(1)?;
            let content_hash: String = row.get(2)?;
            let processor_version: String = row.get(3)?;
            let mtime_ns: i64 = row.get(4)?;
            let file_size_bytes: i64 = row.get(5)?;
            Ok((
                RecordKey {
                    folder_path: folder_path.clone(),
                    file_name: file_name.clone(),
                },
                RecordIndexRow {
                    folder_path,
                    file_name,
                    content_hash,
                    processor_version,
                    mtime_ns,
                    file_size_bytes,
                },
            ))
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;

    let mut map = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|e| anyhow::anyhow!("{e}"))?;
        map.insert(key, value);
    }
    Ok(map)
}

fn build_refresh_plan(
    worktree_root: &Path,
    conn: &Connection,
    status_candidates: &[StatusCandidate],
    options: RefreshOptions,
    selected_paths: Option<&HashSet<String>>,
) -> anyhow::Result<RefreshPlan> {
    let existing_rows = read_rows_map(conn)?;
    let current_paths = collect_record_paths(worktree_root)?;
    let current_path_set: HashSet<String> = current_paths.iter().cloned().collect();

    let mut delete_candidates: HashSet<RecordKey> = existing_rows
        .keys()
        .filter(|key| {
            let rel_path = key.to_rel_path();
            !current_path_set.contains(&rel_path)
                && selected_paths
                    .map(|paths| paths.contains(&rel_path))
                    .unwrap_or(true)
        })
        .cloned()
        .collect();
    let mut upsert_candidates: HashSet<RecordKey> = HashSet::new();
    let mut unchanged_candidates = 0usize;
    let mut skipped = 0usize;
    let mut reasons_by_path: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for candidate in status_candidates {
        let path = candidate.path.replace('\\', "/");
        let original_path = candidate
            .original_path
            .as_deref()
            .map(|value| value.replace('\\', "/"));
        let is_selected = selected_paths.map(|paths| {
            paths.contains(&path)
                || original_path
                    .as_deref()
                    .map(|value| paths.contains(value))
                    .unwrap_or(false)
        });
        if is_selected == Some(false) {
            continue;
        }

        if !is_record_rel_path(&path) {
            skipped += 1;
        }

        if candidate.is_rename {
            if let Some(original_path) = original_path.as_deref() {
                if is_record_rel_path(&original_path) {
                    delete_candidates.insert(RecordKey::from_rel_path(&original_path)?);
                    add_reason(&mut reasons_by_path, &original_path, "rename-source");
                } else {
                    skipped += 1;
                }
            }
        }
    }

    if existing_rows.is_empty() {
        for rel_path in &current_paths {
            if selected_paths
                .map(|paths| !paths.contains(rel_path))
                .unwrap_or(false)
            {
                continue;
            }
            upsert_candidates.insert(RecordKey::from_rel_path(rel_path)?);
            add_reason(&mut reasons_by_path, rel_path, "bootstrap");
        }
    } else if options.rebuild {
        for rel_path in &current_paths {
            if selected_paths
                .map(|paths| !paths.contains(rel_path))
                .unwrap_or(false)
            {
                continue;
            }
            upsert_candidates.insert(RecordKey::from_rel_path(rel_path)?);
            add_reason(&mut reasons_by_path, rel_path, "rebuild");
        }
    }

    for rel_path in &current_paths {
        if selected_paths
            .map(|paths| !paths.contains(rel_path))
            .unwrap_or(false)
        {
            continue;
        }
        let key = RecordKey::from_rel_path(rel_path)?;
        let full_path = worktree_root.join(rel_path);
        let fingerprint = fingerprint_for_path(&full_path).with_context(|| {
            format!(
                "failed to read metadata for record file {}",
                full_path.display()
            )
        })?;
        match existing_rows.get(&key) {
            None => {
                upsert_candidates.insert(key);
                add_reason(&mut reasons_by_path, rel_path, "missing-row");
            }
            Some(row) => {
                if row.processor_version != PROCESSOR_VERSION {
                    upsert_candidates.insert(key.clone());
                    add_reason(&mut reasons_by_path, rel_path, "processor-version-mismatch");
                }
                if row.mtime_ns != fingerprint.mtime_ns
                    || row.file_size_bytes != fingerprint.file_size_bytes
                {
                    upsert_candidates.insert(key);
                    add_reason(&mut reasons_by_path, rel_path, "file-metadata-mismatch");
                } else if status_candidate_matches(status_candidates, rel_path) {
                    unchanged_candidates += 1;
                }
            }
        }
    }

    for key in &delete_candidates {
        add_reason(
            &mut reasons_by_path,
            &key.to_rel_path(),
            "missing-from-worktree",
        );
    }

    let stale_records = reasons_by_path
        .into_iter()
        .map(|(path, reasons)| StaleRecord {
            path,
            reasons: reasons.into_iter().collect(),
        })
        .collect();

    Ok(RefreshPlan {
        existing_rows,
        upsert_candidates,
        delete_candidates,
        unchanged_candidates,
        skipped,
        stale_records,
    })
}

fn migrate_legacy_record_index_if_needed(db_path: &Path, conn: &Connection) -> anyhow::Result<()> {
    let current_count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {RECORD_INDEX_TABLE}"),
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if current_count > 0 {
        return Ok(());
    }

    let Some(file_name) = db_path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    if !file_name.ends_with(".db") {
        return Ok(());
    }

    let legacy_file_name = format!("{}.record-index.db", file_name.trim_end_matches(".db"));
    let legacy_path = db_path.with_file_name(legacy_file_name);
    if legacy_path == db_path || !legacy_path.exists() {
        return Ok(());
    }

    let legacy = Connection::open(&legacy_path)
        .map_err(|e| anyhow::anyhow!("failed to open legacy db {}: {e}", legacy_path.display()))?;

    let has_legacy_table: bool = legacy
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [LEGACY_RECORD_INDEX_TABLE],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);
    if !has_legacy_table {
        return Ok(());
    }

    let legacy_columns = table_columns(&legacy, "record_index")?;
    let mtime_expr = if legacy_columns.iter().any(|column| column == "mtime_ns") {
        "mtime_ns"
    } else {
        "0"
    };
    let file_size_expr = if legacy_columns
        .iter()
        .any(|column| column == "file_size_bytes")
    {
        "file_size_bytes"
    } else {
        "-1"
    };

    let mut stmt = legacy
        .prepare(&format!(
            "SELECT folder_path, file_name, content_hash, processor_version, \
                    COALESCE({mtime_expr}, 0), COALESCE({file_size_expr}, -1) \
             FROM {LEGACY_RECORD_INDEX_TABLE}"
        ))
        .map_err(|e| anyhow::anyhow!("failed to read legacy record_index: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RecordIndexRow {
                folder_path: row.get(0)?,
                file_name: row.get(1)?,
                content_hash: row.get(2)?,
                processor_version: row.get(3)?,
                mtime_ns: row.get(4)?,
                file_size_bytes: row.get(5)?,
            })
        })
        .map_err(|e| anyhow::anyhow!("failed to query legacy record_index: {e}"))?;

    for row in rows {
        let row = row.map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute(
            &format!(
                "INSERT OR REPLACE INTO {RECORD_INDEX_TABLE} \
             (folder_path, file_name, content_hash, processor_version, mtime_ns, file_size_bytes) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
            ),
            params![
                row.folder_path,
                row.file_name,
                row.content_hash,
                row.processor_version,
                row.mtime_ns,
                row.file_size_bytes
            ],
        )
        .map_err(|e| anyhow::anyhow!("failed to migrate legacy record_index row: {e}"))?;
    }

    Ok(())
}

fn add_reason(
    reasons_by_path: &mut BTreeMap<String, BTreeSet<String>>,
    rel_path: &str,
    reason: &str,
) {
    reasons_by_path
        .entry(rel_path.to_string())
        .or_default()
        .insert(reason.to_string());
}

fn upsert_row(
    conn: &Connection,
    key: &RecordKey,
    content_hash: &str,
    fingerprint: FileFingerprint,
) -> anyhow::Result<()> {
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO {RECORD_INDEX_TABLE} \
         (folder_path, file_name, content_hash, processor_version, mtime_ns, file_size_bytes) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ),
        params![
            key.folder_path,
            key.file_name,
            content_hash,
            PROCESSOR_VERSION,
            fingerprint.mtime_ns,
            fingerprint.file_size_bytes
        ],
    )
    .map_err(|e| {
        anyhow::anyhow!(
            "failed to upsert {}/{}: {e}",
            key.folder_path,
            key.file_name
        )
    })?;
    Ok(())
}

fn delete_row(conn: &Connection, key: &RecordKey) -> anyhow::Result<()> {
    conn.execute(
        &format!("DELETE FROM {RECORD_INDEX_TABLE} WHERE folder_path = ?1 AND file_name = ?2"),
        params![key.folder_path, key.file_name],
    )
    .map_err(|e| {
        anyhow::anyhow!(
            "failed to delete {}/{}: {e}",
            key.folder_path,
            key.file_name
        )
    })?;
    Ok(())
}

fn collect_record_paths(root: &Path) -> anyhow::Result<Vec<String>> {
    let mut out = BTreeSet::new();
    collect_record_paths_recursive(root, root, &mut out)?;
    Ok(out.into_iter().collect())
}

fn collect_record_paths_recursive(
    root: &Path,
    dir: &Path,
    out: &mut BTreeSet<String>,
) -> anyhow::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(anyhow::anyhow!(
                "failed to read directory {}: {err}",
                dir.display()
            ))
        }
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        if name.starts_with('.') {
            continue;
        }

        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_record_paths_recursive(root, &path, out)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if is_record_rel_path(&rel_path) {
            out.insert(rel_path);
        }
    }

    Ok(())
}

fn is_record_rel_path(rel_path: &str) -> bool {
    if rel_path.is_empty() || rel_path.starts_with(".scratch/") {
        return false;
    }

    let path = Path::new(rel_path);
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if file_name == "schema.json" || file_name == "validation.json" || !file_name.ends_with(".json")
    {
        return false;
    }

    path.components().all(|component| match component {
        std::path::Component::Normal(segment) => {
            let text = segment.to_string_lossy();
            !text.starts_with('.')
        }
        _ => false,
    })
}

fn fingerprint_for_path(path: &Path) -> anyhow::Result<FileFingerprint> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("failed to stat record file {}", path.display()))?;
    let modified = metadata
        .modified()
        .with_context(|| format!("failed to read mtime for {}", path.display()))?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| anyhow::anyhow!("mtime before UNIX_EPOCH for {}", path.display()))?;
    let mtime_ns = duration
        .as_secs()
        .checked_mul(1_000_000_000)
        .and_then(|secs| secs.checked_add(duration.subsec_nanos() as u64))
        .ok_or_else(|| anyhow::anyhow!("mtime overflow for {}", path.display()))?;
    let mtime_ns = i64::try_from(mtime_ns)
        .map_err(|_| anyhow::anyhow!("mtime out of range for {}", path.display()))?;
    let file_size_bytes = i64::try_from(metadata.len())
        .map_err(|_| anyhow::anyhow!("file size out of range for {}", path.display()))?;
    Ok(FileFingerprint {
        mtime_ns,
        file_size_bytes,
    })
}

fn status_candidate_matches(status_candidates: &[StatusCandidate], rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    status_candidates.iter().any(|candidate| {
        candidate.path.replace('\\', "/") == normalized
            || candidate
                .original_path
                .as_deref()
                .map(|path| path.replace('\\', "/") == normalized)
                .unwrap_or(false)
    })
}

fn record_index_schema_exists(conn: &Connection) -> anyhow::Result<bool> {
    let table_exists = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [RECORD_INDEX_TABLE],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if !table_exists {
        return Ok(false);
    }

    let columns = table_columns(conn, RECORD_INDEX_TABLE)?;

    Ok([
        "folder_path",
        "file_name",
        "content_hash",
        "processor_version",
        "mtime_ns",
        "file_size_bytes",
    ]
    .iter()
    .all(|required| columns.iter().any(|column| column == required)))
}

fn table_columns(conn: &Connection, table_name: &str) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|e| anyhow::anyhow!("failed to inspect {table_name} schema: {e}"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| anyhow::anyhow!("failed to query {table_name} schema: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(columns)
}

fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        inspect, read_index, refresh, RefreshOptions, StaleRecord, StatusCandidate,
        PROCESSOR_VERSION, RECORD_INDEX_TABLE,
    };
    use rusqlite::Connection;
    use std::collections::HashSet;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn write_file(root: &Path, rel_path: &str, contents: &str) {
        let path = root.join(rel_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn bootstrap_indexes_only_record_json_files() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("record-index.db");

        write_file(tmp.path(), "posts/one.json", "{\"id\":1}");
        write_file(tmp.path(), "top.json", "{\"id\":2}");
        write_file(tmp.path(), "posts/schema.json", "{}");
        write_file(tmp.path(), ".hidden.json", "{}");
        write_file(tmp.path(), ".scratch/posts/schema.json", "{}");
        write_file(tmp.path(), "notes.txt", "hello");
        write_file(tmp.path(), "posts/.draft/skip.json", "{}");

        let summary = refresh(tmp.path(), &db_path, &[], RefreshOptions::default(), None).unwrap();
        assert_eq!(summary.inserted, 2);
        assert_eq!(summary.updated, 0);
        assert_eq!(summary.deleted, 0);

        let rows = read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].folder_path, "");
        assert_eq!(rows[0].file_name, "top.json");
        assert_eq!(rows[1].folder_path, "posts");
        assert_eq!(rows[1].file_name, "one.json");
    }

    #[test]
    fn refresh_updates_modified_new_and_deleted_records() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("record-index.db");

        write_file(tmp.path(), "posts/one.json", "{\"id\":1}");
        write_file(tmp.path(), "posts/two.json", "{\"id\":2}");
        refresh(tmp.path(), &db_path, &[], RefreshOptions::default(), None).unwrap();

        write_file(
            tmp.path(),
            "posts/one.json",
            "{\"id\":1,\"name\":\"updated\"}",
        );
        write_file(tmp.path(), "posts/three.json", "{\"id\":3}");
        fs::remove_file(tmp.path().join("posts/two.json")).unwrap();

        let candidates = vec![
            StatusCandidate {
                path: "posts/one.json".to_string(),
                original_path: None,
                is_rename: false,
            },
            StatusCandidate {
                path: "posts/three.json".to_string(),
                original_path: None,
                is_rename: false,
            },
            StatusCandidate {
                path: "posts/two.json".to_string(),
                original_path: None,
                is_rename: false,
            },
        ];

        let summary = refresh(
            tmp.path(),
            &db_path,
            &candidates,
            RefreshOptions::default(),
            None,
        )
        .unwrap();
        assert_eq!(summary.inserted, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(summary.deleted, 1);

        let rows = read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| row.file_name == "one.json"));
        assert!(rows.iter().any(|row| row.file_name == "three.json"));
        assert!(!rows.iter().any(|row| row.file_name == "two.json"));
    }

    #[test]
    fn refresh_handles_rename_as_delete_plus_insert() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("record-index.db");

        write_file(tmp.path(), "posts/old.json", "{\"id\":1}");
        refresh(tmp.path(), &db_path, &[], RefreshOptions::default(), None).unwrap();

        fs::rename(
            tmp.path().join("posts/old.json"),
            tmp.path().join("posts/new.json"),
        )
        .unwrap();

        let candidates = vec![StatusCandidate {
            path: "posts/new.json".to_string(),
            original_path: Some("posts/old.json".to_string()),
            is_rename: true,
        }];

        let summary = refresh(
            tmp.path(),
            &db_path,
            &candidates,
            RefreshOptions::default(),
            None,
        )
        .unwrap();
        assert_eq!(summary.inserted, 1);
        assert_eq!(summary.deleted, 1);

        let rows = read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_name, "new.json");
    }

    #[test]
    fn refresh_reprocesses_rows_when_processor_version_changes() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("record-index.db");

        write_file(tmp.path(), "posts/one.json", "{\"id\":1}");
        refresh(tmp.path(), &db_path, &[], RefreshOptions::default(), None).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            &format!(
                "UPDATE {RECORD_INDEX_TABLE} SET processor_version = 'old-version' \
                 WHERE folder_path = 'posts' AND file_name = 'one.json'"
            ),
            [],
        )
        .unwrap();

        let summary = refresh(tmp.path(), &db_path, &[], RefreshOptions::default(), None).unwrap();
        assert_eq!(summary.updated, 1);

        let rows = read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].processor_version, PROCESSOR_VERSION);
    }

    #[test]
    fn refresh_with_selected_paths_only_bootstraps_selected_records() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("record-index.db");

        write_file(tmp.path(), "posts/one.json", "{\"id\":1}");
        write_file(tmp.path(), "posts/two.json", "{\"id\":2}");
        write_file(tmp.path(), "posts/three.json", "{\"id\":3}");

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());

        let summary = refresh(
            tmp.path(),
            &db_path,
            &[],
            RefreshOptions::default(),
            Some(&selected),
        )
        .unwrap();
        assert_eq!(summary.inserted, 1);
        assert_eq!(summary.updated, 0);
        assert_eq!(summary.deleted, 0);

        let rows = read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].folder_path, "posts");
        assert_eq!(rows[0].file_name, "one.json");
    }

    #[test]
    fn inspect_with_selected_paths_only_reports_selected_stale_records() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("record-index.db");

        write_file(tmp.path(), "posts/one.json", "{\"id\":1}");
        write_file(tmp.path(), "posts/two.json", "{\"id\":2}");
        refresh(tmp.path(), &db_path, &[], RefreshOptions::default(), None).unwrap();

        write_file(
            tmp.path(),
            "posts/one.json",
            "{\"id\":1,\"name\":\"updated\"}",
        );
        write_file(tmp.path(), "posts/three.json", "{\"id\":3}");

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());

        let stale = inspect(
            tmp.path(),
            &db_path,
            &[],
            RefreshOptions::default(),
            Some(&selected),
        )
        .unwrap();

        assert_eq!(
            stale,
            vec![StaleRecord {
                path: "posts/one.json".to_string(),
                reasons: vec!["file-metadata-mismatch".to_string()],
            }]
        );

        let rows = read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| row.file_name == "one.json"));
        assert!(rows.iter().any(|row| row.file_name == "two.json"));
        assert!(!rows.iter().any(|row| row.file_name == "three.json"));
    }

    #[test]
    fn inspect_reports_stale_reasons_without_mutating_db() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("record-index.db");

        write_file(tmp.path(), "posts/one.json", "{\"id\":1}");
        refresh(tmp.path(), &db_path, &[], RefreshOptions::default(), None).unwrap();

        write_file(
            tmp.path(),
            "posts/one.json",
            "{\"id\":1,\"name\":\"updated\"}",
        );
        write_file(tmp.path(), "posts/two.json", "{\"id\":2}");

        let stale = inspect(
            tmp.path(),
            &db_path,
            &[StatusCandidate {
                path: "posts/one.json".to_string(),
                original_path: None,
                is_rename: false,
            }],
            RefreshOptions::default(),
            None,
        )
        .unwrap();

        assert_eq!(
            stale,
            vec![
                StaleRecord {
                    path: "posts/one.json".to_string(),
                    reasons: vec!["file-metadata-mismatch".to_string()],
                },
                StaleRecord {
                    path: "posts/two.json".to_string(),
                    reasons: vec!["missing-row".to_string()],
                },
            ]
        );

        let rows = read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_name, "one.json");
    }
}
