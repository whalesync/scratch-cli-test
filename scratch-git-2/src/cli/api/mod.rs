use reqwest::{Client, Method, StatusCode};
use serde::{de::DeserializeOwned, Serialize};
use thiserror::Error;

/// Default server URL. Override at build time by setting SCRATCH_DEFAULT_URL env var.
/// The release scripts set this to https://api.scratch.md (prod) or https://test-api.scratch.md (test).
pub const DEFAULT_SERVER_URL: &str = match option_env!("SCRATCH_DEFAULT_URL") {
    Some(url) => url,
    None => "http://localhost:3010",
};

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("Not authenticated. Run `scratchmd auth login` first.")]
    Unauthorized,
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Server error ({status}): {body}")]
    ServerError { status: u16, body: String },
    #[error("Request failed: {0}")]
    Network(#[from] reqwest::Error),
    #[error("{0}")]
    Other(String),
}

pub type ApiResult<T> = Result<T, ApiError>;

pub struct ApiClient {
    client: Client,
    base_url: String,
    token: String,
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: format!("{}/cli/v1", base_url.into().trim_end_matches('/')),
            token: token.into(),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Build from credentials. Returns None if not logged in for the given server.
    pub fn from_credentials(server_url: &str) -> Option<Self> {
        let creds = crate::config::credentials::get(server_url)?;
        if creds.api_token.is_empty() {
            return None;
        }
        Some(Self::new(server_url, creds.api_token))
    }

    /// Build an authenticated request with standard headers.
    /// Sets Content-Length: 0 when no body is provided — required by GCP load balancers.
    fn build_request<B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> reqwest::RequestBuilder {
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let mut req = self
            .client
            .request(method, &url)
            .header("Authorization", format!("API-Token {}", self.token))
            .header("User-Agent", "Scratch-cli/1.0");

        if let Some(b) = body {
            req = req.json(b);
        } else {
            req = req.header("Content-Length", "0");
        }
        req
    }

    /// Send a request and parse the JSON response.
    async fn do_request<B, R>(&self, method: Method, path: &str, body: Option<&B>) -> ApiResult<R>
    where
        B: Serialize,
        R: DeserializeOwned,
    {
        let resp = self.build_request(method, path, body).send().await?;
        let resp = Self::check_response(resp).await?;
        let data = resp.json::<R>().await?;
        Ok(data)
    }

    /// Send a request discarding the response body (handles 200/204).
    async fn do_request_void(&self, method: Method, path: &str) -> ApiResult<()> {
        let resp = self.build_request::<()>(method, path, None).send().await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    /// Check response status, returning the response on success or an error on failure.
    async fn check_response(resp: reqwest::Response) -> ApiResult<reqwest::Response> {
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthorized);
        }
        if status == StatusCode::NOT_FOUND {
            return Err(ApiError::NotFound(resp.url().path().to_string()));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::ServerError {
                status: status.as_u16(),
                body,
            });
        }
        Ok(resp)
    }

    pub async fn get<R: DeserializeOwned>(&self, path: &str) -> ApiResult<R> {
        self.do_request::<(), R>(Method::GET, path, None).await
    }

    pub async fn get_query<R: DeserializeOwned>(&self, path: &str, query: &str) -> ApiResult<R> {
        let full = format!("{}?{}", path, query);
        self.do_request::<(), R>(Method::GET, &full, None).await
    }

    pub async fn post<B: Serialize, R: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> ApiResult<R> {
        self.do_request(Method::POST, path, Some(body)).await
    }

    pub async fn post_no_body<R: DeserializeOwned>(&self, path: &str) -> ApiResult<R> {
        self.do_request::<(), R>(Method::POST, path, None).await
    }

    pub async fn patch<B: Serialize, R: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> ApiResult<R> {
        self.do_request(Method::PATCH, path, Some(body)).await
    }

    pub async fn delete<R: DeserializeOwned>(&self, path: &str) -> ApiResult<R> {
        self.do_request::<(), R>(Method::DELETE, path, None).await
    }

    pub async fn delete_void(&self, path: &str) -> ApiResult<()> {
        self.do_request_void(Method::DELETE, path).await
    }

    // ── Auth endpoints (no token needed) ───────────────────────────────────

    /// Build an unauthenticated request with standard headers.
    /// Sets Content-Length: 0 when no body is provided — required by GCP load balancers.
    fn build_unauthed_request<B: Serialize>(
        client: &Client,
        method: Method,
        url: &str,
        body: Option<&B>,
    ) -> reqwest::RequestBuilder {
        let mut req = client
            .request(method, url)
            .header("User-Agent", "Scratch-cli/1.0");

        if let Some(b) = body {
            req = req.json(b);
        } else {
            req = req.header("Content-Length", "0");
        }
        req
    }

    pub async fn auth_initiate(base_url: &str) -> ApiResult<AuthInitiateResponse> {
        let client = Client::new();
        let url = format!("{}/cli/v1/auth/initiate", base_url.trim_end_matches('/'));
        let resp = Self::build_unauthed_request::<()>(&client, Method::POST, &url, None)
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        Ok(resp.json().await?)
    }

    pub async fn auth_poll(base_url: &str, polling_code: &str) -> ApiResult<AuthPollResponse> {
        let client = Client::new();
        let url = format!("{}/cli/v1/auth/poll", base_url.trim_end_matches('/'));
        let body = serde_json::json!({ "pollingCode": polling_code });
        let resp = Self::build_unauthed_request(&client, Method::POST, &url, Some(&body))
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        Ok(resp.json().await?)
    }
}

