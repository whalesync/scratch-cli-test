//! `scratchmd plan-publish` — build a local publish plan by diffing dirty vs master.
//!
//! Plan phases mirror the server:
//!   edit      — update existing record (stripped dirty content + changedFields)
//!   create    — create new record (stripped dirty content)
//!   delete    — delete record ({} placeholder, remote ID in plan.json)
//!   backfill  — re-update after creates resolve pending IDs
//!   rename    — rename scratch_pending_* → real filename after create
//!
//! Stripping passes applied to every edit and create file:
//!   Pass 1: strip FK refs to deleted records (via x-scratch-foreign-key schema annotations)
//!   Pass 2: strip @/ pseudo-refs (references to pending new records)
//!   Pass 3: strip @asset/ pseudo-refs (schema-agnostic)
//!
//! Output: {conn_dir}/.scratch/publish-plans/{timestamp}/
//!   plan.json       — metadata, delete_index, changed_fields, entries map
//!   {folder}/edit/  — stripped edit content files
//!   {folder}/create/ — stripped create content files
//!   {folder}/delete/ — empty {} placeholder files
//!   {folder}/backfill/ — pass-1 content for files that needed stripping
//!   {folder}/rename/ — empty {} placeholder files for pending creates

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::markers;

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
    /// rel_path → remote_id for deleted files
    delete_index: HashMap<String, String>,
    /// rel_path → sparse changed-fields object for efficient PATCH
    changed_fields: HashMap<String, Value>,
    /// phase name → list of rel_paths in that phase
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

