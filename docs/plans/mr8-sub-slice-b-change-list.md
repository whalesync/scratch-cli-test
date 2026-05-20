# Sub-slice B change-list (DEV-10144)

Working notes for the next session. Not durable documentation — once B
ships, this gets folded into the main plan's deviation log if anything
moved.

## Progress (as of 2026-05-19)

On branch `dev-10144-mr13` off `master`. (mr11: steps 1–4. mr12: step 5. mr13: steps 6–12.)

| Step | Status | Notes |
| ---- | ------ | ----- |
| 1. `layout::connection_root_path` | ✅ committed (mr11) | + tests for both `for_cli` and `for_service` layouts |
| 2. `compute_accepted_state` + `apply_patch_entry_to_blob` | ✅ committed (mr11) | 10 unit tests; `compute_unreviewed_entries` switched to `json_content_differs` so synthesized approved bytes vs worktree-written bytes don't false-positive on whitespace drift |
| 3. `discard_field_in_folder` | ✅ committed (mr11) | 7 unit tests; new `PatchAction` enum + `patch_object_mentions_field` helper |
| 4. `run_accept` / `run_reject` / `run_discard` + `discard_paths_single_repo` | ✅ committed (mr11, WIP) | Three new shared helpers landed alongside: `read_main_tree`, `parse_json_value_at`, `write_or_remove_working_file`. Two existing tests fixed up: `discard_paths_single_repo_reverts_only_listed_paths` and `..._with_only_approved_change` now seed `accepted-patches.json` via new test helper `seed_accepted_patches_from_fixture`. `cargo test --bin scratchmd`: 266 passes. |
| 5. `accept_field` / `reject_field` rewrite + new `run_discard_field` | ✅ committed (mr12 HEAD, WIP) | `FieldCommandResult.dirty_changed` renamed to `patches_changed`. New `field_paths_in_folder` + `approved_object_for_path` shared helpers (consumed by all three field-level routines). `accept_field_in_folder` routes through `re_anchor::compute_entry` so Create/Update/Delete shape decisions reuse the same machinery as single-path accept. `reject_field_in_folder` is strict per decision 35 — no patch file writes, no master/dirty hybrid. New `DiscardField` clap variant; new `run_discard_field` command. Existing 7 module-level field tests deleted; 14 new tests added in a `field_helpers` submodule asserting on `AcceptedPatchesFile` shape (Update/Create kinds, patch content, `changed_paths`, `patches_changed`). Five `discard_field_helper` test sites updated for the rename. `cargo test`: 273 + 169 + 16 + 2 = 460 passes, 0 failures. |
| 6. `_all` variants + delete `_scoped_via_index` variants | ✅ committed (mr12) | `accept_all_full_scan` / `reject_all_full_scan` / `discard_all_full_scan` rewritten to operate on `(main, accepted-patches.json, working)`. `_single_repo` wrappers are now thin sync-schema + dispatch shells; the `_scoped_via_index` branch is gone. Existing 5 `_all` tests rewritten to call `seed_accepted_patches_from_fixture` before exercising and assert on `accepted-patches.json` shape instead of dirty-branch tree. `cargo test`: 273 + 169 + 16 + 2 = 460 passes. One dead-code warning for `scratch_only_map` (deleted in step 10). |
| 7. `restore_deleted_records_locally` / `discard_created_records_locally` | ✅ committed (mr13) | Both helpers now load `accepted-patches.json`, error if the entry isn't the expected `Delete` / `Create` kind, drop the entry + sync the worktree (write main blob / remove file), and save_atomic. Remote-cleanup hack (`discard_created_record_remotely`) untouched. Two-pass loop separates validation from mutation so a midway error doesn't leave half a state change on disk. 2 old tests rewritten + 2 new error-path tests added. `cargo test`: 275 passes. |
| 8. `upload_single_repo_via_patches` → read `accepted-patches.json` verbatim | ✅ committed (mr13) | Reads the file, translates `Vec<AnchoredPatch>` → `UploadPatchPayload` (drops `kind` — server infers from patch shape), PUT + commit + poll. Counts (created/updated/deleted) come from the kinds. `local_unreviewed` warning recomputed against `compute_accepted_state` (was previously against worktree-status). `run_publish` now calls `accepted_patches::clear` after the local `main` advance per connection. `compute_upload_patches` + the local `PatchKind` enum + `ComputedUploadPatch` are now dead — deleted in step 10. `cargo test`: 275 passes. |
| 9. Listing commands (`run_unreviewed` / `run_unpublished` / `run_unpushed`) | ✅ committed (mr13) | `unreviewed_entries` switches from `git status` against the dirty sparse checkout to `compute_unreviewed_entries(approved_map, local_map)`. `unpublished_entries` enumerates `accepted-patches.json` entries directly (status from kind). `unpushed_entries` collapses to a thin delegate to `unpublished_entries` — per change-list, "pushed" no longer means "on the local dirty branch." Leaves `worktree_status_entries` + `WorktreeStatusEntry` + `unreviewed_entries_from_status` dead (step 10). `cargo test`: 275 passes. |
| 10. Delete dead code (`compute_upload_patches`, local `PatchKind`, `update_dirty_worktree_index`, `_scoped_via_index` helpers) | ✅ committed (mr13) | Deleted `compute_upload_patches` + local `PatchKind` + `ComputedUploadPatch` + `parse_json_value` (~80 LOC), `scratch_only_map` (10 LOC), `worktree_status_entries` + `WorktreeStatusEntry` (60 LOC) + the re-export, and 3 module-level `compute_upload_patches_*` tests. Removed `#![allow(dead_code)]` from `accepted_patches.rs` (one targeted attr on the unused-for-now `remove_field` helper stays). `update_dirty_worktree_index` + `commit_file_map_to_dirty_ref` stay — `download_single_repo` and `force_upload_single_repo` still need them; slice D/F cleanup. Final `cargo build`: zero warnings. |
| 11. Test sweep across `tests/` and module tests | ✅ committed (mr13) | Module tests updated alongside each step (5-9). `tests/cli/` is an integration smoke loop that calls `files accept-all` + `files upload` — those still work since the user-facing CLI surface is preserved. No other test files reference the rewritten internals. |
| 12. `cargo fmt` + `yarn lint-strict` in `server/` (no-op expected) | ✅ committed (mr13) | `cargo fmt` touched 2 files (whitespace); `yarn lint-strict` in `server/` clean (no cross-cutting type changes — pure CLI work as predicted). |
| 13. Manual dogfood | ⏳ pending user | All 12 prior steps shipped; sub-slice B is mechanically complete. Driver hand-off: clone a fresh workspace, exercise accept / accept-field / accept-all / reject / discard / discard-field / restore-deleted-record / discard-created-record / upload / publish through the CLI and verify `.scratch/connections/<conn>/accepted-patches.json` looks right at each step. Confirm desktop UI still drives accept/reject/discard correctly. |

