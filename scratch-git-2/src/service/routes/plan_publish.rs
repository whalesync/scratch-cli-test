use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::service::envelope::envelope_result;
use crate::service::error::AppError;
use crate::service::state::AppState;
use crate::service::worktree::TempWorktree;
use crate::shared::plan_publish;

const DIRTY_BRANCH: &str = "dirty";
const MAIN_BRANCH: &str = "main";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildPlanBody {
    pub connection_name: String,
    pub connection_id: String,
}

/// POST /api/repo/:id/publish-plan/build
///
/// Materializes worktrees from the bare repo, runs the shared publish-plan logic,
/// commits phase files to dirty, then cleans up the worktrees.
pub async fn build_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<BuildPlanBody>,
) -> Response {
    let result = {
        let repos_dir = state.repos_dir.clone();
        let index_dir = state.index_dir.clone();
        let write_locks = state.write_locks.clone();
        let id = id.clone();

        write_locks
            .with_lock(&id, DIRTY_BRANCH, || {
                let repos_dir = repos_dir.clone();
                let index_dir = index_dir.clone();
                let id = id.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
                        let bare_repo = repos_dir.join(format!("{}.git", id));
                        if !bare_repo.exists() {
                            return Err(AppError::not_found(format!(
                                "Repository not found: {}",
                                id
                            )));
                        }

                        let worktrees_root = repos_dir.join(".worktrees");

                        // Materialize both branches
                        let dirty_wt =
                            TempWorktree::create(&bare_repo, DIRTY_BRANCH, &worktrees_root)
                                .map_err(|e| {
                                    AppError::internal(format!(
                                        "Failed to create dirty worktree: {e}"
                                    ))
                                })?;
                        let main_wt =
                            TempWorktree::create(&bare_repo, MAIN_BRANCH, &worktrees_root)
                                .map_err(|e| {
                                    AppError::internal(format!(
                                        "Failed to create main worktree: {e}"
                                    ))
                                })?;

                        let db_path = index_dir.join(format!("{}.db", id));
                        let timestamp = plan_publish::now_compact();

                        // Build the plan
                        let result = plan_publish::build_publish_plan(
                            &body.connection_name,
                            &body.connection_id,
                            &dirty_wt.path,
                            &main_wt.path,
                            &db_path,
                            &timestamp,
                        )
                        .map_err(|e| AppError::internal(format!("Plan build failed: {e}")))?;

                        match result {
                            Some(plan_result) => {
                                // Commit the plan files to dirty branch
                                dirty_wt
                                    .commit(&format!(
                                        "Publish plan {} for {}",
                                        plan_result.meta.plan_id, body.connection_name
                                    ))
                                    .map_err(|e| {
                                        AppError::internal(format!("Failed to commit plan: {e}"))
                                    })?;

                                Ok(json!({
                                    "success": true,
                                    "planId": plan_result.meta.plan_id,
                                    "summary": plan_result.meta.summary,
                                }))
                            }
                            None => {
                                // No changes — nothing to commit
                                Ok(json!({
                                    "success": true,
                                    "planId": null,
                                    "summary": null,
                                    "message": "Nothing to publish — no changes detected"
                                }))
                            }
                        }
                        // dirty_wt and main_wt dropped here → worktrees cleaned up
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await
    };

    envelope_result(&state, &id, result)
}
