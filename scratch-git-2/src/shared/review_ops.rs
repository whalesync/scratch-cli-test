//! Accept / reject / discard helpers for the review model.
//!
//! These are the I/O-bounded helpers (filesystem-only — NO git access) that
//! compute the "what changes" of accept/reject/discard operations and reconcile
//! working files with computed states. Git access is deliberately NOT done
//! here; callers pass in pre-computed `FileMap`s representing the bare repo's
//! `main` tree. This keeps the module portable across the two binaries
//! (cli + service) AND across the future napi cdylib without dragging the
//! cli's `git_ops` along.
//!
//! See `docs/plans/2026-05-20-slice-h-spec.md` for the slice H plan; this
//! module is the "pure compute + FS" core. The I/O-bundling public entry
//! points that call git on behalf of callers (`accept_field`, `discard_field`,
//! `restore_deleted_record`, `discard_created_record` with `LockMode`) land in
//! slice H.2/H.3 once the napi crate is in place and we've decided where the
//! git utility functions live.
//!
//! See `docs/REVIEW_MODEL.md` for the published/approved/local state model
//! and the field-level action matrix this module implements.

// `shared` is compiled for both the `scratchmd` and `scratch-git-2` (service)
// binaries; the service doesn't reach into review_ops, so dead-code warnings
// would fire on every helper there. Allowing at module scope avoids a wall
// of per-item annotations.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::shared::accepted_patches::{self, AcceptedPatchesFile};
use crate::shared::layout::WorkspaceLayout;
use crate::shared::re_anchor::{AnchoredPatch, PatchKind};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Map of repo-relative path → file content. Re-exported from `shared::git_local`
/// where the actual definition lives — the canonical `FileMap` type is shared
/// across `git_local`, `review_ops`, and `cli::git_ops`.
pub use crate::shared::git_local::FileMap;

/// Subset of cli's `ConnectionContext` that review_ops actually uses. CLI
/// callers build this from a `ConnectionContext`; future napi callers build it
/// from `(workspace_dir, connection_dir_name)` once they have a way to read
/// the workspace marker.
#[derive(Debug, Clone)]
pub struct ConnectionPaths {
    /// User-facing connection folder name (e.g. `"HubSpot"`). Used in display
    /// paths emitted to the user.
    pub conn_dir_name: String,
    /// Workspace root (`<workspace>`). The lock file and `.scratch/connections/<conn>`
    /// hang off this.
    pub workspace_dir: PathBuf,
    /// The user's editable directory — one non-sparse worktree on
    /// `refs/heads/main` post-slice F.
    pub worktree_dir: PathBuf,
    /// Bare repo (`<workspace>/.repos/<repo-id>.git/`). Read-only from this
    /// module's perspective; callers handle ref advances.
    pub bare_repo: PathBuf,
    /// Per-connection scratch dir for `.scratch/` schema/validation/state.
    pub scratch_dir: PathBuf,
}

/// Per-call summary of what a field-level accept / reject / discard touched.
#[derive(Default, Debug)]
pub struct FieldCommandResult {
    /// Workspace-prefixed paths (`<conn>/<rel>`) that the call touched. Drives
    /// folder-index reindex on the CLI side.
    pub changed_paths: Vec<String>,
    /// True iff the call mutated `accepted-patches.json`. Caller decides
    /// whether to `save_atomic`. Reject leaves this false (reject never writes
    /// to the patch file — see decision 35); accept and discard set it when
    /// they upsert or remove an entry.
    pub patches_changed: bool,
}

/// Outcome of a single field within `discard_field_in_folder`. Used to decide
/// whether the working file needs rewriting and whether the parent patch entry
/// should be dropped.
pub enum PatchAction {
    Untouched,
    Modified,
    Dropped,
    /// Like `Dropped`, but originated from a `Create` entry — the working
    /// file should be removed since `published` has no such record.
    DroppedCreate,
}

// ---------------------------------------------------------------------------
// Public entry-point types — see slice H spec (DEV-10144)
// ---------------------------------------------------------------------------

/// How the public entry points should acquire `.scratch/lock`. CLI callers
/// (terminal scripts) want the 30-second blocking wait; napi callers on the
/// Electron main thread want a bounded short wait that surfaces a structured
/// `LOCK_BUSY` error to the renderer.
#[derive(Debug, Clone, Copy)]
pub enum LockMode {
    /// 30-second blocking wait. Matches CLI's existing `workspace_lock::acquire`.
    DefaultBlocking,
    /// 100ms bounded wait, then `ReviewOpError::LockBusy`.
    ShortWait,
}

/// Coarse-grained "what happened" tag the desktop renderer can pattern-match
/// on. Strings live in the renderer; this is just a Rust enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewOpEffect {
    /// The operation was a no-op (local already matched approved, or there
    /// was nothing to discard).
    NoOp,
    /// `accepted-patches.json` gained or updated an entry for the record.
    PatchUpserted,
    /// The patch entry was removed (e.g. discard emptied the last field, or
    /// restore_deleted_record dropped a `Delete`).
    PatchDropped,
    /// The working file was rewritten or removed. (Mutually compatible with
    /// `PatchUpserted` / `PatchDropped`; this enum returns the *primary*
    /// effect from the caller's point of view.)
    WorkingRestored,
}

/// Result of a public entry point. Drives the desktop's reindex + folder grid
/// refresh on the calling side; CLI command wrappers use `workspace_path` for
/// printing and `patches_changed` to decide whether to refresh the folder
/// index's `approved_patches_mtime` column.
#[derive(Debug, Clone)]
pub struct ReviewOpResult {
    /// Workspace-prefixed path of the touched record, e.g.
    /// `"HubSpot/Companies/rec_123.json"`. Empty when nothing matched (no-op
    /// from a path-resolution failure won't reach here — those become errors).
    pub workspace_path: String,
    /// True iff `accepted-patches.json` was rewritten.
    pub patches_changed: bool,
    /// True iff the working file on disk was created, rewritten, or removed.
    pub working_changed: bool,
    /// Primary effect from the caller's perspective. See [`ReviewOpEffect`].
    pub effect: ReviewOpEffect,
}

