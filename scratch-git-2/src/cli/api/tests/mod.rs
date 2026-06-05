use super::{
    job_progress_path, ApiClient, BlockedDirtyResponse, BlockedStaleResponse, CheckFailedResponse,
    JobProgress, UploadPatchCommitResponse, Workbook,
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
    // No publicProgress in this shape — the dirty-head accessor stays None.
    assert!(progress
        .public_progress
        .and_then(|p| p.dirty_head)
        .is_none());
}

#[test]
fn job_progress_reads_apply_patches_dirty_head_off_public_progress() {
    // DEV-10316: the desktop reads the post-apply dirty HEAD off the completed
    // apply-patches job's `publicProgress.dirtyHead` to use as the publish-time
    // TOCTOU token. Lock down that the CLI's JobProgress deserializes it.
    let progress: JobProgress = serde_json::from_value(serde_json::json!({
        "state": "completed",
        "publicProgress": {
            "status": "completed",
            "uploadId": "up_1",
            "patchCount": 3,
            "processedCount": 3,
            "dirtyHead": "abc123def456"
        }
    }))
    .unwrap();

    assert_eq!(progress.status, "completed");
    assert_eq!(
        progress.public_progress.and_then(|p| p.dirty_head),
        Some("abc123def456".to_string())
    );
}

#[test]
fn job_progress_dirty_head_absent_when_public_progress_omits_it() {
    // A running/non-apply job has no dirtyHead — accessor must yield None
    // (rather than panic) so the upload path leaves the token unset.
    let progress: JobProgress = serde_json::from_value(serde_json::json!({
        "state": "active",
        "publicProgress": { "status": "running", "uploadId": "up_1", "patchCount": 3, "processedCount": 1 }
    }))
    .unwrap();

    assert!(progress
        .public_progress
        .and_then(|p| p.dirty_head)
        .is_none());
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

// DEV-10316: locks down the wire-shape contract for the dirty gate. The server
// throws `ConflictException(payload)` → `{ statusCode: 409, ...payload }`; the
// CLI parses `status` + the count-only fields strictly.
#[test]
fn blocked_dirty_response_deserializes_from_nest_conflict_body() {
    let body = serde_json::json!({
        "statusCode": 409,
        "status": "blocked_dirty",
        "connectorAccountId": "ca_conn1",
        "dirtyCount": 47,
        "message": "This connection has unpublished changes on the server."
    });
    let parsed: BlockedDirtyResponse = serde_json::from_value(body).unwrap();
    assert_eq!(parsed.status, "blocked_dirty");
    assert_eq!(parsed.connector_account_id, "ca_conn1");
    assert_eq!(parsed.dirty_count, 47);
    assert!(parsed.message.unwrap().contains("unpublished"));
}

// The dirty-gate parse must be structurally distinguishable from blocked_stale
// so the 409 discriminator in `upload_patch_commit` can't confuse them: a
// blocked_stale body (no `dirtyCount`) must NOT deserialize as BlockedDirty.
#[test]
fn blocked_stale_body_does_not_parse_as_blocked_dirty() {
    let stale_body = serde_json::json!({
        "status": "blocked_stale",
        "currentRemoteHead": "cccccccccccccccccccccccccccccccccccccccc"
    });
    assert!(serde_json::from_value::<BlockedDirtyResponse>(stale_body).is_err());
}

// DEV-10316 fail-closed: `ServiceUnavailableException(payload)` → 503 body.
#[test]
fn check_failed_response_deserializes_from_nest_service_unavailable_body() {
    let body = serde_json::json!({
        "statusCode": 503,
        "status": "check_failed",
        "connectorAccountId": "ca_conn1",
        "message": "Couldn't verify the server's state. Try again."
    });
    let parsed: CheckFailedResponse = serde_json::from_value(body).unwrap();
    assert_eq!(parsed.status, "check_failed");
    assert_eq!(parsed.connector_account_id, "ca_conn1");
    assert!(parsed.message.unwrap().contains("Try again"));
}
