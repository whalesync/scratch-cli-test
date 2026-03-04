use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::envelope::{envelope, envelope_error, envelope_result};
use crate::error::AppError;
use crate::git::repo::GitRepo;
use crate::state::AppState;
use crate::types::*;

pub async fn init_repo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    tracing::info!("[API] Initializing repo: {}", id);
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            GitRepo::init(&repos_dir, &id)?;
            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn delete_repo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        move || {
            let repo_path = state.repo_path(&id);
            if repo_path.exists() {
                std::fs::remove_dir_all(&repo_path)
                    .map_err(|e| AppError::internal(format!("Failed to delete repo: {}", e)))?;
            }
            // Best-effort cleanup of empty parent dirs up to repos_dir
            let mut dir = repo_path.parent();
            while let Some(parent) = dir {
                if parent == state.repos_dir {
                    break;
                }
                if std::fs::read_dir(parent).map(|mut d| d.next().is_none()).unwrap_or(false) {
                    let _ = std::fs::remove_dir(parent);
                    dir = parent.parent();
                } else {
                    break;
                }
            }
            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn exists(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let repo_path = state.repo_path(&id);
    let exists = repo_path.exists();
    let has_head = exists && repo_path.join("HEAD").exists();

    envelope(
        &state,
        Some(&id),
        json!({
            "repoId": id,
            "repoPath": repo_path.to_string_lossy(),
            "exists": exists,
            "hasHead": has_head,
        }),
    )
}

#[derive(Deserialize)]
pub struct ResetBody {
    pub path: Option<String>,
}

pub async fn reset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ResetBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let _write_locks = state.write_locks.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            if let Some(path) = body.path {
                // Discard specific changes
                let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;
                let dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;
                if main_oid == dirty_oid {
                    return Ok(json!({ "success": true }));
                }
                let changes = git_repo.compare_commits(main_oid, dirty_oid)?;

                let normalized_target = path.strip_prefix('/').unwrap_or(&path);
                let changes_to_discard: Vec<_> = changes
                    .iter()
                    .filter(|c| {
                        c.path == normalized_target
                            || c.path.starts_with(&format!("{}/", normalized_target))
                    })
                    .collect();

                if changes_to_discard.is_empty() {
                    return Ok(json!({ "success": true }));
                }

                let mut revert_changes = Vec::new();
                for change in changes_to_discard {
                    if change.status == "added" {
                        revert_changes.push(FileChange {
                            path: change.path.clone(),
                            content: None,
                            oid: None,
                            change_type: ChangeType::Delete,
                        });
                    } else {
                        let main_content =
                            git_repo.get_file_content(MAIN_BRANCH, &change.path)?;
                        if let Some(content) = main_content {
                            revert_changes.push(FileChange {
                                path: change.path.clone(),
                                content: Some(content),
                                oid: None,
                                change_type: ChangeType::Modify,
                            });
                        }
                    }
                }

                if !revert_changes.is_empty() {
                    git_repo.commit_changes_to_ref(
                        DIRTY_BRANCH,
                        &revert_changes,
                        &format!("Discard changes to {}", normalized_target),
                    )?;
                }
            } else {
                // Reset dirty to main
                let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;
                git_repo.force_ref(DIRTY_BRANCH, main_oid)?;
            }

            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn count_objects(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        move || {
            let repo_path = state.repo_path(&id);
            let output = std::process::Command::new("git")
                .args(["count-objects", "-v"])
                .current_dir(&repo_path)
                .output()
                .map_err(|e| AppError::internal(format!("Failed to run git count-objects: {}", e)))?;
            let stats = String::from_utf8_lossy(&output.stdout).to_string();
            let gc_in_progress = state.gc_state.get(&id).map(|v| *v);
            Ok::<_, AppError>(json!({ "stats": stats, "gcInProgress": gc_in_progress, "engine": "gitoxide" }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct GcBody {
    pub aggressive: Option<bool>,
}

pub async fn gc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<GcBody>,
) -> Response {
    // Check if GC is already in progress
    if state.gc_state.contains_key(&id) {
        return envelope_error(
            &state,
            Some(&id),
            AppError::conflict("GC already in progress"),
        );
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    state.gc_state.insert(id.clone(), now);

    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        let aggressive = body.aggressive.unwrap_or(false);
        move || {
            let repo_path = state.repo_path(&id);

            let get_stats = || -> String {
                std::process::Command::new("git")
                    .args(["count-objects", "-v"])
                    .current_dir(&repo_path)
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                    .unwrap_or_else(|e| format!("Failed to get stats: {}", e))
            };

            let stats_before = get_stats();

            let gc_args = if aggressive {
                vec!["gc", "--prune=now", "--aggressive"]
            } else {
                vec!["gc", "--prune=now"]
            };

            std::process::Command::new("git")
                .args(&gc_args)
                .current_dir(&repo_path)
                .output()
                .map_err(|e| AppError::internal(format!("Failed to run git gc: {}", e)))?;

            let stats_after = get_stats();

            Ok::<_, AppError>(json!({
                "success": true,
                "statsBefore": stats_before,
                "statsAfter": stats_after,
            }))
        }
    })
    .await;

    state.gc_state.remove(&id);

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct CopyBody {
    pub from: String,
    pub to: String,
}

pub async fn copy_repo(
    State(state): State<AppState>,
    Json(body): Json<CopyBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        move || {
            // Sanitize paths: strip leading slashes, reject path traversal
            let from_id = body.from.trim_start_matches('/');
            let to_id = body.to.trim_start_matches('/');
            if from_id.is_empty() || to_id.is_empty() {
                return Err(AppError::bad_request("from and to must be non-empty"));
            }
            if from_id.contains("..") || to_id.contains("..") {
                return Err(AppError::bad_request("Path traversal (..) is not allowed"));
            }

            let from_path = state.repo_path(from_id);
            let to_path = state.repo_path(to_id);

            if !from_path.exists() {
                return Err(AppError::not_found(format!(
                    "Source repo not found: {}",
                    body.from
                )));
            }
            if to_path.exists() {
                return Err(AppError::conflict(format!(
                    "Destination repo already exists: {}",
                    body.to
                )));
            }

            // Create parent directories for the destination
            if let Some(parent) = to_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::internal(format!("Failed to create destination dirs: {}", e))
                })?;
            }

            // Recursive copy
            copy_dir_recursive(&from_path, &to_path)?;

            Ok::<_, AppError>(json!({
                "success": true,
                "from": body.from,
                "to": body.to,
            }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, "copy", inner),
        Err(e) => envelope_error(&state, None, AppError::internal(e.to_string())),
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst)
        .map_err(|e| AppError::internal(format!("Failed to create dir {:?}: {}", dst, e)))?;

    for entry in std::fs::read_dir(src)
        .map_err(|e| AppError::internal(format!("Failed to read dir {:?}: {}", src, e)))?
    {
        let entry = entry
            .map_err(|e| AppError::internal(format!("Failed to read entry: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                AppError::internal(format!(
                    "Failed to copy {:?} -> {:?}: {}",
                    src_path, dst_path, e
                ))
            })?;
        }
    }
    Ok(())
}
