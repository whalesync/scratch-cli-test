# Simplify Local Workspace Architecture

**Date**: 2026-05-17 (last updated 2026-05-20)
**Status**: Phases 1–3 shipped on `mr1`/`mr2`/`mr3` (Phase 1), `mr4` (Phase 2), `mr6` (Phase 3). Phase 4+5 merged (see [decision log](#phase-45-merger-2026-05-19)). Phase 4+5 sub-slice A (`accepted-patches.json` IO + `compute_entry`/`re_anchor`/`apply` helpers) shipped on `mr7`/`mr8`. Sub-slice B (the full cutover of accept/reject/discard/upload/listing commands to `accepted-patches.json`) shipped across `mr11`–`mr14` — see [change-list](mr8-sub-slice-b-change-list.md). **Slice H complete: H.4 (multi-platform CI for the napi `.node` + afterPack wiring) shipped on `mr27`** 2026-05-21 — CI cross-compiles `scratchmd-native` for Mac arm64 + Linux x64 alongside the CLI; `afterPack.cjs` copies the platform-correct `.node` into the packaged `.app`'s `Resources/bin/`; legacy `extraResources` glob removed. **Sub-slice D (pull rewrite — refuse-if-unreviewed + re-anchor accepted) shipped on `mr16`.** **[DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when) (publish over-clears `accepted-patches.json` on connector failure) fixed on `mr17`** by routing the post-publish path through the same `re_anchor_patches` machinery slice D uses; the old unconditional `clear` is gone. **Sub-slice E (`folder_index` column recompute against `accepted-patches.json` + schema-v3 bump + patch-file staleness invalidation + desktop filter-mapping flip) shipped on `mr18`** — fixes a latent post-Phase-3 bug where the dirty filesystem tree was dead but the columns still depended on it. **Sub-slice H.1 (hoist `re_anchor` + `accepted_patches` to `shared/`, new `shared/review_ops.rs` with the compute + FS helpers, `workspace_lock::try_acquire_with_short_wait` + `LockError`) shipped on `mr20`** — see [slice H spec](2026-05-20-slice-h-spec.md). **Sub-slice H.1.5 (pure git read helpers hoisted to `shared/git_local.rs`, `workspace_lock` moved to `shared/`, four public entry points `accept_field` / `discard_field` / `restore_deleted_record` / `discard_created_record` with `LockMode` + `ReviewOpResult` / `ReviewOpEffect` / `ReviewOpError` types) shipped 2026-05-20.** **Sub-slice H.2 (Cargo workspace + new `scratchmd-native` cdylib crate exposing `acceptField` to Node, desktop loader at `scratch-desktop/src/main/native/scratchmd-native.ts` with packaged + dev path resolution, `predev` build hook, `electron-builder` `extraResources` wiring, JS-side smoke tests against a real workspace + bare repo fixture) shipped 2026-05-20.** **Sub-slice H.3 (added `discardField` to the napi crate; migrated the three Electron cell-edit IPC handlers — `acceptCellChange`, `acceptCellInputText`, `undoApprovedCellChange` — to delegate to the napi binding; deleted ~150 LOC of dead helpers in `local-files.ts` including the direct-to-dirty triple-write path, the dead `restoreDeletedRecord`/`discardCreatedRecord` local copies, and ten JSON-field/git-spawn helpers; +8 desktop vitest tests for `deriveRecordPaths` + `parseNativeErrorCode`) shipped 2026-05-20. The desktop no longer writes to `refs/heads/dirty` from local actions — slice F (init collapse) is unblocked.** **Slice F (sub-slices F.1 + F.2.a + F.2.b + F.3 + F.5) shipped 2026-05-20** — see [slice F spec](2026-05-20-slice-f-spec.md): F.1 added a structured `workspace_needs_reinit` refusal for pre-F workspaces; F.2.a renamed `dirty_dir`/`dirty_checkout_path` → `worktree_dir`/`worktree_path` across the codebase; F.2.b is the cutover (one non-sparse worktree on `main` per connection, idempotent init, `update_main_worktree_after_pull` refreshes the worktree index via `worktree_reset_mixed` + `worktree_checkout_path -- .scratch`); F.3 deleted the legacy layout helpers (`master_worktree_path`, `reviewed_worktree_path`, `ConnectionContext::master_dir`, `ConnectionPaths::master_dir`) and repointed `validators::run_validations` from the deleted master worktree to `refs/heads/main` via `shared::git_local::read_tree_files` (fixed a latent F.2.b regression where readonly-field checks silently no-op'd). **F.5 killed every remaining dirty-branch read**: new napi `readFolderBlobs` binding feeds the desktop's grid-view three-way diff from `refs/heads/main` + `accepted-patches.json` instead of the deleted on-disk mirrors at `.scratch/connections/{dirty,master}/<conn>/`; CLI's `force-upload` + `find-merge-base` subcommands deleted along with `force_upload_single_repo`, `commit_file_map_to_dirty_ref`, `force_push_origin_dirty`, `merge_base_to_string`; `materialize_workbook_checkout`'s `DIRTY_BRANCH` fallback gone (constant deleted); `setup_connection` now prunes the local `refs/heads/dirty` ref post-clone. **F.4 (perf measurement) shipped 2026-05-20** — `SCRATCHMD_PROFILE=1 scratchmd workspaces init wkb_3qH9SlxsNq` against the Monorepo (135,447 files, 5 connectors) clocked **30.4s** total, down from the ~110s baseline in [Problem](#problem). Per-connection: Stripe 81.5s → 23.6s (3.5×); HubSpot 26.9s → 5.8s (4.6×). Disk usage 1.2 GB vs 3.2 GB pre-F (no dirty/reviewed-dirty/master worktree copies + no `file_index` SQLite table). Phase 6 (parallelize connections) and Phase 7 (delete `run-from-git`) are not started.
**Linear**: [DEV-10144](https://linear.app/whalesync/issue/DEV-10144/scratchmd-simplify-workspaces-init-drop-worktrees-move-publish-to)
**Author**: Curtis Fonger

**Scope**: Replace the three-worktree + eager SQLite + local-publish architecture of `scratchmd workspaces init` with a one-bare-repo + one-non-sparse-worktree-per-connection model. Publishing redirects to the existing server-native pipeline via a thin upload-patch shim; the working tree IS the diff source against `main`, with `gix` doing index-backed diff detection.

## Contents

- [Problem](#problem) — what's slow and why
- [Current architecture (recap)](#current-architecture-recap) — three worktrees, what each is for
- [End-state design](#end-state-design) — layout, why git, [the patch file](#review-state-the-accepted-patches-file), operations, decisions, measured perf
- [Migration plan](#migration-plan) — [Phase 1](#phase-1--unify-publish-on-the-server-via-upload-patch) (shipped) through [Phase 7](#phase-7--delete-publish-v2run-from-git)
- [Out of scope](#out-of-scope) · [Risks](#risks) · [Status](#status) · [Follow-ups](#follow-ups)
- [Decision log](#decision-log) — why each choice was made
- [Phase 1 implementation notes](#phase-1-implementation-notes) — what specifically shipped on `mr1`/`mr2`/`mr3`
- **Sub-plans**: [Slice H spec (`2026-05-20-slice-h-spec.md`)](2026-05-20-slice-h-spec.md) — shared Rust library + napi bindings + desktop migration

## Problem

`scratchmd workspaces init wkb_3qH9SlxsNq` takes **~110s** for the Monorepo workspace (135k files, 5 connections), of which only **~6.7s is network**. The remaining **~94%** is local post-clone work that exists to support publish-time three-way reasoning. Profile breakdown (gated on `SCRATCHMD_PROFILE=1`, from `scratch-git-2/src/cli/commands/workspaces.rs`):

| Phase                                        | Stripe    | HubSpot   | Notes                                |
| -------------------------------------------- | --------- | --------- | ------------------------------------ |
| `git_clone_bare`                             | 5.6s      | 0.7s      | The only network step                |
| `materialize_dirty_checkout` (sparse: dirty) | 15.7s     | 3.9s      | Worktree #1                          |
| `setup_sparse_worktree` (reviewed-dirty)     | 11.8s     | 4.3s      | Worktree #2 — same ref as #1         |
| `git_checkout_branch_from_bare` (main)       | 12.8s     | 4.1s      | Worktree #3                          |
| `index::build` (SQLite)                      | **35.0s** | 13.8s     | Eagerly built for publish-plan diffs |
| **Total per connection**                     | **81.5s** | **26.9s** | Connections run **sequentially**     |

**Post-F measurement (2026-05-20, slice F.4)** — same workbook, same dev server, same `SCRATCHMD_PROFILE=1` debug build:

| Phase                                       | Stripe    | HubSpot  | Notes                                                              |
| ------------------------------------------- | --------- | -------- | ------------------------------------------------------------------ |
| `git_clone_bare`                            | 6.2s      | 0.8s     | Network — unchanged                                                |
| `prune local refs/heads/dirty`              | 12ms      | 13ms     | New (F.5): drop the local dirty ref carried in from the bare clone |
| `materialize_main_worktree (non-sparse)`    | 17.2s     | 4.9s     | The only worktree now — single `git worktree add` of `main`        |
| `reconcile_data_folder_dirs`                | 83ms      | 17ms     |                                                                    |
| `sync_schema_files_from_worktree`           | 2ms       | 1ms      | Schema cache populates from worktree's `.scratch/` (F.2.b)         |
| `count_files (worktree)`                    | 88ms      | 18ms     |                                                                    |
| **Total per connection**                    | **23.6s** | **5.8s** | Connections still sequential — Phase 6 fans these out              |

Whole-workspace `init_v2 (total)`: **30.4s** for 135,447 files, down from ~110s. **3.6× speedup**, with the entire SQLite + sparse-checkout + reviewed-dirty + master-worktree machinery gone. Disk usage 1.2 GB vs 3.2 GB pre-F (~62% smaller — two worktree copies and the `file_index` SQLite table eliminated). Per-connection: Stripe 3.5× (-58s), HubSpot 4.6× (-21s). The remaining time is dominated by `materialize_main_worktree` — the one unavoidable cost of putting `main`'s tree on disk. Phase 6 (parallelize) will let the slowest connection set the floor instead of the sum: a parallel run should land around ~24s for this workbook.

Three structural problems:

1. **Three git worktrees per connection.** `dirty`, `reviewed-dirty`, and `main` exist to support local publish-plan generation. `dirty` is materialized twice (the second copy is `reviewed-dirty`, an identical sparse checkout of the same ref).
2. **Eager SQLite indexing.** Built up-front so `shared/plan_publish.rs` can diff `reviewed-dirty` against `master` at publish time. Not needed for "init then start editing."
3. **Sequential connection setup.** `init_v2` loops over `connector_accounts` one at a time, so Stripe's 81s blocks all other connections.

## Current architecture (recap)

The three checkouts are three **states** of the user's data, not a three-way diff:

| Checkout         | Branch  | Meaning                                                       |
| ---------------- | ------- | ------------------------------------------------------------- |
| `master`         | `main`  | The last known server state                                   |
| `reviewed-dirty` | `dirty` | The snapshot of changes the user has **approved** for publish |
| `dirty`          | `dirty` | The user's live editing area (may contain unreviewed edits)   |

- **Publish** = two-way diff of `reviewed-dirty` vs `master` (`shared/plan_publish.rs:96`).
- **Download** = three-way merge of `master` (base), new `master` (theirs), `dirty` (ours).
- The SQLite index speeds up the publish-plan diff by avoiding a full filesystem scan.

## End-state design

> Per connection: **one bare repo + one non-sparse git worktree of `main`**. The user's editable files live in that worktree. Snapshot reads, diff detection, and fetches go through `gix` against the bare repo; pull refuses with a structured error if any unreviewed edits exist (the user accepts or discards first). Publishing is server-side, with JSON Merge Patches sent over REST.

The user's working files at the top of the worktree are plain JSON record files, just as today. The only git artifact in user-facing space is the `.git` link file (a single file, not a directory) — identical to what today's `dirty` checkout already has.

### Local layout (target)

```
<workspace>/
  HubSpot/                           ← non-sparse git worktree of `main`
    .git                             ← gitlink → ../.repos/<id>.git
    Companies/<record-id>.json       ← user-editable files
    ...
  Stripe/                            ← non-sparse git worktree of `main` (separate repo)
    .git
    ...
  .repos/
    <stripe-repo-id>.git/            ← bare repo: transport + snapshot blobs
    <stripe-repo-id>.db              ← SQLite: per-folder tables for grid pagination + validation
    <hubspot-repo-id>.git/
    <hubspot-repo-id>.db
    ...
  .scratch/
    workspace.yaml                   ← workspace marker (unchanged shape)
    conflicts.log                    ← same-field collisions from pull (audit-only)
    connections/<conn>/
      accepted-patches.json          ← user's approved-pending-publish edits (RFC 7396; IS the wire payload)
```

What disappears vs. today: `.scratch/connections/*/dirty/`, `.scratch/connections/*/master/`, `.scratch/connections/*/reviewed-dirty/` worktrees, the `file_index` and `file_references` tables inside `.repos/<conn>.db` (per-folder tables stay — see [Phase 2](#phase-2--stop-building-the-master-file_index-table-at-initdownload)), and the sparse-checkout configuration in each worktree.

What stays: one bare repo per connection (already used as transport), one worktree per connection (the user's editable directory), the `.repos/<conn>.db` SQLite file (now holding only per-folder tables that the desktop UI's grid view depends on).

### Why keep git locally

Git earns its keep on three fronts that would otherwise need bespoke replacements:

1. **Incremental fetch.** `git fetch origin main` only ships changed objects; the scratch-git-2 service already speaks it.
2. **Snapshot storage.** The bare repo's packed objects ARE the snapshot for "what was main when we pulled" — no separate snapshot directory needed. Snapshot reads go through `gix::Repository::rev_parse("HEAD:<path>")` → blob bytes.
3. **Fast diff detection via index.** `gix::Repository::status(...)` uses git's index to skip unchanged files via `stat`, hashing only files whose mtime/size changed. Measured ~210ms warm on the Stripe worktree (~110k files); see [Measured performance](#measured-performance) below.

What we stop using git for: branches (no `dirty`, no `reviewed-dirty` — they were our de facto long-lived stash storage), local commits (publishing is now an HTTP call), local merge logic (`shared/plan_publish.rs` machinery), and the `file_index` SQLite table that the local plan generator depended on. Pull refuses when the user has unreviewed working-tree edits; otherwise it re-anchors `accepted-patches.json` against the new server `main` and replays it.

### Diff format on the wire: JSON Merge Patch (RFC 7396)

Per-file, computed on demand:

- `diff(snapshot_file, current_file) → patch` — produces a merge patch describing what the user changed.
- `apply(target, patch) → new` — replays the patch on top of a new base.

Spec is ~30 lines:

```
apply(target, patch):
    for each key k in patch:
        if patch[k] is null:        delete target[k]
        elif both are objects:      recurse
        else:                       target[k] = patch[k]
```

A whole-file delete is represented by `patch = null` (the snapshot has content, the current file is missing). A whole-file create is `patch = full_content` (the snapshot is missing, the current file has content).

This is the format used for publish-upload and for the pull re-anchor pass over `accepted-patches.json`. It is independent of git's own diff format — we use gix to _find_ changed files and to _read_ snapshot content, but the patch itself is computed in JSON space because that's the shape the server speaks.

Once Phase 5 lands, the patch isn't (re)computed at publish time — it's accumulated incrementally in [`accepted-patches.json`](#review-state-the-accepted-patches-file) as the user accepts changes. The diff logic moves from "publish time" to "accept time."

### Review state: the accepted-patches file

Today's three-worktree model encodes review state structurally — `dirty` HEAD is "user's accepted edits", working tree is "live unreviewed edits", `master` HEAD is "last published." Collapsing to one worktree on `main` removes that structure. Replacement: a per-connection JSON file holding exactly the `UploadPatchPayload` that would be sent to `/upload-patch/init`, accumulated as the user accepts changes.

**File path:** `<workspace>/.scratch/connections/<conn>/accepted-patches.json`

**Shape:** the same RFC 7396 payload the server already accepts:

```json
{
  "patches": [
    {
      "path": "Companies/rec_123.json",
      "kind": "update",
      "patch": { "industry": "SaaS" }
    },
    {
      "path": "Companies/rec_456.json",
      "kind": "create",
      "patch": { "name": "Acme" }
    },
    { "path": "Companies/rec_789.json", "kind": "delete", "patch": null }
  ]
}
```

The file IS the wire format. Publish becomes "read file → PUT to GCS → POST `/commit`" — no diff computation at upload time. All the diff logic happens at accept time, which matches the user's intent moment.

#### The field-level state model

State is per-field, not per-file. Every record field has three conceptual values; the field's state is determined by comparing them.

| Value         | Source                                                                                                               | Git analogy                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **published** | The field's value at `refs/heads/main:<path>`. What's live in the SaaS app.                                          | The line on `main`.                       |
| **approved**  | The field's value after applying the patch entry for `<path>` (if any) to the published value. Pending publish.      | The line on the local branch HEAD.        |
| **local**     | The field's value in the working file on disk. May be approved (matches `approved`) or unapproved (differs from it). | The line in the uncommitted working copy. |

The patch in `accepted-patches.json` is RFC 7396, so the **approved** value for a single field is:

- If the path's entry has a `kind: "create"` patch and the field appears in it: the field's value in that patch.
- If the path's entry has a `kind: "update"` patch and the field appears in its top-level keys: the value at that key (with `null` meaning "delete this field"), or recursively if the value is a nested object.
- If the path's entry has a `kind: "delete"` patch: the file is approved-deleted; field doesn't have an approved value.
- Otherwise (path absent from `accepted-patches.json`, or path present but the field isn't mentioned by the patch): **approved == published**. The patch only mentions changed keys; everything else falls through.

**A field is "unapproved" when `local ≠ approved`.** That's the single rule. Equivalent restatement:

- If the field has an entry in the patch (any of the cases above): unapproved iff `local ≠ patch's value for the field`.
- If the field is absent from the patch: unapproved iff `local ≠ published`.

#### File-level state

A file's state is the aggregation of its fields' states:

- **Published**: no patch entry, AND every field's `local == published`. (Working file = main blob byte-for-byte.)
- **Approved, pending publish**: patch entry exists, AND every field's `local == approved`. (Working file = `apply(main, patch)` byte-for-byte.)
- **Unreviewed**: at least one field has `local ≠ approved`. (Working file differs from `apply(main, patch_or_empty)`.)

`folder_index`'s `approvedChanges` / `unapprovedChanges` columns populate from this aggregation during `reindex_files`:

- `approvedChanges = 1` iff the path has a patch entry. (Or equivalently: there's at least one field where `approved ≠ published`.)
- `unapprovedChanges = 1` iff at least one field has `local ≠ approved`.

Same columns, same SQL filters (`WHERE unapprovedChanges = 1`) — only the population logic changes from today's three-worktree byte-comparison.

#### Field-level actions

Three primary actions, all field-level. Aggregations follow naturally.

| Action      | Precondition        | Effect on `local`   | Effect on patch entry                                            |
| ----------- | ------------------- | ------------------- | ---------------------------------------------------------------- |
| **accept**  | field is unapproved | unchanged           | set patch's value for this field to `local`                      |
| **reject**  | field is unapproved | `local ← approved`  | unchanged                                                        |
| **discard** | any state           | `local ← published` | remove this field from patch entry; if entry empties, drop entry |

A few invariants drop out:

- **Reject and discard are not the same.** Reject undoes a single step (unapproved → approved). Discard undoes both steps in one shot (anything → published). Once a field is already approved (`local == approved`), reject is a no-op; only discard can undo the approval.
- **Accept always moves a field unapproved → approved**, never the reverse. It never restores; it never deletes.
- **Patch entries shrink under reject (never), accept (when adding keys), and discard (always for the touched field).** A `kind: "update"` entry whose top-level keys all get discarded drops out of the file entirely.

The git analogy makes the asymmetry obvious:

| Action  | Git equivalent (for one line of one file)                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| accept  | `git add -p` that single line into the index (and immediately commit)                                             |
| reject  | `git checkout HEAD -- <file>` for that line — drop the unstaged edit                                              |
| discard | `git restore --source=main --staged --worktree <file>` for that line — drop the index entry AND the unstaged edit |

#### File-level commands

Each file-level CLI command is the field-level action applied across every field in the file (or every file in scope).

| CLI command                            | Behavior                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accept <path>`                        | For each unapproved field in `<path>`, set patch's value to `local`. Working file untouched. Patch entry created/replaced/updated to a `Create`/`Update`/`Delete` reflecting `local`-vs-`published` deltas. |
| `accept-field <field> <folder>`        | Per file in `<folder>`: if field is unapproved, accept just that field. Working untouched.                                                                                                                  |
| `accept-all [folder]`                  | Per unapproved file in `<folder>` (or whole workspace): accept all unapproved fields.                                                                                                                       |
| `reject <path>`                        | Per unapproved field in `<path>`: `local ← approved`. Working file restored to `apply(main, patch_entry_or_empty)`. Patch entry untouched. No-op when no fields are unapproved.                             |
| `reject-field <field> <folder>`        | Per file in `<folder>` where the field is unapproved: `local[field] ← approved`. Patch untouched.                                                                                                           |
| `reject-all [folder]`                  | Per unapproved file: reject all unapproved fields. Patch file untouched.                                                                                                                                    |
| `discard <path>`                       | Working file restored to `published` (= main blob; deleted if main lacks the path). Patch entry removed.                                                                                                    |
| `discard-field <field> <folder>` (new) | Per file in `<folder>`: `local[field] ← published`. Remove field from patch entry; drop entry if it empties.                                                                                                |
| `discard-all [folder]`                 | Per file in scope with a patch entry OR unapproved working state: discard. Patch entries cleared in scope.                                                                                                  |

Two file-level convenience commands for the lifecycle edges, since they don't have a clean field-level analogue:

| CLI command                     | Behavior                                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restore-deleted-record <path>` | Discard variant for `kind: "delete"` entries. Working file restored from main; remove the `delete` entry. Errors if no `delete` entry exists.                                                                                                              |
| `discard-created-record <path>` | Discard variant for `kind: "create"` entries. Working file removed; remove the `create` entry. Errors if no `create` entry exists. Also removes the path from the server-side dirty branch (legacy short-term workaround; see [F8](#ceo-follow-ups) etc.). |

**UX migration note:** Today's `reject <path>` has a _hybrid_ behavior — if the file is unreviewed, it restores from the `dirty` branch (= approved state, matching new `reject`); if the file is already at the approved state, the field-level `reject_field_in_folder` silently switches into discard semantics and also rolls the approved state back to main. After this slice ships, that hybrid splits: `reject` only undoes unapproved edits, and the user (or desktop UI) must call the new `discard-field` / `discard <path>` for the second step. The plan is to update desktop call-sites as a follow-up MR; the CLI's `reject-field` becoming a no-op on already-approved fields is a small UX regression bridged by `discard-field`.

**Atomic writes:** write to `accepted-patches.json.tmp`, fsync, rename. The existing `.scratch/lock` gates concurrent mutation.

**Re-anchoring on pull:** an accepted patch is a diff against `old_head[path]`. After `git fetch` advances `main`, each entry must be valid against `new_head[path]`. Three cases:

- Server didn't touch the path → patch valid as-is.
- Server deleted the path → if the user had an `update` accepted, convert to a `create` with reconstructed content; log a conflict.
- Server changed a key the user's patch touches → user-wins. Patch value stays; semantics shift from "change A→B" to "set to B." Append to `.scratch/conflicts.log`.

The re-anchor routine runs once per pull, over `accepted-patches.json`. Unreviewed working-tree edits don't need re-anchoring — pull refuses with a structured error when any exist, requiring the user to `accept-all` or `discard-all` first (see [Operations → Pull](#operations) and the [Phase 4 spec](#phase-4--5--retire-dirty-branch-switch-to-accepted-patchesjson-merged-2026-05-19)).

### Operations

**Publish** (desktop app initiates; all mutating ops acquire `.scratch/lock` first):

1. Read `accepted-patches.json` for the connection.
2. `POST /workbook/:id/upload-patch/init` → server returns `{ uploadId, presignedUrl }`.
3. CLI PUTs the patch payload (the file's contents, verbatim) to GCS using the presigned URL.
4. `POST /workbook/:id/upload-patch/commit { uploadId, baseHead? }` → server validates paths, enqueues an `ApplyPatchesJob`. Response includes `stalenessWarning?: { newHead }` if `baseHead` doesn't match server's `main`.
5. `ApplyPatchesJob` worker: stream patch from GCS → apply RFC 7396 patches to the server-side dirty branch as one commit → trigger the existing `publish-v2/plan-job` + `run-job`.
6. On job success: clear `accepted-patches.json`; desktop calls `git fetch origin main` so the local `HEAD` advances.

If `stalenessWarning` is present, the desktop shows a non-blocking banner: "The server has more recent changes than what's on your computer. Refresh first?" The patches were still applied — single-user assumption + audit/telemetry covers the residual risk.

**Pull** (download latest from server):

1. Acquire `.scratch/lock`.
2. Detect unreviewed working-tree edits — for each data file, compare disk content against `apply(refs/heads/main:<path>, accepted_patch_for_path)` ("approved" snapshot). If any field's `local ≠ approved`, exit non-zero with a structured error listing the offending paths. No fetch happens. The user must `scratchmd files accept-all` or `discard-all` first, then retry. (Matches git's "commit or stash before pull" UX — no silent overwrite of in-flight work.)
3. Read `refs/heads/main` as `old_head`. Load `accepted-patches.json`.
4. `git fetch origin main` (incremental, packed).
5. `gix` tree-vs-tree diff between `old_head` and `refs/remotes/origin/main` → list of server-changed paths.
6. Re-anchor each `accepted-patches.json` entry via `re_anchor_patches` against `(old_head, new_head)`:
   - Server didn't change a key the user accepted → entry valid as-is.
   - Server deleted a path the user `update`d → convert to `create` with reconstructed content; log a conflict.
   - Server changed a key the user accepted → user-wins. Entry value stays; meaning shifts from "change A→B" to "set to B." Append to `.scratch/conflicts.log`.
7. For each server-changed path:
   - No patch entry for the path → write the new `main` blob to the working file (or delete it if `main` removed the path).
   - Patch entry for the path → write `apply(new_main_blob, re_anchored_patch)` to the working file.
8. Persist re-anchored `accepted-patches.json` atomically. Advance `refs/heads/main` to `refs/remotes/origin/main`.

**Init**:

1. Resolve the workbook's connector accounts.
2. For each connection (in parallel via `rayon::par_iter`):
   - `git clone --bare` into `.repos/<repo-id>.git/`.
   - `git worktree add --no-detach <workspace>/<Connection> main` (shell out unless gix has caught up — verify before defaulting).
3. Write `.scratch/workspace.yaml`.
4. If 1/N connectors fails, warn + continue with N-1. If 0/N, exit non-zero. If a partial prior init is detected, resume the missing connections.
5. Done. One bare repo + one worktree per connection. No `reviewed-dirty`, no `master` worktree, no `file_index` SQLite table. (`.repos/<conn>.db` is created lazily on first folder open for grid-view tables.)

### Design decisions

| Decision                      | Recommendation                                                                                                                                          | Why                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch granularity             | RFC 7396 (Merge Patch) — field-level, arrays atomic                                                                                                     | ~60 lines total. Upgrade to RFC 6902 only if same-array conflicts become a real problem.                                                                        |
| Conflict policy               | User wins; log same-field collisions to `.scratch/conflicts.log`                                                                                        | Zero blocking UX, no silent data loss without an audit trail.                                                                                                   |
| Snapshot storage              | Bare repo objects (read via `gix::rev_parse("HEAD:<path>")`)                                                                                            | No duplicate on-disk snapshot directory. Packed objects are already efficient storage.                                                                          |
| Diff detection mechanism      | `gix::Repository::status(Discard).into_iter([])` against the worktree                                                                                   | Index-backed; measured ~235ms cold / ~210ms warm on the Stripe worktree (~110k files). Already a dependency. See [Measured performance](#measured-performance). |
| Working tree shape            | One **non-sparse** git worktree of `main` per connection                                                                                                | The `.git` link file is the only artifact; identical to today's dirty checkout. Non-sparse so we don't pay sparse-checkout config overhead.                     |
| Transport                     | `git clone --bare` + `git fetch origin main` (incremental)                                                                                              | Free incremental fetch from existing scratch-git-2 backend; no tarball or manifest-API to build.                                                                |
| Worktree creation             | Shell out to `git worktree add` at init                                                                                                                 | gix 0.70's worktree-add support is limited; we already shell out for this today in `setup_sparse_worktree`. Hot path is one call per connection.                |
| Publish wire format           | Split: `POST :id/upload-patch/init` (returns presigned GCS URL + `uploadId`) → CLI PUTs to GCS → `POST :id/upload-patch/commit { uploadId, baseHead? }` | Inline POST hits NestJS body-parser limits on big publishes. Presigned upload + async job matches the existing publish-v2 UX.                                   |
| Concurrent pulls / publishes  | `baseHead` is optional; mismatch returns soft warning, server applies anyway                                                                            | Hard 409 would fail too often once incremental polling started moving `main` server-side.                                                                       |
| Arrays in RFC 7396 are atomic | Accept the limitation; log it in the conflicts file if both sides touched                                                                               | Rare in record-per-file data; upgrade to RFC 6902 only if user pain materializes.                                                                               |
| Local concurrency             | File lock at `.scratch/lock` for any mutating CLI op                                                                                                    | Single-worktree design loses the implicit serialization the three-worktree model had. Matches git's own `.git/index.lock` pattern.                              |

### Measured performance

Spike: `scratch-git-2/examples/gix_status_spike.rs` against the existing Stripe worktree at `/tmp/scratchmd-profile-37373/Monorepo/Stripe` (~110k files):

| Scenario                     | gix `Repository::status(...)` | `git status --porcelain` |
| ---------------------------- | ----------------------------- | ------------------------ |
| `gix::open()`                | ~0.5–2.5ms                    | n/a                      |
| Cold scan, 0 modified        | **235ms**                     | 1,612ms                  |
| Warm scan, 0 modified        | **210ms**                     | 210ms                    |
| Cold scan, 50 files modified | **226ms**                     | (similar)                |
| Warm scan, 50 files modified | **207–218ms** (50 detected)   | 203–213ms (50 detected)  |

gix is at parity with `git status` on warm scans and ~7× faster cold (parallel scan by default). 50 modifications correctly detected by both. The desktop app's "what's changed" view can comfortably refresh on demand or poll every second on the worst-case connector; the small connectors (Affinity, Airtable, Shopify) will be in the tens of ms.

The spike file is preserved in `examples/` for future perf checks; `cargo` does not link it into the `scratchmd` or `scratch-git-2` binaries.

## Migration plan

The architecture changes touch many files; the migration order is **publish (1), strip the easy dead code (2–3), rewrite pull (4), collapse and parallelize (5–6), delete the legacy server endpoint (7)**. Each phase is independently shippable and leaves the system working.

### Phase 1 — Unify publish on the server via /upload-patch

> **Status: SHIPPED** on `dev-10144-{mr1,mr2,mr3}`. The spec below is preserved as a record of what was planned; see [Phase 1 implementation notes](#phase-1-implementation-notes) for what specifically shipped and where it deviated.

**Goal:** Replace local publish-plan building with a server-native flow that feeds the existing `publish-v2/plan-job` + `run-job` pipeline. Eliminate the dual publish paths (server-native used by web client + run-from-git used by desktop) → one server publish path.

**Endpoint shape** (thin upload shim, not a new pipeline):

```
POST /workbook/:id/upload-patch/init
  → { uploadId, presignedUrl }      // presigned GCS PUT URL, ≤24h TTL

CLI PUTs the patch payload to GCS using the presigned URL.

POST /workbook/:id/upload-patch/commit { uploadId, baseHead? }
  → enqueues ApplyPatchesJob (BullMQ)
  → response: { jobId, stalenessWarning?: { newHead } }

ApplyPatchesJob worker:
  → streamObject(uploadId) from GCS
  → validate every patch.path via validateRecordPath()
  → apply RFC 7396 patches to dirty branch as ONE commit

Publish (separate concern, separate CLI command):
  → CLI calls POST /cli/v1/workbooks/:id/publish-v2/plan-job
  → then POST /cli/v1/workbooks/:id/publish-v2/run-job
```

**`baseHead` semantics:** optional. If omitted, server applies with no concurrency check. If provided and mismatched, server applies anyway and returns a staleness warning (incremental server-side polling moves `main` under the user; hard 409 would fail too often given the single-user assumption).

**Server deliverables:**

- Controllers: `/upload-patch/init` + `/upload-patch/commit` under `server/src/cli/upload-patch.controller.ts`
- `JobType.ApplyPatches` + `ApplyPatchesJobDefinition` + worker handler under `server/src/worker/jobs/`
- `enqueueApplyPatchesJob(...)` in `bull-enqueuer.service.ts`
- `signPutUrlForPatchUpload(key, ttl)` + `streamObjectFromPatchUpload(key)` on `ObjectStorageService` (use-case-specific, each pins bucket + `Content-Type`)
- `validateRecordPath(path, dataFolders)` in `server/src/utils/path-validation.ts`
- AuditLog entry on `/upload-patch/commit`
- CLI shim endpoints for publish-v2 plan + run under `/cli/v1/workbooks/:id/publish-v2/...`

**CLI deliverables:**

- Replace `scratchmd files upload` in-place. New flow: gix-status → per-file RFC 7396 patch → presigned PUT to GCS → call `/commit`.
- New `scratchmd files publish` command — runs `/publish-v2/plan-job` then `/run-job` per connection, polls each to terminal, advances local `refs/heads/main` after success.
- File lock at `.scratch/lock` for any mutating op (also Phase 5 prereq). Detect + reclaim stale locks via PID check.

**Desktop deliverables:**

- Rewrite `scratch-desktop/src/renderer/src/pages/workspace/PublishChangesModal.tsx`. Two-step flow: upload first (single IPC), land on a per-connection diff summary with "Publish now" + "Review on web" actions, then user explicitly publishes.
- Per-connection parallel publish via `Promise.allSettled`; per-connection failure isolation.
- Single shared poller (one bulk-status request per second) feeding all in-flight jobs.
- Staleness banner consuming `stalenessWarning.newHead` from the upload result.

**Asset uploads stay on the existing `/assets` pipeline.** Patches are JSON-only. The `publish-plan-build` service's asset-upload phase 0 continues to read asset refs from the dirty branch — unchanged.

**Tests (mandatory for Phase 1 to ship):**

- **Parity test** at `server/src/publish-plan/__tests__/apply-patches-vs-legacy-invariants.spec.ts`. Feed identical edits through both `/upload-patch` → plan-job and through legacy `run-from-git`. Compare dispatched operations + final `main` SHA. Deleted in Phase 7.
- **Permanent end-to-end smoke test** at `server/src/publish-plan/__tests__/upload-patch.e2e.spec.ts`. Asserts the full round-trip (edit → upload → commit → plan-job → run-job → connector update → main advanced). Survives Phase 7 as the integration regression backstop.

**Leaves alone:** `reviewed-dirty`, the SQLite index, `shared/plan_publish.rs`, the `run-from-git` endpoint. All deleted in later phases. The new path is additive.

**Done when:** desktop's publish action uses `/upload-patch` end-to-end against test-api; parity test green; permanent e2e smoke test in CI.

### Phase 2 — Stop building the master `file_index` table at init/download

> **Status: SHIPPED** on `dev-10144-mr4`. Pure-deletion phase. Concretely removed: eager `index::build` at `workspaces.rs:755`, `rebuild_index_for_conn` and its two callers in `files.rs` (downloads + workspace download), the `index init` + `index dump` CLI subcommands, and the now-unused `db_path` binding in `init_connection`. `shared/index.rs` itself stays (service binary depends on it; `validators::builtin::extract_id_path` is also still imported from there). Verified: full `cargo test` green (398 passes), `cargo build` clean for both binaries, `yarn lint` + `yarn build` clean from repo root.

**Audit finding (2026-05-19):** There is one SQLite file per connection (`<workspace>/.repos/<conn>.db`) shared by **two** Rust modules that write **different tables** in that file:

| Tables                                                                                               | Written by                                                                                                                                                            | Read by                                                                                                                  | Lifecycle                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file_index`, `file_references`                                                                      | `shared/index.rs::build` from the CLI (eager at init + after every download)                                                                                          | Only `shared/plan_publish.rs` on the client (dies post-Phase 1 at runtime, source deleted in Phase 7)                    | Phase 2 stops writing these                                                                                                                                                                                                                         |
| Per-folder tables (`Contacts`, `blog_en`, ...) with column metadata, FK metadata, validation results | `shared/folder_index.rs::reindex_table` / `refresh_folder` / `reindex_files` etc., invoked by the desktop via `scratchmd index rebuild-folder` / `refresh-files-full` | `read_records.rs::run_query` (SQL `LIMIT/OFFSET/WHERE/ORDER BY` — desktop grid pagination), validators, validation stats | **Tables and columns unchanged in Phase 2.** Note: the `approvedChanges` / `unapprovedChanges` column _compute_ changes in Phase 5 when the three-worktree comparison goes away — see [Phase 5](#phase-5--collapse-to-one-worktree-per-connection). |

**The `.db` file itself stays.** The CLI keeps opening it on every folder rebuild, refresh, and validation call from the desktop. Phase 2 only stops the `shared/index.rs` writes — the small `file_index` table that `plan_publish.rs` consumes.

**Why the desktop UI is unaffected:**

- Grid pagination uses `scratchmd read-records` → `folder_index::run_query` → SQL against per-folder tables. Doesn't touch `file_index`.
- Cross-record FK lookups (linked records, references) in the desktop go through the **server-side** index at `/api/repo/index/:id/lookup-filenames` (production endpoint, see `server/src/workbook/files.service.ts:330`). Not the local DB.
- Validation runs through `folder_index::validate_files`. Doesn't touch `file_index`.

**Delete from the CLI:**

- `workspaces.rs:755` — eager `index::build` at init (~35s saved on Stripe)
- `files.rs:430, 1985` — `rebuild_index_for_conn` calls after downloads
- `files.rs:4665–4687` — `rebuild_index_for_conn` itself (no other callers)
- `cli/commands/index.rs::init_command` + `dump_command` — the two subcommands that operate on the `file_index` table. The rest of that file delegates to `folder_index` (`rebuild-folder`, `refresh-files-full`, `find-stale-files`, `clear-folder`, `add-column`, `clear-column`, `rebuild-all`, `refresh-folder`, `refresh-files-columns-only`) — all of those stay; the desktop calls them.

**Defer to Phase 7** (deleted alongside `run-from-git`):

- `cli/commands/plan_publish.rs` (the local plan command wiring)
- `shared/plan_publish.rs` (~855 LOC) — the only remaining `file_index` reader

**Keep:**

- `shared/index.rs` (the module file) — the **service binary** depends on it. Same crate, two binaries.
- `service/routes/index.rs` — server-side HTTP API for the index, production load-bearing.
- `shared/folder_index.rs` — entire module, all subcommands, all desktop-facing surface.

**Sequencing:** Phase 2 (stop writing `file_index`) is safe before Phase 7 (stop reading it) because Phase 1 already stopped _calling_ `plan_publish.rs` from active client code paths. Deleting the writes stops doing wasted work; deleting the source waits until Phase 7.

**Done when:** `init` doesn't build the `file_index` table; downloads don't refresh it; `<conn>.db` exists and is written to as before, but no longer contains a `file_index` or `file_references` table after a fresh init.

### Phase 3 — Stop creating `reviewed-dirty` on init

> **Status: SHIPPED** on `dev-10144-mr6`. Concretely removed: the `setup_sparse_worktree(reviewed-dirty)` block in `init_connection` (workspaces.rs:710–724), the `update_reviewed_dirty` helper (files.rs:2343), all 11 call sites in `files.rs`, and the `reviewed_dirty_dir` field on `ConnectionContext` plus its initialization. Kept: `layout.reviewed_dirty_checkout_path` (still called by `plan_publish.rs`, dying in Phase 7) and the `remove_path(&reviewed_dirty_dir)` calls in `teardown_connection`/`detach_connection` (back-compat cleanup for workspaces created before Phase 3). Test assertion in `tests/workspaces.rs` inverted to check the worktree is NOT created. Verified: `cargo build` clean (0 warnings), full `cargo test` green (398 passes), `yarn build` + `yarn lint` + `server/yarn lint-strict` clean.

Once Phase 1 lands, `reviewed-dirty` is unused. Delete `layout.reviewed_dirty_checkout_path` references and the worktree setup in `workspaces.rs`. Also delete the `update_reviewed_dirty` calls in `cli/commands/files.rs` (called from accept/reject paths). Saves ~10–15s of `init` per large connection.

**Why this is safe to ship before Phase 5:** the only code that reads from `reviewed-dirty` is `shared/plan_publish.rs`, which Phase 1 dead-coded at runtime by routing desktop publishes through `/upload-patch`. Stopping the writes (`update_reviewed_dirty`) means the worktree (if it still exists on an old workspace) drifts out of sync with `dirty` — but nothing reads it, so the drift is harmless. New workspaces don't create the worktree at all.

**Done when:** `init` no longer creates the worktree and no code path references it.

### Phase 4 + 5 — Retire `dirty` branch, switch to `accepted-patches.json` (merged 2026-05-19)

> **Status: SUB-SLICES A + B + C + D + E + G + H.1 + H.1.5 + H.2 + H.3 + H.4 + F.1 + F.2.a + F.2.b + F.3 + F.4 + F.5 SHIPPED (latest: H.4 on 2026-05-21, `mr27`).** Slice F and Slice H both complete — all planned scope for the merged Phase 4+5 is in production. Single-user accept/reject/discard flow through `accepted-patches.json`; `files upload` ships the file verbatim; `files publish` reconciles it post-fetch via `re_anchor_patches` (patches that landed in `main` drop; failed-connector patches survive — fixed on `mr17`, see [DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when)); listing commands derive from it. **`scratchmd files download` now refuses with a structured `blocked_unreviewed` error when any working-tree edits are unreviewed; on the happy path it fetches origin, re-anchors `accepted-patches.json` against the new server `main`, replays the patches on top of the new blobs, and advances local `refs/heads/main`. Same-field collisions land in `.scratch/conflicts.log` (user wins).** **Slice F retired the multi-worktree model**: init now creates one non-sparse worktree per connection at `<workspace>/<conn>/` on `refs/heads/main`; the user-facing worktree carries `.scratch/` (schemas + views) natively; no more master worktree at `.scratch/connections/master/<conn>/`. Pre-F workspaces are refused with a `workspace_needs_reinit` structured error. **F.5 killed every remaining local dirty-branch read** — new napi `readFolderBlobs` binding feeds the desktop's three-way diff straight from the bare repo; `force-upload` + `find-merge-base` CLI subcommands deleted along with `force_push_origin_dirty` / `commit_file_map_to_dirty_ref` / `merge_base_to_string`; `DIRTY_BRANCH` constant + the workbook-config `dirty` fallback gone; `setup_connection` prunes the local `refs/heads/dirty` ref post-clone. The local dirty branch is now dead — only `#[cfg(test)]` fixture builders still touch it. Server-side `dirty` (publish working area) is unchanged. See [slice F spec](2026-05-20-slice-f-spec.md) for the cutover breakdown and [Phase 4+5 merger](#phase-45-merger-2026-05-19) in the decision log for the architectural context.
>
> **What shipped:**
>
> - **`mr7` (merged 2026-05-19)** — pure helpers landed under `#[allow(dead_code)]`:
>   - `scratch-git-2/src/cli/commands/re_anchor.rs`: `PatchKind`, `AnchoredPatch`, `PatchConflict`, `ReAnchoredOne`, `ReAnchorOutput`, `re_anchor_one`, `re_anchor_patches`, plus 15 unit tests covering server-untouched paths, no-op detection, path-deleted kind conversion, same-field collision, disjoint changes, user-delete-on-modified-path, batched API, serde shapes.
>   - `scratch-git-2/src/cli/commands/merge_patch.rs::apply`: RFC 7396 apply mirroring the server's `applyJsonMergePatch`, 7 tests including a diff-apply round trip.
>   - Decision log entries: re-anchor preserves the patch verbatim; conflict iff user-touched scope outcomes diverge AND server actually changed that scope.
> - **`mr8` sub-slice A (shipped 2026-05-19, commit `95329287`)** — `accepted-patches.json` IO + accept-time diff helper, all gated under `#[allow(dead_code)]`:
>   - `scratch-git-2/src/cli/config/accepted_patches.rs`: `AcceptedPatchesFile` + `load`, `save_atomic` (temp+fsync+rename), `clear`, `get_entry`, `upsert_entry` (with Create-then-Delete collapse), `remove_entry`, `remove_field` (drops the entry when last field empties). 11 unit tests.
>   - `scratch-git-2/src/cli/commands/re_anchor.rs::compute_entry`: `(path, snapshot, working) → Option<AnchoredPatch>` — accept-time inverse of `re_anchor_one`. 4 unit tests.
>   - `scratch-git-2/src/cli/config/mod.rs`: `pub mod accepted_patches`.
>   - Verified: `cargo build` clean, `cargo test --bin scratchmd` green (249 passes, +16 from mr7's 233 baseline).
> - **Sub-slice B — atomic cutover** (`mr11`/`mr12`/`mr13`/`mr14`, shipped 2026-05-19→2026-05-20). 13 micro-steps; see [`mr8-sub-slice-b-change-list.md`](mr8-sub-slice-b-change-list.md) for the per-step record. Highlights:
>   - New shared helpers `compute_accepted_state`, `apply_patch_entry_to_blob`, `field_paths_in_folder`, `approved_object_for_path`, `accepted_patches_dir(ctx)`.
>   - All 9 mutating CLI commands rewritten: `accept`, `accept-field`, `accept-all`, `reject`, `reject-field`, `reject-all`, `discard`, `discard-all`, plus the **new** `discard-field` (added because today's hybrid `reject-field` is being split — see [decision 35](#field-level-state-and-actions-clarified-2026-05-19-with-pm)).
>   - `restore-deleted-record` + `discard-created-record` switched to patch-entry checks.
>   - `files upload` reads `accepted-patches.json` verbatim (sub-slice C absorbed).
>   - `files publish` clears the file post-`refs/heads/main` advance. (Superseded on `mr17` by `reconcile_accepted_after_publish` re-anchor — see [DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when).)
>   - `unreviewed` / `unpublished` / `unpushed` derive from `(main, accepted-patches.json, working)` (sub-slice G absorbed).
>   - ~600 LOC of three-worktree comparison logic deleted (`compute_upload_patches`, local `PatchKind`, `_scoped_via_index` variants, `worktree_status_entries`, `scratch_only_map`).
>   - `FieldCommandResult.dirty_changed` renamed to `patches_changed`.
>   - End state: `cargo build` zero warnings; 459 tests pass (272 scratchmd unit + 169 service + 16 misc + 2 integration); `yarn lint-strict` clean.
> - **`mr14` — dogfood + bugfix + new docs** (2026-05-20). End-to-end exercise against a real workspace (`wkb_tOnbqcvoVB`, Airtable connector): all 9 mutating commands behave per the spec; upload genuinely lands on server's `dirty`; publish runs plan-job + run-job and clears the local file on success.
>   - **Path-resolution bug found and fixed (`95cc450e`):** 6 post-B sites used `WorkspaceLayout::for_cli(&ctx.workspace_dir)` to resolve `accepted-patches.json`, but `ctx.workspace_dir` is the workbook materialization path (`<workspace>/.scratch/workspace`), not the workspace root. Routed all post-B sites through the new `accepted_patches_dir(ctx)` helper that derives the root from `ctx.dirty_dir.parent()`.
>   - **New doc `scratch-git-2/docs/REVIEW_MODEL.md`** (`15c15175`): published/approved/local state model, the three actions, the reject-vs-discard callout, full CLI reference, `accepted-patches.json` shape. Linked from the root `CLAUDE.md` and from `scratch-git-2/CLAUDE.md`.
>   - **`scratch-git-2/docs/REPO_STRUCTURES.md` refreshed:** branches table now reflects server-owned `dirty`; `accepted-patches.json` added to derived-paths table; removed-by-Phase-3 `reviewed-dirty` references dropped; manual verification checklist rewritten around the new flow.
>   - **Follow-up bug filed:** [DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when) — `files publish` clears `accepted-patches.json` on orchestrator-level success even when the underlying connector batch failed. **(Fixed on `mr17`.)**
> - **`mr16` sub-slice D — pull rewrite** (shipped 2026-05-20). Two micro-steps in one commit:
>   - **D.1 — `scratch-git-2/src/cli/config/conflicts_log.rs`** (~155 LOC): `ConflictEntry` (camelCase serde), `path(workspace_dir)`, `append(workspace_dir, entry)` (POSIX `O_APPEND` single-write atomicity, ≤ PIPE_BUF), `now_rfc3339()` helper. 6 unit tests cover lazy `.scratch/` creation, JSONL line shape, `["*"]` whole-file sentinel round-trip, RFC 3339 parseability, and multi-entry append order. Registered as `pub mod conflicts_log;` in `cli/config/mod.rs`.
>   - **D.2 — `download_single_repo` rewrite** in `cli/commands/files.rs`. New flow per the [Phase 4 spec](#phase-4--5--retire-dirty-branch-switch-to-accepted-patchesjson-merged-2026-05-19): `workspace_lock::acquire` at `run_download` entry → workspace-wide pre-flight via the new `detect_unreviewed_for_pull` helper (refuse with `blocked_unreviewed` structured payload + non-zero exit if any unreviewed) → `fetch_origin` → short-circuit `up_to_date` if `main` didn't move → `re_anchor_patches` against `(refs/heads/main, refs/remotes/origin/main)` → conflicts streamed to `.scratch/conflicts.log` (best-effort; append errors don't abort the pull) → `materialize_local_repo(approved_map_new, local_map)` → atomic save of re-anchored `accepted-patches.json` BEFORE the ref bump (idempotent crash recovery) → `git_update_ref refs/heads/main`. New `print_blocked_unreviewed_result` handles the structured JSON + human output. `download_workbook` (programmatic refresh from `linked.rs`) gains the new `workspace_dir` arg but explicitly skips lock + pre-flight.
>   - **Deletions:** `prepare_upload_merge` (~57 LOC), `compute_merge_actions` (~89), `MergeAction` enum (~21), `merge_content` + `update_dirty_worktree_index` callsite + `worktree_reset_mixed` (no callers anywhere). 3 obsolete `prepare_upload_merge_*` tests + 1 `download_single_repo_uses_real_merge_base_*` test deleted. `git_rev_parse` (test-only wrapper) gated `#[cfg(test)]`; `rev_parse_to_string` gated `#[cfg_attr(not(test), allow(dead_code))]` + its re-export `#[cfg(test)]`-only. `shared/merge.rs` gains a module-level `#![allow(dead_code)]` (scratchmd no longer uses the 3-way merge; service still does).
>   - **Tests added (3):** `download_re_anchors_accepted_patch_when_server_touches_disjoint_field`, `download_logs_conflict_and_user_wins_when_server_overwrites_same_field` (the canonical Slice D acceptance test), and `download_returns_up_to_date_when_server_main_unchanged`. Each spins up a `BareFixture` with a real `git` and an origin bare repo; new helpers `seed_main_with_record` + `advance_remote_main` keep the setup tight.
>   - **End state:** `cargo build` zero warnings on both binaries; 464 tests pass (277 scratchmd + 169 service + 16 misc + 2 integration); `yarn lint` clean. Net diff: +565 inserted / -486 deleted across `files.rs` + tests + new `conflicts_log.rs`.
>   - **Spec update:** the `working-patches.json` stash design from the original Phase 4 spec was abandoned in favor of refuse-if-unreviewed; see [decision log → Pull design (revised 2026-05-20)](#pull-design-revised-2026-05-20) for the rationale.
> - **`mr18` sub-slice E — `folder_index` column compute** (shipped 2026-05-20).
>   - **`shared/merge_patch.rs`** (move). Hoisted from `cli/commands/merge_patch.rs` so `folder_index.rs` can apply RFC 7396 patches without depending on `cli/`. 5 import sites updated (re_anchor, files.rs, tests/files.rs). `apply_patch_entry_to_blob` remains in `cli/commands/files.rs` (it uses the cli-only `AnchoredPatch` type); `folder_index` does its own minimal kind dispatch over a raw `serde_json::Value` view of the patch file.
>   - **`shared/folder_index.rs` schema bump v2 → v3.** New `accepted_patches_mtime INTEGER` column on each per-folder table. The existing `sweep_stale_version_tables` mechanism drops v2 tables on next open and rebuilds them cold — no `ALTER TABLE` migration. `CORE_COLUMNS` updated; `StoredRow` + `load_stored_rows` carry the new column.
>   - **New compute helpers**: `resolve_accepted_patches_path`, `load_patch_index`, `AcceptedKind`/`AcceptedEntry`/`PatchIndex`, `folder_sub_path`, `repo_relative_path_for_filename`, `approved_json_for_entry`, `compute_review_bits`. The compute reads the patch file once per refresh call, builds a `HashMap<repo-relative-path, AcceptedEntry>`, and per file computes `(approvedChanges, unapprovedChanges)` from `(patch_entry, working_stat, working_json, master_json)`.
>   - **`refresh_index` + `reindex_files`** rewritten: stop reading `<ws>/.scratch/connections/dirty/<conn>` (dead since Phase 3). `dirty_mtime`/`dirty_size` columns are now always written `NULL` — Slice F drops them entirely along with the worktree. The `reindex_files` "delete row if file gone from all trees" branch now keeps the row alive when a patch entry exists (e.g. a `Create` whose working file was deleted out-of-band).
>   - **`find_stale_files`** gains an `accepted_patches_mtime` staleness check: rows whose stored mtime predates the current patch file mtime are flagged, even when the working file is unchanged. Catches the discard / accept-elsewhere case where the bits need to flip but the working file hasn't been touched.
>   - **Column semantics flipped** (latent bug fix). Old compute: `approvedChanges = working ≠ dirty` (= unreviewed), `unapprovedChanges = dirty ≠ master` (= unpublished). New compute: `approvedChanges = path has patch entry` (= unpublished), `unapprovedChanges = working ≠ approved` (= unreviewed). The desktop's `scratch-desktop/src/main/local-files.ts` filter mapping flipped to match: `unreviewed` → `unapprovedChanges`, `unpublished` → `approvedChanges`.
>   - **Tests**: 8 tests rewritten to seed `accepted-patches.json` instead of the dirty filesystem tree (`test_working_only_file_appears`, `test_approved_changes_flag`, `test_unapproved_changes_flag`, `test_filter_approved_changes`, `test_filter_unapproved_changes`, `test_filter_has_dirty` → renamed to `…_returns_nothing_post_slice_e`, `test_summary_dirty_only` → renamed to `…_is_always_zero_post_slice_e`, `test_combined_filters_and_semantics`, `test_file_content_change_updates_index`). New test `test_patch_file_change_invalidates_rows` asserts that bumping the patch file mtime flips bits without a working-file edit.
>   - **End state**: `cargo build` zero warnings on both binaries; 484 tests pass (280 scratchmd + 186 service + 2 misc + 16 jsonschema; +5 net for slice E rewrites + new test); `yarn lint` + `yarn build` from root clean; `server/yarn lint-strict` clean. `cargo fmt --check` clean.
>   - **Latent bug fix:** post-Phase-3, the dirty filesystem tree at `<ws>/.scratch/connections/dirty/<conn>` was never populated, so the old compute returned `approvedChanges = 1, unapprovedChanges = 1` for almost every file with a working copy. The desktop's `unreviewed` / `unpublished` grid filters were showing everything indiscriminately. Slice E fixes this.
> - **`mr17` — DEV-10175 fix (publish over-clears `accepted-patches.json` on connector failure)** (shipped 2026-05-20).
>   - **New helper `reconcile_accepted_after_publish(ctx, workspace_dir, token)`** in `cli/commands/files.rs`, sibling of `download_single_repo`: snapshot pre-fetch `refs/heads/main` → `fetch_origin` → `re_anchor::re_anchor_patches` against `(old_main, refs/remotes/origin/main)` → append same-field collisions to `.scratch/conflicts.log` (best-effort) → `accepted_patches::save_atomic` BEFORE `git_update_ref refs/heads/main` (same crash-recovery ordering as the pull). Patches whose outcome matches `new_main` drop via `re_anchor_one`'s no-op detection; patches whose connector batch failed survive verbatim.
>   - **`run_publish` rewritten** to call the helper in place of the prior `fetch_origin` → `git_update_ref` → `accepted_patches::clear` triplet.
>   - **`accepted_patches::clear` removed** as dead code along with its `clear_removes_file_idempotent` unit test.
>   - **Tests added (3):** `reconcile_keeps_patch_when_server_main_did_not_advance` (canonical bug repro), `reconcile_drops_patch_when_server_published_the_change`, `reconcile_keeps_failed_record_when_partial_publish_succeeded`. All three use the existing `BareFixture` + `seed_main_with_record` / `advance_remote_main` helpers from `mr16`.
>   - **End state:** `cargo build` zero warnings; 279 scratchmd unit tests pass (+2 net: +3 new, -1 deleted); `cargo fmt --check` clean; `yarn lint` + `yarn build` from repo root clean.
> - **`mr20` sub-slice H.1 — hoist review_ops core into shared/** (shipped 2026-05-20, commit `30010d41`). Spec: [`2026-05-20-slice-h-spec.md`](2026-05-20-slice-h-spec.md). The CLI-side compute layer that the future napi binding will share is now in `shared/`.
>   - **Renames (git-tracked, history preserved):** `cli/commands/re_anchor.rs` → `shared/re_anchor.rs`; `cli/config/accepted_patches.rs` → `shared/accepted_patches.rs`.
>   - **New `shared/review_ops.rs`** (~1050 LOC, ~700 LOC code + 10 unit tests + ~350 LOC docs): `ConnectionPaths` struct (subset of `ConnectionContext` review_ops needs); pure compute helpers (`accept_field_in_folder`, `reject_field_in_folder`, `discard_field_in_folder`, `field_paths_in_folder`, `approved_object_for_path`, `compute_accepted_state`, `apply_patch_entry_to_blob`, JSON/path utilities, `PatchAction` enum, `FieldCommandResult`); FS-only helpers (`read_materialized_repo`, `read_dirty_disk`, `read_scratch_disk`, `apply_changed_working_files`, `write_or_remove_working_file`, `write_file`, `sync_schema_files_from_master`, `accepted_patches_dir`, `normalize_crlf`).
>   - **`workspace_lock`** gained a structured short-wait entry point: new `LockError` enum (`Busy { pid, lock_path }` | `Io(io::Error)`) + `try_acquire_with_short_wait(workspace_dir, timeout) -> Result<_, LockError>`. Existing `acquire(_) -> anyhow::Result<_>` (30s) now delegates to it. Resolves [decision D7](2026-05-20-slice-h-spec.md#resolved-decisions). +2 new tests for the short-wait path.
>   - **`cli/commands/files.rs`** shrunk by ~900 LOC. New `impl ConnectionContext::to_paths()` builds a `ConnectionPaths` from the full context; 8 thin wrapper fns (`accept_field_in_folder`, `reject_field_in_folder`, `discard_field_in_folder`, `read_materialized_repo`, `apply_changed_working_files`, `write_or_remove_working_file`, `sync_schema_files_from_master`, `accepted_patches_dir`) keep the existing `&ConnectionContext`-shaped signatures so every call site is untouched. Helper bodies deleted in place.
>   - **Tests moved alongside the code:** 10 tests for `compute_accepted_state` + `apply_patch_entry_to_blob` (the `accepted_state_helpers` module) moved from `cli/commands/tests/files.rs` into `shared/review_ops::tests`. The field-level tests (accept*field*_, reject*field*_, discard*field*\*) stay next to the cli wrappers — they depend on `ConnectionContext` fixtures that haven't moved. Side benefit: the service binary now exercises the moved tests too (+10 tests on the service side).
>   - **Deviation flagged for H.1.5:** the spec's I/O-bundling public entry points (`accept_field`, `discard_field`, `restore_deleted_record`, `discard_created_record` with `LockMode`) were not added. They need to read `refs/heads/main`, which means calling git. `git_ops` is still in `cli/`, so `shared/review_ops` can't reach it without a cross-module hack. H.1.5 picks this up — see the [updated sequencing](2026-05-20-slice-h-spec.md#sequencing-inside-the-slice).
>   - **End state:** `cargo build` zero warnings on both binaries; **526 tests pass** (282 scratchmd + 226 service + 2 integration + 16 jsonschema); `cargo fmt --check` clean; `yarn lint` from repo root clean. Net diff: −1025 / +1405 lines (the +1405 is mostly `shared/review_ops.rs`, ~50% of which is docs+tests).
> - **sub-slice H.1.5 — public entry points + git plumbing** (shipped 2026-05-20). Picked **option (b)** from the H.1.5 sketch (small extraction, not full git_ops hoist). Spec: [`2026-05-20-slice-h-spec.md`](2026-05-20-slice-h-spec.md#sequencing-inside-the-slice).
>   - **New `shared/git_local.rs`** (~170 LOC). Extracted `open_bare_repo`, `read_tree_files` (incl. the `git ls-tree | cat-file --batch` pipeline), `rev_parse_optional_to_string`, the canonical `FileMap` type, and the inline `normalize_crlf` helper. `cli/git_ops.rs` re-exports the same four names so the two existing CLI callers (`git_rev_parse_optional`/`read_git_tree` in `files.rs`) compile unchanged. `shared/review_ops::FileMap` is now `pub use crate::shared::git_local::FileMap`.
>   - **`cli/config/workspace_lock.rs` → `shared/workspace_lock.rs`** (git-tracked move). `cli/config/mod.rs` adds `pub use crate::shared::workspace_lock;` so the three existing CLI callers (`download`, `upload`, `publish`) compile unchanged. `#![allow(dead_code)]` on the moved module since the service binary doesn't acquire the lock.
>   - **Four public per-record entry points in `shared/review_ops`:** `accept_field(workspace_dir, conn, record_rel_path, field, local_value, LockMode)`, `discard_field(workspace_dir, conn, record_rel_path, field, LockMode)`, `restore_deleted_record(workspace_dir, conn, record_rel_path, LockMode)`, `discard_created_record(workspace_dir, conn, record_rel_path, LockMode)`. Each bundles: `resolve_connection_paths` (reads `<workspace>/.scratch/workspace.yaml` with a tiny serde-only `LocalWorkspaceMarker` shape) → `acquire_lock(workspace_dir, lock_mode)` (dispatches to `workspace_lock::acquire` for `DefaultBlocking` or `try_acquire_with_short_wait(100ms)` for `ShortWait`) → `read_main_tree_for_entry_point` (via `git_local::rev_parse_optional_to_string` + `read_tree_files`) → `accepted_patches::load` → mutate (delegate to existing folder helpers, or do per-record diff/compute inline) → `accepted_patches::save_atomic` → write/remove working file → return `ReviewOpResult`.
>   - **New types:** `LockMode { DefaultBlocking, ShortWait }`; `ReviewOpResult { workspace_path, patches_changed, working_changed, effect }`; `ReviewOpEffect { NoOp, PatchUpserted, PatchDropped, WorkingRestored }`; `ReviewOpError` (thiserror-based, includes `LockBusy { pid, lock_path }` for the napi `LOCK_BUSY` mapping). Implements `From<workspace_lock::LockError>` for clean propagation.
>   - **Tests:** 5 new in `cli/commands/tests/files.rs::entry_points` — `accept_field_round_trip_persists_patch_file`, `accept_field_returns_lock_busy_when_held` (writes a fake lock with the current PID; entry point's `kill(0)` probe sees it as alive and `try_acquire_with_short_wait` returns Busy after 100ms), `discard_field_drops_patch_entry_when_empty`, `restore_deleted_record_errors_on_non_delete_entry`, `discard_created_record_errors_when_main_has_path`. Each spins up a real bare repo at `<workspace>/.repos/conn1.git/` (matches `WorkspaceLayout::bare_repo_path("conn1")`) and writes a minimal `workspace.yaml`. Tests use the existing `commit_all` / `run_git` / `git_available` helpers in the cli test module.
>   - **Deviation captured:** the parent spec line "CLI's `run_accept_field` / `run_reject_field` / `run_discard_field` / `run_restore_deleted_record` / `run_discard_created_record` thin to one call into the new entry points" did not survive contact with implementation. The four entry points are per-record; three of those CLI commands are folder-scoped, and the other two have all-or-nothing batch semantics that would break if looped. Resolution: CLI wrappers stay using the folder/batch helpers in `shared::review_ops`; the new entry points are the napi-facing surface, with H.3 wiring the desktop's per-cell handlers where the per-record shape is the natural fit.
>   - **End state:** `cargo build` zero warnings on both binaries; **536 tests pass** (287 scratchmd + 231 service + 2 integration + 16 jsonschema); `cargo fmt --check` clean; `yarn lint` from repo root clean. Net delta vs. H.1: +5 scratchmd unit tests, +5 service tests (the moved `workspace_lock` tests now visible to the service binary). Estimated ~600 LOC across `shared/git_local.rs`, the new entry points + types in `review_ops.rs`, and the fixture-backed test module.
> - **sub-slice H.2 — napi crate + first binding + desktop loader** (shipped 2026-05-20). Spec: [`2026-05-20-slice-h-spec.md`](2026-05-20-slice-h-spec.md#sequencing-inside-the-slice).
>   - **Cargo workspace.** `scratch-git-2/Cargo.toml` is now a workspace root with `.` + `napi` as members. `[profile.release]` moved up from the napi crate to the workspace root to silence cargo's sub-package profile warning.
>   - **New `src/lib.rs` (~10 LOC).** Minimal library target so the napi crate can resolve `scratch_git_2::shared::review_ops::*`. Re-uses the same `#[path = "../shared/mod.rs"]` trick the two binaries already use; the binaries don't depend on this library.
>   - **New `napi/` crate** (`scratch-git-2/napi/`). `Cargo.toml` declares `crate-type = ["cdylib"]` and depends on `napi 2.x` + `napi-derive 2.x` (with `type-def` feature) + the parent crate via path-dep. `src/lib.rs` defines the JS-side `ReviewOpResult` shape (effect as a flat string), `map_err`, and one `#[napi]` async binding: `accept_field` (renders as `acceptField` on the JS side). `build.rs` is the one-line `napi_build::setup()`. Hand-written `index.d.ts` because napi-rs's `--dts` autogen didn't produce output in our workspace setup.
>   - **Error-code convention.** napi 2.x doesn't let Rust override `err.code` (it's reserved for the napi `Status` enum), so the binding prefixes error messages with the structured code: `"LOCK_BUSY: workspace lock held by another scratchmd process (pid 12345)"`. The desktop's `parseNativeErrorCode(err)` helper extracts the prefix.
>   - **`scratch-desktop/src/main/native/scratchmd-native.ts` loader.** Resolves the platform-correct `.node` between `<repoRoot>/scratch-git-2/napi/` (dev) and `process.resourcesPath/bin/` (packaged). Exports `acceptField(...)`, `parseNativeErrorCode(err)`, `NativeErrorCode` union, `ReviewOpResult` type. No IPC handlers consume it yet — H.3 wires the three cell-edit handlers.
>   - **Build pipeline.** `@napi-rs/cli` v3's workspace handling proved fiddly, so `scratch-desktop/scripts/build-native.sh` uses `cargo build -p scratchmd-native` + manual `libscratchmd_native.dylib` → `scratchmd-native.<platform>-<arch>.node` rename. Script picks `darwin-arm64` / `darwin-x64` / `linux-x64-gnu` from `uname`. Wired into `scratch-desktop/package.json` as `predev` + `prebuild` + `build:native` so `yarn dev` auto-rebuilds (~1s incremental, ~45s clean release). Packaged builds get a fresh `.node` via `prebuild`.
>   - **`electron-builder.yml` extraResources.** New glob copies `scratch-git-2/napi/scratchmd-native.*.node` into `Resources/bin/` at packaging time. `electron-builder.unsigned-mac.yml` inherits via `extends`.
>   - **Smoke tests** in `scratch-git-2/napi/__tests__/accept-field.test.mjs` (Node built-in test runner — no new npm dep on the napi crate). Two tests: round-trip writes `accepted-patches.json` correctly; `LOCK_BUSY:` message prefix surfaces when the workspace lock is held by a live PID. Verified end-to-end against a temp workspace + bare git repo from JS.
>   - **End state:** `cargo build --workspace` zero warnings; **714 tests pass** (178 lib + 287 scratchmd + 231 service + 2 integration + 16 jsonschema; +178 vs H.1.5: the new library target compiles `shared::tests` for a third time); `cargo fmt --check` clean; `yarn lint` + `yarn build` from repo root clean. Mac arm64 `.node` is 4.2 MB release-stripped.
> - **sub-slice H.4 — multi-platform CI + afterPack wiring** (shipped 2026-05-21, `mr27`). Spec: [`2026-05-20-slice-h-spec.md`](2026-05-20-slice-h-spec.md#sequencing-inside-the-slice). Closes slice H.
>   - **CI `.build_cli_for_desktop`** (`scratch-desktop/.gitlab-ci-release.yml`) now also runs `cargo zigbuild --release -p scratchmd-native --target <triple>` for `aarch64-apple-darwin` + `x86_64-unknown-linux-gnu`. The produced `.dylib`/`.so` is renamed to `cli-binaries/<triple>/scratchmd-native.<platform>-<arch>[-<abi>].node` so the filename matches what the desktop loader (`scratch-desktop/src/main/native/scratchmd-native.ts::nativeBinaryFilename`) expects at runtime. Windows napi deferred — same gap as before slice H.
>   - **`scratch-desktop/scripts/afterPack.cjs`** extended to copy the platform-correct `.node` from `cli-binaries/<triple>/` into `<resourcesDir>/bin/` alongside the CLI binary. On `win32-x64` the copy is skipped with a logged warning (CLI still ships). On other supported platforms a missing `.node` raises a loud failure with a copy-paste cargo command. afterPack runs before electron-builder's codesign + notarize pass, so the `.node` is included in the signed bundle automatically.
>   - **`scratch-desktop/electron-builder.yml`** `extraResources` glob `from: ../scratch-git-2/napi/` removed. afterPack is the canonical path now — the glob would have copied stale dev-machine `.node` files on builds where CI artifacts hadn't been generated (i.e. always, on the Linux package runner where `build-native.sh` skips for lack of cargo). `electron-builder.unsigned-mac.yml` inherits via `extends:` so the change propagates.
>   - **Local mac build scripts** (`scripts/build_mac_local.sh`, `scripts/build_mac_prod_local.sh`) extended to build both `scratchmd` and `scratchmd-native` for `aarch64-apple-darwin` before invoking the packaging step; both drop into `cli-binaries/aarch64-apple-darwin/`. Native-Mac uses plain `cargo build` (matching the existing CLI heuristic — zigbuild's SDKROOT/-L handling fights Xcode on a host Mac). `BUILD_SCRATCHMD=0` short-circuit in `build_mac_prod_local.sh` now requires both files to exist. `build_mac_local_signed.sh` left untouched (it's a sign-and-package wrapper that assumes `cli-binaries/` is already populated).
>   - **No SHA-check guard** baked in. The original "stale `.node` SHA guard" in the spec was scoped to the in-repo `Resources/bin/` bundling approach we didn't adopt. afterPack pulls fresh CI artifacts every release; the loud-failure-on-missing case covers the "did CI build it?" question directly.
>   - **Verification**: afterPack dry-runs cover all three packaged platforms (`darwin-arm64`, `linux-x64`, `win32-x64`) + the missing-`.node` error path; YAML parses (`.gitlab-ci-release.yml` + `electron-builder*.yml`); desktop `yarn lint` + `yarn build` + `yarn test` (140 tests) clean; napi smoke tests (`node --test napi/__tests__/*.mjs`) still 5/5 green. Full packaged-mac e2e (notarized `.app`, cell-edit hits napi, no `refs/heads/dirty` advance) deferred to the next packaged-mac release dogfood.
>   - **End state.** Slice H complete. Mac arm64 + Linux x64 packaged builds bundle the napi `.node` from the same CI artifact tree the CLI binary uses; no live surface writes to `refs/heads/dirty` from local actions.
> - **sub-slice H.3 — desktop handler migration** (shipped 2026-05-20). Spec: [`2026-05-20-slice-h-spec.md`](2026-05-20-slice-h-spec.md#sequencing-inside-the-slice). The desktop no longer writes to `refs/heads/dirty` from local actions.
>   - **New `discardField` binding** in the napi crate (mirror of `acceptField`; same async + ShortWait + error-prefix shape). Hand-written `index.d.ts` updated; napi smoke tests grew from 2 → 3 (added a `discardField` round-trip that verifies entry-dropped + working-file restored to main).
>   - **Desktop loader (`scratch-desktop/src/main/native/scratchmd-native.ts`) gained:** `discardField` re-export, `deriveRecordPaths(workspacePath, folderPath, filename) → {connectionDirName, recordRelPath}` for converting the IPC-handler triple into the napi-binding pair, and `acceptCellField(...)` / `discardCellField(...)` convenience wrappers that combine `deriveRecordPaths` + the corresponding native call.
>   - **Three IPC handlers in `local-files.ts` reduced to one-liners:** `acceptCellChange` (coerce + `acceptCellField`), `acceptCellInputText` (schema-driven coerce + `acceptCellField`), `undoApprovedCellChange` (straight `discardCellField`). Schema-driven coercion stays in TS — it reads on-disk schema files the Rust core doesn't know about.
>   - **Dead code purged** from `local-files.ts` (~150 LOC): `applyAcceptedCellValue`, `commitReviewedDirtyFile`, the dead local copies of `restoreDeletedRecord` + `discardCreatedRecord` (IPC handlers already routed through the `*ViaCli` shell-outs), JSON-field helpers (`patchJsonField` / `applyJsonField` / `readJsonField` / `removeJsonField` / `readJsonObject` / `writeJsonObject` / `setNestedValue` / `getNestedValue` / `deleteNestedValue` / `deleteNestedValueAt`), worktree-path / git-spawn helpers (`getConnectionPaths` / `toGitPath` / `pathExists` / `runGit`), and the `JsonFieldValue` + `ConnectionPaths` types + `child_process.execFile` import.
>   - **Tests:** new `scratch-desktop/src/main/__tests__/scratchmd-native.spec.ts` (+8 vitest tests) covering `deriveRecordPaths` (folder-split, nested folders, escapes-workspace error, equals-workspace error) and `parseNativeErrorCode` (known prefix, unknown prefix, no prefix, non-Error values). Mocks `electron`'s `app` so vitest doesn't need an Electron runtime.
>   - **End state:** desktop vitest **140 passes** (was 132; +8 new); `yarn lint` + `yarn build` + `yarn test` from repo root clean; `cargo build --workspace` zero warnings; **714 cargo tests pass** (unchanged from H.2 — the migration was pure TS-side surgery); napi smoke tests 3/3. `grep -r commitReviewedDirtyFile scratch-desktop/` returns nothing.
>   - **Dogfood deferred:** verifying a real Electron-built cell-edit produces an `accepted-patches.json` entry (and doesn't advance `refs/heads/dirty`) is a manual step. The standalone Node smoke tests in `napi/__tests__/` already prove the JS → Rust → JS round trip end-to-end.
>
> **Slice status:**
>
> | Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | LOC est.                                                                                                                                                                                                                                               | Status |
> | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
> | A     | IO + accept-time diff helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Shipped** on `mr8` (`95329287`).                                                                                                                                                                                                                     |
> | B     | Atomic cutover of all mutating + listing commands to `accepted-patches.json`; ~600 LOC of three-worktree logic deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **Shipped** on `mr11`/`mr12`/`mr13`/`mr14`.                                                                                                                                                                                                            |
> | C     | `files upload` reads patch file verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **Absorbed into sub-slice B step 8.**                                                                                                                                                                                                                  |
> | D     | Rewrite `download_single_repo`: refuse with a structured error if any unreviewed working-tree edits exist (user must `accept-all`/`discard-all` first), then re-anchor `accepted-patches.json` against `(old_main, new_main)` via `re_anchor_patches` and replay accepted edits on top of new `main` blobs. Append same-field accepted-vs-server collisions to `.scratch/conflicts.log`. No stash file, no `--clear-stash` flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Shipped** on `mr16`.                                                                                                                                                                                                                                 |
> | E     | `folder_index` columns `approvedChanges` / `unapprovedChanges` switch compute: `approvedChanges = path appears in accepted-patches.json`; `unapprovedChanges = working differs from apply(snapshot, accepted_patch_for_path)`. Same columns + SQL — only population logic changes. (Also fixes a latent bug: post-Phase-3 the dirty filesystem tree was dead, so the old compute marked all rows as having changes regardless of state.) Desktop's `local-files.ts` filter mapping flipped to match the new column semantics (`unreviewed` → `unapprovedChanges`, `unpublished` → `approvedChanges`). Schema bumped to v3 so the existing `sweep_stale_version_tables` rebuilds tables cold on next open — no migration code. New `accepted_patches_mtime` column on each per-folder table; `find_stale_files` flags rows whose stored mtime predates the current `accepted-patches.json` mtime. Hoisted `cli/commands/merge_patch.rs` → `shared/merge_patch.rs` so `folder_index.rs` can apply patches without depending on `cli/`. | **Shipped** (this MR). ~200 LOC.                                                                                                                                                                                                                       |
> | F     | Init rewrite: one non-sparse worktree per connection on `refs/heads/main`; drop sparse `dirty` and `master` worktrees. Migration of in-flight workspaces by refuse + re-init prompt (not auto-rebuild, see [slice F spec](2026-05-20-slice-f-spec.md#migration-of-in-flight-workspaces)). F.5 closes the loop by killing every remaining local read of the `dirty` branch (desktop diff readers, CLI legacy commands, workbook-config fallback, local ref). **F.4 measured 30.4s init for the Monorepo (135k files, 5 connectors) — down from ~110s; see [Problem § post-F measurement](#problem).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **F.1 + F.2.a + F.2.b + F.3 + F.4 + F.5 shipped** (2026-05-20). ~1300 LOC across the five sub-slices (~500 for F.1–F.3, ~800 for F.5).                                                                                                                |
> | G     | Listing commands derive from `(main, accepted-patches.json, working)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Absorbed into sub-slice B step 9.**                                                                                                                                                                                                                  |
> | H     | **Shared Rust library + desktop migration.** Hoist the I/O-free accept/reject/discard core out of `cli/commands/files.rs` into `shared/review_ops.rs`; expose via a new `napi-rs` cdylib crate; rewrite the 3 direct-dirty-ops handlers in `scratch-desktop/src/main/local-files.ts` (cell-edit hot path: `acceptCellChange`, `acceptCellInputText`, `undoApprovedCellChange`) to call the Rust functions instead of patching the dirty worktree + advancing the dirty ref from TypeScript. Detailed spec: [`2026-05-20-slice-h-spec.md`](2026-05-20-slice-h-spec.md). Summary: [Slice H — Shared Rust library + desktop migration](#slice-h--shared-rust-library--desktop-migration).                                                                                                                                                                                                                                                                                                                                               | **H.1 + H.1.5 + H.2 + H.3 + H.4 shipped.** Desktop's three cell-edit handlers delegate to the napi binding; no live surface writes to `refs/heads/dirty` from local actions. **H.4 (2026-05-21, `mr27`)** wires CI to cross-compile `scratchmd-native` for Mac arm64 + Linux x64 alongside the CLI binary, with `afterPack.cjs` copying the platform-correct `.node` into the packaged `.app`'s `Resources/bin/` (`extraResources` glob removed). Local mac build scripts extended in lockstep. Slice complete. |
>
> **Pickup notes for the next slice:**
>
> 1. Pre-F, the user-facing worktree is still `ctx.dirty_dir` (sparse on `refs/heads/dirty`). Accept/reject/discard/pull write to `accepted-patches.json` (and now `refs/heads/main`) but the worktree path is unchanged. F is what retires the worktree-path indirection.
> 2. `re_anchor::re_anchor_patches` is wired into production via `download_single_repo` (mr16). `re_anchor::compute_entry` is wired via the accept-time path (mr11–mr14).
> 3. The migration step inside F can reuse `seed_accepted_patches_from_fixture` (already in the test suite) as a starting point: diff `dirty_tree` vs `main_tree` per data path, emit Create/Update/Delete entries.
> 4. [DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when) (`files publish` over-clears on connector failure) — **fixed on `mr17`**. `files publish` now calls `reconcile_accepted_after_publish` (re-anchor + save) instead of `accepted_patches::clear`; the latter is deleted as dead code.
> 5. **Slice F unblocked → both H.3 and slice F shipped** — H.3 migrated all three live Electron cell-edit handlers (`acceptCellChange`, `acceptCellInputText`, `undoApprovedCellChange` in `scratch-desktop/src/main/local-files.ts`) to delegate to the napi binding. No local-action surface writes to `refs/heads/dirty` anymore. **H.4 (multi-platform CI for the `.node` builds + afterPack wiring) shipped on `mr27` 2026-05-21** — CI cross-compiles `scratchmd-native` for Mac arm64 + Linux x64 in the same `.build_cli_for_desktop` job as the CLI; afterPack copies the platform-correct `.node` into the packaged `Resources/bin/`. Legacy `extraResources` napi glob removed. Slice H complete.
> 6. **`download_workbook` lock + pre-flight tightening — shipped on `mr28` 2026-05-21.** The linked-CLI programmatic refresh path (`download_workbook`, called from `linked.rs::{create,remove,pull,publish}` after server-side mutations) now acquires `.scratch/lock` and runs `detect_unreviewed_for_pull` per-connection before materializing. If any connection has unreviewed working-tree edits, the refresh logs a stderr warning naming the affected records (up to 10, then "... and N more") and returns Ok(()) — the linked-table action that triggered the refresh already succeeded server-side, so we don't bail; we just don't overwrite in-flight typing. User re-runs `scratchmd files download` after `accept-all`/`discard-all` to sync. Refactor: extracted `refresh_workbook_for_contexts(workspace_dir, contexts, folders, token)` as the testable inner loop. +2 unit tests against a custom inline bare fixture (the existing `create_bare_fixture` seeds `syncs/a.json` on main, which hits a known asymmetry between `read_main_tree` and `read_dirty_disk`'s `"syncs" => continue` filter — pre-existing, scoped out).
> 7. The original Phase 4 / Phase 5 sections below stay as the _design spec_; the slicing in this status block is the _execution plan_.

**Goal:** Replace the three-way merge download with a refuse-or-replay model. If the user has any unreviewed working-tree edits, the pull refuses up-front with a structured error and asks them to `accept-all` or `discard-all` first. Otherwise pull fetches the new server `main`, re-anchors the user's accepted-but-not-yet-published edits against the new head, and replays them on top. Same-field collisions between accepted patches and server changes resolve user-wins and are logged to `.scratch/conflicts.log`.

**Why refuse instead of stash:** the earlier design used a JSON stash file (`working-patches.json`) as the user's escape hatch when pull crashed mid-replay. Refusing up-front gives the same safety with no persistent state on disk: pull is fully idempotent, has no crash-recovery story to maintain, and matches git's familiar "commit or stash before pull" UX. The existing CLI commands (`accept-all`, `discard-all`, `unreviewed`) are already the right tools to clear the path — no stash file, no `--clear-stash` flag, no recovery prompt. See [decision log → Pull design (revised 2026-05-20)](#pull-design-revised-2026-05-20) for the trade-off rationale.

**CLI flow:**

1. Acquire `.scratch/lock`.
2. Detect unreviewed working-tree edits — for each data file, compare its content against `apply(refs/heads/main:<path>, accepted_patch_for_path)`. If any field's `local ≠ approved`, exit non-zero with a structured error listing the offending paths. No fetch happens.
3. Read `refs/heads/main` as `old_head`. Load `accepted-patches.json`.
4. `git fetch origin main`.
5. `gix` tree-vs-tree diff between `old_head` and `refs/remotes/origin/main` → list of server-changed paths.
6. Re-anchor each `accepted-patches.json` entry via `re_anchor_patches` against `(old_head, new_head)`:
   - Server didn't change a key the user accepted → entry valid as-is.
   - Server deleted a path the user `update`d → convert to `create` with reconstructed content; log a conflict.
   - Server changed a key the user accepted → user-wins. Entry value stays; meaning shifts from "change A→B" to "set to B." Append to `.scratch/conflicts.log`.
7. For each server-changed path:
   - No patch entry for the path → write the new `main` blob to the working file (or delete it if `main` removed the path).
   - Patch entry for the path → write `apply(new_main_blob, re_anchored_patch)` to the working file.
8. Persist re-anchored `accepted-patches.json` atomically. Advance `refs/heads/main` to `refs/remotes/origin/main`.

**Structured error on unreviewed (CLI `--json` mode):**

```json
{
  "status": "blocked_unreviewed",
  "unreviewed_count": 3,
  "paths": [
    "Companies/rec_acme.json",
    "Companies/rec_widget.json",
    "Companies/rec_globex.json"
  ]
}
```

Human output: `Cannot refresh — 3 unreviewed records: ...` followed by the path list and a suggestion to run `scratchmd files accept-all` or `scratchmd files discard-all`. Exit code non-zero.

**`conflicts.log` entry shape** (one JSON object per line, no record content):

```
{ "ts": "2026-05-18T13:24:51Z", "connectorAccountId": "ca_...", "path": "Companies/rec123.json", "conflictingKeys": ["website", "industry"] }
```

**Desktop:** Refresh action consumes the structured error. On `blocked_unreviewed`, surface a modal listing the affected records with three actions: "Accept all and refresh," "Discard all and refresh," and "Cancel." Each button maps to two CLI calls (the chosen `*-all` + `download`). Accepted-vs-server conflicts (logged to `conflicts.log`) are silent for now; a UI affordance is out of scope for D.

**Leaves alone:** init still creates worktrees the same way. The refuse-or-replay flow supersedes the three-way merge but doesn't require Slice F first — the worktree path used for reads/writes is the existing `ctx.dirty_dir` until F. The CLI no longer touches `refs/heads/dirty` on pull; the server's own `dirty` branch (the publish working area) is unchanged.

**Done when:** `scratchmd files download` refuses with the structured error when unreviewed edits exist; the happy path re-anchors `accepted-patches.json` against the new `main` and applies blobs cleanly; `.scratch/conflicts.log` is written on accepted-patch collisions; a round-trip test with concurrent server + user-accepted changes asserts user-wins and produces the conflict log entry; the local `refs/heads/dirty` ref is no longer touched by the download path.

### Phase 5 — Collapse to one worktree per connection

> **Note (2026-05-19):** Merged with Phase 4 — see [Phase 4+5 above](#phase-4--5--retire-dirty-branch-switch-to-accepted-patchesjson-merged-2026-05-19) for current status and the `mr8` sub-slicing plan. The design spec below remains accurate; only the ship-order changed.

Today's "dirty checkout" (sparse worktree of the dirty branch) becomes the single non-sparse worktree of `main`. The separate `master` worktree goes away — its snapshot-reads role is now served by `gix::rev_parse("HEAD:<path>")` against the bare repo. The `dirty` branch's role as "user's accepted snapshot" is taken over by [`accepted-patches.json`](#review-state-the-accepted-patches-file).

**Worktree changes:**

- Drop `materialize_dirty_checkout`'s sparse-checkout config; replace with a plain `git worktree add` of `main`.
- Remove all CLI references to the dirty branch. (Server-side, `dirty` continues to exist as the publish working area — by design, unchanged.)
- Delete `update_dirty_worktree_index` at `files.rs:2342` and its 9 call sites — it's a `worktree_reset_mixed` wrapper for the dirty worktree (despite the misleading "index" in its name), obsolete once the dirty worktree is gone.
- **Worktree-add mechanism:** verify whether the current gix crate version supports `worktree add` natively before defaulting to shell-out. If gix supports it, drop the shell-out.
- The `.scratch/lock` file lock from Phase 1 continues to gate any mutating op against the single worktree.

**Accept/reject/discard rewrite** — the CLI commands switch from advancing the `dirty` branch to mutating `accepted-patches.json`. The full action matrix lives in [Review state → Field-level actions](#field-level-actions) and [File-level commands](#file-level-commands); a one-line summary per command family:

- `files accept`, `files accept-all`, `files accept-field` → for each unapproved field, set the patch's value to `local`. Working file untouched.
- `files reject`, `files reject-all`, `files reject-field` → for each unapproved field, `local ← approved` (= `apply(main, patch_entry)` per field, falling through to `main` for fields the patch doesn't mention). Patch file untouched. No-op when nothing is unapproved.
- `files discard`, `files discard-all`, **new** `files discard-field` → `local ← published` for the field/file/scope; remove the corresponding fields from the patch entry; drop the entry if it empties.
- `files restore-deleted-record`, `files discard-created-record` → discard variants for `delete` / `create` entries (whole-file lifecycle, no field-level analogue).
- `files unreviewed`, `files unpushed`, `files unpublished` → compute the three states (unreviewed / approved-pending / published) from worktree + snapshot + patch file. See [Review state](#review-state-the-accepted-patches-file) for the per-file state rules.

**UX migration:** today's `reject` is a hybrid that silently switches to discard semantics once a file is already approved (see [Review state → UX migration note](#file-level-commands)). The new `reject` is strict — it only undoes unapproved edits — so desktop call-sites that relied on the hybrid need to route the second step through `discard` / `discard-field`. The CLI rewrite ships first; the desktop swap is a follow-up MR.

**Upload simplification** — `scratchmd files upload` (introduced in Phase 1) currently computes patches on the fly from worktree-vs-dirty-vs-main. Replace it with a thin reader: load `accepted-patches.json`, PUT to GCS, POST `/commit`, clear the file on success. The diff computation moves to accept time, where it belongs.

**folder_index column compute** — `reindex_files` / `refresh-files-full` currently populate `approvedChanges` / `unapprovedChanges` by comparing `working_stat` / `dirty_stat` / `master_stat`. Switch to the new compute: `approvedChanges = 1` iff path appears in `accepted-patches.json`; `unapprovedChanges = 1` iff working file differs from `apply(snapshot, patch_for_path)`. Columns and SQL filters stay; only the population logic changes.

**Migration of existing workspaces** — a workspace init'd on the old layout has no `accepted-patches.json` and still has the three worktrees on disk. On first run after Phase 5 ships:

- Option (a): Build a patch file from the existing `dirty`-vs-`master` diff before tearing down the worktrees, then re-clone as the new layout.
- Option (b): Prompt the user to re-init, which loses any locally-accepted-but-unpublished edits. Acceptable if (a) is too much work; the user can publish first, then re-init.

Choice deferred to the Phase 5 implementer; the desktop should at least detect the old layout and surface a clear message.

**Done when:** a fresh `init` against `wkb_3qH9SlxsNq` produces one bare repo + one non-sparse `main` worktree per connection. Accept/reject/discard mutate `accepted-patches.json`. `files upload` reads the file verbatim. `folder_index` columns populate from the new compute.

### Slice H — Shared Rust library + desktop migration

> **Detailed spec: [`2026-05-20-slice-h-spec.md`](2026-05-20-slice-h-spec.md)** — scope, Rust API surface (`shared::review_ops`), napi binding signatures, per-handler migration sketches, build/distribution pipeline, test matrix, four-PR sequencing (H.1–H.4), and resolved design decisions. **The spec is the authoritative implementation reference.** The summary below is just enough context for plan readers to understand where H fits in the gating order.

**Surfaced 2026-05-20 during sub-slice B dogfood.** Three IPC handlers in `scratch-desktop/src/main/local-files.ts` (`acceptCellChange`, `acceptCellInputText`, `undoApprovedCellChange`) bypass `scratchmd` entirely — they patch the working file and the dirty worktree, then advance `refs/heads/dirty` directly from Node. The design was Ivan's deliberate choice in [`ff5b1529`](https://gitlab.com/whalesync/spinner/-/commit/ff5b15296ed6a165829ea696c587a1a4cc6f4fb5) (2026-04-07) to avoid the ~50ms `scratchmd` spawn cost on every grid-cell keystroke. After sub-slice B, the CLI writes to `accepted-patches.json` and the desktop still writes to `refs/heads/dirty`; the two surfaces produce inconsistent local state.

H's approach: hoist the pure accept/reject/discard helpers from `cli/commands/files.rs` into a new `shared/review_ops.rs` module, add I/O-bundling public entry points there (acquire lock + load + compute + atomic save), and expose those entry points to Node via a new [napi-rs](https://napi.rs/) cdylib crate at `scratch-git-2/napi/`. Both CLI and desktop call the same Rust wrapper — one implementation, two consumers.

**Why this slice exists in the plan and not as a follow-up:** [slice F](#) (init collapse to one `main` worktree) cannot ship while any live surface still writes to `refs/heads/dirty`. H is the gating slice for F.

**Migration sequencing:**

- **Before H:** sub-slice B is in. CLI writes to `accepted-patches.json`; desktop writes to `refs/heads/dirty`.
- **H.1 + H.1.5 (shipped):** Rust core fully in `shared/` with four per-record public entry points + napi-ready types. Still no JS caller.
- **H.2 (shipped):** `scratchmd-native` cdylib exposes `acceptField` to Node; desktop main process can load and call it (loader + dev hook + extraResources wired). Still no IPC handler consumes it.
- **H.3 (shipped):** Desktop's three cell-edit handlers migrate to napi. Both surfaces now write to `accepted-patches.json` via the same Rust core. No live local surface advances `refs/heads/dirty`.
- **After H.3, before F:** Dirty ref still exists on disk (used by init / download), but no local action writes to it.
- **F:** Init stops creating the dirty worktree at all.
- **H.4 (shipped 2026-05-21):** CI cross-compiles `scratchmd-native` for Mac arm64 + Linux x64 in the same `.build_cli_for_desktop` job as the CLI binary. `afterPack.cjs` copies the platform-correct `.node` into the packaged `.app`'s `Resources/bin/` (replacing the previous `extraResources` glob, which would have shipped stale dev-machine `.node` files). Local mac build scripts (`build_mac_local.sh`, `build_mac_prod_local.sh`) extended in lockstep. Slice H complete.

See the spec for the full Rust + napi API, the per-handler before/after, the five-PR breakdown (H.1 hoist core, H.1.5 entry points + git helpers, H.2 napi crate + first binding + dev loop, H.3 desktop handler migration, H.4 multi-platform CI), and the resolved design decisions.

### Phase 6 — Parallelize connections

Replace the `for (ca, entry) in ...` loop in `workspaces.rs` with `rayon::par_iter` or `tokio::task::spawn_blocking` fan-out. Ships after Phase 5 (each connection is then "clone + worktree add" with no shared mutable state).

**Failure policy:** if 1/N connections fails to clone, log a warning and continue with the other N-1 — user gets a partial-but-usable workspace. If 0/N succeed, exit non-zero.

**Re-init detection:** if the workspace dir contains a partial prior init (some bare repos exist, others don't), detect via marker scan and resume the missing connections. Failing-clean is acceptable as a fallback.

**Done when:** total wall time is dominated by the single slowest connection, not the sum; partial-failure behavior is tested.

### Phase 7 — Delete `publish-v2/run-from-git`

Once Phases 1–6 are live and the desktop app has shipped using `/upload-patch`, monitor server metrics for callers of `POST :id/publish-v2/run-from-git`. When zero callers are observed for a sustained window (≥7 consecutive days), delete:

- The `run-from-git` endpoint in both `cli-workbook.controller.ts` and `publish-plan.controller.ts`.
- `enqueuePublishFromGitJob` and `publish-from-git.service.ts`.
- The CLI's local plan-build command (the `scratchmd files upload` flow that produces phase files — superseded by Phase 1's `upload` + `publish` commands).
- `scratch-git-2/src/shared/plan_publish.rs` (~855 LOC) — the only remaining reader of the local `index.db`. Deleting it completes the Phase 2 work on the client side.
- `cli/commands/plan_publish.rs` (the wiring that opened `index.db` for the local plan command).
- The parity test introduced in Phase 1.

Net debt reduction: ~600 LOC from `plan_publish.rs` and friends + sparse-checkout config + SQLite write paths removed. After Phase 7, the only publish path on the server is `/upload-patch` → `publish-v2/plan-job` → `publish-v2/run-job`.

**Perf gate:** Before deletion, measure p50/p95 latency of the new path's `/upload-patch` → first published operation on the Monorepo workspace (135k files). Must be within 2× today's `run-from-git` baseline. If it regresses beyond that, fix before deletion, don't ship the regression and clean up later.

**Done when:** `run-from-git` has been removed from the server, CLI, and desktop, the parity test is gone, and the perf gate cleared.

## Out of scope

- Multi-user collaborative editing of the same workspace (still single-user assumed).
- Binary-file diffing (records are JSON; assets stay handled by the existing asset pipeline).
- Rewriting the server's publish pipeline itself — Phase 1 reuses it.
- Migrating existing workspaces on disk. New init produces the new layout; old workspaces continue working until re-init.
- Server-side dirty-branch cleanup. The branch may continue to exist server-side after Phase 5; removing it is a separate server-side task.
- The server-side SQLite index in scratch-git (`service/routes/index.rs`). Production grid views, files API linked-record refs, and the legacy publish-from-git path all depend on it. Out of scope for this plan.

## Risks

- **Same-field collision = silent user-wins.** Mitigated by `.scratch/conflicts.log` + PostHog event (Phase 4). The desktop app should eventually surface this as a UI; out of scope for v1.
- **Server-side publish performance.** Path A (`plan-job` + `run-job`) already exists and runs in production for the web client, so structurally the cutover is safe — but its perf on the 135k-file Monorepo workspace hasn't been benchmarked. Phase 7's gate forces a measurement before deletion.
- **gix `worktree add` gaps.** gix 0.70's worktree-add support was limited. Verify the current crate version before defaulting to shell-out.
- **Loss of git-as-undo.** Users currently have a local git history they could in principle inspect. Almost certainly unused, but worth confirming nobody depends on it before Phase 5 ships.
- **Migration of in-flight workspaces.** Workspaces already initialized on the old layout keep using the old code paths until they re-init. The desktop should prompt re-init when the new path lands.

## Status

| Phase                                             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — Server `/upload-patch`                  | **Shipped** on `dev-10144-{mr1,mr2,mr3}`. See [Phase 1 implementation notes](#phase-1-implementation-notes) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Phase 2 — Stop building master `file_index` table | **Shipped** on `dev-10144-mr4`. See Phase 2 status line above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase 3 — Drop `reviewed-dirty` on init           | **Shipped** on `dev-10144-mr6`. See Phase 3 status line above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase 4 + 5 — Retire `dirty` branch (merged)      | **Sub-slices A + B + C + D + E + G + H.1 + H.1.5 + H.2 + H.3 + H.4 + F.1 + F.2.a + F.2.b + F.3 + F.4 + F.5 shipped** on `mr7`→2026-05-21. Single-user accept/reject/discard write to `accepted-patches.json`; `files upload`/`publish` consume it; listing commands derive from it; `files download` re-anchors patches against new `main` and refuses with a structured error if any unreviewed working-tree edits exist (`mr16`); `folder_index` columns `approvedChanges`/`unapprovedChanges` now derive from `(main, accepted-patches.json, working)` and stay fresh via a new `accepted_patches_mtime` column (`mr18`); **`shared::review_ops` + `shared::accepted_patches` + `shared::re_anchor` + `shared::workspace_lock` + `shared::git_local` landed (`mr20` + H.1.5) with four per-record public entry points; the new `scratchmd-native` cdylib in `scratch-git-2/napi/` exposes `acceptField` + `discardField` + `readFolderBlobs` to Node via napi-rs (H.2 + H.3 + F.5) and is loaded by the desktop main process from `scratch-desktop/src/main/native/scratchmd-native.ts`. H.3 migrated the three Electron cell-edit IPC handlers (`acceptCellChange`, `acceptCellInputText`, `undoApprovedCellChange`) to delegate to the napi binding and deleted ~150 LOC of dead direct-to-dirty helpers in `local-files.ts` — no live surface writes to `refs/heads/dirty` from local actions anymore. Slice F retired the multi-worktree model: F.1 added the `workspace_needs_reinit` refusal for pre-F workspaces; F.2.a renamed `dirty_dir`/`dirty_checkout_path` → `worktree_dir`/`worktree_path`; F.2.b is the cutover (one non-sparse worktree on `main` per connection, idempotent init); F.3 deleted the legacy layout helpers + repointed `validators::run_validations` to read `refs/heads/main` via gix (fixed a latent F.2.b regression). F.5 killed every remaining local dirty-branch read — desktop diff readers (`readDiffGridDataPage`, `readDiffGridDataPageV2`, `findRecordOffset`, `readDiffRecordData`) repointed to the new `readFolderBlobs` napi binding; CLI's `force-upload` + `find-merge-base` subcommands deleted along with `force_push_origin_dirty` / `commit_file_map_to_dirty_ref` / `merge_base_to_string`; `DIRTY_BRANCH` constant + workbook-config `dirty` fallback gone; `setup_connection` prunes the local `refs/heads/dirty` ref post-clone.** [DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when) (`files publish` over-clear on connector failure) fixed on `mr17`. ~600 LOC of three-worktree logic + ~200 LOC of three-way merge code deleted in earlier slices; H.1 deleted ~900 more LOC from `cli/commands/files.rs` by hoisting the helpers; H.1.5 added the napi-ready surface (~600 LOC); H.2 added the napi crate + desktop loader plumbing (~400 LOC); H.3 migrated the desktop handlers + deleted ~150 LOC; F.2.b+F.3 deleted another ~300 LOC of legacy worktree code; F.5 deleted ~800 LOC of dirty-reading code across desktop + CLI. **F.4 (perf measurement) shipped — 30.4s init for the Monorepo (135k files, 5 connectors) down from ~110s, see [Problem § post-F measurement](#problem); H.4 (multi-platform CI for `.node` + afterPack wiring) shipped on `mr27` 2026-05-21.** See [Phase 4+5 status block](#phase-4--5--retire-dirty-branch-switch-to-accepted-patchesjson-merged-2026-05-19) for slice-by-slice detail, [slice F spec](2026-05-20-slice-f-spec.md) for the F sub-slicing record, and [`mr8-sub-slice-b-change-list.md`](mr8-sub-slice-b-change-list.md) for the per-step record. |
| Phase 6 — Parallelize connections                 | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase 7 — Delete `run-from-git`                   | Blocked on ≥7-day zero-caller window + perf gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Follow-ups

Smaller items to track as separate tickets. None block shipping the phases above.

### Linear-tracked

| Ticket                                                                                                                  | Title                                                                                    | Discovered                  | Notes                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when) | `scratchmd files publish` clears `accepted-patches.json` even when connector batch fails | Sub-slice B dogfood, `mr14` | **Fixed on `mr17` (2026-05-20).** Replaced the unconditional `clear` in `run_publish` with a new `reconcile_accepted_after_publish` helper that runs `re_anchor_patches` against (pre-fetch `refs/heads/main`, post-fetch `refs/remotes/origin/main`). Patches that landed in `main` drop via no-op detection; failed-connector patches survive. Dead `accepted_patches::clear` + test removed. |

### CEO follow-ups

| #   | Item                                                              | Why                                                                | Effort (CC) |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| F1  | Parallelize per-file patch loop in CLI publish (rayon)            | 1000+ files sequential is slow on Monorepo                         | 15min       |
| F2  | gix-patterns docs page in `scratch-git-2/docs/`                   | Bus factor — only the spike file uses gix today                    | 30min       |
| F3  | AuditLogService entries for `/upload-patch` + publish trigger     | `server/CLAUDE.md` requires audit logging on CLI interactions      | 30min       |
| F4  | Body size + nesting depth caps on `/upload-patch/commit`          | DoS guard on the trigger endpoint (presigned upload itself is GCS) | 15min       |
| F5  | Init: 1/N connector failure policy (continue vs rollback)         | Plan doesn't specify; needs choice + UX                            | 30min       |
| F6  | Init: re-run on partial state — resume or fail-clean              | Detect partial prior init and decide                               | 1h          |
| F7  | iCloud/Dropbox workspace detection + warning                      | Git on cloud-synced FS corrupts state                              | 1h          |
| F8  | Multi-connection publish atomicity model                          | Partial-success UX when 3/5 connectors succeed                     | 1h          |
| F9  | Publish-then-fetch failure → server-driven HEAD-advance signal    | Avoid silent local divergence when `git fetch` fails post-publish  | 1h          |
| F10 | conflicts.log rotation                                            | Prevent unbounded growth                                           | 15min       |
| F11 | Worktree lock metrics (acquire timeout, stale recovery)           | Observability gap                                                  | 30min       |
| F12 | Promote init-phase timings (`SCRATCHMD_PROFILE`) to PostHog event | See init perf in production                                        | 15min       |
| F13 | End-to-end publish smoke test per deploy                          | Catch regressions immediately post-deploy                          | 1h          |

### Eng-review follow-ups

| #   | Item                                                                                                                                                                 | Why                                                                                               | Effort (CC) |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------- |
| E1  | Backfill AuditLog across remaining `server/src/cli/` endpoints                                                                                                       | Scope-limited in Phase 1 to `/upload-patch`; rest of CLI still uncovered                          | 1h          |
| E2  | Delete `update_dirty_worktree_index` (`files.rs:2342`) and its 9 callers in Phase 5                                                                                  | Re-scoped: function is a `worktree_reset_mixed` wrapper, not SQLite; dies with the dirty worktree | 30min       |
| E3  | Verify gix worktree-add support in current crate version (may have landed since 0.70)                                                                                | If gix supports it natively, drop the shell-out                                                   | 15min       |
| E4  | Document desktop's post-publish `git fetch origin main` retry policy                                                                                                 | Finding 1.6 from CEO review on the data-flow shadow path                                          | 30min       |
| E5  | Add a branch-head lookup to ScratchGitService → ScratchGitClient and light up the `stalenessWarning` in `/upload-patch/commit`                                       | Currently `/commit` accepts `baseHead` but never compares; signal is dark                         | 1h          |
| E6  | Controller-level e2e for `/upload-patch` (supertest + NestJS TestingModule): asserts AuditLog row written, 503 on unconfigured bucket, staleness banner pass-through | The Phase 1 e2e covers the service; the controller surface still needs coverage                   | 1-2h        |

### CLI-review follow-ups

| #   | Item                                                                                                                                                     | Why                                                                                                                                                                   | Effort (CC) |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| C1  | Wire `.scratch/lock` into the remaining mutating commands (accept/accept-all/accept-field/reject*/discard*/restore-deleted-record/download/force-upload) | Phase 1 introduces the lock; only `upload` calls it today. The other mutating ops still rely on three-worktree implicit serialization, which Phase 5 removes.         | 1h          |
| C2  | Mock-HTTP integration test for the upload-patch round-trip                                                                                               | Unit coverage on `compute_upload_patches` + `merge_patch` is good; an end-to-end CLI test against a fake `/upload-patch/init`-`/commit` would catch wire-shape drift. | 2h          |
| C3  | Surface `stalenessWarning.new_head` in the printed warning (full SHA in `--json`, short SHA in human output)                                             | Today the warning string just lists the short SHA. Desktop will format more usefully; the CLI text could match.                                                       | 15min       |

### Dogfood follow-ups (mr29, 2026-05-21)

Surfaced during a full dogfood pass against `wkb_3qH9SlxsNq` (Monorepo, 5 connectors, 135k files) after slice F + H + mr28 shipped. Three release-blocking bugs were found AND fixed in the same MR — `2095293c` (walker dropped `.json`-named records), `55751f41` (folder_index read master from deleted worktree, marked all rows unreviewed), and `bb0e2c1f` (desktop badge counts swapped vs slice E column semantics). D1–D4 and D6 were also fixed in mr29; D5 is the remaining open item.

| #   | Item                                                                                                                              | Why                                                                                                                                                                                              | Effort (CC) | Status                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------- |
| D1  | Server file-naming slug: stop producing filenames like `.json` / `-.json` / `-alex.json` for non-ASCII record names               | Affects every workspace with international records. Found Stripe Customers with names "鄭菲菲" / "ԴեմԱռԴեմ Թիմ" / "안현수 (Alex)" slugged to filenames whose stem is empty or pure-punctuation. Fall back to the unique ID (`cus_*`) when the slug is empty. Likely in `server/src/remote-service/connectors/library/stripe/` or a shared file-naming utility. | 1h          | **Shipped on `d1a1f56f`** — added `isUsableFileNameSlug` (`server/src/workbook/util.ts`); applied at `resolveBaseFileName` + `buildGitFilesFromConnectorFiles`. New pulls produce clean filenames; existing on-disk names unchanged. |
| D2  | `conflicts.log`: report nested field paths (e.g. `properties.city`) instead of top-level RFC 7396 keys (`properties`)             | Today the user can see "fields collided" but not "which specific nested key" — too coarse to audit. Spec example used flat keys, but real connectors nest. Walk the patch entry recursively when emitting the `conflictingKeys` array.                                                                       | 30min       | **Shipped on `821c3b4c`** — `detect_conflict` now uses `collect_nested_conflicts` to recurse RFC 7396 objects and emit dot-separated key paths.                                                                                  |
| D3  | `scratchmd --json files discard-all`: suppress the plain "Discarding changes in <conn>..." progress lines                         | Breaks `jq` consumers; the `--json` flag should produce only the JSON result. Check sibling commands (`accept-all`, `reject-all`, `download` progress reindex banners) for the same leak.                                                                                                                   | 30min       | **Shipped on `2f1a51d9`** — root cause was `[reindex]` line from `reindex_files` on stderr (not the `Discarding...` lines, which already check `!json`). Gated the eprintln on `stderr.is_terminal()`.                              |
| D4  | `files accept` / `files discard` single-file variants: call `reindex_folder_index_for_changes` like `accept-all` / `discard-all`  | Desktop grid bits go stale after a per-file accept until something else triggers a reindex. The `*-all` variants already do this (`cli/commands/files.rs:1154`, `:1000`); the single-file `run_accept` (line 1188) and `run_discard` (line 1405) are missing the call.                                       | 15min       | **Shipped on `3e61aea8`** — added the reindex call to `run_accept`, `run_reject`, `run_discard`, `run_accept_field`, `run_reject_field`, `run_discard_field`, `run_restore_deleted_record`, `run_discard_created_record`.       |
| D5  | `readFolderBlobs` grid-load: page or stream blobs instead of loading the whole folder into Electron main memory                   | HubSpot/Contacts (22,864 records × ~3-5KB × 2 = published+approved) loads ~200-500MB synchronously when the user opens the folder, pinning the main process at 3GB+ RSS and freezing the UI for tens of seconds. Likely needs pagination at the napi layer or lazy per-row blob fetch.                       | 4-8h        | Open. Deferred — bigger scope, deserves a design pass on whether to page from napi or precompute per-row diff bits server-side.                                                                                                  |
| D6  | folder_index residual `paths.master` reads in `count_stale`, `reindex_files_columns`, `find_stale_files` variants                 | The user-facing critical path (`refresh-folder` / `reindex_files` for bit compute) is fixed on `55751f41`, but utility/diagnostic functions still read the deleted master worktree. Migrate them to `read_main_blobs_for_folder` so the diagnostic surface is consistent. Also drop `paths.master` and `paths.dirty` from `FolderPaths` when migration completes. | 1-2h        | **Shipped on `39b5b42a`** — `count_stale`, `find_stale_files`, `validate_page_records` now read main from `refs/heads/main`. `paths.master` / `paths.dirty` fields stay on `FolderPaths` as no-ops; dropping them is a follow-up.   |

## Decision log

Rationale captured during review and implementation. Records the _why_ behind the architecture so future readers can judge edge cases.

### Endpoint shape & job pipeline (Phase 1)

1. **Endpoint split.** Original proposal was inline `POST /publish { patches, baseHead }`. Conflating upload + publish reduces flexibility (can't retry publish without re-uploading; can't pre-stage a large patch). Split into `/upload-patch/init` + `/commit`.
2. **Reuse server-native publish.** Server already had `publish-v2/plan-job` + `run-job` used by the web client. New endpoint is a thin shim, not a new pipeline. Goal: one publish path on the server, no parallel system.
3. **Presigned GCS upload.** Inline POST hits NestJS body-parser limits and blows up server memory on big publishes. GCS upload-then-process matches the existing async-job UX.
4. **`baseHead` soft warning, not 409.** Hard rejection on stale `baseHead` would fail too often once incremental server-side polling started moving `main` under the user. Single-user assumption makes silent overwrites acceptably rare; audit log + telemetry covers the residual risk.
5. **Server-side path validation.** Path traversal in `patch.path` is the only Med-likelihood / High-impact security gap. Defense-in-depth: server is the gate; CLI may validate for UX.
6. **`/upload-patch/commit` only applies patches.** First cut auto-enqueued the publish pipeline from `/commit`, which the endpoint's name didn't promise; the CLI's poll then "completed" before the publish actually finished. Split into two CLI calls — `upload` (apply patches) and `publish` (plan-job + run-job).
7. **CLI shim endpoints under `/cli/v1/...`.** The CLI's `ApiClient` hardcodes `/cli/v1/` into its base URL. Two thin shim controllers for `/publish-v2/plan-job` and `/run-job` are cheaper than complicating URL construction, and keep the CLI behind a stable versioned namespace.
8. **Plan and run as two CLI calls, not `runAfterPlan=true` chain.** Splits cleanly for scripting and surfaces plan completion as a useful intermediate state.
9. **Local-main advance moves to `publish`, not `upload`.** Upload doesn't change server main; publish does. Previously they were lumped together in the legacy flow.
10. **`ServiceUnavailableException` (503) on unconfigured bucket** (not `BadRequestException`). Misconfiguration is server-side, not client-side. Client can branch on 503 to surface "admin needs to provision the bucket" vs treating as a user error.
11. **Use-case-specific `signPutUrlForPatchUpload` / `streamObjectFromPatchUpload`.** Each method enforces its bucket and pins `Content-Type`, so callers can't accidentally mix buckets. Preferred over generic `signPutUrl` / `streamObject`.
12. **DTOs in `@spinner/shared-types/dto/upload-patch/`.** Matches existing convention (`dto/schedule/*`, `dto/workbook/*`). Single source of truth for the wire contract; the Rust CLI re-declares the shapes via serde.

### Infrastructure (Phase 1)

13. **24h bucket lifecycle** (not 7d as originally proposed). Patches process within minutes; less data at rest is safer than a longer debugging window.
14. **Wildcard CORS for the upload bucket.** The signed URL is the auth (short TTL, per-upload, server-issued only to the authenticated session). CORS restriction is theatre for signed PUTs and would block future browser clients.
15. **Bucket name `${gcp_project_id}-upload-patches`.** Mirrors the asset bucket's naming.
16. **Local-dev GCS signing via impersonation (`GCS_LOCAL_SIGNING_SA`).** `@google-cloud/storage`'s V4 signer needs a `client_email`; user ADC doesn't have one. Cloud Run's runtime ADC is a service account so signing works natively. The env var, when set, wraps `Impersonated.sign()` to call IAM Credentials `signBlob` against the target SA. Requires `roles/iam.serviceAccountTokenCreator`.

### Concurrency

17. **`.scratch/lock` for any mutating CLI op.** Three-worktree design implicitly serialized via branch ops; the single-worktree design loses this. File lock matches git's own `.git/index.lock` pattern. PID-based stale reclaim via `kill(pid, 0)` ESRCH probe.
18. **`@SkipApiRateLimit` on read-only polling endpoints.** First-cut of the desktop modal had per-connection pollers running concurrently with a page-level poller, producing ~10 `/jobs/bulk-status` requests/sec and exhausting the 60-req/min CLI budget mid-publish. Fixed by (a) consolidating to one shared poller in the desktop, and (b) adding `@SkipApiRateLimit` to read-only polling endpoints in `JobController` (bulk-status, workbook/:id/active, :id/progress, :id/raw, run/:runId). `GET /jobs` (paginated DB scan) and `POST /jobs/:jobId/cancel` (mutating) stay limited.
19. **Single shared poller in the desktop.** One batched `/jobs/bulk-status` call per second feeds both the `jobs` state for connection-row rendering AND per-connection state-machine `await`s via a `pendingWaitsRef` Map.

### Diff format & conflicts

20. **RFC 7396 over RFC 6902.** ~60 lines total. Upgrade to RFC 6902 only if same-array conflicts become a real problem.
21. **User wins on same-field collisions** — log to `.scratch/conflicts.log` + PostHog event. Zero blocking UX, no silent data loss without an audit trail. Conflicts get more common as incremental polling moves `main`; the telemetry is the signal for whether a real conflict-resolution UI is needed later.
22. **Arrays in RFC 7396 are atomic.** Accept the limitation; log it in the conflicts file if both sides touched.

### Storage & diff detection

23. **Bare repo objects as snapshot storage.** No duplicate on-disk snapshot directory. Packed objects are already efficient storage.
24. **`gix::Repository::status(...)` for diff detection.** Index-backed; measured at parity with `git status` warm, ~7× faster cold. Already a dependency.
25. **Non-sparse worktree of `main`.** The `.git` link file is the only artifact; identical to today's dirty checkout. Non-sparse so we don't pay sparse-checkout config overhead.
26. **Shell out to `git worktree add` at init.** gix 0.70's worktree-add support is limited; we already shell out for this today. Hot path is one call per connection.

### Pull stash mechanism (Phase 4, superseded 2026-05-20)

> **Superseded by [Pull design (revised 2026-05-20)](#pull-design-revised-2026-05-20) below.** The entries here describe a `working-patches.json` stash mechanism that was abandoned before implementation in favor of a simpler refuse-if-unreviewed approach. The re-anchor design decisions (last two bullets) are still load-bearing — they apply to `accepted-patches.json` re-anchoring, which the new pull flow still does.

- **Stash to `working-patches.json` on disk, not git internals.** Original spec used `gix status` + in-memory `Vec<(path, patch)>` as the stash during pull. Switched to a plain JSON file on disk because: (a) if anything fails, the user can `cat` it and reason about it without git knowledge; (b) same RFC 7396 shape as `accepted-patches.json` and the `/upload-patch` payload, so the re-anchor routine's input contract is one shape across the codebase; (c) gives a natural "overwrite my local with the fresh copy" escape hatch via `--clear-stash`. Git still does snapshot reads and the fetch; only the stash moves to JSON.
- **File-only-during-pull, not persistent shadow log.** Considered keeping `working-patches.json` always-present whenever there's unreviewed work. Rejected: extra disk I/O on every accept/edit, and the working tree is already the source of truth for unreviewed state — a persistent shadow log would be derived state that drifts. The pull-only file is purely a stash artifact: written before fetch, deleted on success, left on disk only when something went wrong.
- **Pre-existing stash blocks new pull.** If `working-patches.json` exists at pull start, refuse and surface a recovery message. Blindly replaying an old stash against a fresh HEAD could silently re-apply edits the user has already manually merged or rejected. Better to make the user acknowledge the leftover.
- **Re-anchor preserves the user's patch verbatim, doesn't rebuild from "user-intended state."** First-pass design computed `user_intended = apply(old, patch)` and then re-diffed against `new` to produce a fresh merge patch. Subtle bug: if the user touched only key `a` but the server independently touched key `b`, the rebuilt patch would carry `b` along too (because `user_intended.b` came from `old.b`), inadvertently rolling back the server's `b` change. Switched to: keep the user's RFC 7396 patch as-is whenever the kind doesn't have to change. RFC 7396's merge semantics — "set these keys, delete these others, leave the rest alone" — are already the correct re-anchor behavior; the patch only needs to be repackaged when the file lifecycle changes (server deleted what user updated → emit Create with `apply(old, patch)`; server created what user created → emit Update with the same patch). Implemented in `re_anchor::re_anchor_entry`.
- **Conflict iff user-touched scope outcomes diverge from server's new state AND server actually changed that scope.** Earlier draft flagged a conflict any time user and server both touched the same key, even if they independently arrived at the same value. Tightened: a conflict only logs when (a) the user touched key K, (b) the server changed K (i.e. `old[K] != new[K]`), AND (c) the user's intended value at K differs from the server's new value at K. Avoids spurious entries in `conflicts.log` when both sides edited the same field to the same answer. The whole-file-replacement case (path deleted remotely, or non-object patch) emits `"*"` as the sentinel key.

### Pull design (revised 2026-05-20)

Surfaced when sizing slice D: the stash/replay design added a persistent on-disk file (`working-patches.json`), a crash-recovery flow, a `--clear-stash` flag, and a duplicated re-anchor pass over working-tree patches — all to silently preserve in-flight unreviewed edits across a pull. The simpler alternative — refuse the pull when unreviewed edits exist — gives the same data safety with a smaller surface and a UX users already understand from git.

- **Refuse the pull when any field has `local ≠ approved`.** No silent overwrite of in-flight typing; the user explicitly chooses what to do with their unreviewed work (`accept-all` to keep, `discard-all` to drop) and re-runs the pull. CLI exits non-zero with a structured `blocked_unreviewed` payload that the desktop pattern-matches on to present a three-action modal (Accept all & refresh / Discard all & refresh / Cancel).
- **No `working-patches.json`, no `--clear-stash`, no crash-recovery story.** Pull becomes idempotent — fetch + re-anchor + write blobs + write `accepted-patches.json` atomically — so a crash mid-pull leaves recoverable state without an escape hatch file. Removes ~150 LOC of stash IO + re-anchor doubling that the original design needed.
- **Accept-time and pull-time stay symmetric on the re-anchor side.** Accepted-patches.json is the single persistent re-anchorable artifact in the system. The five-bullet rationale from the superseded section above still applies (re-anchor preserves verbatim; conflicts only fire on genuine divergence) — those decisions transfer 1:1 to the new design without modification. The `re_anchor::re_anchor_patches` machinery is unchanged.
- **Trade-off accepted: pull is gated on the user reviewing their typing.** Earlier framing treated this as a UX regression. In practice the user has to reckon with their unreviewed work eventually (publish also requires accepting first); pull is now consistent with publish. The escape hatch for "I just want the fresh server copy" is `discard-all` → `download`, two commands the user already has.

### SQLite index scope (Phase 2 audit, 2026-05-19)

27. **One SQLite file, two table families.** Initial plan said "drop the SQLite index entirely" — wrong. There's a single `<workspace>/.repos/<conn>.db` per connection. Within it: a `file_index`/`file_references` pair (written by `shared/index.rs`, read only by `plan_publish.rs` on the client) and per-folder tables (written by `shared/folder_index.rs`, read by `read-records` for desktop grid pagination). The file stays; the CLI keeps writing per-folder tables; Phase 2 only stops the `file_index` build. Server-side, the scratch-git microservice's HTTP index API uses the same `shared/index.rs` module but against its own DBs in `service_repos_dir/<id>.db` — independent of the client and out of scope.
28. **Phase 2 is safe before Phase 7.** Phase 1 already stopped _calling_ `plan_publish.rs` from active client code paths; Phase 2 stops writing the `file_index` table the dead-coded reader would have read; Phase 7 deletes the reader source. The intermediate state (write-side gone, read-side still compiled but unreached) is fine.

### Phase 4+5 merger (2026-05-19)

After mr7 shipped the pure re-anchor + `apply` helpers, the next step was wiring them into the download flow. Surveying the code surfaced an architectural impedance mismatch: the plan's Phase 4 spec says "Read `refs/heads/main` as `old_head`" and "`gix status` against `old_head` snapshots" — but pre-Phase-5, the user's worktree is on `refs/heads/dirty` (sparse), not `main`. Computing a working-tree-vs-main diff conflates accepted-but-not-published edits (on the `dirty` branch) with unreviewed working-tree edits — exactly the structural distinction the three-worktree model existed to preserve.

Three options surfaced:

1. **Re-target Phase 4 to `dirty`** pre-Phase-5: stash is `working-tree vs refs/heads/dirty`, fetch advances both `main` and `dirty`, re-anchor against new `dirty`. Replaces the three-way merge cleanly but doesn't simplify the model — `dirty` is still load-bearing.
2. **Pull Phase 5 forward and merge with Phase 4**: retire `refs/heads/dirty` entirely as the source of truth for accepted state; switch to `accepted-patches.json` everywhere; the worktree is on `main`; pull is `stash unreviewed → fetch → re-anchor accepted + working → replay`.
3. **Hold Phase 4 until Phase 5 is fully spec'd**: ship the helpers and a no-op gate.

Curtis chose option 2 with the explicit framing: "I don't want to use git anymore for keeping track of accepted-but-not-published edits." Migration risk (existing in-progress workspaces have a populated `dirty` branch) is low — there are ~2–5 desktop users today, all reachable. The escape hatch is a "your workspace needs re-init" prompt if best-effort migration fails.

The merged phase is implemented across mr7 (re-anchor + `apply` helpers, dead-coded) and mr8+ (the cutover). Sub-slicing for mr8 lives in the [Phase 4+5 status block](#phase-4--5--retire-dirty-branch-switch-to-accepted-patchesjson-merged-2026-05-19). The original Phase 4 and Phase 5 sections remain as the design spec — only the ship order changed.

**What this buys us:** one source of truth for accepted state (a JSON file, not a git branch). Accept/reject/discard become simple JSON mutations instead of branch-graph operations. Publish reads the file verbatim. Pull becomes "stash → fetch → re-anchor → replay" with no merge logic. The `dirty` branch can be deleted from both client and server side eventually.

**What this costs:** sub-slice B is atomic (~600–800 LOC of careful surgery in `files.rs`) because partially rewriting commands would create inconsistent state. The plan to land mr8's B as a single coherent commit is a deliberate trade for review-effort over diff size.

### Shared Rust library via napi-rs, not duplicated TypeScript (2026-05-20)

Surfaced during sub-slice B dogfood: the desktop's five mutating cell handlers (`acceptCellChange` et al. in `scratch-desktop/src/main/local-files.ts`) bypass `scratchmd` entirely and write to `refs/heads/dirty` directly from Node. Sub-slice B made the CLI write to `accepted-patches.json`; the desktop kept its direct-to-dirty path, so the two surfaces now produce inconsistent local state. Ivan's [April 7 PR (`ff5b1529`)](https://gitlab.com/whalesync/spinner/-/commit/ff5b15296ed6a165829ea696c587a1a4cc6f4fb5) deliberately introduced the direct path to avoid the ~50ms per-call cost of spawning `scratchmd` when a user types in a grid cell — a legitimate latency win at the time, but the result was a duplicated implementation of accept/reject/discard semantics across Rust and TypeScript.

Three options surfaced for closing the gap:

1. **Shell out to `scratchmd` from the desktop.** Simple — one source of truth, same code path the CLI uses. ~50ms per cell edit; rapid typing in a grid would feel laggy.
2. **Re-implement sub-slice B's accept-time logic in TypeScript inside the Electron main process.** Preserves latency. Doubles the implementation surface; field-level diff, RFC 7396 apply, atomic file writes, lock acquisition — all duplicated. Drift becomes inevitable. We already saw exactly this drift: sub-slice B shipped, the desktop didn't, surfaces diverged within a week.
3. **Make a shared Rust library, expose it to both surfaces via napi-rs.** One implementation, both surfaces. Native addon costs ~sub-ms per call (no spawn). napi-rs has GitHub Actions templates for per-platform prebuilds; the Electron app already bundles a per-platform `scratchmd` binary so the build pipeline is familiar.

Picked: option 3. The Rust core is the canonical source; both the CLI binary and the Electron main process consume it. The structural cost (new `napi/` cdylib crate, per-platform `.node` build matrix) is paid once and amortized across every future change to accept/reject/discard semantics. This is the model used by `next/swc`, `oxc`, Parcel's Rust plugins, and Sentry's CLI — there's well-trodden tooling.

**Stronger principle:** when domain logic needs to run both in a CLI and in an Electron main process, don't duplicate. Promote the logic to Rust, expose to Node via napi-rs. Slice H is the first application of this principle; it's likely not the last (e.g. validators, schema readers, folder-index queries all face the same temptation).

The slice is captured in the [Phase 4+5 status block](#phase-4--5--retire-dirty-branch-switch-to-accepted-patchesjson-merged-2026-05-19) as **Slice H**; the implementation spec lives in [Slice H — Shared Rust library + desktop migration](#slice-h--shared-rust-library--desktop-migration). At the time this decision was recorded, Slice F (init retires the dirty branch) was blocked on H — without H, the desktop would have lost its read/write surface on the day F landed. H.3 then unblocked F, and F.1–F.3 shipped on 2026-05-20 (see [slice F spec](2026-05-20-slice-f-spec.md)).

### Phase ordering (2026-05-19 reorder)

Original order was `1 → pull → reviewed-dirty → file_index → 5 → 6 → 7`. Reordered to put the two low-risk dead-code deletions first:

- **Old Phase 4 → new Phase 2** (stop building `file_index`): pure deletion; Phase 1 already dead-coded the reader. Biggest single-phase init perf win (~35s on Stripe).
- **Phase 3** (drop `reviewed-dirty` on init): unchanged position; also a pure deletion (~10–15s).
- **Old Phase 2 → new Phase 4** (pull stash/replay): the substantive rewrite. Now ships last among the pre-collapse phases, after Phases 2 and 3 have already shrunk the surface area it needs to reason about.

**Why:** users see init-time perf improvements faster; the riskier pull rewrite ships with less surrounding code in flight; Phase 5's prereq (the re-anchor routine in Phase 4) is unchanged. Dependencies: `4 → 5 → 6` and `7` blocked on observation window — all still satisfied. Phase 3 remains technically subsumable by Phase 5, but is worth shipping standalone for the early perf win unless Phase 5 lands very quickly after it.

### Review state in the single-worktree model (Phase 5)

29. **Per-connection `accepted-patches.json` is the source of truth for "approved, pending publish."** Collapsing to one worktree on `main` removes the structural distinction today's three-worktree model gives us between unreviewed and approved edits. Options considered: drop the distinction; use git stage; separate marker file; folder*index as authoritative; second local ref. Picked: store an accumulating RFC 7396 payload at `.scratch/connections/<conn>/accepted-patches.json` that is \_both* the local approved-state record AND the exact wire payload sent to `/upload-patch/init`.
30. **Patch file IS the wire format.** Publish becomes "read file → PUT → /commit" with no diff computation at upload time. Diff logic moves to accept time, where it matches the user's intent moment. Field-level accept naturally composes (merge keys into the entry). Pull re-anchors patches to the new HEAD via the same conflict semantics as the worktree replay — one routine, two inputs (working-tree patches + accepted patches).
31. **Phase 5 is the moment of replacement.** Until Phase 5 ships, `files upload` computes patches on the fly (Phase 1 behavior) so in-flight workspaces continue to work. At Phase 5, `files upload` switches to reading `accepted-patches.json`; CLI accept/reject/discard commands rewrite to mutate the file; `folder_index`'s `approvedChanges` / `unapprovedChanges` columns get a new compute (presence-in-patch-file + worktree-vs-`apply(snapshot, patch)` instead of the three-worktree comparison). Same columns, same SQL filters, new data source.
32. **Why this beats git stage.** Git stage stores file _snapshots_ in git's binary index and would require recomputing patches at publish time via `git diff --staged`. The patch file stores _deltas_ in JSON, IS the upload payload directly, and is trivially inspectable (`cat accepted-patches.json`). Field-level accept maps to merging keys into an entry rather than the more awkward `git add -p` hunk semantics.

### Field-level state and actions (clarified 2026-05-19 with PM)

33. **State is per-field, not per-file.** Each record field has three conceptual values: `published` (= value on `main`), `approved` (= value after applying the patch entry to `published`, if any), `local` (= value in the working file). A field is "unapproved" iff `local ≠ approved`. File-level state is the aggregation: published if every field's `local == published` AND no patch entry; approved-pending if every field's `local == approved` AND a patch entry exists; unreviewed otherwise. See [Review state → Field-level state model](#the-field-level-state-model) for the definitive write-up; this entry is just the rationale.
34. **Accept, reject, discard are three distinct one-step transitions.** Accept moves a field unapproved → approved (`patch[field] ← local`, working untouched). Reject moves unapproved → approved by restoring `local ← approved` (patch untouched). Discard moves any state → published (`local ← main`, remove field from patch). Reject and discard are NOT synonyms: reject is a no-op once approved, discard is the only way to undo an approval. Earlier drafts of the plan's action table had `reject` removing the entry and `discard` leaving it; both effects were swapped. Corrected in the same MR that ships sub-slice B (this entry records the swap so the diff is greppable).
35. **Today's hybrid `reject` UX splits.** Today's `run_reject` restores from `dirty` (approved state) when the file is unreviewed, AND today's `reject_field_in_folder` silently switches into discard semantics when the field is already approved. That "step back one regardless of state" UX gets retired: the new `reject` only undoes unapproved edits; clearing an approval requires `discard <path>` or the new `discard-field <field> <folder>`. Desktop call-sites that relied on the hybrid migrate as a follow-up MR. Adding `discard-field` was the minimal CLI surface needed to keep field-level workflow complete.
36. **Git analogy is load-bearing for review.** Published = `main`, approved = local-branch HEAD, local = working copy. Accept ≈ `git add -p` + immediate commit. Reject ≈ `git checkout HEAD -- <file>` for that line. Discard ≈ `git restore --source=main --staged --worktree` for that line. The analogy made the asymmetry between reject and discard obvious in PM review and is preserved in the plan for future readers.

### Testing & rollout

29. **Parity test + permanent smoke.** Parity catches divergence between the two publish paths during cutover; the permanent smoke catches integration drift forever. The parity test gets deleted in Phase 7; the smoke survives.
30. **Server first, no flag, caller-identity = version.** Simpler than feature flags. Server tracks which endpoint each desktop version calls; Phase 7 deletes the old when callers drop to zero for ≥7 days.
31. **Perf gate (Phase 7 prerequisite).** Path A's `getRepoStatus` exists in production for the web client but hasn't been benchmarked at Monorepo scale (135k files). Gate Phase 7 deletion on p95 within 2× today's `run-from-git` baseline.

### Phase 1 deviations from the original spec

Captured during implementation. Listed for traceability — none changed the goal, several changed the _how_.

| Plan said                                                        | Shipped                                                                                                            | Why                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop modal: single-step "compute diff → publish"              | Two-step: upload first, land on per-connection summary, user clicks Publish                                        | Explicit separation of "stage server-side" from "actually publish" matches the CLI's `upload`/`publish` split; gives users a checkpoint to review on web first.                            |
| Single-file publish path via `filterPath` (kept for back-compat) | `filterPath` prop dropped; per-file publish entry opens workspace-wide modal                                       | `files upload` always uploads everything accepted; "publish only this file" was never coherent with accept's all-or-nothing semantics.                                                     |
| Sequential per-connection publish                                | Parallel via `Promise.allSettled`                                                                                  | Server queue handles concurrency via BullMQ; cheap to fan out. Wall-clock improvement on multi-connector workspaces, plus per-connection failure isolation.                                |
| Keep IPC name `pushWorkspaceChanges` for back-compat             | Renamed to `uploadWorkspaceChanges`                                                                                | Function no longer "pushes" anything; rename matches the new mental model.                                                                                                                 |
| Aggregate diff: three colored badges                             | Single dimmed text line `0 added · 1 modified · 0 deleted`; zero counts filtered                                   | Visual feedback during dogfooding: three colored badges + per-connection cards + status badges stacked up to "skittles." Color reserved for state badges where it carries meaning.         |
| Modal title static `"Publish changes"`                           | Dynamic per mode: `Uploading changes` / `Ready to publish` / `Publishing changes` / `Published` / `Publish failed` | Static title was misleading during upload. One-line UX win, near-zero cost.                                                                                                                |
| "Review on web" closes the modal                                 | Opens `${webUrl}/workbook/${id}/review`, leaves modal open                                                         | Workbook is the canonical entity name in server URLs (workspace is desktop-only UI terminology). Don't-close: user might want to review then come back to publish without re-uploading.    |
| `gix status` for changed paths                                   | `read_git_tree` diff between local `refs/heads/dirty` and `refs/remotes/origin/main`                               | Pre-Phase-5, the accepted state lives in `dirty`, not the worktree — same diff, different ref pair. Worktree-based gix-status moves in Phase 5.                                            |
| "Wrap every mutating CLI op in `.scratch/lock`"                  | Lock infrastructure landed + wired into `upload` only                                                              | Other mutating ops still have implicit three-worktree serialization. Tracked as CLI follow-up C1.                                                                                          |
| Local refs untouched after publish                               | `refs/heads/main` advanced to match `refs/remotes/origin/main` after job success                                   | Without this, the next `upload` would diff against a stale local `main` and re-send already-published patches.                                                                             |
| Per-job polling acceptable                                       | Single shared poller (one bulk-status request per tick)                                                            | Naive per-job impl produced 429s when scaled to 5 connections × 2 jobs each. Single-poller is the right design regardless of rate-limit fix.                                               |
| Defer server-side rate-limit changes                             | `@SkipApiRateLimit` decorator + applied to all read-only polling endpoints in `JobController`                      | Desktop fix alone solved the immediate bug, but the underlying mismatch (CLI budget applied to UI polling) was the real footgun. Fixing broadly avoids re-surfacing on future polling UIs. |

## Phase 1 implementation notes

Reference material for what specifically shipped. Useful when chasing back through what each slice changed.

### Server slice (`dev-10144-mr1`, commit `d6f78f14`, 23 files / +1773 −3)

- `POST /cli/v1/workbooks/:id/upload-patch/init` + `/commit` controller in `server/src/cli/upload-patch.controller.ts`. Returns **503 `ServiceUnavailableException`** when the patch bucket is unconfigured.
- `ApplyPatchesService` + `ApplyPatchesJobHandler` (`server/src/publish-plan/apply-patches.service.ts`, `server/src/worker/jobs/job-definitions/apply-patches.job.ts`) — streams the GCS payload, applies RFC 7396 patches to dirty as one logical change. (Post-decoupling — see CLI slice — service returns `{ patchCount }`, no auto-publish enqueue.)
- `JobType.ApplyPatches` added; `BullEnqueuerService.enqueueApplyPatchesJob` mirrors `enqueuePublishFromGitJob`; metric maps extended.
- `ObjectStorageService.signPutUrlForPatchUpload(key, ttl)` + `streamObjectFromPatchUpload(key)`. Pinned to `Content-Type: application/json`.
- `validateRecordPath(path, dataFolders)` in `server/src/utils/path-validation.ts` — rejects empty / absolute / traversal / reserved-prefix / outside-folder paths. All-or-nothing across a batch.
- AuditLog row written on `/commit` (`eventType: 'publish'`).
- DTOs in `@spinner/shared-types/dto/upload-patch/upload-patch.dto.ts`. Rust CLI re-declares via serde.

**Tests:**

- `server/src/utils/__tests__/path-validation.spec.ts` — 9 cases.
- `server/src/publish-plan/__tests__/apply-patches.service.spec.ts` — 22 cases including all-or-nothing rejection, mixed batch, no-diff skip, and an explicit regression guard that the service no longer touches publish.
- `server/src/publish-plan/__tests__/apply-patches-vs-legacy-invariants.spec.ts` — hand-modeled baseline comparison.
- `server/src/publish-plan/__tests__/upload-patch.e2e.spec.ts` — gated on `DATABASE_URL`; runs against a real `PrismaClient` with seeded org/user/workbook/connector/data-folders; mocks ScratchGitService + ObjectStorageService + BullEnqueuerService at the boundary. Asserts `/upload-patch/commit` does NOT create a `PublishPlan` row.

### Infrastructure (terraform-applied in both envs on 2026-05-18)

Added to `terraform/modules/env/main.tf`:

- `google_storage_bucket.upload_patches` (`${gcp_project_id}-upload-patches`): private, uniform bucket-level access, **24h lifecycle delete**, CORS `origin=["*"], method=["PUT"], response_header=["Content-Type"]`.
- IAM: `roles/storage.objectAdmin` to `cloudrun-service-account` on the new bucket; signed URLs work because the SA already has `roles/iam.serviceAccountTokenCreator` on itself.
- `GCS_PATCH_UPLOAD_BUCKET` wired into all three Cloud Run services (api / cron / worker) in `services.tf`.
- Applied to `eu-test` and `eu-production`. `/upload-patch/init` returns 503 in both envs until PR 1 ships and the next deploy runs.

### CLI slice (`dev-10144-mr2`)

`scratchmd files upload` replaced in place — no `upload-v2` command, no flag gating. Three new modules plus a clean rewrite of `upload_single_repo`:

- **`scratch-git-2/src/cli/commands/files.rs`** — `run_upload` is async; per-connection it fetches origin, computes the diff between local `main` and local `dirty` (the user's accepted state), emits one RFC 7396 patch per data file, POSTs `/upload-patch/init`, PUTs to the presigned URL with `Content-Type: application/json`, POSTs `/commit`. Legacy local-merge-and-push code deleted (`upload_single_repo`, `apply_remote_changes_to_working_copy`, `read_local_publish_plan_map`, `strip_publish_plan_files`, `TreeCache`, `push_origin_dirty`).
- **`scratch-git-2/src/cli/commands/merge_patch.rs`** — shared RFC 7396 diff helper (~50 LOC + 9 unit tests). The server's `applyJsonMergePatch` is the apply side of the same contract; the two implementations are intentionally symmetric.
- **`scratch-git-2/src/cli/config/workspace_lock.rs`** — `.scratch/lock` file lock with PID-based stale reclaim. Acquired at the workspace level in `run_upload`. 3 unit tests cover acquire/release, contention detection, and stale-PID reclaim.
- **API client (`scratch-git-2/src/cli/api/mod.rs`)** — `upload_patch_init` / `upload_patch_put` / `upload_patch_commit` + wire types (`UploadPatchPayload`, `UploadPatchEntry`, `UploadPatchInitResponse`, `UploadPatchCommitResponse`, `StalenessWarning`).
- **Tests** — 3 new unit tests on `compute_upload_patches` (create / update / delete shapes, non-data path filtering, parse-error handling). Four obsolete tests removed alongside the code they covered. Full Rust suite: 211 tests pass.

### CLI/server decoupling (also on `dev-10144-mr2`)

Code review found that the first cut conflated `/upload-patch/commit` (apply patches) with publish enqueuing. Decoupled:

**Server:**

- `ApplyPatchesService.applyAndPublish` → `applyPatches`. Dropped `publishPlanBuildService` and `bullEnqueuerService` dependencies. Service applies patches to `dirty` and returns `{ patchCount }`.
- `ApplyPatchesJobHandler` simplified — payload is `{ uploadId, patchCount, processedCount }`, no more `pipelineId` / `publishJobId`.
- `ApplyPatchesJobDefinition['data']` drops `organizationId`.
- New CLI shim endpoints in `cli-workbook.controller.ts`: `POST /cli/v1/workbooks/:id/publish-v2/plan-job` and `/run-job`. Thin pass-throughs to `PublishPlanBuildService` + `BullEnqueuerService.enqueuePlanPipelineJob` / `enqueueRunPipelineJob`.

**CLI:**

- `FilesCommands::Upload` patches-only. Wall-time drops accordingly.
- New `FilesCommands::Publish` — runs `/publish-v2/plan-job` then `/publish-v2/run-job` per connection. Polls each. Fetches + advances local `refs/heads/main` after a successful run-job.

### Desktop slice (`dev-10144-mr3`)

`PublishChangesModal.tsx` rewritten end-to-end; CLI `files upload --json` extended; server gains `@SkipApiRateLimit` decorator.

**CLI extension:**

- `compute_upload_patches` tags each `ComputedUploadPatch` as `Create | Update | Delete`.
- `UploadResult` carries per-connection `connection_name`, separate `files_created`/`files_updated`/`files_deleted` counts + path lists, and structured `staleness_warning: Option<StalenessWarning>`.
- `print_upload_result` JSON output gains `connections: [...]` + top-level `stalenessWarning`. Previous `filesUploaded` / `uploadedPaths` keys removed.

**Desktop modal rewrite:**

- State machine: `approval → uploading → uploaded → publishing → complete | error`.
- Two-step UI: upload first (single IPC), land on `uploaded` mode showing per-connection diff summary, user explicitly clicks **Publish now** or **Review on web ↗**.
- Per-connection parallel publish via `Promise.allSettled`.
- Staleness banner consumes `stalenessWarning.newHead` — non-blocking, dismissible.
- Single shared poller behind `pendingWaitsRef: Map<string, (status) => void>`. ONE batched `/jobs/bulk-status` call per second.
- `~150 LOC` of dead helpers deleted (`triggerPublishFromGit`, `listLocalPublishPlans`, `deleteLocalPublishPlans`, `startPlanPublish`, `startPublishFromGit`, `startPublishAll`, etc).

**Server — `@SkipApiRateLimit` decorator (`server/src/rate-limiter/`):**

- New `@SkipApiRateLimit()` decorator in `api-rate-limit.decorator.ts`. Guard checks `API_RATE_LIMIT_SKIP_KEY` after kill-switch and unlimited-scope checks but before consuming points. Handler-level metadata first, then class-level.
- Applied to read-only polling endpoints in `JobController`: `POST /jobs/bulk-status`, `GET /jobs/workbook/:workbookId/active`, `GET /jobs/:jobId/progress`, `GET /jobs/:jobId/raw`, `GET /jobs/run/:runId`.
- 2 new guard tests cover handler-level and class-level skip; full suite 16 pass.

### End-to-end verification (2026-05-18, against localhost)

Drove the full CLI flow against `/tmp/scratchmd-profile-37373/Monorepo` (5 connectors, Affinity has a diff). Server log trace:

1. `UploadPatchController.init` — issued presigned URL (signed via impersonated `cloudrun-service-account`)
2. CLI PUT to GCS → 200
3. `UploadPatchController.commit` — enqueued `ApplyPatchesJob`
4. `ApplyPatchesJobHandler` — streamed payload from GCS, applied 1 patch to dirty
5. `ApplyPatchesService.applyPatches` — returned `{ patchCount: 1 }` (no auto-publish)
6. CLI polled job to completion; total wall time 3.1s for `upload`

Then `scratchmd --json files publish`:

7. `/publish-v2/plan-job` — `PublishPlanBuildService.createPipeline`
8. `/publish-v2/run-job` — `PublishRunService.runPipeline`
9. Affinity batch reported `"The Affinity connector is read-only. Updating list entries is not supported."` — expected for a read-only connector. The job _completed_ but the internal `failedCount` recorded the connector failure, rendered as a red badge in the desktop modal.

The plumbing is sound; 429s went away after polling consolidation + `@SkipApiRateLimit`.

## Review summary

| Review                      | Trigger               | Why                             | Runs | Status             | Findings                                                                                                   |
| --------------------------- | --------------------- | ------------------------------- | ---- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| CEO Review                  | `/plan-ceo-review`    | Scope & strategy                | 1    | CLEAR (HOLD_SCOPE) | mode: HOLD_SCOPE, 0 critical gaps, 9 decisions captured                                                    |
| Eng Review                  | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN)       | 18 issues found across Architecture/Code Quality/Tests/Performance, 0 critical gaps, 11 decisions captured |
| Design Review               | `/plan-design-review` | UI/UX gaps                      | 0    | —                  | —                                                                                                          |
| Adversarial / Outside Voice | `/codex`              | Independent 2nd opinion         | 0    | skipped            | Codex CLI not installed; user opted out                                                                    |

**UNRESOLVED:** 0
**VERDICT:** CEO + ENG CLEARED. Phase 1 shipped. Phase 2 scope clarified by 2026-05-19 audit (file_index; renumbered from old Phase 4 on 2026-05-19). Tasks artifact at `~/.gstack/projects/whalesync-spinner/tasks-eng-review-20260518-095015.jsonl`.
