//! Pure planning for `scratchmd routines` (DEV-12617) — no disk I/O, no HTTP.
//!
//! Everything that decides *what* pull / status / push should do lives here so it can be
//! unit-tested exhaustively; `local_routine_files.rs` does the disk I/O and `routines.rs` the
//! HTTP. Three inputs drive every decision, all keyed by server-relative routine path
//! (`routines/<name>.yaml`):
//!
//! - the manifest (`.scratch/routines-state.json`): each file's server version and content hash
//!   at the last pull/push — the merge base;
//! - the local scan of `.scratch/routines/`: each file's exact bytes and their hash;
//! - the server listing (`GET …/routines/files`): each file's version (and content, for pull).

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Context;
use sha2::{Digest, Sha256};

use crate::api::{
    PushRoutineFileDelete, PushRoutineFileUpsert, PushRoutineFilesRequest, PushRoutineStaleFile,
    RoutineFileVersion, RoutineFileWithVersion,
};
use crate::config::routines_state_manifest::{
    RoutineFileStateAtLastSync, RoutineFileStateAtLastSyncByServerPath,
};

/// Every routine file's server path is `routines/<name>.yaml`; locally it is
/// `.scratch/routines/<name>.yaml`.
pub(crate) const SERVER_ROUTINE_PATH_PREFIX: &str = "routines/";

/// Lowercase hex SHA-256 of `bytes` — the content identity used throughout routines sync.
pub(crate) fn sha256_hex_of_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// ── The routine file-name rule ───────────────────────────────────────────────────────────────

/// Why a name can't be a routine file in `.scratch/routines/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DisallowedRoutineFileNameReason {
    NotInsideRoutinesDirectory,
    EmptyName,
    ContainsPathSeparator,
    HiddenName,
    ContainsDoubleDot,
    NotLowercaseYamlExtension,
}

impl DisallowedRoutineFileNameReason {
    pub(crate) fn describe(self) -> &'static str {
        match self {
            Self::NotInsideRoutinesDirectory => "routine files must be inside `routines/`",
            Self::EmptyName => "the file name is empty",
            Self::ContainsPathSeparator => {
                "routine files must sit directly inside the routines directory (no subdirectories)"
            }
            Self::HiddenName => "hidden names (starting with `.`) are not routine files",
            Self::ContainsDoubleDot => "routine file names must not contain `..`",
            Self::NotLowercaseYamlExtension => {
                "routine files must end with .yaml or .yml (lowercase)"
            }
        }
    }
}

/// The one file-name rule shared by the local scan, server-path validation, and push: a
/// non-empty, non-hidden name without path separators or `..`, ending in exactly `.yaml` or
/// `.yml` (case-sensitive, like the server). Hidden names are excluded so our own
/// `.<name>.tmp.<pid>` atomic-write temp files, editor lock files, and macOS AppleDouble files
/// are never mistaken for routines.
pub(crate) fn check_routine_file_name_is_allowed(
    file_name: &str,
) -> Result<(), DisallowedRoutineFileNameReason> {
    if file_name.is_empty() {
        return Err(DisallowedRoutineFileNameReason::EmptyName);
    }
    if file_name.contains('/') || file_name.contains('\\') {
        return Err(DisallowedRoutineFileNameReason::ContainsPathSeparator);
    }
    if file_name.starts_with('.') {
        return Err(DisallowedRoutineFileNameReason::HiddenName);
    }
    if file_name.contains("..") {
        return Err(DisallowedRoutineFileNameReason::ContainsDoubleDot);
    }
    if !(file_name.ends_with(".yaml") || file_name.ends_with(".yml")) {
        return Err(DisallowedRoutineFileNameReason::NotLowercaseYamlExtension);
    }
    Ok(())
}

pub(crate) fn server_routine_path_for_file_name(file_name: &str) -> String {
    format!("{SERVER_ROUTINE_PATH_PREFIX}{file_name}")
}

/// The local file name for a server routine path, when it is one this workspace can store:
/// `routines/<name>` with `<name>` passing [`check_routine_file_name_is_allowed`].
pub(crate) fn routine_file_name_for_server_path(
    server_relative_path: &str,
) -> Result<&str, DisallowedRoutineFileNameReason> {
    let file_name = server_relative_path
        .strip_prefix(SERVER_ROUTINE_PATH_PREFIX)
        .ok_or(DisallowedRoutineFileNameReason::NotInsideRoutinesDirectory)?;
    check_routine_file_name_is_allowed(file_name)?;
    Ok(file_name)
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────

/// One file from the local scan of `.scratch/routines/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalRoutineFile {
    pub file_bytes: Vec<u8>,
    pub file_bytes_sha256_hex: String,
}

impl LocalRoutineFile {
    pub(crate) fn from_bytes(file_bytes: Vec<u8>) -> Self {
        let file_bytes_sha256_hex = sha256_hex_of_bytes(&file_bytes);
        Self {
            file_bytes,
            file_bytes_sha256_hex,
        }
    }
}

pub(crate) type LocalRoutineFilesByServerPath = BTreeMap<String, LocalRoutineFile>;

/// One file from the server listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerRoutineFile {
    pub version: i64,
    /// The YAML text — present in a full listing (pull), absent in a metadata-only one (status).
    pub content: Option<String>,
}

/// A server routine file pull needs to write: version, content, and the content's hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerRoutineFileWithContent {
    pub version: i64,
    pub content: String,
    pub content_sha256_hex: String,
}

/// A server routine path this workspace can't store, so it is left alone (never written,
/// never tracked in the manifest, never pushed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerRoutinePathSkippedAsUnusableLocally {
    pub server_relative_path: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub(crate) struct IndexedServerRoutineFiles {
    pub server_routine_files_by_path: BTreeMap<String, ServerRoutineFile>,
    pub server_routine_paths_skipped_as_unusable_locally:
        Vec<ServerRoutinePathSkippedAsUnusableLocally>,
}

impl IndexedServerRoutineFiles {
    pub(crate) fn skipped_server_routine_paths(&self) -> BTreeSet<String> {
        self.server_routine_paths_skipped_as_unusable_locally
            .iter()
            .map(|skipped| skipped.server_relative_path.clone())
            .collect()
    }
}

