//! DEV-13025: keep each connection's local table-spec cache in step with the server.
//!
//! Every folder's table spec (`schema.json`) and default view (`views/default.json`) live in the
//! connection's cache, `<workspace>/.scratch/connections/scratch/<connection>/<folder>/`. The
//! validators, the folder index, `record-tree`, `syncs validate-local`, `files revert-plan`, and
//! Scratch Desktop all read them from there. Before DEV-13025 the cache was copied from the
//! connection repo's git `.scratch/` mirror; now this module is its only writer, and it fills it from
//! `GET /cli/v1/workbooks/{id}/table-specs`, which reads Postgres (the source of truth since
//! DEV-12616). That is what lets the server stop writing specs to git.
//!
//! How a refresh works:
//!
//! 1. One metadata-only call lists every linked folder's two files with their SHA-256s.
//! 2. [`claim_cache_files_for_connection`] maps each folder to the files it owns locally, and
//!    [`plan_table_spec_cache_changes`] compares them with the bytes on disk. Both are pure.
//! 3. Only when something must be written does a second call fetch the content, and the plan is
//!    rebuilt from that complete listing.
//! 4. Deletes, then atomic writes. Nothing is deleted after a failed call.
//!
//! The refresh owns exactly two file names: `schema.json` and `views/default.json`, at any depth
//! of a connection's cache. Everything else there (Desktop's `validation.json`, named views, hidden
//! files) is never touched. Writes compare raw bytes, so a refresh that finds nothing new leaves
//! every file, and its mtime, alone. Re-running always converges, because the server listing plus a
//! hash of the bytes on disk decide every write and delete.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::api::{
    TableSpecArtifact, WorkbookTableSpecsConnection, WorkbookTableSpecsDataFolder,
    WorkbookTableSpecsDataFolderEntry, WorkbookTableSpecsResponse,
    SUPPORTED_WORKBOOK_TABLE_SPECS_FORMAT_VERSION,
};
use crate::config::markers;
use crate::shared::folder_index;
use crate::shared::layout::WorkspaceLayout;

const TABLE_SPEC_FILE_NAME: &str = "schema.json";
const DEFAULT_VIEWS_DIRECTORY_NAME: &str = "views";
const DEFAULT_VIEW_FILE_NAME: &str = "default.json";

/// How long `workspaces init` waits for the table specs before giving up and leaving the repair to
/// the next `files download`.
pub const TABLE_SPEC_CACHE_REFRESH_TIMEOUT_DURING_INIT: Duration = Duration::from_secs(60);

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/// One connection whose cache a refresh may write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableSpecCacheTarget {
    pub connection_id: String,
    /// The connection's directory name in the workspace (the first segment of every folder key).
    pub conn_dir_name: String,
    /// `<workspace>/.scratch/connections/scratch/<conn_dir_name>/`.
    pub cache_dir: PathBuf,
}

/// Every connection the workspace marker lists (the same set `files download` works on before its
/// cwd filter), as refresh targets.
pub fn table_spec_cache_targets_for_workspace(
    workspace_dir: &Path,
    workspace_marker: &markers::WorkspaceMarker,
) -> Vec<TableSpecCacheTarget> {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    workspace_marker
        .connections
        .iter()
        .filter(|connection| !connection.repo_path.is_empty() && !connection.dir_name.is_empty())
        .map(|connection| TableSpecCacheTarget {
            connection_id: connection.id.clone(),
            conn_dir_name: connection.dir_name.clone(),
            cache_dir: layout.connection_scratch_path(&connection.dir_name),
        })
        .collect()
}

/// Where a refresh gets its listings. The API client in production; a fake in tests (the crate has
/// no HTTP mock).
pub(crate) trait TableSpecListingFetcher {
    async fn fetch_table_spec_listing(
        &self,
        workbook_id: &str,
        connector_account_id: Option<&str>,
        metadata_only: bool,
    ) -> anyhow::Result<WorkbookTableSpecsResponse>;
}

