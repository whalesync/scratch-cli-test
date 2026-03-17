//! Proxy to the system `git http-backend` CGI program.
//!
//! This lets clients do `git clone http://localhost:3100/git/orgId/workbookId/connId/repo.git`
//! using the standard git protocol. We set the CGI environment variables that
//! git-http-backend expects and forward stdin/stdout.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method, Request, Response, StatusCode};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::AppState;

pub async fn handle(
    State(state): State<AppState>,
    method: Method,
    Path(repo_path): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    req: Request<Body>,
) -> Response<Body> {
    // git http-backend expects:
    //   GIT_PROJECT_ROOT = repos_dir
    //   PATH_INFO        = /{repo_path}  (full path including repo name and git suffix)
    //   GIT_HTTP_EXPORT_ALL = 1
    // The repo_path captured by axum is e.g. "org/wb/conn/repo.git/info/refs"
    if !repo_path.contains(".git") {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap();
    }
    let path_info = format!("/{}", repo_path);

    let query_string = query
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");

    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let content_length = headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Collect request body
    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(format!("failed to read body: {e}")))
                .unwrap();
        }
    };

    // Spawn git http-backend as a subprocess
    let mut child = match Command::new("git")
        .arg("http-backend")
        .env("GIT_PROJECT_ROOT", &state.repos_dir)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("GIT_HTTP_RECEIVE_PACK", "1")
        .env("REQUEST_METHOD", method.as_str())
        .env("PATH_INFO", &path_info)
        .env("QUERY_STRING", &query_string)
        .env("CONTENT_TYPE", &content_type)
        .env("CONTENT_LENGTH", &content_length)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!("failed to spawn git http-backend: {e}")))
                .unwrap();
        }
    };

    // Write request body to stdin
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&body_bytes).await;
    }

    // Read response from stdout
    let output = match child.wait_with_output().await {
        Ok(o) => o,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!("git http-backend error: {e}")))
                .unwrap();
        }
    };

    // git http-backend writes a CGI response: headers, blank line, body
    // Parse it and convert to an HTTP response
    parse_cgi_response(output.stdout)
}

/// Parse a CGI-format response (headers\r\n\r\nbody) into an Axum Response.
fn parse_cgi_response(raw: Vec<u8>) -> Response<Body> {
    // Find the header/body separator (\r\n\r\n or \n\n)
    let separator = if let Some(pos) = find_sequence(&raw, b"\r\n\r\n") {
        (pos, pos + 4)
    } else if let Some(pos) = find_sequence(&raw, b"\n\n") {
        (pos, pos + 2)
    } else {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from("invalid CGI response from git http-backend"))
            .unwrap();
    };

    let header_bytes = &raw[..separator.0];
    let body_bytes = raw[separator.1..].to_vec();

    let header_str = String::from_utf8_lossy(header_bytes);
    let mut status = StatusCode::OK;
    let mut builder = Response::builder();

    for line in header_str.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            let value = value.trim();
            if key.eq_ignore_ascii_case("Status") {
                // "Status: 200 OK"
                if let Some(code) = value.split_whitespace().next() {
                    if let Ok(n) = code.parse::<u16>() {
                        status = StatusCode::from_u16(n).unwrap_or(StatusCode::OK);
                    }
                }
            } else {
                builder = builder.header(key, value);
            }
        }
    }

    builder
        .status(status)
        .body(Body::from(body_bytes))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::empty())
                .unwrap()
        })
}

fn find_sequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
