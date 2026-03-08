use serde_json::Value;

/// HTTP client for the Scratch FastAPI backend.
pub struct ApiClient {
    client: reqwest::Client,
    base_url: String,
    auth_token: Option<String>,
}

impl ApiClient {
    /// Create a new `ApiClient` pointing at the given base URL.
    ///
    /// Automatically picks up `SCRATCH_AUTH_TOKEN` from the environment if set.
    pub fn new(base_url: &str) -> Self {
        let auth_token = std::env::var("SCRATCH_AUTH_TOKEN").ok();
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("failed to build reqwest client"),
            base_url: base_url.trim_end_matches('/').to_string(),
            auth_token,
        }
    }

    /// Create a new `ApiClient` with an explicit auth token.
    pub fn with_token(base_url: &str, token: Option<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("failed to build reqwest client"),
            base_url: base_url.trim_end_matches('/').to_string(),
            auth_token: token,
        }
    }

    // ── Workspaces ─────────────────────────────────────────────────────

    /// Create a new workspace.
    pub async fn create_workspace(&self, name: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces", self.base_url);
        self.post_json(&url, &serde_json::json!({"name": name})).await
    }

    /// List all workspaces.
    pub async fn list_workspaces(&self) -> Result<Value, String> {
        let url = format!("{}/api/workspaces", self.base_url);
        self.get_json(&url).await
    }

    /// Delete a workspace.
    pub async fn delete_workspace(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}", self.base_url);
        self.delete_json(&url).await
    }

    // ── Connections ────────────────────────────────────────────────────

    /// Create a new connection.
    pub async fn create_connection(
        &self,
        workspace_id: &str,
        service: &str,
        credentials: &Value,
        display_name: Option<&str>,
    ) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/connections", self.base_url);
        let mut body = serde_json::json!({
            "service": service,
            "credentials": credentials,
        });
        if let Some(name) = display_name {
            body["displayName"] = Value::String(name.to_string());
        }
        self.post_json(&url, &body).await
    }

    /// List connections for a workspace.
    pub async fn list_connections(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/connections",
            self.base_url
        );
        self.get_json(&url).await
    }

    /// Delete a connection.
    pub async fn delete_connection(
        &self,
        workspace_id: &str,
        conn_id: &str,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/connections/{conn_id}",
            self.base_url
        );
        self.delete_json(&url).await
    }

    /// Test a connection.
    pub async fn test_connection(
        &self,
        workspace_id: &str,
        conn_id: &str,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/connections/{conn_id}/test",
            self.base_url
        );
        self.post_json(&url, &serde_json::json!({})).await
    }

    /// Discover remote tables for a connection.
    pub async fn discover_tables(
        &self,
        workspace_id: &str,
        conn_id: &str,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/connections/{conn_id}/tables",
            self.base_url
        );
        self.get_json(&url).await
    }

    // ── Folders (tables) ───────────────────────────────────────────────

    /// Link tables as data folders.
    pub async fn link_tables(
        &self,
        workspace_id: &str,
        connection_id: &str,
        tables: &[Value],
    ) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/folders", self.base_url);
        self.post_json(
            &url,
            &serde_json::json!({
                "connectionId": connection_id,
                "tables": tables,
            }),
        )
        .await
    }

    /// List data folders.
    pub async fn list_folders(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/folders", self.base_url);
        self.get_json(&url).await
    }

    /// Unlink a data folder.
    pub async fn unlink_folder(
        &self,
        workspace_id: &str,
        folder_id: &str,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/folders/{folder_id}",
            self.base_url
        );
        self.delete_json(&url).await
    }

    // ── Syncs ──────────────────────────────────────────────────────────

    /// Create a sync.
    pub async fn create_sync(
        &self,
        workspace_id: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/syncs", self.base_url);
        self.post_json(&url, payload).await
    }

    /// List syncs.
    pub async fn list_syncs(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/syncs", self.base_url);
        self.get_json(&url).await
    }

    /// Get a single sync.
    pub async fn get_sync(
        &self,
        workspace_id: &str,
        sync_id: &str,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/syncs/{sync_id}",
            self.base_url
        );
        self.get_json(&url).await
    }

    /// Update a sync.
    pub async fn update_sync(
        &self,
        workspace_id: &str,
        sync_id: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/syncs/{sync_id}",
            self.base_url
        );
        self.patch_json(&url, payload).await
    }

    /// Delete a sync.
    pub async fn delete_sync(
        &self,
        workspace_id: &str,
        sync_id: &str,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/syncs/{sync_id}",
            self.base_url
        );
        self.delete_json(&url).await
    }

    /// Run a sync mapping.
    pub async fn run_sync(&self, workspace_id: &str, sync_id: &str) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/syncs/{sync_id}/run",
            self.base_url
        );
        self.post_json(&url, &serde_json::json!({})).await
    }

    // ── Pull / Push / Publish ──────────────────────────────────────────

    /// Pull changes from remote for a workspace.
    pub async fn pull(
        &self,
        workspace_id: &str,
        connection_id: Option<&str>,
    ) -> Result<Value, String> {
        let mut url = format!("{}/api/workspaces/{workspace_id}/pull", self.base_url);
        if let Some(conn) = connection_id {
            url = format!("{url}?connection_id={conn}");
        }
        self.post_json(&url, &serde_json::json!({})).await
    }

    /// Push local files to the server's git layer.
    pub async fn push_files(
        &self,
        workspace_id: &str,
        files: &[Value],
    ) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/push", self.base_url);
        self.post_json(&url, &serde_json::json!({"files": files}))
            .await
    }

    /// Download all files from the server for local storage.
    pub async fn download_files(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/download", self.base_url);
        self.get_json(&url).await
    }

    /// Download files from the main (published) branch for baseline comparison.
    pub async fn download_baseline(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!(
            "{}/api/workspaces/{workspace_id}/download?branch=main",
            self.base_url
        );
        self.get_json(&url).await
    }

    /// Run a publish operation.
    pub async fn run_publish(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/publish", self.base_url);
        self.post_json(&url, &serde_json::json!({})).await
    }

    /// Get workspace status.
    pub async fn get_status(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/status", self.base_url);
        self.get_json(&url).await
    }

    /// Get dirty files (changes).
    pub async fn get_changes(&self, workspace_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/workspaces/{workspace_id}/changes", self.base_url);
        self.get_json(&url).await
    }

    /// Poll a job until it completes. Returns the final job status.
    pub async fn poll_job(&self, job_id: &str) -> Result<Value, String> {
        let url = format!("{}/api/jobs/{job_id}", self.base_url);
        loop {
            let result = self.get_json(&url).await?;
            let status = result
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");

            match status {
                "completed" | "failed" | "error" => return Ok(result),
                _ => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────

    fn apply_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(ref token) = self.auth_token {
            builder.bearer_auth(token)
        } else {
            builder
        }
    }

    async fn get_json(&self, url: &str) -> Result<Value, String> {
        let resp = self
            .apply_auth(self.client.get(url))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {e}"))?;

        if !status.is_success() {
            return Err(format!("API returned {status}: {body}"));
        }

        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response JSON: {e}"))
    }

    async fn post_json(&self, url: &str, body: &Value) -> Result<Value, String> {
        let resp = self
            .apply_auth(self.client.post(url).json(body))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        let response_body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {e}"))?;

        if !status.is_success() {
            return Err(format!("API returned {status}: {response_body}"));
        }

        serde_json::from_str(&response_body)
            .map_err(|e| format!("Failed to parse response JSON: {e}"))
    }

    async fn patch_json(&self, url: &str, body: &Value) -> Result<Value, String> {
        let resp = self
            .apply_auth(self.client.patch(url).json(body))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        let response_body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {e}"))?;

        if !status.is_success() {
            return Err(format!("API returned {status}: {response_body}"));
        }

        serde_json::from_str(&response_body)
            .map_err(|e| format!("Failed to parse response JSON: {e}"))
    }

    async fn delete_json(&self, url: &str) -> Result<Value, String> {
        let resp = self
            .apply_auth(self.client.delete(url))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        let response_body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {e}"))?;

        if !status.is_success() {
            return Err(format!("API returned {status}: {response_body}"));
        }

        serde_json::from_str(&response_body)
            .map_err(|e| format!("Failed to parse response JSON: {e}"))
    }
}