impl TableSpecListingFetcher for crate::api::ApiClient {
    async fn fetch_table_spec_listing(
        &self,
        workbook_id: &str,
        connector_account_id: Option<&str>,
        metadata_only: bool,
    ) -> anyhow::Result<WorkbookTableSpecsResponse> {
        Ok(self
            .list_workbook_table_specs(workbook_id, connector_account_id, metadata_only)
            .await?)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TableSpecCacheRefreshStatus {
    /// Every target's cache now matches the server (folders the server couldn't serve were kept).
    Refreshed,
    /// A call failed, or a file couldn't be written. Nothing is deleted after a failed call; the
    /// next refresh retries.
    Failed,
    /// The server answered with a `formatVersion` newer than this build understands. The cache was
    /// left alone.
    UnsupportedFormat,
    /// No refresh ran (no connections, or the caller asked to skip it).
    #[default]
    Skipped,
}

/// What a refresh did, printed as `tableSpecCacheRefresh` in `--json` output.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpecCacheRefreshReport {
    pub status: TableSpecCacheRefreshStatus,
    pub schema_files_written: usize,
    pub default_view_files_written: usize,
    pub files_deleted: usize,
    /// Workspace-relative folder keys (`<connection>/<folder>`, or `<connection>` for a root folder)
    /// whose `schema.json` was written or deleted. Their DEV-10518 `enforce_schema` results are stale.
    pub folders_with_changed_table_spec: Vec<String>,
    /// Workspace-relative folder keys whose stored table spec or default view the server couldn't
    /// serve. Their local files were kept.
    pub folders_with_unreadable_server_spec: Vec<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

impl TableSpecCacheRefreshReport {
    pub fn skipped() -> Self {
        Self::default()
    }

    pub fn failed(error: impl std::fmt::Display) -> Self {
        Self {
            status: TableSpecCacheRefreshStatus::Failed,
            error: Some(error.to_string()),
            ..Self::default()
        }
    }

    pub fn succeeded(&self) -> bool {
        matches!(
            self.status,
            TableSpecCacheRefreshStatus::Refreshed | TableSpecCacheRefreshStatus::Skipped
        )
    }
}

/// Prints a report's warnings, and its failure, to stderr. Every command that refreshes calls this,
/// so a refresh that didn't happen is never silent, even when `--json` owns stdout.
pub fn print_table_spec_cache_refresh_problems(report: &TableSpecCacheRefreshReport) {
    for warning in &report.warnings {
        eprintln!("Warning: table specs: {warning}");
    }
    match report.status {
        TableSpecCacheRefreshStatus::Failed => eprintln!(
            "Warning: could not refresh the local table specs ({}). Run `scratchmd files refresh-table-specs` to retry.",
            report.error.as_deref().unwrap_or("unknown error")
        ),
        TableSpecCacheRefreshStatus::UnsupportedFormat => eprintln!(
            "Warning: the server's table-spec format is newer than this scratchmd understands; the local table specs were left alone. Update scratchmd."
        ),
        TableSpecCacheRefreshStatus::Refreshed | TableSpecCacheRefreshStatus::Skipped => {}
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure planning
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnedCacheFileKind {
    TableSpec,
    DefaultView,
}

/// One local file a listed folder owns, and what the server says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedCacheFile {
    pub kind: OwnedCacheFileKind,
    /// The owning folder's directory relative to the connection cache (`""` for the root folder).
    pub folder_cache_relative_dir: String,
    pub artifact: TableSpecArtifact,
}

/// Every local file the listing claims for one connection, keyed by its slash-separated path
/// relative to the connection cache.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaimedCacheFiles {
    pub by_cache_relative_path: BTreeMap<String, ClaimedCacheFile>,
    /// False when an entry's folder couldn't be identified, so an owned file the listing doesn't
    /// claim might still be that folder's. Nothing is pruned then.
    pub prune_unclaimed_files: bool,
    /// Folder directories (relative to the connection cache) the server couldn't fully serve.
    pub folder_dirs_with_unreadable_server_spec: BTreeSet<String>,
    pub warnings: Vec<String>,
}

/// Maps a folder's `DataFolder.path` to its directory relative to the connection cache: `/` is the
/// cache root and `/A/B` is `A/B` (the same mapping as the folder keys `files download` builds).
/// Rejects anything that could escape the cache or that git could never have held.
pub fn folder_cache_relative_dir_for_server_path(server_path: &str) -> Result<String, String> {
    let Some(path_without_leading_slash) = server_path.strip_prefix('/') else {
        return Err(format!("folder path {server_path:?} doesn't start with /"));
    };
    if path_without_leading_slash.is_empty() {
        return Ok(String::new());
    }
    if server_path.contains('\\') || server_path.contains('\0') {
        return Err(format!(
            "folder path {server_path:?} holds a backslash or a NUL"
        ));
    }
    if path_without_leading_slash
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!(
            "folder path {server_path:?} has an empty, `.`, or `..` segment"
        ));
    }
    Ok(path_without_leading_slash.to_string())
}