/// Error shape for the public entry points. napi maps `LockBusy` to
/// `err.code = 'LOCK_BUSY'` so the renderer can show a "another operation in
/// progress" toast; everything else surfaces as a generic error.
#[derive(thiserror::Error, Debug)]
pub enum ReviewOpError {
    #[error("workspace not found at {0}")]
    WorkspaceNotFound(PathBuf),
    #[error("connection '{0}' not registered in workspace.yaml")]
    UnknownConnection(String),
    #[error("'{path}' is not a record file under '{connection}'")]
    NotARecordPath { connection: String, path: String },
    #[error("'{0}' is not an approved deleted record")]
    NotAnApprovedDelete(String),
    #[error("'{0}' is not an approved created record")]
    NotAnApprovedCreate(String),
    #[error("'{0}' does not exist on main and cannot be restored")]
    RestoreSourceMissing(String),
    #[error("'{0}' does not exist in the working tree — write the value before calling accept")]
    WorkingFileMissing(String),
    #[error("'{0}' exists on main and cannot be discarded as an approved create")]
    CreateClashesWithMain(String),
    #[error("workspace lock held by another scratchmd process (pid {pid})")]
    LockBusy { pid: u32, lock_path: PathBuf },
    #[error("invalid JSON in '{path}': {source}")]
    InvalidJson {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(#[from] anyhow::Error),
}

impl From<crate::shared::workspace_lock::LockError> for ReviewOpError {
    fn from(err: crate::shared::workspace_lock::LockError) -> Self {
        match err {
            crate::shared::workspace_lock::LockError::Busy { pid, lock_path } => {
                ReviewOpError::LockBusy { pid, lock_path }
            }
            crate::shared::workspace_lock::LockError::Io(io_err) => ReviewOpError::Io(io_err),
        }
    }
}

// ---------------------------------------------------------------------------
// Path conventions
// ---------------------------------------------------------------------------

trait ToSlashLossy {
    fn to_slash_lossy(&self) -> String;
}

impl ToSlashLossy for Path {
    fn to_slash_lossy(&self) -> String {
        self.to_string_lossy().replace('\\', "/")
    }
}

/// Resolve `<workspace>/.scratch/connections/<conn>` for a paths bundle.
///
/// `paths.workspace_dir` is the workspace root post-slice-D; we derive the
/// connection root via the standard `WorkspaceLayout` API to stay consistent
/// with the rest of the codebase.
pub fn accepted_patches_dir(paths: &ConnectionPaths) -> PathBuf {
    WorkspaceLayout::for_cli(&paths.workspace_dir).connection_root_path(&paths.conn_dir_name)
}

/// True iff `path` looks like a data record file under `repo_folder`
/// (or anywhere if `repo_folder` is empty). Filters out `.scratch/` entries
/// and non-`.json` files so callers don't have to.
pub fn is_data_path_in_folder(path: &str, repo_folder: &str) -> bool {
    !path.starts_with(".scratch/")
        && path.ends_with(".json")
        && (repo_folder.is_empty() || path.starts_with(&format!("{repo_folder}/")))
}

/// Collect the union of data paths from `base_map`, `local_map`, and an
/// optional `master_map` that lie under `repo_folder`. Used to enumerate the
/// set of files a folder-scoped operation needs to consider.
pub fn iter_data_paths_in_folder(
    base_map: &FileMap,
    local_map: &FileMap,
    master_map: Option<&FileMap>,
    repo_folder: &str,
) -> Vec<String> {
    let mut paths = std::collections::BTreeSet::new();

    for key in base_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    for key in local_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    if let Some(master_map) = master_map {
        for key in master_map.keys() {
            if is_data_path_in_folder(key, repo_folder) {
                paths.insert(key.clone());
            }
        }
    }

    paths.into_iter().collect()
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/// Parse `content` as a JSON object, attaching `path` to any error so the
/// user sees which record failed.
pub fn parse_json_object_bytes(
    content: &[u8],
    path: &str,
) -> anyhow::Result<JsonMap<String, JsonValue>> {
    let parsed: JsonValue = serde_json::from_slice(content)
        .map_err(|err| anyhow::anyhow!("Failed to parse JSON in '{}': {}", path, err))?;
    match parsed {
        JsonValue::Object(obj) => Ok(obj),
        _ => anyhow::bail!(
            "JSON record '{}' must have an object at the top level.",
            path
        ),
    }
}

pub fn json_object_to_bytes(object: &JsonMap<String, JsonValue>) -> anyhow::Result<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(&JsonValue::Object(
        object.clone(),
    ))?)
}

/// Pull a value from a `FileMap` and parse it as JSON, attaching the source
/// name (`refs/heads/main`, `working tree`, …) to any error so the user can
/// see which copy failed to parse.
pub fn parse_json_value_at(
    map: &FileMap,
    rel_path: &str,
    source: &str,
) -> anyhow::Result<Option<JsonValue>> {
    match map.get(rel_path) {
        Some(bytes) => Ok(Some(serde_json::from_slice(bytes).with_context(|| {
            format!("failed to parse {source} blob at {rel_path} as JSON")
        })?)),
        None => Ok(None),
    }
}

/// Read a nested field (dot-separated) from a JSON object. `metadata.author`
/// drills into `metadata`'s child object.
pub fn read_nested_json_value(
    object: &JsonMap<String, JsonValue>,
    field: &str,
) -> Option<JsonValue> {
    let mut current = object.get(field.split('.').next()?)?;
    let mut parts = field.split('.');
    parts.next()?;

    for part in parts {
        current = current.as_object()?.get(part)?;
    }

    Some(current.clone())
}

/// Write a nested field (dot-separated) into a JSON object. `Some(v)` sets;
/// `None` deletes. Empty intermediate objects are pruned.
pub fn apply_nested_json_value(
    object: &mut JsonMap<String, JsonValue>,
    field: &str,
    value: Option<JsonValue>,
) {
    let parts: Vec<&str> = field.split('.').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return;
    }
    apply_nested_json_value_parts(object, &parts, value);
}

fn apply_nested_json_value_parts(
    object: &mut JsonMap<String, JsonValue>,
    parts: &[&str],
    value: Option<JsonValue>,
) -> bool {
    if parts.len() == 1 {
        match value {
            Some(value) => {
                object.insert(parts[0].to_string(), value);
            }
            None => {
                object.remove(parts[0]);
            }
        }
        return object.is_empty();
    }

    let key = parts[0].to_string();
    let child = object
        .entry(key.clone())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if !child.is_object() {
        *child = JsonValue::Object(JsonMap::new());
    }
    let should_prune =
        apply_nested_json_value_parts(child.as_object_mut().unwrap(), &parts[1..], value);
    if should_prune {
        object.remove(&key);
    }
    object.is_empty()
}

/// True iff the patch object's "logical" keys include `field` (supports
/// dotted nested keys like `metadata.author`). Walks the object tree the same
/// way `read_nested_json_value` does so the field-mention check agrees with
/// what would actually be read at lookup time.
pub fn patch_object_mentions_field(object: &JsonMap<String, JsonValue>, field: &str) -> bool {
    read_nested_json_value(object, field).is_some()
}

// ---------------------------------------------------------------------------
// Patch <-> blob bridge
// ---------------------------------------------------------------------------

/// Per-file analogue of [`compute_accepted_state`]. Returns the approved blob
/// bytes for a single path, or `None` when the entry says the path is
/// approved-deleted.
///
/// - `Create`: `entry.patch` is the full file content; serialize it.
/// - `Update`: parse the `main` blob (or treat as `null` if missing — this is
///   a pathological state caused by something earlier in the pipeline;
///   `re_anchor` converts server-side deletes to `Create` at pull time so
///   `Update` against `None` shouldn't normally occur) and apply the RFC 7396
///   patch.
/// - `Delete`: returns `None` so callers can `out.remove(path)`.
pub fn apply_patch_entry_to_blob(
    main_blob: Option<&[u8]>,
    entry: &AnchoredPatch,
) -> anyhow::Result<Option<Vec<u8>>> {
    match entry.kind {
        PatchKind::Delete => Ok(None),
        PatchKind::Create => Ok(Some(serde_json::to_vec_pretty(&entry.patch).with_context(
            || {
                format!(
                    "failed to serialize accepted Create patch for {}",
                    entry.path
                )
            },
        )?)),
        PatchKind::Update => {
            let base: JsonValue = match main_blob {
                Some(bytes) => serde_json::from_slice(bytes).with_context(|| {
                    format!(
                        "failed to parse refs/heads/main blob at {} as JSON",
                        entry.path
                    )
                })?,
                None => JsonValue::Null,
            };
            let merged = crate::shared::merge_patch::apply(&base, &entry.patch);
            Ok(Some(serde_json::to_vec_pretty(&merged).with_context(
                || format!("failed to serialize accepted Update for {}", entry.path),
            )?))
        }
    }
}

/// Roll an entire accepted-patches file forward against `main_map`, producing
/// the per-file "approved" view. Drives folder_index column compute and any
/// caller that needs the synthetic approved tree (= what would land on `main`
/// if all accepted edits were published).
pub fn compute_accepted_state(
    main_map: &FileMap,
    file: &AcceptedPatchesFile,
) -> anyhow::Result<FileMap> {
    let mut out = main_map.clone();
    for entry in &file.patches {
        match apply_patch_entry_to_blob(
            main_map.get(entry.path.as_str()).map(|b| b.as_slice()),
            entry,
        )? {
            Some(bytes) => {
                out.insert(entry.path.clone(), bytes);
            }
            None => {
                out.remove(entry.path.as_str());
            }
        }
    }
    Ok(out)
}

/// Return the parsed "approved" object for a path: the per-file
/// `apply(main_blob, patch_entry)` if an entry exists, else the parsed main
/// blob, else `None` (path is approved-deleted or simply doesn't exist).
pub fn approved_object_for_path(
    main_map: &FileMap,
    file: &AcceptedPatchesFile,
    path: &str,
) -> anyhow::Result<Option<JsonMap<String, JsonValue>>> {
    if let Some(entry) = accepted_patches::get_entry(file, path) {
        match apply_patch_entry_to_blob(main_map.get(path).map(|v| v.as_slice()), entry)? {
            Some(bytes) => Ok(Some(parse_json_object_bytes(&bytes, path)?)),
            None => Ok(None),
        }
    } else if let Some(bytes) = main_map.get(path) {
        Ok(Some(parse_json_object_bytes(bytes, path)?))
    } else {
        Ok(None)
    }
}

