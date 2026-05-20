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
use serde_json::Value as JsonValue;
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
        ReviewOpError::CreateClashesWithMain(_) => (Status::InvalidArg, "CREATE_CLASHES_WITH_MAIN"),
        ReviewOpError::InvalidJson { .. } => (Status::GenericFailure, "INVALID_JSON"),
        ReviewOpError::Io(_) | ReviewOpError::Internal(_) => (Status::GenericFailure, "INTERNAL"),
    };
    Error::new(status, format!("{code}: {err}"))
}

/// Accept the user's `localValue` for `field` on `recordRelPath` under
/// `connectionDirName` inside `workspaceDir`. Updates `accepted-patches.json`
/// so the field's approved value matches `localValue`; the working file is
/// not touched.
///
/// Returns a `ReviewOpResult` describing what changed; throws an `Error` whose
/// `.code` is one of `LOCK_BUSY`, `WORKSPACE_NOT_FOUND`, `UNKNOWN_CONNECTION`,
/// `NOT_A_RECORD_PATH`, `INVALID_JSON`, `INTERNAL`.
///
/// Uses `LockMode::ShortWait` (100ms budget) so the Electron main thread
/// surfaces `LOCK_BUSY` instead of freezing on a contended lock.
#[napi]
pub async fn accept_field(
    workspace_dir: String,
    connection_dir_name: String,
    record_rel_path: String,
    field: String,
    local_value: serde_json::Value,
) -> Result<ReviewOpResult> {
    let value: JsonValue = local_value;
    napi::tokio::task::spawn_blocking(move || {
        review_ops::accept_field(
            &PathBuf::from(&workspace_dir),
            &connection_dir_name,
            &record_rel_path,
            &field,
            &value,
            LockMode::ShortWait,
        )
    })
    .await
    .map_err(|join_err| Error::from_reason(format!("native worker panic: {join_err}")))?
    .map(Into::into)
    .map_err(map_err)
}
