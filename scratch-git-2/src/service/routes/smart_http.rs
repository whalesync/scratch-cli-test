use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode},
    response::IntoResponse,
};
use futures::stream::StreamExt;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::io::ReaderStream;

use crate::service::state::AppState;
use crate::service::types::DIRTY_BRANCH;

pub async fn git_backend(
    State(state): State<AppState>,
    Path(repo_id_and_path): Path<String>,
    method: Method,
    headers: HeaderMap,
    req: Request<Body>,
) -> impl IntoResponse {
    // repo_id_and_path will be something like "123.git/info/refs"
    let parts: Vec<&str> = repo_id_and_path.splitn(2, ".git/").collect();
    if parts.len() != 2 {
        return (StatusCode::NOT_FOUND, "Repository not found").into_response();
    }
    let repo_id = parts[0];
    let path_info = format!("/{}.git/{}", repo_id, parts[1]);

    let repos_dir = &state.repos_dir;

    let repo_path = repos_dir.join(format!("{}.git", repo_id));

    if !repo_path.exists() {
        tracing::error!("[GIT] Repository not found: {:?}", repo_path);
        return (
            StatusCode::NOT_FOUND,
            format!("Repository not found: {}", repo_id),
        )
            .into_response();
    }

    let head_path = repo_path.join("HEAD");
    if !head_path.exists() {
        tracing::error!("[GIT] Invalid git repository (no HEAD): {:?}", repo_path);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Invalid git repository: {}", repo_id),
        )
            .into_response();
    }

    let git_project_root = repos_dir.to_str().unwrap_or("");
    let query_string = req.uri().query().unwrap_or("").to_string();

    let content_type = headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    // git-receive-pack is a write operation (git push). Acquire the dirty-branch write lock
    // before spawning the subprocess and hold it until the child exits, preventing concurrent
    // writes from the port-3100 REST API and the port-3101 git HTTP backend.
    // git-upload-pack (fetch/clone) is read-only and does not need a lock.
    let is_receive_pack = content_type.contains("git-receive-pack")
        || repo_id_and_path.contains("git-receive-pack");
    let repo_id_owned = repo_id.to_string();
    let write_guard = if is_receive_pack {
        Some(state.write_locks.acquire(&repo_id_owned, DIRTY_BRANCH).await)
    } else {
        None
    };

    let header_content_length = headers
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    let content_encoding = headers
        .get("content-encoding")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    // For POST/PUT, always buffer the body. This is necessary because:
    // 1. git http-backend (CGI) requires CONTENT_LENGTH — chunked requests lack it
    // 2. The body may be gzip-compressed — git http-backend expects raw pkt-line data
    // Git protocol request bodies are small (typically <10KB), so buffering is fine.
    let is_post_or_put = method == Method::POST || method == Method::PUT;

    let (body_bytes, body_for_streaming) = if is_post_or_put {
        let raw = match axum::body::to_bytes(req.into_body(), 100 * 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::error!("[GIT] Failed to buffer request body: {}", e);
                return (
                    StatusCode::BAD_REQUEST,
                    format!("Failed to read request body: {}", e),
                )
                    .into_response();
            }
        };

        // Decompress gzip if needed (git clients may gzip the request body)
        let is_gzip =
            content_encoding.eq_ignore_ascii_case("gzip") || raw.starts_with(&[0x1f, 0x8b]);
        let decompressed = if is_gzip {
            use flate2::read::GzDecoder;
            use std::io::Read;
            let mut decoder = GzDecoder::new(&raw[..]);
            let mut buf = Vec::new();
            match decoder.read_to_end(&mut buf) {
                Ok(_) => {
                    tracing::debug!(
                        "[GIT] Decompressed gzip request body: {} -> {} bytes",
                        raw.len(),
                        buf.len()
                    );
                    axum::body::Bytes::from(buf)
                }
                Err(e) => {
                    tracing::error!("[GIT] Failed to decompress gzip body: {}", e);
                    return (
                        StatusCode::BAD_REQUEST,
                        format!("Failed to decompress request body: {}", e),
                    )
                        .into_response();
                }
            }
        } else {
            raw
        };

        (Some(decompressed), None)
    } else {
        (None, Some(req.into_body()))
    };

    let content_length = match &body_bytes {
        Some(bytes) => bytes.len().to_string(),
        None => header_content_length.unwrap_or_default(),
    };

    tracing::info!(
        "[GIT] Proxying {} to repo: {:?} | PATH_INFO={} | content-type={} | content-length={}",
        method,
        repo_path,
        path_info,
        content_type,
        content_length,
    );

    let mut cmd = Command::new("git");
    cmd.arg("http-backend")
        .env("GIT_PROJECT_ROOT", git_project_root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", &path_info)
        .env("REMOTE_USER", "scratch-user")
        .env("QUERY_STRING", query_string)
        .env("REQUEST_METHOD", method.as_str())
        .env("CONTENT_TYPE", content_type)
        .env("CONTENT_LENGTH", &content_length)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            tracing::error!("[GIT] Failed to spawn git http-backend: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend error").into_response();
        }
    };

    // Forward request body to git http-backend's stdin.
    let mut child_stdin = child.stdin.take().unwrap();
    let stdin_handle = if let Some(buffered) = body_bytes {
        // POST/PUT: body was buffered (and possibly decompressed)
        tokio::spawn(async move {
            let len = buffered.len() as u64;
            if let Err(e) = child_stdin.write_all(&buffered).await {
                tracing::error!("[GIT] Failed to write body to stdin: {}", e);
                return 0u64;
            }
            drop(child_stdin);
            len
        })
    } else {
        // GET/HEAD: stream through (no meaningful body expected)
        let mut req_body = body_for_streaming.unwrap().into_data_stream();
        tokio::spawn(async move {
            let mut bytes_written: u64 = 0;
            while let Some(Ok(chunk)) = req_body.next().await {
                bytes_written += chunk.len() as u64;
                if let Err(e) = child_stdin.write_all(&chunk).await {
                    tracing::error!("[GIT] Failed to write to git stdin: {}", e);
                    return bytes_written;
                }
            }
            drop(child_stdin);
            bytes_written
        })
    };

    // Handle stderr — collect into a shared buffer so we can log it with the exit status
    let child_stderr = child.stderr.take().unwrap();
    let stderr_lines = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let stderr_lines_writer = stderr_lines.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(child_stderr);
        let mut line = String::new();
        while let Ok(n) = reader.read_line(&mut line).await {
            if n == 0 {
                break;
            }
            let trimmed = line.trim_end().to_string();
            tracing::warn!("[GIT][stderr] {}", trimmed);
            stderr_lines_writer.lock().await.push(trimmed);
            line.clear();
        }
    });

    let child_stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(child_stdout);

    // Read and parse CGI headers
    let mut cgi_headers = Vec::new();
    let mut raw_stdout_before_headers = Vec::new();
    let mut header_buf = String::new();
    let mut got_header_terminator = false;
    loop {
        header_buf.clear();
        match reader.read_line(&mut header_buf).await {
            Ok(0) => break, // EOF before header terminator
            Ok(_) => {
                let line = header_buf.trim_end_matches("\r\n").trim_end_matches('\n');
                if line.is_empty() {
                    got_header_terminator = true;
                    break; // End of headers
                }
                if let Some((name, value)) = line.split_once(": ") {
                    cgi_headers.push((name.to_string(), value.to_string()));
                } else {
                    // Not a valid CGI header — likely an error message written directly to stdout
                    raw_stdout_before_headers.push(line.to_string());
                }
            }
            Err(e) => {
                tracing::error!("[GIT] Failed to read CGI headers: {}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend read error")
                    .into_response();
            }
        }
    }

    // If we got no valid CGI headers, git http-backend likely failed.
    // Read remaining stdout to capture the full error message.
    if cgi_headers.is_empty() && !got_header_terminator {
        let mut remaining = String::new();
        // Read up to 4KB of remaining output for error diagnostics
        let mut buf = vec![0u8; 4096];
        if let Ok(n) = tokio::io::AsyncReadExt::read(&mut reader, &mut buf).await {
            if n > 0 {
                remaining = String::from_utf8_lossy(&buf[..n]).to_string();
            }
        }

        let stdout_output = if raw_stdout_before_headers.is_empty() && remaining.is_empty() {
            "(no stdout output)".to_string()
        } else {
            let mut parts = raw_stdout_before_headers;
            if !remaining.is_empty() {
                parts.push(remaining);
            }
            parts.join("\n")
        };

        // Wait for stderr to finish
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let stderr_output = {
            let collected = stderr_lines.lock().await;
            if collected.is_empty() {
                "(no stderr output)".to_string()
            } else {
                collected.join("\n")
            }
        };

        // Wait for exit status
        let exit_status = match child.wait().await {
            Ok(status) => format!("{}", status),
            Err(e) => format!("(failed to get status: {})", e),
        };

        tracing::error!(
            "[GIT] git http-backend failed with no CGI response | {} | method={} path={} | stdout:\n{}\nstderr:\n{}",
            exit_status,
            method,
            path_info,
            stdout_output,
            stderr_output
        );

        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Git backend error: {}", stdout_output),
        )
            .into_response();
    }

    // Prepare response
    let mut response_builder = Response::builder().status(StatusCode::OK);
    let mut cgi_status = StatusCode::OK;
    for (name, value) in &cgi_headers {
        if name.to_lowercase() == "status" {
            // Optional CGI status header like "Status: 404 Not Found"
            if let Some(status_str) = value.split_whitespace().next() {
                if let Ok(status) = status_str.parse::<u16>() {
                    if let Ok(status_code) = StatusCode::from_u16(status) {
                        cgi_status = status_code;
                        response_builder = response_builder.status(status_code);
                    }
                }
            }
        } else if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
            if let Ok(header_val) = HeaderValue::from_str(value) {
                response_builder = response_builder.header(header_name, header_val);
            }
        }
    }

    if !cgi_status.is_success() {
        tracing::warn!(
            "[GIT] git http-backend returned CGI status {} | method={} path={}",
            cgi_status,
            method,
            path_info
        );
    }

    // Wait for stdin forwarding to complete before streaming the response body.
    // git-upload-pack needs all "want" lines and EOF on stdin before it produces packfile data.
    match stdin_handle.await {
        Ok(bytes) => {
            tracing::debug!(
                "[GIT] stdin complete ({} bytes) before streaming response | method={} path={}",
                bytes,
                method,
                path_info
            );
        }
        Err(e) => {
            tracing::error!(
                "[GIT] stdin forwarding task failed | method={} path={} | error: {}",
                method,
                path_info,
                e
            );
        }
    }

    // Body is the remaining stdout stream
    let stream = ReaderStream::new(reader);
    let body = Body::from_stream(stream);

    // Wait for process in background and log stderr on failure.
    // The write_guard (if held for git-receive-pack) is moved into this task so the lock
    // is held for the entire subprocess lifetime and released when the child exits.
    let log_path_info = path_info.clone();
    let log_method = method.to_string();
    tokio::spawn(async move {
        let _guard = write_guard;
        if let Ok(status) = child.wait().await {
            if !status.success() {
                // Give stderr reader a moment to finish collecting output
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let collected = stderr_lines.lock().await;
                let stderr_output = if collected.is_empty() {
                    "(no stderr output)".to_string()
                } else {
                    collected.join("\n")
                };
                tracing::error!(
                    "[GIT] git http-backend exited with {} | method={} path={} | stderr:\n{}",
                    status,
                    log_method,
                    log_path_info,
                    stderr_output
                );
            }
        }
    });

    response_builder.body(body).unwrap().into_response()
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request, Router};
    use std::process::Command as StdCommand;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::service::git::lock::WriteLockManager;
    use crate::service::state::AppState;

    /// Build a minimal axum Router with just the git backend handler for testing.
    fn test_app(repos_dir: &std::path::Path) -> Router {
        let state = AppState {
            repos_dir: repos_dir.to_path_buf(),
            index_dir: repos_dir.to_path_buf(),
            staging_dir: repos_dir.to_path_buf(),
            build_version: "test".to_string(),
            gc_state: std::sync::Arc::new(dashmap::DashMap::new()),
            write_locks: std::sync::Arc::new(WriteLockManager::new()),
        };
        Router::new()
            .route(
                "/{*repo_id_and_path}",
                axum::routing::any(super::git_backend),
            )
            .with_state(state)
    }

    /// Create a bare git repo with an initial commit containing one file.
    fn create_test_repo(repos_dir: &std::path::Path, repo_name: &str) -> std::path::PathBuf {
        let repo_path = repos_dir.join(format!("{}.git", repo_name));
        StdCommand::new("git")
            .args(["init", "--bare", "--initial-branch=main"])
            .arg(&repo_path)
            .output()
            .expect("git init --bare");

        // Create an initial commit using a temp working directory + GIT_DIR
        let work_dir = repos_dir.join("_tmp_work");
        std::fs::create_dir_all(&work_dir).unwrap();

        // Initialize a non-bare repo that uses the bare repo as its object store
        StdCommand::new("git")
            .args(["init", "--initial-branch=main"])
            .arg(&work_dir)
            .output()
            .expect("git init work");

        std::fs::write(work_dir.join("hello.txt"), "world").unwrap();

        let run = |args: &[&str]| {
            let out = StdCommand::new("git")
                .args(["-C", work_dir.to_str().unwrap()])
                .args(["-c", "user.name=Test", "-c", "user.email=test@test.com"])
                .args(args)
                .output()
                .expect(&format!("git {}", args.join(" ")));
            assert!(
                out.status.success(),
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run(&["add", "."]);
        run(&["commit", "-m", "init"]);
        run(&[
            "push",
            repo_path.to_str().unwrap(),
            "refs/heads/main:refs/heads/main",
        ]);

        std::fs::remove_dir_all(&work_dir).ok();
        repo_path
    }

    /// Helper to collect the response body as bytes.
    async fn body_bytes(body: Body) -> Vec<u8> {
        use futures::StreamExt;
        let mut stream = body.into_data_stream();
        let mut buf = Vec::new();
        while let Some(Ok(chunk)) = stream.next().await {
            buf.extend_from_slice(&chunk);
        }
        buf
    }

    // ── Path validation ──────────────────────────────────────────────────

    #[tokio::test]
    async fn returns_404_for_path_without_dot_git() {
        let tmp = TempDir::new().unwrap();
        let app = test_app(tmp.path());
        let resp = app
            .oneshot(
                Request::get("/no-dot-git-here/info/refs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn returns_404_for_nonexistent_repo() {
        let tmp = TempDir::new().unwrap();
        let app = test_app(tmp.path());
        let resp = app
            .oneshot(
                Request::get("/nonexistent.git/info/refs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    // ── GET info/refs (ref advertisement) ────────────────────────────────

    #[tokio::test]
    async fn info_refs_returns_ref_advertisement() {
        let tmp = TempDir::new().unwrap();
        create_test_repo(tmp.path(), "testrepo");
        let app = test_app(tmp.path());

        let resp = app
            .oneshot(
                Request::get("/testrepo.git/info/refs?service=git-upload-pack")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), 200);
        let body = body_bytes(resp.into_body()).await;
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("service=git-upload-pack"),
            "should contain service advertisement: {}",
            text
        );
        assert!(
            text.contains("refs/heads/main"),
            "should list main ref: {}",
            text
        );
    }

    // ── POST git-upload-pack with raw body ───────────────────────────────

    #[tokio::test]
    async fn upload_pack_succeeds_with_valid_pkt_line_body() {
        let tmp = TempDir::new().unwrap();
        let repo_path = create_test_repo(tmp.path(), "testrepo");

        // Get the current HEAD commit to construct a valid want line
        let head_output = StdCommand::new("git")
            .args([
                "--git-dir",
                repo_path.to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ])
            .output()
            .expect("git rev-parse");
        let head_oid = String::from_utf8_lossy(&head_output.stdout)
            .trim()
            .to_string();

        // Build a valid pkt-line request: want HEAD, then done
        let want_line = format!(
            "want {} multi_ack_detailed side-band-64k ofs-delta agent=git/test\n",
            head_oid
        );
        let want_pkt = format!("{:04x}{}", want_line.len() + 4, want_line);
        let request_body = format!("{}00000009done\n", want_pkt);
        let content_length = request_body.len().to_string();

        let app = test_app(tmp.path());
        let resp = app
            .oneshot(
                Request::post("/testrepo.git/git-upload-pack")
                    .header("content-type", "application/x-git-upload-pack-request")
                    .header("content-length", &content_length)
                    .body(Body::from(request_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            resp.status(),
            200,
            "upload-pack should succeed with valid pkt-line body"
        );
        let body = body_bytes(resp.into_body()).await;
        assert!(!body.is_empty(), "response body should contain pack data");
    }

    // ── POST git-upload-pack with gzip body ──────────────────────────────

    #[tokio::test]
    async fn upload_pack_succeeds_with_gzip_compressed_body() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let tmp = TempDir::new().unwrap();
        let repo_path = create_test_repo(tmp.path(), "testrepo");

        let head_output = StdCommand::new("git")
            .args([
                "--git-dir",
                repo_path.to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ])
            .output()
            .expect("git rev-parse");
        let head_oid = String::from_utf8_lossy(&head_output.stdout)
            .trim()
            .to_string();

        let want_line = format!(
            "want {} multi_ack_detailed side-band-64k ofs-delta agent=git/test\n",
            head_oid
        );
        let want_pkt = format!("{:04x}{}", want_line.len() + 4, want_line);
        let raw_body = format!("{}00000009done\n", want_pkt);

        // Gzip compress the body
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(raw_body.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();

        // Verify it starts with gzip magic bytes
        assert_eq!(&compressed[..2], &[0x1f, 0x8b]);

        let content_length = compressed.len().to_string();

        let app = test_app(tmp.path());
        let resp = app
            .oneshot(
                Request::post("/testrepo.git/git-upload-pack")
                    .header("content-type", "application/x-git-upload-pack-request")
                    .header("content-length", &content_length)
                    .body(Body::from(compressed))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            resp.status(),
            200,
            "upload-pack should succeed with gzip-compressed body"
        );
        let body = body_bytes(resp.into_body()).await;
        assert!(!body.is_empty(), "response body should contain pack data");
    }

    // ── POST without Content-Length (chunked transfer) ───────────────────

    #[tokio::test]
    async fn upload_pack_succeeds_without_content_length_header() {
        let tmp = TempDir::new().unwrap();
        let repo_path = create_test_repo(tmp.path(), "testrepo");

        let head_output = StdCommand::new("git")
            .args([
                "--git-dir",
                repo_path.to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ])
            .output()
            .expect("git rev-parse");
        let head_oid = String::from_utf8_lossy(&head_output.stdout)
            .trim()
            .to_string();

        let want_line = format!(
            "want {} multi_ack_detailed side-band-64k ofs-delta agent=git/test\n",
            head_oid
        );
        let want_pkt = format!("{:04x}{}", want_line.len() + 4, want_line);
        let raw_body = format!("{}00000009done\n", want_pkt);

        let app = test_app(tmp.path());
        // Deliberately omit content-length header to simulate chunked transfer
        let resp = app
            .oneshot(
                Request::post("/testrepo.git/git-upload-pack")
                    .header("content-type", "application/x-git-upload-pack-request")
                    .body(Body::from(raw_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            resp.status(),
            200,
            "upload-pack should succeed even without Content-Length (buffered path)"
        );
        let body = body_bytes(resp.into_body()).await;
        assert!(!body.is_empty(), "response body should contain pack data");
    }

    // ── POST with gzip body but no Content-Encoding header ───────────────

    #[tokio::test]
    async fn upload_pack_detects_gzip_by_magic_bytes_without_header() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let tmp = TempDir::new().unwrap();
        let repo_path = create_test_repo(tmp.path(), "testrepo");

        let head_output = StdCommand::new("git")
            .args([
                "--git-dir",
                repo_path.to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ])
            .output()
            .expect("git rev-parse");
        let head_oid = String::from_utf8_lossy(&head_output.stdout)
            .trim()
            .to_string();

        let want_line = format!(
            "want {} multi_ack_detailed side-band-64k ofs-delta agent=git/test\n",
            head_oid
        );
        let want_pkt = format!("{:04x}{}", want_line.len() + 4, want_line);
        let raw_body = format!("{}00000009done\n", want_pkt);

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(raw_body.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();

        let app = test_app(tmp.path());
        // Send gzip body WITHOUT Content-Encoding header — should detect via magic bytes
        let resp = app
            .oneshot(
                Request::post("/testrepo.git/git-upload-pack")
                    .header("content-type", "application/x-git-upload-pack-request")
                    .body(Body::from(compressed))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            resp.status(),
            200,
            "should detect gzip via magic bytes even without Content-Encoding header"
        );
        let body = body_bytes(resp.into_body()).await;
        assert!(!body.is_empty(), "response body should contain pack data");
    }

    // ── Nested repo path (V2 layout) ────────────────────────────────────

    #[tokio::test]
    async fn works_with_nested_v2_repo_path() {
        let tmp = TempDir::new().unwrap();
        // V2 layout: org/workbook/connection.git
        let nested_dir = tmp.path().join("org_abc").join("wkb_123");
        std::fs::create_dir_all(&nested_dir).unwrap();
        create_test_repo(&nested_dir, "coa_xyz");

        // Point repos_dir at the root so the full nested path is relative
        let app = test_app(tmp.path());
        let resp = app
            .oneshot(
                Request::get("/org_abc/wkb_123/coa_xyz.git/info/refs?service=git-upload-pack")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), 200);
        let body = body_bytes(resp.into_body()).await;
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("refs/heads/main"));
    }
}
