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

    pub async fn post_void<B: Serialize>(&self, path: &str, body: &B) -> ApiResult<()> {
        let resp = self
            .build_request(Method::POST, path, Some(body))
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
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

    // ── Routines ────────────────────────────────────────────────────────────

    /// Push routine files (`scratchmd routines push`). Posts upserts + deletes to the server,
    /// which commits them to the workbook config repo `main` and reloads routines. Discriminates
    /// the `409 blocked_stale` optimistic-concurrency response so the caller can prompt a
    /// `routines pull` + retry rather than surface a raw server error.
    pub async fn routines_push(
        &self,
        workbook_id: &str,
        request: &RoutinesPushRequest,
    ) -> ApiResult<RoutinesPushOutcome> {
        let path = format!("workbooks/{}/routines/push", workbook_id);
        match self.post::<_, RoutinesPushResponse>(&path, request).await {
            Ok(response) => Ok(RoutinesPushOutcome::Pushed(response)),
            Err(ApiError::ServerError { status: 409, body }) => {
                match serde_json::from_str::<RoutinesPushBlockedStale>(&body) {
                    Ok(stale) if stale.status == "blocked_stale" => {
                        Ok(RoutinesPushOutcome::BlockedStale(stale))
                    }
                    // A 409 that isn't the structured stale envelope is a genuine error.
                    _ => Err(ApiError::ServerError { status: 409, body }),
                }
            }
            Err(other) => Err(other),
        }
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

// ── Routines push types ──────────────────────────────────────────────────────

/// A single routine file to create or overwrite.
#[derive(Debug, Serialize)]
pub struct RoutineUpsert {
    pub path: String,
    pub content: String,
}

/// Request body for `POST /cli/v1/workbooks/:id/routines/push`. `base_head` is the client's local
/// config-repo `main` SHA; omitted (`None`) skips the server's optimistic-concurrency guard.
#[derive(Debug, Serialize)]
pub struct RoutinesPushRequest {
    pub upserts: Vec<RoutineUpsert>,
    pub deletes: Vec<String>,
    #[serde(rename = "baseHead", skip_serializing_if = "Option::is_none")]
    pub base_head: Option<String>,
}

/// Success response: the new `main` SHA and the reconciled routines (kept opaque — the CLI only
/// needs the count).
#[derive(Debug, serde::Deserialize)]
pub struct RoutinesPushResponse {
    #[serde(default)]
    pub head: String,
    #[serde(default)]
    pub routines: Vec<serde_json::Value>,
}

/// The `409 blocked_stale` envelope: `main` advanced past the client's `base_head`.
#[derive(Debug, serde::Deserialize)]
pub struct RoutinesPushBlockedStale {
    #[serde(default)]
    pub status: String,
    #[serde(rename = "currentRemoteHead", default)]
    pub current_remote_head: String,
    #[serde(default)]
    pub message: String,
}

/// Outcome of a routines push: applied, or refused because the local copy is stale.
#[derive(Debug)]
pub enum RoutinesPushOutcome {
    Pushed(RoutinesPushResponse),
    BlockedStale(RoutinesPushBlockedStale),
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
    #[serde(default)]
    pub path: Option<String>,
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
    /// The connector account's on-disk folder *structure* version
    /// (`ConnectorAccount.version` server-side). Recorded in the workspace
    /// marker at `init` and compared against the server's current value on
    /// download to detect a server-side folder restructure (DEV-9698) that
    /// leaves the local clone stale. Defaults to `0` ("unknown") when an older
    /// server omits it — detection treats `0` as "not recorded" and never fires.
    #[serde(default)]
    pub version: i32,
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
    /// UI-facing job progress payload. DEV-10316 reads `dirtyHead` off the
    /// completed apply-patches job here to use as the publish-time TOCTOU token.
    #[serde(rename = "publicProgress", default)]
    pub public_progress: Option<JobPublicProgress>,
}

/// Subset of a job's `publicProgress` the CLI cares about.
#[derive(Debug, Default, serde::Deserialize)]
#[allow(dead_code)]
pub struct JobPublicProgress {
    /// DEV-10316: dirty-branch HEAD after an apply-patches job landed. Surfaced
    /// to the desktop so it can carry it to `/publish-v2/plan-job` as
    /// `expectedBaseDirtyHead`. Absent on non-apply jobs / while running.
    #[serde(rename = "dirtyHead", default)]
    pub dirty_head: Option<String>,
    /// DEV-10243: number of operations the destination connector rejected during
    /// a publish run-job (rows the server marked `failed-batch`). The job itself
    /// still ends `completed`, so this is the only signal that some rows didn't
    /// land. `0`/absent on jobs that had no per-row failures.
    #[serde(rename = "failedCount", default)]
    pub failed_count: u64,
    /// Per-record connector rejections from a publish run-job (the server's
    /// `failedOperations`), each carrying the connector's own user-facing
    /// message so the CLI can show *why* a record failed (e.g. Pipedrive's
    /// "'person_id' is a read-only field…"), not just `failedCount`. Bounded
    /// server-side; `[]`/absent on jobs that had no per-row failures.
    #[serde(rename = "failedOperations", default)]
    pub failed_operations: Vec<JobFailedOperation>,
}

/// One record the destination connector rejected during a publish run-job.
/// Mirrors `@spinner/shared-types`' `PublishFailedOperation` — an entry of the
/// server's `failedOperations` on the run-job's terminal `publicProgress`.
/// Keep this struct's fields in sync with that shared type.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[allow(dead_code)]
pub struct JobFailedOperation {
    #[serde(rename = "filePath", default)]
    pub file_path: String,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub error: Option<String>,
    /// Per-field connector rejection messages keyed by RFC 6902 JSON Pointer
    /// (e.g. `/Organization`). Mirrors `PublishFailedOperation.fieldErrors`.
    /// Absent/`null` when only a record-level `error` is available. Moved into
    /// the matching `failed-patches.json` entry during the post-publish reconcile
    /// to drive the per-field "this field failed to publish" warning.
    #[serde(rename = "fieldErrors", default)]
    pub field_errors: Option<std::collections::BTreeMap<String, String>>,
}

/// Response from endpoints that start a background job.
#[derive(Debug, serde::Deserialize)]
pub struct JobStartedResponse {
    #[serde(rename = "jobId")]
    pub job_id: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct PullAllLinkedTablesResponse {
    #[serde(rename = "jobId", default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(rename = "jobIds", default)]
    pub job_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

fn job_progress_path(job_id: &str) -> String {
    format!("jobs/{}/progress", job_id)
}

/// Poll a job until it completes or fails. Prints dots to stderr. Returns the
/// final `JobProgress` on success so callers can read the terminal
/// `publicProgress` (e.g. DEV-10316's `dirtyHead` off an apply-patches job).
pub async fn poll_job(client: &ApiClient, job_id: &str) -> ApiResult<JobProgress> {
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
                return Ok(progress);
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
        mode: &str,
    ) -> ApiResult<JobStartedResponse> {
        let body = serde_json::json!({ "mode": mode });
        self.post(
            &format!("workbooks/{}/linked/{}/pull", workbook_id, folder_id),
            &body,
        )
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

    pub async fn pull_all_linked_tables(
        &self,
        workbook_id: &str,
        mode: &str,
    ) -> ApiResult<PullAllLinkedTablesResponse> {
        let body = serde_json::json!({ "mode": mode });
        self.post(&format!("workbooks/{}/linked/pull-all", workbook_id), &body)
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

    /// Step 1 of publish: build a publish plan from the server's current
    /// dirty-vs-main diff for one connector. Returns `{ jobId: null,
    /// pipelineId: null }` when there's nothing to publish. Otherwise the
    /// caller polls `jobId` then calls `publish_plan_run` with `pipelineId`.
    /// `runAfterPlan` is intentionally `false` — the split publish flow does
    /// plan and run as separate explicit calls.
    pub async fn publish_plan_build(
        &self,
        workbook_id: &str,
        connector_account_id: &str,
    ) -> ApiResult<PublishPlanBuildResponse> {
        self.post(
            &format!("workbooks/{}/publish-v2/plan-job", workbook_id),
            &serde_json::json!({
                "connectorAccountId": connector_account_id,
                "runAfterPlan": false,
            }),
        )
        .await
    }

    /// Step 2 of publish: execute the pipeline created by `publish_plan_build`.
    /// Returns the run-job id to poll.
    pub async fn publish_plan_run(
        &self,
        workbook_id: &str,
        pipeline_id: &str,
    ) -> ApiResult<PublishPlanRunResponse> {
        self.post(
            &format!("workbooks/{}/publish-v2/run-job", workbook_id),
            // `publishOrigin: "desktop"` (publish redesign, DEV-10048): the CLI
            // owns a local working tree + `accepted-patches.json`, so the server
            // strips failed paths from its `dirty` branch and the failures travel
            // back here (the run-job's `failedOperations` → `failed-patches.json`).
            &serde_json::json!({ "pipelineId": pipeline_id, "publishOrigin": "desktop" }),
        )
        .await
    }

    /// Step 1 of the upload-patch flow: request a presigned GCS PUT URL.
    /// Mirrors `packages/shared-types/src/dto/upload-patch/*`. The Rust CLI
    /// re-declares the wire types in serde rather than importing from TS.
    pub async fn upload_patch_init(
        &self,
        workbook_id: &str,
        connector_account_id: &str,
    ) -> ApiResult<UploadPatchInitResponse> {
        self.post(
            &format!("workbooks/{}/upload-patch/init", workbook_id),
            &serde_json::json!({ "connectorAccountId": connector_account_id }),
        )
        .await
    }

    /// Step 3 of the upload-patch flow: tell the server the GCS upload is
    /// complete so it can enqueue the ApplyPatches worker. `base_head` is the
    /// local `main` SHA at diff time.
    ///
    /// Two staleness modes, gated on `refuse_if_stale`:
    ///   - `refuse_if_stale = true`: if server `main` ≠ `base_head`, the
    ///     server responds with HTTP 409 + a `blocked_stale` JSON body. The
    ///     job is NOT enqueued and the audit log is NOT written. Returns
    ///     `UploadPatchCommitResult::BlockedStale(_)`.
    ///   - `refuse_if_stale = false`: legacy soft-warning behavior — patches
    ///     apply anyway, and a divergence shows up in `stalenessWarning`.
    ///     Returns `UploadPatchCommitResult::Applied(_)`.
    pub async fn upload_patch_commit(
        &self,
        workbook_id: &str,
        connector_account_id: &str,
        upload_id: &str,
        base_head: Option<&str>,
        refuse_if_stale: bool,
        refuse_if_dirty: bool,
        check_only: bool,
    ) -> ApiResult<UploadPatchCommitResult> {
        let mut body = serde_json::json!({
            "uploadId": upload_id,
            "connectorAccountId": connector_account_id,
        });
        if let Some(head) = base_head {
            body["baseHead"] = serde_json::Value::String(head.to_string());
        }
        if refuse_if_stale {
            body["refuseIfStale"] = serde_json::Value::Bool(true);
        }
        if refuse_if_dirty {
            body["refuseIfDirty"] = serde_json::Value::Bool(true);
        }
        if check_only {
            body["checkOnly"] = serde_json::Value::Bool(true);
        }
        match self
            .post::<_, UploadPatchCommitResponse>(
                &format!("workbooks/{}/upload-patch/commit", workbook_id),
                &body,
            )
            .await
        {
            Ok(applied) => Ok(UploadPatchCommitResult::Applied(applied)),
            Err(ApiError::ServerError { status: 409, body }) => {
                // NestJS's `ConflictException(payload)` serializes as
                // `{ statusCode: 409, ...payload }`. Discriminate on the
                // `status` tag: `blocked_dirty` (DEV-10316 dirty gate) takes
                // precedence over `blocked_stale` (refuseIfStale) — pending
                // changes are surfaced before staleness. Anything else is an
                // unrelated 409 and propagates as an error.
                if let Ok(dirty) = serde_json::from_str::<BlockedDirtyResponse>(&body) {
                    if dirty.status == "blocked_dirty" {
                        return Ok(UploadPatchCommitResult::BlockedDirty(dirty));
                    }
                }
                if let Ok(stale) = serde_json::from_str::<BlockedStaleResponse>(&body) {
                    if stale.status == "blocked_stale" {
                        return Ok(UploadPatchCommitResult::BlockedStale(stale));
                    }
                }
                Err(ApiError::ServerError { status: 409, body })
            }
            Err(ApiError::ServerError { status: 503, body }) => {
                // Fail-closed dirty-gate check failure. NestJS's
                // `ServiceUnavailableException(payload)` serializes as
                // `{ statusCode: 503, ...payload }`. The `check_failed` tag
                // confirms it's the retryable gate-check failure and not some
                // unrelated 503.
                if let Ok(failed) = serde_json::from_str::<CheckFailedResponse>(&body) {
                    if failed.status == "check_failed" {
                        return Ok(UploadPatchCommitResult::CheckFailed(failed));
                    }
                }
                Err(ApiError::ServerError { status: 503, body })
            }
            Err(e) => Err(e),
        }
    }

    /// PUT the patch payload to a presigned GCS URL. The server pins
    /// `Content-Type: application/json` on the presigned URL signature, so the
    /// CLI MUST send exactly that header — anything else fails with a
    /// SignatureDoesNotMatch from GCS.
    pub async fn upload_patch_put(
        &self,
        presigned_url: &str,
        payload: &UploadPatchPayload,
    ) -> ApiResult<()> {
        let body = serde_json::to_vec(payload).map_err(|e| ApiError::Other(e.to_string()))?;
        let resp = self
            .client
            .put(presigned_url)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(ApiError::ServerError {
                status: status.as_u16(),
                body: format!("GCS PUT failed: {text}"),
            });
        }
        Ok(())
    }

    pub async fn discard_remote_dirty_changes(
        &self,
        workbook_id: &str,
        connector_account_id: &str,
        path: &str,
    ) -> ApiResult<()> {
        self.post_void(
            &format!(
                "workbooks/{}/connectors/{}/discard-remote-dirty-changes",
                workbook_id, connector_account_id
            ),
            &serde_json::json!({ "path": path }),
        )
        .await
    }
}

// ── Upload-patch ────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct UploadPatchInitResponse {
    #[serde(rename = "uploadId")]
    pub upload_id: String,
    #[serde(rename = "presignedUrl")]
    pub presigned_url: String,
    #[allow(dead_code)] // documents the wire contract; surfaces in logs if we ever need it
    #[serde(rename = "expiresInSeconds", default)]
    pub expires_in_seconds: u64,
}

#[derive(Debug, serde::Deserialize)]
pub struct UploadPatchCommitResponse {
    #[serde(rename = "jobId", default)]
    pub job_id: Option<String>,
    #[serde(rename = "stalenessWarning", default)]
    pub staleness_warning: Option<StalenessWarning>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct StalenessWarning {
    #[serde(rename = "newHead")]
    pub new_head: String,
}

/// Body shape of the HTTP 409 response from `/upload-patch/commit` when
/// `refuseIfStale: true` and the client's `baseHead` doesn't match the
/// server's current `refs/heads/main`. Mirrors
/// `UploadPatchBlockedStaleResponseDto` in `@spinner/shared-types`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct BlockedStaleResponse {
    /// Always `"blocked_stale"` for this response shape.
    pub status: String,
    /// The client-supplied `baseHead`. Echoed back for debug clarity.
    #[serde(rename = "baseHead", default)]
    pub base_head: Option<String>,
    /// The server's current `refs/heads/main` SHA for the connection's repo.
    #[serde(rename = "currentRemoteHead")]
    pub current_remote_head: String,
    /// Human-readable message from `ConflictException`.
    #[serde(default)]
    pub message: Option<String>,
}

/// Body shape of the HTTP 409 response from `/upload-patch/commit` when
/// `refuseIfDirty: true` and the connection's `dirty` branch holds unpublished
/// record changes vs live `refs/heads/main` (DEV-10316). Count-only. Mirrors
/// `UploadPatchBlockedDirtyResponseDto` in `@spinner/shared-types`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct BlockedDirtyResponse {
    /// Always `"blocked_dirty"` for this response shape.
    pub status: String,
    /// The connection whose staging area is not clean.
    #[serde(rename = "connectorAccountId")]
    pub connector_account_id: String,
    /// Total pending (unpublished) record changes vs live `main`. Count-only.
    #[serde(rename = "dirtyCount")]
    pub dirty_count: u64,
    /// Human-readable message from `ConflictException`.
    #[serde(default)]
    pub message: Option<String>,
}

/// Body shape of the HTTP 503 response from `/upload-patch/commit` when the
/// dirty-gate check itself could not run (the git service is down or busy).
/// Fail-closed and retryable. Mirrors `UploadPatchCheckFailedResponseDto` in
/// `@spinner/shared-types`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct CheckFailedResponse {
    /// Always `"check_failed"` for this response shape.
    pub status: String,
    /// The connection whose state could not be verified.
    #[serde(rename = "connectorAccountId")]
    pub connector_account_id: String,
    /// Human-readable message from `ServiceUnavailableException`.
    #[serde(default)]
    pub message: Option<String>,
}

/// Outcome of [`ApiClient::upload_patch_commit`]. Either the patches were
/// applied (legacy or fresh-state path), or the server refused with a
/// structured payload: `blocked_stale` (refuseIfStale strict-mode),
/// `blocked_dirty` (DEV-10316 dirty gate), or `check_failed` (the dirty-gate
/// check itself failed — retryable).
#[derive(Debug)]
pub enum UploadPatchCommitResult {
    Applied(UploadPatchCommitResponse),
    BlockedStale(BlockedStaleResponse),
    BlockedDirty(BlockedDirtyResponse),
    CheckFailed(CheckFailedResponse),
}

/// Wire format for the body uploaded to the presigned GCS PUT URL. Mirrors
/// `packages/shared-types/src/dto/upload-patch/upload-patch.dto.ts::UploadPatchPayload`.
#[derive(Debug, serde::Serialize)]
pub struct UploadPatchPayload {
    /// On-disk / wire format version (see
    /// `accepted_patches::FORMAT_VERSION`). `2` tells the server this payload is
    /// from a 6902-capable client; `Update` bodies may be RFC 6902 op arrays or
    /// legacy RFC 7396 merge patches, dispatched server-side by shape.
    pub version: u32,
    pub patches: Vec<UploadPatchEntry>,
}

#[derive(Debug, serde::Serialize)]
pub struct UploadPatchEntry {
    /// Path relative to the connection root, e.g. `Companies/rec123.json`.
    pub path: String,
    /// Record-lifecycle discriminator (`create` | `update` | `delete`). Sent
    /// explicitly so the server's whole-record delete signal is `kind == delete`
    /// rather than a magic null patch. Serializes lowercase.
    pub kind: crate::shared::re_anchor::PatchKind,
    /// The patch body. A JSON **array** is an RFC 6902 JSON Patch (`Update`,
    /// where `null` is an ordinary value); a JSON **object** is a full record
    /// (`Create`) or a legacy RFC 7396 merge patch (`Update`); `null` is a
    /// whole-record delete.
    pub patch: serde_json::Value,
    /// True when this patch was produced by `files revert-plan` reviving a
    /// previously-deleted record. The server persists this to
    /// `UploadPatchMeta` so the publish-plan-build pass4 step can null FK
    /// fields and route them through the BACKFILL phase, where they get
    /// resolved against `RecreatedIdMap` after every co-reverted record's
    /// new id has been assigned in the create phase. Without this flag the
    /// post-publish create payload carries the stale prior FK literals and
    /// the connector's FK constraint fires.
    ///
    /// `skip_serializing_if = "Clone::clone"` (which is `|b| *b == false`
    /// for bools) keeps the field absent on non-revert entries to match the
    /// server's optional shape. Use `#[serde(default, skip_serializing_if)]`
    /// to omit the field when false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub revert: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

// ── Publish-v2 (plan + run) ────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct PublishPlanBuildResponse {
    /// `null` when there's nothing to publish (server's dirty == main).
    #[serde(rename = "jobId", default)]
    pub job_id: Option<String>,
    #[serde(rename = "pipelineId", default)]
    pub pipeline_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct PublishPlanRunResponse {
    #[serde(rename = "jobId", default)]
    pub job_id: Option<String>,
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
