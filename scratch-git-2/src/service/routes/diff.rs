use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use crate::service::envelope::{envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::service::types::*;

pub async fn status(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let merge_base_oid = match git_repo.resolve_merge_base_or_main() {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };

            if merge_base_oid == dirty_oid {
                return Ok(json!([]));
            }

            let changes = git_repo.compare_commits(merge_base_oid, dirty_oid)?;
            Ok::<_, AppError>(serde_json::to_value(&changes).unwrap())
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn has_dirty(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let merge_base_oid = match git_repo.resolve_merge_base_or_main() {
                Ok(oid) => oid,
                Err(_) => return Ok(json!({ "dirty": false })),
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!({ "dirty": false })),
            };

            if merge_base_oid == dirty_oid {
                return Ok(json!({ "dirty": false }));
            }

            // Compare root-level non-dotfile entries only (fast, skips .scratch/ metadata)
            let dirty = git_repo.has_visible_tree_changes(merge_base_oid, dirty_oid)?;
            Ok::<_, AppError>(json!({ "dirty": dirty }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct CountQuery {
    /// Which ref to diff `dirty` against.
    ///   - `"main"` → compare against live `refs/heads/main`. Used by the
    ///     DEV-10316 desktop dirty gate, which must NOT be fooled by a
    ///     `merge_base` tag that lags `main` after a pull-without-rebase
    ///     (that lag would false-positive and block a clean connection).
    ///   - omitted / anything else → the `merge_base` tag (falling back to
    ///     `main`), i.e. the legacy "what publish would ship" baseline.
    pub base: Option<String>,
}

pub async fn count(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<CountQuery>,
) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let compare_against_main = query.base.as_deref() == Some("main");
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let base_oid = if compare_against_main {
                match git_repo.resolve_ref(MAIN_BRANCH) {
                    Ok(oid) => oid,
                    Err(_) => return Ok(json!({ "count": 0 })),
                }
            } else {
                match git_repo.resolve_merge_base_or_main() {
                    Ok(oid) => oid,
                    Err(_) => return Ok(json!({ "count": 0 })),
                }
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!({ "count": 0 })),
            };

            if base_oid == dirty_oid {
                return Ok(json!({ "count": 0 }));
            }

            let changes = git_repo.compare_commits(base_oid, dirty_oid)?;
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

#[cfg(test)]
mod count_vs_main_tests {
    use crate::service::git::repo::GitRepo;
    use crate::service::types::*;
    use tempfile::TempDir;

    /// After a pull-without-rebase, a pull job writes fresh records into BOTH
    /// `main` and `dirty` but does NOT advance the `merge_base` tag — so the
    /// tag lags `main`, and a `merge_base → dirty` diff reports the pulled
    /// records as "pending" (a false positive). The DEV-10316 dirty gate
    /// avoids this by diffing `dirty` against live `main` (the `?base=main`
    /// count), which correctly reports zero pending changes. This locks in
    /// decision #6: compare against live `main`, read-only.
    #[test]
    fn count_vs_main_ignores_post_pull_merge_base_lag() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "test").unwrap();

        // R1 lands on main; establish a clean dirty == merge_base == main baseline.
        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "R1.json".to_string(),
                content: Some("{\"v\":1}".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "seed R1",
        )
        .unwrap();
        repo.rebase_dirty("ours").unwrap(); // dirty == merge_base == main

        // Simulate a pull-without-rebase: identical fresh records (R1 updated,
        // R2 added) written to BOTH main and dirty, with the merge_base tag
        // left lagging at the pre-pull commit.
        let pulled = vec![
            FileChange {
                path: "R1.json".to_string(),
                content: Some("{\"v\":2}".to_string()),
                oid: None,
                change_type: ChangeType::Modify,
            },
            FileChange {
                path: "R2.json".to_string(),
                content: Some("{\"v\":1}".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            },
        ];
        repo.commit_changes_to_ref(MAIN_BRANCH, &pulled, "pull into main")
            .unwrap();
        repo.commit_changes_to_ref(DIRTY_BRANCH, &pulled, "pull into dirty")
            .unwrap();

        let main_oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let dirty_oid = repo.resolve_ref(DIRTY_BRANCH).unwrap();
        let merge_base_oid = repo.resolve_merge_base_or_main().unwrap();

        // The lagging merge_base tag false-positives — what the legacy count saw.
        let vs_merge_base = repo.compare_commits(merge_base_oid, dirty_oid).unwrap();
        assert!(
            !vs_merge_base.is_empty(),
            "merge_base lag should surface pulled records as a false positive"
        );

        // Comparing against live main — what `?base=main` does — sees no pending
        // user changes, because main and dirty hold identical trees.
        let vs_main = repo.compare_commits(main_oid, dirty_oid).unwrap();
        assert!(
            vs_main.is_empty(),
            "vs-main count must be zero after a pull-without-rebase (no real pending changes)"
        );
    }

    /// A genuine pending user edit on `dirty` (not present on `main`) IS
    /// counted by the vs-main comparison — the gate must still fire when there
    /// really is unpublished work staged.
    #[test]
    fn count_vs_main_counts_real_pending_edits() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "test").unwrap();

        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "R1.json".to_string(),
                content: Some("{\"v\":1}".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "seed R1",
        )
        .unwrap();
        repo.rebase_dirty("ours").unwrap();

        // A real local edit staged only on dirty.
        repo.commit_changes_to_ref(
            DIRTY_BRANCH,
            &[FileChange {
                path: "R1.json".to_string(),
                content: Some("{\"v\":99}".to_string()),
                oid: None,
                change_type: ChangeType::Modify,
            }],
            "user edit",
        )
        .unwrap();

        let main_oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let dirty_oid = repo.resolve_ref(DIRTY_BRANCH).unwrap();
        let vs_main = repo.compare_commits(main_oid, dirty_oid).unwrap();
        assert_eq!(
            vs_main.len(),
            1,
            "a real pending edit on dirty must be counted vs main"
        );
    }
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
            let merge_base_oid = match git_repo.resolve_merge_base_or_main() {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };
            let dirty_oid = match git_repo.resolve_ref(DIRTY_BRANCH) {
                Ok(oid) => oid,
                Err(_) => return Ok(json!([])),
            };

            if merge_base_oid == dirty_oid {
                return Ok(json!([]));
            }

            let all_changes = git_repo.compare_commits(merge_base_oid, dirty_oid)?;
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
