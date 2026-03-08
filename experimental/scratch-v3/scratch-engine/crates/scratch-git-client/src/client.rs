use scratch_core::error::EngineError;
use serde_json::{json, Value};

/// Async HTTP client for the scratch-git-2 microservice.
pub struct GitClient {
    client: reqwest::Client,
    base_url: String,
}

/// Extract the `"data"` field from a `{"data": ...}` envelope.
/// Falls back to the full body if no `"data"` key is present.
fn unwrap_response(body: Value) -> Value {
    match &body {
        Value::Object(map) => match map.get("data") {
            Some(data) => data.clone(),
            None => body,
        },
        _ => body,
    }
}

/// Strip the leading `/` from a path, matching Python's `str.lstrip("/")`.
fn strip_leading_slash(path: &str) -> &str {
    path.trim_start_matches('/')
}

impl GitClient {
    /// Create a new `GitClient` pointing at the given scratch-git-2 base URL.
    pub fn new(base_url: &str) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("failed to build reqwest client"),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Build the canonical repo ID: `"{org_id}--{workbook_id}--{connection_id}"`.
    pub fn repo_id(org_id: &str, workbook_id: &str, connection_id: &str) -> String {
        format!("{org_id}--{workbook_id}--{connection_id}")
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /// Issue a GET request returning parsed JSON.
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, EngineError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .get(&url)
            .query(query)
            .send()
            .await
            .map_err(|e| EngineError::GitClient(e.to_string()))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| EngineError::GitClient(e.to_string()))?;

        if !status.is_success() {
            return Err(EngineError::GitClient(format!(
                "GET {path} returned {status}: {body_text}"
            )));
        }

        let body: Value =
            serde_json::from_str(&body_text).map_err(|e| EngineError::GitClient(e.to_string()))?;

