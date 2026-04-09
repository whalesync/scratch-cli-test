//! Shared publish-plan logic used by both the CLI and the service.
//!
//! The core function [`build_publish_plan`] takes two directory trees (dirty and master),
//! an optional index DB, and produces plan files on disk under the dirty directory.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMeta {
    pub plan_id: String,
    pub created_at: String,
    pub connection_name: String,
    pub connection_id: String,
    pub summary: PlanSummary,
    pub table_paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct PlanSummary {
    pub edit: usize,
    pub create: usize,
    pub delete: usize,
    pub backfill: usize,
    pub rename: usize,
}

/// Result of building a publish plan.
/// Fields are used across binaries: service reads `meta`, CLI reads `folder_reports`.
#[allow(dead_code)]
pub struct PlanResult {
    pub meta: PlanMeta,
    pub folder_reports: Vec<FolderReport>,
}

#[allow(dead_code)]
pub struct FolderReport {
    pub folder: String,
    pub raw_modified: usize,
    pub raw_added: usize,
    pub raw_deleted: usize,
    pub raw_ref_clear: usize,
    pub plan_edit: usize,
    pub plan_create: usize,
    pub plan_delete: usize,
    pub plan_backfill: usize,
    pub plan_rename: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Edit,
    Create,
    Delete,
    Backfill,
    Rename,
}

impl Phase {
    pub fn dir_name(&self) -> &'static str {
        match self {
            Phase::Edit => "edit",
            Phase::Create => "create",
            Phase::Delete => "delete",
            Phase::Backfill => "backfill",
            Phase::Rename => "rename",
        }
    }
}

struct PlanEntry {
    rel_path: String,
    phase: Phase,
    content: Value,
    changed_fields: Option<Value>,
}

struct FkPath {
    path: Vec<String>,
    _target_table_id: String,
}

// ---------------------------------------------------------------------------
// Core entry point
// ---------------------------------------------------------------------------

/// Build a publish plan by diffing `dirty_dir` against `master_dir`.
///
/// Writes phase files and the plan manifest under `dirty_dir/.scratch/`.
/// Returns `Ok(None)` if there are no changes to publish.
/// Returns `Ok(Some(PlanResult))` with the plan metadata and per-folder reports.
#[allow(dead_code)]
pub fn build_publish_plan(
    conn_name: &str,
    connection_id: &str,
    dirty_dir: &Path,
    master_dir: &Path,
    db_path: &Path,
    timestamp: &str,
) -> anyhow::Result<Option<PlanResult>> {
    build_publish_plan_with_scratch_dir(
        conn_name,
        connection_id,
        dirty_dir,
        master_dir,
        db_path,
        &dirty_dir.join(".scratch"),
        timestamp,
        None,
    )
}