fn join_cache_relative_path(folder_cache_relative_dir: &str, file_relative_path: &str) -> String {
    if folder_cache_relative_dir.is_empty() {
        file_relative_path.to_string()
    } else {
        format!("{folder_cache_relative_dir}/{file_relative_path}")
    }
}

fn table_spec_cache_relative_path(folder_cache_relative_dir: &str) -> String {
    join_cache_relative_path(folder_cache_relative_dir, TABLE_SPEC_FILE_NAME)
}

fn default_view_cache_relative_path(folder_cache_relative_dir: &str) -> String {
    join_cache_relative_path(
        folder_cache_relative_dir,
        &format!("{DEFAULT_VIEWS_DIRECTORY_NAME}/{DEFAULT_VIEW_FILE_NAME}"),
    )
}

/// A `present` file whose `content` doesn't hash to its `sha256` can't be trusted: it becomes
/// `unreadable`, so the local copy is kept.
fn artifact_with_verified_content(artifact: &TableSpecArtifact) -> TableSpecArtifact {
    match artifact {
        TableSpecArtifact::Present {
            sha256,
            content: Some(content),
        } if sha256_of_bytes(content.as_bytes()) != *sha256 => TableSpecArtifact::Unreadable {
            reason: "the content doesn't match its sha256".to_string(),
        },
        other => other.clone(),
    }
}

fn is_unreadable_or_unknown(artifact: &TableSpecArtifact) -> bool {
    matches!(
        artifact,
        TableSpecArtifact::Unreadable { .. } | TableSpecArtifact::Unknown
    )
}