/// Index the server listing by path, skipping paths this workspace can't store:
///
/// - names that break the file-name rule — e.g. a hidden `routines/.x.yaml`, which the server
///   allows but our scan deliberately ignores (it would read as deleted forever);
/// - names that differ only by letter case (`routines/A.yaml` vs `routines/a.yaml`): on a
///   case-insensitive filesystem (macOS / Windows default) both would land in one file, one
///   would then read as deleted, and a push would delete it on the server.
pub(crate) fn index_server_routine_files_skipping_paths_unusable_locally(
    listed_server_routine_files: Vec<RoutineFileWithVersion>,
) -> IndexedServerRoutineFiles {
    let mut indexed = IndexedServerRoutineFiles::default();

    let mut storable_files_with_lowercase_name = Vec::new();
    for listed_file in listed_server_routine_files {
        match routine_file_name_for_server_path(&listed_file.path) {
            Ok(file_name) => {
                storable_files_with_lowercase_name.push((file_name.to_lowercase(), listed_file))
            }
            Err(disallowed_reason) => indexed
                .server_routine_paths_skipped_as_unusable_locally
                .push(ServerRoutinePathSkippedAsUnusableLocally {
                    server_relative_path: listed_file.path.clone(),
                    reason: disallowed_reason.describe().to_string(),
                }),
        }
    }

    let mut server_paths_by_lowercase_file_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (lowercase_file_name, listed_file) in &storable_files_with_lowercase_name {
        server_paths_by_lowercase_file_name
            .entry(lowercase_file_name.clone())
            .or_default()
            .push(listed_file.path.clone());
    }

    for (lowercase_file_name, listed_file) in storable_files_with_lowercase_name {
        let server_paths_sharing_this_name =
            &server_paths_by_lowercase_file_name[&lowercase_file_name];
        if server_paths_sharing_this_name.len() > 1 {
            let other_server_paths = server_paths_sharing_this_name
                .iter()
                .filter(|other_path| **other_path != listed_file.path)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            indexed
                .server_routine_paths_skipped_as_unusable_locally
                .push(ServerRoutinePathSkippedAsUnusableLocally {
                    server_relative_path: listed_file.path,
                    reason: format!(
                        "it differs from {other_server_paths} only by letter case, which case-insensitive filesystems can't store side by side"
                    ),
                });
            continue;
        }
        indexed.server_routine_files_by_path.insert(
            listed_file.path,
            ServerRoutineFile {
                version: listed_file.version,
                content: listed_file.content,
            },
        );
    }

    indexed
        .server_routine_paths_skipped_as_unusable_locally
        .sort_by(|left, right| left.server_relative_path.cmp(&right.server_relative_path));
    indexed
}

/// Pull needs every file's content; a listing without it is a server contract violation.
pub(crate) fn require_content_for_every_server_routine_file(
    server_routine_files_by_path: BTreeMap<String, ServerRoutineFile>,
) -> anyhow::Result<BTreeMap<String, ServerRoutineFileWithContent>> {
    server_routine_files_by_path
        .into_iter()
        .map(|(server_relative_path, server_file)| {
            let content = server_file.content.ok_or_else(|| {
                anyhow::anyhow!("the server listed {server_relative_path} without its content")
            })?;
            let content_sha256_hex = sha256_hex_of_bytes(content.as_bytes());
            Ok((
                server_relative_path,
                ServerRoutineFileWithContent {
                    version: server_file.version,
                    content,
                    content_sha256_hex,
                },
            ))
        })
        .collect()
}

// ── Change classification ────────────────────────────────────────────────────────────────────

/// How a routine file changed relative to the manifest. Serialized as `"added"` /
/// `"modified"` / `"deleted"` in the `--json` contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RoutineFileChangeKind {
    Added,
    Modified,
    Deleted,
}

impl RoutineFileChangeKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
        }
    }
}

/// The change from `state_at_last_sync` to `current_state`, where `None` means "absent" and the
/// state is a content hash or a server version.
fn classify_change_since_last_sync<T: PartialEq>(
    state_at_last_sync: Option<T>,
    current_state: Option<T>,
) -> Option<RoutineFileChangeKind> {
    match (state_at_last_sync, current_state) {
        (None, None) => None,
        (None, Some(_)) => Some(RoutineFileChangeKind::Added),
        (Some(_), None) => Some(RoutineFileChangeKind::Deleted),
        (Some(last_sync), Some(current)) if last_sync != current => {
            Some(RoutineFileChangeKind::Modified)
        }
        (Some(_), Some(_)) => None,
    }
}

/// Local routine edits not yet pushed: files on disk vs the manifest's content hashes.
pub(crate) fn classify_local_routine_changes_against_manifest(
    manifest_files_at_last_sync: &RoutineFileStateAtLastSyncByServerPath,
    local_routine_files_by_path: &LocalRoutineFilesByServerPath,
) -> Vec<(String, RoutineFileChangeKind)> {
    let every_known_path: BTreeSet<&String> = manifest_files_at_last_sync
        .keys()
        .chain(local_routine_files_by_path.keys())
        .collect();
    every_known_path
        .into_iter()
        .filter_map(|server_relative_path| {
            classify_change_since_last_sync(
                manifest_files_at_last_sync
                    .get(server_relative_path)
                    .map(|state| state.sha256.as_str()),
                local_routine_files_by_path
                    .get(server_relative_path)
                    .map(|local_file| local_file.file_bytes_sha256_hex.as_str()),
            )
            .map(|change| (server_relative_path.clone(), change))
        })
        .collect()
}

/// Server routine changes not yet pulled, by version (all a metadata-only listing carries).
/// Skipped server paths are ignored: they are neither pullable nor deleted.
pub(crate) fn classify_server_routine_changes_against_manifest_by_version(
    manifest_files_at_last_sync: &RoutineFileStateAtLastSyncByServerPath,
    server_routine_files_by_path: &BTreeMap<String, ServerRoutineFile>,
    server_routine_paths_skipped_as_unusable_locally: &BTreeSet<String>,
) -> Vec<(String, RoutineFileChangeKind)> {
    let every_known_path: BTreeSet<&String> = manifest_files_at_last_sync
        .keys()
        .chain(server_routine_files_by_path.keys())
        .filter(|server_relative_path| {
            !server_routine_paths_skipped_as_unusable_locally.contains(*server_relative_path)
        })
        .collect();
    every_known_path
        .into_iter()
        .filter_map(|server_relative_path| {
            classify_change_since_last_sync(
                manifest_files_at_last_sync
                    .get(server_relative_path)
                    .map(|state| state.version),
                server_routine_files_by_path
                    .get(server_relative_path)
                    .map(|server_file| server_file.version),
            )
            .map(|change| (server_relative_path.clone(), change))
        })
        .collect()
}

// ── pull ─────────────────────────────────────────────────────────────────────────────────────

/// One change pull makes on disk. Each carries the hash the file must still have (or, when
/// `None`, that it must not exist) right before the change, so an edit saved while the pull
/// runs — or a case-variant name on a case-insensitive filesystem — aborts the pull instead of
/// being clobbered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlannedLocalRoutineFileOperation {
    DeleteLocalFile {
        server_relative_path: String,
        expected_sha256_hex_on_disk: String,
    },
    WriteServerContent {
        server_relative_path: String,
        content: String,
        expected_sha256_hex_on_disk_before_write: Option<String>,
    },
}

/// A file that changed both locally and on the server, to different content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoutinePullConflict {
    pub server_relative_path: String,
    pub local_change: RoutineFileChangeKind,
    pub server_change: RoutineFileChangeKind,
}

#[derive(Debug, Default)]
pub(crate) struct RoutinePullPlan {
    /// Deletes first, then writes: on a case-insensitive filesystem a write of `Daily.yaml`
    /// followed by the delete of `daily.yaml` would remove the file just written.
    pub local_file_operations_deletes_before_writes: Vec<PlannedLocalRoutineFileOperation>,
    pub manifest_files_after_successful_pull: RoutineFileStateAtLastSyncByServerPath,
    /// Server changes since the last pull/push (the incoming change set), whatever the local state.
    pub server_paths_added_since_last_sync: Vec<String>,
    pub server_paths_modified_since_last_sync: Vec<String>,
    pub server_paths_deleted_since_last_sync: Vec<String>,
    /// Local edits replaced by the server copy because of `--discard-local`.
    pub local_edits_discarded: Vec<String>,
    /// Non-empty means the pull must be refused (nothing written) — only without `--discard-local`.
    pub conflicts_between_local_and_server_changes: Vec<RoutinePullConflict>,
}

