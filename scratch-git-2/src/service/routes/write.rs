use axum::extract::{Path, Query, State};
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
pub struct BranchQuery {
    pub branch: Option<String>,
}

#[derive(Deserialize)]
pub struct CommitFilesBody {
    pub files: Vec<FileInput>,
    pub message: Option<String>,
}

#[derive(Deserialize)]
pub struct FileInput {
    pub path: String,
    pub content: String,
}

pub async fn commit_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<BranchQuery>,
    Json(body): Json<CommitFilesBody>,
) -> Response {
    let branch = query.branch.unwrap_or_else(|| MAIN_BRANCH.to_string());
    let message = body.message.unwrap_or_else(|| "Update files".to_string());

    let result = {
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let write_locks = state.write_locks.clone();
        let branch_clone = branch.clone();

        write_locks
            .with_lock(&id, &branch_clone, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let branch = branch_clone.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;

                        let changes: Vec<FileChange> = body
                            .files
                            .iter()
                            .map(|f| {
                                let path = f.path.strip_prefix('/').unwrap_or(&f.path);
                                FileChange {
                                    path: path.to_string(),
                                    content: Some(f.content.clone()),
                                    oid: None,
                                    change_type: ChangeType::Modify,
                                }
                            })
                            .collect();

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

    envelope_result(&state, &id, result)
}

#[derive(Deserialize)]
pub struct DeleteFilesBody {
    pub files: Vec<String>,
    pub message: Option<String>,
}

pub async fn delete_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<BranchQuery>,
    Json(body): Json<DeleteFilesBody>,
) -> Response {
    let branch = query.branch.unwrap_or_else(|| MAIN_BRANCH.to_string());
    let message = body.message.unwrap_or_else(|| "Delete files".to_string());

    let result = {
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let write_locks = state.write_locks.clone();
        let branch_clone = branch.clone();

        write_locks
            .with_lock(&id, &branch_clone, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let branch = branch_clone.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;

                        let changes: Vec<FileChange> = body
                            .files
                            .iter()
                            .map(|p| {
                                let path = p.strip_prefix('/').unwrap_or(p);
                                FileChange {
                                    path: path.to_string(),
                                    content: None,
                                    oid: None,
                                    change_type: ChangeType::Delete,
                                }
                            })
                            .collect();

                        git_repo
                            .commit_changes_to_ref(&branch, &changes, &message)?
                            .0;
                        Ok::<_, AppError>(json!({ "success": true }))
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await
    };

    envelope_result(&state, &id, result)
}

#[derive(Deserialize)]
pub struct DeleteFolderQuery {
    pub folder: Option<String>,
    pub branch: Option<String>,
}

#[derive(Deserialize)]
pub struct DeleteFolderBody {
    pub message: Option<String>,
}

pub async fn delete_folder(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<DeleteFolderQuery>,
    Json(body): Json<DeleteFolderBody>,
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
    let branch = query.branch.unwrap_or_else(|| DIRTY_BRANCH.to_string());
    let message = body.message.unwrap_or_else(|| "Delete folder".to_string());

    let result = {
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let write_locks = state.write_locks.clone();
        let branch_clone = branch.clone();

        write_locks
            .with_lock(&id, &branch_clone, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let branch = branch_clone.clone();
                let folder = folder.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;
                        let target_folder = folder.strip_prefix('/').unwrap_or(&folder).to_string();

                        let changes = vec![FileChange {
                            path: target_folder,
                            content: None,
                            oid: None,
                            change_type: ChangeType::Delete,
                        }];

                        git_repo
                            .commit_changes_to_ref(&branch, &changes, &message)?
                            .0;
                        Ok::<_, AppError>(json!({ "success": true }))
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await
    };

    envelope_result(&state, &id, result)
}

#[derive(Deserialize)]
pub struct DeleteDataFolderBody {
    pub path: Option<String>,
}

pub async fn delete_data_folder(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<DeleteDataFolderBody>,
) -> Response {
    let folder_path = match body.path {
        Some(p) => p,
        None => {
            return envelope_error(&state, Some(&id), AppError::bad_request("Path is required"));
        }
    };

    let result: Result<serde_json::Value, AppError> = async {
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let write_locks = state.write_locks.clone();

        let target_folder = folder_path
            .strip_prefix('/')
            .unwrap_or(&folder_path)
            .to_string();
        let message = format!("Remove data folder {}", target_folder);

        // Delete from main
        write_locks
            .with_lock(&id, MAIN_BRANCH, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let target_folder = target_folder.clone();
                let message = message.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;
                        let changes = vec![FileChange {
                            path: target_folder,
                            content: None,
                            oid: None,
                            change_type: ChangeType::Delete,
                        }];
                        git_repo
                            .commit_changes_to_ref(MAIN_BRANCH, &changes, &message)?
                            .0;
                        Ok::<_, AppError>(())
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await?;

        // Delete from dirty
        let target_folder = folder_path
            .strip_prefix('/')
            .unwrap_or(&folder_path)
            .to_string();
        let message = format!("Remove data folder {}", target_folder);

        write_locks
            .with_lock(&id, DIRTY_BRANCH, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let target_folder = target_folder.clone();
                let message = message.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;
                        let changes = vec![FileChange {
                            path: target_folder,
                            content: None,
                            oid: None,
                            change_type: ChangeType::Delete,
                        }];
                        git_repo
                            .commit_changes_to_ref(DIRTY_BRANCH, &changes, &message)?
                            .0;
                        Ok::<_, AppError>(())
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await?;

        // Rebase
        tokio::task::spawn_blocking({
            let repos_dir = repos_dir.clone();
            let id = id.clone();
            move || {
                let git_repo = GitRepo::open(&repos_dir, &id)?;
                git_repo.rebase_dirty("diff3")?;
                Ok::<_, AppError>(json!({ "success": true }))
            }
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
    }
    .await;

    envelope_result(&state, &id, result)
}

#[derive(Deserialize)]
pub struct PublishBody {
    pub file: PublishFileInput,
    pub message: Option<String>,
}

#[derive(Deserialize)]
pub struct PublishFileInput {
    pub path: String,
    pub content: String,
}

pub async fn publish(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PublishBody>,
) -> Response {
    let message = body.message.unwrap_or_else(|| "Publish file".to_string());

    let result: Result<serde_json::Value, AppError> = async {
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let write_locks = state.write_locks.clone();

        // Commit to main
        write_locks
            .with_lock(&id, MAIN_BRANCH, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let path = body.file.path.clone();
                let content = body.file.content.clone();
                let message = message.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;
                        let file_path = path.strip_prefix('/').unwrap_or(&path).to_string();
                        let changes = vec![FileChange {
                            path: file_path,
                            content: Some(content),
                            oid: None,
                            change_type: ChangeType::Modify,
                        }];
                        git_repo
                            .commit_changes_to_ref(MAIN_BRANCH, &changes, &message)?
                            .0;
                        Ok::<_, AppError>(())
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await?;

        // Rebase dirty
        tokio::task::spawn_blocking({
            let repos_dir = repos_dir.clone();
            let id = id.clone();
            move || {
                let git_repo = GitRepo::open(&repos_dir, &id)?;
                git_repo.rebase_dirty("diff3")?;
                Ok::<_, AppError>(json!({ "success": true }))
            }
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
    }
    .await;

    envelope_result(&state, &id, result)
}

#[derive(Deserialize)]
pub struct DiscardChangesBody {
    pub path: String,
}

pub async fn discard_changes(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<DiscardChangesBody>,
) -> Response {
    let result = {
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let write_locks = state.write_locks.clone();

        write_locks
            .with_lock(&id, DIRTY_BRANCH, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let path = body.path.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;
                        let normalized_target = path.strip_prefix('/').unwrap_or(&path).to_string();

                        let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;
                        let dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;

                        if main_oid == dirty_oid {
                            return Ok(json!({ "success": true }));
                        }

                        let changes = git_repo.compare_commits(main_oid, dirty_oid)?;
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
                            git_repo
                                .commit_changes_to_ref(
                                    DIRTY_BRANCH,
                                    &revert_changes,
                                    &format!("Discard changes to {}", normalized_target),
                                )?
                                .0;
                        }

                        Ok::<_, AppError>(json!({ "success": true }))
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await
    };

    envelope_result(&state, &id, result)
}

#[derive(Deserialize)]
pub struct RebaseBody {
    pub strategy: Option<String>,
}

pub async fn rebase(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RebaseBody>,
) -> Response {
    let strategy = body.strategy.unwrap_or_else(|| "diff3".to_string());

    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let (rebased, conflicts) = git_repo.rebase_dirty(&strategy)?;
            Ok::<_, AppError>(json!({ "rebased": rebased, "conflicts": conflicts }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct RenameBody {
    #[serde(rename = "folderPath")]
    pub folder_path: String,
    pub renames: Vec<RenameInput>,
    pub message: Option<String>,
}

#[derive(Deserialize)]
pub struct RenameInput {
    #[serde(rename = "oldName")]
    pub old_name: String,
    #[serde(rename = "newName")]
    pub new_name: String,
}

pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> Response {
    let message = body
        .message
        .unwrap_or_else(|| format!("Rename batch in {}", body.folder_path));

    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let folder_path = body.folder_path.clone();
        let renames = body.renames;
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let normalized_folder = folder_path
                .strip_prefix('/')
                .unwrap_or(&folder_path)
                .to_string();
            let clean_folder = normalized_folder
                .strip_suffix('/')
                .unwrap_or(&normalized_folder)
                .to_string();

            // Read dirty tree at folder to get OIDs
            let dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;
            let dirty_entries = git_repo.read_tree_at_path(dirty_oid, &clean_folder)?;

            // Read main tree at folder
            let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;
            let main_entries = git_repo
                .read_tree_at_path(main_oid, &clean_folder)
                .unwrap_or_default();

            let mut changes_for_dirty: Vec<FileChange> = Vec::new();
            let mut changes_for_main: Vec<FileChange> = Vec::new();

            for rename in &renames {
                let entry_in_dirty = dirty_entries
                    .iter()
                    .find(|(name, _, _)| name == &rename.old_name);
                let entry_in_dirty = match entry_in_dirty {
                    Some(e) => e,
                    None => {
                        return Err(AppError::internal(format!(
                            "File {} not found in {}",
                            rename.old_name, clean_folder
                        )));
                    }
                };

                let old_file_path = if clean_folder.is_empty() {
                    rename.old_name.clone()
                } else {
                    format!("{}/{}", clean_folder, rename.old_name)
                };
                let new_file_path = if clean_folder.is_empty() {
                    rename.new_name.clone()
                } else {
                    format!("{}/{}", clean_folder, rename.new_name)
                };

                // Always apply to dirty
                changes_for_dirty.push(FileChange {
                    path: old_file_path.clone(),
                    content: None,
                    oid: None,
                    change_type: ChangeType::Delete,
                });
                changes_for_dirty.push(FileChange {
                    path: new_file_path.clone(),
                    content: None,
                    oid: Some(entry_in_dirty.1.to_string()),
                    change_type: ChangeType::Add,
                });

                // Only apply to main if it existed in main
                let entry_in_main = main_entries
                    .iter()
                    .find(|(name, _, _)| name == &rename.old_name);
                if let Some(main_entry) = entry_in_main {
                    changes_for_main.push(FileChange {
                        path: old_file_path,
                        content: None,
                        oid: None,
                        change_type: ChangeType::Delete,
                    });
                    changes_for_main.push(FileChange {
                        path: new_file_path,
                        content: None,
                        oid: Some(main_entry.1.to_string()),
                        change_type: ChangeType::Add,
                    });
                }
            }

            // Apply to main
            let mut new_main_commit_oid = main_oid;
            if !changes_for_main.is_empty() {
                (new_main_commit_oid, _) =
                    git_repo.commit_changes_to_ref(MAIN_BRANCH, &changes_for_main, &message)?;
            }

            // Apply to dirty with efficient squashed rebase
            let dirty_commit_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;
            let dirty_tree_oid = git_repo.get_commit_tree_oid(dirty_commit_oid)?;
            let (new_dirty_tree_oid, _) =
                git_repo.apply_changes_to_tree(dirty_tree_oid, &changes_for_dirty, "")?;

            let new_main_tree_oid = git_repo.get_commit_tree_oid(new_main_commit_oid)?;

            if new_dirty_tree_oid == new_main_tree_oid {
                // Fast-forward
                git_repo.force_ref(DIRTY_BRANCH, new_main_commit_oid)?;
            } else {
                // Create squashed commit
                let new_dirty_commit = git_repo.write_commit(
                    new_dirty_tree_oid,
                    &[new_main_commit_oid],
                    "Uncommitted changes after rename",
                )?;
                git_repo.force_ref(DIRTY_BRANCH, new_dirty_commit)?;
            }

            Ok(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}