/// Maps one connection's listed folders to the local files they own. Pure.
///
/// - A folder with an invalid path is warned about and claims nothing.
/// - Two folders whose directories differ only in case (one directory on macOS and Windows) are
///   resolved to the most recently updated stored row, like the server's index build, with a
///   warning. The other is ignored.
/// - A malformed entry whose path can be read claims its files as `unreadable`, so they're kept. One
///   whose path can't be read turns pruning off for the connection.
pub fn claim_cache_files_for_connection(
    listed_data_folders: &[WorkbookTableSpecsDataFolderEntry],
) -> ClaimedCacheFiles {
    let mut claimed = ClaimedCacheFiles {
        prune_unclaimed_files: true,
        ..ClaimedCacheFiles::default()
    };

    // Resolve folders that share a directory, case-insensitively, before claiming anything.
    let mut winning_folder_by_lowercase_dir: BTreeMap<
        String,
        (String, &WorkbookTableSpecsDataFolder),
    > = BTreeMap::new();
    let mut malformed_folders_with_readable_path: Vec<(String, String)> = Vec::new();
    for entry in listed_data_folders {
        match entry {
            WorkbookTableSpecsDataFolderEntry::Parsed(data_folder) => {
                let folder_cache_relative_dir =
                    match folder_cache_relative_dir_for_server_path(&data_folder.path) {
                        Ok(dir) => dir,
                        Err(reason) => {
                            claimed.warnings.push(format!(
                                "skipped folder {}: {reason}",
                                data_folder.data_folder_id
                            ));
                            continue;
                        }
                    };
                let lowercase_dir = folder_cache_relative_dir.to_lowercase();
                match winning_folder_by_lowercase_dir.get(&lowercase_dir) {
                    Some((_, current_winner)) => {
                        claimed.warnings.push(format!(
                            "folders {} and {} map to the same local directory {:?}; using the more recently updated one",
                            current_winner.data_folder_id, data_folder.data_folder_id, data_folder.path
                        ));
                        if is_more_recently_updated(data_folder, current_winner) {
                            winning_folder_by_lowercase_dir
                                .insert(lowercase_dir, (folder_cache_relative_dir, data_folder));
                        }
                    }
                    None => {
                        winning_folder_by_lowercase_dir
                            .insert(lowercase_dir, (folder_cache_relative_dir, data_folder));
                    }
                }
            }
            WorkbookTableSpecsDataFolderEntry::Malformed { path, reason } => {
                match path
                    .as_deref()
                    .map(folder_cache_relative_dir_for_server_path)
                {
                    Some(Ok(folder_cache_relative_dir)) => {
                        claimed.warnings.push(format!(
                            "kept the local files of folder {:?}: its listing entry is malformed ({reason})",
                            path.as_deref().unwrap_or_default()
                        ));
                        malformed_folders_with_readable_path
                            .push((folder_cache_relative_dir, reason.clone()));
                    }
                    _ => {
                        claimed.prune_unclaimed_files = false;
                        claimed.warnings.push(format!(
                            "a listing entry has no usable folder path ({reason}); no unlisted files were removed"
                        ));
                    }
                }
            }
        }
    }

    for (folder_cache_relative_dir, data_folder) in winning_folder_by_lowercase_dir.values() {
        let table_spec = artifact_with_verified_content(&data_folder.table_spec);
        let default_view = artifact_with_verified_content(&data_folder.default_view);
        if is_unreadable_or_unknown(&table_spec) || is_unreadable_or_unknown(&default_view) {
            claimed
                .folder_dirs_with_unreadable_server_spec
                .insert(folder_cache_relative_dir.clone());
            claimed.warnings.push(format!(
                "kept the local files of folder {:?}: the server couldn't serve its stored table spec or default view",
                data_folder.path
            ));
        }
        claimed.by_cache_relative_path.insert(
            table_spec_cache_relative_path(folder_cache_relative_dir),
            ClaimedCacheFile {
                kind: OwnedCacheFileKind::TableSpec,
                folder_cache_relative_dir: folder_cache_relative_dir.clone(),
                artifact: table_spec,
            },
        );
        claimed.by_cache_relative_path.insert(
            default_view_cache_relative_path(folder_cache_relative_dir),
            ClaimedCacheFile {
                kind: OwnedCacheFileKind::DefaultView,
                folder_cache_relative_dir: folder_cache_relative_dir.clone(),
                artifact: default_view,
            },
        );
    }

    for (folder_cache_relative_dir, reason) in malformed_folders_with_readable_path {
        claimed
            .folder_dirs_with_unreadable_server_spec
            .insert(folder_cache_relative_dir.clone());
        for (cache_relative_path, kind) in [
            (
                table_spec_cache_relative_path(&folder_cache_relative_dir),
                OwnedCacheFileKind::TableSpec,
            ),
            (
                default_view_cache_relative_path(&folder_cache_relative_dir),
                OwnedCacheFileKind::DefaultView,
            ),
        ] {
            claimed
                .by_cache_relative_path
                .entry(cache_relative_path)
                .or_insert_with(|| ClaimedCacheFile {
                    kind,
                    folder_cache_relative_dir: folder_cache_relative_dir.clone(),
                    artifact: TableSpecArtifact::Unreadable {
                        reason: reason.clone(),
                    },
                });
        }
    }

    claimed
}

/// The newer stored row wins; a folder with a row beats one without; ties go to the smaller id, so
/// the choice never depends on listing order. ISO-8601 timestamps compare as strings.
fn is_more_recently_updated(
    candidate: &WorkbookTableSpecsDataFolder,
    current_winner: &WorkbookTableSpecsDataFolder,
) -> bool {
    match (
        &candidate.stored_row_updated_at,
        &current_winner.stored_row_updated_at,
    ) {
        (Some(candidate_updated_at), Some(winner_updated_at))
            if candidate_updated_at != winner_updated_at =>
        {
            candidate_updated_at > winner_updated_at
        }
        (Some(_), None) => true,
        (None, Some(_)) => false,
        _ => candidate.data_folder_id < current_winner.data_folder_id,
    }
}

/// A file the plan writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedCacheFileWrite {
    pub cache_relative_path: String,
    pub kind: OwnedCacheFileKind,
    pub folder_cache_relative_dir: String,
    pub sha256: String,
    /// None in a plan built from a metadata-only listing: the content is fetched only once a plan
    /// needs it.
    pub content: Option<String>,
}

