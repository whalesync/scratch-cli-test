//! Node native addon exposing `shared::review_ops` to the Electron main
//! process. Shipped under the local module name `scratchmd-native` (D6) at
//! `scratch-desktop/Resources/bin/scratchmd-native.<platform>-<arch>[-<abi>].node`
//! in packaged builds; in dev, the loader resolves the `.node` next to this
//! crate's `Cargo.toml`. See `docs/plans/resolved/2026-05-20-slice-h-spec/2026-05-20-slice-h-spec.md`.
//!
//! Slice H.2 ships only `acceptField`. The remaining three entry points
//! (`discardField`, `restoreDeletedRecord`, `discardCreatedRecord`) land in
//! H.3 alongside the desktop handler migration.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use scratch_git_2::shared::review_ops::{
    self, FolderBlob as RustFolderBlob, LockMode, ReviewOpEffect, ReviewOpError,
    ReviewOpResult as RustReviewOpResult,
};
use scratch_git_2::shared::review_stats;
use scratch_git_2::shared::validation_stats;
use std::path::PathBuf;

/// Result shape returned to JS. Mirrors `review_ops::ReviewOpResult` with
/// `effect` flattened to a string for easy `switch` / `===` matching from TS.
#[napi(object)]
pub struct ReviewOpResult {
    pub workspace_path: String,
    pub patches_changed: bool,
    pub working_changed: bool,
    /// One of `"NoOp"`, `"PatchUpserted"`, `"PatchDropped"`, `"WorkingRestored"`.
    pub effect: String,
}

impl From<RustReviewOpResult> for ReviewOpResult {
    fn from(r: RustReviewOpResult) -> Self {
        ReviewOpResult {
            workspace_path: r.workspace_path,
            patches_changed: r.patches_changed,
            working_changed: r.working_changed,
            effect: match r.effect {
                ReviewOpEffect::NoOp => "NoOp",
                ReviewOpEffect::PatchUpserted => "PatchUpserted",
                ReviewOpEffect::PatchDropped => "PatchDropped",
                ReviewOpEffect::WorkingRestored => "WorkingRestored",
            }
            .to_string(),
        }
    }
}

/// Map `review_ops::ReviewOpError` to a `napi::Error` whose JS-side message
/// is `"<CODE>: <human description>"`. The desktop's TS shim parses the
/// `<CODE>` prefix to pattern-match on (in particular, `LOCK_BUSY` must
/// surface as "another operation in progress" — see
/// [Lock semantics](../../../docs/plans/resolved/2026-05-20-slice-h-spec/2026-05-20-slice-h-spec.md#lock-semantics)).
///
/// Why message-prefix and not `err.code`: napi-rs 2.x sets `err.code` to the
/// `Status` enum name (`GenericFailure` / `InvalidArg`) and offers no way to
/// override it from Rust. Custom error codes need a thin JS wrapper layer;
/// for slice H.2 we keep it Rust-only by encoding the code in the message.
fn map_err(err: ReviewOpError) -> Error {
    let (status, code) = match &err {
        ReviewOpError::LockBusy { .. } => (Status::GenericFailure, "LOCK_BUSY"),
        ReviewOpError::WorkspaceNotFound(_) => (Status::InvalidArg, "WORKSPACE_NOT_FOUND"),
        ReviewOpError::UnknownConnection(_) => (Status::InvalidArg, "UNKNOWN_CONNECTION"),
        ReviewOpError::NotARecordPath { .. } => (Status::InvalidArg, "NOT_A_RECORD_PATH"),
        ReviewOpError::NotAnApprovedDelete(_) => (Status::InvalidArg, "NOT_AN_APPROVED_DELETE"),
        ReviewOpError::NotAnApprovedCreate(_) => (Status::InvalidArg, "NOT_AN_APPROVED_CREATE"),
        ReviewOpError::RestoreSourceMissing(_) => (Status::InvalidArg, "RESTORE_SOURCE_MISSING"),
        ReviewOpError::WorkingFileMissing(_) => (Status::InvalidArg, "WORKING_FILE_MISSING"),
        ReviewOpError::CreateClashesWithMain(_) => (Status::InvalidArg, "CREATE_CLASHES_WITH_MAIN"),
        ReviewOpError::InvalidJson { .. } => (Status::GenericFailure, "INVALID_JSON"),
        ReviewOpError::Io(_) | ReviewOpError::Internal(_) => (Status::GenericFailure, "INTERNAL"),
    };
    Error::new(status, format!("{code}: {err}"))
}