/// Enumerate in-folder paths that any of (main, local, patch entries) cares
/// about. Field-level commands walk this union so a path that exists only in
/// the patch (locally deleted but with an accepted edit, say) still gets
/// considered.
pub fn field_paths_in_folder(
    main_map: &FileMap,
    local_map: &FileMap,
    file: &AcceptedPatchesFile,
    repo_folder: &str,
) -> Vec<String> {
    let mut paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for key in main_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    for key in local_map.keys() {
        if is_data_path_in_folder(key, repo_folder) {
            paths.insert(key.clone());
        }
    }
    for entry in &file.patches {
        if is_data_path_in_folder(&entry.path, repo_folder) {
            paths.insert(entry.path.clone());
        }
    }
    paths.into_iter().collect()
}

// ---------------------------------------------------------------------------
// Field-level mutators
// ---------------------------------------------------------------------------

/// Folder-scoped, field-level accept. For each file in `repo_folder` where
/// `local[field] != approved[field]`, fold that field's local value into the
/// file's `accepted-patches.json` entry (creating, updating, or removing the
/// entry as the new approved state demands). Working files are NOT touched —
/// accept moves the patch, not the worktree.
///
/// The approved state for a path is `apply(main_blob, patch_entry)` when an
/// entry exists, else `main_blob` itself. The new patch entry comes from
/// `re_anchor::compute_entry(path, main, next_approved)`, which produces the
/// right `Create` / `Update` / `Delete` shape automatically.
///
/// Whole-file deletes (`local` missing, anything in approved) are skipped —
/// field-level accept doesn't apply to a file that no longer exists locally.
pub fn accept_field_in_folder(
    conn_dir_name: &str,
    repo_folder: &str,
    field: &str,
    main_map: &FileMap,
    file: &mut AcceptedPatchesFile,
    local_map: &FileMap,
) -> anyhow::Result<FieldCommandResult> {
    let mut result = FieldCommandResult::default();
    let paths = field_paths_in_folder(main_map, local_map, file, repo_folder);

    for path in paths {
        let Some(local_content) = local_map.get(path.as_str()) else {
            // Locally deleted: whole-file delete is not a field-level target.
            continue;
        };
        let local_obj = parse_json_object_bytes(local_content, path.as_str())?;

        let approved_obj_opt = approved_object_for_path(main_map, file, &path)?;
        let approved_value = approved_obj_opt
            .as_ref()
            .and_then(|obj| read_nested_json_value(obj, field));
        let local_value = read_nested_json_value(&local_obj, field);

        if local_value == approved_value {
            continue;
        }

        // Compose the new approved object: existing approved (or empty if
        // missing) with `field ← local_value` applied.
        let mut next_approved = approved_obj_opt.unwrap_or_default();
        apply_nested_json_value(&mut next_approved, field, local_value);

        let main_parsed = parse_json_value_at(main_map, path.as_str(), "refs/heads/main")?;
        let next_approved_value = if next_approved.is_empty() && main_parsed.is_none() {
            // Both ends agree the file shouldn't exist — drop any entry.
            None
        } else {
            Some(JsonValue::Object(next_approved))
        };

        match crate::shared::re_anchor::compute_entry(
            path.as_str(),
            main_parsed.as_ref(),
            next_approved_value.as_ref(),
        ) {
            Some(new_entry) => {
                accepted_patches::upsert_entry(file, new_entry);
            }
            None => {
                accepted_patches::remove_entry(file, path.as_str());
            }
        }

        result
            .changed_paths
            .push(format!("{}/{}", conn_dir_name, path));
        result.patches_changed = true;
    }

    Ok(result)
}

/// Folder-scoped, field-level reject. For each file in `repo_folder` where
/// `local[field] != approved[field]`, restore the working file's field to its
/// approved value. The accepted-patches file is **not** touched — reject only
/// undoes the unreviewed delta between working and approved (decision 35).
///
/// Pre-B `reject_field` had a hybrid second branch that also rolled the dirty
/// branch back to master when a field was already approved. That behavior is
/// now exclusively `discard_field_in_folder`'s job; reject is a no-op on an
/// already-approved field.
pub fn reject_field_in_folder(
    conn_dir_name: &str,
    repo_folder: &str,
    field: &str,
    main_map: &FileMap,
    file: &AcceptedPatchesFile,
    local_map: &FileMap,
) -> anyhow::Result<(FileMap, FieldCommandResult)> {
    let mut next_local_map = local_map.clone();
    let mut result = FieldCommandResult::default();
    let paths = field_paths_in_folder(main_map, local_map, file, repo_folder);

    for path in paths {
        let Some(local_content) = local_map.get(path.as_str()) else {
            // Locally deleted: field-level reject doesn't apply.
            continue;
        };
        let local_obj = parse_json_object_bytes(local_content, path.as_str())?;

        let approved_obj_opt = approved_object_for_path(main_map, file, &path)?;
        let approved_value = approved_obj_opt
            .as_ref()
            .and_then(|obj| read_nested_json_value(obj, field));
        let local_value = read_nested_json_value(&local_obj, field);

        if local_value == approved_value {
            continue;
        }

        let mut next_local_obj = local_obj;
        apply_nested_json_value(&mut next_local_obj, field, approved_value);
        if next_local_obj.is_empty() {
            // Restoring the only field of a created-only file to "approved =
            // doesn't exist" means the working file shouldn't exist either.
            next_local_map.remove(path.as_str());
        } else {
            next_local_map.insert(path.clone(), json_object_to_bytes(&next_local_obj)?);
        }

        result
            .changed_paths
            .push(format!("{}/{}", conn_dir_name, path));
    }

    Ok((next_local_map, result))
}