/// A file the plan deletes: the server has nothing stored for it (`absent`), or no listed folder
/// claims it any more (an unlinked or moved folder).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedCacheFileDelete {
    pub cache_relative_path: String,
    /// The owning folder when the server listed it as `absent`; None for an unclaimed file.
    pub claimed_by: Option<(OwnedCacheFileKind, String)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableSpecCachePlan {
    pub writes: Vec<PlannedCacheFileWrite>,
    pub deletes: Vec<PlannedCacheFileDelete>,
    pub unchanged_file_count: usize,
}

/// Compares the claimed files with the disk. Pure.
///
/// `sha256_of_local_file_at_claimed_path` holds the hash of the bytes the filesystem returns for
/// each claimed path (None when it's missing). Reading the claimed path, rather than matching names
/// from a directory walk, lets the filesystem resolve case: on macOS and Windows a claimed
/// `Posts/schema.json` reads the existing `posts/schema.json`, so a case-only folder rename doesn't
/// rewrite the file on every refresh. `owned_files_on_disk` is that walk: every `schema.json` and
/// `views/default.json` under the cache, for pruning.
///
/// Raw bytes are compared (a CRLF copy is rewritten), because DEV-10518 hashes raw bytes.
pub fn plan_table_spec_cache_changes(
    claimed: &ClaimedCacheFiles,
    sha256_of_local_file_at_claimed_path: &BTreeMap<String, Option<String>>,
    owned_files_on_disk: &BTreeSet<String>,
) -> TableSpecCachePlan {
    let mut plan = TableSpecCachePlan::default();

    for (cache_relative_path, claimed_file) in &claimed.by_cache_relative_path {
        let local_sha256 = sha256_of_local_file_at_claimed_path
            .get(cache_relative_path)
            .cloned()
            .flatten();
        match &claimed_file.artifact {
            TableSpecArtifact::Present { sha256, content } => {
                if local_sha256.as_deref() == Some(sha256.as_str()) {
                    plan.unchanged_file_count += 1;
                } else {
                    plan.writes.push(PlannedCacheFileWrite {
                        cache_relative_path: cache_relative_path.clone(),
                        kind: claimed_file.kind,
                        folder_cache_relative_dir: claimed_file.folder_cache_relative_dir.clone(),
                        sha256: sha256.clone(),
                        content: content.clone(),
                    });
                }
            }
            TableSpecArtifact::Absent => {
                if local_sha256.is_some() {
                    plan.deletes.push(PlannedCacheFileDelete {
                        cache_relative_path: cache_relative_path.clone(),
                        claimed_by: Some((
                            claimed_file.kind,
                            claimed_file.folder_cache_relative_dir.clone(),
                        )),
                    });
                }
            }
            TableSpecArtifact::Unreadable { .. } | TableSpecArtifact::Unknown => {}
        }
    }

    if claimed.prune_unclaimed_files {
        // A file that differs from a claimed path only in case is either the claimed file itself (on
        // a case-insensitive filesystem) or a harmless leftover of a case-only rename (on a
        // case-sensitive one). Deleting it could delete the claimed file, so it's kept.
        let lowercase_claimed_paths: BTreeSet<String> = claimed
            .by_cache_relative_path
            .keys()
            .map(|path| path.to_lowercase())
            .collect();
        for owned_file_on_disk in owned_files_on_disk {
            if claimed
                .by_cache_relative_path
                .contains_key(owned_file_on_disk)
                || lowercase_claimed_paths.contains(&owned_file_on_disk.to_lowercase())
            {
                continue;
            }
            plan.deletes.push(PlannedCacheFileDelete {
                cache_relative_path: owned_file_on_disk.clone(),
                claimed_by: None,
            });
        }
    }

    plan
}

// ─────────────────────────────────────────────────────────────────────────────
// Local filesystem
// ─────────────────────────────────────────────────────────────────────────────

pub fn sha256_of_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn absolute_cache_path(cache_dir: &Path, cache_relative_path: &str) -> PathBuf {
    cache_relative_path
        .split('/')
        .fold(cache_dir.to_path_buf(), |path, segment| path.join(segment))
}

