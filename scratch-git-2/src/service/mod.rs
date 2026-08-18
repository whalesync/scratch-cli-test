pub mod config;
pub mod envelope;
pub mod error;
pub mod git;
pub mod graceful_shutdown;
pub mod routes;
pub mod slack;
pub mod state;
pub mod types;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use std::sync::Arc;
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

/// Result of evaluating a request against the shared-token policy.
enum AuthorizationOutcome {
    Allow,
    Reject,
}

/// Bearer-token authentication for the scratch-git HTTP APIs (DEV-10600).
///
/// Enforcement is gated on `SCRATCH_GIT_AUTH_TOKEN` being configured (passed in as this
/// middleware's own state). When it is `None` the APIs are unauthenticated — today's
/// behavior, relied on by local dev, `cargo test`, and the smoke-test Docker stack.
///
/// When configured, enforcement is STRICT: every request except `/` and `/health` (the
/// `deploy.sh` health probe and GCP TCP health checks) must present a valid `Bearer` token —
/// see [`authorize_request`].
async fn require_auth(
    State(expected_bearer_token): State<Option<Arc<str>>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if path == "/" || path == "/health" {
        return next.run(request).await;
    }

    let Some(expected_bearer_token) = expected_bearer_token.as_deref() else {
        // No token configured on this service → preserve legacy unauthenticated behavior.
        return next.run(request).await;
    };

    match authorize_request(&request, expected_bearer_token) {
        AuthorizationOutcome::Allow => next.run(request).await,
        AuthorizationOutcome::Reject => unauthorized_response(),
    }
}

/// STRICT policy (MR3): only a request presenting a correct `Bearer` token is allowed. A
/// request with no `Authorization` header, a non-`Bearer` header, or a wrong token is
/// rejected with 401. (This is the enforcing form; the earlier MR1 rollout allowed a missing
/// header so the receiving end could deploy before the server was updated to present the token.)
fn authorize_request(request: &Request, expected_bearer_token: &str) -> AuthorizationOutcome {
    match extract_bearer_token(request) {
        Some(provided_bearer_token)
            if bearer_tokens_match(provided_bearer_token, expected_bearer_token) =>
        {
            AuthorizationOutcome::Allow
        }
        _ => AuthorizationOutcome::Reject,
    }
}

