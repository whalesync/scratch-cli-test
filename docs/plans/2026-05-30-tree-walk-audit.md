# Tree-walk & full-folder read audit — desktop + CLI hot paths

**Date:** 2026-05-30
**Author:** Curtis Fonger

## Problem

Several user-facing actions in the desktop app and CLI walk the entire
`refs/heads/main` tree (or load the full materialized worktree) when they only
need a single record or a small set of paths. On workspaces with tens of
thousands of records this turns sub-millisecond local work into a 1–2 second
spinner.

Triggering case: clicking **Approve** on a single field in the Needs review tab
takes ~1–2s on a workspace with HubSpot Contacts (~22k records) + Stripe
(~38k records), even though the on-disk work is a JSON read, a JSON write, and
one `accepted-patches.json` upsert.

## How to read this doc

Every call site is labeled:

- **Justified** — bulk read is intentional (full-scan command, multi-path
  reconciliation, etc.). No change recommended.
- **Needs improvement** — the surrounding code only consumes a known subset of
  what it reads. Narrow the read.

Findings are grouped by the helper they call so the fix patterns line up.

---

## 1. `review_ops::read_main_tree_for_entry_point` (single-record napi ops)

All five functions below are called from the desktop via napi for one record at
a time. Each one's downstream code only consumes `main_map.get(record_rel_path)`
— a single key lookup — but the helper reads every blob in the bare repo.

Fix pattern (per call site):

```rust
let main_map = read_main_tree_for_entry_point_filtered(
    &paths.bare_repo,
    |p| p == record_rel_path,
)?;
```

`read_main_tree_for_entry_point_filtered` already exists and is the documented
narrowing pattern (`git_local.rs:105-109`).

### 1.1 `accept_field` — `scratch-git-2/src/shared/review_ops.rs:1197`

**Status: Needs improvement.**

UI trigger: "Approve" button per field in the Needs review tab. Today's bug.

### 1.2 `reject_field` — `scratch-git-2/src/shared/review_ops.rs:1287`

**Status: Needs improvement.**

UI trigger: per-field "Reject" — reverts an unreviewed edit back to the approved
value.

### 1.3 `discard_field` — `scratch-git-2/src/shared/review_ops.rs:1363`

**Status: Needs improvement.**

UI trigger: per-field undo on an already-approved field.

### 1.4 `restore_deleted_record` — `scratch-git-2/src/shared/review_ops.rs:1511`

**Status: Needs improvement.**

UI trigger: "Revert" from publish history when the record is currently in an
approved-delete state.

### 1.5 `discard_created_record` — `scratch-git-2/src/shared/review_ops.rs:1559`

**Status: Needs improvement.**

UI trigger: discard a pending-create record from the Needs review tab.

---

## 2. CLI path-list / per-path ops (`cli::commands::files`)

These commands take an explicit list of paths (or a known small set derived from
gix::status) but read the full main tree + full materialized repo.

Fix pattern: filter `read_main_tree` to the path set and replace
`read_materialized_repo` with a narrower disk read over the affected folders.

### 2.1 `run_accept` — `files.rs:1515, 1517`

**Status: Needs improvement.**

CLI: `scratchmd files accept <paths>`. Desktop shells out to this for explicit
path lists. Walks the full tree even when `paths.len() == 1`.

### 2.2 `discard_paths_single_repo` — `files.rs:3683, 3686`

**Status: Needs improvement.**

Same pattern as 2.1 for the discard verb.

### 2.3 `detect_unreviewed_fast` — `files.rs:2938`

**Status: Needs improvement.**

Called from `run_unreviewed`, which the desktop spawns every time the
pre-publish modal opens. `gix::status` already produces a small `ambiguous` list
of byte-flagged paths, then we read the entire main tree just to disambiguate
them. Narrow `read_main_tree` to the `ambiguous` set.

### 2.4 `restore_deleted_records_locally` — `files.rs:2659`

**Status: Needs improvement.**

Takes an explicit path list; reads the whole tree.

### 2.5 `discard_created_records_locally` — `files.rs:2700`

**Status: Needs improvement.**

Same pattern as 2.4.

---

## 3. CLI folder-scoped field ops

The `*-all --folder` commands already use `read_folder_scoped_maps`
(`files.rs:3105`) per commit `797b4707`. The three single-field folder
variants still use the unfiltered helpers.

