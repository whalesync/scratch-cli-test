use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;

use crate::service::envelope::{envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::shared::index as idx;
use crate::shared::json_path::{read_record_id_as_string, DEFAULT_ID_PATH};

/// Optional JSON body of `POST /api/repo/index/{id}/build` (DEV-12616).
///
/// The NestJS server is moving table specs from git (`.scratch/**/schema.json`) into
/// Postgres, and sends them here so the index no longer depends on the git copies.
/// Keys are repo-relative folder keys exactly as the git schema loop derives them:
/// `DataFolder.path` minus its single leading `/`, `""` for the repo root, nested keys
/// (e.g. `"Webflow/Blog Posts"`) verbatim. Values are borrowed as raw JSON so a large
/// body is not copied into an owned `Value` tree up front; each spec is parsed one at a
/// time while building the schema maps.
///
/// Unknown fields are ignored (no `deny_unknown_fields`) for forward compatibility.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BuildIndexRequestBody<'a> {
    #[serde(borrow, default)]
    table_specs_by_repo_relative_folder_key: HashMap<String, &'a RawValue>,
}

/// Parse the optional build-index request body.
///
/// An empty or whitespace-only body means "no table specs supplied" — the request today's
/// server sends (always with `Content-Type: application/json`, which is why the handler
/// takes raw `Bytes` instead of axum's `Json` extractor). Malformed JSON, and any folder key
/// that starts or ends with `/`, is a 400: key normalization is the server's job, and a
/// drifted contract should fail fast rather than silently miss every folder.
///
/// Returns the 400 message on error; the handler wraps it in [`AppError::bad_request`].
fn parse_build_index_request_body(
    request_body_bytes: &[u8],
) -> Result<BuildIndexRequestBody<'_>, String> {
    let first_non_whitespace_byte = request_body_bytes
        .iter()
        .find(|byte| !byte.is_ascii_whitespace());
    match first_non_whitespace_byte {
        None => return Ok(BuildIndexRequestBody::default()),
        Some(b'{') => {}
        // serde's derived struct visitor also accepts the positional array form (`[]`,
        // `[{...}]`); only a JSON object is part of the contract.
        Some(_) => {
            return Err("invalid build-index request body: expected a JSON object".to_string())
        }
    }
    let parsed_request_body: BuildIndexRequestBody = serde_json::from_slice(request_body_bytes)
        .map_err(|e| format!("invalid build-index request body: {e}"))?;
    for repo_relative_folder_key in parsed_request_body
        .table_specs_by_repo_relative_folder_key
        .keys()
    {
        if repo_relative_folder_key.starts_with('/') || repo_relative_folder_key.ends_with('/') {
            return Err(format!(
                "invalid build-index request body: tableSpecsByRepoRelativeFolderKey key {:?} \
                 must not start or end with '/' (use the repo-relative folder key, \"\" for the root)",
                repo_relative_folder_key
            ));
        }
    }
    Ok(parsed_request_body)
}

/// Map a blob path in the `main` tree to the folder key its table spec describes, if the
/// blob is a `.scratch` schema file: `.scratch/schema.json` → `""` (repo root) and
/// `.scratch/<folderKey>/schema.json` → `<folderKey>` (nested keys kept verbatim).
/// Every other path → `None`.
fn folder_key_for_scratch_schema_blob_path(blob_path: &str) -> Option<&str> {
    let path_relative_to_scratch_dir = blob_path.strip_prefix(".scratch/")?;
    if path_relative_to_scratch_dir == "schema.json" {
        return Some("");
    }
    path_relative_to_scratch_dir.strip_suffix("/schema.json")
}