/// Plan a pull as a per-file three-way merge between the manifest (base), the local files, and
/// the server, comparing **content hashes** — versions are only recorded for the push guard.
/// Hashes catch a server delete→recreate (its version restarts at 1) and don't mistake a version
/// bump with identical content for a change.
///
/// | server vs base | local vs base | outcome |
/// |---|---|---|
/// | unchanged | unchanged | nothing |
/// | unchanged | edited/deleted | keep local — or restore the server copy with `--discard-local` |
/// | — (local-only new file) | added | never touched, even with `--discard-local` |
/// | changed | unchanged | apply the server change |
/// | changed | changed to the same content | nothing (converged) |
/// | changed | changed differently | conflict — or take the server copy with `--discard-local` |
pub(crate) fn plan_three_way_routine_pull_by_content_hash(
    manifest_files_at_last_sync: &RoutineFileStateAtLastSyncByServerPath,
    local_routine_files_by_path: &LocalRoutineFilesByServerPath,
    server_routine_files_by_path: &BTreeMap<String, ServerRoutineFileWithContent>,
    server_routine_paths_skipped_as_unusable_locally: &BTreeSet<String>,
    discard_local_edits_to_server_tracked_files: bool,
) -> RoutinePullPlan {
    let mut plan = RoutinePullPlan::default();
    let mut planned_deletes = Vec::new();
    let mut planned_writes = Vec::new();

    let every_known_path: BTreeSet<&String> = manifest_files_at_last_sync
        .keys()
        .chain(local_routine_files_by_path.keys())
        .chain(server_routine_files_by_path.keys())
        .filter(|server_relative_path| {
            !server_routine_paths_skipped_as_unusable_locally.contains(*server_relative_path)
        })
        .collect();

    for server_relative_path in every_known_path {
        let content_hash_at_last_sync = manifest_files_at_last_sync
            .get(server_relative_path)
            .map(|state| state.sha256.as_str());
        let local_content_hash = local_routine_files_by_path
            .get(server_relative_path)
            .map(|local_file| local_file.file_bytes_sha256_hex.as_str());
        let server_file = server_routine_files_by_path.get(server_relative_path);
        let server_content_hash = server_file.map(|file| file.content_sha256_hex.as_str());

        let server_change =
            classify_change_since_last_sync(content_hash_at_last_sync, server_content_hash);
        let local_change =
            classify_change_since_last_sync(content_hash_at_last_sync, local_content_hash);

        match server_change {
            Some(RoutineFileChangeKind::Added) => plan
                .server_paths_added_since_last_sync
                .push(server_relative_path.clone()),
            Some(RoutineFileChangeKind::Modified) => plan
                .server_paths_modified_since_last_sync
                .push(server_relative_path.clone()),
            Some(RoutineFileChangeKind::Deleted) => plan
                .server_paths_deleted_since_last_sync
                .push(server_relative_path.clone()),
            None => {}
        }

        let should_make_local_file_match_server = match (server_change, local_change) {
            (None, None) => false,
            // A local-only new file — never pushed, not on the server — is never touched.
            (None, Some(_)) if content_hash_at_last_sync.is_none() => false,
            // The server copy is unchanged; keep the local edit/delete unless discarding.
            (None, Some(_)) => {
                if discard_local_edits_to_server_tracked_files {
                    plan.local_edits_discarded
                        .push(server_relative_path.clone());
                }
                discard_local_edits_to_server_tracked_files
            }
            // The server changed a file the user didn't touch: apply it.
            (Some(_), None) => true,
            // Both sides made the same change (including both deleting): already converged.
            (Some(_), Some(_)) if local_content_hash == server_content_hash => false,
            (Some(server_change), Some(local_change)) => {
                if discard_local_edits_to_server_tracked_files {
                    plan.local_edits_discarded
                        .push(server_relative_path.clone());
                } else {
                    plan.conflicts_between_local_and_server_changes
                        .push(RoutinePullConflict {
                            server_relative_path: server_relative_path.clone(),
                            local_change,
                            server_change,
                        });
                }
                discard_local_edits_to_server_tracked_files
            }
        };

        if should_make_local_file_match_server {
            match (server_file, local_content_hash) {
                (Some(server_file), _) => {
                    planned_writes.push(PlannedLocalRoutineFileOperation::WriteServerContent {
                        server_relative_path: server_relative_path.clone(),
                        content: server_file.content.clone(),
                        expected_sha256_hex_on_disk_before_write: local_content_hash
                            .map(str::to_string),
                    })
                }
                (None, Some(local_content_hash)) => {
                    planned_deletes.push(PlannedLocalRoutineFileOperation::DeleteLocalFile {
                        server_relative_path: server_relative_path.clone(),
                        expected_sha256_hex_on_disk: local_content_hash.to_string(),
                    })
                }
                (None, None) => {}
            }
        }
    }

    plan.local_file_operations_deletes_before_writes = planned_deletes;
    plan.local_file_operations_deletes_before_writes
        .extend(planned_writes);

    plan.manifest_files_after_successful_pull = server_routine_files_by_path
        .iter()
        .map(|(server_relative_path, server_file)| {
            (
                server_relative_path.clone(),
                RoutineFileStateAtLastSync {
                    version: server_file.version,
                    sha256: server_file.content_sha256_hex.clone(),
                },
            )
        })
        .collect();
    // Skipped server paths are left exactly as the manifest last knew them.
    for skipped_server_path in server_routine_paths_skipped_as_unusable_locally {
        if let Some(state_at_last_sync) = manifest_files_at_last_sync.get(skipped_server_path) {
            plan.manifest_files_after_successful_pull
                .insert(skipped_server_path.clone(), state_at_last_sync.clone());
        }
    }

    plan
}

pub(crate) fn format_routine_pull_conflicts_message(conflicts: &[RoutinePullConflict]) -> String {
    let mut message = String::from(
        "Pull refused — nothing was changed. These routines changed both locally and on the server:\n",
    );
    for conflict in conflicts {
        message.push_str(&format!(
            "  {} (local: {}, server: {})\n",
            conflict.server_relative_path,
            conflict.local_change.as_str(),
            conflict.server_change.as_str()
        ));
    }
    message.push_str(
        "Copy your local version somewhere safe, then run `scratchmd routines pull --discard-local` to take the server's version, re-apply your edits, and push.",
    );
    message
}

// ── push ─────────────────────────────────────────────────────────────────────────────────────

/// The local changes to push, plus the hash of each upserted file's exact bytes (recorded in the
/// manifest once the push succeeds).
#[derive(Debug, Clone, Default)]
pub(crate) struct RoutinePushChangeSet {
    pub upserts: Vec<PushRoutineFileUpsert>,
    pub deletes: Vec<PushRoutineFileDelete>,
    pub pushed_content_sha256_hex_by_server_path: BTreeMap<String, String>,
}