        Ok(unwrap_response(body))
    }

    /// Issue a POST request with a JSON body, returning parsed JSON.
    async fn post(
        &self,
        path: &str,
        query: &[(&str, &str)],
        json_body: &Value,
    ) -> Result<Value, EngineError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .post(&url)
            .query(query)
            .json(json_body)
            .send()
            .await
            .map_err(|e| EngineError::GitClient(e.to_string()))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| EngineError::GitClient(e.to_string()))?;

        if !status.is_success() {
            return Err(EngineError::GitClient(format!(
                "POST {path} returned {status}: {body_text}"
            )));
        }

        let body: Value =
            serde_json::from_str(&body_text).map_err(|e| EngineError::GitClient(e.to_string()))?;

        Ok(unwrap_response(body))
    }

    // ── Repo management ──────────────────────────────────────────────────

    /// Initialize a repository.
    pub async fn init_repo(&self, repo_id: &str) -> Result<Value, EngineError> {
        self.post(
            &format!("/api/repo/manage/{repo_id}/init"),
            &[],
            &json!({}),
        )
        .await
    }

    // ── Read operations ──────────────────────────────────────────────────

    /// List files in a folder on the given branch.
    pub async fn list_files(
        &self,
        repo_id: &str,
        folder: &str,
        branch: &str,
    ) -> Result<Vec<Value>, EngineError> {
        let stripped = strip_leading_slash(folder);
        let mut query = vec![("branch", branch)];
        if !stripped.is_empty() {
            query.push(("folder", stripped));
        }

        let val = self
            .get(&format!("/api/repo/read/{repo_id}/list"), &query)
            .await?;

        match val {
            Value::Array(arr) => Ok(arr),
            other => Ok(vec![other]),
        }
    }

    /// Read a single file from the repository.
    pub async fn read_file(
        &self,
        repo_id: &str,
        path: &str,
        branch: &str,
    ) -> Result<Value, EngineError> {
        let stripped = strip_leading_slash(path);
        self.get(
            &format!("/api/repo/read/{repo_id}/file"),
            &[("path", stripped), ("branch", branch)],
        )
        .await
    }

    /// Read multiple files in a single batch request.
    pub async fn read_files_batch(
        &self,
        repo_id: &str,
        paths: &[String],
        branch: &str,
    ) -> Result<Vec<Value>, EngineError> {
        let stripped_paths: Vec<&str> = paths.iter().map(|p| strip_leading_slash(p)).collect();

        let val = self
            .post(
                &format!("/api/repo/read/{repo_id}/files"),
                &[],
                &json!({ "paths": stripped_paths, "branch": branch }),
            )
            .await?;

        match val {
            Value::Array(arr) => Ok(arr),
            other => Ok(vec![other]),
        }
    }

    /// Read the diff for a specific file path.
    pub async fn read_diff(&self, repo_id: &str, path: &str) -> Result<Value, EngineError> {
        let stripped = strip_leading_slash(path);
        self.get(
            &format!("/api/repo/read/{repo_id}/diff"),
            &[("path", stripped)],
        )
        .await
    }

    // ── Write operations ─────────────────────────────────────────────────

    /// Write one or more files to the repository.
    pub async fn write_files(
        &self,
        repo_id: &str,
        files: &[Value],
        message: &str,
        branch: &str,
    ) -> Result<Value, EngineError> {
        let mut payload = json!({ "files": files });
        if !message.is_empty() {
            payload["message"] = Value::String(message.to_string());
        }

        self.post(
            &format!("/api/repo/write/{repo_id}/files"),
            &[("branch", branch)],
            &payload,
        )
        .await
    }

    /// Rename files in a repository folder.
    pub async fn rename_files(
        &self,
        repo_id: &str,
        folder_path: &str,
        renames: &[Value],
    ) -> Result<Value, EngineError> {
        self.post(
            &format!("/api/repo/write/{repo_id}/rename"),
            &[],
            &json!({ "folderPath": folder_path, "renames": renames }),
        )
        .await
    }

    /// Rebase the dirty branch onto the latest main.
    pub async fn rebase_dirty(&self, repo_id: &str) -> Result<Value, EngineError> {
        self.post(
            &format!("/api/repo/write/{repo_id}/rebase"),
            &[],
            &json!({}),
        )
        .await
    }

    /// Publish a file (commit from dirty to main).
    pub async fn publish(
        &self,
        repo_id: &str,
        path: &str,
        content: &str,
    ) -> Result<Value, EngineError> {
        let stripped = strip_leading_slash(path);
        self.post(
            &format!("/api/repo/write/{repo_id}/publish"),
            &[],
            &json!({ "file": { "path": stripped, "content": content } }),
        )
        .await
    }

    /// Discard uncommitted changes for a specific file.
    pub async fn discard_changes(&self, repo_id: &str, path: &str) -> Result<Value, EngineError> {
        let stripped = strip_leading_slash(path);
        self.post(
            &format!("/api/repo/write/{repo_id}/discard-changes"),
            &[],
            &json!({ "path": stripped }),
        )
        .await
    }

    // ── Diff / Status ────────────────────────────────────────────────────

    /// Get the full git status for a repository.
    pub async fn git_status(&self, repo_id: &str) -> Result<Value, EngineError> {
        self.get(&format!("/api/repo/diff/{repo_id}/status"), &[])
            .await
    }

    /// Check whether the repository has any dirty (uncommitted) changes.
    pub async fn has_dirty(&self, repo_id: &str) -> Result<bool, EngineError> {
        let val = self
            .get(
                &format!("/api/repo/diff/{repo_id}/status/has-dirty"),
                &[],
            )
            .await?;

        Ok(val
            .get("dirty")
            .and_then(|v| v.as_bool())
            .unwrap_or(false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repo_id_construction() {
        let id = GitClient::repo_id("org-123", "wb-456", "conn-789");
        assert_eq!(id, "org-123--wb-456--conn-789");
    }

    #[test]
    fn test_repo_id_with_empty_parts() {
        let id = GitClient::repo_id("", "wb", "conn");
        assert_eq!(id, "--wb--conn");
    }

    #[test]
    fn test_strip_leading_slash_no_slash() {
        assert_eq!(strip_leading_slash("foo/bar.json"), "foo/bar.json");
    }

    #[test]
    fn test_strip_leading_slash_single_slash() {
        assert_eq!(strip_leading_slash("/foo/bar.json"), "foo/bar.json");
    }

    #[test]
    fn test_strip_leading_slash_multiple_slashes() {
        assert_eq!(strip_leading_slash("///foo/bar.json"), "foo/bar.json");
    }

    #[test]
    fn test_strip_leading_slash_empty() {
        assert_eq!(strip_leading_slash(""), "");
    }

    #[test]
    fn test_strip_leading_slash_only_slashes() {
        assert_eq!(strip_leading_slash("///"), "");
    }

    #[test]
    fn test_unwrap_response_with_data_field() {
        let body = json!({"data": [{"path": "a.json"}, {"path": "b.json"}]});
        let result = unwrap_response(body);
        assert_eq!(result, json!([{"path": "a.json"}, {"path": "b.json"}]));
    }

    #[test]
    fn test_unwrap_response_without_data_field() {
        let body = json!({"status": "ok"});
        let result = unwrap_response(body);
        assert_eq!(result, json!({"status": "ok"}));
    }

    #[test]
    fn test_unwrap_response_data_is_null() {
        let body = json!({"data": null});
        let result = unwrap_response(body);
        assert!(result.is_null());
    }

    #[test]
    fn test_unwrap_response_non_object() {
        let body = json!([1, 2, 3]);
        let result = unwrap_response(body.clone());
        assert_eq!(result, body);
    }

    #[test]
    fn test_unwrap_response_data_is_bool() {
        let body = json!({"data": {"dirty": true}});
        let result = unwrap_response(body);
        assert_eq!(result, json!({"dirty": true}));
    }

    #[test]
    fn test_client_new_strips_trailing_slash() {
        let client = GitClient::new("http://localhost:3100/");
        assert_eq!(client.base_url, "http://localhost:3100");
    }

    #[test]
    fn test_client_new_no_trailing_slash() {
        let client = GitClient::new("http://localhost:3100");
        assert_eq!(client.base_url, "http://localhost:3100");
    }
}
