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

    tracing::info!(
        "[GIT] Proxying to repo: {:?}, PATH_INFO: {}",
        repo_path,
        path_info
    );

    let git_project_root = repos_dir.to_str().unwrap_or("");
    let query_string = req.uri().query().unwrap_or("");

    let content_type = headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let content_length = headers
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    let mut cmd = Command::new("git");
    cmd.arg("http-backend")
        .env("GIT_PROJECT_ROOT", git_project_root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", &path_info)
        .env("REMOTE_USER", "scratch-user")
        .env("QUERY_STRING", query_string)
        .env("REQUEST_METHOD", method.as_str())
        .env("CONTENT_TYPE", content_type)
        .env("CONTENT_LENGTH", content_length)
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

    // Forward stdin
    let mut child_stdin = child.stdin.take().unwrap();
    let mut req_body = req.into_body().into_data_stream();
    tokio::spawn(async move {
        while let Some(chunk_res) = req_body.next().await {
            if let Ok(chunk) = chunk_res {
                if let Err(e) = child_stdin.write_all(&chunk).await {
                    tracing::error!("[GIT] Failed to write to git stdin: {}", e);
                    break;
                }
            }
        }
    });

    // Handle stderr
    let child_stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut reader = BufReader::new(child_stderr);
        let mut line = String::new();
        while let Ok(n) = reader.read_line(&mut line).await {
            if n == 0 {
                break;
            }
            tracing::error!("[GIT][stderr] {}", line.trim_end());
            line.clear();
        }
    });

    let child_stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(child_stdout);

    // Read and parse CGI headers
    let mut cgi_headers = Vec::new();
    let mut header_buf = String::new();
    loop {
        header_buf.clear();
        match reader.read_line(&mut header_buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                let line = header_buf.trim_end_matches("\r\n").trim_end_matches('\n');
                if line.is_empty() {
                    break; // End of headers
                }
                if let Some((name, value)) = line.split_once(": ") {
                    cgi_headers.push((name.to_string(), value.to_string()));
                }
            }
            Err(e) => {
                tracing::error!("[GIT] Failed to read CGI headers: {}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend read error")
                    .into_response();
            }
        }
    }

    // Prepare response
    let mut response_builder = Response::builder().status(StatusCode::OK);
    for (name, value) in cgi_headers {
        if name.to_lowercase() == "status" {
            // Optional CGI status header like "Status: 404 Not Found"
            if let Some(status_str) = value.split_whitespace().next() {
                if let Ok(status) = status_str.parse::<u16>() {
                    if let Ok(status_code) = StatusCode::from_u16(status) {
                        response_builder = response_builder.status(status_code);
                    }
                }
            }
        } else if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
            if let Ok(header_val) = HeaderValue::from_str(&value) {
                response_builder = response_builder.header(header_name, header_val);
            }
        }
    }

    // Body is the remaining stdout stream
    let stream = ReaderStream::new(reader);
    let body = Body::from_stream(stream);

    // Wait for process in background
    tokio::spawn(async move {
        if let Ok(status) = child.wait().await {
            if !status.success() {
                tracing::error!("[GIT] git http-backend exited with {}", status);
            }
        }
    });

    response_builder.body(body).unwrap().into_response()
}