pub fn run(workspace_start: &Path) -> anyhow::Result<()> {
    let workspace = resolve_workspace(workspace_start)?;

    let conn_dirs = find_connector_dirs(&workspace);
    if conn_dirs.is_empty() {
        anyhow::bail!(
            "No connector directories found in {}. Run 'scratchmd workspaces init' first.",
            workspace.display()
        );
    }

    let timestamp = now_compact();
    let mut any_changes = false;

    for conn_dir in &conn_dirs {
        let conn_name = conn_dir.file_name().unwrap_or_default().to_string_lossy().to_string();

        // Read connector marker to get the connection ID
        let marker_path = conn_dir.join(".scratchmd");
        let connection_id = match markers::read(&marker_path) {
            Ok(markers::Marker::Connector(m)) => m.connector.id,
            _ => {
                eprintln!("  {conn_name}: could not read connector marker, skipping");
                continue;
            }
        };

        let dirty_dir = conn_dir.as_path();
        let master_dir = crate::shared::index::master_dir(&workspace, &conn_name);
        let db_path = crate::shared::index::db_path(&workspace, &conn_name);

        if !master_dir.exists() {
            eprintln!("  {conn_name}: master worktree not found at {}, skipping", master_dir.display());
            eprintln!("    Run 'scratchmd workspaces init' to set up the master worktree.");
            continue;
        }

        match plan_connection(
            &conn_name,
            &connection_id,
            dirty_dir,
            &master_dir,
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
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// publish-from-git: trigger server-side publish for all connectors with a plan
// ---------------------------------------------------------------------------

/// Reads the current workspace, finds every connector that has a publish plan,
/// and calls POST /workbook/:id/publish-v2/run-from-git for each.
pub async fn run_publish_from_git(workspace_start: &Path, client: &crate::api::ApiClient) -> anyhow::Result<()> {
    let workspace = resolve_workspace(workspace_start)?;

    // Get workbook ID from workspace marker
    let ws_marker_path = workspace.join(".scratchmd");
    let workbook_id = match markers::read(&ws_marker_path) {
        Ok(markers::Marker::Workspace(m)) => m.workbook.id,
        _ => anyhow::bail!("Could not read workspace marker at {}", ws_marker_path.display()),
    };

    let conn_dirs = find_connector_dirs(&workspace);
    if conn_dirs.is_empty() {
        anyhow::bail!("No connector directories found. Run 'scratchmd workspaces init' first.");
    }

    let mut any_triggered = false;

    for conn_dir in &conn_dirs {
        let conn_name = conn_dir.file_name().unwrap_or_default().to_string_lossy().to_string();

        // Read connector account ID from marker
        let marker_path = conn_dir.join(".scratchmd");
        let connector_account_id = match markers::read(&marker_path) {
            Ok(markers::Marker::Connector(m)) => m.connector.id,
            _ => {
                eprintln!("  {conn_name}: could not read connector marker, skipping");
                continue;
            }
        };

        // Find the single publish plan directory
        let plans_dir = conn_dir.join(".scratch/publish-plans");
        let plan_dir = match std::fs::read_dir(&plans_dir).ok().and_then(|mut d| d.next()) {
            Some(Ok(e)) if e.path().is_dir() => e.path(),
            _ => {
                eprintln!("  {conn_name}: no publish plan found — run 'scratchmd plan-publish' first");
                continue;
            }
        };

        // planPath is relative to the connector repo root (what the server reads from git)
        let plan_timestamp = plan_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        let plan_path = format!(".scratch/publish-plans/{}", plan_timestamp);

        match client.publish_from_git(&workbook_id, &connector_account_id, &plan_path).await {
            Ok(resp) => {
                let job_id = resp.get("jobId").and_then(|v| v.as_str()).unwrap_or("(unknown)");
                println!("  {conn_name}: publish job queued (jobId: {job_id})");
                any_triggered = true;
            }
            Err(e) => {
                eprintln!("  {conn_name}: failed to trigger publish: {e}");
            }
        }
    }

    if !any_triggered {
        println!("No publish jobs triggered.");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Per-connection planning
// ---------------------------------------------------------------------------

fn plan_connection(
    conn_name: &str,
    connection_id: &str,
    dirty_dir: &Path,
    master_dir: &Path,
    db_path: &Path,
    timestamp: &str,
) -> anyhow::Result<bool> {
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

    if modified.is_empty() && added.is_empty() && deleted.is_empty() {
        println!("  {conn_name}: nothing to publish");
        return Ok(false);
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

    // 6. Schema cache: folder → FK paths
    let mut schema_cache: HashMap<String, Vec<FkPath>> = HashMap::new();

    // 7. Build plan entries
    let mut entries: Vec<PlanEntry> = vec![];
    let mut changed_fields_map: HashMap<String, Value> = HashMap::new();

    // --- Edit phase ---
    for rel_path in &edit_set {
        let folder = folder_of(rel_path);

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

        let fk_paths = get_schema_fk_paths(&folder, master_dir, &mut schema_cache);

        let pass1 = strip_deleted_refs(&dirty_val, fk_paths, &deleted_id_set);
        let pass2 = strip_pseudo_refs(&pass1, fk_paths);
        let pass3 = strip_asset_pseudo_refs(&pass2);

        let changed = compute_changed_fields(&master_val, &pass3);
        if !is_empty_object(&changed) {
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
    report_by_folder(conn_name, &entries, &modified, &added, &deleted, &ref_clear_candidates);

    // 10. Write plan files into dirty_dir/.scratch/publish-plans/{timestamp}/
    // Only one plan per connection is kept — delete any existing plan first.
    let plans_dir = dirty_dir.join(".scratch/publish-plans");
    if plans_dir.exists() {
        for old in std::fs::read_dir(&plans_dir)?.flatten() {
            if old.path().is_dir() {
                std::fs::remove_dir_all(old.path())?;
            }
        }
    }
    let plan_root = plans_dir.join(timestamp);
    std::fs::create_dir_all(&plan_root)?;

    for entry in &entries {
        let (folder, filename) = split_path(&entry.rel_path);
        let phase_dir = if folder.is_empty() {
            plan_root.join(entry.phase.dir_name())
        } else {
            plan_root.join(&folder).join(entry.phase.dir_name())
        };
        std::fs::create_dir_all(&phase_dir)?;
        let content_str = serde_json::to_string_pretty(&entry.content)?;
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
    conn_name: &str,
    entries: &[PlanEntry],
    modified: &[String],
    added: &[String],
    deleted: &[String],
    ref_clear_candidates: &HashSet<String>,
) {
    println!("  {conn_name}");
    let folders: Vec<String> = entries.iter()
        .map(|e| folder_of(&e.rel_path))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    for folder in folders {
        let label = if folder.is_empty() { "(root)".to_string() } else { folder.clone() };

        let raw_modified  = modified.iter().filter(|r| folder_of(r) == folder).count();
        let raw_added     = added.iter().filter(|r| folder_of(r) == folder).count();
        let raw_deleted   = deleted.iter().filter(|r| folder_of(r) == folder).count();
        let raw_ref_clear = ref_clear_candidates.iter().filter(|r| folder_of(r) == folder).count();

        let plan_edit     = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Edit).count();
        let plan_create   = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Create).count();
        let plan_delete   = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Delete).count();
        let plan_backfill = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Backfill).count();
        let plan_rename   = entries.iter().filter(|e| folder_of(&e.rel_path) == folder && e.phase == Phase::Rename).count();

        let mut raw_parts = vec![];
        if raw_modified  > 0 { raw_parts.push(format!("{raw_modified} modified")); }
        if raw_added     > 0 { raw_parts.push(format!("{raw_added} added")); }
        if raw_deleted   > 0 { raw_parts.push(format!("{raw_deleted} deleted")); }
        if raw_ref_clear > 0 { raw_parts.push(format!("{raw_ref_clear} ref-clear")); }

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
    master_dir: &Path,
    cache: &'a mut HashMap<String, Vec<FkPath>>,
) -> &'a [FkPath] {
    if !cache.contains_key(folder) {
        // Schema is at master_dir/.scratch/{folder}/schema.json
        let schema_path = master_dir
            .join(".scratch")
            .join(folder)
            .join("schema.json");

        let fk_paths = if schema_path.exists() {
            std::fs::read_to_string(&schema_path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .map(|outer| {
                    // Schema file may wrap the real JSON Schema under a "schema" key
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
            out.push(FkPath { path: path.to_vec(), target_table_id: id.to_string() });
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
        } else {
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
    let db = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open index.db: {e}"))?;

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

        let rows = stmt.query_map(rusqlite::params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| anyhow::anyhow!("query failed: {e}"))?;

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

fn collect_files_rec(root: &Path, dir: &Path, map: &mut HashMap<String, String>) -> anyhow::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if path.is_dir() {
            // Skip hidden dirs and .scratch metadata
            if name.starts_with('.') { continue; }
            collect_files_rec(root, &path, map)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            // Skip schema.json files
            if name == "schema.json" { continue; }
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
            if let Ok(content) = std::fs::read_to_string(&path) {
                map.insert(rel, content);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace / connector discovery
// ---------------------------------------------------------------------------

fn resolve_workspace(start: &Path) -> anyhow::Result<PathBuf> {
    let abs = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    let mut dir = abs.as_path();
    loop {
        let candidate = dir.join(".scratchmd");
        if candidate.exists() {
            if let Ok(markers::Marker::Workspace(_)) = markers::read(&candidate) {
                return Ok(dir.to_path_buf());
            }
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => break,
        }
    }
    // Fallback: use provided path
    Ok(abs)
}

fn find_connector_dirs(wb_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(wb_dir) else { return Vec::new() };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let subdir = entry.path();
        let marker_path = subdir.join(".scratchmd");
        let Ok(content) = std::fs::read_to_string(&marker_path) else { continue };
        let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content) else { continue };
        if value.get("connector").is_none() {
            continue;
        }
        if subdir.join(".git").exists() {
            dirs.push(subdir);
        }
    }
    dirs
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
    use tempfile::TempDir;

    fn make_workspace(conn: &str) -> (TempDir, PathBuf, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();

        // Workspace marker
        let wb_marker = root.join(".scratchmd");
        std::fs::write(
            &wb_marker,
            "version: \"2\"\nworkbook:\n  id: wkb_test\n  name: Test\n  serverUrl: http://localhost\n  initializedAt: \"2024-01-01T00:00:00Z\"\n",
        ).unwrap();

        // Connector dir
        let conn_dir = root.join(conn);
        std::fs::create_dir_all(&conn_dir).unwrap();
        std::fs::create_dir_all(conn_dir.join(".git")).unwrap();
        std::fs::write(
            conn_dir.join(".scratchmd"),
            format!("version: \"2\"\nworkbook:\n  id: wkb_test\n  name: Test\nconnector:\n  id: conn_test_id\n  displayName: Test\n  service: airtable\n  repoPath: \"\"\n"),
        ).unwrap();

        // Master dir
        let master_dir = root.join(".scratch/connections").join(conn).join("master");
        std::fs::create_dir_all(&master_dir).unwrap();

        let db_path = root.join(".scratch/connections").join(conn).join("index.db");

        (tmp, conn_dir, master_dir, db_path)
    }

    fn write_json(dir: &Path, rel: &str, v: &Value) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(v).unwrap()).unwrap();
    }

    fn read_plan_json(plan_root: &Path) -> Value {
        let content = std::fs::read_to_string(plan_root.join("plan.json")).unwrap();
        serde_json::from_str(&content).unwrap()
    }

    fn find_plan_root(conn_dir: &Path) -> Option<PathBuf> {
        let plans_dir = conn_dir.join(".scratch/publish-plans");
        if !plans_dir.exists() { return None; }
        std::fs::read_dir(&plans_dir).ok()?
            .flatten()
            .find(|e| e.path().is_dir())
            .map(|e| e.path())
    }

    #[test]
    fn test_simple_edit() {
        let (tmp, conn_dir, master_dir, _db_path) = make_workspace("my-conn");

        // Same file in master and dirty, but dirty has a modified field
        write_json(&master_dir, "public/posts/rec1.json", &json!({"id": "rec1", "fields": {"title": "Old"}}));
        write_json(&conn_dir, "public/posts/rec1.json", &json!({"id": "rec1", "fields": {"title": "New"}}));

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&conn_dir).expect("plan dir not created");
        let plan = read_plan_json(&plan_root);

        assert_eq!(plan["summary"]["edit"], 1);
        assert_eq!(plan["summary"]["create"], 0);
        assert_eq!(plan["summary"]["delete"], 0);

        let edit_file = plan_root.join("public/posts/edit/rec1.json");
        assert!(edit_file.exists(), "edit file not created");
        let edit_content: Value = serde_json::from_str(&std::fs::read_to_string(edit_file).unwrap()).unwrap();
        assert_eq!(edit_content["fields"]["title"], "New");
    }

    #[test]
    fn test_create_and_delete() {
        let (tmp, conn_dir, master_dir, _db_path) = make_workspace("my-conn");

        // File only in master → deleted
        write_json(&master_dir, "posts/old.json", &json!({"id": "rec_old"}));
        // File only in dirty → created
        write_json(&conn_dir, "posts/new.json", &json!({"fields": {"title": "New Post"}}));
        // File in both, unchanged
        write_json(&master_dir, "posts/same.json", &json!({"id": "rec_same"}));
        write_json(&conn_dir, "posts/same.json", &json!({"id": "rec_same"}));

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&conn_dir).expect("plan dir not created");
        let plan = read_plan_json(&plan_root);

        assert_eq!(plan["summary"]["create"], 1);
        assert_eq!(plan["summary"]["delete"], 1);
        assert_eq!(plan["summary"]["edit"], 0);
        assert_eq!(plan["deleteIndex"]["posts/old.json"], "rec_old");
    }

    #[test]
    fn test_nothing_to_publish_when_identical() {
        let (tmp, conn_dir, master_dir, _db_path) = make_workspace("my-conn");

        write_json(&master_dir, "posts/rec1.json", &json!({"id": "rec1", "fields": {"title": "Same"}}));
        write_json(&conn_dir, "posts/rec1.json", &json!({"id": "rec1", "fields": {"title": "Same"}}));

        run(tmp.path()).unwrap();

        assert!(find_plan_root(&conn_dir).is_none(), "should not create plan when nothing changed");
    }

    #[test]
    fn test_pending_file_gets_rename_entry() {
        let (tmp, conn_dir, master_dir, _) = make_workspace("my-conn");

        // Only in dirty, with scratch_pending_ prefix
        write_json(&master_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(&conn_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(&conn_dir, "posts/scratch_pending_abc.json", &json!({"fields": {"title": "New"}}));

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&conn_dir).expect("plan dir not created");
        let plan = read_plan_json(&plan_root);

        assert_eq!(plan["summary"]["create"], 1);
        assert_eq!(plan["summary"]["rename"], 1);
    }

    #[test]
    fn test_asset_pseudo_refs_stripped_in_create() {
        let (tmp, conn_dir, master_dir, _) = make_workspace("my-conn");

        write_json(&master_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(&conn_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(&conn_dir, "posts/new.json", &json!({
            "fields": {
                "title": "Hello",
                "image": "@asset/uploads/img.png"
            }
        }));

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&conn_dir).expect("plan dir not created");
        let create_file = plan_root.join("posts/create/new.json");
        assert!(create_file.exists());
        let content: Value = serde_json::from_str(&std::fs::read_to_string(create_file).unwrap()).unwrap();
        assert!(content["fields"]["image"].is_null(), "asset pseudo-ref should be stripped to null");
    }

    #[test]
    fn test_compute_changed_fields() {
        let master = json!({"id": "1", "fields": {"title": "Old", "count": 5}});
        let dirty  = json!({"id": "1", "fields": {"title": "New", "count": 5}});
        let changed = compute_changed_fields(&master, &dirty);
        assert_eq!(changed["fields"]["title"], "New");
        assert!(changed["fields"].get("count").is_none(), "unchanged field should not appear");
    }
}
