use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use crate::envelope::{envelope_error, envelope_result};
use crate::error::AppError;
use crate::git::repo::GitRepo;
use crate::state::AppState;
use crate::types::*;

pub async fn status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let main_oid = match git_repo.resolve_ref(MAIN_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };

            if main_oid == dirty_oid {
                return Ok(json!([]));
            }

            let changes = git_repo.compare_commits(main_oid, dirty_oid)?;
            Ok::<_, AppError>(serde_json::to_value(&changes).unwrap())
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn has_dirty(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let main_oid = match git_repo.resolve_ref(MAIN_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!({ "dirty": false })),
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!({ "dirty": false })),
            };

            if main_oid == dirty_oid {
                return Ok(json!({ "dirty": false }));
            }

            // Optimized: compare tree OIDs directly
            let main_tree = git_repo.get_commit_tree_oid(main_oid)?;
            let dirty_tree = git_repo.get_commit_tree_oid(dirty_oid)?;

            Ok::<_, AppError>(json!({ "dirty": main_tree != dirty_tree }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn count(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let main_oid = match git_repo.resolve_ref(MAIN_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!({ "count": 0 })),
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!({ "count": 0 })),
            };

            if main_oid == dirty_oid {
                return Ok(json!({ "count": 0 }));
            }

            let changes = git_repo.compare_commits(main_oid, dirty_oid)?;
            Ok::<_, AppError>(json!({ "count": changes.len() }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct FolderDiffQuery {
    pub folder: Option<String>,
}

pub async fn folder_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<FolderDiffQuery>,
) -> Response {
    let folder = match query.folder {
        Some(f) => f,
        None => {
            return envelope_error(
                &state,
                Some(&id),
                AppError::bad_request("Query param folder is required"),
            );
        }
    };

    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let main_oid = match git_repo.resolve_ref(MAIN_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };

            if main_oid == dirty_oid {
                return Ok(json!([]));
            }

            let all_changes = git_repo.compare_commits(main_oid, dirty_oid)?;
            let folder_norm = folder.strip_prefix('/').unwrap_or(&folder);
            let prefix = if folder_norm.ends_with('/') {
                folder_norm.to_string()
            } else {
                format!("{}/", folder_norm)
            };

            let filtered: Vec<_> = all_changes
                .into_iter()
                .filter(|c| c.path.starts_with(&prefix))
                .collect();

            Ok::<_, AppError>(serde_json::to_value(&filtered).unwrap())
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}