/// Accept the working file's current value for `field` on `recordRelPath`
/// under `connectionDirName` inside `workspaceDir`. The caller must have
/// already written the user's typed value to the working file at
/// `<connectionDirName>/<recordRelPath>` before calling this — the binding
/// reads the field's value from disk and folds it into
/// `accepted-patches.json`. The working file itself is not touched here.
///
/// Returns a `ReviewOpResult` describing what changed; throws an `Error` whose
/// message is prefixed with one of `LOCK_BUSY`, `WORKSPACE_NOT_FOUND`,
/// `UNKNOWN_CONNECTION`, `NOT_A_RECORD_PATH`, `WORKING_FILE_MISSING`,
/// `INVALID_JSON`, `INTERNAL`.
///
/// Uses `LockMode::ShortWait` (100ms budget) so the Electron main thread
/// surfaces `LOCK_BUSY` instead of freezing on a contended lock.
#[napi]
pub async fn accept_field(
    workspace_dir: String,
    connection_dir_name: String,
    record_rel_path: String,
    field: String,
) -> Result<ReviewOpResult> {
    napi::tokio::task::spawn_blocking(move || {
        review_ops::accept_field(
            &PathBuf::from(&workspace_dir),
            &connection_dir_name,
            &record_rel_path,
            &field,
            LockMode::ShortWait,
        )
    })
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map(Into::into)
    .map_err(map_err)
}

/// Reject the user's unreviewed working-tree edit for `field` on
/// `recordRelPath`: restore the working file's field value to the *approved*
/// value (the patch entry's value if present, else `refs/heads/main`'s value)
/// WITHOUT touching `accepted-patches.json`. Field-level analogue of `files
/// reject`. The strict invariant is that Reject never mutates the patch file
/// — use `discardField` when the caller wants to also drop an existing
/// approved patch entry.
///
/// Uses `LockMode::ShortWait` (100ms budget); same error shape as
/// `acceptField`.
#[napi]
pub async fn reject_field(
    workspace_dir: String,
    connection_dir_name: String,
    record_rel_path: String,
    field: String,
) -> Result<ReviewOpResult> {
    napi::tokio::task::spawn_blocking(move || {
        review_ops::revert_field_edit_to_approved_value(
            &PathBuf::from(&workspace_dir),
            &connection_dir_name,
            &record_rel_path,
            &field,
            LockMode::ShortWait,
        )
    })
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map(Into::into)
    .map_err(map_err)
}

/// Discard the user's pending change for `field` on `recordRelPath`. Drops
/// the field from any accepted-patches entry AND restores the working file's
/// value for that field to whatever `refs/heads/main` says. Mirrors the
/// `Discard` semantics in `docs/REVIEW_MODEL.md`.
///
/// Stripping the last field from a `Create` entry drops the entry and
/// removes the working file (the record rolls back to "never existed").
/// `Delete` entries are no-ops at the field level — use a different entry
/// point for whole-file restore.
///
/// Uses `LockMode::ShortWait` (100ms budget); same error shape as
/// `acceptField`.
#[napi]
pub async fn discard_field(
    workspace_dir: String,
    connection_dir_name: String,
    record_rel_path: String,
    field: String,
) -> Result<ReviewOpResult> {
    napi::tokio::task::spawn_blocking(move || {
        review_ops::drop_approved_field_and_restore_to_main_value(
            &PathBuf::from(&workspace_dir),
            &connection_dir_name,
            &record_rel_path,
            &field,
            LockMode::ShortWait,
        )
    })
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map(Into::into)
    .map_err(map_err)
}

/// One record file in a folder, returned by [`readFolderBlobs`]. `published`
/// is the file's content at `refs/heads/main:<folder>/<filename>` (null when
/// the file isn't published yet). `approved` is `apply(published,
/// accepted-patches.json entry)` — null when the entry is a `Delete` (file
/// is approved-deleted).
#[napi(object)]
pub struct FolderBlob {
    pub filename: String,
    /// JSON content of the published version, or null if the file isn't on
    /// `refs/heads/main` yet (= new record).
    pub published: Option<String>,
    /// JSON content of the approved version (`published` + any accepted
    /// patch), or null if approved-deleted.
    pub approved: Option<String>,
}

