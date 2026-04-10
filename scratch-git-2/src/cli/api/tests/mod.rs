use super::{job_progress_path, ApiClient, JobProgress, Workbook};
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
