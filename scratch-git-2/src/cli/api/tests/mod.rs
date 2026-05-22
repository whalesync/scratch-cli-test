use super::{
    job_progress_path, ApiClient, BlockedStaleResponse, JobProgress, UploadPatchCommitResponse,
    Workbook,
};
use reqwest::{Client, Method};

#[test]
fn workbook_deserializes_config_git_url_alias() {
    let workbook: Workbook = serde_json::from_value(serde_json::json!({
        "id": "wkb_1",
        "name": "Test",
        "orgId": "org_1",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "tableCount": 0,
        "version": 2,
        "connectorAccounts": [],
        "configGitUrl": "http://localhost:3010/cli/v1/workbooks/wkb_1/config/git"
    }))
    .unwrap();

    assert_eq!(
        workbook.git_url,
        "http://localhost:3010/cli/v1/workbooks/wkb_1/config/git"
    );
}

#[test]
fn job_progress_path_uses_progress_endpoint() {
    assert_eq!(job_progress_path("job_123"), "jobs/job_123/progress");
}

#[test]
fn job_progress_deserializes_null_failed_reason() {
    let progress: JobProgress = serde_json::from_value(serde_json::json!({
        "bullJobId": "job_123",
        "dbJobId": "db_123",
        "state": "completed",
        "failedReason": null
    }))
    .unwrap();

    assert_eq!(progress.bull_job_id, "job_123");
    assert_eq!(progress.db_job_id, "db_123");
    assert_eq!(progress.status, "completed");
    assert_eq!(progress.failed_reason, None);
}

#[test]
fn build_request_sets_content_length_zero_when_no_body() {
    let client = ApiClient::new("http://localhost:3010", "test-token");
    let req = client
        .build_request::<()>(Method::POST, "test", None)
        .build()
        .unwrap();
    assert_eq!(req.headers().get("Content-Length").unwrap(), "0");
}

#[test]
fn build_request_does_not_set_zero_content_length_when_body_present() {
    let client = ApiClient::new("http://localhost:3010", "test-token");
    let body = serde_json::json!({"key": "value"});
    let req = client
        .build_request(Method::POST, "test", Some(&body))
        .build()
        .unwrap();
    // reqwest sets Content-Length at send time for json bodies, so it won't be in headers yet.
    // The key invariant: we must NOT have explicitly set it to "0".
    assert_ne!(
        req.headers()
            .get("Content-Length")
            .map(|v| v.to_str().unwrap()),
        Some("0")
    );
}

#[test]
fn build_unauthed_request_sets_content_length_zero_when_no_body() {
    let client = Client::new();
    let req = ApiClient::build_unauthed_request::<()>(
        &client,
        Method::POST,
        "http://localhost:3010/test",
        None,
    )
    .build()
    .unwrap();
    assert_eq!(req.headers().get("Content-Length").unwrap(), "0");
}

#[test]
fn build_unauthed_request_does_not_set_zero_content_length_when_body_present() {
    let client = Client::new();
    let body = serde_json::json!({"key": "value"});
    let req = ApiClient::build_unauthed_request(
        &client,
        Method::POST,
        "http://localhost:3010/test",
        Some(&body),
    )
    .build()
    .unwrap();
    assert_ne!(
        req.headers()
            .get("Content-Length")
            .map(|v| v.to_str().unwrap()),
        Some("0")
    );
}

// D8: locks down the wire-shape contract for the staleness gate. The server
// throws a NestJS `ConflictException(payload)` which serializes as
// `{ statusCode: 409, ...payload }`; the CLI must parse `status` strictly to
// distinguish blocked_stale from arbitrary 409s.
#[test]
fn blocked_stale_response_deserializes_from_nest_conflict_body() {
    let body = serde_json::json!({
        "statusCode": 409,
        "status": "blocked_stale",
        "baseHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "currentRemoteHead": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "message": "Server `main` has advanced past your local `main`."
    });
    let parsed: BlockedStaleResponse = serde_json::from_value(body).unwrap();
    assert_eq!(parsed.status, "blocked_stale");
    assert_eq!(
        parsed.base_head.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(
        parsed.current_remote_head,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert!(parsed.message.unwrap().contains("main"));
}

#[test]
fn blocked_stale_response_tolerates_missing_base_head() {
    // The client may not have a local main yet (fresh workspace, never
    // pulled). Server still echoes back `baseHead: undefined` rather than
    // erroring; we deserialize it as `None`.
    let body = serde_json::json!({
        "status": "blocked_stale",
        "currentRemoteHead": "cccccccccccccccccccccccccccccccccccccccc"
    });
    let parsed: BlockedStaleResponse = serde_json::from_value(body).unwrap();
    assert_eq!(parsed.base_head, None);
    assert_eq!(parsed.message, None);
}

#[test]
fn upload_patch_commit_response_omits_staleness_warning_on_match() {
    let body = serde_json::json!({ "jobId": "job_1" });
    let parsed: UploadPatchCommitResponse = serde_json::from_value(body).unwrap();
    assert_eq!(parsed.job_id.as_deref(), Some("job_1"));
    assert!(parsed.staleness_warning.is_none());
}