### Where step 12 leaves the codebase

All `accepted-patches.json` rewrites for sub-slice B are in. Production
code paths for single-path / field / `_all` / record-level commands +
`files upload` + the three listing commands all read and write the JSON
file. `compute_upload_patches`, the local `PatchKind`, the
`_scoped_via_index` helpers, `worktree_status_entries`, and
`scratch_only_map` are deleted. `cargo build` is warning-free; 459
tests green. CLI help text matches the new model.

Still on the `dirty` branch and explicitly deferred to slice D / F:
- `download_single_repo` (pull path) — slice D's stash/replay rewrite.
- `force_upload_single_repo` (force-upload escape hatch) — slice F.
- `commit_file_map_to_dirty_ref` + `update_dirty_worktree_index` —
  retire alongside their callers above.

Sub-slice B is mechanically complete pending dogfood (step 13). No
known regressions; all module tests pass.

### Per-field upsert algorithm (for step 5)

When `accept-field` moves a single field from unapproved → approved, the
cleanest path is to:

1. Read the file's current approved object: `approved_map[path]` (parsed
   to `JsonMap`). If absent, start with empty.
2. Read the file's current local object from `local_map[path]` (parsed).
3. `next_approved = clone(approved); apply_nested_json_value(&mut
   next_approved, field, local_value);`
