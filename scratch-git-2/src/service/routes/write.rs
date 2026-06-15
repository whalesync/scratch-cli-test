use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::Json;
use gix::ObjectId;
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

/// Build the list of file changes needed to remove a data folder.
/// Deletes both the data folder (e.g. `Companies`) and its `.scratch/` metadata (e.g. `.scratch/Companies`).
fn data_folder_delete_changes(folder_path: &str) -> Vec<FileChange> {
    let target_folder = folder_path
        .strip_prefix('/')
        .unwrap_or(folder_path)
        .to_string();
    let scratch_folder = format!(".scratch/{}", target_folder);
    vec![
        FileChange {
            path: target_folder,
            content: None,
            oid: None,
            change_type: ChangeType::Delete,
        },
        FileChange {
            path: scratch_folder,
            content: None,
            oid: None,
            change_type: ChangeType::Delete,
        },
    ]
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

        let changes = data_folder_delete_changes(&folder_path);
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
                let changes = changes.clone();
                let message = message.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;
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
        let changes = data_folder_delete_changes(&folder_path);
        let message = format!("Remove data folder {}", target_folder);

        write_locks
            .with_lock(&id, DIRTY_BRANCH, || {
                let repos_dir = repos_dir.clone();
                let id = id.clone();
                let changes = changes.clone();
                let message = message.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let git_repo = GitRepo::open(&repos_dir, &id)?;
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

                        if main_oid != dirty_oid {
                            let changes = git_repo.compare_commits(main_oid, dirty_oid)?;
                            let changes_to_discard: Vec<_> = changes
                                .iter()
                                .filter(|c| {
                                    c.path == normalized_target
                                        || c.path.starts_with(&format!("{}/", normalized_target))
                                })
                                .collect();

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
                        }

                        // If dirty now visibly matches main, advance
                        // merge_base so the review list (compare
                        // merge_base ↔ dirty) reflects reality. Without
                        // this, ghost files persist whenever main has
                        // drifted ahead of merge_base — see
                        // `resolve_merge_base_or_main`.
                        let new_dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;
                        if git_repo
                            .compare_commits(main_oid, new_dirty_oid)?
                            .is_empty()
                        {
                            git_repo.write_tag("merge_base", main_oid)?;
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

    let _guard = state.write_locks.acquire(&id, DIRTY_BRANCH).await;

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

    // Acquire main before dirty to maintain consistent lock ordering and prevent deadlocks.
    let _main_guard = state.write_locks.acquire(&id, MAIN_BRANCH).await;
    let _dirty_guard = state.write_locks.acquire(&id, DIRTY_BRANCH).await;

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

            // Rename is a lockstep operation: the same paths are rewritten
            // on both main and dirty. Advance merge_base to the new main so
            // the renames don't appear as ghost delete+add entries in the
            // review list. Any remaining merge_base ↔ dirty diffs after this
            // are genuine user edits — see `resolve_merge_base_or_main`.
            git_repo.write_tag("merge_base", new_main_commit_oid)?;

            Ok(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct MoveFolderBody {
    #[serde(rename = "oldPath")]
    pub old_path: String,
    #[serde(rename = "newPath")]
    pub new_path: String,
    pub message: Option<String>,
}

/// Strip the leading and trailing `/` from a folder path so it matches the
/// no-leading-slash convention git trees use (e.g. `/My Site/Blog` → `My Site/Blog`).
fn normalize_folder_path(folder_path: &str) -> String {
    let without_leading = folder_path.strip_prefix('/').unwrap_or(folder_path);
    without_leading
        .strip_suffix('/')
        .unwrap_or(without_leading)
        .to_string()
}

/// True when `old_path` is `new_path` itself or an ancestor of it — i.e. the destination is
/// nested *inside* the source (e.g. a collection literally named "Collections" moving from
/// `Site/Collections` to `Site/Collections/Collections`). In that case we must NOT delete the
/// old folder wholesale (that would wipe the freshly-grafted destination); we delete only the
/// individual source leaves instead.
fn old_path_is_prefix_of_new(old_path: &str, new_path: &str) -> bool {
    new_path == old_path || new_path.starts_with(&format!("{}/", old_path))
}

/// Build the `FileChange` list that moves the blobs under `old_path` to `new_path` on a single
/// branch. Blob OIDs are reused so content identity (and git history) follows the move.
fn build_subtree_move_changes(
    old_path: &str,
    new_path: &str,
    old_blob_paths_with_oids: &[(String, ObjectId)],
    old_path_is_prefix_of_new: bool,
) -> Vec<FileChange> {
    let mut changes = Vec::new();

    if old_path_is_prefix_of_new {
        // Destination is nested under the source — delete each source leaf individually so the
        // grafted destination (which lives under `old_path`) survives.
        for (relative_path, _) in old_blob_paths_with_oids {
            changes.push(FileChange {
                path: format!("{}/{}", old_path, relative_path),
                content: None,
                oid: None,
                change_type: ChangeType::Delete,
            });
        }
    } else {
        // Disjoint paths — delete the whole old folder in one entry so no empty tree is left
        // behind at the source.
        changes.push(FileChange {
            path: old_path.to_string(),
            content: None,
            oid: None,
            change_type: ChangeType::Delete,
        });
    }

    for (relative_path, oid) in old_blob_paths_with_oids {
        changes.push(FileChange {
            path: format!("{}/{}", new_path, relative_path),
            content: None,
            oid: Some(oid.to_string()),
            change_type: ChangeType::Add,
        });
    }

    changes
}

/// Build the move changes for one branch, covering both the data folder and its `.scratch/`
/// metadata sibling. Returns:
///   - `Ok(vec![])` when there is nothing to move on this branch (source absent everywhere) — the
///     idempotent no-op case (already moved, or folder only lives on the other branch).
///   - `Err(..)` when the move is refused: the source has a nested data folder, or the
///     destination already exists with differing content (non-destructive guard).
fn build_move_changes_for_branch(
    git_repo: &GitRepo,
    commit_oid: ObjectId,
    old_data_path: &str,
    new_data_path: &str,
    old_scratch_path: &str,
    new_scratch_path: &str,
) -> Result<Vec<FileChange>, AppError> {
    let mut changes = Vec::new();

    // The data folder (records) is handled first; its `.scratch/<path>` metadata sibling
    // (schema.json + views) follows the move. `is_data_path` gates the nested-folder check,
    // which is meaningful only for the records tree (`.scratch` legitimately nests `views/`).
    let path_pairs = [
        (true, old_data_path, new_data_path),
        (false, old_scratch_path, new_scratch_path),
    ];

    for (is_data_path, old_path, new_path) in path_pairs {
        let all_blobs_under_old_path = match git_repo.list_blob_paths_under(commit_oid, old_path)? {
            // Source absent on this branch for this path — nothing to move here.
            None => continue,
            Some(blobs) => blobs,
        };

        let old_is_prefix_of_new = old_path_is_prefix_of_new(old_path, new_path);
        // The mirror direction: the destination is an ANCESTOR of the source. This is the
        // inverse/rollback of a collection literally named "Collections"
        // (`Site/Collections/Collections` → `Site/Collections`). The source subtree then lives
        // *under* the destination, so it appears in the destination's blob listing and must be
        // excluded from the non-destructive collision check below (otherwise the guard always sees
        // the source as "differing content already at the destination" and refuses the move).
        let new_is_prefix_of_old = old_path_is_prefix_of_new(new_path, old_path);

        // When the destination is nested under the source (a collection literally named
        // "Collections"), the destination's already-relocated records live *under* `old_path`.
        // The records that still need moving are only those NOT yet under `new_path` — so on an
        // idempotent re-run after the move completed, the source is correctly seen as empty.
        let source_blobs_to_move: Vec<(String, ObjectId)> = if old_is_prefix_of_new {
            // `new_path` relative to `old_path`, e.g. old `Site/Coll`, new `Site/Coll/Coll` → `Coll`.
            let nested_relative_prefix = new_path[old_path.len() + 1..].to_string();
            all_blobs_under_old_path
                .into_iter()
                .filter(|(relative_path, _)| {
                    relative_path != &nested_relative_prefix
                        && !relative_path.starts_with(&format!("{}/", nested_relative_prefix))
                })
                .collect()
        } else {
            all_blobs_under_old_path
        };

        if source_blobs_to_move.is_empty() {
            // Nothing left at the source (already relocated) — no-op for this path.
            continue;
        }

        // Refuse to move a data folder that contains a nested data folder: the migration updates
        // one DataFolder row at a time, so a wholesale subtree move would orphan the nested
        // folder's DB path. A nested folder shows up as a relative blob path containing a `/`
        // (record files live directly under their folder, never in subdirectories).
        if is_data_path
            && source_blobs_to_move
                .iter()
                .any(|(relative_path, _)| relative_path.contains('/'))
        {
            return Err(AppError::bad_request(format!(
                "Refusing to move folder {}: it contains a nested folder; move nested folders first",
                old_path
            )));
        }

        // Non-destructive guard: if the destination already has content, only proceed when it is
        // byte-identical to the records being moved (an interrupted run that grafted the
        // destination but never deleted the source). Differing content is an ambiguous collision —
        // refuse rather than clobber.
        if let Some(new_blob_paths_with_oids) =
            git_repo.list_blob_paths_under(commit_oid, new_path)?
        {
            // When the destination is an ancestor of the source (the "Collections"-named inverse),
            // the source's own records are nested under the destination and show up here. Exclude
            // them so the guard only judges OTHER content at the destination: an unrelated collision
            // or a sibling collection not yet moved out (both still refuse), while the source itself
            // — and a re-run's already-grafted copy at the destination level — does not.
            let destination_blobs: BTreeMap<String, ObjectId> = if new_is_prefix_of_old {
                let source_relative_prefix = old_path[new_path.len() + 1..].to_string();
                new_blob_paths_with_oids
                    .into_iter()
                    .filter(|(relative_path, _)| {
                        relative_path != &source_relative_prefix
                            && !relative_path.starts_with(&format!("{}/", source_relative_prefix))
                    })
                    .collect()
            } else {
                new_blob_paths_with_oids.into_iter().collect()
            };
            if !destination_blobs.is_empty() {
                let source_blobs: BTreeMap<String, ObjectId> =
                    source_blobs_to_move.iter().cloned().collect();
                if source_blobs != destination_blobs {
                    return Err(AppError::bad_request(format!(
                        "Refusing to move folder {} → {}: destination already exists with differing content",
                        old_path, new_path
                    )));
                }
            }
        }

        changes.extend(build_subtree_move_changes(
            old_path,
            new_path,
            &source_blobs_to_move,
            old_is_prefix_of_new,
        ));
    }

    Ok(changes)
}

/// Re-parent the data folder at `old_path` (and its `.scratch/` metadata) to `new_path` on BOTH
/// `main` and `dirty`, preserving blob OIDs, in lockstep with `merge_base` so the move does not
/// surface as ghost delete+add entries in the review list (mirrors [`rename`]).
///
/// Idempotent and crash-safe: a re-run after a partial move converges to a no-op. Returns whether
/// any change was actually written (`moved`).
pub fn perform_move_folder(
    git_repo: &GitRepo,
    old_normalized_path: &str,
    new_normalized_path: &str,
    message: &str,
) -> Result<bool, AppError> {
    if old_normalized_path == new_normalized_path {
        return Ok(false);
    }

    let old_scratch_path = format!(".scratch/{}", old_normalized_path);
    let new_scratch_path = format!(".scratch/{}", new_normalized_path);

    let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;
    let dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;

    let changes_for_main = build_move_changes_for_branch(
        git_repo,
        main_oid,
        old_normalized_path,
        new_normalized_path,
        &old_scratch_path,
        &new_scratch_path,
    )?;
    let changes_for_dirty = build_move_changes_for_branch(
        git_repo,
        dirty_oid,
        old_normalized_path,
        new_normalized_path,
        &old_scratch_path,
        &new_scratch_path,
    )?;

    if changes_for_main.is_empty() && changes_for_dirty.is_empty() {
        // Nothing to move on either branch — already migrated, or the folder is absent.
        return Ok(false);
    }

    // Apply to main.
    let mut new_main_commit_oid = main_oid;
    if !changes_for_main.is_empty() {
        (new_main_commit_oid, _) =
            git_repo.commit_changes_to_ref(MAIN_BRANCH, &changes_for_main, message)?;
    }

    // Apply to dirty with an efficient squashed rebase onto the new main (same shape as `rename`).
    let dirty_commit_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;
    let dirty_tree_oid = git_repo.get_commit_tree_oid(dirty_commit_oid)?;
    let (new_dirty_tree_oid, _) =
        git_repo.apply_changes_to_tree(dirty_tree_oid, &changes_for_dirty, "")?;
    let new_main_tree_oid = git_repo.get_commit_tree_oid(new_main_commit_oid)?;

    if new_dirty_tree_oid == new_main_tree_oid {
        git_repo.force_ref(DIRTY_BRANCH, new_main_commit_oid)?;
    } else {
        let new_dirty_commit = git_repo.write_commit(
            new_dirty_tree_oid,
            &[new_main_commit_oid],
            "Uncommitted changes after folder move",
        )?;
        git_repo.force_ref(DIRTY_BRANCH, new_dirty_commit)?;
    }

    // A folder move is a lockstep operation: the same paths are rewritten on both main and dirty.
    // Advance merge_base to the new main so the move does not appear as ghost delete+add entries
    // in the review list — any remaining merge_base ↔ dirty diffs are genuine user edits.
    git_repo.write_tag("merge_base", new_main_commit_oid)?;

    Ok(true)
}

pub async fn move_folder(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<MoveFolderBody>,
) -> Response {
    let old_normalized_path = normalize_folder_path(&body.old_path);
    let new_normalized_path = normalize_folder_path(&body.new_path);

    if old_normalized_path.is_empty() || new_normalized_path.is_empty() {
        return envelope_error(
            &state,
            Some(&id),
            AppError::bad_request(
                "Both oldPath and newPath are required and cannot be the repo root",
            ),
        );
    }

    let message = body.message.unwrap_or_else(|| {
        format!(
            "Move folder {} → {}",
            old_normalized_path, new_normalized_path
        )
    });

    // Acquire main before dirty to maintain consistent lock ordering and prevent deadlocks.
    let _main_guard = state.write_locks.acquire(&id, MAIN_BRANCH).await;
    let _dirty_guard = state.write_locks.acquire(&id, DIRTY_BRANCH).await;

    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let moved = perform_move_folder(
                &git_repo,
                &old_normalized_path,
                &new_normalized_path,
                &message,
            )?;
            Ok::<_, AppError>(json!({ "success": true, "moved": moved }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn data_folder_delete_changes_includes_scratch_metadata() {
        let changes = data_folder_delete_changes("/Companies");

        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "Companies");
        assert_eq!(changes[0].change_type, ChangeType::Delete);
        assert_eq!(changes[1].path, ".scratch/Companies");
        assert_eq!(changes[1].change_type, ChangeType::Delete);
    }

    #[test]
    fn data_folder_delete_changes_handles_path_without_leading_slash() {
        let changes = data_folder_delete_changes("Products");

        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "Products");
        assert_eq!(changes[1].path, ".scratch/Products");
    }

    // ── move_folder ──────────────────────────────────────────────────────────

    fn setup_repo() -> (TempDir, GitRepo) {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "test").unwrap();
        (tmp, repo)
    }

    fn add(path: &str, content: &str) -> FileChange {
        FileChange {
            path: path.to_string(),
            content: Some(content.to_string()),
            oid: None,
            change_type: ChangeType::Add,
        }
    }

    /// Commit `changes` to main, then point dirty + merge_base at the new main so the repo looks
    /// like a freshly-pulled, edit-free workbook (folder present identically on both branches).
    fn commit_to_both_branches(repo: &GitRepo, changes: &[FileChange]) {
        repo.commit_changes_to_ref(MAIN_BRANCH, changes, "seed")
            .unwrap();
        let main_oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        repo.force_ref(DIRTY_BRANCH, main_oid).unwrap();
        repo.write_tag("merge_base", main_oid).unwrap();
    }

    fn sorted_relative_paths(repo: &GitRepo, branch: &str, folder: &str) -> Option<Vec<String>> {
        let commit_oid = repo.resolve_ref(branch).unwrap();
        repo.list_blob_paths_under(commit_oid, folder)
            .unwrap()
            .map(|blobs| {
                let mut paths: Vec<String> = blobs.into_iter().map(|(path, _)| path).collect();
                paths.sort();
                paths
            })
    }

    fn blob_oid_at(
        repo: &GitRepo,
        branch: &str,
        folder: &str,
        relative_path: &str,
    ) -> Option<ObjectId> {
        let commit_oid = repo.resolve_ref(branch).unwrap();
        repo.list_blob_paths_under(commit_oid, folder)
            .unwrap()
            .and_then(|blobs| {
                blobs
                    .into_iter()
                    .find(|(path, _)| path == relative_path)
                    .map(|(_, oid)| oid)
            })
    }

    fn dummy_oid() -> ObjectId {
        ObjectId::from_hex(b"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap()
    }

    #[test]
    fn build_subtree_move_changes_deletes_whole_folder_for_disjoint_paths() {
        let blobs = vec![
            ("rec1.json".to_string(), dummy_oid()),
            ("rec2.json".to_string(), dummy_oid()),
        ];
        let changes =
            build_subtree_move_changes("Site/Blog", "Site/Collections/Blog", &blobs, false);

        assert_eq!(changes[0].path, "Site/Blog");
        assert_eq!(changes[0].change_type, ChangeType::Delete);
        let added: Vec<&str> = changes
            .iter()
            .filter(|c| c.change_type == ChangeType::Add)
            .map(|c| c.path.as_str())
            .collect();
        assert_eq!(
            added,
            vec![
                "Site/Collections/Blog/rec1.json",
                "Site/Collections/Blog/rec2.json"
            ]
        );
    }

    #[test]
    fn build_subtree_move_changes_deletes_leaves_when_old_is_prefix_of_new() {
        let blobs = vec![
            ("rec1.json".to_string(), dummy_oid()),
            ("rec2.json".to_string(), dummy_oid()),
        ];
        let changes = build_subtree_move_changes(
            "Site/Collections",
            "Site/Collections/Collections",
            &blobs,
            true,
        );

        let deleted: Vec<&str> = changes
            .iter()
            .filter(|c| c.change_type == ChangeType::Delete)
            .map(|c| c.path.as_str())
            .collect();
        // Per-leaf deletes, NOT a whole-folder delete (which would wipe the new location).
        assert_eq!(
            deleted,
            vec!["Site/Collections/rec1.json", "Site/Collections/rec2.json"]
        );
    }

    #[test]
    fn old_path_is_prefix_of_new_is_segment_aware() {
        assert!(old_path_is_prefix_of_new(
            "Site/Collections",
            "Site/Collections/Collections"
        ));
        assert!(old_path_is_prefix_of_new("Site/Blog", "Site/Blog"));
        // Must not treat "Blog" as a prefix of "Blog Posts" — a shared string prefix is not an
        // ancestor relationship.
        assert!(!old_path_is_prefix_of_new("Site/Blog", "Site/Blog Posts"));
        assert!(!old_path_is_prefix_of_new(
            "Site/Blog",
            "Site/Collections/Blog"
        ));
    }

    #[test]
    fn move_folder_relocates_records_and_scratch_metadata_on_both_branches() {
        let (_tmp, repo) = setup_repo();
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Blog/rec1.json", "{\"id\":1}"),
                add("My Site/Blog/rec2.json", "{\"id\":2}"),
                add(".scratch/My Site/Blog/schema.json", "{\"schema\":true}"),
                add(
                    ".scratch/My Site/Blog/views/default.json",
                    "{\"view\":true}",
                ),
            ],
        );

        let original_rec1_oid =
            blob_oid_at(&repo, MAIN_BRANCH, "My Site/Blog", "rec1.json").unwrap();

        let moved =
            perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "move").unwrap();
        assert!(moved);

        for branch in [MAIN_BRANCH, DIRTY_BRANCH] {
            // Old data + scratch locations gone.
            assert_eq!(sorted_relative_paths(&repo, branch, "My Site/Blog"), None);
            assert_eq!(
                sorted_relative_paths(&repo, branch, ".scratch/My Site/Blog"),
                None
            );

            // Records relocated.
            assert_eq!(
                sorted_relative_paths(&repo, branch, "My Site/Collections/Blog"),
                Some(vec!["rec1.json".to_string(), "rec2.json".to_string()])
            );
            // `.scratch` metadata (schema + views) relocated alongside.
            assert_eq!(
                sorted_relative_paths(&repo, branch, ".scratch/My Site/Collections/Blog"),
                Some(vec![
                    "schema.json".to_string(),
                    "views/default.json".to_string()
                ])
            );
        }

        // Blob OIDs are preserved across the move (content identity / git history follows).
        let relocated_rec1_oid =
            blob_oid_at(&repo, MAIN_BRANCH, "My Site/Collections/Blog", "rec1.json").unwrap();
        assert_eq!(relocated_rec1_oid, original_rec1_oid);

        // Lockstep: merge_base advances to the new main so the move isn't a ghost diff.
        assert_eq!(
            repo.resolve_ref("merge_base").unwrap(),
            repo.resolve_ref(MAIN_BRANCH).unwrap()
        );
    }

    #[test]
    fn move_folder_is_idempotent_on_rerun() {
        let (_tmp, repo) = setup_repo();
        commit_to_both_branches(&repo, &[add("My Site/Blog/rec1.json", "{\"id\":1}")]);

        assert!(
            perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "m").unwrap()
        );

        let main_after_first = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let dirty_after_first = repo.resolve_ref(DIRTY_BRANCH).unwrap();

        // Re-run: nothing to move (source absent, destination present).
        let moved_again =
            perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "m").unwrap();
        assert!(!moved_again);
        assert_eq!(repo.resolve_ref(MAIN_BRANCH).unwrap(), main_after_first);
        assert_eq!(repo.resolve_ref(DIRTY_BRANCH).unwrap(), dirty_after_first);
    }

    #[test]
    fn move_folder_handles_collection_named_collections() {
        let (_tmp, repo) = setup_repo();
        // A CMS collection literally named "Collections" sits at `My Site/Collections` in the flat
        // v1 layout and must move to `My Site/Collections/Collections` — old path is a prefix of new.
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Collections/rec1.json", "{\"id\":1}"),
                add(".scratch/My Site/Collections/schema.json", "{}"),
            ],
        );

        assert!(perform_move_folder(
            &repo,
            "My Site/Collections",
            "My Site/Collections/Collections",
            "m"
        )
        .unwrap());

        for branch in [MAIN_BRANCH, DIRTY_BRANCH] {
            // The records moved one level deeper; nothing left loose at the old level.
            assert_eq!(
                sorted_relative_paths(&repo, branch, "My Site/Collections"),
                Some(vec!["Collections/rec1.json".to_string()])
            );
            assert_eq!(
                sorted_relative_paths(&repo, branch, "My Site/Collections/Collections"),
                Some(vec!["rec1.json".to_string()])
            );
        }

        // Idempotent even in the prefix case.
        assert!(!perform_move_folder(
            &repo,
            "My Site/Collections",
            "My Site/Collections/Collections",
            "m"
        )
        .unwrap());
    }

    #[test]
    fn move_folder_refuses_folder_with_nested_data_folder() {
        let (_tmp, repo) = setup_repo();
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Blog/rec1.json", "{\"id\":1}"),
                add("My Site/Blog/Nested/rec2.json", "{\"id\":2}"),
            ],
        );

        let result = perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "m");
        assert!(result.is_err());
        // Nothing should have moved.
        assert!(sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Blog").is_some());
        assert!(sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Collections/Blog").is_none());
    }

    #[test]
    fn move_folder_refuses_destination_with_differing_content() {
        let (_tmp, repo) = setup_repo();
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Blog/rec1.json", "{\"id\":1}"),
                add("My Site/Collections/Blog/other.json", "{\"id\":99}"),
            ],
        );

        let result = perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "m");
        assert!(result.is_err());
    }

    #[test]
    fn move_folder_converges_when_destination_already_identical() {
        let (_tmp, repo) = setup_repo();
        // Simulate a crash after the destination was grafted but before the source was deleted:
        // both locations hold byte-identical records.
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Blog/rec1.json", "{\"id\":1}"),
                add("My Site/Collections/Blog/rec1.json", "{\"id\":1}"),
            ],
        );

        assert!(
            perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "m").unwrap()
        );

        // Source removed, destination intact.
        assert_eq!(
            sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Blog"),
            None
        );
        assert_eq!(
            sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Collections/Blog"),
            Some(vec!["rec1.json".to_string()])
        );
    }

    #[test]
    fn move_folder_no_ops_when_source_absent() {
        let (_tmp, repo) = setup_repo();
        commit_to_both_branches(&repo, &[add("My Site/Other/rec1.json", "{\"id\":1}")]);

        let moved =
            perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "m").unwrap();
        assert!(!moved);
    }

    #[test]
    fn move_folder_moves_dirty_only_folder() {
        let (_tmp, repo) = setup_repo();
        // Folder exists only on dirty (e.g. a locally-created folder not yet on main).
        repo.commit_changes_to_ref(
            DIRTY_BRANCH,
            &[add("My Site/Blog/rec1.json", "{\"id\":1}")],
            "dirty-only",
        )
        .unwrap();

        let moved =
            perform_move_folder(&repo, "My Site/Blog", "My Site/Collections/Blog", "m").unwrap();
        assert!(moved);

        // Main untouched (folder never existed there); dirty relocated.
        assert_eq!(
            sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Blog"),
            None
        );
        assert_eq!(
            sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Collections/Blog"),
            None
        );
        assert_eq!(
            sorted_relative_paths(&repo, DIRTY_BRANCH, "My Site/Collections/Blog"),
            Some(vec!["rec1.json".to_string()])
        );
    }

    #[test]
    fn move_folder_no_ops_when_old_equals_new() {
        let (_tmp, repo) = setup_repo();
        commit_to_both_branches(&repo, &[add("My Site/Blog/rec1.json", "{\"id\":1}")]);

        let moved = perform_move_folder(&repo, "My Site/Blog", "My Site/Blog", "m").unwrap();
        assert!(!moved);
    }

    // ── move_folder: inverse / rollback (nested v2 → flat v1) ─────────────────

    #[test]
    fn move_folder_inverts_nested_collection_to_flat() {
        let (_tmp, repo) = setup_repo();
        // The rollback of an ordinary collection: `Site/Collections/Blog` → `Site/Blog`. Disjoint
        // paths, the mirror of the forward nest move.
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Collections/Blog/rec1.json", "{\"id\":1}"),
                add("My Site/Collections/Blog/rec2.json", "{\"id\":2}"),
                add(".scratch/My Site/Collections/Blog/schema.json", "{}"),
                add(
                    ".scratch/My Site/Collections/Blog/views/default.json",
                    "{\"view\":true}",
                ),
            ],
        );

        let original_rec1_oid =
            blob_oid_at(&repo, MAIN_BRANCH, "My Site/Collections/Blog", "rec1.json").unwrap();

        let moved = perform_move_folder(
            &repo,
            "My Site/Collections/Blog",
            "My Site/Blog",
            "rollback",
        )
        .unwrap();
        assert!(moved);

        for branch in [MAIN_BRANCH, DIRTY_BRANCH] {
            assert_eq!(
                sorted_relative_paths(&repo, branch, "My Site/Collections/Blog"),
                None
            );
            assert_eq!(
                sorted_relative_paths(&repo, branch, ".scratch/My Site/Collections/Blog"),
                None
            );
            assert_eq!(
                sorted_relative_paths(&repo, branch, "My Site/Blog"),
                Some(vec!["rec1.json".to_string(), "rec2.json".to_string()])
            );
            assert_eq!(
                sorted_relative_paths(&repo, branch, ".scratch/My Site/Blog"),
                Some(vec![
                    "schema.json".to_string(),
                    "views/default.json".to_string()
                ])
            );
        }

        // OID preserved across the rollback move.
        assert_eq!(
            blob_oid_at(&repo, MAIN_BRANCH, "My Site/Blog", "rec1.json").unwrap(),
            original_rec1_oid
        );
        assert_eq!(
            repo.resolve_ref("merge_base").unwrap(),
            repo.resolve_ref(MAIN_BRANCH).unwrap()
        );
    }

    #[test]
    fn move_folder_inverts_collection_named_collections() {
        let (_tmp, repo) = setup_repo();
        // The rollback mirror of the prefix case: a collection literally named "Collections" moves
        // back from the nested `My Site/Collections/Collections` to the flat `My Site/Collections`.
        // Here the destination (`My Site/Collections`) is an ANCESTOR of the source — new is a prefix
        // of old — and the source's own records appear under the destination listing.
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Collections/Collections/rec1.json", "{\"id\":1}"),
                add(".scratch/My Site/Collections/Collections/schema.json", "{}"),
            ],
        );

        let moved = perform_move_folder(
            &repo,
            "My Site/Collections/Collections",
            "My Site/Collections",
            "rollback",
        )
        .unwrap();
        assert!(moved);

        for branch in [MAIN_BRANCH, DIRTY_BRANCH] {
            // Records moved one level up; the nested `Collections/` subtree is gone.
            assert_eq!(
                sorted_relative_paths(&repo, branch, "My Site/Collections"),
                Some(vec!["rec1.json".to_string()])
            );
            assert_eq!(
                sorted_relative_paths(&repo, branch, "My Site/Collections/Collections"),
                None
            );
        }

        // Idempotent even in the inverse prefix case (source absent on re-run).
        assert!(!perform_move_folder(
            &repo,
            "My Site/Collections/Collections",
            "My Site/Collections",
            "rollback"
        )
        .unwrap());
    }

    #[test]
    fn move_folder_inverse_collections_named_refuses_when_sibling_present() {
        let (_tmp, repo) = setup_repo();
        // Rolling back the "Collections"-named collection BEFORE its siblings have vacated
        // `My Site/Collections/` is unsafe: the destination still holds the sibling's records, which
        // are NOT part of the source being moved up. The guard must refuse rather than clobber — the
        // migration's ordering (Collections-named LAST) is what prevents this.
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Collections/Collections/rec1.json", "{\"id\":1}"),
                add("My Site/Collections/Blog/rec2.json", "{\"id\":2}"),
            ],
        );

        let result = perform_move_folder(
            &repo,
            "My Site/Collections/Collections",
            "My Site/Collections",
            "rollback",
        );
        assert!(result.is_err());
        // Nothing moved — the source is intact.
        assert_eq!(
            sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Collections/Collections"),
            Some(vec!["rec1.json".to_string()])
        );
    }

    #[test]
    fn move_folder_inverse_collections_named_converges_after_partial() {
        let (_tmp, repo) = setup_repo();
        // Crash mid-rollback of the "Collections"-named collection: the destination was grafted
        // (`My Site/Collections/rec1.json`) but the source (`…/Collections/Collections/rec1.json`)
        // was never deleted. Both hold byte-identical records → converge (finish the delete).
        commit_to_both_branches(
            &repo,
            &[
                add("My Site/Collections/Collections/rec1.json", "{\"id\":1}"),
                add("My Site/Collections/rec1.json", "{\"id\":1}"),
            ],
        );

        let moved = perform_move_folder(
            &repo,
            "My Site/Collections/Collections",
            "My Site/Collections",
            "rollback",
        )
        .unwrap();
        assert!(moved);

        // Source subtree gone; destination intact.
        assert_eq!(
            sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Collections/Collections"),
            None
        );
        assert_eq!(
            sorted_relative_paths(&repo, MAIN_BRANCH, "My Site/Collections"),
            Some(vec!["rec1.json".to_string()])
        );
    }
}