/// Hashes the bytes at each claimed path. A missing file is None; any other read error fails the
/// refresh rather than risk planning against a file it couldn't see.
fn read_sha256_of_local_files_at_claimed_paths(
    cache_dir: &Path,
    claimed: &ClaimedCacheFiles,
) -> anyhow::Result<BTreeMap<String, Option<String>>> {
    let mut sha256_by_claimed_path = BTreeMap::new();
    for cache_relative_path in claimed.by_cache_relative_path.keys() {
        let absolute_path = absolute_cache_path(cache_dir, cache_relative_path);
        let local_sha256 = match std::fs::read(&absolute_path) {
            Ok(bytes) => Some(sha256_of_bytes(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(anyhow::anyhow!(
                    "couldn't read {}: {error}",
                    absolute_path.display()
                ))
            }
        };
        sha256_by_claimed_path.insert(cache_relative_path.clone(), local_sha256);
    }
    Ok(sha256_by_claimed_path)
}

/// Every `schema.json` and `views/default.json` under the cache, skipping hidden entries (the same
/// rule the cache loaders use, and where the atomic writer's temp files live).
fn list_owned_files_on_disk(cache_dir: &Path) -> anyhow::Result<BTreeSet<String>> {
    fn walk(
        directory: &Path,
        relative_segments: &mut Vec<String>,
        owned_files: &mut BTreeSet<String>,
    ) -> anyhow::Result<()> {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                relative_segments.push(name);
                walk(&entry.path(), relative_segments, owned_files)?;
                relative_segments.pop();
            } else if file_type.is_file() {
                let is_table_spec = name == TABLE_SPEC_FILE_NAME;
                let is_default_view = name == DEFAULT_VIEW_FILE_NAME
                    && relative_segments.last().map(String::as_str)
                        == Some(DEFAULT_VIEWS_DIRECTORY_NAME);
                if is_table_spec || is_default_view {
                    let mut path_segments = relative_segments.clone();
                    path_segments.push(name);
                    owned_files.insert(path_segments.join("/"));
                }
            }
        }
        Ok(())
    }

    let mut owned_files = BTreeSet::new();
    walk(cache_dir, &mut Vec::new(), &mut owned_files)?;
    Ok(owned_files)
}

/// Deletes a file, then removes its now-empty parent directories up to (never including) the cache
/// directory. A directory that still holds anything, such as a `validation.json`, stays.
fn delete_cache_file_and_empty_parents(
    cache_dir: &Path,
    cache_relative_path: &str,
) -> anyhow::Result<()> {
    let absolute_path = absolute_cache_path(cache_dir, cache_relative_path);
    match std::fs::remove_file(&absolute_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(anyhow::anyhow!(
                "couldn't delete {}: {error}",
                absolute_path.display()
            ))
        }
    }
    let mut parent_directory = absolute_path.parent().map(Path::to_path_buf);
    while let Some(directory) = parent_directory {
        if directory == cache_dir || !directory.starts_with(cache_dir) {
            break;
        }
        if std::fs::remove_dir(&directory).is_err() {
            break;
        }
        parent_directory = directory.parent().map(Path::to_path_buf);
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────

fn folder_key_for_cache_relative_dir(
    conn_dir_name: &str,
    folder_cache_relative_dir: &str,
) -> String {
    if folder_cache_relative_dir.is_empty() {
        conn_dir_name.to_string()
    } else {
        format!("{conn_dir_name}/{folder_cache_relative_dir}")
    }
}

/// One target, planned against one listing.
struct PlannedTarget<'a> {
    target: &'a TableSpecCacheTarget,
    claimed: ClaimedCacheFiles,
    plan: TableSpecCachePlan,
}

fn plan_targets<'a>(
    targets: &'a [TableSpecCacheTarget],
    listing: &WorkbookTableSpecsResponse,
    report_warnings: &mut Vec<String>,
) -> anyhow::Result<Vec<PlannedTarget<'a>>> {
    let mut planned_targets = Vec::new();
    for target in targets {
        let Some(listed_connection) = listing
            .connector_accounts
            .iter()
            .find(|connection| connection.connector_account_id == target.connection_id)
        else {
            report_warnings.push(format!(
                "the server didn't list connection {} ({}); its local table specs were left alone",
                target.conn_dir_name, target.connection_id
            ));
            continue;
        };
        planned_targets.push(plan_target(target, listed_connection)?);
    }
    Ok(planned_targets)
}