4. Compute the new entry via
   `re_anchor::compute_entry(path, main_parsed.as_ref(),
   Some(JsonValue::Object(next_approved)).as_ref())` (or `None` if
   next_approved emptied AND main is absent).
5. `match (existing_pos, new_entry)`: replace / insert / remove the
   entry in the file.

This reuses `compute_entry` semantics so the Create-vs-Update-vs-Delete
decision falls out of the same machinery used by single-path accept. The
test for `accept_field_in_folder_accepts_modified_and_created_rows_but_ignores_deleted_rows`
needs updating to assert on `AcceptedPatchesFile` contents instead of the
returned FileMap.

For `reject-field`, the new logic is much simpler than today's hybrid:
`local[field] ← approved[field]`. No `master_map` argument. Returns
`(FileMap, FieldCommandResult)` (just next_local_map + result). The
hybrid's branch 2 (already-approved → roll dirty back to master)
disappears — see decision 35 in the main plan.

For `run_discard_field`, just call `discard_field_in_folder` (already
landed in step 3) + `save_atomic` + `apply_changed_working_files`.

### Test-helper momentum

`seed_accepted_patches_from_fixture` (added in step 4 at
`scratch-git-2/src/cli/commands/tests/files.rs`) translates the legacy
fixture's `dirty != main` state into an equivalent
`accepted-patches.json` file. **Reuse this helper from step 5 onward** —
every test that today relies on `create_multi_folder_fixture`'s baked-in
"approved delta" can call it before invoking the function under test.
The helper currently uses `merge_patch::diff`; that function stays alive
through B regardless (re_anchor depends on it).

## State model recap (target after B)

Pre-Phase-5: worktree stays at `ctx.dirty_dir` (sparse on `refs/heads/dirty`).
We stop _writing_ `refs/heads/dirty`. Accepted state moves to
`accepted-patches.json` at `<workspace>/.scratch/connections/<conn>/accepted-patches.json`.

For a given path:

- **published** = `refs/heads/main` blob content
- **approved** = `apply_patch_entry_to_blob(published, accepted_patches[path])`,
  or `published` if no entry. For `kind: "delete"` entries: approved = "file is gone."
  For `kind: "create"`: approved = `patch` (full content). For `kind: "update"`:
  approved = `apply(published, patch)`.
- **local** (= working) = `ctx.dirty_dir.join(path)` bytes.

A path is **unapproved** iff `local != approved`. A path is
**approved-pending-publish** iff it has an entry in `accepted-patches.json`.

## Path resolution

`shared/layout.rs` already gives us `connection_scratch_path(name)` →
`scratch_root/connections/scratch/<name>/`. The plan calls for
`<workspace>/.scratch/connections/<name>/accepted-patches.json` (no `/scratch/`).

**Decision:** add a sibling helper `connection_root_path(name)` →
`scratch_root/connections/<name>/` and use it as the `connection_dir`
argument to `accepted_patches::{load, save_atomic, clear, path}`. Keep
`connection_scratch_path` alone — it's where schema files live and is
called from many places (workspaces.rs, files.rs).

The `accepted_patches::path()` helper is already
`connection_dir.join(FILENAME)`, so it works as-is. We just need the right
`connection_dir`.

Add a `accepted_patches_dir: PathBuf` field to `ConnectionContext` or call
`layout.connection_root_path(conn_dir_name)` inline. **Pick inline** — fewer
plumbing changes, easier to grep later.

## New shared helpers (live alongside compute_unreviewed_entries near files.rs:4034)

### `compute_accepted_state(main_map: &FileMap, file: &AcceptedPatchesFile) -> FileMap`

