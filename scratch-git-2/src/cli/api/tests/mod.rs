use super::{
    is_safe_to_replay_after_server_may_have_received_it, is_status_safe_to_retry,
    job_progress_path, parse_blocked_stale_routine_push_body, routine_files_list_path, ApiClient,
    BlockedDirtyResponse, BlockedStaleResponse, CheckFailedResponse, JobProgress,
    ListRoutineFilesResponse, PushRoutineFileDelete, PushRoutineFileUpsert,
    PushRoutineFilesRequest, PushRoutineFilesResponse, UploadPatchCommitResponse, Workbook,
    MAX_REQUEST_ATTEMPTS, RESPONSE_SILENCE_TIMEOUT, RETRY_BACKOFF_BY_FAILED_ATTEMPTS,
    SERVER_SIDE_REQUEST_CEILING,
};
use reqwest::{Client, Method, StatusCode};

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
fn job_progress_reads_failed_operations_off_run_job_public_progress() {
    // A publish run-job that the connector partially rejected reports the count
    // (`failedCount`) AND the per-record messages (`failedOperations`) on its
    // terminal `completed` progress. Lock down that the CLI deserializes both so
    // it can show *why* a record failed, not just that something did.
    let progress: JobProgress = serde_json::from_value(serde_json::json!({
        "state": "completed",
        "publicProgress": {
            "status": "completed",
            "failedCount": 1,
            "failedOperations": [
                {
                    "filePath": "Activities/call-nishant.json",
                    "phase": "create",
                    "error": "'person_id' is a read-only field. Add a primary participant instead."
                }
            ]
        }
    }))
    .unwrap();

    let public = progress.public_progress.unwrap();
    assert_eq!(public.failed_count, 1);
    assert_eq!(public.failed_operations.len(), 1);
    assert_eq!(
        public.failed_operations[0].file_path,
        "Activities/call-nishant.json"
    );
    assert_eq!(public.failed_operations[0].phase, "create");
    assert!(public.failed_operations[0]
        .error
        .as_deref()
        .unwrap()
        .contains("read-only field"));
}

