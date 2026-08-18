use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::service::envelope::envelope_result;
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::service::types::DIRTY_BRANCH;

#[derive(Deserialize)]
pub struct WriteTagBody {
    pub name: String,
    #[serde(rename = "ref")]
    pub ref_: String,
}

/// Tag whatever `ref` resolves to (branch name, tag name, or oid) with `name`.
/// Overwrites any existing tag with the same name.
///
/// Tags (`merge_base`, publish-plan tags) are written under the `dirty` write
/// lock — the same lock every other `merge_base` writer (`reset`,
/// `discard_changes`, `repair`) holds — so a tag write is never interleaved
/// with a dirty rewrite. Until DEV-11316 this route took no lock at all.
pub async fn write_tag(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<WriteTagBody>,
) -> Response {
    let result = state
        .repo_locks
        .run_write(&id, DIRTY_BRANCH, {
            let repos_dir = state.repos_dir.clone();
            let id = id.clone();
            move || {
                let git_repo = GitRepo::open(&repos_dir, &id)?;
                let oid = git_repo.resolve_ref(&body.ref_)?;
                git_repo.write_tag(&body.name, oid)?;
                Ok::<_, AppError>(json!({ "success": true, "oid": oid.to_string() }))
            }
        })
        .await;

    envelope_result(&state, &id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::git::lock::RepoLocks;
    use crate::service::types::MAIN_BRANCH;
    use axum::http::StatusCode;
    use tempfile::TempDir;

    fn make_state(repos_dir: &std::path::Path) -> AppState {
        AppState {
            repos_dir: repos_dir.to_path_buf(),
            index_dir: repos_dir.to_path_buf(),
            staging_dir: repos_dir.to_path_buf(),
            build_version: "test".to_string(),
            gc_state: std::sync::Arc::new(dashmap::DashMap::new()),
            repo_locks: std::sync::Arc::new(RepoLocks::new()),
        }
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn write_tag_handler_success_and_error_contract() {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "t/tag").unwrap();
        let main_oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let state = make_state(tmp.path());

        let response = write_tag(
            State(state.clone()),
            Path("t/tag".to_string()),
            Json(WriteTagBody {
                name: "plan_abc".to_string(),
                ref_: MAIN_BRANCH.to_string(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["data"]["success"], true);
        assert_eq!(body["data"]["oid"], main_oid.to_string());
        assert!(body["status"]["gcInProgress"].is_null());
        assert_eq!(repo.resolve_ref("plan_abc").unwrap(), main_oid);

        // Unknown ref → error envelope (not a panic), repo missing → 404.
        let response = write_tag(
            State(state.clone()),
            Path("t/tag".to_string()),
            Json(WriteTagBody {
                name: "x".to_string(),
                ref_: "no-such-ref".to_string(),
            }),
        )
        .await;
        assert!(response.status().is_client_error() || response.status().is_server_error());
        let response = write_tag(
            State(state.clone()),
            Path("t/missing".to_string()),
            Json(WriteTagBody {
                name: "x".to_string(),
                ref_: MAIN_BRANCH.to_string(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// The tag write now takes the dirty lock: it waits for an in-flight dirty
    /// write instead of interleaving with it.
    #[tokio::test]
    async fn write_tag_waits_for_in_flight_dirty_write() {
        let tmp = TempDir::new().unwrap();
        GitRepo::init(tmp.path(), "t/tagwait").unwrap();
        let state = make_state(tmp.path());
        let held = state
            .repo_locks
            .acquire_branch_write_guard("t/tagwait", DIRTY_BRANCH)
            .await;
        let tag_future = tokio::spawn({
            let state = state.clone();
            async move {
                write_tag(
                    State(state),
                    Path("t/tagwait".to_string()),
                    Json(WriteTagBody {
                        name: "merge_base".to_string(),
                        ref_: MAIN_BRANCH.to_string(),
                    }),
                )
                .await
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            !tag_future.is_finished(),
            "tag write ran under a dirty write"
        );
        drop(held);
        let response = tag_future.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