impl FolderBlob {
    fn try_from_rust(rb: RustFolderBlob) -> std::result::Result<Self, ReviewOpError> {
        let to_string = |bytes: Vec<u8>, label: &str, filename: &str| {
            String::from_utf8(bytes).map_err(|err| {
                ReviewOpError::Internal(anyhow::anyhow!(
                    "non-UTF-8 bytes in {label} blob for {filename}: {err}"
                ))
            })
        };
        let published = rb
            .published
            .map(|b| to_string(b, "published", &rb.filename))
            .transpose()?;
        let approved = rb
            .approved
            .map(|b| to_string(b, "approved", &rb.filename))
            .transpose()?;
        Ok(FolderBlob {
            filename: rb.filename,
            published,
            approved,
        })
    }
}

/// Read `(published, approved)` content for every record file directly inside
/// `<workspaceDir>/<connectionDirName>/<folderRelPath>/`. Non-recursive —
/// subfolders are excluded. Empty `folderRelPath` is the connection root.
///
/// Drives the desktop's grid-view diff status. The desktop reads the working
/// version itself from disk (TS fs); this binding supplies the other two
/// sides of the three-way comparison.
///
/// **For paginated grid views, prefer [`readFolderBlobsFiltered`]** — this
/// binding loads ALL records in the folder into memory (hundreds of MB on
/// 20k+ row folders) before returning.
///
/// Same error-prefix convention as `acceptField` (codes: `WORKSPACE_NOT_FOUND`,
/// `UNKNOWN_CONNECTION`, `INVALID_JSON`, `INTERNAL`). No `LOCK_BUSY` — reads
/// don't acquire the workspace lock.
#[napi]
pub async fn read_folder_blobs(
    workspace_dir: String,
    connection_dir_name: String,
    folder_rel_path: String,
) -> Result<Vec<FolderBlob>> {
    napi::tokio::task::spawn_blocking(
        move || -> std::result::Result<Vec<FolderBlob>, ReviewOpError> {
            let blobs = review_ops::read_folder_blobs(
                &PathBuf::from(&workspace_dir),
                &connection_dir_name,
                &folder_rel_path,
            )?;
            blobs.into_iter().map(FolderBlob::try_from_rust).collect()
        },
    )
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map_err(map_err)
}

/// Like [`readFolderBlobs`] but restricted to the supplied filename list —
/// the returned array contains only entries whose `filename` is in
/// `filenames`. Filenames the folder doesn't have are silently dropped.
/// Empty `filenames` short-circuits to `[]` before touching the bare repo.
///
/// Use this from paginated grid renderers (pass the page's filenames) and
/// single-record diff views (pass `[filename]`) to bound memory at the page
/// size instead of loading the entire folder's `(published, approved)`
/// content. See `docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md`
/// follow-up D5.
///
/// Same error-prefix convention as `readFolderBlobs`.
#[napi]
pub async fn read_folder_blobs_filtered(
    workspace_dir: String,
    connection_dir_name: String,
    folder_rel_path: String,
    filenames: Vec<String>,
) -> Result<Vec<FolderBlob>> {
    napi::tokio::task::spawn_blocking(
        move || -> std::result::Result<Vec<FolderBlob>, ReviewOpError> {
            let filename_set: std::collections::HashSet<String> = filenames.into_iter().collect();
            let blobs = review_ops::read_folder_blobs_filtered(
                &PathBuf::from(&workspace_dir),
                &connection_dir_name,
                &folder_rel_path,
                &filename_set,
            )?;
            blobs.into_iter().map(FolderBlob::try_from_rust).collect()
        },
    )
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map_err(map_err)
}

