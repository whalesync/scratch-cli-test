use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::service::envelope::{envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::shared::index as idx;

pub async fn build_index(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let db_path = state.index_db_path(&id);
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let commit_oid = git_repo.resolve_ref("main")?;
            let tree_oid = git_repo.get_commit_tree_oid(commit_oid)?;

            // Walk the entire tree and collect all blob paths + OIDs
            let blobs = collect_blobs(&git_repo.repo, tree_oid)?;

            // First pass: build FK map from .scratch/**/schema.json files
            let mut fk_map: HashMap<String, Vec<idx::FkField>> = HashMap::new();
            for (path, oid) in &blobs {
                let Some(scratch_rest) = path.strip_prefix(".scratch/") else { continue };
                if !scratch_rest.ends_with("/schema.json") && scratch_rest != "schema.json" {
                    continue;
                }
                let folder_key = if scratch_rest == "schema.json" {
                    String::new()
                } else {
                    scratch_rest.strip_suffix("/schema.json").unwrap_or("").to_string()
                };
                let Ok(content) = git_repo.read_blob(*oid) else { continue };
                let Ok(text) = std::str::from_utf8(&content) else { continue };
                let Ok(schema) = serde_json::from_str::<Value>(text) else { continue };
                let fk_fields = idx::extract_fk_fields(&schema);
                if !fk_fields.is_empty() {
                    fk_map.insert(folder_key, fk_fields);
                }
            }

            // Second pass: index data files and build FK reference entries
            let mut file_entries: Vec<(String, String, Option<String>)> = Vec::new();
            let mut ref_entries: Vec<(String, String, String, String)> = Vec::new();

            for (path, oid) in &blobs {
                // Skip hidden paths (but .scratch was already handled above)
                if path.starts_with('.') {
                    continue;
                }
                if !path.ends_with(".json") {
                    continue;
                }

                // Split into folder + filename
                let (folder, filename) = match path.rfind('/') {
                    Some(i) => (path[..i].to_string(), path[i + 1..].to_string()),
                    None => (String::new(), path.clone()),
                };
                if filename == "schema.json" {
                    continue;
                }

                let Ok(content) = git_repo.read_blob(*oid) else { continue };
                let Ok(text) = std::str::from_utf8(&content) else { continue };
                let Ok(value) = serde_json::from_str::<Value>(text) else { continue };

                // Extract remote_id (handle both string and numeric ids)
                let remote_id = value
                    .get("id")
                    .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string())));

                // FK references
                if let Some(fk_fields) = fk_map.get(&folder) {
                    for fk in fk_fields {
                        if let Some(ref_val) = idx::get_by_path(&value, &fk.field_path) {
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
                                ref_entries.push((
                                    folder.clone(),
                                    filename.clone(),
                                    fk.target_table_id.clone(),
                                    target_id,
                                ));
                            }
                        }
                    }
                }

                file_entries.push((folder, filename, remote_id));
            }

            let count = file_entries.len();
            idx::build_from_entries(&file_entries, &ref_entries, &db_path)
                .map_err(|e| AppError::internal(e.to_string()))?;

            Ok::<_, AppError>(serde_json::json!({ "count": count }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn dump_index(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let db_path = state.index_db_path(&id);
        let id = id.clone();
        move || {
            if !db_path.exists() {
                return Err(AppError::not_found(format!("index not built for {}", id)));
            }
            let files =
                idx::read_index(&db_path).map_err(|e| AppError::internal(e.to_string()))?;
            let refs =
                idx::read_references(&db_path).map_err(|e| AppError::internal(e.to_string()))?;

            let files_json: Vec<serde_json::Value> = files
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "folder": r.folder,
                        "filename": r.filename,
                        "remoteId": r.remote_id,
                    })
                })
                .collect();

            let refs_json: Vec<serde_json::Value> = refs
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "sourceFolder": r.source_folder,
                        "sourceFilename": r.source_filename,
                        "targetTableId": r.target_table_id,
                        "targetRemoteId": r.target_remote_id,
                    })
                })
                .collect();

            Ok::<_, AppError>(serde_json::json!({
                "files": files_json,
                "references": refs_json,
            }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct LookupRequest {
    pub folder: String,
    pub remote_ids: Vec<String>,
}

/// Resolve a batch of remote IDs to filenames using the SQLite index.
///
/// POST body: `{ "folder": "contacts", "remote_ids": ["rec123", "rec456"] }`
/// Response:  `{ "rec123": "alice.json", "rec456": "bob.json" }`
pub async fn lookup_index(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<LookupRequest>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let db_path = state.index_db_path(&id);
        let id = id.clone();
        move || {
            let map = idx::lookup_by_remote_ids(&db_path, &body.folder, &body.remote_ids)
                .map_err(|e| AppError::internal(e.to_string()))?;
            let json_map: serde_json::Map<String, Value> =
                map.into_iter().map(|(k, v)| (k, Value::String(v))).collect();
            Ok::<_, AppError>(Value::Object(json_map))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

/// Incrementally update the SQLite index for one file after it is committed to main.
///
/// Reads the schema for the file's folder from the git tree at `main` to get FK fields.
/// No-ops gracefully if the index DB does not exist yet (full build hasn't run).
#[allow(dead_code)]
pub fn index_single_file_on_main(
    state: &AppState,
    id: &str,
    file_path: &str,
    file_content: &str,
) -> Result<(), crate::service::error::AppError> {
    let file_path = file_path.strip_prefix('/').unwrap_or(file_path);
    let (folder, filename) = match file_path.rfind('/') {
        Some(i) => (&file_path[..i], &file_path[i + 1..]),
        None => ("", file_path),
    };
    if filename == "schema.json" || !filename.ends_with(".json") {
        return Ok(());
    }

    let db_path = state.index_db_path(id);
    let fk_fields = load_fk_fields_for_folder(state, id, folder).unwrap_or_default();

    idx::upsert_single_file(&db_path, folder, filename, file_content, &fk_fields)
        .map_err(|e| crate::service::error::AppError::internal(e.to_string()))
}

/// Remove a file from the SQLite index (called when a file is deleted from main).
#[allow(dead_code)]
pub fn remove_file_from_index(
    state: &AppState,
    id: &str,
    file_path: &str,
) -> Result<(), crate::service::error::AppError> {
    let file_path = file_path.strip_prefix('/').unwrap_or(file_path);
    let (folder, filename) = match file_path.rfind('/') {
        Some(i) => (&file_path[..i], &file_path[i + 1..]),
        None => ("", file_path),
    };
    let db_path = state.index_db_path(id);
    idx::remove_single_file(&db_path, folder, filename)
        .map_err(|e| crate::service::error::AppError::internal(e.to_string()))
}

/// Read FK field definitions for a specific folder from the main branch in git.
#[allow(dead_code)]
fn load_fk_fields_for_folder(
    state: &AppState,
    id: &str,
    folder: &str,
) -> anyhow::Result<Vec<idx::FkField>> {
    let git_repo = GitRepo::open(&state.repos_dir, id)?;
    let schema_path = if folder.is_empty() {
        ".scratch/schema.json".to_string()
    } else {
        format!(".scratch/{}/schema.json", folder)
    };

    let Some(text) = git_repo.get_file_content("main", &schema_path)? else {
        return Ok(vec![]);
    };
    let schema: serde_json::Value = serde_json::from_str(&text)?;
    Ok(idx::extract_fk_fields(&schema))
}

/// Recursively collect all blob (file) entries from a git tree as `(path, ObjectId)` pairs.
///
/// Uses an iterative DFS with a stack to avoid borrow-checker conflicts from recursive
/// `find_object` calls while a `TreeRef` is alive.
fn collect_blobs(
    repo: &gix::Repository,
    root_tree_oid: gix::ObjectId,
) -> Result<Vec<(String, gix::ObjectId)>, AppError> {
    let mut result: Vec<(String, gix::ObjectId)> = Vec::new();
    let mut stack: Vec<(gix::ObjectId, String)> = vec![(root_tree_oid, String::new())];

    while let Some((tree_oid, prefix)) = stack.pop() {
        let obj = repo
            .find_object(tree_oid)
            .map_err(|e| AppError::internal(format!("find tree object: {}", e)))?;
        let tree = obj
            .try_into_tree()
            .map_err(|e| AppError::internal(format!("not a tree: {}", e)))?;

        // Collect entries into owned data before dropping the tree
        let mut children: Vec<(String, gix::ObjectId, bool)> = Vec::new();
        for entry_ref in tree.iter() {
            if let Ok(entry) = entry_ref {
                let name = std::str::from_utf8(entry.filename()).unwrap_or("").to_string();
                let full_path =
                    if prefix.is_empty() { name.clone() } else { format!("{}/{}", prefix, name) };
                let oid: gix::ObjectId = entry.object_id().into();
                children.push((full_path, oid, entry.mode().is_tree()));
            }
        }
        drop(tree);

        for (full_path, oid, is_tree) in children {
            if is_tree {
                stack.push((oid, full_path));
            } else {
                result.push((full_path, oid));
            }
        }
    }

    Ok(result)
}
