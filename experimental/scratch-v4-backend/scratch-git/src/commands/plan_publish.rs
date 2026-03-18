//! `scratchmdv4 plan-publish` — full publish plan with FK stripping, backfill, and rename.
//!
//! Plan phases mirror the production server:
//!   edit      — update existing record (stripped dirty content + changedFields)
//!   create    — create new record (stripped dirty content)
//!   delete    — delete record ({} placeholder, remote ID in plan.json)
//!   backfill  — re-update after creates resolve pending IDs (pass-1 content)
//!   rename    — rename scratch_pending_* → real filename after create
//!
//! Stripping passes (applied to every edit and create file):
//!   Pass 1: strip FK refs to deleted records (using x-scratch-foreign-key schema annotations)
//!   Pass 2: strip @/ pseudo-refs (references to pending new records)
//!   Pass 3: strip @asset/ pseudo-refs (schema-agnostic)
//!
//! Ref-clearing: files not modified by the user but referencing a deleted record
//! are found via the file_references SQLite index and added to the edit phase.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{Error, Result};
use super::resolve_workspace;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct Args {
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,
}

// ---------------------------------------------------------------------------
// Plan metadata (plan.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanMeta {
    plan_id: String,
    created_at: String,
    connection_name: String,
    connection_id: String,
    summary: PlanSummary,
    /// rel_path → remote_id for deleted files (execute needs this; master file is gone)
    delete_index: HashMap<String, String>,
    /// rel_path → sparse changed-fields object (for efficient PATCH)
    changed_fields: HashMap<String, Value>,
    /// phase name → list of rel_paths in that phase (so NestJS can read plan files without traversing the tree)
    entries: HashMap<String, Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PlanSummary {
    edit: usize,
    create: usize,
    delete: usize,
    backfill: usize,
    rename: usize,
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Edit,
    Create,
    Delete,
    Backfill,
    Rename,
}

impl Phase {
    fn dir_name(self) -> &'static str {
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

/// A foreign-key field path extracted from a schema.
#[derive(Debug, Clone)]
struct FkPath {
    /// Path segments in the record content, e.g. ["fields", "authors"] or ["items", "[]", "ref"].
    path: Vec<String>,
    /// The linkedTableId value from x-scratch-foreign-key.
    target_table_id: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;
    let connections_dir = workspace.join(".scratch/connections");

    if !connections_dir.exists() {
        return Err(Error::Other(format!(
            "connections directory not found at {}. Run `scratchmdv4 pull` first.",
            connections_dir.display()
        )));
    }

    let timestamp = now_compact();
    let mut any_changes = false;

    for entry in std::fs::read_dir(&connections_dir)? {
        let entry = entry?;
        let conn_scratch_dir = entry.path();
        if !conn_scratch_dir.is_dir() { continue; }

        let conn_name = conn_scratch_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        let master_dir = conn_scratch_dir.join("master");
        let dirty_dir = workspace.join(&conn_name);

        if !master_dir.exists() || !dirty_dir.exists() { continue; }

        let connection_id = std::fs::read_to_string(conn_scratch_dir.join("id"))
            .unwrap_or_default().trim().to_string();

        let db_path = conn_scratch_dir.join("index.db");

        match plan_connection(
            &conn_name,
            &connection_id,
            &master_dir,
            &dirty_dir,
            &conn_scratch_dir,
            &db_path,
            &timestamp,
        ) {
            Ok(true) => any_changes = true,
            Ok(false) => {}
            Err(e) => {
                eprintln!("  {conn_name}: planning error: {e}");
            }
        }
    }

