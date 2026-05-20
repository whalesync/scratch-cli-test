//! Node native addon exposing `shared::review_ops` to the Electron main
//! process. Shipped under the local module name `scratchmd-native` (D6) at
//! `scratch-desktop/Resources/bin/scratchmd-native.<platform>-<arch>[-<abi>].node`
//! in packaged builds; in dev, the loader resolves the `.node` next to this
//! crate's `Cargo.toml`. See `docs/plans/2026-05-20-slice-h-spec.md`.
//!
//! Slice H.2 ships only `acceptField`. The remaining three entry points
//! (`discardField`, `restoreDeletedRecord`, `discardCreatedRecord`) land in
//! H.3 alongside the desktop handler migration.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use scratch_git_2::shared::review_ops::{
    self, LockMode, ReviewOpEffect, ReviewOpError, ReviewOpResult as RustReviewOpResult,
};
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
/// [Lock semantics](../../../docs/plans/2026-05-20-slice-h-spec.md#lock-semantics)).
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
        review_ops::discard_field(
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
