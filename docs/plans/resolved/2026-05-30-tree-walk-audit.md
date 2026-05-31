# Tree-walk & full-folder read audit — desktop + CLI hot paths

**Date:** 2026-05-30
**Author:** Curtis Fonger

## Implementation status (updated 2026-05-30)

| Slice | Status | Landed in |
|---|---|---|
| §0 Vocabulary & renaming pass (Rust) | ✅ Shipped | `cfonger-81` commit `7b2a675a` |
| §0 Vocabulary & renaming pass (desktop TS) | ✅ Shipped | `cfonger-83` commit `4d7117f0` |
| §1 Single-record napi ops (per-field Approve perf fix) | ✅ Shipped | `cfonger-84` |
| §2 CLI path-list / per-path ops | ✅ Shipped | `cfonger-84` |
| §3 CLI folder-scoped field ops | ✅ Shipped | `cfonger-84` |
| §4 Validators partial-revalidation filter | ✅ Shipped | `cfonger-84` |
| §5.1 / §5.2 / §5.3 Bulk all-ops (re-classified — see note) | ✅ Shipped | `cfonger-84` |
| §6.1 / §6.2 Frontend amplifier fixes | ✅ Shipped (per-field accept paths) | `cfonger-84` |

> **Re-classification note (2026-05-30):** §5.1 / §5.2 / §5.3
> (`{accept,reject,discard}_all_unreviewed_changes_in_connection_repo`)
> were originally marked Justified. On follow-up review they were
> re-classified as Needs improvement: the unreviewed set is bounded by
> `gix::status ∪ accepted-patches.json`, not the whole tree. See §5.1
> for the full reasoning.

**Renames intentionally not applied:**
- `paths` local (audit §"Internal locals") — used as a parameter name across
  many functions, not just §1. Skipped as too-broad-for-value.
- Broader "Cell → Field standardize everywhere" recommendation — grid-library
  adapter methods (`onCellClicked`, `getCellContent`, etc.) retained their
  `Cell` naming to match the underlying library API. Only the audit's
  explicitly-enumerated identifiers were renamed.

**Non-rename cleanup completed:**
- `.publish-plans` exception removal in
  `load_connection_scratch_into_path_contents_map` — shipped in `cfonger-85`
  commit `8f658c73` as part of Phase 7 deletion of the server-side
  `POST /:id/publish-v2/run-from-git` endpoint. No remaining `.publish-plans`
  references in `review_ops.rs`.

**Verification at landing:**
- Rust: `cargo check --workspace --all-targets` + `cargo fmt` + `cargo test`
  (336 passing).
- Desktop: `yarn build` + `yarn lint-strict` + `yarn test` (174 passing).

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

## 1. `review_ops::read_main_branch_contents` (single-record napi ops)

All five functions below are called from the desktop via napi for one record at
a time. Each one's downstream code only consumes `file_path_to_contents_map_in_main_branch.get(record_rel_path)`
— a single key lookup — but the helper reads every blob in the bare repo.

Fix pattern (per call site):

```rust
let file_path_to_contents_map_in_main_branch = read_main_branch_contents_filtered_by_path(
    &paths.bare_repo,
    |p| p == record_rel_path,
)?;
```

`read_main_branch_contents_filtered_by_path` already exists and is the documented
narrowing pattern (`git_local.rs:105-109`).

### 1.1 `accept_field` — `scratch-git-2/src/shared/review_ops.rs:1197`

**Status: Needs improvement.**

UI trigger: "Approve" button per field in the Needs review tab. Today's bug.

### 1.2 `revert_field_edit_to_approved_value` — `scratch-git-2/src/shared/review_ops.rs:1287`

**Status: Needs improvement.**

UI trigger: per-field "Reject" — reverts an unreviewed edit back to the approved
value.

### 1.3 `drop_approved_field_and_restore_to_main_value` — `scratch-git-2/src/shared/review_ops.rs:1363`

**Status: Needs improvement.**

UI trigger: per-field undo on an already-approved field.

### 1.4 `restore_record_from_main_after_dropping_delete_patch` — `scratch-git-2/src/shared/review_ops.rs:1511`

**Status: Needs improvement.**

UI trigger: "Revert" from publish history when the record is currently in an
approved-delete state.

### 1.5 `drop_create_patch_and_delete_working_file` — `scratch-git-2/src/shared/review_ops.rs:1559`

**Status: Needs improvement.**

