pub mod git_backend;
pub mod routes;

use std::path::PathBuf;
use std::sync::Arc;

use axum::{routing::get, routing::post, Router};
use tower_http::trace::TraceLayer;

use crate::git::RepoBranchLock;

/// Shared state available to all route handlers.
#[derive(Clone)]
pub struct AppState {
    /// Root directory where all repos live, e.g. /var/scratch-repos
    pub repos_dir: PathBuf,
    /// Per-repo write lock
    pub lock: Arc<RepoBranchLock>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        // Custom operations
        .route("/api/repos/init", post(routes::init_repo))
        .route("/api/repos/upsert-files", post(routes::upsert_files))
        .route("/api/repos/rebase-dirty", post(routes::rebase_dirty))
        .route("/api/repos/diff", post(routes::diff))
        .route("/api/repos/delete-files", post(routes::delete_files))
        .route("/api/repos/read-files", post(routes::read_files))
        // Git HTTP backend — handles git clone / fetch / push
        // Path: /git/{repoPath...} where repoPath is relative to repos_dir
        .route("/git/{*repo_path}", get(git_backend::handle))
        .route("/git/{*repo_path}", post(git_backend::handle))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}
