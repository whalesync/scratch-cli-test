use std::path::PathBuf;

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::git::{self, DiffEntry, FileEntry, ReadFileEntry, RebaseDirtyResult, UpsertResult};
use crate::{Error, Result};

use super::AppState;

// ---------------------------------------------------------------------------
// POST /api/repos/init
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct InitRepoRequest {
    /// Absolute path where the bare repo should be created
    pub path: String,
}

#[derive(Serialize)]
pub struct InitRepoResponse {
    pub ok: bool,
    pub path: String,
}

pub async fn init_repo(
    State(state): State<AppState>,
    Json(body): Json<InitRepoRequest>,
) -> Result<Json<InitRepoResponse>> {
    let path = PathBuf::from(&body.path);

    // Validate that path is under repos_dir (basic security check)
    if !path.starts_with(&state.repos_dir) {
        return Err(Error::Other(format!(
            "path must be under repos_dir ({})",
            state.repos_dir.display()
        )));
    }

    tokio::task::spawn_blocking(move || git::init_repo(&path))
        .await
        .map_err(|e| Error::Other(e.to_string()))??;

    Ok(Json(InitRepoResponse {
        ok: true,
        path: body.path,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/repos/upsert-files
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertFilesRequest {
    /// Absolute path to the bare repo
    pub repo_path: String,
    /// Folder within the repo, e.g. "tableId/records"
    pub folder: String,
    /// Commit message
    pub message: String,
    /// Files to upsert
    pub files: Vec<FileEntry>,
}

pub async fn upsert_files(
    State(state): State<AppState>,
    body: std::result::Result<Json<UpsertFilesRequest>, JsonRejection>,
) -> std::result::Result<Json<UpsertResult>, (StatusCode, Json<serde_json::Value>)> {
    let Json(body) = body.map_err(|e| {
        tracing::error!("upsert-files JSON rejection: {}", e);
        (
            e.status(),
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;
    let repo_path = PathBuf::from(&body.repo_path);

    if !repo_path.starts_with(&state.repos_dir) {
        let msg = format!("repoPath must be under repos_dir ({})", state.repos_dir.display());
        tracing::error!("upsert-files: {}", msg);
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))));
    }

    let lock = state.lock.clone();

    let result = tokio::task::spawn_blocking(move || {
        git::upsert_files(&repo_path, &body.folder, &body.message, &body.files, &lock)
    })
    .await
    .map_err(|e| {
        let msg = e.to_string();
        tracing::error!("upsert-files spawn error: {}", msg);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg })))
    })?
    .map_err(|e| {
        tracing::error!("upsert-files git error: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() })))
    })?;

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// POST /api/repos/rebase-dirty
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseDirtyRequest {
    pub repo_path: String,
}

pub async fn rebase_dirty(
    State(state): State<AppState>,
    Json(body): Json<RebaseDirtyRequest>,
) -> Result<Json<RebaseDirtyResult>> {
    let repo_path = PathBuf::from(&body.repo_path);

    if !repo_path.starts_with(&state.repos_dir) {
        return Err(Error::Other(format!(
            "repoPath must be under repos_dir ({})",
            state.repos_dir.display()
        )));
    }

    let lock = state.lock.clone();
    let result = tokio::task::spawn_blocking(move || git::rebase_dirty(&repo_path, &lock))
        .await
        .map_err(|e| Error::Other(e.to_string()))??;

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// POST /api/repos/diff
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub repo_path: String,
    pub base_branch: String,
    pub head_branch: String,
}

#[derive(Serialize)]
pub struct DiffResponse {
    pub files: Vec<DiffEntry>,
}

pub async fn diff(
    State(state): State<AppState>,
    Json(body): Json<DiffRequest>,
) -> Result<Json<DiffResponse>> {
    let repo_path = PathBuf::from(&body.repo_path);

    if !repo_path.starts_with(&state.repos_dir) {
        return Err(Error::Other(format!(
            "repoPath must be under repos_dir ({})",
            state.repos_dir.display()
        )));
    }

    let files = tokio::task::spawn_blocking(move || {
        git::diff_branches(&repo_path, &body.base_branch, &body.head_branch)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))??;

    Ok(Json(DiffResponse { files }))
}

// ---------------------------------------------------------------------------
// POST /api/repos/read-files
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFilesRequest {
    pub repo_path: String,
    pub branch: String,
    /// Folder path within the repo, e.g. "MyBase/Posts"
    pub folder_path: String,
    /// Filenames within the folder, e.g. ["recAbc.json", "recDef.json"]
    pub file_names: Vec<String>,
}

#[derive(Serialize)]
pub struct ReadFilesResponse {
    pub files: Vec<ReadFileEntry>,
}

pub async fn read_files(
    State(state): State<AppState>,
    Json(body): Json<ReadFilesRequest>,
) -> Result<Json<ReadFilesResponse>> {
    let repo_path = PathBuf::from(&body.repo_path);

    if !repo_path.starts_with(&state.repos_dir) {
        return Err(Error::Other(format!(
            "repoPath must be under repos_dir ({})",
            state.repos_dir.display()
        )));
    }

    let files = tokio::task::spawn_blocking(move || {
        git::read_files(&repo_path, &body.branch, &body.folder_path, &body.file_names)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))??;

    Ok(Json(ReadFilesResponse { files }))
}
