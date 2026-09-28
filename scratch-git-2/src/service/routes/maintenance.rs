//! `/api/maintenance/*` — the background-maintenance switch and its status (DEV-11316).
//!
//! The switch is flipped from the NestJS server's admin dev tool. It is persisted on disk by
//! `MaintenanceState::set_enabled` and re-read at boot, so it survives restarts; a missing file
//! means off. Everything else about the loop lives in `service::maintenance`.

use axum::extract::{Query, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;

use crate::service::envelope::{envelope, envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::state::AppState;

/// `GET /api/maintenance/config` → `{ enabled, updatedAtMs }`.
pub async fn get_config(State(state): State<AppState>) -> Response {
    envelope(&state, None, state.maintenance.config())
}

#[derive(Deserialize)]
pub struct PutConfigBody {
    pub enabled: bool,
}

/// `PUT /api/maintenance/config` `{ enabled }` → the persisted config. The in-memory switch
/// changes only once the file is written, so a failed persist is a 500 and nothing changes.
pub async fn put_config(
    State(state): State<AppState>,
    Json(body): Json<PutConfigBody>,
) -> Response {
    let result = state.maintenance.set_enabled(body.enabled);
    envelope_result(&state, "", result)
}

/// `GET /api/maintenance/status` → switch, settings, whether a tick is running, the repo being
/// worked on, and the last tick's summary (per-repo outcomes included).
pub async fn get_status(State(state): State<AppState>) -> Response {
    envelope(&state, None, state.maintenance.status())
}

/// `GET /api/maintenance/settings` → every `settings` row (dev tools; no pagination).
pub async fn get_settings(State(state): State<AppState>) -> Response {
    let db = state.maintenance.db().clone();
    let rows = tokio::task::spawn_blocking(move || db.list_settings())
        .await
        .unwrap_or_default();
    envelope(&state, None, rows)
}

/// `GET /api/maintenance/repos` → every repo as the sweep sees it now: derived state + the
/// decision the next tick would take. Read-only; scans like a tick (~ms per repo).
pub async fn get_repos(State(state): State<AppState>) -> Response {
    let repos_dir = state.repos_dir.clone();
    let settings = state.maintenance.settings.clone();
    let db = state.maintenance.db().clone();
    let rows = tokio::task::spawn_blocking(move || {
        let latest_run_state_and_start_by_repo_id = db.latest_run_state_and_start_by_repo_id();
        crate::service::maintenance::repo_overview(
            &repos_dir,
            &settings,
            &latest_run_state_and_start_by_repo_id,
            crate::service::maintenance::now_ms(),
        )
    })
    .await
    .unwrap_or_default();
    envelope(&state, None, rows)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunNowBody {
    pub repo_id: String,
    /// `quick` | `full`
    pub mode: String,
    /// How long the HTTP call waits for the step before answering `started` (default 10 s,
    /// capped at 240 s < the 300 s proxy limit). The step keeps running either way.
    pub wait_seconds: Option<u64>,
}

/// `POST /api/maintenance/run` `{repoId, mode}` — run one step on one repo now (the dev tool's
/// play buttons). Forces the step past the due-rules; same marker/lock/budget/journal as the
/// loop; works with the switch off. Answers the outcome if it finishes within `waitSeconds`,
/// else `{state: "started"}`; `{state: "skipped_already_running"}` when a GC already holds the
/// repo.
pub async fn run_now(State(state): State<AppState>, Json(body): Json<RunNowBody>) -> Response {
    let mode = match body.mode.as_str() {
        "quick" => crate::service::maintenance::StepMode::Quick,
        "full" => crate::service::maintenance::StepMode::Full,
        other => {
            return envelope_error(
                &state,
                Some(&body.repo_id),
                AppError::bad_request(format!("mode must be quick or full, got {:?}", other)),
            )
        }
    };
    let wait = std::time::Duration::from_secs(body.wait_seconds.unwrap_or(10).min(240));
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    let task_state = state.clone();
    let repo_id = body.repo_id.clone();
    tokio::spawn(async move {
        let result =
            crate::service::maintenance::run_manual_step(&task_state, &repo_id, mode).await;
        let _ = result_tx.send(result);
    });
    match tokio::time::timeout(wait, result_rx).await {
        Ok(Ok(Ok(Some(outcome)))) => envelope(
            &state,
            Some(&body.repo_id),
            serde_json::json!({ "state": outcome.state, "outcome": outcome }),
        ),
        Ok(Ok(Ok(None))) => envelope(
            &state,
            Some(&body.repo_id),
            serde_json::json!({ "state": "skipped_already_running" }),
        ),
        Ok(Ok(Err(err))) => envelope_error(&state, Some(&body.repo_id), err),
        Ok(Err(_recv_dropped)) => envelope_error(
            &state,
            Some(&body.repo_id),
            AppError::internal("manual step task dropped".to_string()),
        ),
        // Still running: the detached task owns marker, lock and child; poll the journal.
        Err(_elapsed) => envelope(
            &state,
            Some(&body.repo_id),
            serde_json::json!({ "state": "started" }),
        ),
    }
}

#[derive(Deserialize)]
pub struct TicksQuery {
    pub limit: Option<usize>,
}

/// `GET /api/maintenance/ticks?limit=<n>` → the `ticks` journal, newest first.
pub async fn get_ticks(State(state): State<AppState>, Query(query): Query<TicksQuery>) -> Response {
    let db = state.maintenance.db().clone();
    let rows = tokio::task::spawn_blocking(move || db.recent_ticks(query.limit.unwrap_or(100)))
        .await
        .unwrap_or_default();
    envelope(&state, None, rows)
}

#[derive(Deserialize)]
pub struct RunsQuery {
    pub repo: Option<String>,
    pub limit: Option<usize>,
}

/// `GET /api/maintenance/runs?repo=<id>&limit=<n>` → the journal, newest first (30-day
/// retention). Empty when the DB does not exist.
pub async fn get_runs(State(state): State<AppState>, Query(query): Query<RunsQuery>) -> Response {
    let db = state.maintenance.db().clone();
    let rows = tokio::task::spawn_blocking(move || {
        db.recent_runs(query.repo.as_deref(), query.limit.unwrap_or(100))
    })
    .await
    .unwrap_or_default();
    envelope(&state, None, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::maintenance::MaintenanceState;
    use std::sync::Arc;

    fn make_state(root: &std::path::Path) -> AppState {
        AppState {
            repos_dir: root.join("repos"),
            index_dir: root.join("repos"),
            staging_dir: root.join("staging"),
            build_version: "test".to_string(),
            gc_state: Arc::new(dashmap::DashMap::new()),
            repo_locks: Arc::new(crate::service::git::lock::RepoLocks::new()),
            maintenance: Arc::new(MaintenanceState::load(&root.join("maintenance"))),
            run_store: Default::default(),
        }
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn config_round_trip_through_the_handlers() {
        let tmp = tempfile::tempdir().unwrap();
        let state = make_state(tmp.path());

        let body = response_json(get_config(State(state.clone())).await).await;
        assert_eq!(body["data"]["enabled"], false);
        assert!(body["data"]["updatedAtMs"].is_null());

        let response =
            put_config(State(state.clone()), Json(PutConfigBody { enabled: true })).await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["data"]["enabled"], true);
        assert!(body["data"]["updatedAtMs"].is_number());
        assert!(state.maintenance.is_enabled());
        assert!(tmp.path().join("maintenance/maintenance.sqlite").exists());

        let body = response_json(get_status(State(state.clone())).await).await;
        assert_eq!(body["data"]["enabled"], true);
        assert_eq!(body["data"]["tickInProgress"], false);
        assert!(body["data"]["current"].is_null());
        assert!(body["data"]["lastTick"].is_null());
        assert_eq!(body["data"]["settings"]["looseThreshold"], 500);

        // A fresh state from the same dir sees the persisted value.
        let reloaded = make_state(tmp.path());
        assert!(reloaded.maintenance.is_enabled());

        let body = response_json(
            get_runs(
                State(state.clone()),
                Query(RunsQuery {
                    repo: None,
                    limit: Some(5),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(body["data"], serde_json::json!([]));

        let body = response_json(get_settings(State(state.clone())).await).await;
        assert_eq!(body["data"][0]["key"], "enabled");
        assert_eq!(body["data"][0]["value"], "1");
        let body =
            response_json(get_ticks(State(state.clone()), Query(TicksQuery { limit: None })).await)
                .await;
        assert_eq!(body["data"], serde_json::json!([]));
        let body = response_json(get_repos(State(state.clone())).await).await;
        assert_eq!(body["data"], serde_json::json!([]), "no repos dir yet");
    }

    #[tokio::test]
    async fn run_now_validates_and_runs_a_manual_quick() {
        let tmp = tempfile::tempdir().unwrap();
        let state = make_state(tmp.path());
        // Bad mode → 400.
        let response = run_now(
            State(state.clone()),
            Json(RunNowBody {
                repo_id: "org_a/wkb_a/coa_a".to_string(),
                mode: "aggressive".to_string(),
                wait_seconds: None,
            }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        // Missing repo → 404.
        let response = run_now(
            State(state.clone()),
            Json(RunNowBody {
                repo_id: "org_a/wkb_a/coa_missing".to_string(),
                mode: "quick".to_string(),
                wait_seconds: Some(30),
            }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        // Real repo → completed outcome with reason manual, journaled.
        crate::service::git::repo::GitRepo::init(&state.repos_dir, "org_a/wkb_a/coa_run").unwrap();
        let response = run_now(
            State(state.clone()),
            Json(RunNowBody {
                repo_id: "org_a/wkb_a/coa_run".to_string(),
                mode: "quick".to_string(),
                wait_seconds: Some(60),
            }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["data"]["state"], "completed");
        assert_eq!(body["data"]["outcome"]["reason"], "manual");
    }
}
