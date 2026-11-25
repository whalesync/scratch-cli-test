use super::{
    is_safe_to_replay_after_server_may_have_received_it, is_status_safe_to_retry,
    job_progress_path, ApiClient, BlockedDirtyResponse, BlockedStaleResponse, CheckFailedResponse,
    JobProgress, UploadPatchCommitResponse, Workbook, MAX_REQUEST_ATTEMPTS,
    RESPONSE_SILENCE_TIMEOUT, RETRY_BACKOFF_BY_FAILED_ATTEMPTS, SERVER_SIDE_REQUEST_CEILING,
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

// ── DEV-13025: versioned User-Agent ─────────────────────────────────────────

#[test]
fn user_agent_keeps_the_prefix_the_server_checks_and_is_never_the_legacy_constant() {
    let user_agent = super::scratchmd_user_agent_for_desktop_app_version(None);
    assert!(user_agent.to_lowercase().starts_with("scratch-cli/"));
    assert_ne!(user_agent, "Scratch-cli/1.0");
    assert_eq!(
        user_agent,
        format!("Scratch-cli/1.0 scratchmd/{}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn user_agent_names_the_desktop_version_when_desktop_runs_the_binary() {
    assert_eq!(
        super::scratchmd_user_agent_for_desktop_app_version(Some("1.0.150")),
        format!(
            "Scratch-cli/1.0 scratchmd/{} scratch-desktop/1.0.150",
            env!("CARGO_PKG_VERSION")
        )
    );
}

#[test]
fn user_agent_leaves_out_a_malformed_desktop_version() {
    let without_desktop = super::scratchmd_user_agent_for_desktop_app_version(None);
    for malformed_version in ["", " 1.0", "1.0 evil", "-1.0", &"9".repeat(65)] {
        assert_eq!(
            super::scratchmd_user_agent_for_desktop_app_version(Some(malformed_version)),
            without_desktop,
            "{malformed_version:?} must not reach the User-Agent"
        );
    }
}

#[test]
fn build_request_sends_the_versioned_user_agent() {
    let client = ApiClient::new("http://localhost:3010", "token");
    let request = client
        .build_request::<()>(Method::GET, "workbooks", None)
        .build()
        .unwrap();
    let user_agent = request.headers()["User-Agent"].to_str().unwrap();
    assert!(user_agent.starts_with("Scratch-cli/1.0 scratchmd/"));
}

// ── DEV-13025: table-specs listing ──────────────────────────────────────────

/// The server pins its wire output to this same file (`cli-workbook-table-specs-contract.spec.ts`).
const CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/cli-workbook-table-specs-response.json"
));

fn parsed_fixture_data_folders() -> Vec<super::WorkbookTableSpecsDataFolder> {
    let response: super::WorkbookTableSpecsResponse =
        serde_json::from_str(CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE).unwrap();
    response
        .connector_accounts
        .iter()
        .flat_map(|connection| connection.parse_data_folders())
        .map(|entry| match entry {
            super::WorkbookTableSpecsDataFolderEntry::Parsed(data_folder) => data_folder,
            super::WorkbookTableSpecsDataFolderEntry::Malformed { reason, .. } => {
                panic!("fixture folder failed to parse: {reason}")
            }
        })
        .collect()
}

#[test]
fn table_specs_fixture_parses_every_status_and_empty_connection() {
    let response: super::WorkbookTableSpecsResponse =
        serde_json::from_str(CLI_WORKBOOK_TABLE_SPECS_RESPONSE_FIXTURE).unwrap();
    assert_eq!(response.format_version, 1);
    assert_eq!(response.connector_accounts.len(), 2);
    assert!(response.connector_accounts[1].data_folders.is_empty());

    let data_folders = parsed_fixture_data_folders();
    let statuses: Vec<(&str, &super::TableSpecArtifact)> = data_folders
        .iter()
        .map(|folder| (folder.path.as_str(), &folder.table_spec))
        .collect();
    assert!(matches!(
        statuses[0],
        ("/", super::TableSpecArtifact::Present { .. })
    ));
    assert!(matches!(
        statuses[1],
        ("/Broken", super::TableSpecArtifact::Unreadable { .. })
    ));
    assert!(matches!(
        statuses[2],
        ("/Never Pulled", super::TableSpecArtifact::Absent)
    ));
    assert_eq!(data_folders[2].stored_row_updated_at, None);
}

/// The cross-language hash contract: the SHA-256 of each `content`'s UTF-8 bytes (the bytes written
/// to disk, and what DEV-10518 hashes) equals the server's `sha256`, through multibyte text, a
/// lone-surrogate escape, and the trailing newline.
#[test]
fn table_specs_fixture_content_round_trips_byte_exact_and_matches_its_sha256() {
    use sha2::{Digest, Sha256};
    let mut present_file_count = 0;
    for data_folder in parsed_fixture_data_folders() {
        for artifact in [&data_folder.table_spec, &data_folder.default_view] {
            if let super::TableSpecArtifact::Present { sha256, content } = artifact {
                let content = content.as_deref().expect("fixture content is present");
                assert_eq!(&format!("{:x}", Sha256::digest(content.as_bytes())), sha256);
                present_file_count += 1;
            }
        }
    }
    assert_eq!(present_file_count, 3);

    let posts = parsed_fixture_data_folders()
        .into_iter()
        .find(|folder| folder.path == "/Posts")
        .unwrap();
    let super::TableSpecArtifact::Present {
        content: Some(content),
        ..
    } = posts.table_spec
    else {
        panic!("/Posts must be present with content");
    };
    assert!(content.contains("Café 🎉 Posts"));
    assert!(
        content.contains(r"\ud83d"),
        "the lone-surrogate escape stays escape text"
    );
    assert!(content.ends_with("}\n"));
}

#[test]
fn table_specs_metadata_only_folder_has_no_content() {
    let connection: super::WorkbookTableSpecsConnection =
        serde_json::from_value(serde_json::json!({
            "connectorAccountId": "coa_1",
            "dataFolders": [{
                "dataFolderId": "dfd_1",
                "path": "/Posts",
                "storedRowUpdatedAt": "2026-11-23T18:02:11.123Z",
                "tableSpec": { "status": "present", "sha256": "aa" },
                "defaultView": { "status": "absent" }
            }]
        }))
        .unwrap();
    let parsed_entries = connection.parse_data_folders();
    let [super::WorkbookTableSpecsDataFolderEntry::Parsed(data_folder)] = parsed_entries.as_slice()
    else {
        panic!("expected one parsed folder");
    };
    assert_eq!(
        data_folder.table_spec,
        super::TableSpecArtifact::Present {
            sha256: "aa".to_string(),
            content: None
        }
    );
}

#[test]
fn table_specs_unknown_status_maps_to_unknown_and_a_malformed_folder_spares_its_siblings() {
    let connection: super::WorkbookTableSpecsConnection =
        serde_json::from_value(serde_json::json!({
            "connectorAccountId": "coa_1",
            "dataFolders": [
                {
                    "dataFolderId": "dfd_new_status",
                    "path": "/A",
                    "storedRowUpdatedAt": null,
                    "tableSpec": { "status": "quarantined", "note": "a future status" },
                    "defaultView": { "status": "absent" }
                },
                {
                    "dataFolderId": "dfd_missing_sha",
                    "path": "/B",
                    "storedRowUpdatedAt": null,
                    "tableSpec": { "status": "present", "content": "{}\n" },
                    "defaultView": { "status": "absent" }
                },
                { "dataFolderId": "dfd_no_path" }
            ]
        }))
        .unwrap();
    let entries = connection.parse_data_folders();
    assert!(matches!(
        &entries[0],
        super::WorkbookTableSpecsDataFolderEntry::Parsed(super::WorkbookTableSpecsDataFolder {
            table_spec: super::TableSpecArtifact::Unknown,
            ..
        })
    ));
    assert!(matches!(
        &entries[1],
        super::WorkbookTableSpecsDataFolderEntry::Malformed { path: Some(path), .. } if path == "/B"
    ));
    assert!(matches!(
        &entries[2],
        super::WorkbookTableSpecsDataFolderEntry::Malformed { path: None, .. }
    ));
}

#[test]
fn table_specs_query_scopes_and_encodes_the_connection() {
    assert_eq!(
        super::workbook_table_specs_query(None, true),
        "metadataOnly=true"
    );
    assert_eq!(
        super::workbook_table_specs_query(Some("coa_1 x"), false),
        "metadataOnly=false&connectorAccountId=coa_1%20x"
    );
}