/// Build a publish plan by diffing `dirty_dir` against `master_dir`, writing
/// plan files under an explicit `scratch_dir`.
pub fn build_publish_plan_with_scratch_dir(
    conn_name: &str,
    connection_id: &str,
    dirty_dir: &Path,
    master_dir: &Path,
    db_path: &Path,
    scratch_dir: &Path,
    timestamp: &str,
    filter: Option<&str>,
) -> anyhow::Result<Option<PlanResult>> {
    // 1. Collect files (skip .scratch and .git dirs)
    let master_files = collect_files(master_dir)?;
    let dirty_files = collect_files(dirty_dir)?;

    // 2. Classify raw diff
    let mut modified: Vec<String> = vec![];
    let mut added: Vec<String> = vec![];
    let mut deleted: Vec<String> = vec![];

    for (rel, dirty_content) in &dirty_files {
        match master_files.get(rel) {
            None => added.push(rel.clone()),
            Some(master_content) if dirty_content != master_content => modified.push(rel.clone()),
            _ => {}
        }
    }
    for rel in master_files.keys() {
        if !dirty_files.contains_key(rel) {
            deleted.push(rel.clone());
        }
    }

    // Apply optional path filter
    if let Some(filter_path) = filter {
        modified.retain(|r| r == filter_path);
        added.retain(|r| r == filter_path);
        deleted.retain(|r| r == filter_path);
    }

    if modified.is_empty() && added.is_empty() && deleted.is_empty() {
        return Ok(None);
    }

    // 3. Extract deleted remote IDs (from file content or index.db)
    let deleted_remote_ids = build_deleted_remote_ids(&deleted, &master_files, db_path);
    let deleted_id_set: HashSet<String> = deleted_remote_ids.values().cloned().collect();

    // 4. Find ref-clearing candidates from file_references index
    let ref_clear_candidates: HashSet<String> = if db_path.exists() && !deleted_id_set.is_empty() {
        query_ref_clear_candidates(db_path, &deleted_id_set).unwrap_or_default()
    } else {
        HashSet::new()
    };

    // 5. Build edit set: modified files + ref-clearing candidates
    let mut edit_set: HashSet<String> = modified.iter().cloned().collect();
    for candidate in &ref_clear_candidates {
        edit_set.insert(candidate.clone());
    }

    // 6. Schema cache: folder -> FK paths
    let mut schema_cache: HashMap<String, Vec<FkPath>> = HashMap::new();

    // 7. Build plan entries
    let mut entries: Vec<PlanEntry> = vec![];

    // --- Edit phase ---
    for rel_path in &edit_set {
        let folder = folder_of(rel_path);

        let dirty_content_str = dirty_files
            .get(rel_path)
            .or_else(|| master_files.get(rel_path));
        let dirty_content_str = match dirty_content_str {
            Some(s) => s,
            None => continue,
        };
        let master_content_str = match master_files.get(rel_path) {
            Some(s) => s,
            None => continue,
        };

        let dirty_val: Value = match serde_json::from_str(dirty_content_str) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let master_val: Value = match serde_json::from_str(master_content_str) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let fk_paths = get_schema_fk_paths(&folder, master_dir, &mut schema_cache);

        let pass1 = strip_deleted_refs(&dirty_val, fk_paths, &deleted_id_set);
        let pass2 = strip_pseudo_refs(&pass1, fk_paths);
        let pass3 = strip_asset_pseudo_refs(&pass2);

        let changed = compute_changed_fields(&master_val, &pass3);
        if !is_empty_object(&changed) {
            entries.push(PlanEntry {
                rel_path: rel_path.clone(),
                phase: Phase::Edit,
                content: pass3.clone(),
                changed_fields: Some(changed),
            });
        }

        // Backfill: if pass 2 or 3 stripped anything, restore after creates resolve IDs
        if values_differ(&pass3, &pass1) {
            let backfill_changed = compute_changed_fields(&pass3, &pass1);
            entries.push(PlanEntry {
                rel_path: rel_path.clone(),
                phase: Phase::Backfill,
                content: pass1.clone(),
                changed_fields: Some(backfill_changed),
            });
        }
    }

    // --- Create phase ---
    for rel_path in &added {
        let folder = folder_of(rel_path);
        let filename = filename_of(rel_path);

        let dirty_content_str = match dirty_files.get(rel_path) {
            Some(s) => s,
            None => continue,
        };
        let dirty_val: Value = match serde_json::from_str(dirty_content_str) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let fk_paths = get_schema_fk_paths(&folder, master_dir, &mut schema_cache);

        let pass1 = strip_deleted_refs(&dirty_val, fk_paths, &deleted_id_set);
        let pass2 = strip_pseudo_refs(&pass1, fk_paths);
        let pass3 = strip_asset_pseudo_refs(&pass2);

        entries.push(PlanEntry {
            rel_path: rel_path.clone(),
            phase: Phase::Create,
            content: pass3.clone(),
            changed_fields: None,
        });

        if filename.starts_with("scratch_pending_") {
            entries.push(PlanEntry {
                rel_path: rel_path.clone(),
                phase: Phase::Rename,
                content: json!({}),
                changed_fields: None,
            });
        }

        if values_differ(&pass3, &pass1) {
            entries.push(PlanEntry {
                rel_path: rel_path.clone(),
                phase: Phase::Backfill,
                content: pass1.clone(),
                changed_fields: None,
            });
        }
    }

    // --- Delete phase ---
    for rel_path in &deleted {
        let remote_id = deleted_remote_ids
            .get(rel_path)
            .cloned()
            .unwrap_or_default();
        entries.push(PlanEntry {
            rel_path: rel_path.clone(),
            phase: Phase::Delete,
            content: json!({ "remoteId": remote_id }),
            changed_fields: None,
        });
    }

    if entries.is_empty() {
        return Ok(None);
    }

    // 8. Count phases
    let summary = PlanSummary {
        edit: entries.iter().filter(|e| e.phase == Phase::Edit).count(),
        create: entries.iter().filter(|e| e.phase == Phase::Create).count(),
        delete: entries.iter().filter(|e| e.phase == Phase::Delete).count(),
        backfill: entries
            .iter()
            .filter(|e| e.phase == Phase::Backfill)
            .count(),
        rename: entries.iter().filter(|e| e.phase == Phase::Rename).count(),
    };

    // 9. Build per-folder reports
    let folder_reports =
        build_folder_reports(&entries, &modified, &added, &deleted, &ref_clear_candidates);

    // 10. Write plan files.
    cleanup_old_plan_dirs(scratch_dir);
    let manifest_dir = scratch_dir.join(".publish-plans");
    if manifest_dir.exists() {
        for old in std::fs::read_dir(&manifest_dir)?.flatten() {
            if old.path().is_dir() {
                std::fs::remove_dir_all(old.path())?;
            }
        }
    }

    // Collect unique table paths for the manifest
    let mut table_paths: Vec<String> = entries
        .iter()
        .map(|e| split_path(&e.rel_path).0)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    table_paths.sort();

    for entry in &entries {
        let (folder, filename) = split_path(&entry.rel_path);
        let plan_base = if folder.is_empty() {
            scratch_dir.to_path_buf()
        } else {
            scratch_dir.join(&folder)
        };
        let phase_dir = plan_base
            .join(format!("publish-plan-{}", timestamp))
            .join(entry.phase.dir_name());
        std::fs::create_dir_all(&phase_dir)?;
        let file_value = match (entry.phase, &entry.changed_fields) {
            (Phase::Edit | Phase::Backfill, Some(cf)) => {
                json!({ "content": entry.content, "changedFields": cf })
            }
            _ => entry.content.clone(),
        };
        std::fs::write(
            phase_dir.join(&filename),
            serde_json::to_string_pretty(&file_value)?,
        )?;
    }

    // 11. Write plan.json manifest
    let plan_root = manifest_dir.join(timestamp);
    std::fs::create_dir_all(&plan_root)?;
    let meta = PlanMeta {
        plan_id: timestamp.to_string(),
        created_at: now_iso8601(),
        connection_name: conn_name.to_string(),
        connection_id: connection_id.to_string(),
        summary,
        table_paths,
    };
    std::fs::write(
        plan_root.join("plan.json"),
        serde_json::to_string_pretty(&meta)?,
    )?;

    Ok(Some(PlanResult {
        meta,
        folder_reports,
    }))
}