impl RoutinePushChangeSet {
    pub(crate) fn is_empty(&self) -> bool {
        self.upserts.is_empty() && self.deletes.is_empty()
    }

    pub(crate) fn to_push_request(&self) -> PushRoutineFilesRequest {
        PushRoutineFilesRequest {
            upserts: self.upserts.clone(),
            deletes: self.deletes.clone(),
        }
    }
}

/// Turn local changes (vs the manifest) into a push: a new file is sent with
/// `baseVersion: null` ("expect new"), an edited one with its manifest version, and a deleted one
/// as a delete carrying its manifest version — so the server refuses the push if any of those
/// files changed since the last pull. Upserts must be UTF-8 text without NUL bytes and pass the
/// light local YAML check; errors name the path.
pub(crate) fn build_routine_push_change_set_from_local_changes(
    manifest_files_at_last_sync: &RoutineFileStateAtLastSyncByServerPath,
    local_routine_files_by_path: &LocalRoutineFilesByServerPath,
) -> anyhow::Result<RoutinePushChangeSet> {
    let mut change_set = RoutinePushChangeSet::default();
    for (server_relative_path, local_change) in classify_local_routine_changes_against_manifest(
        manifest_files_at_last_sync,
        local_routine_files_by_path,
    ) {
        let version_at_last_sync = manifest_files_at_last_sync
            .get(&server_relative_path)
            .map(|state| state.version);
        match (local_change, version_at_last_sync) {
            (RoutineFileChangeKind::Deleted, Some(version_at_last_sync)) => {
                change_set.deletes.push(PushRoutineFileDelete {
                    path: server_relative_path,
                    base_version: version_at_last_sync,
                })
            }
            // A delete always has a manifest entry; nothing to push otherwise.
            (RoutineFileChangeKind::Deleted, None) => {}
            (RoutineFileChangeKind::Added | RoutineFileChangeKind::Modified, _) => {
                let local_file = &local_routine_files_by_path[&server_relative_path];
                let content = routine_file_bytes_as_pushable_text(
                    &server_relative_path,
                    &local_file.file_bytes,
                )?;
                validate_routine_yaml(&server_relative_path, &content)?;
                change_set.pushed_content_sha256_hex_by_server_path.insert(
                    server_relative_path.clone(),
                    local_file.file_bytes_sha256_hex.clone(),
                );
                change_set.upserts.push(PushRoutineFileUpsert {
                    path: server_relative_path,
                    content,
                    base_version: version_at_last_sync,
                });
            }
        }
    }
    Ok(change_set)
}

fn routine_file_bytes_as_pushable_text(
    server_relative_path: &str,
    file_bytes: &[u8],
) -> anyhow::Result<String> {
    let text = String::from_utf8(file_bytes.to_vec()).map_err(|_| {
        anyhow::anyhow!(
            "{server_relative_path}: not valid UTF-8 text — routine files must be UTF-8 YAML"
        )
    })?;
    if text.contains('\0') {
        anyhow::bail!(
            "{server_relative_path}: contains a NUL byte, which routine files can't store"
        );
    }
    Ok(text)
}

/// Light, CLI-side structural validation for fast feedback before a push. The server's
/// RoutineParserService / reference validator remain authoritative (they alone can resolve a
/// workbook's folders/connections), so this only catches the obvious local mistakes.
pub(crate) fn validate_routine_yaml(path: &str, content: &str) -> anyhow::Result<()> {
    if !path.ends_with(".yaml") && !path.ends_with(".yml") {
        anyhow::bail!("{path}: routine files must end with .yaml or .yml");
    }
    let value: serde_yaml::Value =
        serde_yaml::from_str(content).with_context(|| format!("{path}: invalid YAML"))?;
    let mapping = value
        .as_mapping()
        .ok_or_else(|| anyhow::anyhow!("{path}: a routine must be a YAML mapping"))?;

    let has_name = mapping
        .get("name")
        .and_then(|name| name.as_str())
        .map(|name| !name.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        anyhow::bail!("{path}: a routine must have a non-empty `name`");
    }

    let has_steps = mapping
        .get("steps")
        .and_then(|steps| steps.as_sequence())
        .map(|steps| !steps.is_empty())
        .unwrap_or(false);
    if !has_steps {
        anyhow::bail!("{path}: a routine must have at least one entry under `steps`");
    }

    Ok(())
}

#[derive(Debug, Default)]
pub(crate) struct ManifestMergeAfterSuccessfulPush {
    pub manifest_files_after_push: RoutineFileStateAtLastSyncByServerPath,
    pub server_version_by_pushed_upsert_path: BTreeMap<String, i64>,
    /// Upserts the server's response didn't list — their manifest entries are left unchanged
    /// (a later pull converges them).
    pub pushed_upsert_paths_missing_from_server_response: Vec<String>,
}

/// Fold a successful push into the manifest: each pushed upsert gets the version the server
/// returned plus the hash of the bytes actually pushed; each pushed delete is dropped. **Every
/// other entry is left unchanged** — the response lists the full post-push set, including files
/// others changed whose new content this workspace hasn't pulled, and recording those versions
/// would make the stale local copies look current.
pub(crate) fn merge_successful_routine_push_into_manifest_files(
    manifest_files_before_push: &RoutineFileStateAtLastSyncByServerPath,
    pushed_change_set: &RoutinePushChangeSet,
    server_file_versions_after_push: &[RoutineFileVersion],
) -> ManifestMergeAfterSuccessfulPush {
    let server_version_by_path_after_push: BTreeMap<&str, i64> = server_file_versions_after_push
        .iter()
        .map(|file_version| (file_version.path.as_str(), file_version.version))
        .collect();

    let mut merge = ManifestMergeAfterSuccessfulPush {
        manifest_files_after_push: manifest_files_before_push.clone(),
        ..Default::default()
    };
    for pushed_delete in &pushed_change_set.deletes {
        merge.manifest_files_after_push.remove(&pushed_delete.path);
    }
    for pushed_upsert in &pushed_change_set.upserts {
        let Some(&server_version_after_push) =
            server_version_by_path_after_push.get(pushed_upsert.path.as_str())
        else {
            merge
                .pushed_upsert_paths_missing_from_server_response
                .push(pushed_upsert.path.clone());
            continue;
        };
        let pushed_content_sha256_hex = pushed_change_set
            .pushed_content_sha256_hex_by_server_path
            .get(&pushed_upsert.path)
            .cloned()
            .unwrap_or_else(|| sha256_hex_of_bytes(pushed_upsert.content.as_bytes()));
        merge.manifest_files_after_push.insert(
            pushed_upsert.path.clone(),
            RoutineFileStateAtLastSync {
                version: server_version_after_push,
                sha256: pushed_content_sha256_hex,
            },
        );
        merge
            .server_version_by_pushed_upsert_path
            .insert(pushed_upsert.path.clone(), server_version_after_push);
    }
    merge
}

pub(crate) fn format_blocked_stale_routine_push_message(
    stale_files: &[PushRoutineStaleFile],
) -> String {
    let mut message = String::from(
        "Push refused — nothing was saved. These routines changed on the server since your last pull:\n",
    );
    for stale_file in stale_files {
        message.push_str(&format!(
            "  {} ({})\n",
            stale_file.path,
            describe_why_routine_file_is_stale(stale_file)
        ));
    }
    message.push_str("Run `scratchmd routines pull`, then retry the push.");
    message
}

