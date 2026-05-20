# Slice H — Shared Rust library + desktop napi bindings (spec)

**Date**: 2026-05-20
**Status**: **H.1 + H.1.5 + H.2 + H.3 shipped on `dev-10144`** (H.1: `mr20`/`30010d41`; H.1.5: 2026-05-20; H.2: 2026-05-20; H.3: 2026-05-20). H.4 not started. See [Sequencing](#sequencing-inside-the-slice) for what landed and what's left.
**Parent plan**: [2026-05-17-simplify-local-workspace-architecture.md → Slice H](2026-05-17-simplify-local-workspace-architecture.md#slice-h--shared-rust-library--desktop-migration)
**Linear**: [DEV-10144](https://linear.app/whalesync/issue/DEV-10144/scratchmd-simplify-workspaces-init-drop-worktrees-move-publish-to)
**Author**: Curtis Fonger

## Contents

- [Why this slice exists](#why-this-slice-exists)
- [Scope (corrected from parent plan)](#scope-corrected-from-parent-plan)
- [Rust core — `shared::review_ops` API](#rust-core--sharedreview_ops-api)
- [napi binding crate](#napi-binding-crate)
- [Per-handler migration map](#per-handler-migration-map)
- [Build and distribution pipeline](#build-and-distribution-pipeline)
- [Test strategy](#test-strategy)
- [Sequencing inside the slice](#sequencing-inside-the-slice)
- [Resolved decisions](#resolved-decisions)
- [Risks](#risks)
- [Done when](#done-when)

## Why this slice exists

Sub-slice B made the CLI write to `accepted-patches.json`. The Electron main process's three cell-edit IPC handlers — `acceptCellChange`, `acceptCellInputText`, `undoApprovedCellChange` in `scratch-desktop/src/main/local-files.ts` — still write directly to `refs/heads/dirty` and the dirty worktree. Two surfaces, two semantic models, one workspace. The local-files.ts handlers were Ivan's deliberate choice in [`ff5b1529`](https://gitlab.com/whalesync/spinner/-/commit/ff5b15296ed6a165829ea696c587a1a4cc6f4fb5) (2026-04-07) to avoid the ~50ms `scratchmd` spawn cost when a user types in a grid cell — a real latency win, but the result is now duplicated accept/discard logic across Rust and TypeScript.

[Slice F](2026-05-17-simplify-local-workspace-architecture.md) (init collapse to one `main` worktree) cannot ship until the desktop stops touching `refs/heads/dirty`. H is the gating slice.

The chosen approach (from [decision log → Shared Rust library via napi-rs](2026-05-17-simplify-local-workspace-architecture.md#shared-rust-library-via-napi-rs-not-duplicated-typescript-2026-05-20)) is to hoist accept/reject/discard cores out of `cli/commands/files.rs` into a new `shared::review_ops` module, then expose those functions to Node via a [napi-rs](https://napi.rs/) cdylib crate. Both the CLI binary and the Electron main process consume the same Rust core. Native addon round-trip is sub-millisecond — no spawn, no IPC to a subprocess.

## Scope (corrected from parent plan)

The parent plan's Slice H section lists **five** handlers to migrate. Audit of `scratch-desktop/src/main/index.ts` shows only **three** are actually direct-path today:

| Handler in `local-files.ts`            | IPC channel                         | Today                                                                                                  | Notes                                                                                          |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `acceptCellChange` (1716)              | `files:accept-cell-change`          | **Direct**: `patchJsonField(working)` + `patchJsonField(dirty)` + `commitReviewedDirtyFile`            | Hot path — keystrokes in grid                                                                  |
| `acceptCellInputText` (1734)           | `files:accept-cell-input-text`      | **Direct**: schema-driven coercion + same triple-write                                                 | Hot path — keystrokes in grid                                                                  |
| `undoApprovedCellChange` (1780)        | `files:undo-approved-cell-change`   | **Direct**: read master, apply field to working + dirty, advance ref                                   | Cell context-menu action; clicked, not typed                                                   |
| `restoreDeletedRecord` (1817 — *dead*) | `files:restore-deleted-record`      | **Shell-out via `restoreDeletedRecordViaCli`** at `index.ts:938`. The local-files.ts function is dead. | Local function unreferenced; delete in H along with the migration                              |
| `discardCreatedRecord` (1838 — *dead*) | `files:discard-created-record`      | **Shell-out via `discardCreatedRecordViaCli`** at `index.ts:947`. The local-files.ts function is dead. | Same — local function unreferenced                                                             |

**Primary migration target: the three cell-edit handlers.** They're the only ones with the latency constraint, the only ones still writing to `refs/heads/dirty` from TS, and the only ones whose semantics diverged from the CLI when sub-slice B shipped.

**Secondary cleanup: delete the two dead local-files.ts functions.** They're untouched residue from before the CLI shell-out wiring. Removing them lets us close the door on the direct path entirely and grep for `commitReviewedDirtyFile` to verify nothing's left.

**Not migrating in H:** the folder-level `acceptFieldChanges` / `rejectFieldChanges` IPC handlers (`index.ts:956-977`) and `restoreDeletedRecord` / `discardCreatedRecord` IPC handlers shell out to `scratchmd` and stay shelled out. They're not on the latency hot path (each click is a deliberate user action), and the shell-out gives us workspace-lock + JSON output for free. Migrating them to napi is a follow-up that buys consistency, not correctness. Track as a post-H opportunity if the desktop ever needs a sub-100ms field-level apply.

Parent plan's Slice H section was collapsed to a context paragraph + link to this spec (per [resolved decision D1](#resolved-decisions)) to avoid duplicated narrative drift.

## Rust core — `shared::review_ops` API

The accept/reject/discard cores already exist inside `scratch-git-2/src/cli/commands/files.rs` as I/O-free helpers (`accept_field_in_folder`, `reject_field_in_folder`, `discard_field_in_folder`, `approved_object_for_path`, `compute_accepted_state`, `apply_patch_entry_to_blob`, plus the JSON path / atomic-write helpers). They were extracted as part of sub-slice B precisely so this hoist would be a directory move, not a re-derivation.

**Move to** `scratch-git-2/src/shared/review_ops.rs`. Stays in the same crate (the CLI binary keeps depending on it; the new napi cdylib will depend on it; the service binary doesn't touch it).

### Public surface

Three entry points cover the three IPC handlers. All take a `workspace_dir: &Path` and an opaque `connection_dir_name: &str` (the user-facing connection folder, e.g. `"HubSpot"`), open whatever they need internally (bare repo + `accepted-patches.json` + working file), do the mutation atomically under `.scratch/lock`, and return a result struct the caller can use to drive reindexing.

```rust
// scratch-git-2/src/shared/review_ops.rs

pub struct ReviewOpResult {
    /// Workspace-relative path of the file that was touched, e.g. "HubSpot/Companies/rec_123.json".
    pub workspace_path: String,
    /// True iff accepted-patches.json was modified. Caller uses this to decide
    /// whether to bump folder_index.accepted_patches_mtime.
    pub patches_changed: bool,
    /// True iff the working file on disk was touched (write or delete).
    pub working_changed: bool,
    /// Optional summary the desktop can show: "added 1 field to Update entry",
    /// "dropped Create entry", etc. Renderer-side strings live in TS; this is
    /// just an enum the renderer pattern-matches on.
    pub effect: ReviewOpEffect,
}

#[derive(Clone, Copy, Debug)]
pub enum ReviewOpEffect {
    NoOp,
    PatchUpserted,    // entry created or fields added/updated
    PatchDropped,     // entry removed (e.g. discard cleared last field)
    WorkingRestored,  // working file restored from approved/published
}

pub enum LockMode {
    /// CLI's existing behavior: block up to 30s with 250ms polls. Right for
    /// scriptable terminal invocations where the user is fine waiting.
    DefaultBlocking,
    /// Bounded wait (default ~100ms) before erroring with `LockBusy`. Right
    /// for napi callers on the Electron main thread where any longer wait
    /// would feel like jank. See [Lock semantics](#lock-semantics) for the
    /// retry budget rationale.
    ShortWait,
}

pub fn accept_field(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,        // "Companies/rec_123.json"
    field: &str,                  // "industry" or "metadata.author"
    local_value: &JsonValue,      // the value the user typed; what the desktop passes to napi as JSON
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError>;

pub fn discard_field(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,
    field: &str,
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError>;

// Whole-record lifecycle edges. Slice H exposes these so the dead local-files.ts
// functions can be deleted without losing the ability to call them programmatically
// from the desktop in future (today the IPC routes through `scratchmdViaCli`, but
// the napi entry point is here so post-H consolidation is one library call).
pub fn restore_deleted_record(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError>;

pub fn discard_created_record(
    workspace_dir: &Path,
    connection_dir_name: &str,
    record_rel_path: &str,
    lock_mode: LockMode,
) -> Result<ReviewOpResult, ReviewOpError>;
```

CLI command wrappers (`run_accept_field` etc.) pass `LockMode::DefaultBlocking`; the napi bindings pass `LockMode::ShortWait`. Distinction lives in the public entry-point signature so napi's binding crate doesn't need to know about lock internals.

`acceptCellChange` and `acceptCellInputText` both end up calling `accept_field` — the difference between them is the schema-driven type coercion, which stays in TypeScript (it needs to read the connection schema from disk and apply rules that aren't part of the review-ops core). The renderer hands napi a JSON value, not a string.

`undoApprovedCellChange` maps to `discard_field` — its current "restore to master" semantics match discard's "local ← published" rule from the [review model](../../scratch-git-2/docs/REVIEW_MODEL.md). The handler name is legacy; the new TS shim can keep the IPC channel name (`files:undo-approved-cell-change`) for back-compat and call `discard_field` underneath.

### Error shape

```rust
#[derive(thiserror::Error, Debug)]
pub enum ReviewOpError {
    #[error("workspace not found at {0}")]
    WorkspaceNotFound(PathBuf),
    #[error("connection '{0}' not registered in workspace.yaml")]
    UnknownConnection(String),
    #[error("'{path}' is not a record file under '{connection}'")]
    NotARecordPath { connection: String, path: String },
    #[error("workspace lock held by PID {pid} (acquired {acquired})")]
    LockBusy { pid: u32, acquired: String },
    #[error("invalid JSON in working file '{path}': {source}")]
    InvalidWorkingJson { path: String, source: serde_json::Error },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("git: {0}")]
    Git(#[from] anyhow::Error),  // for the gix-shelling-out wrapper bits
    #[error("internal: {0}")]
    Internal(String),
}
```

The `LockBusy` variant matters: napi maps it to a structured JS exception (`code: 'LOCK_BUSY'`), and the desktop renderer surfaces a "another operation is in progress" toast instead of a generic error.

### Lock semantics

`shared::review_ops` acquires `<workspace>/.scratch/lock` on every public entry point. The lock helper today (`cli/config/workspace_lock.rs::acquire`) blocks up to **30 seconds** with 250ms polls — that's the right behavior for terminal CLI invocations where the user is happy to wait, but **catastrophically wrong** for the Electron main thread, where a 30-second freeze would feel like the app hung.

Decision D7: add a second entry point to `workspace_lock.rs`:

```rust
// cli/config/workspace_lock.rs (or move to shared/ as part of H.1)
pub fn try_acquire_with_short_wait(
    workspace_dir: &Path,
    timeout: Duration,  // 100ms default; configurable for tests
) -> Result<WorkspaceLockGuard, LockError>;

pub enum LockError {
    /// Lock held by another live process; gave up waiting.
    Busy { pid: u32, lock_path: PathBuf },
    /// Stale lock detected but reclaim failed (race with another concurrent
    /// reclaim; rare). Treat as Busy on the caller side.
    ReclaimFailed { pid: u32, lock_path: PathBuf },
    Io(std::io::Error),
}
```

`review_ops`'s public entry points dispatch on `LockMode`:

- `LockMode::DefaultBlocking` → call existing `acquire` (30s wait, scriptable).
- `LockMode::ShortWait` → call `try_acquire_with_short_wait(_, Duration::from_millis(100))`, propagate `LockError::Busy` as `ReviewOpError::LockBusy`.

**Why 100ms for short-wait:** the lock holder is almost always another `review_ops` call from the same desktop process — they finish in ~1–5ms. 100ms covers ~20 such ops worth of contention. If we time out, returning `LOCK_BUSY` to the renderer is fine — the desktop can retry once on its own (with a one-frame delay) before surfacing an error to the user. Tested heuristic; revisit if telemetry shows spurious `LOCK_BUSY` events.

**Why a separate function instead of a configurable `acquire`:** the two modes have different ergonomics. `DefaultBlocking` is fire-and-forget (typical CLI use); `try_acquire_with_short_wait` returns a richer `LockError` for the caller to pattern-match. Wrapping both into one function with a `Duration` parameter forces callers to think about a knob they don't care about. Two named entry points keep the call sites readable.

The desktop's `withWorkspaceInternalMutation` wrapper in `scratch-desktop/src/main/index.ts` serializes IPC handlers in the renderer's event loop — that stays. The Rust lock is the cross-process safety net (e.g. user runs `scratchmd files accept-field …` in a terminal while the desktop is open). Two layers of belt + suspenders.

Side benefit: this closes [CLI-review follow-up C1](2026-05-17-simplify-local-workspace-architecture.md#cli-review-follow-ups) for the field-level mutations — `review_ops`'s public entry points wrap the lock, so the CLI wrappers inherit it automatically (they already call `acquire` today; the change is moving the acquire site into `review_ops` instead of the wrapper).

### What gets moved vs. stays

| Currently in `cli/commands/files.rs`                                | After H                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `accept_field_in_folder`                                            | Moves to `shared::review_ops::accept_field_in_folder` (helper used by both)      |
| `reject_field_in_folder`                                            | Moves (CLI-only today; napi doesn't expose it)                                   |
| `discard_field_in_folder`                                           | Moves                                                                            |
| `approved_object_for_path`, `field_paths_in_folder`                 | Move (used by all three)                                                         |
| `compute_accepted_state`, `apply_patch_entry_to_blob`               | Move                                                                             |
| `read_main_tree`, `read_materialized_repo`                          | Move (review_ops needs them)                                                     |
| `parse_json_object_bytes`, `read_nested_json_value`, `apply_nested` | Move                                                                             |
| `restore_deleted_records_locally`, `discard_created_records_locally` | Move + rename to single-record `restore_deleted_record` / `discard_created_record` |
| `run_accept_field` / `run_reject_field` / `run_discard_field`       | Stay (CLI command wrappers — call the moved helpers via the new `review_ops::*` public entry points) |
| `refresh_problem_record_index_for_ctx`                              | Stays in `cli/commands/files.rs` (CLI-only; folder-index touchup belongs to the CLI surface) |

`review_ops`'s public entry points (the four `pub fn`s above) bundle "acquire lock + read main tree + read working file + run helper + atomic-save patches + write working file" into one call. The CLI's `run_accept_field` becomes the thin wrapper: call `review_ops::accept_field`, do the folder-index reindex, print human/JSON output. Same shape as today; the body shrinks.

### Workspace-relative `field` and `record_rel_path` conventions

`record_rel_path` is the **repo-relative** path under the connection root: `"Companies/rec_123.json"`. Not `"HubSpot/Companies/rec_123.json"`, not `/abs/path/HubSpot/Companies/rec_123.json`. This matches the `path` field inside `accepted-patches.json` and the existing `field_paths_in_folder` keying. The napi binding does any path normalization the desktop needs (it currently passes `folderPath` + `filename` separately, joined to absolute paths; the binding accepts the desktop's shape and converts internally — see [napi binding crate](#napi-binding-crate)).

`field` uses dot-notation for nested keys (`"metadata.author"`), already supported by `read_nested_json_value` / `apply_nested_json_value`. Matches the TS side's `setNestedValue` and `getNestedValue` helpers.

## napi binding crate

New crate `scratch-git-2/napi/` (sibling of `src/cli/`, `src/service/`). Stays inside the existing `scratch-git-2` cargo project — same `Cargo.toml` workspace, no new build root.

### `Cargo.toml` shape

```toml
# scratch-git-2/napi/Cargo.toml
[package]
name = "scratchmd-native"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
scratch-git-2 = { path = ".." }  # reuse the existing crate's `shared::review_ops`
napi = { version = "2", default-features = false, features = ["napi8", "serde-json"] }
napi-derive = "2"
serde_json = "1"

[build-dependencies]
napi-build = "2"
```

The parent `scratch-git-2/Cargo.toml` becomes a workspace root (currently it's a single-package manifest):

```toml
[workspace]
members = [".", "napi"]
```

`.` keeps the existing `[[bin]]` declarations for `scratch-git-2` and `scratchmd`. Verify `cargo build --bin scratchmd` still works post-restructure as the first PR in the slice (cargo workspace migration is mechanical but not free).

### Public functions (async)

Decision D3: bindings are async upfront. napi-rs runs the work on a libuv worker thread via `AsyncTask`; the Electron main thread `await`s the returned Promise without blocking. Simpler to start async and never have to revisit than to ship sync and discover main-thread stalls in production.

```rust
// scratch-git-2/napi/src/lib.rs
use napi::bindgen_prelude::*;
use napi_derive::napi;
use scratch_git_2::shared::review_ops::{self, LockMode};
use serde_json::Value as JsonValue;
use std::path::PathBuf;

#[napi]
pub async fn accept_field(
    workspace_dir: String,
    connection_dir_name: String,
    record_rel_path: String,
    field: String,
    local_value: serde_json::Value,
) -> Result<ReviewOpResult> {
    napi::tokio::task::spawn_blocking(move || {
        review_ops::accept_field(
            &PathBuf::from(workspace_dir),
            &connection_dir_name,
            &record_rel_path,
            &field,
            &local_value,
            LockMode::ShortWait,  // 100ms — see Lock semantics
        )
    })
    .await
    .map_err(|join_err| napi::Error::from_reason(format!("worker panic: {join_err}")))?
    .map(Into::into)
    .map_err(map_err)
}

#[napi]
pub async fn discard_field(/* … */) -> Result<ReviewOpResult> { /* mirrors accept_field */ }

#[napi]
pub async fn restore_deleted_record(/* … */) -> Result<ReviewOpResult> { /* … */ }

#[napi]
pub async fn discard_created_record(/* … */) -> Result<ReviewOpResult> { /* … */ }

#[napi(object)]
pub struct ReviewOpResult {
    pub workspace_path: String,
    pub patches_changed: bool,
    pub working_changed: bool,
    pub effect: String,  // "NoOp" | "PatchUpserted" | "PatchDropped" | "WorkingRestored"
}

fn map_err(err: review_ops::ReviewOpError) -> napi::Error {
    use napi::{Error, Status};
    let (status, code) = match &err {
        review_ops::ReviewOpError::LockBusy { .. } => (Status::GenericFailure, "LOCK_BUSY"),
        review_ops::ReviewOpError::WorkspaceNotFound(_) => (Status::InvalidArg, "WORKSPACE_NOT_FOUND"),
        review_ops::ReviewOpError::UnknownConnection(_) => (Status::InvalidArg, "UNKNOWN_CONNECTION"),
        review_ops::ReviewOpError::NotARecordPath { .. } => (Status::InvalidArg, "NOT_A_RECORD_PATH"),
        review_ops::ReviewOpError::InvalidWorkingJson { .. } => (Status::GenericFailure, "INVALID_JSON"),
        _ => (Status::GenericFailure, "INTERNAL"),
    };
    let mut e = Error::new(status, err.to_string());
    e.reason = code.to_string();  // surfaces as `err.code` on the JS side
    e
}
```

The desktop's IPC handlers stay `async`; the napi call slots in like any other awaited promise:

```ts
// scratch-desktop/src/main/index.ts
ipcMain.handle('files:accept-cell-input-text', async (_, ...args) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    return await native.acceptField(/* … */);
  }),
);
```

### Why async upfront

- **No risk of UI freeze.** The Electron main thread serves window events, IPC routing, menu, dock, and global shortcuts. Any sync blocking is felt. Sync bindings would have been fine for the bounded ops we have today, but file-system stalls (cold-cache reads, briefly-held lock, slow SSD) put us within main-thread-jank distance. Async eliminates the failure mode entirely.
- **Cost is small.** napi-rs's `spawn_blocking` round-trip is ~50–100µs vs the 1–5ms the op itself takes. Worker-thread pool is already alive (libuv runs file I/O on it). No new resource allocation.
- **Matches existing handler shape.** Every IPC handler in `scratch-desktop/src/main/index.ts` is already `async`; the renderer awaits IPC results. The napi call drops in cleanly — no shape change at the call site.
- **Future-proofs against scope growth.** If anyone adds a folder-batch op later (D2), it stays in the same shape; no breaking-change moment where sync becomes async.

Tradeoff accepted: each binding requires a `spawn_blocking` wrapper (~3 lines of boilerplate per function). Negligible.

### TypeScript types

napi-rs's `napi build --dts` emits `index.d.ts` automatically from the Rust signatures. Bundle alongside the `.node` file:

```ts
// generated index.d.ts (illustrative)
export interface ReviewOpResult {
  workspacePath: string;
  patchesChanged: boolean;
  workingChanged: boolean;
  effect: 'NoOp' | 'PatchUpserted' | 'PatchDropped' | 'WorkingRestored';
}
export function acceptField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
  localValue: unknown,
): ReviewOpResult;
// ...
```

No hand-maintained wire types between Rust and TS. Drift class eliminated.

## Per-handler migration map

The desktop's `scratch-desktop/src/main/local-files.ts` shrinks; the napi bridge module lives at `scratch-desktop/src/main/native/scratchmd-native.ts` (created in H.2 — see [Local module name and loader](#local-module-name-and-loader)).

### `acceptCellChange` (today: 1716 → 1773)

**Before:**

```ts
// local-files.ts
export async function acceptCellChange(folderPath, workspacePath, filename, fieldName, value) {
  const parsed = coerceCellInputText(value);
  await applyAcceptedCellValue(folderPath, workspacePath, filename, fieldName, parsed);
  return { value: parsed };
}
async function applyAcceptedCellValue(folderPath, workspacePath, filename, fieldName, value) {
  const workingFile = join(folderPath, filename);
  const dirtyPath = getVersionFolderPath(folderPath, workspacePath, 'dirty');
  const dirtyFile = join(dirtyPath, filename);
  await patchJsonField(workingFile, fieldName, value);
  await patchJsonField(dirtyFile, fieldName, value);
  await commitReviewedDirtyFile(folderPath, workspacePath, filename);
}
```

**After:**

```ts
// scratch-desktop/src/main/native/scratchmd-native-helpers.ts  (new — adjacent to the loader)
import * as native from './scratchmd-native';
import { relative } from 'node:path';

export async function nativeAcceptField(
  workspacePath: string,
  folderPath: string,
  filename: string,
  fieldName: string,
  value: unknown,
): Promise<native.ReviewOpResult> {
  // folderPath = "/abs/.../HubSpot/Companies"; derive connection dir + record rel path.
  const workspaceRelativeFolder = relative(workspacePath, folderPath); // "HubSpot/Companies"
  const [connectionDirName, ...rest] = workspaceRelativeFolder.split('/');
  const recordRelPath = [...rest, filename].join('/'); // "Companies/rec_123.json"
  return await native.acceptField(workspacePath, connectionDirName, recordRelPath, fieldName, value);
}

// scratch-desktop/src/main/local-files.ts
export async function acceptCellChange(folderPath, workspacePath, filename, fieldName, value) {
  const parsed = coerceCellInputText(value);
  await nativeAcceptField(workspacePath, folderPath, filename, fieldName, parsed);
  return { value: parsed };
}
```

Deletions from `local-files.ts`: `applyAcceptedCellValue` (private helper), `patchJsonField` if no other callers (grep first), `commitReviewedDirtyFile` if no other callers.

### `acceptCellInputText` (today: 1734 → 1748)

Identical shape to `acceptCellChange` except the value coercion uses `coerceCellInputTextWithSchema` against the on-disk schema. Coercion stays in TS — it reads schema JSON files that aren't part of the Rust review model. Final call into napi is the same `nativeAcceptField(...)`.

### `undoApprovedCellChange` (today: 1780 → 1811)

**Before:** read master file's field, write that value into working + dirty, advance dirty ref.

**After:** call `native.discardField(workspaceDir, connectionDirName, recordRelPath, fieldName)`. Rust handles the read-from-main + write-working + drop-from-patch atomically. No master file read on the TS side; the bare repo is the source.

The handler keeps its IPC channel name (`files:undo-approved-cell-change`) for back-compat. Renaming is a renderer-side change that can land separately.

### `restoreDeletedRecord` (1817 — dead code)

Delete the function from `local-files.ts`. The IPC handler `files:restore-deleted-record` keeps calling `restoreDeletedRecordViaCli` from `scratchmd.ts`. Optionally: rewrite that wrapper to call `native.restoreDeletedRecord` instead of shelling out, for consistency. Not required for slice H — the CLI shell-out is correct, just slower.

### `discardCreatedRecord` (1838 — dead code)

Same treatment as `restoreDeletedRecord`. Delete the dead function; leave the IPC handler shelling out.

### Folder-level handlers (not in scope for H)

`files:accept-field-changes` and `files:reject-field-changes` at `index.ts:956-977` shell out via `acceptFieldChanges` / `rejectFieldChanges` in `scratchmd.ts`. They stay shelled out. The Rust `shared::review_ops` exposes `accept_field` (single-record) but not a folder-batch entry point; folder-batch is naturally a CLI orchestration and the shell-out cost amortizes over many records. Add napi bindings for folder-batch only if the desktop ever needs a click-time field-apply-across-folder, which it doesn't today.

## Build and distribution pipeline

### Per-platform `.node` files

napi-rs emits one cdylib per `(os, arch)`:

| Target          | File                                       | Where it ships                             |
| --------------- | ------------------------------------------ | ------------------------------------------ |
| Mac arm64       | `scratchmd-native.darwin-arm64.node`       | bundled in `scratch-desktop` mac arm64 dmg |
| Mac x64         | `scratchmd-native.darwin-x64.node`         | bundled in mac x64 dmg                     |
| Linux x64       | `scratchmd-native.linux-x64-gnu.node`      | bundled in linux AppImage + .deb           |
| Windows x64     | `scratchmd-native.win32-x64-msvc.node`     | when/if we ship windows                    |

Initial slice ships Mac arm64 + Mac x64 + Linux x64. Windows is a follow-up — `scratch-desktop` doesn't have a packaged windows build today, and the rustpython patch in `Cargo.toml` already shows we have a windows gnu special-case from the CLI; adding napi to that mix should be a separate exercise.

### CI pipeline

napi-rs's [build CLI](https://napi.rs/docs/cli/build) handles per-target compilation. Per D4 we don't publish to npm — the CI pipeline instead:

- Runs a matrix job that invokes `napi build --release --target <triple>` for each supported target.
- Uploads each resulting `.node` file as a build artifact.
- A downstream job in the desktop's pipeline pulls the artifacts and copies them into `scratch-desktop/Resources/bin/scratchmd-native.<platform>-<arch>[-<abi>].node` before `electron-builder` runs.

Wire into the existing `.gitlab-ci.yml`. Add as a new job; doesn't block the existing `cargo build` / `yarn lint` jobs.

### Where the `.node` lives

Decision D4: copy the `.node` files into `scratch-desktop/Resources/bin/` alongside the existing `scratchmd` binary. Skip the npm-package step. Rationale:

- The CI for `Resources/bin/scratchmd` already exists and is well-understood. Adding `.node` files to the same copy step is mechanical.
- No new publishing infrastructure: no npm scope to set up, no auth tokens to manage, no version-bump dance between the napi crate and `scratch-desktop/package.json`.
- The TS import side of things doesn't need an npm package — a local module under `scratch-desktop/src/main/native/` that `require`s the platform-correct file from `Resources/bin/` works just as well as a `node_modules` resolution.

Tradeoff accepted: the napi crate isn't independently versioned. It moves with the desktop release. Fine for an internal tool that's only consumed by one app; revisit if we ever ship Rust libraries to external consumers.

**Layout:**

```
scratch-desktop/Resources/bin/
├── scratchmd-darwin-arm64
├── scratchmd-darwin-x64
├── scratchmd-linux-x64
├── scratchmd-native.darwin-arm64.node
├── scratchmd-native.darwin-x64.node
└── scratchmd-native.linux-x64-gnu.node
```

File naming follows napi-rs's `<package-name>.<platform>-<arch>[-<abi>].node` convention. `<package-name>` resolves D6 (see below).

**Risk to watch:** the existing `Resources/bin/scratchmd` binary has shipped stale at least once ([`mr14` dogfood note](2026-05-17-simplify-local-workspace-architecture.md#what-shipped)) because the desktop's CI didn't pull a fresh build. Same failure mode applies to `.node` files. Mitigation: bake a build-time SHA check into the desktop's CI — fail the build if the bundled binary/`.node` SHAs don't match the latest cargo build artifact.

### Local module name and loader

Decision D6: name the local TS module `scratchmd-native`. The `.node` files use the same prefix (`scratchmd-native.<platform>-<arch>.node`).

```
scratch-desktop/src/main/native/
├── scratchmd-native.ts       ← loader: requires the right .node for current platform, exports the API
└── index.d.ts                 ← generated by napi-rs from the Rust signatures
```

```ts
// scratch-desktop/src/main/native/scratchmd-native.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function resolveNativeBinary(): string {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch;          // 'arm64' | 'x64'
  const abi = platform === 'linux' ? '-gnu' : '';
  const filename = `scratchmd-native.${platform}-${arch}${abi}.node`;

  // Packaged: Resources/bin/. Dev: ../../../scratch-git-2/napi/.
  const resourcesPath = process.resourcesPath
    ? join(process.resourcesPath, 'bin', filename)
    : join(__dirname, '..', '..', '..', '..', 'scratch-git-2', 'napi', filename);
  if (!existsSync(resourcesPath)) {
    throw new Error(`scratchmd-native binary not found at ${resourcesPath}`);
  }
  return resourcesPath;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const native: typeof import('./index.d.ts') = require(resolveNativeBinary());

export const { acceptField, discardField, restoreDeletedRecord, discardCreatedRecord } = native;
export type { ReviewOpResult } from './index.d.ts';
```

Why `scratchmd-native` (not `scratch-git-2-napi`):
- Desktop devs already know the CLI as `scratchmd`. "native" signals "the in-process version of the same operations you'd otherwise spawn."
- Shorter, no embedded crate name.
- No npm scope baggage (we're not publishing to npm).

### electron-builder integration

```yaml
# electron-builder.yml — extraResources additions
extraResources:
  - from: 'Resources/bin/scratchmd-${os}-${arch}'
    to: 'bin/scratchmd'
  # H additions:
  - from: 'Resources/bin/scratchmd-native.${os}-${arch}*.node'  # glob covers -gnu suffix on Linux
    to: 'bin/'
```

The loader's `process.resourcesPath` branch finds the `.node` at runtime; no further wiring needed.

### Local dev loop

In dev (`yarn dev` from `scratch-desktop/`), `process.resourcesPath` is undefined, so the loader falls back to a relative path: `<repo>/scratch-git-2/napi/scratchmd-native.<platform>-<arch>.node`. Built by running `napi build --release` inside `scratch-git-2/napi/` and dropping the `.node` next to `Cargo.toml`. No `yarn link`, no monorepo workspace surgery — just a path resolution that branches on packaged vs dev.

The dev-loop convenience script (`scratch-desktop/scripts/build-native.sh`, new) wraps `cd ../scratch-git-2/napi && napi build --release` so the user doesn't have to remember the incantation. Wire into `scratch-desktop/package.json::scripts.predev` so `yarn dev` rebuilds the `.node` before launching Electron.

## Test strategy

Three tiers, matching the existing test pyramid:

### 1. Rust core (`shared::review_ops`)

Tests already exist for the sub-slice-B helpers (`accept_field_in_folder`, `discard_field_in_folder`, etc.) in `cli/commands/files.rs`'s `#[cfg(test)]` module. **Move them with the code** into `shared::review_ops` tests; rename `accept_field_in_folder_*` → `review_ops::accept_field_*`. No new test logic needed for the hoist itself.

Add tests for the new public entry-point bundles (lock acquisition + read main tree + atomic save):
- `accept_field_round_trip_persists_patch_file` — call `review_ops::accept_field`, reopen `accepted-patches.json` from disk, assert the entry shape.
- `accept_field_returns_lock_busy_when_held` — acquire the lock in test, call `accept_field`, assert `ReviewOpError::LockBusy`.
- `discard_field_drops_patch_entry_when_empty` — accept one field, then discard it, assert the entry is gone.
- `restore_deleted_record_errors_on_non_delete_entry` — assert the input validation.
- `discard_created_record_errors_when_main_has_path` — same shape.

Target: +6 unit tests on top of the moved set. Net delta `cargo test` count: roughly +6.

### 2. napi binding (`scratch-git-2/napi/`)

Smoke tests that exercise the JS→Rust→JS round trip. napi-rs supports `jest` or `ava` for this; pick `vitest` to match the desktop side's choice.

```ts
// napi/__tests__/accept-field.test.ts
import * as native from '..';
import { setupTestWorkspace } from './helpers';

test('acceptField returns ReviewOpResult with patchesChanged=true', async () => {
  const ws = await setupTestWorkspace({ /* preseed accepted-patches.json + main tree */ });
  const result = native.acceptField(ws.dir, 'HubSpot', 'Companies/rec_1.json', 'industry', 'SaaS');
  expect(result.patchesChanged).toBe(true);
  expect(result.effect).toBe('PatchUpserted');
});

test('LOCK_BUSY surfaces as err.code', async () => {
  const ws = await setupTestWorkspace();
  await acquireLockExternally(ws.dir);
  expect(() => native.acceptField(ws.dir, 'HubSpot', 'Companies/rec_1.json', 'x', 'y'))
    .toThrow(expect.objectContaining({ code: 'LOCK_BUSY' }));
});
```

Target: 4 smoke tests — happy path per public function + one error-mapping test. Goal is "the binding does what the .d.ts says," not coverage; the Rust core has coverage already.

### 3. Desktop handler tests

`scratch-desktop`'s existing Jest suite covers `local-files.ts` handlers at the level of "given these IPC args, does X end up on disk?" The slice H rewrite collapses those handlers to one-line wrappers; the existing tests should pass unchanged if the napi call's effect is observationally equivalent to the old triple-write.

Mocking strategy: stub the napi module so handler tests don't need a real Rust binary on the test machine. `vitest`'s `vi.mock('../native/scratchmd-native', ...)` returns a fake `acceptField` that just records calls. Real round-trip is exercised by the napi crate's own tests (tier 2) — no need to double up.

### 4. No new e2e

Dogfood is the e2e. Same pattern as sub-slice B: build the desktop, edit a cell, verify `accepted-patches.json` updates and `refs/heads/dirty` doesn't. Document the dogfood checklist in the slice H PR description.

## Sequencing inside the slice

Five PRs, each shippable on its own. H.1 split into H.1 + H.1.5 once the git-read dependency surfaced during implementation (see deviation note in H.1).

**H.1 — Hoist `review_ops` core to `shared/` (no behavior change). ✅ Shipped 2026-05-20 (`dev-10144-mr20`, commit `30010d41`).** Moved `cli/commands/re_anchor.rs` → `shared/re_anchor.rs` and `cli/config/accepted_patches.rs` → `shared/accepted_patches.rs` (git tracked both renames). Created `shared/review_ops.rs` (~700 LOC of helpers + `ConnectionPaths` struct + 10 unit tests for `compute_accepted_state` + `apply_patch_entry_to_blob`). Added `LockError` enum and `try_acquire_with_short_wait(workspace_dir, timeout) -> Result<_, LockError>` to `workspace_lock`; existing `acquire(_) -> anyhow::Result<_>` now delegates with 30s timeout. CLI's `files.rs` shrunk by ~900 LOC via thin `&ConnectionContext`-shaped wrappers that call into `review_ops`. End state: 282 (scratchmd) + 226 (service) + 2 (integration) + 16 (jsonschema) = **526 tests pass**, `cargo build` clean (0 warnings on both binaries), `cargo fmt --check` clean, `yarn lint` clean.

> **Deviation captured during H.1, deferred to H.1.5:** the spec's "I/O-bundling public entry points" (`accept_field`, `discard_field`, `restore_deleted_record`, `discard_created_record` with `LockMode` baked in) were **not** added in H.1. They need to read `refs/heads/main` to build a `FileMap`, which means calling git. `git_ops` is still in `cli/`, so `shared/review_ops` can't reach it without a cross-module hack. The compute layer they sit on is fully ready; what's left is plumbing one git-read call. H.1.5 picks this up — see below.

**H.1.5 — Add public entry points (and the git plumbing they need). ✅ Shipped 2026-05-20.** Picked option **(b)** — extracted `open_bare_repo`, `read_tree_files`, `rev_parse_optional_to_string`, and the `FileMap` type into a new `shared/git_local.rs` (~170 LOC including the inline `normalize_crlf` helper). `cli/git_ops.rs` re-exports them for the two existing CLI callers (`git_rev_parse_optional` + `read_git_tree` in `files.rs`); `shared/review_ops::FileMap` now re-exports from `git_local::FileMap` so the type is canonical. The cli's full git surface (worktree-add, fetch, push, merge-base, ref mutation) stays in `cli/git_ops/local.rs` — those are orchestration concerns, not pure reads.

Also moved `cli/config/workspace_lock.rs` → `shared/workspace_lock.rs` (with a re-export from `cli/config/mod.rs::pub use crate::shared::workspace_lock`) so `shared/review_ops` can acquire `.scratch/lock` without depending on `cli/`. Both the CLI's existing `crate::config::workspace_lock::acquire(...)` call sites and the new entry points compile against the same module.

Added the four public entry points to `shared/review_ops`:
- `accept_field(workspace_dir, conn, record_rel_path, field, local_value, lock_mode)`
- `discard_field(workspace_dir, conn, record_rel_path, field, lock_mode)`
- `restore_deleted_record(workspace_dir, conn, record_rel_path, lock_mode)`
- `discard_created_record(workspace_dir, conn, record_rel_path, lock_mode)`

Each bundles: resolve `(workspace_dir, conn_dir_name)` → `ConnectionPaths` (via a small private `resolve_connection_paths` helper that reads `.scratch/workspace.yaml` with a tiny serde-only `LocalWorkspaceMarker` shape) → `acquire_lock(workspace_dir, lock_mode)` → `read_main_tree_for_entry_point` (via `shared::git_local`) → `accepted_patches::load` → mutate → `accepted_patches::save_atomic` → write/remove working file → return `ReviewOpResult`. Added types: `LockMode`, `ReviewOpResult`, `ReviewOpEffect`, `ReviewOpError` (with `From<workspace_lock::LockError>` impl for clean `LOCK_BUSY` mapping).

> **Deviation from the original H.1.5 sketch:** the spec text said "CLI's `run_accept_field` / `run_reject_field` / `run_discard_field` / `run_restore_deleted_record` / `run_discard_created_record` thin to one call into the new entry points." On implementation, the fit is poor:
>
> - The four entry points are **per-record**; the three field-level CLI commands (`run_accept_field` / `run_reject_field` / `run_discard_field`) are **folder-scoped**. Looping per-record would acquire the lock once per file (wasteful, and breaks folder-batch atomicity).
> - `run_restore_deleted_record` / `run_discard_created_record` use **batch helpers with all-or-nothing validation** (validate all paths, then apply all). Looping the per-record entry point would lose atomicity if one path in a multi-path call fails after others succeeded.
>
> Resolution: CLI wrappers stay as-is using the existing folder/batch helpers in `shared::review_ops`. The new entry points are the napi-facing surface; the CLI's batch surface coexists. The entry points get exercised end-to-end in five new unit tests (see below). H.3 wires the desktop's per-cell handlers to the entry points where the per-record shape is the natural fit.

5 new unit tests in `cli/commands/tests/files.rs::entry_points`: `accept_field_round_trip_persists_patch_file`, `accept_field_returns_lock_busy_when_held`, `discard_field_drops_patch_entry_when_empty`, `restore_deleted_record_errors_on_non_delete_entry`, `discard_created_record_errors_when_main_has_path`. Each spins up a real bare repo at `<workspace>/.repos/conn1.git/` and writes `<workspace>/.scratch/workspace.yaml` so `resolve_connection_paths` resolves.

End state: 287 (scratchmd) + 231 (service) + 2 (integration) + 16 (jsonschema) = **536 tests pass** (+10 from H.1: +5 new entry-point tests + 5 `workspace_lock` tests now visible to the service binary). `cargo build` clean (0 warnings on both binaries), `cargo fmt --check` clean, `yarn lint` from repo root clean.

**H.2 — Add `napi/` crate + first binding (`acceptField`) + dev loop. ✅ Shipped 2026-05-20.** Workspace + napi crate + Mac arm64 `.node` + desktop loader + dev hook + repo-root lint/build clean.

- **Cargo workspace.** `scratch-git-2/Cargo.toml` is now a workspace root with `.` + `napi` as members. The existing `[package]` definition stays on `.`; both binaries (`scratchmd`, `scratch-git-2`) continue to compile. `[profile.release]` (lto + strip = symbols) moved from the napi crate to the workspace root to silence cargo's "ignored sub-package profile" warning.
- **`src/lib.rs` (new, ~10 LOC).** scratch-git-2 had no library target; the two binaries each `#[path]`-included `shared/mod.rs` into their own crate root. Added a minimal `src/lib.rs` that exposes `pub mod shared` via the same `#[path]` trick so the napi crate can resolve `scratch_git_2::shared::review_ops::*`. Binaries untouched; library target adds compile time (the `shared` module compiles in three places now) but no source changes elsewhere.
- **`napi/` crate.** `Cargo.toml` declares `crate-type = ["cdylib"]`, depends on `napi 2.x` + `napi-derive 2.x` (with `type-def` feature), and a path-dep on the parent crate. `build.rs` is the one-line `napi_build::setup()`. `src/lib.rs` defines the JS-side `ReviewOpResult` (struct with `effect: String` for easy `===` matching from TS), the `map_err(ReviewOpError) -> napi::Error`, and one binding: `accept_field` (snake_case in Rust, `acceptField` in JS via napi-derive's auto-conversion).
- **Build pipeline.** `@napi-rs/cli` v3's workspace handling proved fiddly in our setup; the `scratch-desktop/scripts/build-native.sh` wrapper bypasses the CLI and uses `cargo build -p scratchmd-native` directly, then renames `libscratchmd_native.dylib` → `scratchmd-native.darwin-arm64.node`. Linux + Windows targets follow the same pattern (the script picks the platform suffix from `uname`). Release `.node` is ~4.2 MB.
- **Hand-written `index.d.ts`.** napi-rs's `--dts` autogen produced an empty file under our workspace setup; the `.d.ts` is small (6 lines of signatures), so we maintain it by hand for H.2. Revisit autogen in H.3 if scope grows.
- **Error-code convention.** napi 2.x reserves `err.code` for the napi `Status` enum (`GenericFailure`, `InvalidArg`, etc.) and won't let Rust override it. The binding instead prefixes error messages with the structured code: `"LOCK_BUSY: workspace lock held by another scratchmd process (pid 12345)"`. The desktop TS shim's `parseNativeErrorCode(err)` helper extracts the prefix. Documented in `index.d.ts` and the TS shim.
- **`scratch-desktop/src/main/native/scratchmd-native.ts` loader.** Resolves the platform-correct `.node` between `<repoRoot>/scratch-git-2/napi/` (dev — same `app.getAppPath()` + `..` trick `scratchmd.ts` uses for the CLI binary) and `process.resourcesPath/bin/` (packaged). Exports `acceptField(...)` + `parseNativeErrorCode(err)` + `NativeErrorCode` union + `ReviewOpResult` type. Cached after first load. No IPC handlers consume it yet — that's H.3.
- **`scratch-desktop/scripts/build-native.sh` + `predev` hook.** `yarn dev` now auto-rebuilds the `.node` before launching Electron (~1s incremental, ~45s clean release build). Also wired into `prebuild` so packaged builds get a fresh `.node`. Manual invocation via `yarn build:native`.
- **`electron-builder.yml` extraResources.** New entry copies `scratch-git-2/napi/scratchmd-native.*.node` into `Resources/bin/` at packaging time. The glob covers the `-gnu` ABI suffix on Linux; `electron-builder.unsigned-mac.yml` inherits via `extends`.
- **Smoke tests.** `scratch-git-2/napi/__tests__/accept-field.test.mjs` (Node built-in test runner) spins up a real workspace + bare repo from JS, calls `await acceptField(...)`, and asserts (1) the round-trip writes `accepted-patches.json` with the expected entry shape, (2) holding the workspace lock from JS produces an error whose message starts with `"LOCK_BUSY:"`. Run with `node --test __tests__/*.mjs` from `napi/`. Deferred vitest until H.3 since the desktop already has a vitest suite; meanwhile node's built-in test runner needs no extra deps on the napi crate.
- **End state.** `cargo build --workspace` zero warnings; **714 tests pass** across both binaries + the new library target + integration + jsonschema; `cargo fmt --check` clean; `yarn lint` from repo root clean; `yarn build` from repo root clean. Mac arm64 `.node` loads in Node 22, exposes `acceptField`, round-trip verified end-to-end.

> **Deviations from the original H.2 sketch:**
> - **Workspace-only build, not `napi build` CLI.** Documented above — `cargo build -p scratchmd-native` + manual rename is the path of least resistance for the wrapper script.
> - **Hand-written `index.d.ts`.** napi-rs's autogen didn't produce output in our setup. Six lines, easy to maintain by hand.
> - **Custom error codes via message prefix, not `err.code`.** napi 2.x doesn't expose a `.code` override; the prefix convention is documented in the shim.
> - **Node built-in test runner, not vitest.** No new npm dep on the napi crate. The desktop side will consume the binding via vitest in H.3.

**H.3 — Migrate the three cell-edit handlers. ✅ Shipped 2026-05-20.** All three cell-edit IPC handlers in `scratch-desktop/src/main/local-files.ts` now write to `accepted-patches.json` via the napi binding instead of patching the dirty worktree + advancing `refs/heads/dirty` from Node.

- **New `discardField` binding** added to the napi crate (mirror of `acceptField`, same async + `LockMode::ShortWait` + error-prefix shape). Hand-written `index.d.ts` updated; `napi/__tests__/accept-field.test.mjs` gained a third smoke test (`discardField` drops the patch entry AND restores the working file from `main`).
- **Desktop loader (`scratch-desktop/src/main/native/scratchmd-native.ts`) gained:**
  - Re-export of `discardField`.
  - `deriveRecordPaths(workspacePath, folderPath, filename)` — converts the `(workspace, folder, filename)` triple the IPC handlers already pass in into the `(connectionDirName, recordRelPath)` pair the napi binding accepts. Workspace-relative path is split into `[connDir, ...rest]`; record rel path is the rest joined with `/`. Throws when `folderPath` escapes the workspace (defensive — IPC handlers should never reach this path, but errors are loud rather than silent).
  - `acceptCellField({workspacePath, folderPath, filename, fieldName, value})` and `discardCellField({workspacePath, folderPath, filename, fieldName})` — convenience wrappers calling `deriveRecordPaths` + the corresponding napi function. These are what the IPC handlers consume.
- **Three IPC handlers in `local-files.ts` rewritten to one-liners:**
  - `acceptCellChange(...)` — coerce value via `coerceCellInputText`, then `acceptCellField(...)`.
  - `acceptCellInputText(...)` — schema-driven coercion stays in TS (it reads on-disk schema files the Rust core doesn't know about), then `acceptCellField(...)`.
  - `undoApprovedCellChange(...)` — straight `discardCellField(...)`.
- **Dead code removed from `local-files.ts`** (~150 LOC):
  - `applyAcceptedCellValue` (was the local triple-write helper).
  - `commitReviewedDirtyFile` (was the dirty-ref-advance shell-out).
  - `restoreDeletedRecord` + `discardCreatedRecord` (legacy local copies — the IPC handlers in `index.ts` already routed through `restoreDeletedRecordViaCli` / `discardCreatedRecordViaCli`; these local-files copies were dead before H.3).
  - JSON-field helpers: `patchJsonField`, `applyJsonField`, `readJsonField`, `removeJsonField`, `readJsonObject`, `writeJsonObject`, `setNestedValue`, `getNestedValue`, `deleteNestedValue`, `deleteNestedValueAt`, the `JsonFieldValue` type.
  - Worktree-path / git-spawn helpers: `getConnectionPaths`, `toGitPath`, `pathExists`, `runGit`, the `ConnectionPaths` type, and the `child_process.execFile` import.
- **No live surface in the desktop writes to `refs/heads/dirty` anymore from local actions.** `grep -r commitReviewedDirtyFile scratch-desktop/` returns nothing; same for the other deleted helpers. This is the milestone slice F was blocked on.
- **Tests:** new `scratch-desktop/src/main/__tests__/scratchmd-native.spec.ts` (8 tests) covering `deriveRecordPaths` (3 path-conversion cases + 2 throws) and `parseNativeErrorCode` (4 prefix-extraction cases). Mocks `electron` (`app.isPackaged`, `app.getAppPath`) so the test runner doesn't need a real Electron context.
- **End state:** `cargo build --workspace` zero warnings; **714 tests pass** on the Rust side; **140 desktop vitest tests pass** (+8 from the new scratchmd-native spec); `yarn lint` + `yarn test` from repo root clean; `cargo fmt --check` clean; node-test napi smoke suite still green (3/3).

> **Dogfood (deferred):** verifying a real Electron build edits cells through napi (vs old direct-to-dirty) and that `refs/heads/dirty` doesn't advance is a manual step the user will run separately. The standalone JS smoke tests in `napi/__tests__/` already prove the round trip end-to-end.

**H.4 — Multi-platform CI + Resources/bin/ wiring.** Wire the napi build matrix to produce Mac arm64 + Mac x64 + Linux x64 `.node` files. Pipeline job copies them into `scratch-desktop/Resources/bin/`; `electron-builder.yml` `extraResources` glob picks them up. Add the SHA-check guard so a stale `.node` fails the desktop build. Verify macOS notarization passes with the signed `.node` files. Run the full desktop build per platform. ~2-3 days, mostly CI fiddling.

Total estimate: ~7-10 days of focused work. H.1 done; ~6-9 left. The risk concentrates in H.4 (CI/packaging) and H.2 (first-time napi-rs setup); the actual logic migration in H.3 is the smallest piece because the Rust core is already done.

## Resolved decisions

All seven captured 2026-05-20. Recorded here for traceability — the body of the spec already reflects these.

| #   | Question                                                  | Resolution                                                                                                                          | Why                                                                                                                                                                                                                |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Fix the parent plan's "5 handlers" framing               | Remove the incorrect detail from the parent plan; collapse the Slice H section there to a brief context + link to this spec.        | Spec is the authoritative scope; carrying duplicated narrative in the parent plan invites drift.                                                                                                                   |
| D2  | Migrate folder-level `acceptFieldChanges` to napi too?   | **Defer.** Not on the latency hot path; shell-out works. Track as post-H follow-up if folder-batch ever needs sub-100ms response.   | Folder-batch is a deliberate click action, not a per-keystroke op. 50ms shell-out is fine.                                                                                                                         |
| D3  | Sync vs async napi bindings?                              | **Async upfront** via `tokio::task::spawn_blocking`.                                                                                | No risk of UI freeze on the Electron main thread; cost is negligible (~50–100µs round-trip). Future-proofs against scope growth. See [Why async upfront](#why-async-upfront).                                      |
| D4  | Bundle `.node` via npm package or copy to `Resources/bin/`? | **Copy to `Resources/bin/`** alongside the existing `scratchmd` binary.                                                            | CI for the existing binary path already exists; adding `.node` is mechanical. No new publishing infrastructure (npm scope, auth, version-sync between crate and desktop). The napi crate moves with desktop releases. |
| D5  | Where does the napi crate live?                          | **Inside** the existing `scratch-git-2/` repo at `scratch-git-2/napi/`.                                                            | Same Cargo workspace, `cargo test --workspace` covers it, no separate crate to publish.                                                                                                                            |
| D6  | What do we call the napi module?                          | **`scratchmd-native`** — crate name, `.node` file prefix, and local TS module under `scratch-desktop/src/main/native/`.            | Matches what desktop devs already call the CLI (`scratchmd`); "native" signals "in-process version." Shorter than `scratch-git-2-napi`. Since D4=B, this isn't an npm package name — just the local naming convention. |
| D7  | Lock acquisition behavior for napi callers                | **Add `try_acquire_with_short_wait(_, 100ms)`** to `workspace_lock`. `review_ops` dispatches via a new `LockMode` enum.            | CLI's 30s blocking acquire is wrong for the Electron main thread; 100ms covers ~20 op-lengths of contention without UI-perceptible delay. Separate entry points keep CLI scriptability intact.                     |

## Risks

- **Per-platform builds are CI-fiddly.** napi-rs's matrix is well-trodden, but glibc version pinning (Linux), code signing (Mac), and cross-compilation for `x86_64-apple-darwin` from `aarch64-apple-darwin` runners are all known gotchas. Budget for H.4 to take longer than the spec estimates.
- **Desktop CI shipping stale prebuilds.** Already seen on `Resources/bin/scratchmd` ([`mr14` dogfood](2026-05-17-simplify-local-workspace-architecture.md#what-shipped)). Same failure mode applies to `.node` files. Mitigation in [build pipeline](#build-and-distribution-pipeline): bake a SHA check into the desktop's CI.
- **napi-rs version churn.** Pin to a known-good napi-rs version (currently 2.x stable). Don't auto-bump.
- **electron-builder + native modules on signing.** macOS notarization is finicky about loading unsigned `.node` files at runtime. The `.node` files copied into `Resources/bin/` need to be signed during the desktop's notarization pass. napi-rs supports this; verify on H.2's first packaged build, before sinking time into H.4's full matrix.
- **Local dev loop fragility.** The `predev` build step adds latency to `yarn dev` startup (~5–15s for a clean `napi build --release`). If iterating on Rust + TS simultaneously, the user has to remember to rebuild the `.node` between Rust changes. Mitigation: `napi build` (no `--release`) is much faster; document in `scratch-desktop/CLAUDE.md` once the dev script lands.
- **`process.resourcesPath` vs dev-path branching.** The loader's path resolution has two branches (packaged vs dev). Bugs here surface as "module not found" only at runtime, not build-time. Smoke-test both modes in H.2.

## Done when

- ✅ `shared/review_ops.rs` exists with the helper layer (`ConnectionPaths`, `FieldCommandResult`, `PatchAction`, accept/reject/discard in-folder fns, FS-only helpers); `cargo test` green on both binaries. **(H.1)**
- ✅ `workspace_lock` exposes `try_acquire_with_short_wait(_, timeout) -> Result<_, LockError>` for napi callers. **(H.1)**
- ✅ `shared/review_ops.rs` exposes the four documented public entry points (`accept_field`, `discard_field`, `restore_deleted_record`, `discard_created_record`), each accepting a `LockMode`. Each bundles lock + main_map read + patches load + compute + atomic save + working-file write. **(H.1.5)** _Note: the parent spec line "CLI command wrappers thin to one call around these" did not survive contact with implementation — see the H.1.5 deviation note for why CLI wrappers stay folder/batch-scoped against existing helpers._
- ✅ `scratch-git-2/Cargo.toml` is a workspace root with `napi/` as a member; `cargo build --workspace` produces both binaries and the `scratchmd-native` cdylib without warnings. **(H.2)**
- ⏳ `scratch-desktop/Resources/bin/` contains `scratchmd-native.<platform>-<arch>.node` files for the supported platforms. `electron-builder` bundles them into the packaged app. **(H.4)**
- ✅ `scratch-desktop/src/main/native/scratchmd-native.ts` loader resolves the right `.node` at runtime — dev path verified (loaded from `<repoRoot>/scratch-git-2/napi/`); packaged path tested via dry-run inspection of `electron-builder.yml`'s `extraResources` glob. Full packaged smoke test deferred until H.3 dogfood. **(H.2)**
- ✅ `scratch-desktop/src/main/local-files.ts` no longer contains `commitReviewedDirtyFile` calls. `grep -r commitReviewedDirtyFile scratch-desktop/` returns nothing. **(H.3)**
- ✅ The three cell-edit IPC handlers in `scratch-desktop/src/main/local-files.ts` route through `await acceptCellField(...)` / `await discardCellField(...)`, which call the napi binding's `acceptField` / `discardField`. **(H.3)**
- ✅ The dead `restoreDeletedRecord` and `discardCreatedRecord` functions are deleted from `local-files.ts`. **(H.3)**
- ⏳ Editing a cell in a packaged desktop build produces a new entry in `<workspace>/.scratch/connections/<conn>/accepted-patches.json` (dogfood-verified on at least one connector) and does NOT advance `refs/heads/dirty`. Deferred to user-run dogfood; standalone Node smoke tests already prove the JS → Rust → JS round trip end-to-end. **(H.3)**
- ✅ The desktop's vitest suite passes (140 tests; +8 new in `scratchmd-native.spec.ts`); the napi crate's smoke tests pass (3 tests); `cargo test --workspace` green (714 tests); `yarn lint` / `yarn lint-strict` clean. **(H.3)**
- ⏳ macOS notarization passes on the packaged build with the `.node` files signed. **(H.4)**
- ✅ Slice F (init collapse) is now unblocked — no live surface writes to `refs/heads/dirty` from local actions. **(after H.3)**

## What this unblocks

- **Slice F** — init can stop creating the `dirty` worktree at all; one non-sparse `main` worktree per connection becomes the only on-disk artifact. Massive simplification of `init_connection` in `workspaces.rs`.
- **Future Rust-core moves** — validators, schema readers, folder-index queries are all under the same "duplicated across CLI and desktop" pressure. With napi as the canonical pattern, they get migrated the same way. See [decision log → Shared Rust library via napi-rs](2026-05-17-simplify-local-workspace-architecture.md#shared-rust-library-via-napi-rs-not-duplicated-typescript-2026-05-20)'s "stronger principle."
- **CLI workspace lock coverage** — `shared::review_ops` acquires the lock on every entry, which closes CLI-review follow-up [C1](2026-05-17-simplify-local-workspace-architecture.md#cli-review-follow-ups) for the field-level commands. The remaining `*-all` commands still rely on implicit serialization; revisit when slice F retires the worktree-per-branch model entirely.