#[test]
fn job_progress_failed_operations_default_empty_when_absent() {
    // A clean job (or older server) omits `failedOperations` → empty vec, not a
    // deserialization error.
    let progress: JobProgress = serde_json::from_value(serde_json::json!({
        "state": "completed",
        "publicProgress": { "status": "completed" }
    }))
    .unwrap();

    let public = progress.public_progress.unwrap();
    assert_eq!(public.failed_count, 0);
    assert!(public.failed_operations.is_empty());
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

// ── Transient-transport retry policy ─────────────────────────────────────────
// A single dropped connection between the CLI (or the desktop app, which shells out to
// `scratchmd`) and the API used to abort a whole pull/publish/upload. These lock down the
// safety rules that decide when replaying a request is allowed.

#[test]
fn reads_are_replayable_after_the_server_may_have_received_the_request() {
    assert!(is_safe_to_replay_after_server_may_have_received_it(
        &Method::GET
    ));
    assert!(is_safe_to_replay_after_server_may_have_received_it(
        &Method::HEAD
    ));
}

#[test]
fn writes_are_not_replayable_after_the_server_may_have_received_the_request() {
    // POST/PATCH could duplicate work. DELETE is excluded too even though HTTP calls it
    // idempotent: a replay of a delete that actually succeeded returns 404, which would
    // surface a completed operation to the caller as `ApiError::NotFound`.
    for method in [Method::POST, Method::PATCH, Method::PUT, Method::DELETE] {
        assert!(
            !is_safe_to_replay_after_server_may_have_received_it(&method),
            "{method} must not be replayed once the server may have received it"
        );
    }
}

#[test]
fn load_balancer_failure_statuses_are_retried_for_reads_only() {
    for status in [429u16, 502, 503, 504] {
        let status = StatusCode::from_u16(status).unwrap();
        assert!(
            is_status_safe_to_retry(status, &Method::GET),
            "{status} should be retried on a read"
        );
        assert!(
            !is_status_safe_to_retry(status, &Method::POST),
            "{status} must not be retried on a write"
        );
    }
}

#[test]
fn meaningful_api_statuses_are_never_retried() {
    // `upload_patch_commit` maps 503 `check_failed` and 409 `blocked_stale`/`blocked_dirty`
    // to real outcomes its caller must see, and 4xx are the caller's problem to surface.
    for status in [400u16, 401, 403, 404, 409, 500] {
        let status = StatusCode::from_u16(status).unwrap();
        assert!(
            !is_status_safe_to_retry(status, &Method::GET),
            "{status} carries meaning and must reach the caller"
        );
    }
    // The write path keeps its 503 even though 503 is retryable for reads.
    assert!(!is_status_safe_to_retry(
        StatusCode::SERVICE_UNAVAILABLE,
        &Method::POST
    ));
}

#[test]
fn response_silence_timeout_outlasts_the_servers_own_request_ceiling() {
    // Until the response headers arrive, reqwest treats `read_timeout` as a hard
    // time-to-first-byte deadline rather than an inactivity bound, so anything at or below the
    // server's own ceiling would cut off slow-but-working endpoints (`listTables` against a
    // large remote account, say) before the server had a chance to answer or time out itself.
    assert!(
        RESPONSE_SILENCE_TIMEOUT > SERVER_SIDE_REQUEST_CEILING,
        "a request the server is still allowed to be working on must not be cut off by the client"
    );
}

#[test]
fn backoff_table_covers_every_retry_the_attempt_budget_allows() {
    // `send_request_with_retry` indexes the backoff table by the number of failed attempts,
    // so the table must have one entry per retry or the loop would panic on the last one.
    assert_eq!(
        RETRY_BACKOFF_BY_FAILED_ATTEMPTS.len(),
        MAX_REQUEST_ATTEMPTS - 1
    );
}

// ── Routines REST contract (DEV-12617) ───────────────────────────────────────
// Locks down the wire shapes of GET/POST /cli/v1/workbooks/:id/routines/{files,push}
// (packages/shared-types/src/dto/routine/*.ts) that `scratchmd routines` relies on.

#[test]
fn routine_push_request_serializes_null_base_version_for_files_expected_to_be_new() {
    // `null` means "expect a new file"; an OMITTED baseVersion would make the server skip the
    // staleness guard, silently overwriting a same-named routine someone else created.
    let request = PushRoutineFilesRequest {
        upserts: vec![PushRoutineFileUpsert {
            path: "routines/daily.yaml".to_string(),
            content: "name: Daily\n".to_string(),
            base_version: None,
        }],
        deletes: vec![],
    };
    let body = serde_json::to_value(&request).unwrap();
    let upsert = body["upserts"][0].as_object().unwrap();
    assert!(upsert.contains_key("baseVersion"));
    assert!(upsert["baseVersion"].is_null());
}

#[test]
fn routine_push_request_serializes_numeric_base_versions_and_object_deletes_without_base_head() {
    let request = PushRoutineFilesRequest {
        upserts: vec![PushRoutineFileUpsert {
            path: "routines/daily.yaml".to_string(),
            content: "name: Daily\n".to_string(),
            base_version: Some(3),
        }],
        deletes: vec![PushRoutineFileDelete {
            path: "routines/old.yaml".to_string(),
            base_version: 5,
        }],
    };
    // Exact equality also proves the deprecated `baseHead` is never sent.
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        serde_json::json!({
            "upserts": [{ "path": "routines/daily.yaml", "content": "name: Daily\n", "baseVersion": 3 }],
            "deletes": [{ "path": "routines/old.yaml", "baseVersion": 5 }]
        })
    );
}