// ── Auth response types ─────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct AuthInitiateResponse {
    #[serde(rename = "userCode", default)]
    pub user_code: String,
    #[serde(rename = "pollingCode", default)]
    pub polling_code: String,
    #[serde(rename = "verificationUrl", default)]
    pub verification_url: String,
    #[serde(rename = "expiresIn", default)]
    pub expires_in: u64,
    #[serde(default)]
    pub interval: u64,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct AuthPollResponse {
    #[serde(default)]
    pub status: String,
    #[serde(rename = "apiToken", default)]
    pub api_token: String,
    #[serde(rename = "userEmail", default)]
    pub user_email: String,
    #[serde(rename = "tokenExpiresAt", default)]
    pub token_expires_at: String,
    #[serde(default)]
    pub error: String,
}

// ── Workbooks ───────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct DataFolder {
    pub id: String,
    pub name: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ConnectorAccount {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub service: String,
    #[serde(rename = "repoPath", default)]
    pub repo_path: String,
    #[serde(rename = "gitUrl", default)]
    pub git_url: String,
    #[serde(rename = "dataFolders", default)]
    pub data_folders: Vec<DataFolder>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct Workbook {
    pub id: String,
    pub name: String,
    #[serde(rename = "orgId", default)]
    pub org_id: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
    #[serde(rename = "tableCount", default)]
    pub table_count: i32,
    #[serde(default)]
    pub version: i32,
    #[serde(rename = "connectorAccounts", default)]
    pub connector_accounts: Vec<ConnectorAccount>,
    #[serde(rename = "gitUrl", alias = "configGitUrl", default)]
    pub git_url: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct WorkbookListResponse {
    pub workbooks: Vec<Workbook>,
}

#[cfg(test)]
#[path = "tests/mod.rs"]
mod tests;

// ── Jobs ────────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct JobProgress {
    #[serde(rename = "bullJobId", default)]
    pub bull_job_id: String,
    #[serde(rename = "dbJobId", default)]
    pub db_job_id: String,
    #[serde(default, alias = "state")]
    pub status: String,
    #[serde(rename = "failedReason", default, alias = "failed_reason")]
    pub failed_reason: Option<String>,
}

/// Response from endpoints that start a background job.
#[derive(Debug, serde::Deserialize)]
pub struct JobStartedResponse {
    #[serde(rename = "jobId")]
    pub job_id: String,
}

fn job_progress_path(job_id: &str) -> String {
    format!("jobs/{}/progress", job_id)
}

/// Poll a job until it completes or fails. Prints dots to stderr.
pub async fn poll_job(client: &ApiClient, job_id: &str) -> ApiResult<()> {
    use std::time::Duration;
    use tokio::time::sleep;

    let timeout = Duration::from_secs(30 * 60);
    let interval = Duration::from_secs(2);
    let deadline = std::time::Instant::now() + timeout;

    loop {
        let progress: JobProgress = client.get(&job_progress_path(job_id)).await?;
        match progress.status.as_str() {
            "completed" => {
                eprintln!();
                return Ok(());
            }
            "failed" => {
                eprintln!();
                return Err(ApiError::Other(format!(
                    "Job failed: {}",
                    progress
                        .failed_reason
                        .unwrap_or_else(|| "unknown failure".to_string())
                )));
            }
            "canceled" => {
                eprintln!();
                return Err(ApiError::Other("Job was canceled".to_string()));
            }
            _ => {
                eprint!(".");
                if std::time::Instant::now() > deadline {
                    eprintln!();
                    return Err(ApiError::Other(
                        "Job timed out after 30 minutes".to_string(),
                    ));
                }
                sleep(interval).await;
            }
        }
    }
}

// ── Connections ──────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct Connection {
    pub id: String,
    pub service: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "authType", default)]
    pub auth_type: String,
    #[serde(rename = "healthStatus")]
    pub health_status: Option<String>,
    #[serde(rename = "healthStatusMessage")]
    pub health_status_message: Option<String>,
    #[serde(rename = "repoPath", default, skip_serializing_if = "String::is_empty")]
    pub repo_path: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
}

