//! `/api/run-store/…` — the HTTP surface of the Live Export run store (storage in
//! `service/run_store.rs`, design in `docs/RUN_STORE.md`).
//!
//! Every response uses the standard `{ data, status }` envelope. Every endpoint except create,
//! delete and summary answers 404 when the store doesn't exist (the server's `HttpRunStoreClient`
//! maps that to `RunStoreNotFoundError`). These routes carry their own layers — a 512 MB body
//! limit, gzip request bodies (`Content-Encoding: gzip`) and gzip responses (when the client sends
//! `Accept-Encoding: gzip`) — because they move whole tables per request.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::compression::{CompressionLayer, CompressionLevel};
use tower_http::decompression::RequestDecompressionLayer;

use crate::service::envelope::{envelope, envelope_error};
use crate::service::error::AppError;
use crate::service::run_store::{
    delete_collection, merge_collection_into, patch_entry_meta, put_entries, read_entries_by_keys,
    read_entries_page, validate_collection_name, validate_run_store_key, RunStoreEntryMetaPatch,
    RunStoreEntryToPut,
};
use crate::service::state::AppState;

/// Largest (decompressed) request body the run store routes accept. Bulk writes of a few thousand
/// records are tens of MB; the rest of the API keeps its 50 MB limit.
pub const RUN_STORE_REQUEST_BODY_LIMIT_BYTES: usize = 512 * 1024 * 1024;

/// Page size when the caller doesn't pass `limit`.
pub const DEFAULT_RUN_STORE_PAGE_LIMIT: usize = 1000;
/// Largest `limit` a page read accepts (larger is refused with 400, not silently clamped).
pub const MAXIMUM_RUN_STORE_PAGE_LIMIT: usize = 10_000;
/// Most keys one read-by-keys request accepts.
pub const MAXIMUM_RUN_STORE_KEYS_PER_READ: usize = 10_000;

/// The run store routes with their own body limit and gzip layers. Merged into the main API router
/// before its auth layer, so the same bearer-token policy applies.
pub fn run_store_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/run-store/{key}",
            post(create_or_clear_run_store)
                .get(get_run_store_summary)
                .delete(delete_run_store),
        )
        .route(
            "/api/run-store/{key}/collections/{collection}",
            axum::routing::delete(delete_run_store_collection),
        )
        .route(
            "/api/run-store/{key}/collections/{collection}/entries",
            post(put_run_store_entries).get(read_run_store_entries_page),
        )
        .route(
            "/api/run-store/{key}/collections/{collection}/entries/by-keys",
            post(read_run_store_entries_by_keys),
        )
        .route(
            "/api/run-store/{key}/collections/{collection}/entries/patch-meta",
            post(patch_run_store_entry_meta),
        )
        .route(
            "/api/run-store/{key}/collections/{collection}/merge-into/{to_collection}",
            post(merge_run_store_collection_into),
        )
        // Route-level body limit: innermost, so it overrides the API-wide 50 MB default. Applies
        // to the decompressed body.
        .layer(DefaultBodyLimit::max(RUN_STORE_REQUEST_BODY_LIMIT_BYTES))
        .layer(RequestDecompressionLayer::new())
        // Fastest level: record JSON still compresses several-fold, and level 6 on a 20 MB page
        // costs more CPU time than it saves on the wire inside the VPC.
        .layer(CompressionLayer::new().quality(CompressionLevel::Fastest))
}

/// Run blocking store work on the blocking pool and wrap the result in the envelope.
async fn run_blocking_and_envelope<T, F>(state: &AppState, blocking_operation: F) -> Response
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(blocking_operation)
        .await
        .map_err(|e| AppError::internal(e.to_string()))
        .and_then(|result| result);
    match result {
        Ok(data) => envelope(state, None, data),
        Err(err) => envelope_error(state, None, err),
    }
}

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

/// `POST /api/run-store/{key}` — create the store, or recreate it empty (idempotent). 507 when the
/// other run stores already use the whole `GIT_LE_RUN_STORE_MAX_BYTES` budget.
pub async fn create_or_clear_run_store(
    State(state): State<AppState>,
    Path(run_store_key): Path<String>,
) -> Response {
    let staging_dir = state.staging_dir.clone();
    let run_store_state = state.run_store.clone();
    run_blocking_and_envelope(&state, move || {
        run_store_state.create_or_clear_run_store(&staging_dir, &run_store_key)
    })
    .await
}

/// `DELETE /api/run-store/{key}` — delete the store. A missing store is success.
pub async fn delete_run_store(
    State(state): State<AppState>,
    Path(run_store_key): Path<String>,
) -> Response {
    let staging_dir = state.staging_dir.clone();
    let run_store_state = state.run_store.clone();
    run_blocking_and_envelope(&state, move || {
        let deleted = run_store_state.delete_run_store(&staging_dir, &run_store_key)?;
        Ok(json!({ "deleted": deleted }))
    })
    .await
}