Fix: refactor each to use `read_folder_scoped_maps`.

### 3.1 `run_accept_field` — `files.rs:1822, 1824`

**Status: Needs improvement.**

### 3.2 `run_reject_field` — `files.rs:1916, 1918`

**Status: Needs improvement.**

### 3.3 `run_discard_field` — `files.rs:2006, 2008`

**Status: Needs improvement.**

---

## 4. Validators

### 4.1 `validators::validate_records` — `validators/mod.rs:545`

**Status: Needs improvement.**

`validate_records` accepts an optional `selected_paths` filter for partial
revalidation (single-record edits in the desktop, single-path CLI ops). The
filter is honoured by the per-record work loop, but `main_files` is still
populated with the full `refs/heads/main` tree.

Fix: when `selected_paths.is_some()`, pass a predicate to `read_tree_files`
that keeps only those paths.

Every CLI accept / reject / discard ends with
`refresh_problem_record_index_for_ctx` (`files.rs:386`) which feeds
`selected_paths` through, so every per-record review op pays this cost.

---

## 5. Justified bulk reads (no change)

Documented here so they stay off future audits.

### 5.1 `accept_all_full_scan` — `files.rs:3754`

**Status: Justified.**

Workspace-wide accept-all. Full main tree + full materialized repo is the
intended scope.

### 5.2 `reject_all_full_scan` — `files.rs:3824`

**Status: Justified.** Same as 5.1 for reject.

### 5.3 `discard_all_full_scan` — `files.rs:3596`

**Status: Justified.** Same as 5.1 for discard.

### 5.4 `validators::run_validations` (full rebuild) — `validators/mod.rs:212`

**Status: Justified.**

When `is_full_rebuild == true` and `selected_paths.is_none()`, every record's
published value is needed. (The partial-refresh case is finding 4.1.)

### 5.5 `download_single_repo` — `files.rs:3273`

**Status: Justified.**

Reads main tree before and after the download to reconcile
`accepted-patches.json` against the new main. Both reads inherently span every
path the server might have advanced.

### 5.6 `reconcile_accepted_after_publish` — `files.rs:3170`

**Status: Justified (borderline).**

Re-anchors every entry in `accepted-patches.json` against the post-fetch main.
Technically narrowable to `paths-in-patch-file`, but: (a) this only runs after
a publish, which is already slow; (b) the patch file typically has at most
tens of entries, so the narrowing buys little in absolute terms; (c) reading
the full tree is symmetric with what the publish flow already did on the way
in. Revisit only if a workspace shows a patch-file → tree-size disparity
that makes this measurable.

### 5.7 `accept_field_in_folder` / `reject_field_in_folder` / `discard_field_in_folder` (folder-scoped helpers)

**Status: Justified.**

`review_ops.rs:510, 582, 646`. These are the inner helpers — they operate over
`(main_map, local_map)` that the caller provides. Whether the caller passes a
filtered or unfiltered map is a property of the caller (see findings 3.1–3.3).

---

## 6. Frontend amplifiers (different bug class, same family)

Not tree walks, but they compound the cost of every approve / reject / discard
because they fire after the IPC returns and re-query data the optimistic UI
update has already reflected. Tracked here so we don't claim "approve is fast
now" while the post-action UI still grinds.

### 6.1 Full folder grid refetch after per-field change

**Status: Needs improvement.**

`scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:1079-1089`

`onRecordFieldChanged` (line 3099-3102) calls `onDataRefresh()`, which bumps
`dataRefreshKey` on `WorkspacePage`. That re-fires `loadDiffData('refreshing',
q)` for the entire folder. The grid's optimistic update via
`applyAcceptedCellChange` (line 3100) already shows the correct state.

Fix: drop the `onDataRefresh()` call from the per-field-change path, or split
the parent's refresh signal into "record changed" (re-fetch nothing — UI
already in sync) and "structural change" (re-fetch grid).

### 6.2 Full-workspace validation stats refetch after per-field change

**Status: Needs improvement.**

`scratch-desktop/src/renderer/src/pages/WorkspacePage.tsx:150`,
`scratch-desktop/src/renderer/src/hooks/use-validation.ts:155-162`.

