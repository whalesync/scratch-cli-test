use axum::extract::State;
use axum::response::Response;
use serde_json::json;

use crate::service::envelope::envelope;
use crate::service::state::AppState;

pub async fn root(State(state): State<AppState>) -> Response {
    envelope(
        &state,
        None,
        json!({
            "server": "ScratchGit API",
            "build_version": state.build_version,
        }),
    )
}

pub async fn health(State(state): State<AppState>) -> Response {
    let repos_dir_exists = state.repos_dir.exists();
    envelope(
        &state,
        None,
        json!({
            "status": "alive",
            "build_version": state.build_version,
            "reposDir": state.repos_dir.to_string_lossy(),
            "reposDirExists": repos_dir_exists,
            "timestamp": chrono_now(),
        }),
    )
}

fn chrono_now() -> String {
    // Simple ISO timestamp without pulling in chrono
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}Z", now)
}
