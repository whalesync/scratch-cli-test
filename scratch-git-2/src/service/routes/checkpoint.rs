use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::service::envelope::{envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::service::types::*;

#[derive(Deserialize)]
pub struct CreateCheckpointBody {
    pub name: String,
}

pub async fn create_checkpoint(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CreateCheckpointBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;
            let dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH).unwrap_or(main_oid);

            git_repo.write_tag(&format!("main_{}", body.name), main_oid)?;
            git_repo.write_tag(&format!("dirty_{}", body.name), dirty_oid)?;

            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn list_checkpoints(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let tags = git_repo.list_tags()?;

            let main_tags: Vec<_> = tags
                .iter()
                .filter(|(name, _)| name.starts_with("main_"))
                .map(|(name, oid)| (name[5..].to_string(), *oid))
                .collect();

            let dirty_tags: std::collections::HashSet<_> = tags
                .iter()
                .filter(|(name, _)| name.starts_with("dirty_"))
                .map(|(name, _)| name[6..].to_string())
                .collect();

            let mut checkpoints = Vec::new();
            for (name, _) in &main_tags {
                if dirty_tags.contains(name) {
                    // Get commit info from dirty tag
                    if let Ok(dirty_tag_oid) = git_repo.resolve_ref(&format!("dirty_{}", name)) {
                        if let Ok(info) = git_repo.read_commit_info(dirty_tag_oid) {
                            checkpoints.push(json!({
                                "name": name,
                                "timestamp": info.timestamp,
                                "message": info.message,
                            }));
                        }
                    }
                }
            }

            Ok::<_, AppError>(json!(checkpoints))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct RevertBody {
    pub name: String,
}

pub async fn revert_checkpoint(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RevertBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            let main_tag_oid = git_repo
                .resolve_ref(&format!("main_{}", body.name))
                .map_err(|_| {
                    AppError::internal(format!("Checkpoint {} not found or incomplete", body.name))
                })?;
            let dirty_tag_oid = git_repo
                .resolve_ref(&format!("dirty_{}", body.name))
                .map_err(|_| {
                    AppError::internal(format!("Checkpoint {} not found or incomplete", body.name))
                })?;

            git_repo.force_ref(MAIN_BRANCH, main_tag_oid)?;
            git_repo.force_ref(DIRTY_BRANCH, dirty_tag_oid)?;

            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

/// Path params for delete: /:id/:name
pub async fn delete_checkpoint(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            // Idempotent delete
            git_repo.delete_tag(&format!("main_{}", name))?;
            git_repo.delete_tag(&format!("dirty_{}", name))?;

            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}