UI trigger: discard a pending-create record from the Needs review tab.

---

## 2. CLI path-list / per-path ops (`cli::commands::files`)

These commands take an explicit list of paths (or a known small set derived from
gix::status) but read the full main tree + full materialized repo.

Fix pattern: filter `read_main_branch_contents` to the path set and replace
`read_worktree_files_and_scratch_state` with a narrower disk read over the affected folders.

### 2.1 `run_accept` — `files.rs:1515, 1517`

**Status: Needs improvement.**

CLI: `scratchmd files accept <paths>`. Desktop shells out to this for explicit
path lists. Walks the full tree even when `paths.len() == 1`.

### 2.2 `discard_record_paths_in_connection_repo` — `files.rs:3683, 3686`

**Status: Needs improvement.**

Same pattern as 2.1 for the discard verb.

### 2.3 `list_unreviewed_entries_using_gix_status_then_disambiguate_against_main` — `files.rs:2938`

**Status: Needs improvement.**

Called from `run_unreviewed`, which the desktop spawns every time the
pre-publish modal opens. `gix::status` already produces a small `gix_status_flagged_record_paths_and_status` list
of byte-flagged paths, then we read the entire main tree just to disambiguate
them. Narrow `read_main_branch_contents` to the `gix_status_flagged_record_paths_and_status` set.

### 2.4 `restore_deleted_record_paths_from_main_branch` — `files.rs:2659`

**Status: Needs improvement.**

Takes an explicit path list; reads the whole tree.

### 2.5 `drop_create_patches_and_delete_working_files_for_record_paths` — `files.rs:2700`

**Status: Needs improvement.**

Same pattern as 2.4.

---

## 3. CLI folder-scoped field ops

The `*-all --folder` commands already use `read_main_local_and_approved_maps_scoped_to_folder`
(`files.rs:3105`) per commit `797b4707`. The three single-field folder
variants still use the unfiltered helpers.

**Original fix:** refactor each to use
`read_main_local_and_approved_maps_scoped_to_folder` (folder-scoped maps).