#[test]
fn routine_push_response_reads_full_post_push_versions_and_ignores_deprecated_head() {
    let parsed: PushRoutineFilesResponse = serde_json::from_value(serde_json::json!({
        "files": [
            { "path": "routines/a.yaml", "version": 2 },
            { "path": "routines/b.yaml", "version": 1 }
        ],
        "head": "",
        "routines": [{ "id": "r1" }]
    }))
    .unwrap();
    assert_eq!(parsed.files.len(), 2);
    assert_eq!(parsed.files[0].path, "routines/a.yaml");
    assert_eq!(parsed.files[0].version, 2);
    assert_eq!(parsed.routines.len(), 1);
}

#[test]
fn routine_push_response_without_per_file_versions_fails_to_deserialize() {
    // Without `files` the CLI can't record the pushed versions — fail loudly instead.
    let body = serde_json::json!({ "head": "abc", "routines": [] });
    assert!(serde_json::from_value::<PushRoutineFilesResponse>(body).is_err());
}

#[test]
fn routine_push_blocked_stale_body_parses_stale_files_including_null_versions() {
    let body = serde_json::json!({
        "status": "blocked_stale",
        "staleFiles": [
            { "path": "routines/a.yaml", "baseVersion": 1, "currentVersion": 3 },
            { "path": "routines/new.yaml", "baseVersion": null, "currentVersion": 1 },
            { "path": "routines/gone.yaml", "baseVersion": 2, "currentVersion": null }
        ],
        "message": "Server routines have changed since your last pull (routines/a.yaml)."
    })
    .to_string();
    let parsed = parse_blocked_stale_routine_push_body(&body).unwrap();
    assert_eq!(parsed.stale_files.len(), 3);
    assert_eq!(parsed.stale_files[0].base_version, Some(1));
    assert_eq!(parsed.stale_files[0].current_version, Some(3));
    assert_eq!(parsed.stale_files[1].base_version, None);
    assert_eq!(parsed.stale_files[2].current_version, None);
    assert!(parsed.message.contains("routines/a.yaml"));
}

#[test]
fn routine_push_blocked_stale_body_tolerates_a_nest_status_code_field() {
    let body =
        serde_json::json!({ "statusCode": 409, "status": "blocked_stale", "staleFiles": [] })
            .to_string();
    assert!(parse_blocked_stale_routine_push_body(&body).is_some());
}

#[test]
fn routine_push_409_bodies_that_are_not_blocked_stale_are_not_discriminated() {
    for body in [
        serde_json::json!({ "statusCode": 409, "message": "Conflict" }).to_string(),
        serde_json::json!({ "status": "blocked_dirty", "staleFiles": [] }).to_string(),
        "not json".to_string(),
    ] {
        assert!(
            parse_blocked_stale_routine_push_body(&body).is_none(),
            "{body}"
        );
    }
}

#[test]
fn routine_files_list_response_parses_with_and_without_content() {
    let with_content: ListRoutineFilesResponse = serde_json::from_value(serde_json::json!({
        "files": [{
            "path": "routines/a.yaml",
            "version": 4,
            "updatedAt": "2026-10-29T00:00:00.000Z",
            "content": "name: A\n"
        }]
    }))
    .unwrap();
    assert_eq!(with_content.files[0].version, 4);
    assert_eq!(with_content.files[0].content.as_deref(), Some("name: A\n"));

    // `metadataOnly=true` omits the `content` key entirely.
    let metadata_only: ListRoutineFilesResponse = serde_json::from_value(serde_json::json!({
        "files": [{ "path": "routines/a.yaml", "version": 4, "updatedAt": "2026-10-29T00:00:00.000Z" }]
    }))
    .unwrap();
    assert_eq!(metadata_only.files[0].content, None);
}

#[test]
fn routine_files_list_path_appends_metadata_only_only_when_requested() {
    assert_eq!(
        routine_files_list_path("wkb_1", false),
        "workbooks/wkb_1/routines/files"
    );
    assert_eq!(
        routine_files_list_path("wkb_1", true),
        "workbooks/wkb_1/routines/files?metadataOnly=true"
    );
}