fn plan_target<'a>(
    target: &'a TableSpecCacheTarget,
    listed_connection: &WorkbookTableSpecsConnection,
) -> anyhow::Result<PlannedTarget<'a>> {
    let claimed = claim_cache_files_for_connection(&listed_connection.parse_data_folders());
    let sha256_by_claimed_path =
        read_sha256_of_local_files_at_claimed_paths(&target.cache_dir, &claimed)?;
    let owned_files_on_disk = list_owned_files_on_disk(&target.cache_dir)?;
    let plan =
        plan_table_spec_cache_changes(&claimed, &sha256_by_claimed_path, &owned_files_on_disk);
    Ok(PlannedTarget {
        target,
        claimed,
        plan,
    })
}

fn unsupported_format_report(
    listing: &WorkbookTableSpecsResponse,
) -> Option<TableSpecCacheRefreshReport> {
    (listing.format_version > SUPPORTED_WORKBOOK_TABLE_SPECS_FORMAT_VERSION).then(|| {
        TableSpecCacheRefreshReport {
            status: TableSpecCacheRefreshStatus::UnsupportedFormat,
            error: Some(format!(
                "the server sent table-spec format {}, and this scratchmd understands up to {}",
                listing.format_version, SUPPORTED_WORKBOOK_TABLE_SPECS_FORMAT_VERSION
            )),
            ..TableSpecCacheRefreshReport::default()
        }
    })
}

/// Brings every target's cache in step with the server. Never panics and never returns an error: a
/// failure is a `failed` report, and the caller decides whether that fails its command.
///
/// One metadata-only call, scoped to the connection when there's a single target (otherwise to the
/// workbook, and connections without a local target are ignored). A second call fetches content only
/// when some file must be written. Steady state is one small call. The caller holds the workspace
/// lock.
pub(crate) async fn refresh_table_spec_caches_from_server<F: TableSpecListingFetcher>(
    fetcher: &F,
    workbook_id: &str,
    targets: &[TableSpecCacheTarget],
) -> TableSpecCacheRefreshReport {
    if targets.is_empty() {
        return TableSpecCacheRefreshReport::skipped();
    }
    let scoped_connector_account_id = match targets {
        [only_target] => Some(only_target.connection_id.as_str()),
        _ => None,
    };

    let metadata_listing = match fetcher
        .fetch_table_spec_listing(workbook_id, scoped_connector_account_id, true)
        .await
    {
        Ok(listing) => listing,
        Err(error) => return TableSpecCacheRefreshReport::failed(format!("{error:#}")),
    };
    if let Some(report) = unsupported_format_report(&metadata_listing) {
        return report;
    }

    let mut warnings_from_metadata_plan = Vec::new();
    let metadata_planned_targets =
        match plan_targets(targets, &metadata_listing, &mut warnings_from_metadata_plan) {
            Ok(planned_targets) => planned_targets,
            Err(error) => return TableSpecCacheRefreshReport::failed(format!("{error:#}")),
        };
    let needs_content = metadata_planned_targets
        .iter()
        .any(|planned_target| !planned_target.plan.writes.is_empty());

    let mut report = TableSpecCacheRefreshReport {
        status: TableSpecCacheRefreshStatus::Refreshed,
        ..TableSpecCacheRefreshReport::default()
    };
    let planned_targets = if needs_content {
        let content_listing = match fetcher
            .fetch_table_spec_listing(workbook_id, scoped_connector_account_id, false)
            .await
        {
            Ok(listing) => listing,
            Err(error) => return TableSpecCacheRefreshReport::failed(format!("{error:#}")),
        };
        if let Some(report) = unsupported_format_report(&content_listing) {
            return report;
        }
        // Re-plan from the complete content listing: it's newer than the metadata one, and the
        // two may differ if a spec changed in between.
        match plan_targets(targets, &content_listing, &mut report.warnings) {
            Ok(planned_targets) => planned_targets,
            Err(error) => return TableSpecCacheRefreshReport::failed(format!("{error:#}")),
        }
    } else {
        report.warnings.extend(warnings_from_metadata_plan);
        metadata_planned_targets
    };

    let mut folders_with_changed_table_spec = BTreeSet::new();
    let mut folders_with_unreadable_server_spec = BTreeSet::new();
    for PlannedTarget {
        target,
        claimed,
        plan,
    } in planned_targets
    {
        report.warnings.extend(
            claimed
                .warnings
                .iter()
                .map(|warning| format!("{}: {warning}", target.conn_dir_name)),
        );
        folders_with_unreadable_server_spec.extend(
            claimed
                .folder_dirs_with_unreadable_server_spec
                .iter()
                .map(|dir| folder_key_for_cache_relative_dir(&target.conn_dir_name, dir)),
        );

        if let Err(error) = apply_plan_to_cache(
            target,
            &plan,
            &mut report,
            &mut folders_with_changed_table_spec,
        ) {
            report.status = TableSpecCacheRefreshStatus::Failed;
            report.error = Some(format!("{}: {error:#}", target.conn_dir_name));
        }
    }
    report.folders_with_changed_table_spec = folders_with_changed_table_spec.into_iter().collect();
    report.folders_with_unreadable_server_spec =
        folders_with_unreadable_server_spec.into_iter().collect();
    report
}

