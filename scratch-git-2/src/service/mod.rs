pub mod config;
pub mod envelope;
pub mod error;
pub mod git;
pub mod graceful_shutdown;
pub mod routes;
pub mod slack;
pub mod state;
pub mod types;

use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::Router;
use std::time::Instant;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

use config::Config;
use state::AppState;

async fn timing_middleware(req: Request, next: Next) -> impl IntoResponse {
    let start = Instant::now();
    let method = req.method().clone();
    let uri = req.uri().clone();

    let response = next.run(req).await;

    let duration = start.elapsed();
    if duration.as_millis() > 100 {
        tracing::warn!(
            "SLOW API CALL (>100ms): {} {} took {}ms",
            method,
            uri,
            duration.as_millis()
        );
    }

    response
}

pub async fn run() {
    tracing::info!("[API] Scratch-git starting",);
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env();
    let state = AppState::new(&config);

    tracing::info!("[API] Repos directory (v1): {}", config.repos_dir.display());
    tracing::info!(
        "[API] Repos directory (v1) exists: {}",
        config.repos_dir.exists()
    );
    tracing::info!("[API] Index directory: {}", config.index_dir.display());
    tracing::info!("[API] Staging directory: {}", config.staging_dir.display());

    let app = Router::new()
        // System
        .route("/", get(routes::system::root))
        .route("/health", get(routes::system::health))
        // Manage
        .route(
            "/api/repo/manage/{id}/init",
            post(routes::manage::init_repo),
        )
        .route("/api/repo/manage/{id}", delete(routes::manage::delete_repo))
        .route("/api/repo/manage/{id}/exists", get(routes::manage::exists))
        .route(
            "/api/repo/manage/{id}/branch-head",
            get(routes::manage::branch_head),
        )
        .route("/api/repo/manage/{id}/reset", post(routes::manage::reset))
        .route(
            "/api/repo/manage/{id}/count-objects",
            get(routes::manage::count_objects),
        )
        .route("/api/repo/manage/{id}/gc", post(routes::manage::gc))
        .route("/api/repo/manage/copy", post(routes::manage::copy_repo))
        .route(
            "/api/repo/manage/{id}/strip-prefix",
            post(routes::manage::strip_prefix),
        )
        // Read
        .route("/api/repo/read/{id}/list", get(routes::read::list))
        .route("/api/repo/read/{id}/file", get(routes::read::file))
        .route("/api/repo/read/{id}/diff", get(routes::read::diff))
        .route(
            "/api/repo/read/{id}/files-from-folder",
            post(routes::read::files_from_folder),
        )
        .route("/api/repo/read/{id}/files", post(routes::read::files))
        .route(
            "/api/repo/read/{id}/files-paginated",
            get(routes::read::files_paginated),
        )
        .route(
            "/api/repo/read/{id}/blobs-by-oid",
            post(routes::read::blobs_by_oid),
        )
        .route("/api/repo/read/{id}/archive", get(routes::read::archive))
        // Write
        .route(
            "/api/repo/write/{id}/files",
            post(routes::write::commit_files).delete(routes::write::delete_files),
        )
        .route(
            "/api/repo/write/{id}/folder",
            delete(routes::write::delete_folder),
        )
        .route(
            "/api/repo/write/{id}/data-folder",
            delete(routes::write::delete_data_folder),
        )
        .route("/api/repo/write/{id}/publish", post(routes::write::publish))
        .route(
            "/api/repo/write/{id}/discard-changes",
            post(routes::write::discard_changes),
        )
        .route("/api/repo/write/{id}/rebase", post(routes::write::rebase))
        .route("/api/repo/write/{id}/rename", post(routes::write::rename))
        .route(
            "/api/repo/write/{id}/move-folder",
            post(routes::write::move_folder),
        )
        // Diff
        .route("/api/repo/diff/{id}/status", get(routes::diff::status))
        .route(
            "/api/repo/diff/{id}/status/has-dirty",
            get(routes::diff::has_dirty),
        )
        .route("/api/repo/diff/{id}/status/count", get(routes::diff::count))
        .route(
            "/api/repo/diff/{id}/folder-diff",
            get(routes::diff::folder_diff),
        )
        // Checkpoint
        .route(
            "/api/repo/checkpoint/{id}",
            post(routes::checkpoint::create_checkpoint).get(routes::checkpoint::list_checkpoints),
        )
        .route(
            "/api/repo/checkpoint/{id}/revert",
            post(routes::checkpoint::revert_checkpoint),
        )
        .route(
            "/api/repo/checkpoint/{id}/{name}",
            delete(routes::checkpoint::delete_checkpoint),
        )
        // Tag
        .route("/api/repo/tag/{id}", post(routes::tag::write_tag))
        // Index
        .route(
            "/api/repo/index/{id}/build",
            post(routes::index::build_index),
        )
        .route("/api/repo/index/{id}/dump", get(routes::index::dump_index))
        .route(
            "/api/repo/index/{id}/lookup",
            post(routes::index::lookup_index),
        )
        .route(
            "/api/repo/index/{id}/lookup-filenames",
            post(routes::index::lookup_index_filenames),
        )
        .route(
            "/api/repo/index/{id}/upsert-entries",
            post(routes::index::upsert_index_entries),
        )
        .route(
            "/api/repo/index/{id}/delete-entries",
            post(routes::index::delete_index_entries),
        )
        // Staging
        .route(
            "/api/staging/{jobId}/files",
            post(routes::staging::stage_files).get(routes::staging::read_staged_files),
        )
        .route(
            "/api/staging/{jobId}/processed",
            post(routes::staging::mark_staged_files_processed),
        )
        .route(
            "/api/staging/{jobId}/commit",
            post(routes::staging::commit_staged),
        )
        .route(
            "/api/staging/{jobId}",
            delete(routes::staging::cleanup_staging),
        )
        // Debug
        .route("/api/repo/debug/{id}/graph", get(routes::debug::graph))
        .route(
            "/api/repo/debug/slow-request",
            get(routes::debug::slow_request),
        )
        .layer(CorsLayer::permissive())
        .layer(axum::extract::DefaultBodyLimit::max(50 * 1024 * 1024)) // 50MB
        .layer(middleware::from_fn(timing_middleware))
        .with_state(state.clone());

    let git_app = Router::new()
        .route("/", get(routes::system::root))
        .route("/health", get(routes::system::health))
        .route(
            "/{*repo_id_and_path}",
            axum::routing::any(routes::smart_http::git_backend),
        )
        .layer(CorsLayer::permissive())
        .layer(axum::extract::DefaultBodyLimit::max(50 * 1024 * 1024)) // 50MB
        .layer(middleware::from_fn(timing_middleware))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    let git_addr = format!("0.0.0.0:{}", config.git_backend_port);

    tracing::info!(
        "ScratchGit API listening at http://localhost:{} (build: {}, repos: {}, env: {})",
        config.port,
        config.build_version,
        config.repos_dir.display(),
        std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string()),
    );
    tracing::info!(
        "ScratchGit Git Backend listening at http://localhost:{} (build: {}, repos: {}, env: {})",
        config.git_backend_port,
        config.build_version,
        config.repos_dir.display(),
        std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string()),
    );

    if let Some(url) = config.slack_notification_webhook_url.clone() {
        let build_version = config.build_version.clone();
        tokio::spawn(async move {
            slack::send_startup_notification(&url, &build_version).await;
        });
    }

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    let git_listener = tokio::net::TcpListener::bind(&git_addr).await.unwrap();

    // Spawn a background task that listens for SIGINT/SIGTERM. When a signal is received,
    // both watch channels are notified, causing each server to stop accepting new connections
    // and wait for in-flight requests to complete before exiting.
    let (mut api_shutdown_rx, mut git_shutdown_rx) = graceful_shutdown::spawn_shutdown_handler();

    let api_server = axum::serve(listener, app).with_graceful_shutdown(async move {
        api_shutdown_rx.changed().await.ok();
    });
    let git_server = axum::serve(git_listener, git_app).with_graceful_shutdown(async move {
        git_shutdown_rx.changed().await.ok();
    });

    let (api_result, git_result) = tokio::join!(api_server, git_server);
    if let Err(e) = api_result {
        tracing::error!("API server error: {}", e);
    }
    if let Err(e) = git_result {
        tracing::error!("Git backend server error: {}", e);
    }

    tracing::info!("Graceful shutdown complete.");
}