/// `GET /api/run-store/{key}` — `{ key, collections: [{ collection, entryCount, bodyBytes }] }`,
/// non-empty collections only, by name. 404 when the store doesn't exist.
pub async fn get_run_store_summary(
    State(state): State<AppState>,
    Path(run_store_key): Path<String>,
) -> Response {
    let staging_dir = state.staging_dir.clone();
    let run_store_state = state.run_store.clone();
    run_blocking_and_envelope(&state, move || {
        run_store_state
            .summarize_run_store(&staging_dir, &run_store_key)?
            .ok_or_else(|| {
                AppError::not_found(format!("Run store '{}' does not exist", run_store_key))
            })
    })
    .await
}

// ---------------------------------------------------------------------------
// Collections and entries
// ---------------------------------------------------------------------------

/// Validate the key and collection and open the (existing) store.
fn open_run_store_for_collection(
    state: &AppState,
    run_store_key: &str,
    collection: &str,
) -> Result<std::sync::Arc<crate::service::run_store::OpenRunStoreDatabase>, AppError> {
    validate_run_store_key(run_store_key)?;
    validate_collection_name(collection)?;
    state
        .run_store
        .open_existing_run_store(&state.staging_dir, run_store_key)
}

#[derive(Debug, Deserialize)]
pub struct PutRunStoreEntriesBody {
    pub entries: Vec<RunStoreEntryToPut>,
}

