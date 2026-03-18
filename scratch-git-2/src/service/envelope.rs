use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

use crate::service::error::AppError;
use crate::service::state::AppState;

#[derive(Debug, Serialize)]
pub struct Envelope<T: Serialize> {
    pub data: T,
    pub status: EnvelopeStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeStatus {
    pub gc_in_progress: Option<i64>,
}

/// Wrap a successful response in the standard envelope.
pub fn envelope<T: Serialize>(state: &AppState, repo_id: Option<&str>, data: T) -> Response {
    let gc_in_progress = repo_id.and_then(|id| state.gc_state.get(id).map(|v| *v));
    let body = Envelope {
        data,
        status: EnvelopeStatus { gc_in_progress },
    };
    axum::Json(body).into_response()
}

/// Wrap an error response in the standard envelope.
pub fn envelope_error(state: &AppState, repo_id: Option<&str>, err: AppError) -> Response {
    let gc_in_progress = repo_id.and_then(|id| state.gc_state.get(id).map(|v| *v));
    let status_code = err.status_code();
    let body = json!({
        "data": { "error": err.to_string() },
        "status": { "gcInProgress": gc_in_progress }
    });
    (status_code, axum::Json(body)).into_response()
}

/// Helper that returns an envelope response or an envelope error.
pub fn envelope_result<T: Serialize>(
    state: &AppState,
    repo_id: &str,
    result: Result<T, AppError>,
) -> Response {
    match result {
        Ok(data) => envelope(state, Some(repo_id), data),
        Err(err) => envelope_error(state, Some(repo_id), err),
    }
}