    if !any_changes {
        println!("\nNothing to publish — all connections are in sync.");
    } else {
        println!("\nNext: scratchmdv4 execute-publish (see PUBLISH_NEXT_STEPS.md)");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Per-connection planning
// ---------------------------------------------------------------------------

fn plan_connection(
    conn_name: &str,
    connection_id: &str,
    master_dir: &Path,
    dirty_dir: &Path,
    conn_scratch_dir: &Path,
    db_path: &Path,
    timestamp: &str,
) -> Result<bool> {
    // 1. Collect files
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

    if modified.is_empty() && added.is_empty() && deleted.is_empty() {
        println!("  {conn_name}: nothing to publish");
        return Ok(false);
    }

    // 3. Extract deleted remote IDs (from file content or index.db)
    let deleted_remote_ids: HashMap<String, String> = build_deleted_remote_ids(
        &deleted, &master_files, db_path,
    );
    let deleted_id_set: HashSet<String> = deleted_remote_ids.values().cloned().collect();

    // 4. Find ref-clearing candidates from file_references index
    let ref_clear_candidates: HashSet<String> = if db_path.exists() && !deleted_id_set.is_empty() {
        query_ref_clear_candidates(db_path, &deleted_id_set)
            .unwrap_or_default()
    } else {
        HashSet::new()
    };

    // 5. Build edit set: modified files + ref-clearing candidates
    let mut edit_set: HashSet<String> = modified.iter().cloned().collect();
    for candidate in &ref_clear_candidates {
        edit_set.insert(candidate.clone());
    }

    // 6. Load schema cache (folder → FK paths)
    let mut schema_cache: HashMap<String, Vec<FkPath>> = HashMap::new();

    // 7. Build plan entries
    let mut entries: Vec<PlanEntry> = vec![];
    let mut changed_fields_map: HashMap<String, Value> = HashMap::new();

    // --- Edit phase ---
    for rel_path in &edit_set {
        let folder = folder_of(rel_path);

        // Read dirty content; fall back to master for ref-clear-only files
        let dirty_content_str = dirty_files.get(rel_path)
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
            Ok(v) => v, Err(_) => continue,
        };
        let master_val: Value = match serde_json::from_str(master_content_str) {
            Ok(v) => v, Err(_) => continue,
        };

        let fk_paths = get_schema_fk_paths(&folder, conn_scratch_dir, &mut schema_cache);

        let pass1 = strip_deleted_refs(&dirty_val, fk_paths, &deleted_id_set);
        let pass2 = strip_pseudo_refs(&pass1, fk_paths);
        let pass3 = strip_asset_pseudo_refs(&pass2);

        // Only emit edit if something actually changed vs master
        let changed = compute_changed_fields(&master_val, &pass3);
        if !is_empty_object(&changed) {
            let _filename = filename_of(rel_path);
            changed_fields_map.insert(rel_path.clone(), changed.clone());
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
            Some(s) => s, None => continue,
        };
        let dirty_val: Value = match serde_json::from_str(dirty_content_str) {
            Ok(v) => v, Err(_) => continue,
        };

        let fk_paths = get_schema_fk_paths(&folder, conn_scratch_dir, &mut schema_cache);

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
        entries.push(PlanEntry {
            rel_path: rel_path.clone(),
            phase: Phase::Delete,
            content: json!({}),
            changed_fields: None,
        });
    }

    if entries.is_empty() {
        println!("  {conn_name}: nothing to publish (all changes were no-ops after stripping)");
        return Ok(false);
    }

    // 8. Count phases
    let summary = PlanSummary {
        edit:     entries.iter().filter(|e| e.phase == Phase::Edit).count(),
        create:   entries.iter().filter(|e| e.phase == Phase::Create).count(),
        delete:   entries.iter().filter(|e| e.phase == Phase::Delete).count(),
        backfill: entries.iter().filter(|e| e.phase == Phase::Backfill).count(),
        rename:   entries.iter().filter(|e| e.phase == Phase::Rename).count(),
    };

    // 9. Report
    println!("  {conn_name}");
    report_by_folder(conn_name, &entries, &modified, &added, &deleted, &ref_clear_candidates);

    // 10. Write plan files
    let plan_root = dirty_dir.join(format!(".scratch/publish-plans/{timestamp}"));
    std::fs::create_dir_all(&plan_root)?;

    for entry in &entries {
        let (folder, filename) = split_path(&entry.rel_path);
        let phase_dir = if folder.is_empty() {
            plan_root.join(entry.phase.dir_name())
        } else {
            plan_root.join(&folder).join(entry.phase.dir_name())
        };
        std::fs::create_dir_all(&phase_dir)?;

        let content_str = if entry.phase == Phase::Edit || entry.phase == Phase::Backfill {
            // Include changedFields as a comment-like wrapper? No — just write the content.
            // changedFields is stored in plan.json.
            serde_json::to_string_pretty(&entry.content)?
        } else {
            serde_json::to_string_pretty(&entry.content)?
        };
        std::fs::write(phase_dir.join(&filename), content_str)?;
    }

    // 11. Write plan.json
    let mut entries_map: HashMap<String, Vec<String>> = HashMap::new();
    for entry in &entries {
        entries_map
            .entry(entry.phase.dir_name().to_string())
            .or_default()
            .push(entry.rel_path.clone());
    }

    let meta = PlanMeta {
        plan_id: timestamp.to_string(),
        created_at: now_iso8601(),
        connection_name: conn_name.to_string(),
        connection_id: connection_id.to_string(),
        summary,
        delete_index: deleted_remote_ids,
        changed_fields: changed_fields_map,
        entries: entries_map,
    };
    std::fs::write(plan_root.join("plan.json"), serde_json::to_string_pretty(&meta)?)?;

    println!("  → {}", plan_root.display());

    Ok(true)
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

fn report_by_folder(
    _conn_name: &str,
    entries: &[PlanEntry],
    modified: &[String],
    added: &[String],
    deleted: &[String],
    ref_clear_candidates: &HashSet<String>,
) {
    // Gather all folders involved
    let folders: Vec<String> = entries.iter()
        .map(|e| folder_of(&e.rel_path))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    for folder in folders {
        let label = if folder.is_empty() { "(root)".to_string() } else { folder.clone() };

        // Raw diff for this folder
        let raw_modified = modified.iter().filter(|r| folder_of(r) == folder).count();
        let raw_added    = added.iter().filter(|r| folder_of(r) == folder).count();
        let raw_deleted  = deleted.iter().filter(|r| folder_of(r) == folder).count();
        let raw_ref_clear = ref_clear_candidates.iter().filter(|r| folder_of(r) == folder).count();

        // Plan phases for this folder
        let plan_edit     = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Edit).count();
        let plan_create   = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Create).count();
        let plan_delete   = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Delete).count();
        let plan_backfill = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Backfill).count();
        let plan_rename   = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Rename).count();

        // Build raw summary string
        let mut raw_parts = vec![];
        if raw_modified  > 0 { raw_parts.push(format!("{raw_modified} modified")); }
        if raw_added     > 0 { raw_parts.push(format!("{raw_added} added")); }
        if raw_deleted   > 0 { raw_parts.push(format!("{raw_deleted} deleted")); }
        if raw_ref_clear > 0 { raw_parts.push(format!("{raw_ref_clear} ref-clear")); }

        // Build plan summary string
        let mut plan_parts = vec![];
        if plan_edit     > 0 { plan_parts.push(format!("{plan_edit} edit")); }
        if plan_create   > 0 { plan_parts.push(format!("{plan_create} create")); }
        if plan_delete   > 0 { plan_parts.push(format!("{plan_delete} delete")); }
        if plan_backfill > 0 { plan_parts.push(format!("{plan_backfill} backfill")); }
        if plan_rename   > 0 { plan_parts.push(format!("{plan_rename} rename")); }

        let raw_str  = if raw_parts.is_empty()  { "no changes".to_string() } else { raw_parts.join(", ") };
        let plan_str = if plan_parts.is_empty() { "no ops".to_string()      } else { plan_parts.join(", ") };

        println!("    {label}  ({raw_str})  →  ({plan_str})");
    }
}