// ---------------------------------------------------------------------------
// Folder reports
// ---------------------------------------------------------------------------

fn build_folder_reports(
    entries: &[PlanEntry],
    modified: &[String],
    added: &[String],
    deleted: &[String],
    ref_clear_candidates: &HashSet<String>,
) -> Vec<FolderReport> {
    let folders: Vec<String> = entries
        .iter()
        .map(|e| folder_of(&e.rel_path))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    folders
        .into_iter()
        .map(|folder| FolderReport {
            raw_modified: modified.iter().filter(|r| folder_of(r) == folder).count(),
            raw_added: added.iter().filter(|r| folder_of(r) == folder).count(),
            raw_deleted: deleted.iter().filter(|r| folder_of(r) == folder).count(),
            raw_ref_clear: ref_clear_candidates
                .iter()
                .filter(|r| folder_of(r) == folder)
                .count(),
            plan_edit: entries
                .iter()
                .filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Edit)
                .count(),
            plan_create: entries
                .iter()
                .filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Create)
                .count(),
            plan_delete: entries
                .iter()
                .filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Delete)
                .count(),
            plan_backfill: entries
                .iter()
                .filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Backfill)
                .count(),
            plan_rename: entries
                .iter()
                .filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Rename)
                .count(),
            folder,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Schema loading and FK path extraction
// ---------------------------------------------------------------------------

fn get_schema_fk_paths<'a>(
    folder: &str,
    master_dir: &Path,
    cache: &'a mut HashMap<String, Vec<FkPath>>,
) -> &'a [FkPath] {
    if !cache.contains_key(folder) {
        let schema_path = master_dir.join(".scratch").join(folder).join("schema.json");

        let fk_paths = if schema_path.exists() {
            std::fs::read_to_string(&schema_path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .map(|outer| {
                    let schema = outer.get("schema").unwrap_or(&outer).clone();
                    extract_fk_paths(&schema)
                })
                .unwrap_or_default()
        } else {
            vec![]
        };

        cache.insert(folder.to_string(), fk_paths);
    }
    cache.get(folder).map(|v| v.as_slice()).unwrap_or(&[])
}