#[derive(Debug, serde::Serialize)]
pub struct CreateConnectionRequest {
    pub service: String,
    #[serde(rename = "displayName", skip_serializing_if = "str::is_empty")]
    pub display_name: String,
    #[serde(rename = "userProvidedParams")]
    pub user_provided_params: std::collections::HashMap<String, String>,
}

impl ApiClient {
    pub async fn list_connections(&self, workbook_id: &str) -> ApiResult<Vec<Connection>> {
        self.get(&format!("workbooks/{}/connections", workbook_id))
            .await
    }

    pub async fn get_connection(&self, workbook_id: &str, id: &str) -> ApiResult<Connection> {
        self.get(&format!("workbooks/{}/connections/{}", workbook_id, id))
            .await
    }

    pub async fn create_connection(
        &self,
        workbook_id: &str,
        req: &CreateConnectionRequest,
    ) -> ApiResult<Connection> {
        self.post(&format!("workbooks/{}/connections", workbook_id), req)
            .await
    }

    pub async fn delete_connection(&self, workbook_id: &str, id: &str) -> ApiResult<()> {
        self.delete_void(&format!("workbooks/{}/connections/{}", workbook_id, id))
            .await
    }
}

// ── Linked tables ────────────────────────────────────────────────────────────

/// Table ID from a connector — may be a plain string or a structured object.
/// Stored as a comma-joined string (e.g. "siteId,collectionId").
#[derive(Debug, Clone, serde::Serialize)]
pub struct TablePreviewId(pub String);

impl TablePreviewId {
    #[allow(dead_code)]
    pub fn parts(&self) -> Vec<String> {
        self.0.split(',').map(|s| s.to_string()).collect()
    }
}

