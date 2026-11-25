use super::*;
use std::cell::RefCell;
use tempfile::TempDir;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CONNECTION_ID: &str = "coa_posts";
const CONNECTION_DIR_NAME: &str = "Blog";

fn table_spec_content(name: &str) -> String {
    format!("{{\n  \"name\": \"{name}\",\n  \"idPath\": \"id\"\n}}\n")
}

fn present(content: &str) -> serde_json::Value {
    serde_json::json!({ "status": "present", "sha256": sha256_of_bytes(content.as_bytes()), "content": content })
}

fn absent() -> serde_json::Value {
    serde_json::json!({ "status": "absent" })
}

fn folder(
    data_folder_id: &str,
    path: &str,
    table_spec: serde_json::Value,
    default_view: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "dataFolderId": data_folder_id,
        "path": path,
        "storedRowUpdatedAt": "2026-11-20T00:00:00.000Z",
        "tableSpec": table_spec,
        "defaultView": default_view,
    })
}

fn listing(connections: Vec<(&str, Vec<serde_json::Value>)>) -> serde_json::Value {
    serde_json::json!({
        "formatVersion": 1,
        "workbookId": "wkb_1",
        "connectorAccounts": connections
            .into_iter()
            .map(|(connector_account_id, data_folders)| serde_json::json!({
                "connectorAccountId": connector_account_id,
                "dataFolders": data_folders,
            }))
            .collect::<Vec<_>>(),
    })
}

/// Drops `content` from every present file, the way `metadataOnly=true` does.
fn metadata_only(listing_with_content: &serde_json::Value) -> serde_json::Value {
    let mut metadata_listing = listing_with_content.clone();
    for connection in metadata_listing["connectorAccounts"]
        .as_array_mut()
        .unwrap()
    {
        for data_folder in connection["dataFolders"].as_array_mut().unwrap() {
            for artifact_key in ["tableSpec", "defaultView"] {
                if let Some(artifact) = data_folder[artifact_key].as_object_mut() {
                    artifact.remove("content");
                }
            }
        }
    }
    metadata_listing
}

/// Serves one listing (metadata calls get it without content) and records every call.
struct FakeTableSpecListingFetcher {
    listing_with_content: serde_json::Value,
    fail_metadata_call: bool,
    fail_content_call: bool,
    calls: RefCell<Vec<(Option<String>, bool)>>,
}

impl FakeTableSpecListingFetcher {
    fn serving(listing_with_content: serde_json::Value) -> Self {
        Self {
            listing_with_content,
            fail_metadata_call: false,
            fail_content_call: false,
            calls: RefCell::new(Vec::new()),
        }
    }

    fn content_call_count(&self) -> usize {
        self.calls
            .borrow()
            .iter()
            .filter(|(_, metadata_only)| !metadata_only)
            .count()
    }
}

impl TableSpecListingFetcher for FakeTableSpecListingFetcher {
    async fn fetch_table_spec_listing(
        &self,
        _workbook_id: &str,
        connector_account_id: Option<&str>,
        metadata_only_call: bool,
    ) -> anyhow::Result<WorkbookTableSpecsResponse> {
        self.calls
            .borrow_mut()
            .push((connector_account_id.map(str::to_string), metadata_only_call));
        if metadata_only_call && self.fail_metadata_call {
            anyhow::bail!("Not found: /cli/v1/workbooks/wkb_1/table-specs");
        }
        if !metadata_only_call && self.fail_content_call {
            anyhow::bail!("Server error (429): Too Many Requests");
        }
        let served_listing = if metadata_only_call {
            metadata_only(&self.listing_with_content)
        } else {
            self.listing_with_content.clone()
        };
        Ok(serde_json::from_value(served_listing)?)
    }
}

struct CacheFixture {
    _temp_dir: TempDir,
    target: TableSpecCacheTarget,
}

impl CacheFixture {
    fn new() -> Self {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache").join(CONNECTION_DIR_NAME);
        std::fs::create_dir_all(&cache_dir).unwrap();
        Self {
            _temp_dir: temp_dir,
            target: TableSpecCacheTarget {
                connection_id: CONNECTION_ID.to_string(),
                conn_dir_name: CONNECTION_DIR_NAME.to_string(),
                cache_dir,
            },
        }
    }