fn describe_why_routine_file_is_stale(stale_file: &PushRoutineStaleFile) -> String {
    match (stale_file.base_version, stale_file.current_version) {
        (Some(base_version), Some(current_version)) => format!(
            "your copy is based on version {base_version}; the server is at version {current_version}"
        ),
        (None, Some(current_version)) => format!(
            "you created it, but the server already has version {current_version}"
        ),
        (Some(base_version), None) => format!(
            "deleted on the server; your copy is based on version {base_version}"
        ),
        (None, None) => "changed on the server".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAILY: &str = "routines/daily.yaml";
    const WEEKLY: &str = "routines/weekly.yaml";

    fn manifest_of(entries: &[(&str, i64, &str)]) -> RoutineFileStateAtLastSyncByServerPath {
        entries
            .iter()
            .map(|(path, version, content)| {
                (
                    path.to_string(),
                    RoutineFileStateAtLastSync {
                        version: *version,
                        sha256: sha256_hex_of_bytes(content.as_bytes()),
                    },
                )
            })
            .collect()
    }

    fn local_files_of(entries: &[(&str, &str)]) -> LocalRoutineFilesByServerPath {
        entries
            .iter()
            .map(|(path, content)| {
                (
                    path.to_string(),
                    LocalRoutineFile::from_bytes(content.as_bytes().to_vec()),
                )
            })
            .collect()
    }

    fn server_files_of(
        entries: &[(&str, i64, &str)],
    ) -> BTreeMap<String, ServerRoutineFileWithContent> {
        entries
            .iter()
            .map(|(path, version, content)| {
                (
                    path.to_string(),
                    ServerRoutineFileWithContent {
                        version: *version,
                        content: content.to_string(),
                        content_sha256_hex: sha256_hex_of_bytes(content.as_bytes()),
                    },
                )
            })
            .collect()
    }

    fn plan_pull(
        manifest: &RoutineFileStateAtLastSyncByServerPath,
        local: &LocalRoutineFilesByServerPath,
        server: &BTreeMap<String, ServerRoutineFileWithContent>,
        discard_local: bool,
    ) -> RoutinePullPlan {
        plan_three_way_routine_pull_by_content_hash(
            manifest,
            local,
            server,
            &BTreeSet::new(),
            discard_local,
        )
    }

    fn write_op(
        path: &str,
        content: &str,
        expected_before: Option<&str>,
    ) -> PlannedLocalRoutineFileOperation {
        PlannedLocalRoutineFileOperation::WriteServerContent {
            server_relative_path: path.to_string(),
            content: content.to_string(),
            expected_sha256_hex_on_disk_before_write: expected_before
                .map(|content| sha256_hex_of_bytes(content.as_bytes())),
        }
    }

    fn delete_op(path: &str, expected_content: &str) -> PlannedLocalRoutineFileOperation {
        PlannedLocalRoutineFileOperation::DeleteLocalFile {
            server_relative_path: path.to_string(),
            expected_sha256_hex_on_disk: sha256_hex_of_bytes(expected_content.as_bytes()),
        }
    }

    fn listed(path: &str, version: i64) -> RoutineFileWithVersion {
        RoutineFileWithVersion {
            path: path.to_string(),
            version,
            content: Some(format!("name: {path}\nsteps:\n  - action: pull\n")),
        }
    }

    // ── file-name rule ──

    #[test]
    fn routine_file_name_rule_accepts_lowercase_yaml_and_yml_and_rejects_everything_else() {
        assert_eq!(check_routine_file_name_is_allowed("daily.yaml"), Ok(()));
        assert_eq!(check_routine_file_name_is_allowed("daily-sync.yml"), Ok(()));
        for (file_name, expected_reason) in [
            ("", DisallowedRoutineFileNameReason::EmptyName),
            (".daily.yaml", DisallowedRoutineFileNameReason::HiddenName),
            (
                ".daily.yaml.tmp.123",
                DisallowedRoutineFileNameReason::HiddenName,
            ),
            ("._daily.yaml", DisallowedRoutineFileNameReason::HiddenName),
            (
                "sub/daily.yaml",
                DisallowedRoutineFileNameReason::ContainsPathSeparator,
            ),
            (
                "sub\\daily.yaml",
                DisallowedRoutineFileNameReason::ContainsPathSeparator,
            ),
            (
                "a..b.yaml",
                DisallowedRoutineFileNameReason::ContainsDoubleDot,
            ),
            (
                "daily.YAML",
                DisallowedRoutineFileNameReason::NotLowercaseYamlExtension,
            ),
            (
                "daily.txt",
                DisallowedRoutineFileNameReason::NotLowercaseYamlExtension,
            ),
            (
                "daily.yaml~",
                DisallowedRoutineFileNameReason::NotLowercaseYamlExtension,
            ),
        ] {
            assert_eq!(
                check_routine_file_name_is_allowed(file_name),
                Err(expected_reason),
                "{file_name:?}"
            );
        }
        assert_eq!(routine_file_name_for_server_path(DAILY), Ok("daily.yaml"));
        assert_eq!(
            routine_file_name_for_server_path("syncs/daily.yaml"),
            Err(DisallowedRoutineFileNameReason::NotInsideRoutinesDirectory)
        );
        assert_eq!(
            routine_file_name_for_server_path("routines/nested/daily.yaml"),
            Err(DisallowedRoutineFileNameReason::ContainsPathSeparator)
        );
    }

    // ── server listing ──

    #[test]
    fn server_paths_that_break_the_file_name_rule_are_skipped_with_a_reason() {
        let indexed = index_server_routine_files_skipping_paths_unusable_locally(vec![
            listed(DAILY, 1),
            listed("routines/.hidden.yaml", 2),
        ]);
        assert_eq!(
            indexed
                .server_routine_files_by_path
                .keys()
                .collect::<Vec<_>>(),
            vec![DAILY]
        );
        assert_eq!(
            indexed.skipped_server_routine_paths(),
            BTreeSet::from(["routines/.hidden.yaml".to_string()])
        );
        assert!(indexed.server_routine_paths_skipped_as_unusable_locally[0]
            .reason
            .contains("hidden"));
    }

    #[test]
    fn server_paths_differing_only_by_letter_case_are_all_skipped() {
        let indexed = index_server_routine_files_skipping_paths_unusable_locally(vec![
            listed("routines/Daily.yaml", 1),
            listed(DAILY, 1),
            listed(WEEKLY, 3),
        ]);
        assert_eq!(
            indexed
                .server_routine_files_by_path
                .keys()
                .collect::<Vec<_>>(),
            vec![WEEKLY]
        );
        assert_eq!(
            indexed.skipped_server_routine_paths(),
            BTreeSet::from(["routines/Daily.yaml".to_string(), DAILY.to_string()])
        );
        assert!(indexed.server_routine_paths_skipped_as_unusable_locally[0]
            .reason
            .contains("letter case"));
    }

    #[test]
    fn pull_requires_content_for_every_listed_server_file() {
        let mut server_files = BTreeMap::new();
        server_files.insert(
            DAILY.to_string(),
            ServerRoutineFile {
                version: 1,
                content: None,
            },
        );
        let error = require_content_for_every_server_routine_file(server_files).unwrap_err();
        assert!(error.to_string().contains(DAILY));
    }

    // ── change classification ──

    #[test]
    fn local_changes_are_classified_against_manifest_hashes() {
        let manifest = manifest_of(&[
            (DAILY, 1, "a"),
            (WEEKLY, 2, "w"),
            ("routines/same.yaml", 1, "s"),
        ]);
        let local = local_files_of(&[
            (DAILY, "a-edited"),
            ("routines/new.yaml", "n"),
            ("routines/same.yaml", "s"),
        ]);
        assert_eq!(
            classify_local_routine_changes_against_manifest(&manifest, &local),
            vec![
                (DAILY.to_string(), RoutineFileChangeKind::Modified),
                (
                    "routines/new.yaml".to_string(),
                    RoutineFileChangeKind::Added
                ),
                (WEEKLY.to_string(), RoutineFileChangeKind::Deleted),
            ]
        );
    }

    #[test]
    fn server_changes_for_status_are_classified_by_version_and_ignore_skipped_paths() {
        let manifest = manifest_of(&[
            (DAILY, 1, "a"),
            (WEEKLY, 2, "w"),
            ("routines/Gone.yaml", 1, "g"),
        ]);
        let mut server_files = BTreeMap::new();
        for (path, version) in [(DAILY, 2), ("routines/new.yaml", 1)] {
            server_files.insert(
                path.to_string(),
                ServerRoutineFile {
                    version,
                    content: None,
                },
            );
        }
        let skipped = BTreeSet::from(["routines/Gone.yaml".to_string()]);
        assert_eq!(
            classify_server_routine_changes_against_manifest_by_version(
                &manifest,
                &server_files,
                &skipped
            ),
            vec![
                (DAILY.to_string(), RoutineFileChangeKind::Modified),
                (
                    "routines/new.yaml".to_string(),
                    RoutineFileChangeKind::Added
                ),
                (WEEKLY.to_string(), RoutineFileChangeKind::Deleted),
            ]
        );
    }

    // ── pull planner: one test per decision-table row ──

    #[test]
    fn pull_does_nothing_when_server_and_local_both_match_the_manifest() {
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 3, "a")]),
            &local_files_of(&[(DAILY, "a")]),
            &server_files_of(&[(DAILY, 3, "a")]),
            false,
        );
        assert!(plan.local_file_operations_deletes_before_writes.is_empty());
        assert!(plan.conflicts_between_local_and_server_changes.is_empty());
        assert!(plan.server_paths_modified_since_last_sync.is_empty());
        assert_eq!(
            plan.manifest_files_after_successful_pull,
            manifest_of(&[(DAILY, 3, "a")])
        );
    }

    #[test]
    fn pull_keeps_local_edits_and_deletes_when_the_server_copy_is_unchanged() {
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 3, "a"), (WEEKLY, 1, "w")]),
            &local_files_of(&[(DAILY, "a-edited")]),
            &server_files_of(&[(DAILY, 3, "a"), (WEEKLY, 1, "w")]),
            false,
        );
        assert!(plan.local_file_operations_deletes_before_writes.is_empty());
        assert!(plan.conflicts_between_local_and_server_changes.is_empty());
        assert!(plan.local_edits_discarded.is_empty());
        // The manifest still records both files, so status keeps showing the local changes.
        assert_eq!(
            plan.manifest_files_after_successful_pull,
            manifest_of(&[(DAILY, 3, "a"), (WEEKLY, 1, "w")])
        );
    }

    #[test]
    fn pull_with_discard_local_restores_locally_edited_and_deleted_files_the_server_did_not_change()
    {
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 3, "a"), (WEEKLY, 1, "w")]),
            &local_files_of(&[(DAILY, "a-edited")]),
            &server_files_of(&[(DAILY, 3, "a"), (WEEKLY, 1, "w")]),
            true,
        );
        assert_eq!(
            plan.local_file_operations_deletes_before_writes,
            vec![
                write_op(DAILY, "a", Some("a-edited")),
                write_op(WEEKLY, "w", None),
            ]
        );
        assert_eq!(plan.local_edits_discarded, vec![DAILY, WEEKLY]);
    }

    #[test]
    fn pull_never_touches_a_local_only_new_file_even_with_discard_local() {
        for discard_local in [false, true] {
            let plan = plan_pull(
                &manifest_of(&[]),
                &local_files_of(&[("routines/draft.yaml", "draft")]),
                &server_files_of(&[]),
                discard_local,
            );
            assert!(plan.local_file_operations_deletes_before_writes.is_empty());
            assert!(plan.local_edits_discarded.is_empty());
            assert!(plan.manifest_files_after_successful_pull.is_empty());
        }
    }

    #[test]
    fn pull_applies_server_additions_modifications_and_deletions_to_untouched_local_files() {
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 1, "a"), (WEEKLY, 1, "w")]),
            &local_files_of(&[(DAILY, "a"), (WEEKLY, "w")]),
            &server_files_of(&[(DAILY, 2, "a2"), ("routines/new.yaml", 1, "n")]),
            false,
        );
        assert_eq!(
            plan.local_file_operations_deletes_before_writes,
            vec![
                delete_op(WEEKLY, "w"),
                write_op(DAILY, "a2", Some("a")),
                write_op("routines/new.yaml", "n", None),
            ]
        );
        assert_eq!(
            plan.server_paths_added_since_last_sync,
            vec!["routines/new.yaml"]
        );
        assert_eq!(plan.server_paths_modified_since_last_sync, vec![DAILY]);
        assert_eq!(plan.server_paths_deleted_since_last_sync, vec![WEEKLY]);
        assert_eq!(
            plan.manifest_files_after_successful_pull,
            manifest_of(&[(DAILY, 2, "a2"), ("routines/new.yaml", 1, "n")])
        );
    }

    #[test]
    fn pull_converges_without_file_operations_when_both_sides_made_the_same_change() {
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 1, "a"), (WEEKLY, 1, "w")]),
            &local_files_of(&[(DAILY, "same-edit")]),
            &server_files_of(&[(DAILY, 2, "same-edit")]),
            false,
        );
        assert!(plan.local_file_operations_deletes_before_writes.is_empty());
        assert!(plan.conflicts_between_local_and_server_changes.is_empty());
        assert_eq!(plan.server_paths_modified_since_last_sync, vec![DAILY]);
        assert_eq!(plan.server_paths_deleted_since_last_sync, vec![WEEKLY]);
        assert_eq!(
            plan.manifest_files_after_successful_pull,
            manifest_of(&[(DAILY, 2, "same-edit")])
        );
    }

    #[test]
    fn pull_reports_a_conflict_for_each_file_changed_differently_on_both_sides() {
        let plan = plan_pull(
            &manifest_of(&[
                ("routines/a-modified-both.yaml", 1, "a"),
                ("routines/b-deleted-locally.yaml", 1, "b"),
                ("routines/c-deleted-on-server.yaml", 1, "c"),
            ]),
            &local_files_of(&[
                ("routines/a-modified-both.yaml", "a-local"),
                ("routines/c-deleted-on-server.yaml", "c-local"),
                ("routines/d-added-both.yaml", "d-local"),
            ]),
            &server_files_of(&[
                ("routines/a-modified-both.yaml", 2, "a-server"),
                ("routines/b-deleted-locally.yaml", 2, "b-server"),
                ("routines/d-added-both.yaml", 1, "d-server"),
            ]),
            false,
        );
        use RoutineFileChangeKind::{Added, Deleted, Modified};
        let conflicts: Vec<(&str, RoutineFileChangeKind, RoutineFileChangeKind)> = plan
            .conflicts_between_local_and_server_changes
            .iter()
            .map(|conflict| {
                (
                    conflict.server_relative_path.as_str(),
                    conflict.local_change,
                    conflict.server_change,
                )
            })
            .collect();
        assert_eq!(
            conflicts,
            vec![
                ("routines/a-modified-both.yaml", Modified, Modified),
                ("routines/b-deleted-locally.yaml", Deleted, Modified),
                ("routines/c-deleted-on-server.yaml", Modified, Deleted),
                ("routines/d-added-both.yaml", Added, Added),
            ]
        );
        assert!(plan.local_edits_discarded.is_empty());
    }

    #[test]
    fn pull_with_discard_local_takes_the_server_version_of_every_conflicting_file() {
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 1, "a"), (WEEKLY, 1, "w")]),
            &local_files_of(&[(DAILY, "a-local"), (WEEKLY, "w-local")]),
            &server_files_of(&[(DAILY, 2, "a-server")]),
            true,
        );
        assert!(plan.conflicts_between_local_and_server_changes.is_empty());
        assert_eq!(
            plan.local_file_operations_deletes_before_writes,
            vec![
                delete_op(WEEKLY, "w-local"),
                write_op(DAILY, "a-server", Some("a-local")),
            ]
        );
        assert_eq!(plan.local_edits_discarded, vec![DAILY, WEEKLY]);
    }

    #[test]
    fn pull_detects_a_server_content_change_even_when_the_version_number_is_unchanged() {
        // A delete→recreate on the server restarts the version at 1: same version, new content.
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 1, "original")]),
            &local_files_of(&[(DAILY, "original")]),
            &server_files_of(&[(DAILY, 1, "recreated")]),
            false,
        );
        assert_eq!(
            plan.local_file_operations_deletes_before_writes,
            vec![write_op(DAILY, "recreated", Some("original"))]
        );
        assert_eq!(plan.server_paths_modified_since_last_sync, vec![DAILY]);
    }

    #[test]
    fn pull_treats_a_version_bump_with_identical_content_as_unchanged_and_records_the_new_version()
    {
        // A→B→A on the server bumps the version without changing the content: not a conflict
        // with the local edit, and the new version is recorded so the edit then pushes cleanly.
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 1, "a")]),
            &local_files_of(&[(DAILY, "a-local")]),
            &server_files_of(&[(DAILY, 3, "a")]),
            false,
        );
        assert!(plan.conflicts_between_local_and_server_changes.is_empty());
        assert!(plan.local_file_operations_deletes_before_writes.is_empty());
        assert!(plan.server_paths_modified_since_last_sync.is_empty());
        assert_eq!(
            plan.manifest_files_after_successful_pull,
            manifest_of(&[(DAILY, 3, "a")])
        );
    }

    #[test]
    fn pull_converges_after_a_push_whose_response_was_lost() {
        // The push landed server-side (v4 = the local bytes) but the manifest never heard of it.
        let plan = plan_pull(
            &manifest_of(&[(DAILY, 3, "before-push")]),
            &local_files_of(&[(DAILY, "pushed")]),
            &server_files_of(&[(DAILY, 4, "pushed")]),
            false,
        );
        assert!(plan.conflicts_between_local_and_server_changes.is_empty());
        assert!(plan.local_file_operations_deletes_before_writes.is_empty());
        assert_eq!(
            plan.manifest_files_after_successful_pull,
            manifest_of(&[(DAILY, 4, "pushed")])
        );
    }

    #[test]
    fn pull_with_an_empty_merge_base_adopts_identical_local_files_and_conflicts_on_different_ones()
    {
        // First pull into a workspace with no (or a foreign) manifest.
        let plan = plan_pull(
            &manifest_of(&[]),
            &local_files_of(&[(DAILY, "a"), (WEEKLY, "w-local")]),
            &server_files_of(&[
                (DAILY, 2, "a"),
                (WEEKLY, 5, "w-server"),
                ("routines/x.yaml", 1, "x"),
            ]),
            false,
        );
        assert_eq!(
            plan.conflicts_between_local_and_server_changes
                .iter()
                .map(|conflict| conflict.server_relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![WEEKLY]
        );
        assert_eq!(
            plan.local_file_operations_deletes_before_writes,
            vec![write_op("routines/x.yaml", "x", None)]
        );
    }

    #[test]
    fn pull_manifest_snapshot_covers_every_server_file_and_carries_over_skipped_paths() {
        let manifest = manifest_of(&[("routines/Daily.yaml", 4, "kept-as-is"), (WEEKLY, 1, "w")]);
        let skipped = BTreeSet::from(["routines/Daily.yaml".to_string()]);
        let plan = plan_three_way_routine_pull_by_content_hash(
            &manifest,
            &local_files_of(&[("routines/Daily.yaml", "local"), (WEEKLY, "w")]),
            &server_files_of(&[(WEEKLY, 2, "w2"), ("routines/z.yaml", 1, "z")]),
            &skipped,
            true,
        );
        // The skipped path is neither written nor deleted, and its manifest entry survives.
        assert_eq!(
            plan.local_file_operations_deletes_before_writes,
            vec![
                write_op(WEEKLY, "w2", Some("w")),
                write_op("routines/z.yaml", "z", None)
            ]
        );
        assert_eq!(
            plan.manifest_files_after_successful_pull,
            manifest_of(&[
                ("routines/Daily.yaml", 4, "kept-as-is"),
                (WEEKLY, 2, "w2"),
                ("routines/z.yaml", 1, "z")
            ])
        );
    }

    #[test]
    fn pull_conflict_message_names_each_path_and_the_discard_local_flag() {
        let message = format_routine_pull_conflicts_message(&[RoutinePullConflict {
            server_relative_path: DAILY.to_string(),
            local_change: RoutineFileChangeKind::Modified,
            server_change: RoutineFileChangeKind::Deleted,
        }]);
        assert!(message.contains("routines/daily.yaml (local: modified, server: deleted)"));
        assert!(message.contains("--discard-local"));
    }

    // ── push ──

    #[test]
    fn push_change_set_sends_null_base_for_new_files_and_manifest_versions_for_edits_and_deletes() {
        let valid_yaml = "name: Daily\nsteps:\n  - action: pull\n";
        let edited_yaml = "name: Daily (edited)\nsteps:\n  - action: pull\n";
        let change_set = build_routine_push_change_set_from_local_changes(
            &manifest_of(&[(DAILY, 4, valid_yaml), (WEEKLY, 2, valid_yaml)]),
            &local_files_of(&[(DAILY, edited_yaml), ("routines/new.yaml", valid_yaml)]),
        )
        .unwrap();
        let upserts: Vec<(&str, Option<i64>)> = change_set
            .upserts
            .iter()
            .map(|upsert| (upsert.path.as_str(), upsert.base_version))
            .collect();
        assert_eq!(upserts, vec![(DAILY, Some(4)), ("routines/new.yaml", None)]);
        assert_eq!(change_set.upserts[0].content, edited_yaml);
        let deletes: Vec<(&str, i64)> = change_set
            .deletes
            .iter()
            .map(|delete| (delete.path.as_str(), delete.base_version))
            .collect();
        assert_eq!(deletes, vec![(WEEKLY, 2)]);
        assert_eq!(
            change_set.pushed_content_sha256_hex_by_server_path[DAILY],
            sha256_hex_of_bytes(edited_yaml.as_bytes())
        );
    }

    #[test]
    fn push_change_set_is_empty_when_local_files_match_the_manifest() {
        let valid_yaml = "name: Daily\nsteps:\n  - action: pull\n";
        let change_set = build_routine_push_change_set_from_local_changes(
            &manifest_of(&[(DAILY, 4, valid_yaml)]),
            &local_files_of(&[(DAILY, valid_yaml)]),
        )
        .unwrap();
        assert!(change_set.is_empty());
    }

    #[test]
    fn push_change_set_rejects_non_utf8_nul_bytes_and_invalid_yaml_naming_the_path() {
        let mut non_utf8_local_files = LocalRoutineFilesByServerPath::new();
        non_utf8_local_files.insert(
            DAILY.to_string(),
            LocalRoutineFile::from_bytes(vec![b'n', 0xFF, 0xFE]),
        );
        let error = build_routine_push_change_set_from_local_changes(
            &manifest_of(&[]),
            &non_utf8_local_files,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("routines/daily.yaml: not valid UTF-8"));

        let error = build_routine_push_change_set_from_local_changes(
            &manifest_of(&[]),
            &local_files_of(&[(DAILY, "name: x\0\nsteps:\n  - action: pull\n")]),
        )
        .unwrap_err();
        assert!(error.to_string().contains("NUL byte"));

        let error = build_routine_push_change_set_from_local_changes(
            &manifest_of(&[]),
            &local_files_of(&[(DAILY, "steps:\n  - action: pull\n")]),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("routines/daily.yaml: a routine must have a non-empty `name`"));
    }

    #[test]
    fn push_merge_updates_only_pushed_paths_and_leaves_other_server_versions_alone() {
        let valid_yaml = "name: Daily\nsteps:\n  - action: pull\n";
        let edited_yaml = "name: Daily (edited)\nsteps:\n  - action: pull\n";
        let manifest_before_push = manifest_of(&[
            (DAILY, 4, valid_yaml),
            (WEEKLY, 2, valid_yaml),
            ("routines/untouched.yaml", 7, valid_yaml),
        ]);
        let change_set = build_routine_push_change_set_from_local_changes(
            &manifest_before_push,
            &local_files_of(&[
                (DAILY, edited_yaml),
                ("routines/untouched.yaml", valid_yaml),
            ]),
        )
        .unwrap();
        let merge = merge_successful_routine_push_into_manifest_files(
            &manifest_before_push,
            &change_set,
            &[
                RoutineFileVersion {
                    path: DAILY.to_string(),
                    version: 5,
                },
                // Someone else bumped this file; this workspace doesn't have that content.
                RoutineFileVersion {
                    path: "routines/untouched.yaml".to_string(),
                    version: 9,
                },
            ],
        );
        assert_eq!(
            merge.manifest_files_after_push,
            manifest_of(&[
                (DAILY, 5, edited_yaml),
                ("routines/untouched.yaml", 7, valid_yaml)
            ])
        );
        assert_eq!(
            merge.server_version_by_pushed_upsert_path,
            BTreeMap::from([(DAILY.to_string(), 5)])
        );
        assert!(merge
            .pushed_upsert_paths_missing_from_server_response
            .is_empty());
    }

    #[test]
    fn push_merge_reports_pushed_paths_missing_from_the_response_and_keeps_their_old_entry() {
        let valid_yaml = "name: Daily\nsteps:\n  - action: pull\n";
        let manifest_before_push = manifest_of(&[(DAILY, 4, "old")]);
        let change_set = build_routine_push_change_set_from_local_changes(
            &manifest_before_push,
            &local_files_of(&[(DAILY, valid_yaml)]),
        )
        .unwrap();
        let merge = merge_successful_routine_push_into_manifest_files(
            &manifest_before_push,
            &change_set,
            &[],
        );
        assert_eq!(
            merge.pushed_upsert_paths_missing_from_server_response,
            vec![DAILY]
        );
        assert_eq!(merge.manifest_files_after_push, manifest_before_push);
    }

    #[test]
    fn stale_push_message_lists_each_file_with_its_base_and_current_versions_and_says_to_pull() {
        let message = format_blocked_stale_routine_push_message(&[
            PushRoutineStaleFile {
                path: DAILY.to_string(),
                base_version: Some(2),
                current_version: Some(3),
            },
            PushRoutineStaleFile {
                path: "routines/new.yaml".to_string(),
                base_version: None,
                current_version: Some(1),
            },
            PushRoutineStaleFile {
                path: WEEKLY.to_string(),
                base_version: Some(4),
                current_version: None,
            },
        ]);
        assert!(message.contains(
            "routines/daily.yaml (your copy is based on version 2; the server is at version 3)"
        ));
        assert!(message
            .contains("routines/new.yaml (you created it, but the server already has version 1)"));
        assert!(message.contains(
            "routines/weekly.yaml (deleted on the server; your copy is based on version 4)"
        ));
        assert!(message.contains("scratchmd routines pull"));
    }

    // ── validate_routine_yaml ──

    #[test]
    fn validate_routine_yaml_accepts_minimal_routine() {
        let yaml = "name: Daily\nsteps:\n  - action: pull\n";
        assert!(validate_routine_yaml("routines/daily.yaml", yaml).is_ok());
    }

    #[test]
    fn validate_routine_yaml_rejects_non_yaml_extension() {
        let err =
            validate_routine_yaml("routines/daily.txt", "name: x\nsteps:\n  - action: pull\n")
                .unwrap_err();
        assert!(err.to_string().contains(".yaml or .yml"));
    }

    #[test]
    fn validate_routine_yaml_rejects_missing_name() {
        let err =
            validate_routine_yaml("routines/daily.yaml", "steps:\n  - action: pull\n").unwrap_err();
        assert!(err.to_string().contains("non-empty `name`"));
    }

    #[test]
    fn validate_routine_yaml_rejects_empty_steps() {
        let err =
            validate_routine_yaml("routines/daily.yaml", "name: Daily\nsteps: []\n").unwrap_err();
        assert!(err.to_string().contains("at least one entry under `steps`"));
    }

    #[test]
    fn validate_routine_yaml_rejects_malformed_yaml() {
        let err = validate_routine_yaml("routines/daily.yaml", "name: : :\n\t- bad").unwrap_err();
        assert!(err.to_string().contains("invalid YAML"));
    }
}