Replaces today's `base_map = dirty_tree` everywhere it shows up. Algorithm:

```
out = clone(main_map)                  // start from published
for entry in file.patches:
    match entry.kind:
        Create | Update => out[path] = apply_patch_entry_to_blob(main_map.get(path), entry)
        Delete          => out.remove(path)
return out
```

`out` is keyed by string path → `Vec<u8>` JSON bytes. Same shape as `FileMap`.

### `apply_patch_entry_to_blob(main_blob: Option<&[u8]>, entry: &AnchoredPatch) -> Option<Vec<u8>>`

Per-file apply. Returns `None` when the entry says "delete" or when the
result is conceptually a missing file. Returns `Some(json_bytes)` when
the result is the approved blob bytes.

```
match entry.kind:
    Create =>
        // patch is the full content
        Some(serde_json::to_vec_pretty(&entry.patch)?)
    Update =>
        let base = match main_blob:
            Some(bytes) => serde_json::from_slice(bytes)?
            None        => JsonValue::Null     // pathological — log + treat as Create
        let merged = merge_patch::apply(&base, &entry.patch)
        Some(serde_json::to_vec_pretty(&merged)?)
    Delete =>
        None
```

Two pyrotechnics worth handling carefully:

- Serialization format. Today, dirty blobs were written by us so we know
  the JSON formatter shape. The accepted-state synthesis must produce
  bytes that are byte-equal to what _the user's working file would
  contain_ after the same change — otherwise `local != approved`
  comparisons spuriously trip. Use `serde_json::to_vec_pretty` to match
  how the desktop UI writes worktree files. If we find byte-mismatch in
  testing, normalize via `parse(local) == parse(approved)` instead of
  byte comparison.

- A `kind: "update"` with `main_blob = None` shouldn't happen (re-anchor
  converts it to a Create at pull time). If it does at runtime, treat as
  Create + log an internal error — don't silently produce malformed
  output.

### `compute_unreviewed_entries(...)` stays as-is — `compute_accepted_state` produces a `FileMap` and feeds the existing diff helper.

## Command-by-command rewrite

For each command, the pattern is:

1. Read `main_map` from `refs/heads/main` (replacing today's `base_map` read of `refs/heads/dirty`).
2. Load `accepted_patches::load(&connection_dir)`.
3. Build `approved_map = compute_accepted_state(&main_map, &file)`.
4. Read working from `ctx.dirty_dir` (unchanged).
5. Compute "unreviewed" = `compute_unreviewed_entries(&approved_map, &local_map)`.
6. Mutate `file` in-memory.
7. `save_atomic(&connection_dir, &file)` instead of `commit_file_map_to_dirty_ref` + `update_dirty_worktree_index`.

Detailed per command:

### `run_accept` (files.rs:1143)

Today: for each input path, set `accepted_map[path] = local_map[path]`
(or remove if local missing), then commit to `refs/heads/dirty`.

After:

- For each path: compute `entry = re_anchor::compute_entry(path, snapshot=main_map[path], working=local_map[path])`.
- `accepted_patches::upsert_entry(&mut file, entry)` (or `remove_entry` if `entry` is `None` — accept of a no-op is a no-op, but we still need to check there WAS an unreviewed change to bail with the existing error).
- `save_atomic`.

Validation step (`changed_paths` must contain the requested path) stays
but uses the new unreviewed set: `compute_unreviewed_entries(&approved_map, &local_map)`.

Remove: `commit_file_map_to_dirty_ref`, `update_dirty_worktree_index`,
`sync_schema_files_from_master` for accept (still needed for reject —
keeps `.scratch/schema.json` files in the working tree fresh; deferable).

### `run_reject` (files.rs:1261)

Today: write `dirty[path]` bytes into the working file (or remove if
dirty missing).

After:

- For each path: working ← `approved[path]` (= `apply_patch_entry_to_blob(main[path], file.get_entry(path))`).
- No mutation to `accepted-patches.json` — the entry stays.
- Per decision 35: **reject is a no-op once the field is already approved.** Today's hybrid that also rolls dirty back to master goes away — that's `discard` now.

Implementation: write `approved[path]` to `ctx.dirty_dir.join(path)`,
or `remove_file` if `approved` says missing (delete entry).

### `run_discard` (files.rs:1361)

Today: replaces dirty entry with main's version on disk AND in dirty
branch. `discard_paths_single_repo` does the work.

After:

- For each path: `accepted_patches::remove_entry(&mut file, path)`.
- Working ← `main[path]` (= published), or remove if `main` doesn't have it.
- `save_atomic`.

Rewrite `discard_paths_single_repo` (files.rs:2993) to operate against
`(main_map, accepted_patches_file, local_map)` and write
`accepted-patches.json` + working files. The `skipped_missing_main` flag
stays (returns when `refs/heads/main` is unset).

### `run_accept_all` (files.rs:1068) + `accept_all_single_repo` + `accept_all_full_scan` + `accept_all_scoped_via_index`

Today: build a new accepted_map (folder-scoped or full) and commit.

After (full scan version — drop the index variant for now or keep as
optimization):

```
file = accepted_patches::load(&connection_dir)?
approved_map = compute_accepted_state(&main_map, &file)
unreviewed = compute_unreviewed_entries(&conn_name, &approved_map, &local_map)
            .filter(in_scope)
for entry in unreviewed:
    let patch_entry = re_anchor::compute_entry(&entry.path, main_map.get(&entry.path).map(...), local_map.get(&entry.path).map(...));
    match patch_entry {
        Some(e) => accepted_patches::upsert_entry(&mut file, e),
        None    => accepted_patches::remove_entry(&mut file, &entry.path), // shouldn't normally happen if unreviewed
    }
save_atomic
return accepted_paths = unreviewed.paths
```

`accept_all_scoped_via_index` (files.rs:3303): the index optimization
(`folder_index::select_files_with_approved_changes` + cross-check) was
load-bearing for perf on large folders. Slice E formally swaps the
column compute. For B, the simplest correct rewrite is to **stop using
the scoped_via_index path** (delete it + the `_scoped_via_index` variants
for accept/reject/discard) and route everything through the full-scan
version. After Phase 5/E, we can reintroduce an index-aware version.

The full-scan path on a 110k-file connection: ~210ms gix-status warm
plus an in-memory FileMap diff — well under the user-perceptible
threshold for the common case where only a handful of files are dirty.
The risk is the unscoped `accept-all` across the whole connection
loading every file into a FileMap, but today's code already does that.

**Decision:** B deletes the three `_scoped_via_index` variants
unconditionally. If E shows the perf is needed, reintroduce then.

### `run_reject_all` (files.rs:993) + `reject_all_single_repo` + `reject_all_full_scan`

Today: write working from dirty for each unreviewed path. No git commit.

After: write working from `approved_map[path]` for each unreviewed path.
No accepted-patches mutation. Delete `reject_all_scoped_via_index`.

### `run_discard_all` (files.rs:911) + `discard_all_single_repo` + `discard_all_full_scan`

Today: rebuild dirty as main + commit + write working from main.

After:

- For each in-scope path that is either unreviewed OR has a patch entry: remove the entry, write working from `main[path]` (or remove if missing).
- `save_atomic`.
- Delete `discard_all_scoped_via_index`.

The `skipped_missing_main` flag stays; without `refs/heads/main` we
can't compute the published target.

### `run_accept_field` (files.rs:1455) + `accept_field_in_folder` (files.rs:3509)

Today: for each file in folder, if `local[field] != base[field]`, set
`next_dirty[file][field] = local[field]`. One commit.

After: for each file in folder, compute the field's current `approved`
value (from `apply_patch_entry_to_blob(main[file], file.get_entry(file))`
then read field). If `local[field] != approved[field]`, that field is
unapproved. Update the accepted-patches entry for the file:

- If the file has no entry: create one. If `main[file]` exists, `kind: "update"` with `patch = { field: local[field] }`. If `main[file]` is absent (locally created file), `kind: "create"` with `patch = local_object_with_only_field` (mirror the existing behavior).
- If the file has an existing entry: merge `field` into its patch object (for update kind) or merge into create's content. Use a small helper.

Working file is **untouched** (this matches both today's accept_field
and the new state model).

### `run_reject_field` (files.rs:1536) + `reject_field_in_folder` (files.rs:3558)

Today: hybrid. Branch 1: if `local[field] != base[field]`, restore
working `local[field] ← base[field]`. Branch 2: if working already
matches dirty AND dirty differs from main, ALSO restore both `local`
and `dirty` to `master[field]` (= discard).

After (decision 35): **branch 2 disappears.** Only branch 1 logic:

- For each file in folder where `local[field] != approved[field]`:
  - working `local[field] ← approved[field]`
- Accepted-patches file untouched.

### NEW: `run_discard_field` (decision 34 / 35 — folder-scoped discard for one field)

CLI surface: `scratchmd files discard-field <field> <folder>`.

For each file in folder:

- `local[field] ← published[field]` (= main blob's field; if main missing → remove field from working)
- If the file's accepted-patches entry has `field` as a top-level key, drop it from the patch object. If the patch object empties, remove the entire entry. Use `accepted_patches::remove_field(&mut file, path, field)`.
- Special handling for `kind: "create"`: the patch is a full object, not a merge patch. `remove_field` no-ops there per the IO module. We need the special path: if the create's content has the field, strip it. If the resulting create has no fields left, drop the entry AND remove the working file (since main has nothing for it either). Open question: do we want `discard-field` to be able to delete a created-only file by removing its last field? **Decision:** yes — matches the rule that discard moves to published, and published for a never-published-create is "file doesn't exist." Add an explicit handler in `discard_field_in_folder` for create entries (it's the only kind where field-level discard can lifecycle out the whole file).

This is the new module-level helper `discard_field_in_folder` to write
alongside the existing `accept_field_in_folder` / `reject_field_in_folder`.

Wire `Cli::FilesCommands::DiscardField` enum variant + clap arg, mirror
of `RejectField` and `AcceptField`.

### `run_restore_deleted_record` (files.rs:1635) + `restore_deleted_records_locally` (files.rs:2107)

Today: bails if path exists on dirty (= it's not a "deleted" record).
Bails if path doesn't exist on main. Otherwise writes main content to
worktree + adds back to dirty branch.

After: bails if `accepted_patches::get_entry(&file, path)` is not a
`Delete` entry (= not a "deleted record"). Bails if `main[path]` is
missing. Otherwise: `accepted_patches::remove_entry(&mut file, path)`,
write `main[path]` to working file, `save_atomic`.

### `run_discard_created_record` (files.rs:1696) + `discard_created_records_locally` (files.rs:2153)

Today: bails if path exists on main (= not a "created" record). Bails
if path doesn't exist on dirty. Otherwise removes working file + drops
from dirty branch. Also calls server's `/discard-remote-dirty-changes`
for the remote-cleanup hack.

After: bails if accepted entry isn't `Create`. Bails if `main[path]`
exists. Otherwise: `accepted_patches::remove_entry`, delete working
file, `save_atomic`. The remote-cleanup hack
(`discard_created_record_remotely`) stays untouched per decision 32 /
the comment at files.rs:2207.

### `upload_single_repo_via_patches` (files.rs:2484) — slice C

Today: fetch origin → read main + dirty trees → `compute_upload_patches`
→ PUT + commit + poll.

After: fetch origin → load `accepted-patches.json` → if empty, return
`no_changes` → translate `Vec<AnchoredPatch>` to `UploadPatchPayload`
verbatim → PUT + commit + poll → on success, `accepted_patches::clear`.

The `local_unreviewed` warning logic stays (still useful — checks
working differs from approved).

Delete `compute_upload_patches` (and the local `PatchKind` enum at
files.rs:2700 — use `re_anchor::PatchKind`).

### Listing commands — slice G (separable from B, can ship same MR or follow-up)

#### `run_unreviewed` (files.rs:1772) + `unreviewed_entries` (files.rs:3400) + `unreviewed_entries_from_status` (files.rs:3404)

Today: `git status --porcelain`-style scan of the dirty worktree.

After: compute `approved_map` (as above) and diff against the worktree
to find paths where `local != approved`. Or — to keep `gix status` perf
— continue to use worktree status, but interpret it differently:

- `working differs from dirty branch HEAD` no longer means "unreviewed"
  (because the dirty branch is stale once we stop writing it).
- Reasonable interim: full FileMap scan. Worst case ~hundreds of ms on
  the Stripe worktree — same order of magnitude as today's git-status
  call. If we need the index optimization, slice E delivers it formally.

#### `run_unpublished` (files.rs:1815) + `unpublished_entries` (files.rs:3429)

Today: diff `refs/heads/dirty` tree against `refs/heads/main` tree.

After: enumerate `accepted-patches.json` entries. One `UnreviewedEntry`
per patch entry, status from `kind` (create=added, update=modified,
delete=deleted).

#### `run_unpushed` (files.rs:1858) + `unpushed_entries` (files.rs:1901)

Today: diff between local `main` and local `dirty`.

After: same as `unpublished` (= contents of `accepted-patches.json`)
since "pushed" no longer means "on the local dirty branch." The two
commands could collapse — but keep both for back-compat and let G
formally decide.

## Helpers to delete (B body)

- `compute_upload_patches` (files.rs:2655) — replaced by direct payload assembly from `accepted-patches.json`.
- Local `PatchKind` enum (files.rs:2699) + `ComputedUploadPatch` struct (files.rs:2706).
- `discard_all_scoped_via_index` (files.rs:2860).
- `accept_all_scoped_via_index` (files.rs:3303).
- `reject_all_scoped_via_index` (files.rs:3238).
- `update_dirty_worktree_index` (files.rs:2329) — only called from accept/reject/discard paths we're rewriting. Caller-list:
  - download_single_repo (line 2449) — STAYS for now, gets removed in slice D (download rewrite).
  - run_accept (1228), run_accept_field (1507) — removed.
  - accept_all_full_scan (3174), accept_all_scoped_via_index (3392) — removed.
  - discard_all_full_scan (2840), discard_all_scoped_via_index (2968), discard_paths_single_repo (3068) — removed.
  - reject_field_in_folder caller at 1602 — removed (branch 2 disappears).
  - restore_deleted_records_locally (2149), discard_created_records_locally (2197) — removed.
- `commit_file_map_to_dirty_ref` (files.rs:3483) — still called by `force_upload_single_repo` (3461) and `download_single_repo` (2366). STAYS for now, dies in slice F.

## Helpers to keep

- `sync_schema_files_from_master` — copies schema files from master worktree into `.scratch/`. Orthogonal to the dirty-branch rewrite.
- `read_materialized_repo` — reads the worktree into a `FileMap`. Still needed.
- `refresh_problem_record_index_for_ctx` — folder-index refresh hook. Slice E adjusts what it considers "changed"; B leaves it called from the same callsites.
- `reindex_folder_index_for_changes` — same.
- `apply_changed_working_files` — small disk-write helper for the field commands. Still used by `run_reject_field`.

## CLI surface changes (clap)

In `src/cli/main.rs` (or wherever `FilesCommands` is defined), add:

```
DiscardField {
    #[arg(value_name = "FIELD")]
    field: String,
    #[arg(value_name = "FOLDER")]
    folder: PathBuf,
    #[arg(long)]
    json: bool,
},
```

Mirror of `RejectField`. Route to `run_discard_field`.

## Test coverage to add inside B

Unit tests near the new helpers:

- `compute_accepted_state`: empty file → returns main_map; create entry → main_map + new path; update entry → main_map with patched blob; delete entry → main_map minus path; multiple entries.
- `apply_patch_entry_to_blob`: each of the three kinds; missing main_blob for update.
- `discard_field_in_folder`: field on update entry → strips key; field on create entry → strips key; field on create that empties → drops entry AND removes working file; field on delete → no-op.

Command-level smoke tests (e.g. via `assert_cmd` + tempdir) — TBD,
mostly relying on existing tests that exercise the same surface. Each
existing test that today asserts dirty-branch state needs updating to
assert `accepted-patches.json` state instead. Expect ~20 test sites in
`tests/`.

## Migration concern

Workspaces initialized pre-B with a populated `refs/heads/dirty` and no
`accepted-patches.json` will silently lose their pending changes on
first run after B. **Curtis 2026-05-19: not a concern** — small user
base, none with significant pending local work. No bootstrap helper,
no compatibility gate. `compute_upload_patches` gets deleted alongside
the rest of the legacy logic in step 11.

## Commit shape

Per the plan, B is atomic. Suggested commit message:

```
[scratchmd] switch accept/reject/discard to accepted-patches.json (DEV-10144)

Phase 4+5 sub-slice B: retire refs/heads/dirty as the source of truth
for accepted-but-not-published edits. Accept, reject, discard, and
their field-/all-/record-level variants now mutate
.scratch/connections/<conn>/accepted-patches.json and leave the dirty
branch alone.

- New shared helpers compute_accepted_state, apply_patch_entry_to_blob,
  discard_field_in_folder.
- New CLI command files discard-field <field> <folder>.
- Existing scoped-via-index optimizations removed; full-scan path
  remains. Slice E will reintroduce index awareness.
- One-shot migration: when no accepted-patches.json exists but dirty
  differs from main, bootstrap by diffing dirty vs main before
  proceeding. Removes the manual re-init step for in-progress
  workspaces. Cleared in slice F.
- run_unreviewed / run_unpublished / run_unpushed switched to derive
  state from (main, accepted-patches.json, working).
- upload_single_repo_via_patches now reads accepted-patches.json
  verbatim; clears it on successful publish.

Replaces ~600 LOC of three-worktree comparison logic with the JSON-file
state machine. The worktree (ctx.dirty_dir) is unchanged; phase 5
slice F collapses it to a non-sparse main worktree.
```

(Match the existing commit style — short subject, body explains the
"why" — see git log for recent prior DEV-10144 commits.)

## Order of edits (mechanical)

1. Add `layout::connection_root_path`.
2. Add `compute_accepted_state` + `apply_patch_entry_to_blob` + unit tests.
3. Add `discard_field_in_folder` + unit tests.
4. Rewrite `run_accept` + `run_reject` + `run_discard` (single-path).
5. Rewrite `run_accept_field` + `run_reject_field` + new `run_discard_field`.
6. Rewrite `run_accept_all` + `run_reject_all` + `run_discard_all`. Delete the three `_scoped_via_index` variants.
7. Rewrite `run_restore_deleted_record` + `run_discard_created_record` (local helpers only; remote helper untouched).
8. Switch `upload_single_repo_via_patches` to read accepted-patches.json verbatim (slice C bundled into B per the plan's "B is atomic").
9. Rewrite listing commands (slice G bundled).
10. Delete `compute_upload_patches`, local `PatchKind`, `ComputedUploadPatch`, `update_dirty_worktree_index`. Verify no stragglers via `cargo build`.
11. Update tests in `tests/` and module `__tests__`. Run `cargo test --bin scratchmd` to green.
12. `cargo fmt`. `yarn lint-strict` in `server/` if any cross-cutting types changed (they shouldn't — pure CLI work).
13. Manual dogfood: spin up a test workspace, drive accept / reject / discard / accept-field / publish through the CLI, confirm `accepted-patches.json` looks right at each step.