/// Folder-scoped, field-level discard. Per file in `repo_folder`, drop the
/// named field from any accepted-patches entry AND restore the working
/// file's value for that field to whatever `refs/heads/main` says.
///
/// Three outputs:
///   - `next_local_map` — the working tree's content after the discard
///     (caller writes it back via [`apply_changed_working_files`]).
///   - `result.changed_paths` — workspace-prefixed paths the operation
///     touched (caller surfaces these and reindexes the folder index).
///   - `result.patches_changed` — true iff the call mutated
///     `accepted-patches.json`. Caller decides whether to save_atomic.
///
/// Special handling for the lifecycle edge: stripping the last field from
/// a `Create` entry drops the entry AND removes the working file, since
/// "discard back to published" for a never-published record means "the
/// record no longer exists." `Delete` entries are no-ops — use
/// `restore-deleted-record` to undo a whole-file delete.
pub fn discard_field_in_folder(
    conn_dir_name: &str,
    repo_folder: &str,
    field: &str,
    main_map: &FileMap,
    file: &mut AcceptedPatchesFile,
    local_map: &FileMap,
) -> anyhow::Result<(FileMap, FieldCommandResult)> {
    let mut next_local_map = local_map.clone();
    let mut result = FieldCommandResult::default();
    let mut entries_to_drop: Vec<String> = Vec::new();

    let paths = field_paths_in_folder(main_map, local_map, file, repo_folder);

    for path in paths {
        let published_value = match main_map.get(path.as_str()) {
            Some(bytes) => {
                let obj = parse_json_object_bytes(bytes, path.as_str())?;
                read_nested_json_value(&obj, field)
            }
            None => None,
        };
        let main_has_path = main_map.contains_key(path.as_str());

        let mut patch_action = PatchAction::Untouched;
        if let Some(entry) = file.patches.iter_mut().find(|e| e.path == path) {
            match entry.kind {
                PatchKind::Update => {
                    if let JsonValue::Object(map) = &mut entry.patch {
                        if patch_object_mentions_field(map, field) {
                            apply_nested_json_value(map, field, None);
                            if map.is_empty() {
                                entries_to_drop.push(path.clone());
                                patch_action = PatchAction::Dropped;
                            } else {
                                patch_action = PatchAction::Modified;
                            }
                        }
                    }
                }
                PatchKind::Create => {
                    if let JsonValue::Object(map) = &mut entry.patch {
                        if patch_object_mentions_field(map, field) {
                            apply_nested_json_value(map, field, None);
                            if map.is_empty() {
                                entries_to_drop.push(path.clone());
                                patch_action = PatchAction::DroppedCreate;
                            } else {
                                patch_action = PatchAction::Modified;
                            }
                        }
                    }
                }
                PatchKind::Delete => {
                    // Field-level discard on a Delete entry is a no-op.
                    continue;
                }
            }
        }

        // Update the working file's view of this field. If we just emptied
        // a Create, the file no longer exists at the approved state and
        // should be removed from the worktree.
        let working_touched = match patch_action {
            PatchAction::DroppedCreate => {
                next_local_map.remove(path.as_str());
                true
            }
            _ => {
                let current = local_map.get(path.as_str());
                match current {
                    Some(bytes) => {
                        let mut obj = parse_json_object_bytes(bytes, path.as_str())?;
                        let current_field = read_nested_json_value(&obj, field);
                        if current_field == published_value
                            && matches!(patch_action, PatchAction::Untouched)
                        {
                            // Nothing actually moves for this path.
                            false
                        } else {
                            apply_nested_json_value(&mut obj, field, published_value);
                            next_local_map.insert(path.clone(), json_object_to_bytes(&obj)?);
                            true
                        }
                    }
                    None => {
                        // Working file is absent. If main has the file
                        // (we just dropped an Update entry, say), the
                        // worktree should now mirror main for this path.
                        if main_has_path && !matches!(patch_action, PatchAction::Untouched) {
                            if let Some(main_bytes) = main_map.get(path.as_str()) {
                                let mut obj = parse_json_object_bytes(main_bytes, path.as_str())?;
                                apply_nested_json_value(&mut obj, field, published_value);
                                next_local_map.insert(path.clone(), json_object_to_bytes(&obj)?);
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    }
                }
            }
        };

        if working_touched || !matches!(patch_action, PatchAction::Untouched) {
            result
                .changed_paths
                .push(format!("{}/{}", conn_dir_name, path));
            if !matches!(patch_action, PatchAction::Untouched) {
                result.patches_changed = true;
            }
        }
    }

    for path in entries_to_drop {
        file.patches.retain(|e| e.path != path);
    }

    Ok((next_local_map, result))
}

// ---------------------------------------------------------------------------
// Working-tree I/O
// ---------------------------------------------------------------------------

/// Write a single working-tree file, or remove it if `bytes` is `None`.
/// Used by reject / discard to restore approved / published state.
pub fn write_or_remove_working_file(
    paths: &ConnectionPaths,
    rel_path: &str,
    bytes: Option<&[u8]>,
) -> anyhow::Result<()> {
    let disk_path = paths.worktree_dir.join(rel_path);
    match bytes {
        Some(content) => write_file(&disk_path, content)?,
        None => {
            if disk_path.exists() {
                std::fs::remove_file(&disk_path).with_context(|| {
                    format!("failed to remove working file {}", disk_path.display())
                })?;
            }
        }
    }
    Ok(())
}

/// Write back changed working files from `next_local_map` to disk under
/// `paths.worktree_dir`, scoped to `repo_folder`. Used by reject / discard after
/// they compute the new desired working-tree shape.
pub fn apply_changed_working_files(
    paths: &ConnectionPaths,
    previous_local_map: &FileMap,
    next_local_map: &FileMap,
    repo_folder: &str,
) -> anyhow::Result<()> {
    for path in iter_data_paths_in_folder(previous_local_map, next_local_map, None, repo_folder) {
        let before = previous_local_map.get(path.as_str());
        let after = next_local_map.get(path.as_str());
        if before == after {
            continue;
        }

        let disk_path = paths.worktree_dir.join(&path);
        match after {
            Some(content) => write_file(&disk_path, content)?,
            None => {
                if disk_path.exists() {
                    std::fs::remove_file(&disk_path)?;
                }
            }
        }
    }

    Ok(())
}

pub fn write_file(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Working-tree reads
// ---------------------------------------------------------------------------

/// Read the user's editable directory + the per-connection `.scratch/` state
/// into a single `FileMap`. Schema/validation/state files appear under
/// `.scratch/<rel>` keys; record files appear under their normal repo-relative
/// path. Mirrors what `read_main_tree` produces from git.
pub fn read_materialized_repo(paths: &ConnectionPaths) -> anyhow::Result<FileMap> {
    let mut map = FileMap::new();
    read_dirty_disk(&paths.worktree_dir, &paths.worktree_dir, &mut map)?;
    read_scratch_disk(&paths.scratch_dir, &paths.scratch_dir, &mut map)?;
    Ok(map)
}

pub fn read_dirty_disk(root: &Path, dir: &Path, map: &mut FileMap) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;

        if ft.is_dir() {
            match name_str.as_ref() {
                "syncs" => continue,
                value if value.starts_with('.') => continue,
                _ => read_dirty_disk(root, &entry.path(), map)?,
            }
        } else if ft.is_file() {
            if name_str.starts_with('.') && !name_str.ends_with(".json") {
                continue;
            }
            let rel = entry.path().strip_prefix(root)?.to_slash_lossy();
            let content = normalize_crlf(std::fs::read(entry.path())?);
            map.insert(rel, content);
        }
    }

    Ok(())
}

pub fn read_scratch_disk(root: &Path, dir: &Path, map: &mut FileMap) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;

        if ft.is_dir() {
            if name_str.starts_with('.') && name_str != ".publish-plans" {
                continue;
            }
            read_scratch_disk(root, &entry.path(), map)?;
        } else if ft.is_file() {
            if name_str.starts_with('.') {
                continue;
            }
            let rel = entry.path().strip_prefix(root)?.to_slash_lossy();
            let content = normalize_crlf(std::fs::read(entry.path())?);
            map.insert(format!(".scratch/{rel}"), content);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Schema sync
// ---------------------------------------------------------------------------

/// Copy `schema.json` and `views/*.json` files from the user worktree's
/// tracked `.scratch/` tree into the per-connection `paths.scratch_dir` cache.
/// Run before field-level operations that consult the schema for type
/// coercion.
///
/// Pre-slice-F (when the user worktree was sparse on `dirty`), this read from
/// a second master worktree at `<workspace>/.scratch/connections/master/<conn>/`.
/// Post-slice-F-cutover, the single non-sparse worktree on `main` carries the
/// schemas + views natively, so the source is the user worktree itself.
///
/// The destination cache exists because the broader codebase
/// (`shared/validators`, `shared/plan_publish`, `shared/index`,
/// `cli/commands/validation`) reads schemas from `connection_scratch_path`,
/// not from the worktree. Repointing those readers is tracked as a post-F
/// follow-up (see slice F spec PF1).
pub fn sync_schema_files_from_worktree(paths: &ConnectionPaths) -> anyhow::Result<()> {
    sync_schema_files_from_worktree_paths(&paths.worktree_dir, &paths.scratch_dir)
}

/// Path-only variant of [`sync_schema_files_from_worktree`] for init-time
/// callers that don't yet have a fully-built `ConnectionPaths`.
pub fn sync_schema_files_from_worktree_paths(
    worktree_dir: &Path,
    scratch_dir: &Path,
) -> anyhow::Result<()> {
    let worktree_scratch = worktree_dir.join(".scratch");
    sync_schema_files_dir(&worktree_scratch, &worktree_scratch, scratch_dir)
}

fn sync_schema_files_dir(root: &Path, dir: &Path, scratch_dir: &Path) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            sync_schema_files_dir(root, &path, scratch_dir)?;
            continue;
        }

        if !ft.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        let is_schema = file_name == "schema.json";
        let is_view = file_name.to_str().is_some_and(|n| n.ends_with(".json"))
            && path
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|d| d == "views");
        if !is_schema && !is_view {
            continue;
        }

        let rel = path.strip_prefix(root)?;
        write_file(&scratch_dir.join(rel), &std::fs::read(&path)?)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// File content normalization
// ---------------------------------------------------------------------------

pub fn is_binary(data: &[u8]) -> bool {
    data.contains(&0)
}

