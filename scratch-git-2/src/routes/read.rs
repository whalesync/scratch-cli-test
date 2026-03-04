use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::io::Write;

use crate::envelope::{envelope_error, envelope_result};
use crate::error::AppError;
use crate::git::repo::GitRepo;
use crate::state::AppState;
use crate::types::*;

#[derive(Deserialize)]
pub struct ListQuery {
    pub branch: Option<String>,
    pub folder: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let branch = query.branch.as_deref().unwrap_or(MAIN_BRANCH);
            let folder = query.folder.as_deref().unwrap_or("");
            let folder = folder.strip_prefix('/').unwrap_or(folder);

            let commit_oid = match git_repo.resolve_ref(branch) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };

            let entries = git_repo.read_tree_at_path(commit_oid, folder)?;

            let files: Vec<_> = entries
                .into_iter()
                .map(|(name, _oid, is_tree)| {
                    let path = if folder.is_empty() {
                        name.clone()
                    } else {
                        format!("{}/{}", folder, name)
                    };
                    json!({
                        "name": name,
                        "path": path,
                        "type": if is_tree { "directory" } else { "file" },
                    })
                })
                .collect();

            Ok::<_, AppError>(json!(files))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: Option<String>,
    pub branch: Option<String>,
}

pub async fn file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let file_path = query
                .path
                .as_deref()
                .ok_or_else(|| AppError::bad_request("Query param path is required"))?;
            let branch = query.branch.as_deref().unwrap_or(MAIN_BRANCH);

            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let content = git_repo.get_file_content(branch, file_path)?;

            match content {
                Some(c) => Ok(json!({ "content": c })),
                None => Err(AppError::not_found("File not found")),
            }
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct DiffQuery {
    pub path: Option<String>,
}