// ---------------------------------------------------------------------------
// Schema loading and FK path extraction
// ---------------------------------------------------------------------------

fn get_schema_fk_paths<'a>(
    folder: &str,
    conn_scratch_dir: &Path,
    cache: &'a mut HashMap<String, Vec<FkPath>>,
) -> &'a [FkPath] {
    if !cache.contains_key(folder) {
        let schema_path = conn_scratch_dir
            .join("master")
            .join(".scratch")
            .join(folder)
            .join("schema.json");

        let fk_paths = if schema_path.exists() {
            std::fs::read_to_string(&schema_path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .map(|schema| extract_fk_paths(&schema))
                .unwrap_or_default()
        } else {
            vec![]
        };

        cache.insert(folder.to_string(), fk_paths);
    }
    cache.get(folder).map(|v| v.as_slice()).unwrap_or(&[])
}

/// Walk the schema tree extracting all fields annotated with x-scratch-foreign-key.
fn extract_fk_paths(schema: &Value) -> Vec<FkPath> {
    let mut result = vec![];
    extract_fk_paths_rec(schema, &[], &mut result);
    result
}

fn extract_fk_paths_rec(schema: &Value, path: &[String], out: &mut Vec<FkPath>) {
    // If this node has x-scratch-foreign-key, record it
    if let Some(fk) = schema.get("x-scratch-foreign-key") {
        if let Some(id) = fk.get("linkedTableId").and_then(|v| v.as_str()) {
            out.push(FkPath { path: path.to_vec(), target_table_id: id.to_string() });
        }
    }

    // Recurse into properties
    if let Some(props) = schema.get("properties").and_then(|v| v.as_object()) {
        for (key, child) in props {
            let mut child_path = path.to_vec();
            child_path.push(key.clone());
            extract_fk_paths_rec(child, &child_path, out);
        }
    }

    // Recurse into array items (add [] segment)
    if let Some(items) = schema.get("items") {
        if items.is_object() && !items.is_null() {
            let mut items_path = path.to_vec();
            items_path.push("[]".to_string());
            extract_fk_paths_rec(items, &items_path, out);
        }
    }

    // Recurse into schema combinators
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

/// Pass 1: Strip FK refs whose target ID is in `deleted_ids`.
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

/// Pass 2: Strip @/ pseudo-refs (references to pending new records).
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

/// Pass 3: Strip @asset/ pseudo-refs — schema-agnostic, walks entire tree.
fn strip_asset_pseudo_refs(value: &Value) -> Value {
    match value {
        Value::String(s) => {
            if s.starts_with("@asset/") { Value::Null } else { value.clone() }
        }
        Value::Array(arr) => {
            Value::Array(
                arr.iter()
                    .filter(|item| !item.as_str().map(|s| s.starts_with("@asset/")).unwrap_or(false))
                    .map(strip_asset_pseudo_refs)
                    .collect(),
            )
        }
        Value::Object(obj) => {
            Value::Object(
                obj.iter()
                    .map(|(k, v)| (k.clone(), strip_asset_pseudo_refs(v)))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

/// Recursively follow `path` into `value`, applying check-and-strip at the leaf.
/// Mutates `value` in place.
fn strip_at_path(value: &mut Value, path: &[String], predicate: &impl Fn(&Value) -> bool) {
    if path.is_empty() {
        check_and_strip_inplace(value, predicate);
        return;
    }

    let key = &path[0];
    let rest = &path[1..];

    if key == "[]" {
        if rest.is_empty() {
            // Terminal [] segment: filter matching elements from the array.
            // check_and_strip_inplace on an Array retains elements where predicate is false.
            check_and_strip_inplace(value, predicate);
        } else {
            // Non-terminal [] segment: recurse into each array element with remaining path.
            if let Value::Array(arr) = value {
                for item in arr.iter_mut() {
                    strip_at_path(item, rest, predicate);
                }
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

/// At a leaf: filter matching items from arrays, null-out matching scalars.
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

/// Returns a sparse object containing only the keys that differ between master and dirty.
/// Recurses into plain objects; compares arrays and scalars atomically via JSON string.
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
                } else {
                    // Compare atomically
                    if master_val.to_string() != dirty_val.to_string() {
                        result.insert(key.clone(), dirty_val.clone());
                    }
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

/// Build a map of rel_path → remote_id for all deleted files.
/// Uses content `id` field first; falls back to index.db if available.
fn build_deleted_remote_ids(
    deleted: &[String],
    master_files: &HashMap<String, String>,
    db_path: &Path,
) -> HashMap<String, String> {
    let mut result = HashMap::new();

    // Primary: extract `id` from master file content
    for rel in deleted {
        if let Some(content_str) = master_files.get(rel) {
            if let Ok(val) = serde_json::from_str::<Value>(content_str) {
                if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                    result.insert(rel.clone(), id.to_string());
                    continue;
                }
            }
        }

        // Fallback: query index.db
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

/// Query file_references for files that reference any of the deleted remote IDs.
/// Returns a set of rel_paths (folder/filename) that need ref-clearing edits.
fn query_ref_clear_candidates(
    db_path: &Path,
    deleted_ids: &HashSet<String>,
) -> Result<HashSet<String>> {
    let db = Connection::open(db_path)
        .map_err(|e| Error::Other(format!("failed to open index.db: {e}")))?;

    // Check table exists
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

    // SQLite doesn't support binding a dynamic IN list directly, so we query per ID.
    // For small sets (typical publish batches) this is fine.
    for id in deleted_ids {
        let mut stmt = db.prepare(
            "SELECT source_folder, source_filename FROM file_references WHERE target_remote_id = ?1",
        ).map_err(|e| Error::Other(format!("query failed: {e}")))?;

        let rows = stmt.query_map(rusqlite::params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| Error::Other(format!("query failed: {e}")))?;

        for row in rows {
            let (folder, filename) = row.map_err(|e| Error::Other(e.to_string()))?;
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

fn collect_files(root: &Path) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    collect_files_rec(root, root, &mut map)?;
    Ok(map)
}

fn collect_files_rec(root: &Path, dir: &Path, map: &mut HashMap<String, String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if path.is_dir() {
            if name == ".scratch" || name == ".git" { continue; }
            collect_files_rec(root, &path, map)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
            map.insert(rel, std::fs::read_to_string(&path)?);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

fn folder_of(rel_path: &str) -> String {
    match rel_path.rfind('/') {
        Some(i) => rel_path[..i].to_string(),
        None => String::new(),
    }
}

fn filename_of(rel_path: &str) -> String {
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

fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = unix_to_parts(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn now_compact() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = unix_to_parts(secs);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
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

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;
    use tempfile::TempDir;

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    /// Create the workspace directory skeleton for a single connection and return
    /// (tmp_guard, conn_scratch_dir, master_dir, dirty_dir, db_path).
    fn make_workspace(conn: &str) -> (TempDir, PathBuf, PathBuf, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();

        let conn_scratch = root.join(".scratch/connections").join(conn);
        let master_dir = conn_scratch.join("master");
        let dirty_dir = root.join(conn);
        let db_path = conn_scratch.join("index.db");

        std::fs::create_dir_all(&master_dir).unwrap();
        std::fs::create_dir_all(&dirty_dir).unwrap();
        std::fs::write(conn_scratch.join("id"), "conn_test_id").unwrap();

        (tmp, conn_scratch, master_dir, dirty_dir, db_path)
    }

    fn write_json(dir: &Path, rel: &str, v: &Value) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(v).unwrap()).unwrap();
    }

    /// Write a schema.json for `folder` inside `conn_scratch/master/.scratch/{folder}/`.
    fn write_schema(conn_scratch: &Path, folder: &str, schema: &Value) {
        let path = conn_scratch.join("master/.scratch").join(folder).join("schema.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(schema).unwrap()).unwrap();
    }

    /// Initialise a minimal index.db (both tables) at db_path.
    fn init_index_db(db_path: &Path) -> rusqlite::Connection {
        let db = rusqlite::Connection::open(db_path).unwrap();
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS file_index (
                folder TEXT NOT NULL,
                filename TEXT NOT NULL,
                remote_id TEXT,
                PRIMARY KEY (folder, filename)
             );
             CREATE TABLE IF NOT EXISTS file_references (
                source_folder TEXT NOT NULL,
                source_filename TEXT NOT NULL,
                target_table_id TEXT NOT NULL,
                target_remote_id TEXT NOT NULL
             );",
        ).unwrap();
        db
    }

    fn insert_file_ref(db: &rusqlite::Connection, src_folder: &str, src_file: &str, tgt_table: &str, tgt_id: &str) {
        db.execute(
            "INSERT INTO file_references (source_folder, source_filename, target_table_id, target_remote_id)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![src_folder, src_file, tgt_table, tgt_id],
        ).unwrap();
    }

    fn insert_file_index(db: &rusqlite::Connection, folder: &str, filename: &str, remote_id: &str) {
        db.execute(
            "INSERT OR REPLACE INTO file_index (folder, filename, remote_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![folder, filename, remote_id],
        ).unwrap();
    }

    /// Find the single plan dir written under dirty_dir/.scratch/publish-plans/
    fn find_plan_dir(dirty_dir: &Path) -> PathBuf {
        let plans_root = dirty_dir.join(".scratch/publish-plans");
        std::fs::read_dir(&plans_root).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.is_dir())
            .expect("no plan dir found")
    }

    fn read_plan_meta(plan_dir: &Path) -> PlanMeta {
        let s = std::fs::read_to_string(plan_dir.join("plan.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    /// Read a plan file at `plan_dir/{folder}/{phase}/{filename}`.
    /// For root-level files (no folder): `plan_dir/{phase}/{filename}`.
    fn read_plan_file(plan_dir: &Path, phase: &str, rel: &str) -> Value {
        let (folder, file) = (folder_of(rel), filename_of(rel));
        let path = if folder.is_empty() {
            plan_dir.join(phase).join(&file)
        } else {
            plan_dir.join(&folder).join(phase).join(&file)
        };
        let s = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("plan file not found: {}", path.display()));
        serde_json::from_str(&s).unwrap()
    }

    fn plan_file_exists(plan_dir: &Path, phase: &str, rel: &str) -> bool {
        let (folder, file) = (folder_of(rel), filename_of(rel));
        let path = if folder.is_empty() {
            plan_dir.join(phase).join(&file)
        } else {
            plan_dir.join(&folder).join(phase).join(&file)
        };
        path.exists()
    }

    // =========================================================================
    // Unit: compute_changed_fields
    // =========================================================================

    #[test]
    fn changed_fields_identical_flat() {
        assert_eq!(
            compute_changed_fields(&json!({"a": 1, "b": "x"}), &json!({"a": 1, "b": "x"})),
            json!({})
        );
    }

    #[test]
    fn changed_fields_single_field() {
        assert_eq!(
            compute_changed_fields(&json!({"a": 1, "b": 2}), &json!({"a": 1, "b": 99})),
            json!({"b": 99})
        );
    }

    #[test]
    fn changed_fields_multiple_fields() {
        assert_eq!(
            compute_changed_fields(
                &json!({"a": 1, "b": 2, "c": 3}),
                &json!({"a": 10, "b": 2, "c": 30})
            ),
            json!({"a": 10, "c": 30})
        );
    }

    #[test]
    fn changed_fields_ignores_removed_keys() {
        // Key present in master but absent in dirty → not included
        assert_eq!(
            compute_changed_fields(&json!({"a": 1, "b": 2}), &json!({"a": 1})),
            json!({})
        );
    }

    #[test]
    fn changed_fields_includes_new_keys() {
        assert_eq!(
            compute_changed_fields(&json!({"a": 1}), &json!({"a": 1, "b": 99})),
            json!({"b": 99})
        );
    }

    #[test]
    fn changed_fields_nested_airtable_fields_wrapper() {
        assert_eq!(
            compute_changed_fields(
                &json!({"id": "rec1", "fields": {"Name": "Old", "Notes": "Same"}}),
                &json!({"id": "rec1", "fields": {"Name": "New", "Notes": "Same"}})
            ),
            json!({"fields": {"Name": "New"}})
        );
    }

    #[test]
    fn changed_fields_array_treated_atomically() {
        // One element changed → whole array included
        assert_eq!(
            compute_changed_fields(&json!({"tags": [1, 2, 3]}), &json!({"tags": [1, 99, 3]})),
            json!({"tags": [1, 99, 3]})
        );
    }

    #[test]
    fn changed_fields_identical_array_unchanged() {
        assert_eq!(
            compute_changed_fields(&json!({"tags": ["a", "b"]}), &json!({"tags": ["a", "b"]})),
            json!({})
        );
    }

    #[test]
    fn changed_fields_deep_nesting() {
        assert_eq!(
            compute_changed_fields(
                &json!({"l1": {"l2": {"l3": "old"}}}),
                &json!({"l1": {"l2": {"l3": "new"}}})
            ),
            json!({"l1": {"l2": {"l3": "new"}}})
        );
    }

    #[test]
    fn changed_fields_nested_array_airtable_fk() {
        // Airtable: fields.Authors FK array changed
        assert_eq!(
            compute_changed_fields(
                &json!({"id": "rec1", "fields": {"Title": "Same", "Authors": ["recA", "recB"]}}),
                &json!({"id": "rec1", "fields": {"Title": "Same", "Authors": ["recA"]}})
            ),
            json!({"fields": {"Authors": ["recA"]}})
        );
    }

    #[test]
    fn changed_fields_null_null_unchanged() {
        assert_eq!(
            compute_changed_fields(&json!({"a": null}), &json!({"a": null})),
            json!({})
        );
    }

    // =========================================================================
    // Unit: strip_deleted_refs
    // =========================================================================

    fn authors_fk_paths() -> Vec<FkPath> {
        // Represents: fields.authors (array of record IDs, each FK to "authors_tbl")
        // Path: ["fields", "authors", "[]"]
        vec![FkPath {
            path: vec!["fields".into(), "authors".into(), "[]".into()],
            target_table_id: "authors_tbl".into(),
        }]
    }

    fn author_scalar_fk_paths() -> Vec<FkPath> {
        // Scalar FK: fields.author → "authors_tbl"
        vec![FkPath {
            path: vec!["fields".into(), "author".into()],
            target_table_id: "authors_tbl".into(),
        }]
    }

    #[test]
    fn strip_deleted_refs_removes_from_array() {
        let fk = authors_fk_paths();
        let deleted: HashSet<String> = ["recA".to_string()].into();
        let record = json!({"fields": {"title": "Post", "authors": ["recA", "recB"]}});
        let result = strip_deleted_refs(&record, &fk, &deleted);
        assert_eq!(result, json!({"fields": {"title": "Post", "authors": ["recB"]}}));
    }

    #[test]
    fn strip_deleted_refs_removes_all_from_array() {
        let fk = authors_fk_paths();
        let deleted: HashSet<String> = ["recA".to_string(), "recB".to_string()].into();
        let record = json!({"fields": {"authors": ["recA", "recB"]}});
        let result = strip_deleted_refs(&record, &fk, &deleted);
        assert_eq!(result, json!({"fields": {"authors": []}}));
    }

    #[test]
    fn strip_deleted_refs_nulls_scalar_fk() {
        let fk = author_scalar_fk_paths();
        let deleted: HashSet<String> = ["recA".to_string()].into();
        let record = json!({"fields": {"author": "recA", "title": "Post"}});
        let result = strip_deleted_refs(&record, &fk, &deleted);
        assert_eq!(result, json!({"fields": {"author": null, "title": "Post"}}));
    }

    #[test]
    fn strip_deleted_refs_keeps_non_deleted_id() {
        let fk = authors_fk_paths();
        let deleted: HashSet<String> = ["recX".to_string()].into();
        let record = json!({"fields": {"authors": ["recA", "recB"]}});
        let result = strip_deleted_refs(&record, &fk, &deleted);
        assert_eq!(result, json!({"fields": {"authors": ["recA", "recB"]}}));
    }

    #[test]
    fn strip_deleted_refs_no_fk_paths_passthrough() {
        let deleted: HashSet<String> = ["recA".to_string()].into();
        let record = json!({"fields": {"authors": ["recA"]}});
        let result = strip_deleted_refs(&record, &[], &deleted);
        assert_eq!(result, record);
    }

    #[test]
    fn strip_deleted_refs_empty_deleted_set_passthrough() {
        let fk = authors_fk_paths();
        let deleted: HashSet<String> = HashSet::new();
        let record = json!({"fields": {"authors": ["recA"]}});
        let result = strip_deleted_refs(&record, &fk, &deleted);
        assert_eq!(result, record);
    }

    // =========================================================================
    // Unit: strip_pseudo_refs
    // =========================================================================

    #[test]
    fn strip_pseudo_refs_removes_at_slash_from_array() {
        let fk = authors_fk_paths();
        let record = json!({"fields": {"authors": ["recA", "@/posts/scratch_pending_1.json"]}});
        let result = strip_pseudo_refs(&record, &fk);
        assert_eq!(result, json!({"fields": {"authors": ["recA"]}}));
    }

    #[test]
    fn strip_pseudo_refs_removes_all_pseudo_from_array() {
        let fk = authors_fk_paths();
        let record = json!({"fields": {"authors": ["@/a/b.json", "@/c/d.json"]}});
        let result = strip_pseudo_refs(&record, &fk);
        assert_eq!(result, json!({"fields": {"authors": []}}));
    }

    #[test]
    fn strip_pseudo_refs_nulls_scalar() {
        let fk = author_scalar_fk_paths();
        let record = json!({"fields": {"author": "@/authors/pending.json"}});
        let result = strip_pseudo_refs(&record, &fk);
        assert_eq!(result, json!({"fields": {"author": null}}));
    }

    #[test]
    fn strip_pseudo_refs_keeps_real_ids() {
        let fk = authors_fk_paths();
        let record = json!({"fields": {"authors": ["recA", "recB"]}});
        let result = strip_pseudo_refs(&record, &fk);
        assert_eq!(result, record);
    }

    #[test]
    fn strip_pseudo_refs_no_fk_paths_passthrough() {
        let record = json!({"fields": {"authors": ["@/posts/new.json"]}});
        let result = strip_pseudo_refs(&record, &[]);
        assert_eq!(result, record);
    }

    // =========================================================================
    // Unit: strip_asset_pseudo_refs
    // =========================================================================

    #[test]
    fn strip_asset_pseudo_refs_removes_from_array() {
        let record = json!({"fields": {"images": ["existing_id", "@asset/upload.jpg"]}});
        let result = strip_asset_pseudo_refs(&record);
        assert_eq!(result, json!({"fields": {"images": ["existing_id"]}}));
    }

    #[test]
    fn strip_asset_pseudo_refs_nulls_scalar() {
        let record = json!({"fields": {"image": "@asset/photo.jpg"}});
        let result = strip_asset_pseudo_refs(&record);
        assert_eq!(result, json!({"fields": {"image": null}}));
    }

    #[test]
    fn strip_asset_pseudo_refs_keeps_non_asset() {
        let record = json!({"fields": {"image": "att123", "title": "Post"}});
        let result = strip_asset_pseudo_refs(&record);
        assert_eq!(result, record);
    }

    #[test]
    fn strip_asset_pseudo_refs_recurses_into_objects() {
        // Deeply nested
        let record = json!({"a": {"b": {"c": "@asset/deep.png"}}});
        let result = strip_asset_pseudo_refs(&record);
        assert_eq!(result, json!({"a": {"b": {"c": null}}}));
    }

    // =========================================================================
    // Unit: extract_fk_paths
    // =========================================================================

    #[test]
    fn extract_fk_paths_no_annotations() {
        let schema = json!({"type": "object", "properties": {"title": {"type": "string"}}});
        assert!(extract_fk_paths(&schema).is_empty());
    }

    #[test]
    fn extract_fk_paths_simple_top_level_property() {
        let schema = json!({
            "type": "object",
            "properties": {
                "authorId": {
                    "type": "string",
                    "x-scratch-foreign-key": {"linkedTableId": "authors_tbl"}
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, vec!["authorId"]);
        assert_eq!(paths[0].target_table_id, "authors_tbl");
    }

    #[test]
    fn extract_fk_paths_nested_fields_wrapper_array() {
        // Airtable-style: fields.authors is an array of FK strings
        let schema = json!({
            "type": "object",
            "properties": {
                "fields": {
                    "type": "object",
                    "properties": {
                        "authors": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": {"linkedTableId": "authors_tbl"}
                            }
                        }
                    }
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, vec!["fields", "authors", "[]"]);
        assert_eq!(paths[0].target_table_id, "authors_tbl");
    }

    #[test]
    fn extract_fk_paths_multiple_fk_fields() {
        let schema = json!({
            "type": "object",
            "properties": {
                "fields": {
                    "type": "object",
                    "properties": {
                        "authorIds": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": {"linkedTableId": "authors_tbl"}
                            }
                        },
                        "categoryId": {
                            "type": "string",
                            "x-scratch-foreign-key": {"linkedTableId": "categories_tbl"}
                        }
                    }
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 2);
        let array_path = paths.iter().find(|p| p.path.contains(&"[]".to_string())).unwrap();
        let scalar_path = paths.iter().find(|p| !p.path.contains(&"[]".to_string())).unwrap();
        assert_eq!(array_path.path, vec!["fields", "authorIds", "[]"]);
        assert_eq!(scalar_path.path, vec!["fields", "categoryId"]);
    }

    #[test]
    fn extract_fk_paths_one_of_combinator() {
        let schema = json!({
            "type": "object",
            "properties": {
                "ref": {
                    "oneOf": [
                        {"type": "string", "x-scratch-foreign-key": {"linkedTableId": "targets_tbl"}},
                        {"type": "null"}
                    ]
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, vec!["ref"]);
    }

    // =========================================================================
    // Integration: plan_connection (filesystem fixture tests)
    // =========================================================================

    #[test]
    fn plan_conn_no_changes_returns_false() {
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let rec = json!({"id": "rec1", "fields": {"title": "Hello"}});
        write_json(&master_dir, "posts/rec1.json", &rec);
        write_json(&dirty_dir, "posts/rec1.json", &rec);

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "20240101-120000").unwrap();
        assert!(!result, "no changes should return false");

        let plans_root = dirty_dir.join(".scratch/publish-plans");
        assert!(!plans_root.exists(), "no plan dir should be created");
    }

    #[test]
    fn plan_conn_simple_edit() {
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let master_rec = json!({"id": "rec1", "fields": {"title": "Old", "body": "Same"}});
        let dirty_rec  = json!({"id": "rec1", "fields": {"title": "New", "body": "Same"}});
        write_json(&master_dir, "posts/rec1.json", &master_rec);
        write_json(&dirty_dir,  "posts/rec1.json", &dirty_rec);

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        assert_eq!(meta.summary.edit, 1);
        assert_eq!(meta.summary.create, 0);
        assert_eq!(meta.summary.delete, 0);
        assert_eq!(meta.summary.backfill, 0);

        let edit_content = read_plan_file(&plan_dir, "edit", "posts/rec1.json");
        assert_eq!(edit_content["fields"]["title"], "New");
        assert_eq!(edit_content["fields"]["body"], "Same");

        // changedFields should only have the changed key
        let cf = &meta.changed_fields["posts/rec1.json"];
        assert_eq!(cf["fields"]["title"], "New");
        assert!(cf["fields"]["body"].is_null() || cf["fields"].get("body").is_none(),
            "unchanged field 'body' should not appear in changedFields");
    }

    #[test]
    fn plan_conn_simple_create() {
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let new_rec = json!({"fields": {"title": "Brand New Post"}});
        write_json(&dirty_dir, "posts/recNew.json", &new_rec);

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        assert_eq!(meta.summary.create, 1);
        assert_eq!(meta.summary.edit, 0);

        let create_content = read_plan_file(&plan_dir, "create", "posts/recNew.json");
        assert_eq!(create_content["fields"]["title"], "Brand New Post");
    }

    #[test]
    fn plan_conn_simple_delete() {
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let old_rec = json!({"id": "recOld", "fields": {"title": "Going Away"}});
        write_json(&master_dir, "posts/recOld.json", &old_rec);
        // NOT written to dirty_dir

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        assert_eq!(meta.summary.delete, 1);
        assert_eq!(meta.summary.edit, 0);

        // deleteIndex should map the path to the remote ID from file content
        assert_eq!(meta.delete_index["posts/recOld.json"], "recOld");

        let delete_content = read_plan_file(&plan_dir, "delete", "posts/recOld.json");
        assert_eq!(delete_content, json!({}), "delete content should be empty object");
    }

    #[test]
    fn plan_conn_delete_remote_id_from_index_db() {
        // Remote ID not in file content (no "id" field) — falls back to index.db
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let old_rec = json!({"fields": {"title": "No ID Field"}});
        write_json(&master_dir, "posts/recX.json", &old_rec);

        let db = init_index_db(&db_path);
        insert_file_index(&db, "posts", "recX.json", "rec_from_db");

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);
        assert_eq!(meta.delete_index["posts/recX.json"], "rec_from_db");
    }

    #[test]
    fn plan_conn_fk_ref_clear_on_delete() {
        // The critical scenario: delete authors/recA → posts/recP has FK to recA
        // → posts/recP should appear as an edit with the FK stripped, even though the user didn't touch it.
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        // Schema: posts has fields.authors (array FK → authors_tbl)
        let schema = json!({
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "fields": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "authors": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": {"linkedTableId": "authors_tbl"}
                            }
                        }
                    }
                }
            }
        });
        write_schema(&conn_scratch, "posts", &schema);

        let author = json!({"id": "recA", "fields": {"name": "Alice"}});
        let post   = json!({"id": "recP", "fields": {"name": "Post1", "authors": ["recA", "recB"]}});

        // Master has both
        write_json(&master_dir, "authors/recA.json", &author);
        write_json(&master_dir, "posts/recP.json", &post);

        // Dirty: author deleted, post unchanged
        write_json(&dirty_dir, "posts/recP.json", &post);  // present, unchanged

        // Index: file_references tells us posts/recP.json → recA
        let db = init_index_db(&db_path);
        insert_file_ref(&db, "posts", "recP.json", "authors_tbl", "recA");

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        // One delete (author) + one edit (post ref-cleared)
        assert_eq!(meta.summary.delete, 1, "should have 1 delete");
        assert_eq!(meta.summary.edit, 1, "should have 1 edit (ref-clear)");

        // The edit should have FK stripped: recA removed from authors array, recB kept
        let edit_content = read_plan_file(&plan_dir, "edit", "posts/recP.json");
        let authors = edit_content["fields"]["authors"].as_array().unwrap();
        assert!(!authors.iter().any(|v| v == "recA"), "recA should be stripped from authors");
        assert!(authors.iter().any(|v| v == "recB"), "recB should still be present");

        // changedFields should reflect the stripped authors array
        let cf = &meta.changed_fields["posts/recP.json"];
        assert!(cf["fields"]["authors"].is_array(), "changedFields should contain stripped authors");
        assert_eq!(cf["fields"]["authors"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn plan_conn_pseudo_ref_edit_with_backfill() {
        // posts/recP has a @/ pseudo-ref to a new pending record in authors field.
        // Plan: edit (stripped) + backfill (with original @/ restored).
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let schema = json!({
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "fields": {
                    "type": "object",
                    "properties": {
                        "authors": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": {"linkedTableId": "authors_tbl"}
                            }
                        }
                    }
                }
            }
        });
        write_schema(&conn_scratch, "posts", &schema);

        let master_rec = json!({"id": "recP", "fields": {"authors": ["recA"]}});
        // Dirty: user added a @/ pseudo-ref to a pending new author
        let dirty_rec  = json!({"id": "recP", "fields": {"authors": ["recA", "@/authors/scratch_pending_1.json"]}});

        write_json(&master_dir, "posts/recP.json", &master_rec);
        write_json(&dirty_dir,  "posts/recP.json", &dirty_rec);

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        // After stripping the @/ pseudo-ref, the content equals master (["recA"]).
        // No edit is needed — the record is already at that state in production.
        // Only a backfill is emitted to restore the pseudo-ref once the pending create resolves.
        assert_eq!(meta.summary.edit, 0, "no edit when stripped content == master");
        assert_eq!(meta.summary.backfill, 1);

        let backfill_content = read_plan_file(&plan_dir, "backfill", "posts/recP.json");
        let bf_authors = backfill_content["fields"]["authors"].as_array().unwrap();
        assert!(bf_authors.iter().any(|v| v.as_str().map(|s| s.starts_with("@/")).unwrap_or(false)),
            "backfill should restore the @/ pseudo-ref");
    }

    #[test]
    fn plan_conn_asset_pseudo_ref_with_backfill() {
        // posts/recP has an @asset/ ref. Plan: edit (null) + backfill (restore).
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let master_rec = json!({"id": "recP", "fields": {"image": "attExisting"}});
        let dirty_rec  = json!({"id": "recP", "fields": {"image": "@asset/new_photo.jpg"}});

        write_json(&master_dir, "posts/recP.json", &master_rec);
        write_json(&dirty_dir,  "posts/recP.json", &dirty_rec);

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        assert_eq!(meta.summary.edit, 1);
        assert_eq!(meta.summary.backfill, 1);

        let edit_content = read_plan_file(&plan_dir, "edit", "posts/recP.json");
        assert!(edit_content["fields"]["image"].is_null(), "asset ref should be nulled in edit");

        let backfill_content = read_plan_file(&plan_dir, "backfill", "posts/recP.json");
        assert_eq!(backfill_content["fields"]["image"], "@asset/new_photo.jpg",
            "backfill should restore the @asset/ ref");
    }

    #[test]
    fn plan_conn_scratch_pending_create_gets_rename() {
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let pending = json!({"fields": {"title": "Pending New Post"}});
        write_json(&dirty_dir, "posts/scratch_pending_abc123.json", &pending);

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        assert_eq!(meta.summary.create, 1);
        assert_eq!(meta.summary.rename, 1);

        assert!(plan_file_exists(&plan_dir, "rename", "posts/scratch_pending_abc123.json"),
            "rename entry should exist for scratch_pending_ file");
    }

    #[test]
    fn plan_conn_edit_noop_after_stripping_not_emitted() {
        // Dirty content differs from master ONLY by having a @/ pseudo-ref that gets stripped.
        // After stripping, dirty == master → no edit should be emitted.
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let schema = json!({
            "type": "object",
            "properties": {
                "fields": {
                    "type": "object",
                    "properties": {
                        "authors": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": {"linkedTableId": "authors_tbl"}
                            }
                        }
                    }
                }
            }
        });
        write_schema(&conn_scratch, "posts", &schema);

        // Master has an empty authors array
        let master_rec = json!({"id": "recP", "fields": {"authors": []}});
        // Dirty adds a pseudo-ref (which gets stripped back to [])
        let dirty_rec  = json!({"id": "recP", "fields": {"authors": ["@/authors/pending.json"]}});

        write_json(&master_dir, "posts/recP.json", &master_rec);
        write_json(&dirty_dir,  "posts/recP.json", &dirty_rec);

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        // After stripping, dirty == master, so no edit. But backfill IS emitted (pass3 != pass1).
        // The function returns Ok(true) only if entries is non-empty.
        // entries will have a backfill (restoring the @/ ref), so result = true.
        // What we assert: no EDIT entry.
        if result {
            let plan_dir = find_plan_dir(&dirty_dir);
            let meta = read_plan_meta(&plan_dir);
            assert_eq!(meta.summary.edit, 0, "no edit should be emitted when stripped content == master");
        }
    }

    #[test]
    fn plan_conn_combined_delete_fk_strip_and_pseudo_ref_backfill() {
        // Full scenario:
        //   - authors/recA deleted
        //   - posts/recP has FK ["recA", "@/authors/pending.json"] in fields.authors
        //   After plan:
        //   - delete: authors/recA
        //   - edit: posts/recP with authors stripped to [] (recA deleted + pseudo stripped)
        //   - backfill: posts/recP restoring authors to ["@/authors/pending.json"] (pass1 content)
        let (_tmp, conn_scratch, master_dir, dirty_dir, db_path) = make_workspace("Conn");

        let schema = json!({
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "fields": {
                    "type": "object",
                    "properties": {
                        "authors": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": {"linkedTableId": "authors_tbl"}
                            }
                        }
                    }
                }
            }
        });
        write_schema(&conn_scratch, "posts", &schema);

        let author = json!({"id": "recA", "fields": {"name": "Alice"}});
        // Master post has real ID + FK
        let master_post = json!({"id": "recP", "fields": {"authors": ["recA"]}});
        // Dirty post adds a pseudo-ref for a new pending author
        let dirty_post  = json!({"id": "recP", "fields": {"authors": ["recA", "@/authors/pending.json"]}});

        write_json(&master_dir, "authors/recA.json", &author);
        write_json(&master_dir, "posts/recP.json", &master_post);
        // Dirty: author deleted, post modified with pseudo-ref
        write_json(&dirty_dir, "posts/recP.json", &dirty_post);

        let db = init_index_db(&db_path);
        insert_file_ref(&db, "posts", "recP.json", "authors_tbl", "recA");

        let result = plan_connection("Conn", "conn_id", &master_dir, &dirty_dir, &conn_scratch, &db_path, "ts1").unwrap();
        assert!(result);

        let plan_dir = find_plan_dir(&dirty_dir);
        let meta = read_plan_meta(&plan_dir);

        assert_eq!(meta.summary.delete, 1, "1 delete");
        assert_eq!(meta.summary.edit, 1, "1 edit");
        assert_eq!(meta.summary.backfill, 1, "1 backfill");

        // Edit: both recA and @/ stripped → authors = []
        let edit_content = read_plan_file(&plan_dir, "edit", "posts/recP.json");
        let edit_authors = edit_content["fields"]["authors"].as_array().unwrap();
        assert!(edit_authors.is_empty(), "edit should have fully stripped authors array");

        // Backfill: pass1 content (recA stripped, but @/ still present)
        let bf_content = read_plan_file(&plan_dir, "backfill", "posts/recP.json");
        let bf_authors = bf_content["fields"]["authors"].as_array().unwrap();
        assert_eq!(bf_authors.len(), 1, "backfill should have one entry: the @/ pseudo-ref");
        assert!(bf_authors[0].as_str().unwrap().starts_with("@/"),
            "backfill should contain the @/ pseudo-ref");
    }
}