/// Deletes, then writes. Stops at the first file that fails; the next refresh converges.
fn apply_plan_to_cache(
    target: &TableSpecCacheTarget,
    plan: &TableSpecCachePlan,
    report: &mut TableSpecCacheRefreshReport,
    folders_with_changed_table_spec: &mut BTreeSet<String>,
) -> anyhow::Result<()> {
    for planned_delete in &plan.deletes {
        delete_cache_file_and_empty_parents(
            &target.cache_dir,
            &planned_delete.cache_relative_path,
        )?;
        report.files_deleted += 1;
        if let Some((OwnedCacheFileKind::TableSpec, folder_cache_relative_dir)) =
            &planned_delete.claimed_by
        {
            folders_with_changed_table_spec.insert(folder_key_for_cache_relative_dir(
                &target.conn_dir_name,
                folder_cache_relative_dir,
            ));
        }
    }
    for planned_write in &plan.writes {
        let Some(content) = &planned_write.content else {
            report.warnings.push(format!(
                "{}: the server listed {} without its content; the local copy was kept",
                target.conn_dir_name, planned_write.cache_relative_path
            ));
            continue;
        };
        crate::shared::atomic_json_state::write_bytes_to_file_atomically(
            &absolute_cache_path(&target.cache_dir, &planned_write.cache_relative_path),
            content.as_bytes(),
        )?;
        match planned_write.kind {
            OwnedCacheFileKind::TableSpec => {
                report.schema_files_written += 1;
                folders_with_changed_table_spec.insert(folder_key_for_cache_relative_dir(
                    &target.conn_dir_name,
                    &planned_write.folder_cache_relative_dir,
                ));
            }
            OwnedCacheFileKind::DefaultView => report.default_view_files_written += 1,
        }
    }
    Ok(())
}

/// [`refresh_table_spec_caches_from_server`], then (when asked) clears the DEV-10518
/// `enforce_schema` results of every folder whose `schema.json` changed. A reconcile failure is a
/// warning: the refresh itself succeeded.
pub(crate) async fn refresh_table_spec_caches_and_reconcile_enforce_schema_results<
    F: TableSpecListingFetcher,
>(
    fetcher: &F,
    workspace_dir: &Path,
    workbook_id: &str,
    targets: &[TableSpecCacheTarget],
    reconcile_enforce_schema_results: bool,
) -> TableSpecCacheRefreshReport {
    let mut report = refresh_table_spec_caches_from_server(fetcher, workbook_id, targets).await;
    if reconcile_enforce_schema_results && !report.folders_with_changed_table_spec.is_empty() {
        if let Err(error) = folder_index::reconcile_enforce_schema_results_after_schema_change(
            workspace_dir,
            &report.folders_with_changed_table_spec,
            None,
        ) {
            report.warnings.push(format!(
                "couldn't clear the stale schema validation results of the changed folders: {error:#}"
            ));
        }
    }
    report
}

#[cfg(test)]
#[path = "tests/table_spec_cache_refresh.rs"]
mod tests;