pub async fn diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<DiffQuery>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let file_path = query
                .path
                .as_deref()
                .ok_or_else(|| AppError::bad_request("Query param path is required"))?;

            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let base_content = match git_repo.resolve_merge_base_or_main() {
                Ok(oid) => git_repo.get_file_content_by_commit(oid, file_path)?,
                Err(_) => None,
            };
            let dirty_content = git_repo.get_file_content(DIRTY_BRANCH, file_path)?;

            if base_content.is_none() && dirty_content.is_none() {
                return Ok(serde_json::Value::Null);
            }

            Ok(json!({
                "base": base_content,
                "dirty": dirty_content,
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
pub struct FilesFromFolderBody {
    pub branch: Option<String>,
    #[serde(rename = "folderPath")]
    pub folder_path: String,
    pub filenames: Vec<String>,
}

pub async fn files_from_folder(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<FilesFromFolderBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let branch = body.branch.as_deref().unwrap_or(MAIN_BRANCH);
            let folder = body.folder_path.strip_prefix('/').unwrap_or(&body.folder_path);

            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let commit_oid = match git_repo.resolve_ref(branch) {
                Ok(oid) => oid,
                Err(_) => {
                    let results: Vec<_> = body
                        .filenames
                        .iter()
                        .map(|name| {
                            let path = if folder.is_empty() {
                                name.clone()
                            } else {
                                format!("{}/{}", folder, name)
                            };
                            json!({ "path": path, "content": null })
                        })
                        .collect();
                    return Ok(json!(results));
                }
            };

            // Single tree walk to build oid map for the folder
            let entries = git_repo.read_tree_at_path(commit_oid, folder)?;
            let oid_map: std::collections::HashMap<String, gix::ObjectId> = entries
                .into_iter()
                .filter(|(_, _, is_tree)| !is_tree)
                .map(|(name, oid, _)| (name, oid))
                .collect();

            let results: Vec<_> = body
                .filenames
                .iter()
                .map(|name| {
                    let full_path = if folder.is_empty() {
                        name.clone()
                    } else {
                        format!("{}/{}", folder, name)
                    };
                    let content = oid_map.get(name).and_then(|oid| {
                        git_repo.read_blob_to_string(*oid).ok()
                    });
                    json!({ "path": full_path, "content": content })
                })
                .collect();

            Ok::<_, AppError>(json!(results))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct FilesBody {
    pub branch: Option<String>,
    pub paths: Vec<String>,
}

pub async fn files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<FilesBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let branch = body.branch.as_deref().unwrap_or(MAIN_BRANCH);
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            // Resolve commit ONCE for the whole batch
            let commit_oid = match git_repo.resolve_ref(branch) {
                Ok(oid) => oid,
                Err(_) => {
                    let results: Vec<_> = body.paths.iter().map(|path| json!({ "path": path, "content": serde_json::Value::Null })).collect();
                    return Ok(json!(results));
                }
            };

            // Group paths by folder to minimize tree traversals
            let mut by_folder: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
            for path in &body.paths {
                let normalized = path.strip_prefix('/').unwrap_or(path);
                let (folder, filename) = match normalized.rfind('/') {
                    Some(idx) => (&normalized[..idx], &normalized[idx + 1..]),
                    None => ("", normalized),
                };
                by_folder.entry(folder.to_string()).or_default().push(filename.to_string());
            }

            let mut results_map: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();

            for (folder, filenames) in by_folder {
                if let Ok(entries) = git_repo.read_tree_at_path(commit_oid, &folder) {
                    let oid_map: std::collections::HashMap<&str, gix::ObjectId> = entries
                        .iter()
                        .filter(|(_, _, is_tree)| !*is_tree)
                        .map(|(name, oid, _)| (name.as_str(), *oid))
                        .collect();
                    
                    for filename in filenames {
                        let full_path = if folder.is_empty() { filename.clone() } else { format!("{}/{}", folder, filename) };
                        let content = oid_map.get(filename.as_str())
                            .and_then(|oid| git_repo.read_blob_to_string(*oid).ok());
                        results_map.insert(full_path, content);
                    }
                } else {
                    for filename in filenames {
                        let full_path = if folder.is_empty() { filename.clone() } else { format!("{}/{}", folder, filename) };
                        results_map.insert(full_path, None);
                    }
                }
            }

            let results: Vec<_> = body.paths.iter().map(|path| {
                let normalized = path.strip_prefix('/').unwrap_or(path).to_string();
                let content = results_map.get(&normalized).cloned().flatten();
                json!({ "path": path, "content": content })
            }).collect();

            Ok::<_, AppError>(json!(results))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct FilesPaginatedQuery {
    pub branch: Option<String>,
    pub folder: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

pub async fn files_paginated(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<FilesPaginatedQuery>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let branch = query.branch.as_deref().unwrap_or(MAIN_BRANCH);
            let folder = query.folder.as_deref().unwrap_or("");
            let folder = folder.strip_prefix('/').unwrap_or(folder);
            let limit = query.limit.unwrap_or(50);

            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let commit_oid = match git_repo.resolve_ref(branch) {
                Ok(oid) => oid,
                Err(_) => {
                    return Ok(json!({ "files": [] }));
                }
            };

            // List all files in folder (direct children, skip dotfiles)
            let entries = git_repo.read_tree_at_path(commit_oid, folder)?;
            let mut file_entries: Vec<_> = entries
                .into_iter()
                .filter(|(name, _, is_tree)| !is_tree && !name.starts_with('.'))
                .map(|(name, oid, _)| (name, oid))
                .collect();
            file_entries.sort_by(|a, b| a.0.cmp(&b.0));

            // Apply cursor
            if let Some(cursor) = &query.cursor {
                if let Some(pos) = file_entries.iter().position(|(name, _)| name == cursor) {
                    file_entries = file_entries.into_iter().skip(pos + 1).collect();
                }
            }

            let has_more = file_entries.len() > limit;
            let paginated: Vec<_> = file_entries.into_iter().take(limit).collect();
            let next_cursor = if has_more {
                paginated.last().map(|(name, _)| name.clone())
            } else {
                None
            };

            let files: Vec<_> = paginated
                .iter()
                .map(|(name, oid)| {
                    let content = git_repo
                        .read_blob_to_string(*oid)
                        .unwrap_or_default();
                    json!({ "name": name, "content": content })
                })
                .collect();

            let mut result = serde_json::Map::new();
            result.insert("files".to_string(), json!(files));
            if let Some(cursor) = next_cursor {
                result.insert("nextCursor".to_string(), json!(cursor));
            }
            Ok::<_, AppError>(serde_json::Value::Object(result))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct BlobsByOidBody {
    pub oids: Vec<String>,
}

pub async fn blobs_by_oid(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<BlobsByOidBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            let results: Vec<_> = body
                .oids
                .iter()
                .map(|oid_str| {
                    let content = gix::ObjectId::from_hex(oid_str.as_bytes())
                        .ok()
                        .and_then(|oid| git_repo.read_blob_to_string(oid).ok());
                    json!({ "oid": oid_str, "content": content })
                })
                .collect();

            Ok::<_, AppError>(json!(results))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct ArchiveQuery {
    pub branch: Option<String>,
}

pub async fn archive(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ArchiveQuery>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let branch = query.branch.as_deref().unwrap_or(MAIN_BRANCH);
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let commit_oid = git_repo.resolve_ref(branch)?;

            // Get all files (skip dotfiles)
            let tree_files = git_repo.get_tree_files(commit_oid)?;

            // Create ZIP in memory
            let mut buf = Vec::new();
            {
                let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);

                let mut sorted_paths: Vec<_> = tree_files.keys().collect();
                sorted_paths.sort();

                for path in sorted_paths {
                    let oid_str = &tree_files[path];
                    let oid = gix::ObjectId::from_hex(oid_str.as_bytes())
                        .map_err(|e| AppError::internal(format!("Invalid OID: {}", e)))?;
                    let blob_data = git_repo.read_blob(oid)?;
                    zip.start_file(path, options)
                        .map_err(|e| AppError::internal(format!("ZIP error: {}", e)))?;
                    zip.write_all(&blob_data)
                        .map_err(|e| AppError::internal(format!("ZIP write error: {}", e)))?;
                }
                zip.finish()
                    .map_err(|e| AppError::internal(format!("ZIP finish error: {}", e)))?;
            }

            Ok::<_, AppError>((id.clone(), branch.to_string(), buf))
        }
    })
    .await;

    match result {
        Ok(Ok((repo_id, branch, buf))) => {
            let filename = format!("{}-{}.zip", repo_id, branch);
            Response::builder()
                .header(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", filename),
                )
                .header(header::CONTENT_TYPE, "application/zip")
                .body(Body::from(buf))
                .unwrap_or_else(|_| {
                    envelope_error(&state, Some(&id), AppError::internal("Failed to build response"))
                })
        }
        Ok(Err(e)) => envelope_error(&state, Some(&id), e),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}