impl std::fmt::Display for TablePreviewId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<'de> serde::Deserialize<'de> for TablePreviewId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let v = serde_json::Value::deserialize(d)?;
        match &v {
            serde_json::Value::String(s) => Ok(TablePreviewId(s.clone())),
            serde_json::Value::Object(obj) => {
                if let Some(serde_json::Value::Array(arr)) = obj.get("remoteId") {
                    let parts: Vec<String> = arr
                        .iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect();
                    return Ok(TablePreviewId(parts.join(",")));
                }
                Err(D::Error::custom("cannot parse TablePreviewId"))
            }
            _ => Err(D::Error::custom("cannot parse TablePreviewId")),
        }
    }
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct TablePreview {
    pub id: TablePreviewId,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "disabledCreates", default)]
    pub disabled_creates: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct TableList {
    #[serde(default)]
    pub tables: Vec<TablePreview>,
    #[serde(rename = "discoveryMode", default)]
    pub discovery_mode: String,
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct TableSearchResult {
    #[serde(default)]
    pub tables: Vec<TablePreview>,
    #[serde(rename = "hasMore", default)]
    pub has_more: bool,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct LinkedTable {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
    #[serde(rename = "workbookId", default)]
    pub workbook_id: String,
    #[serde(rename = "connectorAccountId")]
    pub connector_account_id: Option<String>,
    #[serde(rename = "connectorDisplayName")]
    pub connector_display_name: Option<String>,
    #[serde(rename = "connectorService")]
    pub connector_service: Option<String>,
    #[serde(rename = "lastSyncTime")]
    pub last_sync_time: Option<String>,
    pub lock: Option<String>,
    pub path: Option<String>,
    #[serde(rename = "tableId", default)]
    pub table_id: Vec<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct LinkedTableGroup {
    pub name: String,
    pub service: Option<String>,
    #[serde(rename = "dataFolders", default)]
    pub data_folders: Vec<LinkedTable>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct LinkedTableDetail {
    #[serde(flatten)]
    pub table: LinkedTable,
    #[serde(default)]
    pub creates: i32,
    #[serde(default)]
    pub updates: i32,
    #[serde(default)]
    pub deletes: i32,
    #[serde(rename = "hasChanges", default)]
    pub has_changes: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct CreateLinkedTableRequest {
    pub name: String,
    #[serde(rename = "connectorAccountId")]
    pub connector_account_id: String,
    #[serde(rename = "tableId")]
    pub table_id: Vec<String>,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub filter: String,
}

impl ApiClient {
    pub async fn list_connection_tables(
        &self,
        workbook_id: &str,
        connection_id: &str,
    ) -> ApiResult<TableList> {
        self.get(&format!(
            "workbooks/{}/connections/{}/tables",
            workbook_id, connection_id
        ))
        .await
    }

    #[allow(dead_code)]
    pub async fn search_connection_tables(
        &self,
        workbook_id: &str,
        connection_id: &str,
        search_term: &str,
    ) -> ApiResult<TableSearchResult> {
        let encoded = urlencoding::encode(search_term);
        self.get_query(
            &format!(
                "workbooks/{}/connections/{}/tables/search",
                workbook_id, connection_id
            ),
            &format!("searchTerm={}", encoded),
        )
        .await
    }

    pub async fn list_linked_tables(&self, workbook_id: &str) -> ApiResult<Vec<LinkedTableGroup>> {
        self.get(&format!("workbooks/{}/linked", workbook_id)).await
    }

    pub async fn get_linked_table(
        &self,
        workbook_id: &str,
        folder_id: &str,
    ) -> ApiResult<LinkedTableDetail> {
        self.get(&format!("workbooks/{}/linked/{}", workbook_id, folder_id))
            .await
    }

    pub async fn create_linked_table(
        &self,
        workbook_id: &str,
        req: &CreateLinkedTableRequest,
    ) -> ApiResult<LinkedTable> {
        self.post(&format!("workbooks/{}/linked", workbook_id), req)
            .await
    }

    pub async fn delete_linked_table(&self, workbook_id: &str, folder_id: &str) -> ApiResult<()> {
        self.delete_void(&format!("workbooks/{}/linked/{}", workbook_id, folder_id))
            .await
    }

    pub async fn pull_linked_table(
        &self,
        workbook_id: &str,
        folder_id: &str,
    ) -> ApiResult<JobStartedResponse> {
        self.post_no_body(&format!(
            "workbooks/{}/linked/{}/pull",
            workbook_id, folder_id
        ))
        .await
    }

    pub async fn pull_linked_table_files(
        &self,
        workbook_id: &str,
        folder_id: &str,
        file_paths: &[String],
    ) -> ApiResult<JobStartedResponse> {
        let body = serde_json::json!({ "filePaths": file_paths });
        self.post(
            &format!("workbooks/{}/linked/{}/pull-files", workbook_id, folder_id),
            &body,
        )
        .await
    }

    pub async fn publish_linked_table(
        &self,
        workbook_id: &str,
        folder_id: &str,
    ) -> ApiResult<JobStartedResponse> {
        self.post_no_body(&format!(
            "workbooks/{}/linked/{}/publish",
            workbook_id, folder_id
        ))
        .await
    }

    pub async fn publish_from_git(
        &self,
        workbook_id: &str,
        connector_account_id: &str,
        plan_path: &str,
    ) -> ApiResult<serde_json::Value> {
        self.post(
            &format!("workbooks/{}/publish-v2/run-from-git", workbook_id),
            &serde_json::json!({
                "connectorAccountId": connector_account_id,
                "planPath": plan_path,
            }),
        )
        .await
    }
}

// ── Syncs ────────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct SyncTablePair {
    pub id: String,
    #[serde(rename = "syncId", default)]
    pub sync_id: String,
    #[serde(rename = "sourceDataFolderId", default)]
    pub source_data_folder_id: String,
    #[serde(rename = "destinationDataFolderId", default)]
    pub destination_data_folder_id: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct Sync {
    pub id: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(rename = "syncState", default)]
    pub sync_state: String,
    #[serde(rename = "lastSyncTime")]
    pub last_sync_time: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
    #[serde(rename = "syncTablePairs", default)]
    pub sync_table_pairs: Vec<SyncTablePair>,
    pub mappings: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct RunSyncResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(rename = "jobId", default)]
    pub job_id: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ExportSyncConfig {
    pub id: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    pub mappings: Option<serde_json::Value>,
    #[serde(rename = "validateMappings", default)]
    pub validate_mappings: bool,
    #[serde(default)]
    pub schedule: String,
    #[serde(rename = "publishAfterSync", default)]
    pub publish_after_sync: bool,
}

impl ApiClient {
    pub async fn list_syncs(&self, workbook_id: &str) -> ApiResult<Vec<Sync>> {
        self.get(&format!("workbooks/{}/syncs", workbook_id)).await
    }

    pub async fn get_sync(&self, workbook_id: &str, sync_id: &str) -> ApiResult<Sync> {
        self.get(&format!("workbooks/{}/syncs/{}", workbook_id, sync_id))
            .await
    }

    pub async fn get_sync_raw(
        &self,
        workbook_id: &str,
        sync_id: &str,
    ) -> ApiResult<serde_json::Value> {
        self.get(&format!("workbooks/{}/syncs/{}", workbook_id, sync_id))
            .await
    }

    pub async fn create_sync(
        &self,
        workbook_id: &str,
        body: &serde_json::Value,
    ) -> ApiResult<Sync> {
        self.post(&format!("workbooks/{}/syncs", workbook_id), body)
            .await
    }

    pub async fn update_sync(
        &self,
        workbook_id: &str,
        sync_id: &str,
        body: &serde_json::Value,
    ) -> ApiResult<Sync> {
        self.patch(
            &format!("workbooks/{}/syncs/{}", workbook_id, sync_id),
            body,
        )
        .await
    }

    pub async fn delete_sync(&self, workbook_id: &str, sync_id: &str) -> ApiResult<()> {
        self.delete_void(&format!("workbooks/{}/syncs/{}", workbook_id, sync_id))
            .await
    }

    pub async fn run_sync(&self, workbook_id: &str, sync_id: &str) -> ApiResult<RunSyncResponse> {
        self.post_no_body(&format!("workbooks/{}/syncs/{}/run", workbook_id, sync_id))
            .await
    }

    pub async fn export_syncs(&self, workbook_id: &str) -> ApiResult<Vec<ExportSyncConfig>> {
        self.get(&format!("workbooks/{}/syncs/export", workbook_id))
            .await
    }

    pub async fn export_sync(
        &self,
        workbook_id: &str,
        sync_id: &str,
    ) -> ApiResult<Vec<ExportSyncConfig>> {
        let encoded = urlencoding::encode(sync_id);
        self.get_query(
            &format!("workbooks/{}/syncs/export", workbook_id),
            &format!("syncId={}", encoded),
        )
        .await
    }
}