fn extract_fk_paths(schema: &Value) -> Vec<FkPath> {
    let mut result = vec![];
    extract_fk_paths_rec(schema, &[], &mut result);
    result
}

fn extract_fk_paths_rec(schema: &Value, path: &[String], out: &mut Vec<FkPath>) {
    if let Some(fk) = schema.get("x-scratch-foreign-key") {
        if let Some(id) = fk.get("linkedTableId").and_then(|v| v.as_str()) {
            out.push(FkPath {
                path: path.to_vec(),
                _target_table_id: id.to_string(),
            });
        }
    }

    if let Some(props) = schema.get("properties").and_then(|v| v.as_object()) {
        for (key, child) in props {
            let mut child_path = path.to_vec();
            child_path.push(key.clone());
            extract_fk_paths_rec(child, &child_path, out);
        }
    }

    if let Some(items) = schema.get("items") {
        if items.is_object() && !items.is_null() {
            let mut items_path = path.to_vec();
            items_path.push("[]".to_string());
            extract_fk_paths_rec(items, &items_path, out);
        }
    }

    for combinator in &["oneOf", "anyOf", "allOf"] {
        if let Some(arr) = schema.get(combinator).and_then(|v| v.as_array()) {
            for variant in arr {
                extract_fk_paths_rec(variant, path, out);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Three-pass stripping
// ---------------------------------------------------------------------------

fn strip_deleted_refs(value: &Value, fk_paths: &[FkPath], deleted_ids: &HashSet<String>) -> Value {
    if deleted_ids.is_empty() || fk_paths.is_empty() {
        return value.clone();
    }
    let mut result = value.clone();
    for fk in fk_paths {
        strip_at_path(&mut result, &fk.path, &|v: &Value| {
            v.as_str().map(|s| deleted_ids.contains(s)).unwrap_or(false)
        });
    }
    result
}

fn strip_pseudo_refs(value: &Value, fk_paths: &[FkPath]) -> Value {
    if fk_paths.is_empty() {
        return value.clone();
    }
    let mut result = value.clone();
    for fk in fk_paths {
        strip_at_path(&mut result, &fk.path, &|v: &Value| {
            v.as_str().map(|s| s.starts_with("@/")).unwrap_or(false)
        });
    }
    result
}

fn strip_asset_pseudo_refs(value: &Value) -> Value {
    match value {
        Value::String(s) => {
            if s.starts_with("@asset/") {
                Value::Null
            } else {
                value.clone()
            }
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .filter(|item| {
                    !item
                        .as_str()
                        .map(|s| s.starts_with("@asset/"))
                        .unwrap_or(false)
                })
                .map(strip_asset_pseudo_refs)
                .collect(),
        ),
        Value::Object(obj) => Value::Object(
            obj.iter()
                .map(|(k, v)| (k.clone(), strip_asset_pseudo_refs(v)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn strip_at_path(value: &mut Value, path: &[String], predicate: &impl Fn(&Value) -> bool) {
    if path.is_empty() {
        check_and_strip_inplace(value, predicate);
        return;
    }

    let key = &path[0];
    let rest = &path[1..];

    if key == "[]" {
        if rest.is_empty() {
            check_and_strip_inplace(value, predicate);
        } else if let Value::Array(arr) = value {
            for item in arr.iter_mut() {
                strip_at_path(item, rest, predicate);
            }
        }
        return;
    }

    if let Value::Object(obj) = value {
        if let Some(child) = obj.get_mut(key.as_str()) {
            strip_at_path(child, rest, predicate);
        }
    }
}

fn check_and_strip_inplace(value: &mut Value, predicate: &impl Fn(&Value) -> bool) {
    match value {
        Value::Array(arr) => {
            arr.retain(|item| !predicate(item));
        }
        _ => {
            if predicate(value) {
                *value = Value::Null;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Changed fields computation
// ---------------------------------------------------------------------------

fn compute_changed_fields(master: &Value, dirty: &Value) -> Value {
    match (master, dirty) {
        (Value::Object(m), Value::Object(d)) => {
            let mut result = serde_json::Map::new();
            for (key, dirty_val) in d {
                let master_val = m.get(key.as_str()).unwrap_or(&Value::Null);
                if let (Value::Object(_), Value::Object(_)) = (master_val, dirty_val) {
                    let nested = compute_changed_fields(master_val, dirty_val);
                    if !is_empty_object(&nested) {
                        result.insert(key.clone(), nested);
                    }
                } else if master_val.to_string() != dirty_val.to_string() {
                    result.insert(key.clone(), dirty_val.clone());
                }
            }
            Value::Object(result)
        }
        _ => Value::Null,
    }
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

fn build_deleted_remote_ids(
    deleted: &[String],
    master_files: &HashMap<String, String>,
    db_path: &Path,
) -> HashMap<String, String> {
    let mut result = HashMap::new();

    for rel in deleted {
        if let Some(content_str) = master_files.get(rel) {
            if let Ok(val) = serde_json::from_str::<Value>(content_str) {
                if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                    result.insert(rel.clone(), id.to_string());
                    continue;
                }
            }
        }

        if db_path.exists() {
            let (folder, filename) = split_path(rel);
            if let Ok(db) = Connection::open(db_path) {
                let query = db.query_row(
                    "SELECT remote_id FROM file_index WHERE folder = ?1 AND filename = ?2",
                    rusqlite::params![folder, filename],
                    |row| row.get::<_, Option<String>>(0),
                );
                if let Ok(Some(id)) = query {
                    result.insert(rel.clone(), id);
                }
            }
        }
    }

    result
}

fn query_ref_clear_candidates(
    db_path: &Path,
    deleted_ids: &HashSet<String>,
) -> anyhow::Result<HashSet<String>> {
    let db =
        Connection::open(db_path).map_err(|e| anyhow::anyhow!("failed to open index.db: {e}"))?;

    let exists: bool = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='file_references'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);

    if !exists {
        return Ok(HashSet::new());
    }

    let mut candidates = HashSet::new();

    for id in deleted_ids {
        let mut stmt = db.prepare(
            "SELECT source_folder, source_filename FROM file_references WHERE target_remote_id = ?1",
        ).map_err(|e| anyhow::anyhow!("query failed: {e}"))?;

        let rows = stmt
            .query_map(rusqlite::params![id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| anyhow::anyhow!("query failed: {e}"))?;

        for row in rows {
            let (folder, filename) = row.map_err(|e| anyhow::anyhow!("{e}"))?;
            let rel = if folder.is_empty() {
                filename
            } else {
                format!("{folder}/{filename}")
            };
            candidates.insert(rel);
        }
    }

    Ok(candidates)
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

fn collect_files(root: &Path) -> anyhow::Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    collect_files_rec(root, root, &mut map)?;
    Ok(map)
}

fn collect_files_rec(
    root: &Path,
    dir: &Path,
    map: &mut HashMap<String, String>,
) -> anyhow::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if path.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            collect_files_rec(root, &path, map)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if name == "schema.json" {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            if let Ok(content) = std::fs::read_to_string(&path) {
                map.insert(rel, content);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

pub fn folder_of(rel_path: &str) -> String {
    match rel_path.rfind('/') {
        Some(i) => rel_path[..i].to_string(),
        None => String::new(),
    }
}

pub fn filename_of(rel_path: &str) -> String {
    match rel_path.rfind('/') {
        Some(i) => rel_path[i + 1..].to_string(),
        None => rel_path.to_string(),
    }
}

fn split_path(rel_path: &str) -> (String, String) {
    (folder_of(rel_path), filename_of(rel_path))
}

fn is_empty_object(v: &Value) -> bool {
    v.as_object().map(|o| o.is_empty()).unwrap_or(true)
}

fn values_differ(a: &Value, b: &Value) -> bool {
    a.to_string() != b.to_string()
}

pub fn now_compact() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = unix_to_parts(secs);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = unix_to_parts(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Recursively remove all `publish-plan-*` dirs found anywhere under `scratch_dir`.
pub fn cleanup_old_plan_dirs(scratch_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(scratch_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if name_str.starts_with("publish-plan-") {
            let _ = std::fs::remove_dir_all(entry.path());
        } else if !name_str.starts_with('.') {
            cleanup_old_plan_dirs(&entry.path());
        }
    }
}

fn unix_to_parts(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let total_min = secs / 60;
    let mi = total_min % 60;
    let total_h = total_min / 60;
    let h = total_h % 24;
    let total_days = total_h / 24;
    let z = total_days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    (y, mo, d, h, mi, s)
}