    fn path(&self, cache_relative_path: &str) -> PathBuf {
        absolute_cache_path(&self.target.cache_dir, cache_relative_path)
    }

    fn write(&self, cache_relative_path: &str, bytes: &[u8]) {
        let path = self.path(cache_relative_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn read(&self, cache_relative_path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path(cache_relative_path)).ok()
    }

    fn modified_time(&self, cache_relative_path: &str) -> std::time::SystemTime {
        std::fs::metadata(self.path(cache_relative_path))
            .unwrap()
            .modified()
            .unwrap()
    }
}

async fn refresh(
    fetcher: &FakeTableSpecListingFetcher,
    targets: &[TableSpecCacheTarget],
) -> TableSpecCacheRefreshReport {
    refresh_table_spec_caches_from_server(fetcher, "wkb_1", targets).await
}

fn parsed_entries(data_folders: Vec<serde_json::Value>) -> Vec<WorkbookTableSpecsDataFolderEntry> {
    let connection: WorkbookTableSpecsConnection = serde_json::from_value(serde_json::json!({
        "connectorAccountId": CONNECTION_ID,
        "dataFolders": data_folders,
    }))
    .unwrap();
    connection.parse_data_folders()
}

// ─────────────────────────────────────────────────────────────────────────────
// Path mapping
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn folder_paths_map_to_cache_directories_like_folder_keys() {
    assert_eq!(folder_cache_relative_dir_for_server_path("/").unwrap(), "");
    assert_eq!(
        folder_cache_relative_dir_for_server_path("/Base/Contacts").unwrap(),
        "Base/Contacts"
    );
    assert_eq!(
        folder_cache_relative_dir_for_server_path("/Café 🎉").unwrap(),
        "Café 🎉"
    );
}

#[test]
fn folder_paths_that_could_escape_the_cache_are_rejected() {
    for unsafe_path in [
        "Base",
        "/Base/../../etc",
        "/Base/./Contacts",
        "/Base//Contacts",
        "/Base/",
        "/Base\\Contacts",
        "/Base\0",
    ] {
        assert!(
            folder_cache_relative_dir_for_server_path(unsafe_path).is_err(),
            "{unsafe_path:?} must be rejected"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claiming (pure)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn each_folder_claims_its_table_spec_and_default_view_and_the_root_claims_the_cache_root() {
    let claimed = claim_cache_files_for_connection(&parsed_entries(vec![
        folder("dfd_root", "/", present("{}\n"), absent()),
        folder("dfd_posts", "/Posts", present("{}\n"), present("{}\n")),
    ]));
    assert_eq!(
        claimed.by_cache_relative_path.keys().collect::<Vec<_>>(),
        vec![
            "Posts/schema.json",
            "Posts/views/default.json",
            "schema.json",
            "views/default.json"
        ]
    );
    assert!(claimed.prune_unclaimed_files);
}

#[test]
fn folders_sharing_a_directory_case_insensitively_resolve_to_the_most_recently_updated_row() {
    let mut older = folder("dfd_older", "/posts", present("{\"older\":1}\n"), absent());
    older["storedRowUpdatedAt"] = serde_json::json!("2026-11-01T00:00:00.000Z");
    let mut newer = folder("dfd_newer", "/Posts", present("{\"newer\":1}\n"), absent());
    newer["storedRowUpdatedAt"] = serde_json::json!("2026-11-02T00:00:00.000Z");

    for listing_order in [vec![older.clone(), newer.clone()], vec![newer, older]] {
        let claimed = claim_cache_files_for_connection(&parsed_entries(listing_order));
        let table_spec_paths: Vec<&String> = claimed
            .by_cache_relative_path
            .iter()
            .filter(|(_, file)| file.kind == OwnedCacheFileKind::TableSpec)
            .map(|(path, _)| path)
            .collect();
        assert_eq!(table_spec_paths, vec!["Posts/schema.json"]);
        assert!(claimed
            .warnings
            .iter()
            .any(|w| w.contains("same local directory")));
    }
}

#[test]
fn a_malformed_entry_with_a_path_keeps_its_files_and_one_without_a_path_stops_pruning() {
    let claimed = claim_cache_files_for_connection(&parsed_entries(vec![
        serde_json::json!({ "dataFolderId": "dfd_bad", "path": "/Bad", "tableSpec": { "status": "present" } }),
    ]));
    assert!(matches!(
        claimed.by_cache_relative_path["Bad/schema.json"].artifact,
        TableSpecArtifact::Unreadable { .. }
    ));
    assert!(claimed.prune_unclaimed_files);
    assert!(claimed
        .folder_dirs_with_unreadable_server_spec
        .contains("Bad"));

    let claimed_without_path = claim_cache_files_for_connection(&parsed_entries(vec![
        serde_json::json!({ "dataFolderId": "dfd_bad" }),
    ]));
    assert!(!claimed_without_path.prune_unclaimed_files);
}

#[test]
fn content_that_does_not_match_its_sha256_becomes_unreadable() {
    let mut tampered = folder("dfd_1", "/Posts", present("{\"a\":1}\n"), absent());
    tampered["tableSpec"]["content"] = serde_json::json!("{\"a\":2}\n");
    let claimed = claim_cache_files_for_connection(&parsed_entries(vec![tampered]));
    assert!(matches!(
        claimed.by_cache_relative_path["Posts/schema.json"].artifact,
        TableSpecArtifact::Unreadable { .. }
    ));
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning (pure)
// ─────────────────────────────────────────────────────────────────────────────

fn local_sha256s(entries: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
    entries
        .iter()
        .map(|(path, content)| {
            (
                path.to_string(),
                content.map(|content| sha256_of_bytes(content.as_bytes())),
            )
        })
        .collect()
}

fn owned_on_disk(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|path| path.to_string()).collect()
}

#[test]
fn plan_writes_missing_and_changed_files_and_leaves_equal_bytes_alone() {
    let spec = table_spec_content("Posts");
    let claimed = claim_cache_files_for_connection(&parsed_entries(vec![
        folder("dfd_same", "/Same", present(&spec), absent()),
        folder("dfd_missing", "/Missing", present(&spec), absent()),
        folder("dfd_crlf", "/Crlf", present(&spec), absent()),
    ]));
    let plan = plan_table_spec_cache_changes(
        &claimed,
        &local_sha256s(&[
            ("Same/schema.json", Some(&spec)),
            ("Missing/schema.json", None),
            // CRLF on disk is rewritten: DEV-10518 hashes raw bytes.
            ("Crlf/schema.json", Some(&spec.replace('\n', "\r\n"))),
        ]),
        &owned_on_disk(&["Same/schema.json", "Crlf/schema.json"]),
    );
    let written: Vec<&str> = plan
        .writes
        .iter()
        .map(|write| write.cache_relative_path.as_str())
        .collect();
    assert_eq!(written, vec!["Crlf/schema.json", "Missing/schema.json"]);
    assert_eq!(plan.unchanged_file_count, 1);
    assert!(plan.deletes.is_empty());
}

#[test]
fn plan_deletes_absent_files_keeps_unreadable_ones_and_prunes_unclaimed_owned_files() {
    let spec = table_spec_content("Posts");
    let claimed = claim_cache_files_for_connection(&parsed_entries(vec![
        folder("dfd_1", "/Posts", present(&spec), absent()),
        folder(
            "dfd_2",
            "/Broken",
            serde_json::json!({ "status": "unreadable", "reason": "stored-content-not-a-json-object" }),
            absent(),
        ),
    ]));
    let plan = plan_table_spec_cache_changes(
        &claimed,
        &local_sha256s(&[
            ("Posts/schema.json", Some(&spec)),
            ("Posts/views/default.json", Some("{}\n")),
            ("Broken/schema.json", Some("{}\n")),
        ]),
        &owned_on_disk(&[
            "Posts/schema.json",
            "Posts/views/default.json",
            "Broken/schema.json",
            "Unlinked/schema.json",
            "Unlinked/views/default.json",
        ]),
    );
    let deleted: Vec<(&str, bool)> = plan
        .deletes
        .iter()
        .map(|delete| {
            (
                delete.cache_relative_path.as_str(),
                delete.claimed_by.is_some(),
            )
        })
        .collect();
    assert_eq!(
        deleted,
        vec![
            ("Posts/views/default.json", true),
            ("Unlinked/schema.json", false),
            ("Unlinked/views/default.json", false),
        ]
    );
    assert!(plan.writes.is_empty());
}

#[test]
fn plan_keeps_a_case_variant_of_a_claimed_file_and_prunes_nothing_when_pruning_is_off() {
    let spec = table_spec_content("Posts");
    let claimed = claim_cache_files_for_connection(&parsed_entries(vec![folder(
        "dfd_1",
        "/Posts",
        present(&spec),
        absent(),
    )]));
    let plan = plan_table_spec_cache_changes(
        &claimed,
        // On macOS the claimed path reads the existing lowercase file.
        &local_sha256s(&[("Posts/schema.json", Some(&spec))]),
        &owned_on_disk(&["posts/schema.json"]),
    );
    assert!(plan.deletes.is_empty());
    assert!(plan.writes.is_empty());

    let mut claimed_without_pruning = claimed.clone();
    claimed_without_pruning.prune_unclaimed_files = false;
    let plan_without_pruning = plan_table_spec_cache_changes(
        &claimed_without_pruning,
        &local_sha256s(&[("Posts/schema.json", Some(&spec))]),
        &owned_on_disk(&["Unlinked/schema.json"]),
    );
    assert!(plan_without_pruning.deletes.is_empty());
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh protocol (temp cache + fake fetcher)
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn refresh_writes_the_servers_bytes_verbatim_and_reports_the_changed_folders() {
    let cache = CacheFixture::new();
    let posts_spec = "{\n  \"name\": \"Café 🎉\",\n  \"broken\": \"\\ud83d\"\n}\n";
    let root_spec = table_spec_content("Root");
    let posts_view = "{\n  \"columns\": []\n}\n";
    let fetcher = FakeTableSpecListingFetcher::serving(listing(vec![(
        CONNECTION_ID,
        vec![
            folder("dfd_root", "/", present(&root_spec), absent()),
            folder(
                "dfd_posts",
                "/Posts",
                present(posts_spec),
                present(posts_view),
            ),
        ],
    )]));

    let report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;

    assert_eq!(report.status, TableSpecCacheRefreshStatus::Refreshed);
    assert_eq!(
        cache.read("Posts/schema.json").unwrap(),
        posts_spec.as_bytes()
    );
    assert_eq!(
        cache.read("Posts/views/default.json").unwrap(),
        posts_view.as_bytes()
    );
    assert_eq!(cache.read("schema.json").unwrap(), root_spec.as_bytes());
    assert_eq!(report.schema_files_written, 2);
    assert_eq!(report.default_view_files_written, 1);
    assert_eq!(
        report.folders_with_changed_table_spec,
        vec!["Blog".to_string(), "Blog/Posts".to_string()]
    );
    // One target: both calls are scoped to its connection, and content was fetched once.
    assert_eq!(
        *fetcher.calls.borrow(),
        vec![
            (Some(CONNECTION_ID.to_string()), true),
            (Some(CONNECTION_ID.to_string()), false)
        ]
    );
}

#[tokio::test]
async fn a_refresh_with_nothing_new_makes_one_metadata_call_and_keeps_every_mtime() {
    let cache = CacheFixture::new();
    let spec = table_spec_content("Posts");
    let fetcher = FakeTableSpecListingFetcher::serving(listing(vec![(
        CONNECTION_ID,
        vec![folder("dfd_posts", "/Posts", present(&spec), absent())],
    )]));
    refresh(&fetcher, std::slice::from_ref(&cache.target)).await;
    let modified_before = cache.modified_time("Posts/schema.json");
    fetcher.calls.borrow_mut().clear();

    let report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;

    assert_eq!(report.status, TableSpecCacheRefreshStatus::Refreshed);
    assert_eq!(fetcher.calls.borrow().len(), 1);
    assert_eq!(fetcher.content_call_count(), 0);
    assert_eq!(report.schema_files_written, 0);
    assert!(report.folders_with_changed_table_spec.is_empty());
    assert_eq!(cache.modified_time("Posts/schema.json"), modified_before);
}

#[tokio::test]
async fn refresh_prunes_unlinked_folders_but_keeps_validation_json_and_its_directory() {
    let cache = CacheFixture::new();
    cache.write("Unlinked/schema.json", b"{}\n");
    cache.write("Unlinked/views/default.json", b"{}\n");
    cache.write("Kept/schema.json", b"{}\n");
    cache.write("Kept/validation.json", b"{\"rules\":[]}\n");
    cache.write("Posts/validation.json", b"{\"rules\":[1]}\n");
    cache.write("Posts/views/my-view.json", b"{}\n");
    let fetcher = FakeTableSpecListingFetcher::serving(listing(vec![(
        CONNECTION_ID,
        vec![folder(
            "dfd_posts",
            "/Posts",
            present(&table_spec_content("Posts")),
            absent(),
        )],
    )]));

    let report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;

    assert_eq!(report.status, TableSpecCacheRefreshStatus::Refreshed);
    assert_eq!(report.files_deleted, 3);
    assert!(
        !cache.path("Unlinked").exists(),
        "an emptied folder directory is removed"
    );
    assert!(cache.read("Kept/schema.json").is_none());
    assert_eq!(
        cache.read("Kept/validation.json").unwrap(),
        b"{\"rules\":[]}\n"
    );
    assert_eq!(
        cache.read("Posts/validation.json").unwrap(),
        b"{\"rules\":[1]}\n"
    );
    assert_eq!(cache.read("Posts/views/my-view.json").unwrap(), b"{}\n");
    // A pruned folder is no longer linked, so it has no validation results to clear.
    assert_eq!(
        report.folders_with_changed_table_spec,
        vec!["Blog/Posts".to_string()]
    );
}

#[tokio::test]
async fn an_absent_default_view_is_deleted_and_an_unreadable_spec_is_kept() {
    let cache = CacheFixture::new();
    cache.write("Posts/schema.json", b"{\"stale\":true}\n");
    cache.write("Posts/views/default.json", b"{\"stale\":true}\n");
    let fetcher = FakeTableSpecListingFetcher::serving(listing(vec![(
        CONNECTION_ID,
        vec![folder(
            "dfd_posts",
            "/Posts",
            serde_json::json!({ "status": "unreadable", "reason": "stored-content-not-a-json-object" }),
            absent(),
        )],
    )]));

    let report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;

    assert_eq!(report.status, TableSpecCacheRefreshStatus::Refreshed);
    assert_eq!(
        cache.read("Posts/schema.json").unwrap(),
        b"{\"stale\":true}\n"
    );
    assert!(cache.read("Posts/views/default.json").is_none());
    assert_eq!(
        report.folders_with_unreadable_server_spec,
        vec!["Blog/Posts".to_string()]
    );
    assert!(report.folders_with_changed_table_spec.is_empty());
    assert_eq!(fetcher.content_call_count(), 0, "a delete needs no content");
}

#[tokio::test]
async fn a_failed_metadata_call_leaves_the_cache_untouched() {
    let cache = CacheFixture::new();
    cache.write("Unlinked/schema.json", b"{}\n");
    let mut fetcher = FakeTableSpecListingFetcher::serving(listing(vec![(CONNECTION_ID, vec![])]));
    fetcher.fail_metadata_call = true;

    let report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;

    assert_eq!(report.status, TableSpecCacheRefreshStatus::Failed);
    assert!(report.error.as_deref().unwrap().contains("Not found"));
    assert!(cache.read("Unlinked/schema.json").is_some());
}

#[tokio::test]
async fn a_failed_content_call_leaves_the_cache_untouched_and_the_next_refresh_converges() {
    let cache = CacheFixture::new();
    cache.write("Unlinked/schema.json", b"{}\n");
    let spec = table_spec_content("Posts");
    let mut fetcher = FakeTableSpecListingFetcher::serving(listing(vec![(
        CONNECTION_ID,
        vec![folder("dfd_posts", "/Posts", present(&spec), absent())],
    )]));
    fetcher.fail_content_call = true;

    let failed_report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;

    assert_eq!(failed_report.status, TableSpecCacheRefreshStatus::Failed);
    assert!(
        cache.read("Unlinked/schema.json").is_some(),
        "nothing is deleted after a failed call"
    );
    assert!(cache.read("Posts/schema.json").is_none());

    fetcher.fail_content_call = false;
    let converged_report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;
    assert_eq!(
        converged_report.status,
        TableSpecCacheRefreshStatus::Refreshed
    );
    assert_eq!(cache.read("Posts/schema.json").unwrap(), spec.as_bytes());
    assert!(cache.read("Unlinked/schema.json").is_none());
}

#[tokio::test]
async fn a_newer_format_version_leaves_the_cache_untouched() {
    let cache = CacheFixture::new();
    cache.write("Posts/schema.json", b"{}\n");
    let mut newer_format_listing = listing(vec![(CONNECTION_ID, vec![])]);
    newer_format_listing["formatVersion"] = serde_json::json!(2);
    let fetcher = FakeTableSpecListingFetcher::serving(newer_format_listing);

    let report = refresh(&fetcher, std::slice::from_ref(&cache.target)).await;

    assert_eq!(
        report.status,
        TableSpecCacheRefreshStatus::UnsupportedFormat
    );
    assert!(cache.read("Posts/schema.json").is_some());
}

#[tokio::test]
async fn several_targets_share_one_workbook_scoped_listing_and_unlisted_connections_are_left_alone()
{
    let first = CacheFixture::new();
    let mut second = CacheFixture::new();
    second.target.connection_id = "coa_second".to_string();
    second.target.conn_dir_name = "Second".to_string();
    let mut gone = CacheFixture::new();
    gone.target.connection_id = "coa_gone".to_string();
    gone.target.conn_dir_name = "Gone".to_string();
    gone.write("Posts/schema.json", b"{}\n");
    let fetcher = FakeTableSpecListingFetcher::serving(listing(vec![
        (
            CONNECTION_ID,
            vec![folder("dfd_1", "/Posts", present("{}\n"), absent())],
        ),
        (
            "coa_second",
            vec![folder("dfd_2", "/", present("{}\n"), absent())],
        ),
        (
            "coa_not_local",
            vec![folder("dfd_3", "/X", present("{}\n"), absent())],
        ),
    ]));

    let report = refresh(
        &fetcher,
        &[
            first.target.clone(),
            second.target.clone(),
            gone.target.clone(),
        ],
    )
    .await;

    assert_eq!(report.status, TableSpecCacheRefreshStatus::Refreshed);
    assert!(fetcher
        .calls
        .borrow()
        .iter()
        .all(|(scope, _)| scope.is_none()));
    assert!(first.read("Posts/schema.json").is_some());
    assert!(second.read("schema.json").is_some());
    assert!(gone.read("Posts/schema.json").is_some());
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.contains("coa_gone")));
}

#[tokio::test]
async fn no_targets_skips_without_calling_the_server() {
    let fetcher = FakeTableSpecListingFetcher::serving(listing(vec![]));
    let report = refresh(&fetcher, &[]).await;
    assert_eq!(report.status, TableSpecCacheRefreshStatus::Skipped);
    assert!(fetcher.calls.borrow().is_empty());
}

#[test]
fn the_report_serializes_with_the_documented_json_shape() {
    let report = TableSpecCacheRefreshReport {
        status: TableSpecCacheRefreshStatus::UnsupportedFormat,
        schema_files_written: 1,
        folders_with_changed_table_spec: vec!["Blog/Posts".to_string()],
        ..TableSpecCacheRefreshReport::default()
    };
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        serde_json::json!({
            "status": "unsupported-format",
            "schemaFilesWritten": 1,
            "defaultViewFilesWritten": 0,
            "filesDeleted": 0,
            "foldersWithChangedTableSpec": ["Blog/Posts"],
            "foldersWithUnreadableServerSpec": [],
            "warnings": [],
            "error": null,
        })
    );
}