/// `POST /api/run-store/{key}/collections/{collection}/entries` — body `{ entries: [{ key, meta?,
/// body? }] }`; insert-or-replace, one transaction. Returns `{ written }`.
pub async fn put_run_store_entries(
    State(state): State<AppState>,
    Path((run_store_key, collection)): Path<(String, String)>,
    Json(body): Json<PutRunStoreEntriesBody>,
) -> Response {
    let blocking_state = state.clone();
    run_blocking_and_envelope(&state, move || {
        let open_database =
            open_run_store_for_collection(&blocking_state, &run_store_key, &collection)?;
        let written = open_database
            .write(|transaction| put_entries(transaction, &collection, &body.entries))?;
        Ok(json!({ "written": written }))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRunStoreEntriesPageQuery {
    pub after_key: Option<String>,
    pub limit: Option<usize>,
    pub include_bodies: Option<bool>,
}

/// `GET /api/run-store/{key}/collections/{collection}/entries?afterKey=&limit=&includeBodies=` —
/// `{ entries: [{ key, meta, body? }], nextAfterKey }` in ascending key order (UTF-8 byte order),
/// `afterKey` exclusive; `limit` defaults to 1000, max 10000.
pub async fn read_run_store_entries_page(
    State(state): State<AppState>,
    Path((run_store_key, collection)): Path<(String, String)>,
    Query(query): Query<ReadRunStoreEntriesPageQuery>,
) -> Response {
    let blocking_state = state.clone();
    run_blocking_and_envelope(&state, move || {
        let limit = query.limit.unwrap_or(DEFAULT_RUN_STORE_PAGE_LIMIT);
        if limit == 0 || limit > MAXIMUM_RUN_STORE_PAGE_LIMIT {
            return Err(AppError::bad_request(format!(
                "Run store page limit must be between 1 and {}, got {}",
                MAXIMUM_RUN_STORE_PAGE_LIMIT, limit
            )));
        }
        let open_database =
            open_run_store_for_collection(&blocking_state, &run_store_key, &collection)?;
        open_database.read(|transaction| {
            read_entries_page(
                transaction,
                &collection,
                query.after_key.as_deref(),
                limit,
                query.include_bodies.unwrap_or(false),
            )
        })
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRunStoreEntriesByKeysBody {
    pub keys: Vec<String>,
    #[serde(default)]
    pub include_bodies: bool,
}

/// `POST /api/run-store/{key}/collections/{collection}/entries/by-keys` — body `{ keys,
/// includeBodies }` (max 10000 keys) → `{ entries (request order), missingKeys }`.
pub async fn read_run_store_entries_by_keys(
    State(state): State<AppState>,
    Path((run_store_key, collection)): Path<(String, String)>,
    Json(body): Json<ReadRunStoreEntriesByKeysBody>,
) -> Response {
    let blocking_state = state.clone();
    run_blocking_and_envelope(&state, move || {
        if body.keys.len() > MAXIMUM_RUN_STORE_KEYS_PER_READ {
            return Err(AppError::bad_request(format!(
                "Run store read-by-keys accepts at most {} keys, got {}",
                MAXIMUM_RUN_STORE_KEYS_PER_READ,
                body.keys.len()
            )));
        }
        let open_database =
            open_run_store_for_collection(&blocking_state, &run_store_key, &collection)?;
        open_database.read(|transaction| {
            read_entries_by_keys(transaction, &collection, &body.keys, body.include_bodies)
        })
    })
    .await
}

#[derive(Debug, Deserialize)]
pub struct PatchRunStoreEntryMetaBody {
    pub patches: Vec<RunStoreEntryMetaPatch>,
}

/// `POST /api/run-store/{key}/collections/{collection}/entries/patch-meta` — body `{ patches: [{
/// key, metaPatch }] }`; shallow merge (a field set to null is removed), one transaction →
/// `{ missingKeys }`.
pub async fn patch_run_store_entry_meta(
    State(state): State<AppState>,
    Path((run_store_key, collection)): Path<(String, String)>,
    Json(body): Json<PatchRunStoreEntryMetaBody>,
) -> Response {
    let blocking_state = state.clone();
    run_blocking_and_envelope(&state, move || {
        let open_database =
            open_run_store_for_collection(&blocking_state, &run_store_key, &collection)?;
        let missing_keys = open_database
            .write(|transaction| patch_entry_meta(transaction, &collection, &body.patches))?;
        Ok(json!({ "missingKeys": missing_keys }))
    })
    .await
}

/// `POST /api/run-store/{key}/collections/{from}/merge-into/{to}` — atomically move every entry of
/// `from` into `to` (same-key entries replaced) and empty `from` → `{ moved }`.
pub async fn merge_run_store_collection_into(
    State(state): State<AppState>,
    Path((run_store_key, from_collection, to_collection)): Path<(String, String, String)>,
) -> Response {
    let blocking_state = state.clone();
    run_blocking_and_envelope(&state, move || {
        validate_collection_name(&to_collection)?;
        let open_database =
            open_run_store_for_collection(&blocking_state, &run_store_key, &from_collection)?;
        let moved = open_database.write(|transaction| {
            merge_collection_into(transaction, &from_collection, &to_collection)
        })?;
        Ok(json!({ "moved": moved }))
    })
    .await
}

/// `DELETE /api/run-store/{key}/collections/{collection}` — remove a collection's entries
/// (a missing collection is success) → `{ deleted }`.
pub async fn delete_run_store_collection(
    State(state): State<AppState>,
    Path((run_store_key, collection)): Path<(String, String)>,
) -> Response {
    let blocking_state = state.clone();
    run_blocking_and_envelope(&state, move || {
        let open_database =
            open_run_store_for_collection(&blocking_state, &run_store_key, &collection)?;
        let deleted =
            open_database.write(|transaction| delete_collection(transaction, &collection))?;
        Ok(json!({ "deleted": deleted }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::routes::staging::{cleanup_staging, reap_stale_staging_dirs};
    use crate::service::run_store::{RunStoreState, RUN_STORE_STAGING_REAP_MAX_AGE};
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use flate2::read::GzDecoder;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;
    use tower::ServiceExt;

    const RUN_STORE_KEY: &str = "le-rrn_TestRun001";

    fn make_state(run_store_max_bytes: u64) -> (AppState, TempDir) {
        let root = TempDir::new().unwrap();
        let state = AppState {
            repos_dir: root.path().join("repos"),
            index_dir: root.path().join("repos"),
            staging_dir: root.path().join("staging"),
            build_version: "test".to_string(),
            gc_state: Arc::new(dashmap::DashMap::new()),
            repo_locks: Arc::new(crate::service::git::lock::RepoLocks::new()),
            maintenance: Arc::new(crate::service::maintenance::MaintenanceState::load(
                &root.path().join("maintenance"),
            )),
            run_store: Arc::new(RunStoreState::new(run_store_max_bytes)),
        };
        (state, root)
    }

    fn default_state() -> (AppState, TempDir) {
        make_state(crate::service::run_store::DEFAULT_RUN_STORE_MAX_BYTES)
    }

    async fn send_request(state: &AppState, request: Request<Body>) -> (StatusCode, Value) {
        let response = run_store_router()
            .with_state(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let is_gzip = response
            .headers()
            .get(header::CONTENT_ENCODING)
            .map(|value| value == "gzip")
            .unwrap_or(false);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let bytes = if is_gzip {
            let mut decompressed = Vec::new();
            GzDecoder::new(&bytes[..])
                .read_to_end(&mut decompressed)
                .unwrap();
            decompressed
        } else {
            bytes.to_vec()
        };
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()));
        (status, json)
    }

    async fn send(
        state: &AppState,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = Request::builder().method(method).uri(uri);
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        send_request(state, request).await
    }

    fn entries_uri(key: &str, collection: &str) -> String {
        format!("/api/run-store/{}/collections/{}/entries", key, collection)
    }

    async fn create(state: &AppState, key: &str) -> (StatusCode, Value) {
        send(state, "POST", &format!("/api/run-store/{}", key), None).await
    }

    async fn put(state: &AppState, collection: &str, entries: Value) -> (StatusCode, Value) {
        send(
            state,
            "POST",
            &entries_uri(RUN_STORE_KEY, collection),
            Some(json!({ "entries": entries })),
        )
        .await
    }

    async fn read_page(state: &AppState, collection: &str, query: &str) -> (StatusCode, Value) {
        send(
            state,
            "GET",
            &format!("{}?{}", entries_uri(RUN_STORE_KEY, collection), query),
            None,
        )
        .await
    }

    fn keys_of(entries: &Value) -> Vec<String> {
        entries
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["key"].as_str().unwrap().to_string())
            .collect()
    }

    async fn summary(state: &AppState) -> (StatusCode, Value) {
        send(
            state,
            "GET",
            &format!("/api/run-store/{}", RUN_STORE_KEY),
            None,
        )
        .await
    }

    #[tokio::test]
    async fn create_is_idempotent_and_clears_existing_contents() {
        let (state, _root) = default_state();

        let (status, json) = create(&state, RUN_STORE_KEY).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["cleared"], false);
        assert!(state
            .staging_job_path(RUN_STORE_KEY)
            .join("run.db")
            .exists());

        put(&state, "records", json!([{ "key": "a", "body": "{}" }])).await;
        let (_, json) = summary(&state).await;
        assert_eq!(json["data"]["collections"][0]["entryCount"], 1);

        let (status, json) = create(&state, RUN_STORE_KEY).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["cleared"], true);
        let (status, json) = summary(&state).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            json["data"],
            json!({ "key": RUN_STORE_KEY, "collections": [] })
        );
    }

    #[tokio::test]
    async fn create_rejects_invalid_keys() {
        let (state, _root) = default_state();
        let (status, _) = create(&state, "rrn_NoPrefix01").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = create(&state, "le-bad.key").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = send(&state, "DELETE", "/api/run-store/job_pull", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn create_refuses_with_507_when_other_run_stores_exhaust_the_budget() {
        // An empty SQLite database is already a few KB, so a 64-byte budget is exhausted by one store.
        let (state, _root) = make_state(64);

        let (status, _) = create(&state, "le-rrn_First00001").await;
        assert_eq!(status, StatusCode::OK);

        let (status, json) = create(&state, "le-rrn_Second0001").await;
        assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE);
        assert!(json["data"]["error"]
            .as_str()
            .unwrap()
            .contains("GIT_LE_RUN_STORE_MAX_BYTES"));
        assert!(!state.staging_job_path("le-rrn_Second0001").exists());

        // Clearing the over-budget store itself is allowed (its own bytes don't count).
        let (status, _) = create(&state, "le-rrn_First00001").await;
        assert_eq!(status, StatusCode::OK);

        // Pull/sync staging dirs don't count against the budget.
        let (state_with_pull_dir, _root2) = make_state(64);
        let pull_dir = state_with_pull_dir.staging_job_path("job_pull");
        std::fs::create_dir_all(&pull_dir).unwrap();
        std::fs::write(pull_dir.join("a.json"), "y".repeat(10_000)).unwrap();
        let (status, _) = create(&state_with_pull_dir, RUN_STORE_KEY).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn every_store_scoped_endpoint_is_404_when_the_store_is_missing() {
        let (state, _root) = default_state();
        let collection_uri = format!("/api/run-store/{}/collections/c", RUN_STORE_KEY);
        let requests: Vec<(&str, String, Option<Value>)> = vec![
            ("GET", format!("/api/run-store/{}", RUN_STORE_KEY), None),
            (
                "POST",
                format!("{}/entries", collection_uri),
                Some(json!({ "entries": [{ "key": "a" }] })),
            ),
            ("GET", format!("{}/entries", collection_uri), None),
            (
                "POST",
                format!("{}/entries/by-keys", collection_uri),
                Some(json!({ "keys": ["a"], "includeBodies": true })),
            ),
            (
                "POST",
                format!("{}/entries/patch-meta", collection_uri),
                Some(json!({ "patches": [{ "key": "a", "metaPatch": { "x": 1 } }] })),
            ),
            ("POST", format!("{}/merge-into/d", collection_uri), None),
            ("DELETE", collection_uri.clone(), None),
        ];
        for (method, uri, body) in requests {
            let (status, _) = send(&state, method, &uri, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{} {}", method, uri);
        }
        // A write must not have created the store behind the create-time budget check.
        assert!(!state.staging_job_path(RUN_STORE_KEY).exists());
    }

    #[tokio::test]
    async fn put_inserts_and_replaces_whole_entries() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;

        let (status, json) = put(
            &state,
            "records",
            json!([
                { "key": "a", "meta": { "op": "create", "n": 1 }, "body": "{\"id\":\"a\"}" },
                { "key": "b", "body": "{\"id\":\"b\"}" },
                { "key": "tombstone", "meta": { "deleted": true }, "body": null },
            ]),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["written"], 3);

        // Replacing `a` replaces meta AND body (no merge).
        put(
            &state,
            "records",
            json!([{ "key": "a", "meta": { "op": "update" } }]),
        )
        .await;

        let (_, json) = read_page(&state, "records", "includeBodies=true").await;
        assert_eq!(
            json["data"]["entries"],
            json!([
                { "key": "a", "meta": { "op": "update" }, "body": null },
                { "key": "b", "meta": {}, "body": "{\"id\":\"b\"}" },
                { "key": "tombstone", "meta": { "deleted": true }, "body": null },
            ])
        );

        let (_, json) = summary(&state).await;
        assert_eq!(
            json["data"]["collections"],
            json!([{ "collection": "records", "entryCount": 3, "bodyBytes": 10 }])
        );

        // meta must be an object.
        let (status, _) = put(&state, "records", json!([{ "key": "x", "meta": [1] }])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn paging_is_in_utf8_byte_order_with_an_exclusive_cursor_and_a_limit() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        // UTF-8 byte order: "B" < "a" < "b" < "é" (C3 A9) < "\u{FFFF}" (EF BF BF) < "😀" (F0 …).
        // JS's UTF-16 order would put "😀" before "\u{FFFF}".
        let keys_in_insert_order = ["😀", "b", "\u{FFFF}", "a", "é", "B"];
        put(
            &state,
            "records",
            Value::Array(
                keys_in_insert_order
                    .iter()
                    .map(|key| json!({ "key": key, "body": "x" }))
                    .collect(),
            ),
        )
        .await;
        put(&state, "other", json!([{ "key": "zz" }])).await;

        let (status, json) = read_page(&state, "records", "limit=4").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(keys_of(&json["data"]["entries"]), vec!["B", "a", "b", "é"]);
        assert_eq!(json["data"]["nextAfterKey"], "é");
        // includeBodies defaults to false → no `body` field at all.
        assert!(json["data"]["entries"][0].get("body").is_none());

        let (_, json) = read_page(&state, "records", "limit=4&afterKey=%C3%A9").await;
        assert_eq!(
            keys_of(&json["data"]["entries"]),
            vec!["\u{FFFF}".to_string(), "😀".to_string()]
        );
        assert_eq!(json["data"]["nextAfterKey"], Value::Null);

        // A page that ends exactly at the last entry has no next cursor.
        let (_, json) = read_page(&state, "records", "limit=6").await;
        assert_eq!(json["data"]["entries"].as_array().unwrap().len(), 6);
        assert_eq!(json["data"]["nextAfterKey"], Value::Null);

        // afterKey need not be an existing key.
        let (_, json) = read_page(&state, "records", "afterKey=aa").await;
        assert_eq!(keys_of(&json["data"]["entries"])[0], "b");

        // An empty/missing collection is an empty page.
        let (status, json) = read_page(&state, "nothing-here", "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"], json!({ "entries": [], "nextAfterKey": null }));

        // Limits outside 1..=10000 are refused.
        let (status, _) = read_page(&state, "records", "limit=0").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = read_page(&state, "records", "limit=10001").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn read_by_keys_returns_request_order_and_missing_keys() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        put(
            &state,
            "records",
            json!([
                { "key": "a", "meta": { "n": 1 }, "body": "A" },
                { "key": "b", "meta": { "n": 2 } },
            ]),
        )
        .await;

        let uri = format!("{}/by-keys", entries_uri(RUN_STORE_KEY, "records"));
        let (status, json) = send(
            &state,
            "POST",
            &uri,
            Some(json!({ "keys": ["b", "missing", "a"], "includeBodies": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            json["data"],
            json!({
                "entries": [
                    { "key": "b", "meta": { "n": 2 }, "body": null },
                    { "key": "a", "meta": { "n": 1 }, "body": "A" },
                ],
                "missingKeys": ["missing"],
            })
        );

        let (_, json) = send(
            &state,
            "POST",
            &uri,
            Some(json!({ "keys": ["a"], "includeBodies": false })),
        )
        .await;
        assert_eq!(
            json["data"]["entries"],
            json!([{ "key": "a", "meta": { "n": 1 } }])
        );

        let too_many_keys: Vec<String> = (0..10_001).map(|index| index.to_string()).collect();
        let (status, _) = send(
            &state,
            "POST",
            &uri,
            Some(json!({ "keys": too_many_keys, "includeBodies": false })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn patch_meta_shallow_merges_removes_null_fields_and_reports_missing_keys() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        put(
            &state,
            "plan",
            json!([{
                "key": "a",
                "meta": { "status": "pending", "error": "old", "nested": { "x": 1, "y": 2 } },
                "body": "B",
            }]),
        )
        .await;

        let (status, json) = send(
            &state,
            "POST",
            &format!("{}/patch-meta", entries_uri(RUN_STORE_KEY, "plan")),
            Some(json!({ "patches": [
                { "key": "a", "metaPatch": { "status": "success", "error": null, "nested": { "x": 9 } } },
                { "key": "nope", "metaPatch": { "status": "failed" } },
            ] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["missingKeys"], json!(["nope"]));

        let (_, json) = read_page(&state, "plan", "includeBodies=true").await;
        // Shallow: `nested` is replaced wholesale, not merged; the body is untouched.
        assert_eq!(
            json["data"]["entries"],
            json!([{ "key": "a", "meta": { "status": "success", "nested": { "x": 9 } }, "body": "B" }])
        );
    }

    #[tokio::test]
    async fn merge_into_replaces_same_keys_and_empties_the_source() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        put(
            &state,
            "staging",
            json!([{ "key": "a", "body": "new-a" }, { "key": "c", "body": "c" }]),
        )
        .await;
        put(
            &state,
            "main",
            json!([{ "key": "a", "meta": { "old": true }, "body": "old-a" }, { "key": "b", "body": "b" }]),
        )
        .await;

        let merge_uri = format!(
            "/api/run-store/{}/collections/staging/merge-into/main",
            RUN_STORE_KEY
        );
        let (status, json) = send(&state, "POST", &merge_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["moved"], 2);

        let (_, json) = read_page(&state, "main", "includeBodies=true").await;
        assert_eq!(
            json["data"]["entries"],
            json!([
                { "key": "a", "meta": {}, "body": "new-a" },
                { "key": "b", "meta": {}, "body": "b" },
                { "key": "c", "meta": {}, "body": "c" },
            ])
        );
        let (_, json) = read_page(&state, "staging", "").await;
        assert_eq!(json["data"]["entries"], json!([]));

        // Moving a missing/empty collection is a no-op.
        let (status, json) = send(&state, "POST", &merge_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["moved"], 0);

        // Merging a collection into itself is refused.
        let (status, _) = send(
            &state,
            "POST",
            &format!(
                "/api/run-store/{}/collections/main/merge-into/main",
                RUN_STORE_KEY
            ),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn delete_collection_removes_only_that_collection() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        put(&state, "a", json!([{ "key": "1" }, { "key": "2" }])).await;
        put(&state, "b", json!([{ "key": "1" }])).await;

        let collection_uri = format!("/api/run-store/{}/collections/a", RUN_STORE_KEY);
        let (status, json) = send(&state, "DELETE", &collection_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["deleted"], 2);
        let (status, _) = send(&state, "DELETE", &collection_uri, None).await;
        assert_eq!(status, StatusCode::OK);

        let (_, json) = summary(&state).await;
        assert_eq!(
            json["data"]["collections"],
            json!([{ "collection": "b", "entryCount": 1, "bodyBytes": 0 }])
        );
    }

    #[tokio::test]
    async fn collection_names_are_validated_and_percent_decoded() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        // `source:Products` arrives percent-encoded (encodeURIComponent encodes ':').
        let (status, _) = send(
            &state,
            "POST",
            &entries_uri(RUN_STORE_KEY, "source%3AProducts"),
            Some(json!({ "entries": [{ "key": "a" }] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, json) = summary(&state).await;
        assert_eq!(
            json["data"]["collections"][0]["collection"],
            "source:Products"
        );

        let (status, _) = read_page(&state, "has%20space", "").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn delete_store_is_idempotent_and_drops_cached_connections() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        put(&state, "records", json!([{ "key": "a" }])).await;

        let store_uri = format!("/api/run-store/{}", RUN_STORE_KEY);
        let (status, json) = send(&state, "DELETE", &store_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["deleted"], true);
        assert!(!state.staging_job_path(RUN_STORE_KEY).exists());

        // The cached connection is gone: a write is a 404, not a write into the unlinked file.
        let (status, _) = put(&state, "records", json!([{ "key": "b" }])).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = summary(&state).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, json) = send(&state, "DELETE", &store_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["data"]["deleted"], false);
    }

    #[tokio::test]
    async fn staging_cleanup_of_a_run_store_key_also_drops_cached_connections() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        put(&state, "records", json!([{ "key": "a" }])).await;

        let response = cleanup_staging(
            axum::extract::State(state.clone()),
            axum::extract::Path(RUN_STORE_KEY.to_string()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!state.staging_job_path(RUN_STORE_KEY).exists());
        let (status, _) = put(&state, "records", json!([{ "key": "b" }])).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn gzip_request_bodies_are_accepted_and_responses_are_gzipped_on_request() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;

        let request_json = json!({ "entries": (0..200).map(|index| json!({
            "key": format!("k{:04}", index),
            "meta": { "index": index },
            "body": "{\"name\":\"repeated record body that compresses well\"}",
        })).collect::<Vec<_>>() });
        let mut gzip_encoder = GzEncoder::new(Vec::new(), Compression::fast());
        gzip_encoder
            .write_all(&serde_json::to_vec(&request_json).unwrap())
            .unwrap();
        let gzipped_request_body = gzip_encoder.finish().unwrap();

        let (status, json) = send_request(
            &state,
            Request::builder()
                .method("POST")
                .uri(entries_uri(RUN_STORE_KEY, "records"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::CONTENT_ENCODING, "gzip")
                .body(Body::from(gzipped_request_body))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{json}");
        assert_eq!(json["data"]["written"], 200);

        let response = run_store_router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "{}?includeBodies=true",
                        entries_uri(RUN_STORE_KEY, "records")
                    ))
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers().get(header::CONTENT_ENCODING).unwrap(),
            "gzip"
        );
        let gzipped_response_body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let mut decompressed_response_body = Vec::new();
        GzDecoder::new(&gzipped_response_body[..])
            .read_to_end(&mut decompressed_response_body)
            .unwrap();
        let json: Value = serde_json::from_slice(&decompressed_response_body).unwrap();
        assert_eq!(json["data"]["entries"].as_array().unwrap().len(), 200);
        assert!(gzipped_response_body.len() * 5 < decompressed_response_body.len());
    }

    #[tokio::test]
    async fn bodies_over_the_api_wide_50_mb_limit_are_accepted() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        // Same layering as `service::run()`: the API-wide 50 MB limit wraps the merged run store
        // router, whose own (inner) limit must win.
        let router_with_api_wide_body_limit = Router::new()
            .merge(run_store_router())
            .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
            .with_state(state.clone());
        // Two ~30 MB bodies: 60 MB of JSON, over the API-wide limit.
        let big_body = "x".repeat(30 * 1024 * 1024);
        let request_body = serde_json::to_vec(
            &json!({ "entries": [{ "key": "a", "body": big_body }, { "key": "b", "body": big_body }] }),
        )
        .unwrap();
        let response = router_with_api_wide_body_limit
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(entries_uri(RUN_STORE_KEY, "records"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(request_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (_, json) = summary(&state).await;
        assert_eq!(
            json["data"]["collections"][0]["bodyBytes"],
            2 * 30 * 1024 * 1024
        );
    }

    #[tokio::test]
    async fn boot_reaper_uses_the_24h_run_store_threshold_for_le_dirs_only() {
        let (state, _root) = default_state();
        create(&state, RUN_STORE_KEY).await;
        let pull_dir = state.staging_job_path("job_pull");
        std::fs::create_dir_all(&pull_dir).unwrap();
        std::fs::write(pull_dir.join("a.json"), "{}").unwrap();
        std::thread::sleep(Duration::from_millis(10));

        // Generous pull threshold, zero run-store threshold → only the le- dir is reaped.
        let summary = reap_stale_staging_dirs(
            &state.staging_dir,
            Duration::from_secs(72 * 3600),
            Duration::ZERO,
        );
        assert_eq!(summary.scanned, 2);
        assert_eq!(summary.reaped_job_ids, vec![RUN_STORE_KEY.to_string()]);
        assert!(!state.staging_job_path(RUN_STORE_KEY).exists());
        assert!(pull_dir.exists());

        // And the reverse: a fresh le- dir survives the 24h threshold while an "old" pull dir goes.
        create(&state, RUN_STORE_KEY).await;
        std::thread::sleep(Duration::from_millis(10));
        let summary = reap_stale_staging_dirs(
            &state.staging_dir,
            Duration::ZERO,
            RUN_STORE_STAGING_REAP_MAX_AGE,
        );
        assert_eq!(summary.reaped_job_ids, vec!["job_pull".to_string()]);
        assert!(state.staging_job_path(RUN_STORE_KEY).exists());
    }

    // -----------------------------------------------------------------------
    // Benchmark (ignored): `cargo test --release run_store_throughput_benchmark -- --ignored --nocapture`
    // -----------------------------------------------------------------------

    /// A ~4 KB record body shaped like connector JSON (repeated field names, varied values).
    fn benchmark_record_body(record_index: usize) -> String {
        const WORDS: [&str; 16] = [
            "invoice", "customer", "amount", "pending", "shipped", "priority", "north", "south",
            "widget", "gadget", "renewal", "annual", "monthly", "discount", "region", "status",
        ];
        let mut pseudo_random_state = (record_index as u64)
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let mut next_word = || {
            pseudo_random_state = pseudo_random_state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            WORDS[(pseudo_random_state >> 60) as usize]
        };
        let mut fields = serde_json::Map::new();
        fields.insert("id".to_string(), json!(format!("rec{:08}", record_index)));
        let mut field_index = 0;
        while serde_json::to_string(&fields).unwrap().len() < 4000 {
            let text: Vec<&str> = (0..8).map(|_| next_word()).collect();
            fields.insert(
                format!("field_{:03}", field_index),
                json!({ "text": text.join(" "), "n": record_index * 31 + field_index }),
            );
            field_index += 1;
        }
        serde_json::to_string(&fields).unwrap()
    }

    fn gzip_bytes(bytes: &[u8]) -> Vec<u8> {
        let mut gzip_encoder = GzEncoder::new(Vec::new(), Compression::fast());
        gzip_encoder.write_all(bytes).unwrap();
        gzip_encoder.finish().unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn run_store_throughput_benchmark() {
        const ENTRY_COUNT: usize = 100_000;
        const BATCH_SIZE: usize = 5_000;
        let (state, _root) = default_state();
        let router = run_store_router().with_state(state.clone());

        let bodies: Vec<String> = (0..ENTRY_COUNT).map(benchmark_record_body).collect();
        let total_body_bytes: usize = bodies.iter().map(|body| body.len()).sum();
        println!(
            "benchmark: {} entries, {:.1} MB of bodies (avg {} B)",
            ENTRY_COUNT,
            total_body_bytes as f64 / 1e6,
            total_body_bytes / ENTRY_COUNT
        );

        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/run-store/{}", RUN_STORE_KEY))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        for use_gzip in [false, true] {
            let collection = if use_gzip { "gzipped" } else { "plain" };

            // Pre-build request bodies so the timing is the server's work (+ client gzip, reported).
            let client_encode_start = Instant::now();
            let request_bodies: Vec<Vec<u8>> = bodies
                .chunks(BATCH_SIZE)
                .enumerate()
                .map(|(batch_index, batch)| {
                    let entries: Vec<Value> = batch
                        .iter()
                        .enumerate()
                        .map(|(offset, body)| {
                            let record_index = batch_index * BATCH_SIZE + offset;
                            json!({
                                "key": format!("rec{:08}", record_index),
                                "meta": { "op": "create", "sourceId": record_index },
                                "body": body,
                            })
                        })
                        .collect();
                    let json_bytes = serde_json::to_vec(&json!({ "entries": entries })).unwrap();
                    if use_gzip {
                        gzip_bytes(&json_bytes)
                    } else {
                        json_bytes
                    }
                })
                .collect();
            let client_encode_elapsed = client_encode_start.elapsed();
            let wire_bytes: usize = request_bodies.iter().map(Vec::len).sum();

            let write_start = Instant::now();
            for request_body in request_bodies {
                let mut builder = Request::builder()
                    .method("POST")
                    .uri(entries_uri(RUN_STORE_KEY, collection))
                    .header(header::CONTENT_TYPE, "application/json");
                if use_gzip {
                    builder = builder.header(header::CONTENT_ENCODING, "gzip");
                }
                let response = router
                    .clone()
                    .oneshot(builder.body(Body::from(request_body)).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
            }
            let write_elapsed = write_start.elapsed();
            println!(
                "write  gzip={:<5} {:>7.0} ms  {:>8.0} entries/s  {:>6.1} MB/s  wire {:>6.1} MB  (client JSON{} build {:.0} ms)",
                use_gzip,
                write_elapsed.as_secs_f64() * 1000.0,
                ENTRY_COUNT as f64 / write_elapsed.as_secs_f64(),
                total_body_bytes as f64 / 1e6 / write_elapsed.as_secs_f64(),
                wire_bytes as f64 / 1e6,
                if use_gzip { "+gzip" } else { "" },
                client_encode_elapsed.as_secs_f64() * 1000.0,
            );

            for include_bodies in [true, false] {
                let read_start = Instant::now();
                let mut after_key: Option<String> = None;
                let mut entries_read = 0;
                let mut response_wire_bytes = 0;
                loop {
                    let mut uri = format!(
                        "{}?limit={}&includeBodies={}",
                        entries_uri(RUN_STORE_KEY, collection),
                        BATCH_SIZE,
                        include_bodies
                    );
                    if let Some(after_key) = &after_key {
                        uri.push_str(&format!("&afterKey={}", after_key));
                    }
                    let mut builder = Request::builder().uri(uri);
                    if use_gzip {
                        builder = builder.header(header::ACCEPT_ENCODING, "gzip");
                    }
                    let response = router
                        .clone()
                        .oneshot(builder.body(Body::empty()).unwrap())
                        .await
                        .unwrap();
                    let response_bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                    response_wire_bytes += response_bytes.len();
                    let json_bytes = if use_gzip {
                        let mut decompressed = Vec::new();
                        GzDecoder::new(&response_bytes[..])
                            .read_to_end(&mut decompressed)
                            .unwrap();
                        decompressed
                    } else {
                        response_bytes.to_vec()
                    };
                    let page: Value = serde_json::from_slice(&json_bytes).unwrap();
                    entries_read += page["data"]["entries"].as_array().unwrap().len();
                    match page["data"]["nextAfterKey"].as_str() {
                        Some(next_after_key) => after_key = Some(next_after_key.to_string()),
                        None => break,
                    }
                }
                let read_elapsed = read_start.elapsed();
                assert_eq!(entries_read, ENTRY_COUNT);
                println!(
                    "read   gzip={:<5} bodies={:<5} {:>7.0} ms  {:>8.0} entries/s  wire {:>6.1} MB  (incl. client decode)",
                    use_gzip,
                    include_bodies,
                    read_elapsed.as_secs_f64() * 1000.0,
                    ENTRY_COUNT as f64 / read_elapsed.as_secs_f64(),
                    response_wire_bytes as f64 / 1e6,
                );
            }
        }

        let run_store_dir_bytes: u64 = std::fs::read_dir(state.staging_job_path(RUN_STORE_KEY))
            .unwrap()
            .flatten()
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        println!(
            "run store dir: {:.1} MB on disk for 2 x {} entries",
            run_store_dir_bytes as f64 / 1e6,
            ENTRY_COUNT
        );
        let delete_start = Instant::now();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/run-store/{}", RUN_STORE_KEY))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        println!(
            "delete store: {:.0} ms",
            delete_start.elapsed().as_secs_f64() * 1000.0
        );
    }
}
