use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;

use crate::service::envelope::{envelope, envelope_error};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::service::types::*;

// ---------------------------------------------------------------------------
// POST /api/staging/{jobId}/files — write a batch of files to staging
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct StageFilesBody {
    pub folder: String,
    pub files: Vec<StageFileInput>,
}

#[derive(Deserialize)]
pub struct StageFileInput {
    pub path: String,
    pub content: String,
}

pub async fn stage_files(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Json(body): Json<StageFilesBody>,
) -> Response {
    let folder = body.folder;
    let files = body.files;
    let staging_dir = state.staging_job_path(&job_id);
    let folder_dir = staging_dir.join(&folder);

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&folder_dir)
            .map_err(|e| AppError::internal(format!("Failed to create staging dir: {}", e)))?;

        let count = files.len();
        for file in &files {
            let file_path = folder_dir.join(&file.path);
            // Ensure parent dirs exist (for nested paths)
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::internal(format!("Failed to create parent dir: {}", e))
                })?;
            }
            std::fs::write(&file_path, &file.content)
                .map_err(|e| AppError::internal(format!("Failed to write staged file: {}", e)))?;
        }

        Ok(json!({ "count": count }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

// ---------------------------------------------------------------------------
// GET /api/staging/{jobId}/files?folder=X&offset=0&limit=100
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ReadStagedFilesQuery {
    pub folder: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    100
}

pub async fn read_staged_files(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Query(query): Query<ReadStagedFilesQuery>,
) -> Response {
    let folder_dir = state.staging_job_path(&job_id).join(&query.folder);
    let offset = query.offset;
    let limit = query.limit;

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        if !folder_dir.exists() {
            return Ok(json!({ "files": [], "total": 0 }));
        }

        // Step 1: Collect only file paths (no content) — cheap
        let mut paths = collect_paths_recursive(&folder_dir, &folder_dir)?;
        paths.sort();

        let total = paths.len();

        // Step 2: Read content only for the requested page
        let page: Vec<serde_json::Value> = paths
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|rel_path| {
                let full_path = folder_dir.join(&rel_path);
                let content = std::fs::read_to_string(&full_path).unwrap_or_default();
                json!({ "path": rel_path, "content": content })
            })
            .collect();

        Ok(json!({ "files": page, "total": total }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

/// Recursively collect file paths under `base_dir` without reading content.
fn collect_paths_recursive(dir: &PathBuf, base_dir: &PathBuf) -> Result<Vec<String>, AppError> {
    let mut results = Vec::new();
    let read_dir = std::fs::read_dir(dir)
        .map_err(|e| AppError::internal(format!("Failed to read staging dir: {}", e)))?;

    for entry in read_dir {
        let entry =
            entry.map_err(|e| AppError::internal(format!("Failed to read dir entry: {}", e)))?;
        let path = entry.path();

        if path.is_dir() {
            results.extend(collect_paths_recursive(&path, base_dir)?);
        } else {
            let rel_path = path
                .strip_prefix(base_dir)
                .map_err(|e| AppError::internal(format!("Failed to strip prefix: {}", e)))?
                .to_string_lossy()
                .to_string();
            results.push(rel_path);
        }
    }

    Ok(results)
}

/// Recursively collect all files under `base_dir`, returning (relative_path, content) pairs.
fn collect_files_recursive(
    dir: &PathBuf,
    base_dir: &PathBuf,
) -> Result<Vec<(String, String)>, AppError> {
    let mut results = Vec::new();
    let read_dir = std::fs::read_dir(dir)
        .map_err(|e| AppError::internal(format!("Failed to read staging dir: {}", e)))?;

    for entry in read_dir {
        let entry =
            entry.map_err(|e| AppError::internal(format!("Failed to read dir entry: {}", e)))?;
        let path = entry.path();

        if path.is_dir() {
            results.extend(collect_files_recursive(&path, base_dir)?);
        } else {
            let rel_path = path
                .strip_prefix(base_dir)
                .map_err(|e| AppError::internal(format!("Failed to strip prefix: {}", e)))?
                .to_string_lossy()
                .to_string();
            let content = std::fs::read_to_string(&path)
                .map_err(|e| AppError::internal(format!("Failed to read staged file: {}", e)))?;
            results.push((rel_path, content));
        }
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// POST /api/staging/{jobId}/commit — commit staged folder to git
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStagedBody {
    pub repo_id: String,
    pub branch: Option<String>,
    pub folder: String,
    pub message: Option<String>,
}

pub async fn commit_staged(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Json(body): Json<CommitStagedBody>,
) -> Response {
    let branch = body.branch.unwrap_or_else(|| MAIN_BRANCH.to_string());
    let folder_dir = state.staging_job_path(&job_id).join(&body.folder);
    let repo_id = body.repo_id.clone();
    let message = body
        .message
        .unwrap_or_else(|| format!("Commit staged files for {}", body.folder));

    let folder_name = body.folder.clone();
    let result = {
        let repos_dir = state.repos_dir.clone();
        let write_locks = state.write_locks.clone();
        let branch_clone = branch.clone();
        let repo_id_clone = repo_id.clone();

        write_locks
            .with_lock(&repo_id_clone, &branch_clone, || {
                let repos_dir = repos_dir.clone();
                let repo_id = repo_id_clone.clone();
                let branch = branch_clone.clone();
                let folder_name = folder_name.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &repo_id)?;

                        if !folder_dir.exists() {
                            return Err(AppError::not_found(format!(
                                "Staging folder not found: {}",
                                folder_dir.display()
                            )));
                        }

                        // Read all staged files from disk
                        let base_dir = folder_dir.clone();
                        let entries = collect_files_recursive(&folder_dir, &base_dir)?;

                        // Prepend the folder name to each path so git commits
                        // files at the correct location (e.g., "Products/file.json")
                        let changes: Vec<FileChange> = entries
                            .into_iter()
                            .map(|(rel_path, content)| FileChange {
                                path: format!("{}/{}", folder_name, rel_path),
                                content: Some(content),
                                oid: None,
                                change_type: ChangeType::Modify,
                            })
                            .collect();

                        if changes.is_empty() {
                            return Ok(json!({
                                "success": true,
                                "created": [],
                                "updated": [],
                                "unchanged": [],
                            }));
                        }

                        let (_, stats) =
                            git_repo.commit_changes_to_ref(&branch, &changes, &message)?;

                        Ok::<_, AppError>(json!({
                            "success": true,
                            "created": stats.created,
                            "updated": stats.updated,
                            "unchanged": stats.unchanged,
                        }))
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await
    };

    match result {
        Ok(data) => envelope(&state, Some(&repo_id), data),
        Err(err) => envelope_error(&state, Some(&repo_id), err),
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/staging/{jobId} — remove staging directory for a job
// ---------------------------------------------------------------------------

pub async fn cleanup_staging(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Response {
    let staging_dir = state.staging_job_path(&job_id);

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        if staging_dir.exists() {
            std::fs::remove_dir_all(&staging_dir)
                .map_err(|e| AppError::internal(format!("Failed to remove staging dir: {}", e)))?;
        }
        Ok(json!({ "success": true }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_paths_recursive_flat_directory() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();

        std::fs::write(base.join("a.json"), "{}").unwrap();
        std::fs::write(base.join("b.json"), "{}").unwrap();

        let mut paths = collect_paths_recursive(&base, &base).unwrap();
        paths.sort();

        assert_eq!(paths, vec!["a.json", "b.json"]);
    }

    #[test]
    fn collect_paths_recursive_nested_directories() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();

        std::fs::create_dir_all(base.join("sub/deep")).unwrap();
        std::fs::write(base.join("top.json"), "{}").unwrap();
        std::fs::write(base.join("sub/mid.json"), "{}").unwrap();
        std::fs::write(base.join("sub/deep/bottom.json"), "{}").unwrap();

        let mut paths = collect_paths_recursive(&base, &base).unwrap();
        paths.sort();

        assert_eq!(
            paths,
            vec!["sub/deep/bottom.json", "sub/mid.json", "top.json"]
        );
    }

    #[test]
    fn collect_paths_recursive_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();

        let paths = collect_paths_recursive(&base, &base).unwrap();

        assert_eq!(paths, Vec::<String>::new());
    }

    #[test]
    fn collect_files_recursive_reads_content() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();

        std::fs::create_dir_all(base.join("nested")).unwrap();
        std::fs::write(base.join("hello.txt"), "hello world").unwrap();
        std::fs::write(base.join("nested/data.json"), r#"{"key":"val"}"#).unwrap();

        let mut files = collect_files_recursive(&base, &base).unwrap();
        files.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "hello.txt");
        assert_eq!(files[0].1, "hello world");
        assert_eq!(files[1].0, "nested/data.json");
        assert_eq!(files[1].1, r#"{"key":"val"}"#);
    }

    #[test]
    fn collect_paths_recursive_returns_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();

        std::fs::write(base.join("file.txt"), "content").unwrap();

        let paths = collect_paths_recursive(&base, &base).unwrap();

        assert_eq!(paths.len(), 1);
        assert!(!paths[0].starts_with('/'));
        assert_eq!(paths[0], "file.txt");
    }

    #[test]
    fn commit_path_prepends_folder_name() {
        let folder_name = "Products";
        let rel_path = "item-123.json";

        let committed_path = format!("{}/{}", folder_name, rel_path);

        assert_eq!(committed_path, "Products/item-123.json");
    }

    #[test]
    fn commit_path_prepends_folder_name_nested() {
        let folder_name = "Products";
        let rel_path = "sub/nested/item.json";

        let committed_path = format!("{}/{}", folder_name, rel_path);

        assert_eq!(committed_path, "Products/sub/nested/item.json");
    }
}