**Tighter fix (per §5.1 re-classification):** the candidate set isn't every
record in the folder — it's `gix-status-flagged-in-folder ∪
patch-file-entries-in-folder`. For a 22k-record folder where 5 are dirty
and 3 have patch entries, the folder-scoped variant reads 22k blobs; the
gix-status-scoped variant reads 8. Same pattern as §5.1–§5.3.

The folder-scoped fix is still a real improvement over today's
workspace-wide read; the gix-status-scoped fix is a further improvement on
top. Either one is reviewable in isolation. If sequencing matters, ship the
folder-scoped version first (smaller diff, easier to validate against the
existing `*-all --folder` helper) and the gix-status-scoped version with
§5.1–§5.3.

§5.7 (the `_in_folder` inner helpers in `review_ops.rs`) is map-agnostic —
it iterates whatever the caller passes. The narrowing lives here.

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
filter is honoured by the per-record work loop, but `file_path_to_contents_map_in_main_branch` is still
populated with the full `refs/heads/main` tree.

Fix: when `selected_paths.is_some()`, pass a predicate to `read_tree_files`
that keeps only those paths.

Every CLI accept / reject / discard ends with
`revalidate_paths_for_connection_context` (`files.rs:386`) which feeds
`selected_paths` through, so every per-record review op pays this cost.

---

## 5. Bulk reads (mostly justified)

Documented here so they stay off future audits — except §5.1–§5.3, which
were re-classified after a follow-up review (see note at the head of each).

### 5.1 `accept_all_unreviewed_changes_in_connection_repo` — `files.rs:3754`

**Status: ~~Justified~~ → Needs improvement.** (re-classified)

The original entry framed this as workspace-wide accept-all = workspace-wide
read. That conflates the user-facing operation's scope with the set of
paths the function actually mutates. accept-all only writes patch entries
for the **unreviewed** subset, which is bounded by:

- `gix::status(worktree)` — paths where worktree bytes differ from the git
  index (and HEAD == main, so this is "differ from main"). Empty on a
  clean repo; small on an active edit session.
- Paths in `accepted-patches.json` — also small.

Everything else has worktree == main == approved → already at published,
nothing to do. So the candidate set is `gix-status ∪ patch-file`, and the
function only needs to read `main_at_path` + `working_at_path` for those
paths (via `read_main_branch_contents_filtered_by_path` + direct disk
reads), not the entire tree.

Both inputs to the union matter:
- A path with a patch entry but no gix-status flag means the user manually
  reverted to main. accept-all should drop the entry. Without iterating the
  patch file, this state would be missed.
- A path with a gix-status flag but no patch entry is a new edit. accept-all
  should create a Create/Update entry. Without iterating gix-status, this
  is missed.

This is the same primitive `list_unreviewed_entries_using_gix_status_then_disambiguate_against_main`
already uses for §2.3's "any unreviewed?" check, extended to also iterate
patch-file paths.

(Historical context: the comment at `files.rs:3573–3576` mentions a pre-B
`_scoped_via_index` fast path that was removed. That one queried
`folder_index`'s SQLite columns, which had reliability issues. The
gix-status approach uses the git index directly, which is always accurate
— different primitive, different reliability profile.)

### 5.2 `reject_all_unreviewed_changes_in_connection_repo` — `files.rs:3824`

**Status: ~~Justified~~ → Needs improvement.** (re-classified) Same
candidate set as §5.1. reject-all writes the worktree back to approved for
each unreviewed path, so it needs `approved_at_path` + writes to the
working file — both bounded to the candidate set.

### 5.3 `discard_all_unreviewed_changes_in_connection_repo` — `files.rs:3596`

**Status: ~~Justified~~ → Needs improvement.** (re-classified) Same
candidate set as §5.1. discard-all writes the worktree back to main + drops
patch entries, bounded to the candidate set.

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
`(file_path_to_contents_map_in_main_branch, file_path_to_contents_map_in_worktree)` that the caller provides. Whether the caller passes a
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

`onSingleFieldAcceptedApplyOptimistically` (line 3099-3102) calls `invalidateWorkspaceLevelData()`, which bumps
`workspaceLevelDataInvalidationCounter` on `WorkspacePage`. That re-fires `loadDiffData('refreshing',
q)` for the entire folder. The grid's optimistic update via
`applyAcceptedFieldChangeToFolderDiffData` (line 3100) already shows the correct state.

Fix: drop the `invalidateWorkspaceLevelData()` call from the per-field-change path, or split
the parent's refresh signal into "record changed" (re-fetch nothing — UI
already in sync) and "structural change" (re-fetch grid).

### 6.2 Full-workspace validation stats refetch after per-field change

**Status: Needs improvement.**

`scratch-desktop/src/renderer/src/pages/WorkspacePage.tsx:150`,
`scratch-desktop/src/renderer/src/hooks/use-validation.ts:155-162`.

`useValidation(localPath, workspaceLevelDataInvalidationCounter)` re-fires `getValidationConfigs` and
`getValidationStats` whenever `workspaceLevelDataInvalidationCounter` changes. These shell out to
scratchmd across every connection in the workspace.

Fix: same as 6.1 — stop bumping `workspaceLevelDataInvalidationCounter` for per-field changes.

### 6.3 Per-record validation refetch

**Status: Justified.**

`RecordDetailView.tsx:395-412` re-runs `getValidationResults` for the open
record when `openRecordValidationReloadCounter` changes. Scope is one record; cost is small;
the result can genuinely change after an approve. Keep.

---

## Rename pass: design decisions worth recording

The rename pass landed in two PRs (Rust: `cfonger-81/7b2a675a`; desktop:
`cfonger-83/4d7117f0`). The mechanical was→is mapping lives in those
commits' diffs and isn't reproduced here. A few non-obvious design calls
*are* recorded below.

### Why `local_map` became `_in_worktree`, not `_in_local_folder`

The variable held worktree contents read from disk (via
`load_worktree_into_path_contents_map`). "worktree" is the term the
surrounding helpers already use (`worktree_dir`, `is_data_path_in_folder`)
and avoids the ambiguity of "local folder" — the local repo's folder? *a*
folder?

### Why `ambiguous` became `gix_status_flagged_record_paths_and_status`

The variable is a `Vec<(String, &'static str)>` of paths flagged by
`gix::status` (index-vs-worktree iter), each paired with its status string
(`"modified" | "added" | "deleted"`). The name keeps the (path, status)
tuple shape visible and names the actual source (gix status), not the
conceptual goal (which is "needs further disambiguation against main +
patches" — that's what the surrounding loop does *with* this list).

### Why the `_full_scan` triples were inlined

The `_full_scan` suffix was a historical scar: there used to be a
`_scoped_via_index` fast-path companion that no longer exists (sub-slice B
decision). The only remaining distinction between `accept_all_single_repo`
and `accept_all_full_scan` was that the wrapper did
`sync_schema_files_from_worktree` first. The rename PR inlined the inner
into the wrapper, collapsing each pair into one truthful name:
`{accept,reject,discard}_all_unreviewed_changes_in_connection_repo`.

### Why `UnreviewedEntry` became the neutral `RecordChangeEntry`

The old type was used in three semantically different contexts that share
only the JSON shape `(connection_name, path, status)`:

| Caller | Semantic |
|---|---|
| `list_unreviewed_entries_using_gix_status_then_disambiguate_against_main` | Genuinely unreviewed — dirty bytes that haven't been accepted yet. |
| `list_unpublished_accepted_patch_entries` | **Accepted but not yet published** — entries from `accepted-patches.json`. |
| Diff helper + `blocked` lists | Path-level change records, semantically neutral. |

The name "Unreviewed" only fit one of the three. Calling the second use's
function "accepted patch entries as unreviewed entries" read as a
contradiction precisely because the type name was lying. The neutral
`RecordChangeEntry` lets each function returning `Vec<RecordChangeEntry>`
have a name that truthfully describes which kind of change it returns.

### Why the worktree-vs-scratch reads stayed split

`load_worktree_into_path_contents_map` and
`load_connection_scratch_into_path_contents_map` are NOT mergeable:
different ignore rules (only the scratch walk currently allows
`.publish-plans`), different key prefixes (worktree paths as-is vs
`.scratch/<rel>`), and called as two distinct passes by
`read_worktree_files_and_scratch_state`. Kept as a symmetric pair.

### Why the `reject_field` / `discard_field` rename was the highest-value

The names couldn't be told apart without reading REVIEW_MODEL.md, and they
surfaced into the desktop's IPC layer as `rejectCellChange` /
`undoApprovedCellChange`. They're now `revert_field_edit_to_approved_value`
and `drop_approved_field_and_restore_to_main_value` in Rust, and the
contextBridge surface is `revertUnreviewedFieldEditToApproved` /
`dropApprovedFieldAndRestoreToMain` — three layers of self-describing names
where before there were three layers of "wait, which one again?"

## Suggested implementation order

0. ✅ **Vocabulary & renaming pass** — shipped as two PRs (`cfonger-81` for
   Rust, `cfonger-83` for desktop TS). See "Implementation status" at the
   top of this doc for landing details.
1. ✅ **Section 1** (5 one-line changes in renamed `review_ops.rs`) + **Section
   6.1 / 6.2** (drop the redundant invalidation from the per-field accept paths).
   Together they ship the per-field approve performance fix end-to-end.
2. ✅ **Section 4.1** — validators filter on partial revalidations.
3. ✅ **Section 3** — refactored 3 functions onto
   `read_main_local_and_approved_maps_scoped_to_folder` (folder-scoped
   maps). The further gix-status-scoped tightening landed in §5.
4. ✅ **Section 2** — narrower path-list reads in the CLI. New helper
   `read_worktree_files_for_record_paths` reads just the requested
   worktree files instead of walking the whole worktree.
5. ✅ **Section 5.1 / 5.2 / 5.3** — bulk all-ops now build the candidate
   set with `collect_all_ops_candidate_record_paths`
   (`gix::status ∪ accepted-patches.json` entries, optionally folder-scoped),
   load just those bytes via
   `read_main_approved_worktree_maps_for_candidate_paths`, and drive
   accept/reject/discard from that bounded set. The folder-scoped branches
   that used to live alongside the full-repo branches collapsed into a
   single candidate-set flow.

## What didn't ship

The §6.1/§6.2 fix landed for the **accept** paths
(`acceptGridCellChange`, `acceptFieldEditFromInputText`, and the
`onSingleFieldAcceptedApplyOptimistically` wiring). The grid-side
**reject** and **undo-approved** handlers also lost their
`invalidateWorkspaceLevelData()` calls, since they're per-field operations
with no need to bump workspace-wide validation.

The RecordDetailView reject/undo handlers still call
`onRecordStructurallyChangedRefetchAll`, which fires
`invalidateWorkspaceLevelData()`. Splitting that callback into
"record-scoped per-field" vs "structural" is a real follow-up but is outside
the literal §6.1/§6.2 fix and was not enumerated in the audit.