/// Normalize CRLF to LF in JSON record files. Some Windows tools (and copy
/// operations from cloud-sync folders) produce CRLF endings; the bare repo's
/// blobs are always LF, so the comparison would falsely report changes if we
/// didn't normalize.
pub fn normalize_crlf(data: Vec<u8>) -> Vec<u8> {
    if !data.contains(&b'\r') || is_binary(&data) {
        return data;
    }

    let mut out = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        if data[index] == b'\r' && index + 1 < data.len() && data[index + 1] == b'\n' {
            index += 1;
        } else {
            out.push(data[index]);
        }
        index += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Public entry points (slice H.1.5) — single-record I/O-bundling ops the napi
// binding calls. CLI command wrappers can use these too, or call the folder-
// scoped helpers above directly when they're operating across many records.
//
// Each entry point bundles:
//   1. Resolve `(workspace_dir, connection_dir_name)` → `ConnectionPaths`.
//   2. Acquire `.scratch/lock` via the requested `LockMode`.
//   3. Open the bare repo and read `refs/heads/main` into a FileMap.
//   4. Load `accepted-patches.json`.
//   5. Mutate the patches file + the working file as the op demands.
//   6. Atomic save + return a `ReviewOpResult`.
//
// Mirrors the layout from `docs/plans/2026-05-20-slice-h-spec.md`.
// ---------------------------------------------------------------------------

const WORKSPACE_LOCK_SHORT_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

/// Connection lookup record loaded from `<workspace>/.scratch/workspace.yaml`.
/// Mirrors the subset of cli's `markers::ConnectionEntry` review_ops needs;
/// keeping a private shape here avoids dragging cli's full marker module into
/// shared until slice F retires the worktree layout.
#[derive(serde::Deserialize)]
struct LocalConnectionEntry {
    #[serde(rename = "repoPath", default)]
    repo_path: String,
    #[serde(rename = "dirName", default)]
    dir_name: String,
}

#[derive(serde::Deserialize)]
struct LocalWorkspaceMarker {
    #[serde(default)]
    connections: Vec<LocalConnectionEntry>,
}

/// Resolve `(workspace_dir, connection_dir_name)` to a `ConnectionPaths` by
/// reading the workspace marker at `<workspace>/.scratch/workspace.yaml`. The
/// entry points call this before doing anything else; failures surface as
/// `WorkspaceNotFound` (marker missing or unreadable) or `UnknownConnection`
/// (no entry matches `connection_dir_name`).
fn resolve_connection_paths(
    workspace_dir: &Path,
    connection_dir_name: &str,
) -> Result<ConnectionPaths, ReviewOpError> {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    // The canonical workspace marker lives at `<workspace>/.scratch/.scratchmd`.
    // Mirrors `cli/config/markers::marker_path`. Don't confuse with
    // `<workspace>/.scratch/workspace/` (the materialization directory) — same
    // prefix, different role.
    let marker_path = layout.scratch_root().join(".scratchmd");
    let content = match std::fs::read_to_string(&marker_path) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReviewOpError::WorkspaceNotFound(
                workspace_dir.to_path_buf(),
            ));
        }
        Err(err) => return Err(ReviewOpError::Io(err)),
    };
    let marker: LocalWorkspaceMarker = serde_yaml::from_str(&content)
        .map_err(|err| ReviewOpError::Internal(anyhow::anyhow!(err)))?;
    let entry = marker
        .connections
        .into_iter()
        .find(|c| c.dir_name == connection_dir_name)
        .ok_or_else(|| ReviewOpError::UnknownConnection(connection_dir_name.to_string()))?;
    if entry.repo_path.is_empty() {
        return Err(ReviewOpError::UnknownConnection(
            connection_dir_name.to_string(),
        ));
    }

    Ok(ConnectionPaths {
        conn_dir_name: connection_dir_name.to_string(),
        workspace_dir: workspace_dir.to_path_buf(),
        worktree_dir: layout.worktree_path(connection_dir_name),
        scratch_dir: layout.connection_scratch_path(connection_dir_name),
        bare_repo: layout.bare_repo_path(&entry.repo_path),
    })
}

/// Acquire `.scratch/lock` using the requested mode. CLI's 30s blocking
/// behavior maps to `DefaultBlocking`; napi's short-wait maps to `ShortWait`.
fn acquire_lock(
    workspace_dir: &Path,
    mode: LockMode,
) -> Result<crate::shared::workspace_lock::WorkspaceLockGuard, ReviewOpError> {
    match mode {
        LockMode::DefaultBlocking => crate::shared::workspace_lock::acquire(workspace_dir)
            .map_err(|err| ReviewOpError::Internal(err)),
        LockMode::ShortWait => crate::shared::workspace_lock::try_acquire_with_short_wait(
            workspace_dir,
            WORKSPACE_LOCK_SHORT_WAIT,
        )
        .map_err(ReviewOpError::from),
    }
}

fn read_main_tree_for_entry_point(bare_repo: &Path) -> Result<FileMap, ReviewOpError> {
    read_main_tree_for_entry_point_filtered(bare_repo, |_| true)
}

/// Read `refs/heads/main` with a path-level filter applied at the
/// `git ls-tree` stage so `cat-file --batch` only processes matching blobs.
/// Lets paginated callers (e.g. [`read_folder_blobs_filtered`]) read only
/// the records they need rather than the whole tree.
fn read_main_tree_for_entry_point_filtered<F>(
    bare_repo: &Path,
    keep: F,
) -> Result<FileMap, ReviewOpError>
where
    F: Fn(&str) -> bool,
{
    match crate::shared::git_local::rev_parse_optional_to_string(bare_repo, "refs/heads/main")
        .map_err(ReviewOpError::Internal)?
    {
        Some(hash) => crate::shared::git_local::read_tree_files_filtered(bare_repo, &hash, keep)
            .map_err(ReviewOpError::Internal),
        None => Ok(FileMap::new()),
    }
}

/// Path-only walk of `refs/heads/main`. Same scope predicate plumbing as
/// [`read_main_tree_for_entry_point_filtered`] but skips `cat-file` entirely.
fn list_main_tree_paths_filtered<F>(bare_repo: &Path, keep: F) -> Result<Vec<String>, ReviewOpError>
where
    F: Fn(&str) -> bool,
{
    match crate::shared::git_local::rev_parse_optional_to_string(bare_repo, "refs/heads/main")
        .map_err(ReviewOpError::Internal)?
    {
        Some(hash) => crate::shared::git_local::list_tree_paths_filtered(bare_repo, &hash, keep)
            .map_err(ReviewOpError::Internal),
        None => Ok(Vec::new()),
    }
}

fn workspace_path_for(paths: &ConnectionPaths, rel: &str) -> String {
    format!("{}/{}", paths.conn_dir_name, rel)
}

fn validate_record_path(
    paths: &ConnectionPaths,
    record_rel_path: &str,
) -> Result<(), ReviewOpError> {
    if !is_data_path_in_folder(record_rel_path, "") {
        return Err(ReviewOpError::NotARecordPath {
            connection: paths.conn_dir_name.clone(),
            path: record_rel_path.to_string(),
        });
    }
    Ok(())
}

/// Public entry point. Accept the user's `local_value` for `field` on
/// `record_rel_path` under `connection_dir_name`. Reads the field's current
/// value from the working file on disk and folds it into
/// `accepted-patches.json` so the field's approved value matches what's on
/// disk now. The working file itself is not touched — callers (the desktop's
/// cell-edit IPC handlers, the CLI's accept-field command) are responsible
/// for writing the user's typed value to the working file BEFORE calling
/// this entry point. See `docs/REVIEW_MODEL.md`.
///
/// Errors with `ReviewOpError::WorkingFileMissing` if there's no file at
/// `<worktree_dir>/<record_rel_path>` to read. No-op (returns
/// `ReviewOpResult { effect: NoOp, .. }`) if the working file's field value
/// already matches the approved value.
pub fn accept_field(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,
    field: &str,
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError> {
    let paths = resolve_connection_paths(workspace_dir, connection_dir_name)?;
    validate_record_path(&paths, record_rel_path)?;
    let workspace_path = workspace_path_for(&paths, record_rel_path);

    let _lock = acquire_lock(workspace_dir, lock_mode)?;

    // Read the field's current value from the working file. This is the
    // single source of truth for "what value got accepted" — callers wrote
    // it to disk before invoking us.
    let working_path = paths.worktree_dir.join(record_rel_path);
    let working_bytes = match std::fs::read(&working_path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReviewOpError::WorkingFileMissing(workspace_path));
        }
        Err(err) => return Err(ReviewOpError::Io(err)),
    };
    let working_obj = parse_json_object_bytes(&working_bytes, record_rel_path)
        .map_err(ReviewOpError::Internal)?;
    let local_value = read_nested_json_value(&working_obj, field);

    let main_map = read_main_tree_for_entry_point(&paths.bare_repo)?;
    let connection_dir = accepted_patches_dir(&paths);
    let mut file = accepted_patches::load(&connection_dir).map_err(ReviewOpError::Internal)?;

    let approved_obj_opt = approved_object_for_path(&main_map, &file, record_rel_path)
        .map_err(ReviewOpError::Internal)?;
    let approved_value = approved_obj_opt
        .as_ref()
        .and_then(|obj| read_nested_json_value(obj, field));

    if local_value == approved_value {
        return Ok(ReviewOpResult {
            workspace_path,
            patches_changed: false,
            working_changed: false,
            effect: ReviewOpEffect::NoOp,
        });
    }

    // Compose the new approved object: existing approved (or empty if
    // missing) with the field set to the working file's current value. Then
    // ask `compute_entry` to produce the right Create / Update / Delete
    // shape.
    let mut next_approved = approved_obj_opt.unwrap_or_default();
    apply_nested_json_value(&mut next_approved, field, local_value);

    let main_parsed = parse_json_value_at(&main_map, record_rel_path, "refs/heads/main")
        .map_err(ReviewOpError::Internal)?;
    let next_approved_value = if next_approved.is_empty() && main_parsed.is_none() {
        None
    } else {
        Some(JsonValue::Object(next_approved))
    };

    let mut patches_changed = false;
    let mut effect = ReviewOpEffect::NoOp;
    match crate::shared::re_anchor::compute_entry(
        record_rel_path,
        main_parsed.as_ref(),
        next_approved_value.as_ref(),
    ) {
        Some(new_entry) => {
            accepted_patches::upsert_entry(&mut file, new_entry);
            patches_changed = true;
            effect = ReviewOpEffect::PatchUpserted;
        }
        None => {
            if accepted_patches::get_entry(&file, record_rel_path).is_some() {
                accepted_patches::remove_entry(&mut file, record_rel_path);
                patches_changed = true;
                effect = ReviewOpEffect::PatchDropped;
            }
        }
    }

    if patches_changed {
        accepted_patches::save_atomic(&connection_dir, &file).map_err(ReviewOpError::Internal)?;
    }

    Ok(ReviewOpResult {
        workspace_path,
        patches_changed,
        working_changed: false,
        effect,
    })
}