`useValidation(localPath, dataRefreshKey)` re-fires `getValidationConfigs` and
`getValidationStats` whenever `dataRefreshKey` changes. These shell out to
scratchmd across every connection in the workspace.

Fix: same as 6.1 — stop bumping `dataRefreshKey` for per-field changes.

### 6.3 Per-record validation refetch

**Status: Justified.**

`RecordDetailView.tsx:395-412` re-runs `getValidationResults` for the open
record when `validationReloadKey` changes. Scope is one record; cost is small;
the result can genuinely change after an approve. Keep.

---

## Vocabulary & renaming

Many of the call sites flagged above use terse, type-redundant, or
historically-scarred identifiers that make the code hard to read in isolation.
Before (or alongside) landing the perf fixes, these should be renamed to
maximum-self-documenting forms. The principle: a reader looking at one call
site, with no surrounding context, should be able to tell what is stored or
what the function does from the name alone.

### Variable renames (the two `FileMap` carriers)

These two variables flow through nearly every function in §1–§3 and §5. They
are the single biggest source of "what is this?" confusion in the codebase.

| Current | Proposed |
|---|---|
| `main_map` | `file_path_to_contents_map_in_main_branch` |
| `local_map` | `file_path_to_contents_map_in_local_folder` |
| `approved_map` | `file_path_to_contents_map_for_approved_state` |
| `master_blobs` (folder_index) | `file_name_to_contents_map_in_main_branch_for_folder` |
| `main_files` (validators) | `file_path_to_contents_map_in_main_branch` |
| `patched_by_path` | `accepted_patch_entry_by_record_path` |
| `ambiguous` (detect_unreviewed_fast) | `record_paths_with_byte_differences_against_main` |

Reads as English at the call site:

```rust
let file_path_to_contents_map_in_main_branch =
    read_main_branch_contents_filtered_by_path(&paths.bare_repo, |p| p == record_rel_path)?;
let approved_object_at_path_if_any =
    approved_object_for_path(&file_path_to_contents_map_in_main_branch, &accepted_patches, record_rel_path)?;
```

### Function renames

#### `scratch-git-2/src/shared/review_ops.rs`

| Current | Proposed |
|---|---|
| `read_main_tree_for_entry_point` | `read_main_branch_contents` |
| `read_main_tree_for_entry_point_filtered` | `read_main_branch_contents_filtered_by_path` |
| `read_materialized_repo` | `read_worktree_files_and_scratch_state` |
| `read_dirty_disk` | `read_files_recursively_into_path_contents_map` |
| `read_scratch_disk` | (same — internal mirror for the `.scratch/` walk; could merge with above) |
| `reject_field` | `revert_field_edit_to_approved_value` |
| `discard_field` | `drop_approved_field_and_restore_to_main_value` |
| `accept_field` | `accept_field_edit_into_patch_file` (optional — current name is OK on its own) |
| `restore_deleted_record` | `restore_record_from_main_after_dropping_delete_patch` |
| `discard_created_record` | `drop_create_patch_and_delete_working_file` |

The `reject_field` / `discard_field` distinction is the most worth renaming —
the current names can't be told apart without reading REVIEW_MODEL.md, and
they show up in the desktop's IPC surface (`rejectCellChange`,
`undoApprovedCellChange`).

#### `scratch-git-2/src/cli/commands/files.rs`

| Current | Proposed |
|---|---|
| `read_main_tree` | `read_main_branch_contents` |
| `read_main_tree_filtered` | `read_main_branch_contents_filtered_by_path` |
| `read_folder_scoped_maps` | `read_main_local_and_approved_maps_scoped_to_folder` |
| `read_materialized_repo` (CLI alias) | `read_worktree_files_and_scratch_state` |
| `detect_unreviewed_fast` | `list_unreviewed_record_paths_using_index_status_compare` |
| `discard_paths_single_repo` | `discard_record_paths_in_connection_repo` |
| `accept_all_single_repo` | `accept_all_unreviewed_changes_in_connection_repo` |
| `accept_all_full_scan` | `accept_all_unreviewed_changes_by_scanning_connection_repo` |
| `reject_all_single_repo` / `reject_all_full_scan` | mirror the `accept_all` pair |
| `discard_all_single_repo` / `discard_all_full_scan` | mirror the `accept_all` pair |
| `restore_deleted_records_locally` | `restore_deleted_record_paths_from_main_branch` |
| `discard_created_records_locally` | `discard_created_record_paths_from_patch_file` |
| `refresh_problem_record_index_for_ctx` | `revalidate_paths_for_connection_context` |
| `unpushed_entries` / `unpublished_entries` | clarify whether they're paths or entries (they return `Vec<UnreviewedEntry>`) |