/// Rebuild the SQLite file index for a repo from its `main` tree.
///
/// Per-folder table specs (the id path and FK fields) come from two sources:
/// 1. The optional request body's `tableSpecsByRepoRelativeFolderKey` (see
///    [`BuildIndexRequestBody`]). A folder key present there is authoritative: git is
///    never read for it, even when the supplied spec declares no `idPath`/FKs or is not
///    an object (the defaults apply).
/// 2. `.scratch/**/schema.json` blobs on `main`, for every folder key the body did not
///    supply. An empty body therefore behaves exactly as before DEV-12616.
///
/// Response: `{ "count", "tableSpecFolderCountFromRequestBody",
/// "tableSpecFolderCountReadFromGit" }`. Folder keys are deliberately not returned (the
/// server route that proxies this is not workbook-scoped); the keys read from git are
/// logged instead.
pub async fn build_index(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request_body_bytes: Bytes,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let db_path = state.index_db_path(&id);
        let id = id.clone();
        move || {
            // Parse the body before touching the repo or the index DB, so a bad body
            // fails fast and leaves any existing index untouched.
            let request_body = parse_build_index_request_body(&request_body_bytes)
                .map_err(AppError::bad_request)?;
            let table_specs_by_repo_relative_folder_key =
                request_body.table_specs_by_repo_relative_folder_key;

            // First pass: build per-folder schema metadata (FK fields + id path).
            // Specs supplied in the request body win (parsed one at a time from their raw
            // JSON); `.scratch/**/schema.json` on `main` fills in every other folder.
            let mut schema_maps = idx::SchemaMaps::default();
            for (repo_relative_folder_key, raw_table_spec) in
                &table_specs_by_repo_relative_folder_key
            {
                let table_spec: Value =
                    serde_json::from_str(raw_table_spec.get()).map_err(|e| {
                        AppError::bad_request(format!(
                            "invalid table spec for folder key {:?}: {e}",
                            repo_relative_folder_key
                        ))
                    })?;
                schema_maps.record_schema(repo_relative_folder_key.clone(), &table_spec);
            }
            let table_spec_folder_count_from_request_body =
                table_specs_by_repo_relative_folder_key.len();

            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let commit_oid = git_repo.resolve_ref("main")?;
            let tree_oid = git_repo.get_commit_tree_oid(commit_oid)?;

            // Walk the entire tree and collect all blob paths + OIDs
            let blobs = collect_blobs(&git_repo.repo, tree_oid)?;

            let mut folder_keys_with_table_spec_read_from_git: Vec<String> = Vec::new();
            for (path, oid) in &blobs {
                let Some(folder_key) = folder_key_for_scratch_schema_blob_path(path) else {
                    continue;
                };
                if table_specs_by_repo_relative_folder_key.contains_key(folder_key) {
                    continue;
                }
                let Ok(content) = git_repo.read_blob(*oid) else {
                    continue;
                };
                let Ok(text) = std::str::from_utf8(&content) else {
                    continue;
                };
                let Ok(schema) = serde_json::from_str::<Value>(text) else {
                    continue;
                };
                schema_maps.record_schema(folder_key.to_string(), &schema);
                folder_keys_with_table_spec_read_from_git.push(folder_key.to_string());
            }
            folder_keys_with_table_spec_read_from_git.sort();
            let table_spec_folder_count_read_from_git =
                folder_keys_with_table_spec_read_from_git.len();

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

                let Ok(content) = git_repo.read_blob(*oid) else {
                    continue;
                };
                let Ok(text) = std::str::from_utf8(&content) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(text) else {
                    continue;
                };

                // Extract remote_id at the schema's id path (defaults to DEFAULT_ID_PATH for
                // connectors that don't declare one).
                let remote_id = read_record_id_as_string(&value, schema_maps.id_path(&folder));

                // FK references
                if let Some(fk_fields) = schema_maps.fk_map.get(&folder) {
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

            tracing::info!(
                "[INDEX] Built index for {}: {} record file(s); table specs from request body for {} folder(s), read from git for {} folder(s): {:?}",
                id,
                count,
                table_spec_folder_count_from_request_body,
                table_spec_folder_count_read_from_git,
                folder_keys_with_table_spec_read_from_git
            );

            Ok::<_, AppError>(serde_json::json!({
                "count": count,
                "tableSpecFolderCountFromRequestBody": table_spec_folder_count_from_request_body,
                "tableSpecFolderCountReadFromGit": table_spec_folder_count_read_from_git,
            }))
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
            let files = idx::read_index(&db_path).map_err(|e| AppError::internal(e.to_string()))?;
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
        move || {
            let map = idx::lookup_by_remote_ids(&db_path, &body.folder, &body.remote_ids)
                .map_err(|e| AppError::internal(e.to_string()))?;
            let json_map: serde_json::Map<String, Value> = map
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            Ok::<_, AppError>(Value::Object(json_map))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct UpsertEntriesRequest {
    /// Each entry: `[folder, filename, remote_id | null]`
    pub entries: Vec<(String, String, Option<String>)>,
}

/// Upsert a batch of (folder, filename, remote_id) entries into the SQLite index.
///
/// POST body: `{ "entries": [["contacts", "alice.json", "rec123"], ...] }`
pub async fn upsert_index_entries(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpsertEntriesRequest>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let db_path = state.index_db_path(&id);
        move || {
            idx::upsert_entries(&db_path, &body.entries)
                .map_err(|e| AppError::internal(e.to_string()))?;
            Ok::<_, AppError>(serde_json::json!({ "count": body.entries.len() }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct DeleteEntriesRequest {
    /// Each entry: `[folder, filename]`
    pub entries: Vec<(String, String)>,
}

/// Delete a batch of (folder, filename) entries from the SQLite index.
///
/// POST body: `{ "entries": [["contacts", "alice.json"], ...] }`
pub async fn delete_index_entries(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<DeleteEntriesRequest>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let db_path = state.index_db_path(&id);
        move || {
            idx::delete_entries(&db_path, &body.entries)
                .map_err(|e| AppError::internal(e.to_string()))?;
            Ok::<_, AppError>(serde_json::json!({ "count": body.entries.len() }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct LookupFilenamesRequest {
    pub folder: String,
    pub filenames: Vec<String>,
}

/// Resolve a batch of filenames to their remote IDs using the SQLite index.
///
/// POST body: `{ "folder": "contacts", "filenames": ["alice.json", "bob.json"] }`
/// Response:  `{ "alice.json": "rec123", "bob.json": "rec456" }`
pub async fn lookup_index_filenames(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<LookupFilenamesRequest>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let db_path = state.index_db_path(&id);
        move || {
            let map = idx::lookup_filenames_to_remote_ids(&db_path, &body.folder, &body.filenames)
                .map_err(|e| AppError::internal(e.to_string()))?;
            let json_map: serde_json::Map<String, Value> = map
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
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
    let (id_path, fk_fields) = load_schema_for_folder(state, id, folder)
        .unwrap_or_else(|_| (DEFAULT_ID_PATH.to_string(), vec![]));

    idx::upsert_single_file(
        &db_path,
        folder,
        filename,
        file_content,
        &id_path,
        &fk_fields,
    )
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

/// Read both the id path and FK field definitions for a specific folder
/// from the main branch in git. Returns `(DEFAULT_ID_PATH, [])` when the
/// schema is missing or the path isn't declared.
#[allow(dead_code)]
fn load_schema_for_folder(
    state: &AppState,
    id: &str,
    folder: &str,
) -> anyhow::Result<(String, Vec<idx::FkField>)> {
    let git_repo = GitRepo::open(&state.repos_dir, id)?;
    let schema_path = if folder.is_empty() {
        ".scratch/schema.json".to_string()
    } else {
        format!(".scratch/{}/schema.json", folder)
    };

    let Some(text) = git_repo.get_file_content("main", &schema_path)? else {
        return Ok((DEFAULT_ID_PATH.to_string(), vec![]));
    };
    let schema: serde_json::Value = serde_json::from_str(&text)?;
    let id_path = idx::extract_id_path(&schema).unwrap_or_else(|| DEFAULT_ID_PATH.to_string());
    Ok((id_path, idx::extract_fk_fields(&schema)))
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
                let name = std::str::from_utf8(entry.filename())
                    .unwrap_or("")
                    .to_string();
                let full_path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", prefix, name)
                };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::git::lock::RepoLocks;
    use crate::service::types::{ChangeType, FileChange, MAIN_BRANCH};
    use axum::http::StatusCode;
    use serde_json::json;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    /// Contract fixture for the build-index request body. The server half (DEV-12616 MR2b, which
    /// makes `ScratchGitClient.buildIndex` send table specs) must assert its client serializes
    /// exactly this shape; until then only this side is pinned.
    const BUILD_INDEX_REQUEST_BODY_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/build-index-request-body.json"
    ));

    fn make_state(repos_dir: &std::path::Path) -> AppState {
        AppState {
            repos_dir: repos_dir.to_path_buf(),
            index_dir: repos_dir.to_path_buf(),
            staging_dir: repos_dir.to_path_buf(),
            build_version: "test".to_string(),
            gc_state: std::sync::Arc::new(dashmap::DashMap::new()),
            repo_locks: std::sync::Arc::new(RepoLocks::new()),
            maintenance: std::sync::Arc::new(crate::service::maintenance::MaintenanceState::load(
                std::path::Path::new("/nonexistent-maintenance-dir"),
            )),
            run_store: Default::default(),
        }
    }

    fn commit_json_files_to_main(
        repo: &GitRepo,
        repo_relative_path_and_json_content: &[(&str, Value)],
    ) {
        let changes: Vec<FileChange> = repo_relative_path_and_json_content
            .iter()
            .map(|(repo_relative_path, json_content)| FileChange {
                path: repo_relative_path.to_string(),
                content: Some(json_content.to_string()),
                oid: None,
                change_type: ChangeType::Add,
            })
            .collect();
        repo.commit_changes_to_ref(MAIN_BRANCH, &changes, "seed main")
            .unwrap();
    }

    /// Call the handler directly and return `(status, envelope.data)`.
    async fn call_build_index(
        state: &AppState,
        repo_id: &str,
        request_body: &str,
    ) -> (StatusCode, Value) {
        let response = build_index(
            State(state.clone()),
            Path(repo_id.to_string()),
            Bytes::from(request_body.to_string()),
        )
        .await;
        let status = response.status();
        let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let envelope: Value = serde_json::from_slice(&body_bytes).unwrap();
        (status, envelope["data"].clone())
    }

    /// `(folder, filename) → remote_id` for every row of the built index.
    fn remote_ids_by_folder_and_filename(
        state: &AppState,
        repo_id: &str,
    ) -> BTreeMap<(String, String), Option<String>> {
        idx::read_index(&state.index_db_path(repo_id))
            .unwrap()
            .into_iter()
            .map(|row| ((row.folder, row.filename), row.remote_id))
            .collect()
    }

    fn remote_id_for(
        state: &AppState,
        repo_id: &str,
        folder: &str,
        filename: &str,
    ) -> Option<String> {
        remote_ids_by_folder_and_filename(state, repo_id)
            .get(&(folder.to_string(), filename.to_string()))
            .unwrap_or_else(|| panic!("{folder}/{filename} is not in the index"))
            .clone()
    }

    /// `(source_folder, source_filename, target_table_id, target_remote_id)` tuples.
    fn references(state: &AppState, repo_id: &str) -> Vec<(String, String, String, String)> {
        idx::read_references(&state.index_db_path(repo_id))
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row.source_folder,
                    row.source_filename,
                    row.target_table_id,
                    row.target_remote_id,
                )
            })
            .collect()
    }

    // ── folder_key_for_scratch_schema_blob_path ──────────────────────────────

    #[test]
    fn folder_key_for_scratch_schema_blob_path_maps_root_and_nested_schema_blobs() {
        assert_eq!(
            folder_key_for_scratch_schema_blob_path(".scratch/schema.json"),
            Some("")
        );
        assert_eq!(
            folder_key_for_scratch_schema_blob_path(".scratch/contacts/schema.json"),
            Some("contacts")
        );
        assert_eq!(
            folder_key_for_scratch_schema_blob_path(".scratch/Webflow/Blog Posts/schema.json"),
            Some("Webflow/Blog Posts")
        );
    }

    #[test]
    fn folder_key_for_scratch_schema_blob_path_ignores_non_schema_blobs() {
        for blob_path in [
            ".scratch/contacts/views/default.json",
            "contacts/schema.json",
            ".scratch/contacts/schema.json.bak",
            "schema.json",
            ".scratchy/contacts/schema.json",
        ] {
            assert_eq!(
                folder_key_for_scratch_schema_blob_path(blob_path),
                None,
                "{blob_path}"
            );
        }
    }

    // ── parse_build_index_request_body ───────────────────────────────────────

    #[test]
    fn parse_build_index_request_body_treats_empty_and_whitespace_as_no_specs() {
        for request_body in ["", "   ", "\n\t \r\n"] {
            let parsed = parse_build_index_request_body(request_body.as_bytes()).unwrap();
            assert!(
                parsed.table_specs_by_repo_relative_folder_key.is_empty(),
                "{request_body:?}"
            );
        }
    }

    #[test]
    fn parse_build_index_request_body_defaults_missing_map_and_ignores_unknown_fields() {
        let parsed = parse_build_index_request_body(b"{}").unwrap();
        assert!(parsed.table_specs_by_repo_relative_folder_key.is_empty());

        let parsed = parse_build_index_request_body(
            br#"{ "someFutureField": [1, 2, 3], "tableSpecsByRepoRelativeFolderKey": { "contacts": { "idPath": "id" } } }"#,
        )
        .unwrap();
        assert_eq!(parsed.table_specs_by_repo_relative_folder_key.len(), 1);
        assert_eq!(
            parsed.table_specs_by_repo_relative_folder_key["contacts"].get(),
            r#"{ "idPath": "id" }"#
        );

        let parsed = parse_build_index_request_body(br#"{ "someFutureField": true }"#).unwrap();
        assert!(parsed.table_specs_by_repo_relative_folder_key.is_empty());
    }

    #[test]
    fn parse_build_index_request_body_rejects_malformed_json() {
        for request_body in [
            "{",
            "not json",
            r#"{ "tableSpecsByRepoRelativeFolderKey": [] }"#,
            r#"{ "tableSpecsByRepoRelativeFolderKey": { "contacts": } }"#,
            r#"{ "tableSpecsByRepoRelativeFolderKey": null }"#,
            r#"{ "tableSpecsByRepoRelativeFolderKey": {} } trailing"#,
            "[]",
            r#"[{ "contacts": {} }]"#,
            "null",
            "42",
            r#""tableSpecsByRepoRelativeFolderKey""#,
        ] {
            let error_message = parse_build_index_request_body(request_body.as_bytes())
                .err()
                .unwrap_or_else(|| panic!("expected {request_body:?} to be rejected"));
            assert!(
                error_message.starts_with("invalid build-index request body"),
                "{request_body:?}: {error_message}"
            );
        }
    }

    #[test]
    fn parse_build_index_request_body_rejects_keys_with_leading_or_trailing_slash() {
        for folder_key in ["/contacts", "contacts/", "/", "/Webflow/Blog Posts"] {
            let request_body = json!({ "tableSpecsByRepoRelativeFolderKey": { folder_key: {} } });
            let error_message = parse_build_index_request_body(request_body.to_string().as_bytes())
                .err()
                .unwrap_or_else(|| panic!("expected key {folder_key:?} to be rejected"));
            assert!(
                error_message.contains("must not start or end with '/'"),
                "{folder_key:?}: {error_message}"
            );
        }
        // The root key and nested keys are accepted verbatim.
        let request_body = json!({
            "tableSpecsByRepoRelativeFolderKey": { "": {}, "Webflow/Blog Posts": {} }
        });
        let request_body_text = request_body.to_string();
        let parsed = parse_build_index_request_body(request_body_text.as_bytes()).unwrap();
        assert_eq!(parsed.table_specs_by_repo_relative_folder_key.len(), 2);
    }

    #[test]
    fn shared_fixture_parses_to_the_expected_folder_keys() {
        let parsed =
            parse_build_index_request_body(BUILD_INDEX_REQUEST_BODY_FIXTURE.as_bytes()).unwrap();
        let mut folder_keys: Vec<&str> = parsed
            .table_specs_by_repo_relative_folder_key
            .keys()
            .map(String::as_str)
            .collect();
        folder_keys.sort();
        assert_eq!(folder_keys, vec!["Webflow/Blog Posts", "contacts"]);
    }

    // ── build_index handler ──────────────────────────────────────────────────

    #[tokio::test]
    async fn empty_body_reads_table_specs_from_git() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (
                    ".scratch/contacts/schema.json",
                    json!({ "idPath": "id.record_id" }),
                ),
                (
                    "contacts/alice.json",
                    json!({ "id": { "record_id": "r_1" } }),
                ),
            ],
        );
        let state = make_state(tmp.path());

        let (status, data) = call_build_index(&state, "t/idx", "").await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(data["count"], 1);
        assert_eq!(data["tableSpecFolderCountFromRequestBody"], 0);
        assert_eq!(data["tableSpecFolderCountReadFromGit"], 1);
        assert!(data.get("folderKeys").is_none());
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "alice.json"),
            Some("r_1".to_string())
        );
    }

    #[tokio::test]
    async fn body_id_path_wins_over_git_for_the_same_folder() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (".scratch/contacts/schema.json", json!({ "idPath": "id" })),
                (
                    "contacts/alice.json",
                    json!({ "id": { "record_id": "r_1" } }),
                ),
            ],
        );
        let state = make_state(tmp.path());

        let request_body = json!({
            "tableSpecsByRepoRelativeFolderKey": { "contacts": { "idPath": "id.record_id" } }
        });
        let (status, data) = call_build_index(&state, "t/idx", &request_body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(data["tableSpecFolderCountFromRequestBody"], 1);
        assert_eq!(data["tableSpecFolderCountReadFromGit"], 0);
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "alice.json"),
            Some("r_1".to_string())
        );
    }

    #[tokio::test]
    async fn body_spec_without_fk_fields_suppresses_git_fk_fields() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (
                    ".scratch/contacts/schema.json",
                    json!({
                        "idPath": "id",
                        "schema": { "properties": {
                            "company": { "x-scratch-foreign-key": { "linkedTableId": "companies" } }
                        } }
                    }),
                ),
                (
                    "contacts/alice.json",
                    json!({ "id": "rec_1", "company": "cmp_1" }),
                ),
            ],
        );
        let state = make_state(tmp.path());

        // Control: git's FK field produces a reference.
        let (status, _) = call_build_index(&state, "t/idx", "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            references(&state, "t/idx"),
            vec![(
                "contacts".to_string(),
                "alice.json".to_string(),
                "companies".to_string(),
                "cmp_1".to_string()
            )]
        );

        // The body's spec has no FK fields, and it is authoritative for `contacts`.
        let request_body = json!({
            "tableSpecsByRepoRelativeFolderKey": {
                "contacts": { "idPath": "id", "schema": { "properties": { "company": { "type": "string" } } } }
            }
        });
        let (status, data) = call_build_index(&state, "t/idx", &request_body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert!(references(&state, "t/idx").is_empty());
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "alice.json"),
            Some("rec_1".to_string())
        );
    }

    #[tokio::test]
    async fn folders_missing_from_the_body_fall_back_to_git() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (".scratch/contacts/schema.json", json!({ "idPath": "id" })),
                (
                    ".scratch/companies/schema.json",
                    json!({ "idPath": "companyId" }),
                ),
                (
                    "contacts/alice.json",
                    json!({ "id": { "record_id": "r_1" } }),
                ),
                (
                    "companies/acme.json",
                    json!({ "id": "ignored", "companyId": "c_1" }),
                ),
            ],
        );
        let state = make_state(tmp.path());

        let request_body = json!({
            "tableSpecsByRepoRelativeFolderKey": { "contacts": { "idPath": "id.record_id" } }
        });
        let (status, data) = call_build_index(&state, "t/idx", &request_body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(data["count"], 2);
        assert_eq!(data["tableSpecFolderCountFromRequestBody"], 1);
        assert_eq!(data["tableSpecFolderCountReadFromGit"], 1);
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "alice.json"),
            Some("r_1".to_string())
        );
        assert_eq!(
            remote_id_for(&state, "t/idx", "companies", "acme.json"),
            Some("c_1".to_string())
        );
    }

    #[tokio::test]
    async fn body_only_specs_index_without_any_scratch_dir_in_git() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (
                    "contacts/alice.json",
                    json!({ "id": { "record_id": "r_1" }, "company": "cmp_1" }),
                ),
                (
                    "contacts/bob.json",
                    json!({ "id": { "record_id": "r_2" }, "company": ["cmp_1", 7] }),
                ),
            ],
        );
        let state = make_state(tmp.path());

        let request_body = json!({
            "tableSpecsByRepoRelativeFolderKey": {
                "contacts": {
                    "idPath": "id.record_id",
                    "schema": { "properties": {
                        "company": { "x-scratch-foreign-key": { "linkedTableId": "companies" } }
                    } }
                }
            }
        });
        let (status, data) = call_build_index(&state, "t/idx", &request_body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(data["count"], 2);
        assert_eq!(data["tableSpecFolderCountFromRequestBody"], 1);
        assert_eq!(data["tableSpecFolderCountReadFromGit"], 0);
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "alice.json"),
            Some("r_1".to_string())
        );
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "bob.json"),
            Some("r_2".to_string())
        );
        let reference = |filename: &str, target_remote_id: &str| {
            (
                "contacts".to_string(),
                filename.to_string(),
                "companies".to_string(),
                target_remote_id.to_string(),
            )
        };
        let mut references_sorted = references(&state, "t/idx");
        references_sorted.sort();
        assert_eq!(
            references_sorted,
            vec![
                reference("alice.json", "cmp_1"),
                reference("bob.json", "7"),
                reference("bob.json", "cmp_1"),
            ]
        );
    }

    #[tokio::test]
    async fn body_spec_without_id_path_uses_default_and_never_falls_back_to_git() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (".scratch/contacts/schema.json", json!({ "idPath": "uuid" })),
                (
                    "contacts/alice.json",
                    json!({ "id": "rec_flat", "uuid": "u_1" }),
                ),
            ],
        );
        let state = make_state(tmp.path());

        // Control: git's idPath wins with no body.
        call_build_index(&state, "t/idx", "").await;
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "alice.json"),
            Some("u_1".to_string())
        );

        // An object spec with no idPath, a null spec, and a non-object spec are all
        // authoritative: DEFAULT_ID_PATH applies and git's "uuid" is never consulted.
        for table_spec in [
            json!({ "slug": "contacts" }),
            json!(null),
            json!("not an object"),
        ] {
            let request_body =
                json!({ "tableSpecsByRepoRelativeFolderKey": { "contacts": table_spec } });
            let (status, data) = call_build_index(&state, "t/idx", &request_body.to_string()).await;
            assert_eq!(status, StatusCode::OK, "{data}");
            assert_eq!(data["tableSpecFolderCountFromRequestBody"], 1);
            assert_eq!(data["tableSpecFolderCountReadFromGit"], 0);
            assert_eq!(DEFAULT_ID_PATH, "id");
            assert_eq!(
                remote_id_for(&state, "t/idx", "contacts", "alice.json"),
                Some("rec_flat".to_string()),
                "spec {table_spec}"
            );
        }
    }

    #[tokio::test]
    async fn root_folder_key_applies_to_root_level_records_only() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (".scratch/schema.json", json!({ "idPath": "id" })),
                ("alice.json", json!({ "id": "rec_1", "uuid": "u_1" })),
                ("contacts/bob.json", json!({ "id": "rec_2", "uuid": "u_2" })),
            ],
        );
        let state = make_state(tmp.path());

        let request_body =
            json!({ "tableSpecsByRepoRelativeFolderKey": { "": { "idPath": "uuid" } } });
        let (status, data) = call_build_index(&state, "t/idx", &request_body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(data["tableSpecFolderCountFromRequestBody"], 1);
        // `.scratch/schema.json` maps to the root key, which the body already supplied.
        assert_eq!(data["tableSpecFolderCountReadFromGit"], 0);
        assert_eq!(
            remote_id_for(&state, "t/idx", "", "alice.json"),
            Some("u_1".to_string())
        );
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "bob.json"),
            Some("rec_2".to_string())
        );
    }

    #[tokio::test]
    async fn nested_folder_key_applies_only_to_the_nested_folder() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                (
                    "Webflow/Blog Posts/post-1.json",
                    json!({ "id": "x", "_id": "wf_1" }),
                ),
                ("Webflow/parent.json", json!({ "id": "p_1", "_id": "wf_p" })),
            ],
        );
        let state = make_state(tmp.path());

        let request_body = json!({
            "tableSpecsByRepoRelativeFolderKey": { "Webflow/Blog Posts": { "idPath": "_id" } }
        });
        let (status, data) = call_build_index(&state, "t/idx", &request_body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(
            remote_id_for(&state, "t/idx", "Webflow/Blog Posts", "post-1.json"),
            Some("wf_1".to_string())
        );
        assert_eq!(
            remote_id_for(&state, "t/idx", "Webflow", "parent.json"),
            Some("p_1".to_string())
        );
    }

    #[tokio::test]
    async fn invalid_body_returns_400_and_leaves_existing_index_untouched() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(&repo, &[("contacts/alice.json", json!({ "id": "rec_1" }))]);
        let state = make_state(tmp.path());

        let (status, _) = call_build_index(&state, "t/idx", "").await;
        assert_eq!(status, StatusCode::OK);
        let index_db_bytes_before = std::fs::read(state.index_db_path("t/idx")).unwrap();

        // A new record lands on main; a successful rebuild would index it.
        commit_json_files_to_main(&repo, &[("contacts/bob.json", json!({ "id": "rec_2" }))]);

        let leading_slash_body =
            json!({ "tableSpecsByRepoRelativeFolderKey": { "/contacts": {} } });
        for invalid_request_body in [
            "{ not json".to_string(),
            r#"{ "tableSpecsByRepoRelativeFolderKey": [] }"#.to_string(),
            leading_slash_body.to_string(),
        ] {
            let (status, data) = call_build_index(&state, "t/idx", &invalid_request_body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid_request_body}");
            assert!(data["error"]
                .as_str()
                .unwrap()
                .contains("build-index request body"));
            assert_eq!(
                std::fs::read(state.index_db_path("t/idx")).unwrap(),
                index_db_bytes_before
            );
            assert_eq!(
                remote_ids_by_folder_and_filename(&state, "t/idx")
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>(),
                vec![("contacts".to_string(), "alice.json".to_string())]
            );
        }

        // A malformed body is rejected before the repo is opened, so even a missing repo
        // reports the 400 rather than a 404.
        let (status, _) = call_build_index(&state, "t/missing", "{").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!state.index_db_path("t/missing").exists());
    }

    #[tokio::test]
    async fn shared_fixture_drives_the_expected_id_paths_and_fk_references() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/idx").unwrap();
        commit_json_files_to_main(
            &repo,
            &[
                // Stale git mirror that the fixture must override.
                (".scratch/contacts/schema.json", json!({ "idPath": "id" })),
                (
                    "contacts/alice.json",
                    json!({ "id": { "record_id": "r_1" }, "company": "cmp_1" }),
                ),
                (
                    "Webflow/Blog Posts/hello-world.json",
                    json!({ "id": "not-this", "_id": "wf_1", "name": "Hello" }),
                ),
            ],
        );
        let state = make_state(tmp.path());

        let (status, data) =
            call_build_index(&state, "t/idx", BUILD_INDEX_REQUEST_BODY_FIXTURE).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert_eq!(data["count"], 2);
        assert_eq!(data["tableSpecFolderCountFromRequestBody"], 2);
        assert_eq!(data["tableSpecFolderCountReadFromGit"], 0);
        assert_eq!(
            remote_id_for(&state, "t/idx", "contacts", "alice.json"),
            Some("r_1".to_string())
        );
        assert_eq!(
            remote_id_for(&state, "t/idx", "Webflow/Blog Posts", "hello-world.json"),
            Some("wf_1".to_string())
        );
        assert_eq!(
            references(&state, "t/idx"),
            vec![(
                "contacts".to_string(),
                "alice.json".to_string(),
                "companies".to_string(),
                "cmp_1".to_string()
            )]
        );
    }

    // ── router level ─────────────────────────────────────────────────────────

    /// Today's server (`callGitApi`) always sends `Content-Type: application/json`, even
    /// with no body. axum's `Json` extractor would 400 that; the `Bytes` extractor must not.
    #[tokio::test]
    async fn router_accepts_json_content_type_with_empty_body() {
        use axum::body::Body;
        use axum::http::{header::CONTENT_TYPE, Request};
        use axum::routing::post;
        use tower::ServiceExt; // for `oneshot`

        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "org_a/wkb_b/coa_c").unwrap();
        commit_json_files_to_main(&repo, &[("contacts/alice.json", json!({ "id": "rec_1" }))]);
        let state = make_state(tmp.path());

        let router = axum::Router::new()
            .route("/api/repo/index/{id}/build", post(build_index))
            .layer(axum::extract::DefaultBodyLimit::max(50 * 1024 * 1024))
            .with_state(state.clone());

        let send_build_request = |request_body: Body| {
            let router = router.clone();
            async move {
                router
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri("/api/repo/index/org_a%2Fwkb_b%2Fcoa_c/build")
                            .header(CONTENT_TYPE, "application/json")
                            .body(request_body)
                            .unwrap(),
                    )
                    .await
                    .unwrap()
            }
        };

        let response = send_build_request(Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let envelope: Value = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(envelope["data"]["count"], 1);
        assert_eq!(
            remote_id_for(&state, "org_a/wkb_b/coa_c", "contacts", "alice.json"),
            Some("rec_1".to_string())
        );

        let response = send_build_request(Body::from(BUILD_INDEX_REQUEST_BODY_FIXTURE)).await;
        assert_eq!(response.status(), StatusCode::OK);

        let response = send_build_request(Body::from("{")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
