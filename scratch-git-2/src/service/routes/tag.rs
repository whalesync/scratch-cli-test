use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::service::envelope::{envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;

#[derive(Deserialize)]
pub struct WriteTagBody {
    pub name: String,
    #[serde(rename = "ref")]
    pub ref_: String,
}

/// Tag whatever `ref` resolves to (branch name, tag name, or oid) with `name`.
/// Overwrites any existing tag with the same name.
pub async fn write_tag(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<WriteTagBody>,
) -> Response {
    let result = tokio::task::spawn_blocking({
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

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}