/// Extract the `<token>` from an `Authorization: Bearer <token>` header, if present and well-formed.
fn extract_bearer_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// Constant-time token comparison. Both tokens are SHA-256 hashed first so the comparison
/// runs over fixed-length (32-byte) digests — leaking nothing about the expected token's
/// length — and the digests are compared with an XOR accumulator that always touches every
/// byte. (`sha2` is already a dependency.)
fn bearer_tokens_match(provided_bearer_token: &str, expected_bearer_token: &str) -> bool {
    use sha2::{Digest, Sha256};
    let provided_digest = Sha256::digest(provided_bearer_token.as_bytes());
    let expected_digest = Sha256::digest(expected_bearer_token.as_bytes());
    let mut accumulated_difference: u8 = 0;
    for (provided_byte, expected_byte) in provided_digest.iter().zip(expected_digest.iter()) {
        accumulated_difference |= provided_byte ^ expected_byte;
    }
    accumulated_difference == 0
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        "scratch-git: missing or invalid bearer token\n",
    )
        .into_response()
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

    // Shared bearer token the NestJS server presents (DEV-10600). Wrapped in `Arc<str>` so
    // the auth middleware's per-request state clone is cheap. `None` → the HTTP APIs are
    // unauthenticated (legacy behavior; local dev, tests, smoke-test stack).
    let shared_auth_token: Option<Arc<str>> = config.shared_auth_token.as_deref().map(Arc::from);
    let auth_mode_description = if shared_auth_token.is_some() {
        // Strict enforcement: every request (except `/` and `/health`) must present a valid
        // `Bearer` token; missing or invalid tokens get 401.
        "configured (enforcing — requests require a valid bearer token)"
    } else {
        "not configured — HTTP APIs are unauthenticated (legacy)"
    };
    tracing::info!("[API] Shared auth token: {}", auth_mode_description);

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
        .route("/api/repo/manage/{id}/fsck", get(routes::manage::fsck))
        .route("/api/repo/manage/{id}/repair", post(routes::manage::repair))
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
            "/api/repo/read/{id}/count-by-folder",
            get(routes::read::count_files_by_folder),
        )
        .route(
            "/api/repo/read/{id}/count-folder",
            get(routes::read::count_folder_files),
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
            "/api/staging/{jobId}/commit-atomic",
            post(routes::staging::commit_staged_atomic),
        )
        .route(
            "/api/staging/{jobId}",
            delete(routes::staging::cleanup_staging),
        )
        .route("/api/staging", get(routes::staging::list_staging))
        // Debug
        .route("/api/repo/debug/{id}/graph", get(routes::debug::graph))
        .route(
            "/api/repo/debug/slow-request",
            get(routes::debug::slow_request),
        )
        // Bearer-token auth (DEV-10600). Added first so it sits innermost — CORS preflight
        // and timing wrap it, and it runs just before the handlers it protects.
        .layer(middleware::from_fn_with_state(
            shared_auth_token.clone(),
            require_auth,
        ))
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
        // Bearer-token auth (DEV-10600) — same policy as the :3100 API. Closes the
        // git smart-HTTP backend (clone / git-receive-pack push) to unauthenticated callers.
        .layer(middleware::from_fn_with_state(
            shared_auth_token.clone(),
            require_auth,
        ))
        .layer(CorsLayer::permissive())
        .layer(axum::extract::DefaultBodyLimit::max(50 * 1024 * 1024)) // 50MB
        .layer(middleware::from_fn(timing_middleware))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    let git_addr = format!("0.0.0.0:{}", config.git_backend_port);

    tracing::info!(
        "ScratchGit API listening at http://localhost:{} (build: {}, repos: {}, staging: {}, env: {})",
        config.port,
        config.build_version,
        config.repos_dir.display(),
        config.staging_dir.display(),
        std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string()),
    );
    tracing::info!(
        "ScratchGit Git Backend listening at http://localhost:{} (build: {}, repos: {}, staging: {}, env: {})",
        config.git_backend_port,
        config.build_version,
        config.repos_dir.display(),
        config.staging_dir.display(),
        std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string()),
    );

    if let Some(url) = config.slack_notification_webhook_url.clone() {
        let build_version = config.build_version.clone();
        tokio::spawn(async move {
            slack::send_startup_notification(&url, &build_version).await;
        });
    }

    // Age-only startup sweep of orphaned staging dirs (DEV-11317). A crash/redeploy between
    // `stage_files` and the caller's cleanup strands `{staging_dir}/{jobId}` forever; this reaps
    // any dir older than `GIT_STAGING_REAP_MAX_AGE_HOURS` (default 72h) at boot, before the
    // server's hourly (age + job-liveness) cron next ticks. Age-only because the git service has no
    // BullMQ/DbJob knowledge; the generous threshold keeps it clear of the crash-resume design.
    {
        let staging_dir = config.staging_dir.clone();
        let max_age = std::time::Duration::from_secs(config.staging_reap_max_age_hours * 3600);
        tokio::spawn(async move {
            let summary = tokio::task::spawn_blocking(move || {
                routes::staging::reap_stale_staging_dirs(&staging_dir, max_age)
            })
            .await;
            match summary {
                Ok(summary) => {
                    if !summary.reaped_job_ids.is_empty() {
                        tracing::info!(
                            "Staging startup sweep reaped {} orphaned dir(s) ({} bytes) of {} scanned: {:?}",
                            summary.reaped_job_ids.len(),
                            summary.reaped_bytes,
                            summary.scanned,
                            summary.reaped_job_ids,
                        );
                    } else {
                        tracing::info!(
                            "Staging startup sweep found no orphaned dirs ({} scanned)",
                            summary.scanned,
                        );
                    }
                }
                Err(e) => tracing::warn!("Staging startup sweep failed: {}", e),
            }
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

#[cfg(test)]
mod auth_tests {
    //! Tests for the DEV-10600 shared-bearer-token middleware (strict policy).
    use super::*;
    use axum::body::Body;
    use axum::http::header::AUTHORIZATION;
    use axum::http::Request as HttpRequest;
    use axum::routing::get;
    use tower::ServiceExt; // for `oneshot`

    /// A router mirroring the production layering: one protected route plus the always-exempt
    /// `/` and `/health` routes, with the auth middleware carrying `shared_auth_token`.
    fn build_test_router(shared_auth_token: Option<Arc<str>>) -> Router {
        Router::new()
            .route("/", get(|| async { "root" }))
            .route("/health", get(|| async { "ok" }))
            .route("/api/repo/manage/{id}/fsck", get(|| async { "protected" }))
            .layer(middleware::from_fn_with_state(
                shared_auth_token,
                require_auth,
            ))
    }

    async fn status_of(
        shared_auth_token: Option<Arc<str>>,
        path: &str,
        authorization: Option<&str>,
    ) -> StatusCode {
        let mut builder = HttpRequest::builder().method("GET").uri(path);
        if let Some(value) = authorization {
            builder = builder.header(AUTHORIZATION, value);
        }
        let request = builder.body(Body::empty()).unwrap();
        build_test_router(shared_auth_token)
            .oneshot(request)
            .await
            .unwrap()
            .status()
    }

    fn configured_token() -> Option<Arc<str>> {
        Some(Arc::from("s3cret-token"))
    }

    #[tokio::test]
    async fn no_token_configured_allows_unauthenticated_requests() {
        // Legacy behavior: with no token configured the API is fully open (local/dev/tests).
        assert_eq!(
            status_of(None, "/api/repo/manage/abc/fsck", None).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn strict_rejects_request_with_no_authorization_header() {
        // Strict enforcement: a request with no token is rejected (this was allowed during the
        // MR1 lenient rollout).
        assert_eq!(
            status_of(configured_token(), "/api/repo/manage/abc/fsck", None).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn strict_rejects_non_bearer_authorization_header() {
        // A header that isn't a well-formed `Bearer <token>` isn't a presented token, so it is
        // rejected like a missing one.
        assert_eq!(
            status_of(
                configured_token(),
                "/api/repo/manage/abc/fsck",
                Some("s3cret-token")
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn allows_request_with_correct_bearer_token() {
        assert_eq!(
            status_of(
                configured_token(),
                "/api/repo/manage/abc/fsck",
                Some("Bearer s3cret-token"),
            )
            .await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn rejects_request_with_wrong_bearer_token() {
        // A present-but-wrong Bearer token is rejected.
        assert_eq!(
            status_of(
                configured_token(),
                "/api/repo/manage/abc/fsck",
                Some("Bearer wrong-token"),
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn health_and_root_are_exempt() {
        assert_eq!(
            status_of(configured_token(), "/health", None).await,
            StatusCode::OK
        );
        assert_eq!(
            status_of(configured_token(), "/", None).await,
            StatusCode::OK
        );
    }

    #[test]
    fn bearer_tokens_match_compares_correctly() {
        assert!(bearer_tokens_match("abc", "abc"));
        assert!(!bearer_tokens_match("abc", "abd"));
        assert!(!bearer_tokens_match("abc", "abcd"));
        assert!(!bearer_tokens_match("", "abc"));
    }
}