The `_single_repo` / `_full_scan` / `_locally` suffixes carry no useful
information from the caller's perspective and should be retired entirely or
replaced with text that describes the actual scope.

#### `scratch-desktop/src/renderer/src/pages/workspace/`

| Current | Proposed |
|---|---|
| `applyAcceptedCellChange` (grid) | `applyAcceptedFieldChangeToFolderDiffData` |
| `applyAcceptedFieldChangeToRecord` (record view) | `applyAcceptedFieldChangeToOpenRecordData` |
| `onRecordChanged` | `onRecordStructurallyChangedRefetchAll` |
| `onRecordFieldChanged` | `onSingleFieldAcceptedApplyOptimistically` |
| `onDataRefresh` | `invalidateWorkspaceLevelData` |
| `dataRefreshKey` | `workspaceLevelDataInvalidationCounter` |
| `validationReloadKey` | `openRecordValidationReloadCounter` |
| `handleAcceptCellChange` | `handleApproveFieldClick` |
| `handleRejectUnreviewedCellChange` | `handleRejectUnreviewedFieldClick` |
| `handleUndoApprovedCellChange` | `handleUndoApprovedFieldClick` |
| `acceptCellChange` (IPC) | `acceptUnreviewedFieldEdit` |
| `acceptCellInputText` (IPC) | `acceptFieldEditFromInputText` |
| `rejectCellChange` (IPC) | `revertUnreviewedFieldEditToApproved` |
| `undoApprovedCellChange` (IPC) | `dropApprovedFieldAndRestoreToMain` |

The "Cell" / "Field" terminology split — grid views use "cell" (spreadsheet
metaphor), record views use "field" (record metaphor) — is the single biggest
source of paired-name confusion. Standardising on "field" everywhere is
recommended; the grid IS a record table, the cells ARE fields.

### Internal locals worth tightening

Apply the same principle to the inner workings of the §1 functions. Examples
from `review_ops::accept_field`:

| Current | Proposed |
|---|---|
| `paths` (ConnectionPaths) | `connection_directory_paths` |
| `working_path` | `working_file_path_on_disk` |
| `working_bytes` | `working_file_contents_bytes` |
| `working_obj` | `working_file_parsed_json_object` |
| `local_value` | `field_value_in_working_file` |
| `approved_value` | `field_value_in_approved_state` |
| `approved_obj_opt` | `approved_object_at_path_if_any` |
| `next_approved` | `approved_object_after_applying_field_edit` |
| `main_parsed` | `record_parsed_from_main_branch_if_any` |
| `next_approved_value` | `approved_object_after_apply_or_none_if_empty_with_no_main` |

### Implementation note

The rename pass is mechanical — no behaviour change — but it touches a lot of
files. Easiest to:

1. Land it as its own PR (no perf changes, no behaviour changes), so the
   reviewer can confirm semantics by name-only.
2. Then land the perf fixes against the renamed code, where the
   `read_main_branch_contents_filtered_by_path` callsite makes the
   improvement self-evident.

This sequencing also means the audit's "Tier 1" fix can be reviewed against
self-documenting code rather than the current tersely-named version.

## Suggested implementation order

0. **Vocabulary & renaming pass** — mechanical, no behaviour change. Land
   first so every subsequent PR can be reviewed against self-documenting
   identifiers. Doing this last would mean re-reviewing every changed line.
1. **Section 1** (5 one-line changes in renamed `review_ops.rs`) + **Section
   6.1 / 6.2** (drop the redundant invalidation from the per-field path).
   Together they ship the per-field approve performance fix end-to-end.
2. **Section 4.1** — validators filter on partial revalidations.
3. **Section 3** — refactor 3 functions onto
   `read_main_local_and_approved_maps_scoped_to_folder`.
4. **Section 2** — narrower path-list reads in the CLI.