/// List record filenames in `<workspaceDir>/<connectionDirName>/<folderRelPath>/`
/// without reading blob content. Returns the union of `refs/heads/main` paths
/// and `accepted-patches.json` entries (so approved-creates and approved-deletes
/// both show up). Sorted lexicographically.
///
/// Use this for filename-only consumers (`findRecordOffset`, scroll-to-record).
/// For diff content, call `readFolderBlobsFiltered` with the desired page's
/// filenames.
///
/// Same error-prefix convention as `readFolderBlobs` (`WORKSPACE_NOT_FOUND`,
/// `UNKNOWN_CONNECTION`, `INVALID_JSON`, `INTERNAL`). No `LOCK_BUSY` — reads
/// don't acquire the workspace lock.
#[napi]
pub async fn list_folder_filenames(
    workspace_dir: String,
    connection_dir_name: String,
    folder_rel_path: String,
) -> Result<Vec<String>> {
    napi::tokio::task::spawn_blocking(move || -> std::result::Result<Vec<String>, ReviewOpError> {
        review_ops::list_folder_filenames(
            &PathBuf::from(&workspace_dir),
            &connection_dir_name,
            &folder_rel_path,
        )
    })
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map_err(map_err)
}

// ─── Stats + refresh — workspace-wide and per-folder index aggregation ──────
//
// Powers the desktop sidebar's "Needs review" (blue) and "Approved" (gray)
// dots plus the existing validation dots, per
// `docs/plans/resolved/2026-05-31-folder-tree-review-approved-dots/2026-05-31-folder-tree-review-approved-dots.md`. These were
// previously shelled out to the `scratchmd` CLI; moving them in-process
// eliminates the ~10-20 ms spawn cost per invocation, which matters for the
// cold-start refresh pass (sequential walk across every folder).
//
// All three return `serde_json::Value` so the snake_case Rust field names
// (`folder_path`, `unreviewed`, `approved`, `errors`, `warnings`, `records`,
// `base_refreshed`, `columns_refreshed`, `validated`) flow through unchanged
// to JS — preserving the long-standing `ValidationStat` TS contract and the
// matching new `ReviewStat` TS contract.
//
// Read-only ops (`getReviewStats`, `getValidationStats`) and
// `refreshFolder` do not acquire the workspace lock; no `LOCK_BUSY` is
// raised. Errors are surfaced with the prefix `INTERNAL:` (the underlying
// `anyhow` chain doesn't currently classify between marker-missing and
// other I/O — sufficient for the desktop's swallow-and-render-empty contract).

/// Workspace-wide per-folder counts of `(unreviewed, approved)` records.
///
/// For every connection in `<workspaceDir>/.scratch/.scratchmd`, walks the
/// on-disk data folder tree and reads each folder's persisted
/// `approvedChanges` / `unapprovedChanges` bit columns from the per-folder
/// SQLite index. Folders whose counts are both zero are omitted. Folders
/// that haven't been indexed yet are skipped — caller should run
/// `refreshFolder` first if fresh bits are required.
///
/// Returns an array of `{ connection, folder_path, unreviewed, approved }`.
/// Field names are snake_case to mirror the existing `ValidationStat` TS
/// contract. Empty array when the workspace has no folders with changes.
///
/// Error prefix: `INTERNAL:` (workspace marker missing/unreadable, SQLite
/// failure, etc.). No `LOCK_BUSY` — reads don't acquire the workspace lock.
#[napi]
pub async fn get_review_stats(workspace_dir: String) -> Result<serde_json::Value> {
    napi::tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let stats = review_stats::collect_review_stats(&PathBuf::from(&workspace_dir))?;
        Ok(serde_json::to_value(stats)?)
    })
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map_err(|err| Error::new(Status::GenericFailure, format!("INTERNAL: {err:#}")))
}

/// Workspace-wide per-folder counts of validation problems.
///
/// Reads from the shared `validation_results__vN` table in each connection's
/// `.repos/<dirName>.db`, populated by `paginate-records --validate` and
/// `index refresh-folder --validate`. Distinct-filename counts per severity.
///
/// Returns an array of `{ connection, folder_path, errors, warnings, records }`.
/// Field names are snake_case — identical to the long-standing
/// `ValidationStat` TS contract. Migrated from the
/// `scratchmd validation get-stats` CLI shell-out.
///
/// Error prefix: `INTERNAL:`. No `LOCK_BUSY` — reads don't acquire the
/// workspace lock.
#[napi]
pub async fn get_validation_stats(workspace_dir: String) -> Result<serde_json::Value> {
    napi::tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let stats = validation_stats::collect_validation_stats(&PathBuf::from(&workspace_dir))?;
        Ok(serde_json::to_value(stats)?)
    })
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map_err(|err| Error::new(Status::GenericFailure, format!("INTERNAL: {err:#}")))
}