/// Public entry point. Discard the field on `record_rel_path`: drop it from
/// any patch entry AND restore the working file's value for that field to
/// whatever `refs/heads/main` says. Stripping the last field from a `Create`
/// entry drops the entry AND removes the working file (the record is being
/// rolled back to "never existed"). `Delete` entries are no-ops at the
/// field level — use `restore_deleted_record` to undo a whole-file delete.
pub fn discard_field(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,
    field: &str,
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError> {
    let paths = resolve_connection_paths(workspace_dir, connection_dir_name)?;
    validate_record_path(&paths, record_rel_path)?;
    let workspace_path = workspace_path_for(&paths, record_rel_path);

    let _lock = acquire_lock(workspace_dir, lock_mode)?;

    let main_map = read_main_tree_for_entry_point(&paths.bare_repo)?;
    let connection_dir = accepted_patches_dir(&paths);
    let mut file = accepted_patches::load(&connection_dir).map_err(ReviewOpError::Internal)?;

    let published_value = match main_map.get(record_rel_path) {
        Some(bytes) => {
            let obj =
                parse_json_object_bytes(bytes, record_rel_path).map_err(ReviewOpError::Internal)?;
            read_nested_json_value(&obj, field)
        }
        None => None,
    };
    let main_has_path = main_map.contains_key(record_rel_path);

    let mut patch_action = PatchAction::Untouched;
    if let Some(entry) = file.patches.iter_mut().find(|e| e.path == record_rel_path) {
        match entry.kind {
            PatchKind::Update => {
                if let JsonValue::Object(map) = &mut entry.patch {
                    if patch_object_mentions_field(map, field) {
                        apply_nested_json_value(map, field, None);
                        patch_action = if map.is_empty() {
                            PatchAction::Dropped
                        } else {
                            PatchAction::Modified
                        };
                    }
                }
            }
            PatchKind::Create => {
                if let JsonValue::Object(map) = &mut entry.patch {
                    if patch_object_mentions_field(map, field) {
                        apply_nested_json_value(map, field, None);
                        patch_action = if map.is_empty() {
                            PatchAction::DroppedCreate
                        } else {
                            PatchAction::Modified
                        };
                    }
                }
            }
            PatchKind::Delete => {
                // Field-level discard on a Delete entry is a no-op.
                return Ok(ReviewOpResult {
                    workspace_path,
                    patches_changed: false,
                    working_changed: false,
                    effect: ReviewOpEffect::NoOp,
                });
            }
        }
    }

    let mut patches_changed = matches!(
        patch_action,
        PatchAction::Modified | PatchAction::Dropped | PatchAction::DroppedCreate
    );
    let mut working_changed = false;

    if matches!(patch_action, PatchAction::DroppedCreate) {
        // Patch's gone and main never had this path — remove the working file.
        let disk_path = paths.worktree_dir.join(record_rel_path);
        if disk_path.exists() {
            std::fs::remove_file(&disk_path).map_err(ReviewOpError::Io)?;
            working_changed = true;
        }
    } else {
        // Update or no-op patch case: bring the working file's field back to
        // `published_value` (or to whatever main says if the working file
        // happens to be missing on disk).
        let disk_path = paths.worktree_dir.join(record_rel_path);
        let current_bytes = std::fs::read(&disk_path).ok();
        let needs_write = match &current_bytes {
            Some(bytes) => {
                let obj = parse_json_object_bytes(bytes, record_rel_path)
                    .map_err(ReviewOpError::Internal)?;
                let current_field = read_nested_json_value(&obj, field);
                // Skip the rewrite if the working file already matches
                // published AND nothing in the patch moved. Matches the
                // folder helper's "Untouched + already-matching" branch.
                !(current_field == published_value
                    && matches!(patch_action, PatchAction::Untouched))
            }
            None => main_has_path && !matches!(patch_action, PatchAction::Untouched),
        };

        if needs_write {
            let base_bytes = current_bytes
                .as_deref()
                .or_else(|| main_map.get(record_rel_path).map(|v| v.as_slice()));
            if let Some(bytes) = base_bytes {
                let mut obj = parse_json_object_bytes(bytes, record_rel_path)
                    .map_err(ReviewOpError::Internal)?;
                apply_nested_json_value(&mut obj, field, published_value);
                let new_bytes = json_object_to_bytes(&obj).map_err(ReviewOpError::Internal)?;
                write_or_remove_working_file(&paths, record_rel_path, Some(&new_bytes))
                    .map_err(ReviewOpError::Internal)?;
                working_changed = true;
            }
        }
    }

    // Drop the entry from the patch file last so the working-file write above
    // had its chance to inspect it.
    if matches!(
        patch_action,
        PatchAction::Dropped | PatchAction::DroppedCreate
    ) {
        accepted_patches::remove_entry(&mut file, record_rel_path);
    }

    if patches_changed {
        accepted_patches::save_atomic(&connection_dir, &file).map_err(ReviewOpError::Internal)?;
    } else {
        patches_changed = false;
    }

    let effect = match (patches_changed, working_changed) {
        (true, _) if matches!(patch_action, PatchAction::Modified) => ReviewOpEffect::PatchUpserted,
        (true, _) => ReviewOpEffect::PatchDropped,
        (false, true) => ReviewOpEffect::WorkingRestored,
        (false, false) => ReviewOpEffect::NoOp,
    };

    Ok(ReviewOpResult {
        workspace_path,
        patches_changed,
        working_changed,
        effect,
    })
}

/// Public entry point. Undo an accepted delete on `record_rel_path`. Errors
/// when the path doesn't have a `Delete` entry in `accepted-patches.json` or
/// when `refs/heads/main` doesn't have the path (we'd have nothing to
/// restore from).
pub fn restore_deleted_record(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError> {
    let paths = resolve_connection_paths(workspace_dir, connection_dir_name)?;
    validate_record_path(&paths, record_rel_path)?;
    let workspace_path = workspace_path_for(&paths, record_rel_path);

    let _lock = acquire_lock(workspace_dir, lock_mode)?;

    let main_map = read_main_tree_for_entry_point(&paths.bare_repo)?;
    let connection_dir = accepted_patches_dir(&paths);
    let mut file = accepted_patches::load(&connection_dir).map_err(ReviewOpError::Internal)?;

    let entry = accepted_patches::get_entry(&file, record_rel_path)
        .ok_or_else(|| ReviewOpError::NotAnApprovedDelete(workspace_path.clone()))?;
    if entry.kind != PatchKind::Delete {
        return Err(ReviewOpError::NotAnApprovedDelete(workspace_path));
    }
    let main_content = main_map
        .get(record_rel_path)
        .cloned()
        .ok_or_else(|| ReviewOpError::RestoreSourceMissing(workspace_path.clone()))?;

    accepted_patches::remove_entry(&mut file, record_rel_path);
    write_file(&paths.worktree_dir.join(record_rel_path), &main_content)
        .map_err(ReviewOpError::Internal)?;
    accepted_patches::save_atomic(&connection_dir, &file).map_err(ReviewOpError::Internal)?;

    Ok(ReviewOpResult {
        workspace_path,
        patches_changed: true,
        working_changed: true,
        effect: ReviewOpEffect::PatchDropped,
    })
}

/// Public entry point. Undo an accepted create on `record_rel_path`. Errors
/// when the path doesn't have a `Create` entry or when `refs/heads/main`
/// already contains the path (the record was, in fact, published — discarding
/// the local "create" would silently drop the user's record metadata).
///
/// Does NOT do the remote-dirty-cleanup hack that the CLI's
/// `run_discard_created_record` performs (calling
/// `discard_remote_dirty_changes`); that's a CLI-only orchestration concern
/// that stays in the CLI command wrapper.
pub fn discard_created_record(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError> {
    let paths = resolve_connection_paths(workspace_dir, connection_dir_name)?;
    validate_record_path(&paths, record_rel_path)?;
    let workspace_path = workspace_path_for(&paths, record_rel_path);

    let _lock = acquire_lock(workspace_dir, lock_mode)?;

    let main_map = read_main_tree_for_entry_point(&paths.bare_repo)?;
    let connection_dir = accepted_patches_dir(&paths);
    let mut file = accepted_patches::load(&connection_dir).map_err(ReviewOpError::Internal)?;

    if main_map.contains_key(record_rel_path) {
        return Err(ReviewOpError::CreateClashesWithMain(workspace_path));
    }

    let entry = accepted_patches::get_entry(&file, record_rel_path)
        .ok_or_else(|| ReviewOpError::NotAnApprovedCreate(workspace_path.clone()))?;
    if entry.kind != PatchKind::Create {
        return Err(ReviewOpError::NotAnApprovedCreate(workspace_path));
    }

    accepted_patches::remove_entry(&mut file, record_rel_path);

    let disk_path = paths.worktree_dir.join(record_rel_path);
    let mut working_changed = false;
    if disk_path.exists() {
        std::fs::remove_file(&disk_path).map_err(ReviewOpError::Io)?;
        working_changed = true;
    }

    accepted_patches::save_atomic(&connection_dir, &file).map_err(ReviewOpError::Internal)?;

    Ok(ReviewOpResult {
        workspace_path,
        patches_changed: true,
        working_changed,
        effect: ReviewOpEffect::PatchDropped,
    })
}

// ---------------------------------------------------------------------------
// Folder read entry point (slice F.5) — the desktop's grid view reads
// `(published, approved)` for every record in a folder so it can render the
// per-row diff status (added / modified / unpublished / unchanged / deleted)
// without consulting the deleted `dirty`/`master` worktrees. "Working" stays
// a TS-side filesystem read.
// ---------------------------------------------------------------------------

/// One record file in a folder, returned by [`read_folder_blobs`].
///
/// - `published` = the file's bytes at `refs/heads/main:<folder>/<filename>`,
///   or `None` if the file doesn't exist on `main` (= new record).
/// - `approved` = `apply(published, accepted-patches.json entry)`. `None`
///   when the entry is a `Delete` (the file is approved-deleted) OR when the
///   file is absent from both main and the patch file (shouldn't happen for
///   filenames this returns).
///
/// Empty patch entries and missing-from-main + Update entries are handled
/// per [`apply_patch_entry_to_blob`].
#[derive(Debug)]
pub struct FolderBlob {
    pub filename: String,
    pub published: Option<Vec<u8>>,
    pub approved: Option<Vec<u8>>,
}

/// Read the `published` + `approved` content for every record file directly
/// inside `<workspace>/<connection_dir_name>/<folder_rel_path>/`.
///
/// "Directly inside" means non-recursive — subfolders are excluded. Empty
/// `folder_rel_path` means the connection's root.
///
/// Reads `refs/heads/main` from the bare repo and `accepted-patches.json`
/// from the connection's state dir. No filesystem walk of the working tree
/// happens here — callers source the working version via TS-side fs reads.
/// No lock is acquired (reads only).
pub fn read_folder_blobs(
    workspace_dir: &Path,
    connection_dir_name: &str,
    folder_rel_path: &str,
) -> Result<Vec<FolderBlob>, ReviewOpError> {
    read_folder_blobs_inner(workspace_dir, connection_dir_name, folder_rel_path, None)
}

/// Like [`read_folder_blobs`] but restricted to the requested filename set —
/// the returned `Vec<FolderBlob>` contains only entries whose `filename`
/// appears in `filenames`. Lets paginated grid renderers and single-record
/// diff views avoid loading hundreds of MB of `(published, approved)` content
/// for folders they only need a small page of (e.g. HubSpot/Contacts with
/// 22k+ records).
///
/// Empty `filenames` returns an empty `Vec` — this is the explicit "page is
/// empty" signal, distinct from "give me everything" which uses
/// [`read_folder_blobs`]. Filenames the folder doesn't have are silently
/// dropped (no error).
pub fn read_folder_blobs_filtered(
    workspace_dir: &Path,
    connection_dir_name: &str,
    folder_rel_path: &str,
    filenames: &std::collections::HashSet<String>,
) -> Result<Vec<FolderBlob>, ReviewOpError> {
    read_folder_blobs_inner(
        workspace_dir,
        connection_dir_name,
        folder_rel_path,
        Some(filenames),
    )
}

/// List record filenames directly inside
/// `<workspace>/<connection_dir_name>/<folder_rel_path>/`. The result is the
/// union of (a) JSON blobs reachable from `refs/heads/main` and (b) entries
/// in `accepted-patches.json` (a `Create` may not be on `main` yet) — sorted
/// lexicographically.
///
/// Does NOT read blob content. Use this when the caller only needs filenames
/// (`findRecordOffset`, scroll-to-record affordances). For diff content,
/// call [`read_folder_blobs_filtered`] with the page filenames.
pub fn list_folder_filenames(
    workspace_dir: &Path,
    connection_dir_name: &str,
    folder_rel_path: &str,
) -> Result<Vec<String>, ReviewOpError> {
    let paths = resolve_connection_paths(workspace_dir, connection_dir_name)?;
    let accepted_file =
        accepted_patches::load(&accepted_patches_dir(&paths)).map_err(ReviewOpError::Internal)?;

    let folder_normalized = folder_rel_path.trim_matches('/').to_string();
    let folder_prefix = if folder_normalized.is_empty() {
        String::new()
    } else {
        format!("{folder_normalized}/")
    };

    let in_folder = |path: &str| -> bool {
        if !is_data_path_in_folder(path, &folder_normalized) {
            return false;
        }
        let rest = path.strip_prefix(folder_prefix.as_str()).unwrap_or(path);
        !rest.contains('/')
    };

    // Path-only walk: cheap variant of read_folder_blobs that lists matching
    // entries from `refs/heads/main` without `cat-file`-ing any blob content.
    // Reuses the same path predicate as the blob reader so the two stay in sync.
    let folder_prefix_for_keep = folder_prefix.clone();
    let folder_normalized_for_keep = folder_normalized.clone();
    let keep = move |path: &str| -> bool {
        if !is_data_path_in_folder(path, &folder_normalized_for_keep) {
            return false;
        }
        let rest = path
            .strip_prefix(folder_prefix_for_keep.as_str())
            .unwrap_or(path);
        !rest.contains('/')
    };
    let main_paths = list_main_tree_paths_filtered(&paths.bare_repo, keep)?;

    let mut filenames: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for path in &main_paths {
        let rest = path
            .strip_prefix(folder_prefix.as_str())
            .unwrap_or(path)
            .to_string();
        filenames.insert(rest);
    }
    for entry in &accepted_file.patches {
        if !in_folder(&entry.path) {
            continue;
        }
        let rest = entry
            .path
            .strip_prefix(folder_prefix.as_str())
            .unwrap_or(entry.path.as_str())
            .to_string();
        filenames.insert(rest);
    }

    Ok(filenames.into_iter().collect())
}

fn read_folder_blobs_inner(
    workspace_dir: &Path,
    connection_dir_name: &str,
    folder_rel_path: &str,
    filter: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<FolderBlob>, ReviewOpError> {
    // Empty filter set short-circuits before touching the bare repo — saves a
    // tree walk on the common "page is empty" case.
    if let Some(f) = filter {
        if f.is_empty() {
            return Ok(Vec::new());
        }
    }

    let paths = resolve_connection_paths(workspace_dir, connection_dir_name)?;
    let accepted_file =
        accepted_patches::load(&accepted_patches_dir(&paths)).map_err(ReviewOpError::Internal)?;

    let folder_normalized = folder_rel_path.trim_matches('/').to_string();
    let folder_prefix = if folder_normalized.is_empty() {
        String::new()
    } else {
        format!("{folder_normalized}/")
    };

    // A record path is "directly inside" the folder iff:
    //   - it passes `is_data_path_in_folder` (json + not under .scratch + under
    //     folder prefix when folder is non-empty), AND
    //   - the part AFTER the folder prefix has no `/` (no nested subfolder).
    let in_folder = |path: &str| -> bool {
        if !is_data_path_in_folder(path, &folder_normalized) {
            return false;
        }
        let rest = path.strip_prefix(folder_prefix.as_str()).unwrap_or(path);
        !rest.contains('/')
    };

    // Push the filter down to the git ls-tree → cat-file step so we don't
    // pull the whole folder's blobs when we only want a page's worth.
    let main_map = {
        let folder_prefix_for_keep = folder_prefix.clone();
        let folder_normalized_for_keep = folder_normalized.clone();
        let keep = |path: &str| -> bool {
            // Same filter as `in_folder` but inline-friendly (closure-stable).
            if !is_data_path_in_folder(path, &folder_normalized_for_keep) {
                return false;
            }
            let rest = path
                .strip_prefix(folder_prefix_for_keep.as_str())
                .unwrap_or(path);
            if rest.contains('/') {
                return false;
            }
            match filter {
                None => true,
                Some(f) => f.contains(rest),
            }
        };
        read_main_tree_for_entry_point_filtered(&paths.bare_repo, keep)?
    };

    // Union filenames from main + accepted-patches (each may have entries
    // the other doesn't — e.g. a Create that isn't on main yet, or a main
    // file with no patch). When a filter is supplied, only keep filenames
    // the caller asked about.
    let mut filenames: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let keep = |rest: &str| -> bool {
        match filter {
            None => true,
            Some(f) => f.contains(rest),
        }
    };
    for path in main_map.keys() {
        if !in_folder(path) {
            continue;
        }
        let rest = path
            .strip_prefix(folder_prefix.as_str())
            .unwrap_or(path)
            .to_string();
        if keep(&rest) {
            filenames.insert(rest);
        }
    }
    for entry in &accepted_file.patches {
        if !in_folder(&entry.path) {
            continue;
        }
        let rest = entry
            .path
            .strip_prefix(folder_prefix.as_str())
            .unwrap_or(entry.path.as_str())
            .to_string();
        if keep(&rest) {
            filenames.insert(rest);
        }
    }

    let mut out = Vec::with_capacity(filenames.len());
    for filename in filenames {
        let full_path = format!("{folder_prefix}{filename}");
        let published = main_map.get(&full_path).cloned();
        let approved = match accepted_patches::get_entry(&accepted_file, &full_path) {
            Some(entry) => apply_patch_entry_to_blob(published.as_deref(), entry)
                .map_err(ReviewOpError::Internal)?,
            None => published.clone(),
        };
        out.push(FolderBlob {
            filename,
            published,
            approved,
        });
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests — moved alongside the code in slice H.1 from
// `cli/commands/tests/files.rs::accepted_state_helpers`. Other field-level
// tests (accept_field_*, reject_field_*, discard_field_*) still live next to
// the cli wrappers because they need ConnectionContext fixtures; those move
// here as a follow-up when the fixture helpers themselves move to shared.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::accepted_patches::AcceptedPatchesFile;
    use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
    use serde_json::{json, Value as JsonValue};

    fn map_of(pairs: &[(&str, &str)]) -> FileMap {
        let mut m = FileMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.as_bytes().to_vec());
        }
        m
    }

    fn entry(path: &str, kind: PatchKind, patch: JsonValue) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind,
            patch,
        }
    }

    fn json_bytes(v: &JsonValue) -> Vec<u8> {
        serde_json::to_vec_pretty(v).unwrap()
    }

    #[test]
    fn compute_accepted_state_with_empty_file_returns_main_map() {
        let main = map_of(&[("Companies/rec_1.json", "{\"name\":\"Acme\"}")]);
        let file = AcceptedPatchesFile::default();
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert_eq!(approved, main);
    }

    #[test]
    fn compute_accepted_state_applies_update_via_merge_patch() {
        let base = json!({"name": "Acme", "industry": "Other"});
        let main = {
            let mut m = FileMap::new();
            m.insert("Companies/rec_1.json".into(), json_bytes(&base));
            m
        };
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_1.json",
                PatchKind::Update,
                json!({"industry": "SaaS"}),
            )],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        let expected = json_bytes(&json!({"name": "Acme", "industry": "SaaS"}));
        assert_eq!(
            approved.get("Companies/rec_1.json").map(|v| v.as_slice()),
            Some(expected.as_slice())
        );
    }

    #[test]
    fn compute_accepted_state_inserts_create_entries() {
        let main = FileMap::new();
        let new_record = json!({"name": "New Co"});
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_new.json",
                PatchKind::Create,
                new_record.clone(),
            )],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert_eq!(
            approved.get("Companies/rec_new.json").map(|v| v.as_slice()),
            Some(json_bytes(&new_record).as_slice())
        );
    }

    #[test]
    fn compute_accepted_state_removes_delete_entries() {
        let main = map_of(&[("Companies/rec_1.json", "{\"name\":\"Acme\"}")]);
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_1.json",
                PatchKind::Delete,
                JsonValue::Null,
            )],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert!(approved.is_empty());
    }

    #[test]
    fn compute_accepted_state_handles_multiple_entries_in_order() {
        let main = {
            let mut m = FileMap::new();
            m.insert(
                "Companies/rec_1.json".into(),
                json_bytes(&json!({"name": "Acme"})),
            );
            m.insert(
                "Companies/rec_keep.json".into(),
                json_bytes(&json!({"name": "Keep"})),
            );
            m
        };
        let file = AcceptedPatchesFile {
            patches: vec![
                entry(
                    "Companies/rec_1.json",
                    PatchKind::Update,
                    json!({"industry": "SaaS"}),
                ),
                entry(
                    "Companies/rec_2.json",
                    PatchKind::Create,
                    json!({"name": "Beta"}),
                ),
                entry(
                    "Companies/rec_keep.json",
                    PatchKind::Delete,
                    JsonValue::Null,
                ),
            ],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert_eq!(approved.len(), 2);
        assert!(approved.contains_key("Companies/rec_1.json"));
        assert!(approved.contains_key("Companies/rec_2.json"));
        assert!(!approved.contains_key("Companies/rec_keep.json"));
    }

    #[test]
    fn apply_patch_entry_to_blob_create_serializes_full_content() {
        let e = entry("p.json", PatchKind::Create, json!({"name": "Acme"}));
        let out = apply_patch_entry_to_blob(None, &e).unwrap();
        assert_eq!(out, Some(json_bytes(&json!({"name": "Acme"}))));
    }

    #[test]
    fn apply_patch_entry_to_blob_update_merges_keys() {
        let main_blob = json_bytes(&json!({"name": "Acme", "industry": "Other"}));
        let e = entry("p.json", PatchKind::Update, json!({"industry": "SaaS"}));
        let out = apply_patch_entry_to_blob(Some(&main_blob), &e).unwrap();
        assert_eq!(
            out,
            Some(json_bytes(&json!({"name": "Acme", "industry": "SaaS"})))
        );
    }

    #[test]
    fn apply_patch_entry_to_blob_update_with_null_key_deletes_field() {
        let main_blob = json_bytes(&json!({"name": "Acme", "draft": true}));
        let e = entry("p.json", PatchKind::Update, json!({"draft": null}));
        let out = apply_patch_entry_to_blob(Some(&main_blob), &e).unwrap();
        assert_eq!(out, Some(json_bytes(&json!({"name": "Acme"}))));
    }

    #[test]
    fn apply_patch_entry_to_blob_delete_returns_none() {
        let main_blob = json_bytes(&json!({"name": "Acme"}));
        let e = entry("p.json", PatchKind::Delete, JsonValue::Null);
        let out = apply_patch_entry_to_blob(Some(&main_blob), &e).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn apply_patch_entry_to_blob_update_against_missing_main_treats_as_null() {
        // Pathological state but we don't want to panic. RFC 7396 apply on
        // null + an object patch produces a fresh object from the patch's
        // non-null keys.
        let e = entry("p.json", PatchKind::Update, json!({"name": "Acme"}));
        let out = apply_patch_entry_to_blob(None, &e).unwrap();
        assert_eq!(out, Some(json_bytes(&json!({"name": "Acme"}))));
    }
}
