# Slice F — Init collapse to one non-sparse `main` worktree

**Date**: 2026-05-20
**Status**: **F.1 + F.2.a + F.2.b shipped 2026-05-20.** F.3 (cleanup) + F.4 (perf measurement) not started.
**Parent plan**: [`2026-05-17-simplify-local-workspace-architecture.md`](2026-05-17-simplify-local-workspace-architecture.md) — see [Phase 5](2026-05-17-simplify-local-workspace-architecture.md#phase-5--collapse-to-one-worktree-per-connection) for the design spec.
**Author**: Curtis Fonger

## Contents

- [Why this slice exists](#why-this-slice-exists)
- [Scope](#scope)
- [Target on-disk layout](#target-on-disk-layout)
- [What gets deleted vs. retargeted vs. kept](#what-gets-deleted-vs-retargeted-vs-kept)
- [Migration of in-flight workspaces](#migration-of-in-flight-workspaces)
- [Schema cache decision](#schema-cache-decision)
- [Sub-slice sequencing (F.1–F.4)](#sub-slice-sequencing-f1-f4)
- [Test strategy](#test-strategy)
- [Open decisions](#open-decisions)
- [Risks](#risks)
- [Done when](#done-when)

## Why this slice exists

Today's init creates **two** worktrees per connection:

1. `<workspace>/<connector>/` — sparse-checkout of `refs/heads/dirty`, excludes `.scratch/`. This is what the user edits.
2. `<workspace>/.scratch/connections/master/<connector>/` — sparse-checkout of `refs/heads/main`, includes `.scratch/**/schema.json`. Source for `sync_schema_files_from_master_checkout`.

(A third worktree — `.scratch/connections/dirty/<connector>/` — was deleted in Phase 3.)

Post-Slice-H, no live surface in either the CLI or the desktop writes to `refs/heads/dirty` from local actions. The user-facing worktree being on `dirty` is now load-bearing for **nothing** — it's just where files happen to live. The `master` worktree exists only to seed the schema cache.

Slice F collapses both worktrees into one non-sparse `main` worktree:

```
<workspace>/<connector>/   ← non-sparse worktree of refs/heads/main
  .git                     ← gitlink → ../.repos/<id>.git
  .scratch/                ← schemas from main (was synced from the master worktree)
  Companies/<rec>.json     ← user-editable record files
  ...
```

This is the original goal of the parent plan. It deletes the sparse-checkout config, deletes the `master` worktree entirely, and finishes retiring the local `dirty` branch as the source of truth for accepted state.

## Scope

In scope:

- New workspaces: init creates one non-sparse `main` worktree per connection at `<workspace>/<connector>/`. No `master` worktree, no sparse-checkout config, no `include_schemas_in_sparse_checkout` call.
- `sync_schema_files_from_master` retargets: source is now `<workspace>/<connector>/.scratch/` (the new worktree's tracked schema dir). Destination is unchanged (`<workspace>/.scratch/connections/scratch/<connector>/`) for now — see [schema cache decision](#schema-cache-decision).
- `teardown_connection` / `detach_connection` stop referencing `master_worktree_path` and `reviewed_dirty_checkout_path` (the latter is already a back-compat cleanup-only call after Phase 3).
- Existing workspaces: detect the old layout on any CLI op and refuse with a structured "your workspace needs re-init" message. (See [migration](#migration-of-in-flight-workspaces) for why we don't auto-migrate.)
- `WorkspaceLayout` API: `master_worktree_path` and `reviewed_dirty_checkout_path` removed once all callers are gone. `dirty_checkout_path` renamed to `worktree_path` — the worktree isn't dirty anymore.
- `ConnectionContext` (in `cli/commands/files.rs`): `master_dir` field removed; `dirty_dir` renamed to `worktree_dir`. The thin wrappers in `files.rs` (~10 fns adapting `ConnectionContext` → `ConnectionPaths`) update accordingly.
- `DIRTY_BRANCH` constant deleted from `workspaces.rs`. Any remaining callers of `setup_sparse_worktree` against the dirty branch get rerouted or deleted.

Out of scope:

- Repointing schema readers (`validators`, `plan_publish`, `index`, etc.) to read directly from the new worktree's `.scratch/` instead of the `<workspace>/.scratch/connections/scratch/<conn>/` cache. **Required post-F cleanup** — see [schema cache decision](#schema-cache-decision) and [post-F follow-ups](#post-f-follow-ups).
- Server-side `dirty` branch removal. The server still uses `refs/heads/dirty` as its publish working area; that's a separate server change.
- Phase 6 (parallelizing connection setup). F leaves the loop sequential; 6 fans out once each connection is cheap enough to overlap.

## Target on-disk layout

```
<workspace>/
  HubSpot/                                       ← non-sparse worktree of refs/heads/main
    .git                                         ← gitlink → ../.repos/<id>.git
    .scratch/                                    ← schemas tracked in main
      Companies/schema.json
      ...
    Companies/rec_123.json                       ← user-editable
    Contacts/rec_456.json
    ...
  Stripe/                                        ← same shape, separate repo
    ...
  .repos/
    <hubspot-repo-id>.git/                       ← bare repo (unchanged)
    <hubspot-repo-id>.db                         ← SQLite per-folder tables (unchanged)
    ...
  .scratch/
    workspace.yaml                               ← workspace marker (unchanged)
    conflicts.log                                ← from slice D (unchanged)
    connections/
      HubSpot/
        accepted-patches.json                    ← from slices A/B (unchanged)
      scratch/
        HubSpot/                                 ← schema cache; populated from <workspace>/HubSpot/.scratch (was: from master worktree)
          Companies/schema.json
          ...
```

What disappears vs. today:

- `<workspace>/.scratch/connections/master/<connector>/` — the master worktree directory and the git worktree entry that referenced it.
- `<workspace>/.scratch/connections/dirty/<connector>/` — the reviewed-dirty worktree (already gone post-Phase-3; F removes the back-compat cleanup-only references).
- Sparse-checkout config inside `<workspace>/<connector>/.git/info/sparse-checkout`.
- The `dirty` ref in `<workspace>/.repos/<id>.git/refs/heads/`. The local-clone bare repo has no further use for it; the server-side `dirty` branch is unaffected.

What stays:

- One bare repo + one SQLite file per connection in `<workspace>/.repos/`.
- `<workspace>/.scratch/workspace.yaml`, `.scratch/conflicts.log`, `.scratch/connections/<conn>/accepted-patches.json`.
- `<workspace>/.scratch/connections/scratch/<conn>/` — the schema cache. Its source changes (from the master worktree → from the main worktree's tracked `.scratch/`), but the cache itself stays so we don't have to migrate every schema reader in this slice.

## What gets deleted vs. retargeted vs. kept

| Symbol / call site | Action | Notes |
| --- | --- | --- |
| `materialize_dirty_checkout` (`workspaces.rs:511`) | Delete | Replaced by a single non-sparse `git worktree add <worktree> main` call. |
| `include_schemas_in_sparse_checkout` (`workspaces.rs:525`) | Delete | Non-sparse worktree includes schemas natively. |
| `git_checkout_branch_from_bare` against `MAIN_BRANCH` into `master_dir` (`workspaces.rs:715`) | Delete | The master worktree goes away. |
| `sync_schema_files_from_master_checkout` (`workspaces.rs:547`) | Delete | The init-time copy from the master worktree to the schema cache. The runtime `sync_schema_files_from_master` in `review_ops` is *retargeted*, not deleted — see below. |
| `setup_sparse_worktree` (`git_ops`) | Delete | Only `materialize_dirty_checkout` + `git_checkout_branch_from_bare` call it. Both go. |
| `git_checkout_branch_from_bare` (`workspaces.rs:503`) | Delete | Only called for the master worktree. New code uses a direct `git worktree add` shell-out. |
| `DIRTY_BRANCH` constant (`workspaces.rs:11`) | Delete | No CLI surface references the local `dirty` ref after F. |
| `WorkspaceLayout::master_worktree_path` (`layout.rs:87`) | Delete | All callers go away in F. |
| `WorkspaceLayout::reviewed_dirty_checkout_path` (`layout.rs:94`) | Delete | The back-compat cleanup call sites in `teardown_connection` / `detach_connection` are also removed; the directory is gone from any workspace re-init'd under F, and old workspaces are forced to re-init (see [migration](#migration-of-in-flight-workspaces)). |
| `WorkspaceLayout::dirty_checkout_path` | **Rename** to `worktree_path` | Same path semantics (`<workspace>/<connector>/`), accurate name. |
| `ConnectionContext::dirty_dir` field (`files.rs:185`) | **Rename** to `worktree_dir` | All ~50 call sites updated. Path semantics unchanged. |
| `ConnectionContext::master_dir` field (`files.rs:188`) | Delete | `review_ops::sync_schema_files_from_master` retargets to use `worktree_dir.join(".scratch")` as its source. |
| `review_ops::sync_schema_files_from_master` (`review_ops.rs:910`) | **Retarget** | Source: `paths.worktree_dir.join(".scratch")` instead of `paths.master_dir.join(".scratch")`. Rename to `sync_schema_files_from_worktree`. |
| `ConnectionPaths::master_dir` field (`review_ops.rs`) | Delete | Tied to the same retarget. |
| `setup_connection` (`workspaces.rs:677`) | Rewrite | New flow: `git clone --bare` → `git worktree add --no-detach <worktree> main` → `reconcile_data_folder_dirs` → first-pass `sync_schema_files_from_worktree`. No second worktree, no sparse config. |
| `teardown_connection` (`workspaces.rs:747`) | Simplify | Drop `remove_path(&master_dir)` and `remove_path(&reviewed_dirty_dir)`. |
| `detach_connection` (`workspaces.rs:772`) | Simplify | Same as teardown. |

## Migration of in-flight workspaces

The parent plan flagged two options:

> - (a) Build a patch file from the existing `dirty`-vs-`master` diff before tearing down the worktrees, then re-clone as the new layout.
> - (b) Prompt the user to re-init, which loses any locally-accepted-but-unpublished edits. Acceptable if (a) is too much work; the user can publish first, then re-init.

This slice picks **option (b)** — refuse + prompt.

Reasoning:

- Population is ~2-5 desktop users today, all reachable (parent plan, [Phase 4+5 merger](2026-05-17-simplify-local-workspace-architecture.md#phase-45-merger-2026-05-19)).
- Post-Slice-B, accepted state already lives in `accepted-patches.json` for any edits made on a CLI/desktop version that includes B. The `dirty` branch only carries pre-B accepted-but-not-published edits. The user can `scratchmd files publish` to drain those, then re-init.
- Auto-migration code (option a) is a one-shot path: it runs once per workspace, then dies. Carrying it forever is debt; deleting it requires a follow-up.
- The escape hatch is already in the user's hands: `scratchmd files publish` drains the dirty branch; then re-init produces the new layout cleanly.

Detection mechanism: on any CLI op that touches a workspace, check for either:

- The presence of `<workspace>/.scratch/connections/master/<connector>/` for any connector, OR
- The presence of `.git/info/sparse-checkout` inside any `<workspace>/<connector>/`.

If either condition is true on a workspace marker present (`<workspace>/.scratch/workspace.yaml` exists), emit a structured error:

```json
{
  "status": "workspace_needs_reinit",
  "reason": "old_layout_pre_slice_f",
  "recommendation": "Run `scratchmd files publish` to drain any pending edits, then re-init the workspace."
}
```

Human output: `This workspace was initialized on an older layout. Run "scratchmd files publish" to drain any pending edits, then re-initialize. (Pre-Slice-F workspaces are no longer supported.)`. Exit code non-zero. The desktop's existing "workspace error" surface pattern-matches on `status` to render a user-friendly prompt.

This detection only fires on **read** ops (e.g. `files unreviewed`) and **mutating** ops (e.g. `accept`, `discard`, `upload`, `download`). `workspaces unsync` and `workspaces show` skip the check so the user can always tear down a stuck workspace.

## Schema cache decision

The `<workspace>/.scratch/connections/scratch/<connector>/` cache exists because the dirty worktree (sparse) excluded `.scratch/` from itself. The cache was the only way readers could find schemas.

Post-F, the worktree is non-sparse on `main`, so schemas live at `<workspace>/<connector>/.scratch/`. Two options:

- **(c) Keep the cache; retarget the source.** `sync_schema_files_from_worktree` copies from `<workspace>/<connector>/.scratch/schema.json` → `<workspace>/.scratch/connections/scratch/<connector>/schema.json`. All existing readers (validators, plan_publish, index, etc.) are unchanged.
- **(d) Drop the cache; repoint readers.** Update all callers of `WorkspaceLayout::connection_scratch_path` to read from the worktree's `.scratch/` directly instead. Simpler end state, but ~10 reader sites in `validators`, `plan_publish`, `cli/commands/validation.rs`, `shared/index.rs`.

**Pick (c) for F. (d) is a required post-F follow-up** — see [post-F follow-ups](#post-f-follow-ups). The cache copy is cheap (one shell-out's worth of file copies) and lets F land without touching every schema reader. The duplication is genuine debt, not an acceptable end state: the cache can drift if any code path mutates worktree schemas without calling `sync_schema_files_from_worktree`, and the per-folder per-call refresh is wasted work once readers can hit the worktree directly. Tracking it as a hard follow-up (not a "maybe") keeps the debt visible.

The retarget rename is mechanical: `sync_schema_files_from_master(paths)` → `sync_schema_files_from_worktree(paths)`. Function body changes from `paths.master_dir.join(".scratch")` to `paths.worktree_dir.join(".scratch")`. ~13 callers across `files.rs` update at the same time.

## Sub-slice sequencing (F.1–F.4)

Four PRs, each shippable on its own.

### F.1 — Detect old layout + refuse

> **Status: SHIPPED 2026-05-20.** Smallest slice that gets the safety net in place before the cutover. No behavior changes for new workspaces; just refuses on old ones.
>
> **What shipped:**
>
> - **`WorkspaceLayout::detect_old_layout(connection_dir_names) -> OldLayoutDetection`** in `shared/layout.rs`. Returns the connections with stale `<workspace>/.scratch/connections/master/<conn>/` directories and/or `<workspace>/<conn>/.git/info/sparse-checkout` config files (≤ 2 stat calls per connection — safe on every CLI op). `OldLayoutDetection` exposes `is_old_layout()` + `affected_connections()` for the printer.
> - **`check_workspace_layout_or_bail(workspace_dir, marker, json)`** + **`print_workspace_needs_reinit_result(detection, json)`** in `cli/commands/files.rs`. JSON mode emits the documented `status: "workspace_needs_reinit"` payload (with `affectedConnections`, `connectionsWithMasterWorktree`, `connectionsWithSparseCheckout`, `recommendation`); non-JSON mode emits a three-step recovery prompt. Caller bails with a non-zero exit code right after printing, mirroring the `blocked_unreviewed` pattern from slice D.
> - **`resolve_workspace_and_connections(cwd, server_url, json)`** gained the `json` parameter; the check runs internally after `read_workspace_marker`. The 12 callers (`run_download`, `run_upload`, `run_publish`, `run_find_merge_base`, `run_accept_all`, `run_reject_all`, `run_discard_all`, `run_discard_created_record`, `run_unreviewed`, `run_unpublished`, `run_unpushed`, `run_force_upload`) all already had `json` in scope — pass-through is mechanical.
> - **7 direct `build_connection_contexts` call sites** (in `run_accept`, `run_reject`, `run_discard`, `run_accept_field`, `run_reject_field`, `run_discard_field`, `run_restore_deleted_record`) gained an explicit `check_workspace_layout_or_bail` call between the marker read and the context build.
> - **`download_workbook` intentionally bypasses the check.** Linked-CLI callers expect a best-effort programmatic refresh; refusing here would fail downstream operations the user didn't directly trigger. The bypass is commented in-line.
> - **Tests (+9 total):** 5 unit tests in `shared/layout.rs` (`detect_old_layout_returns_empty_on_fresh_new_layout`, `..._flags_connections_with_master_worktree`, `..._flags_connections_with_sparse_checkout_config`, `..._affected_connections_dedupes_across_both_artifacts`, `old_layout_detection_default_is_new_layout`); 4 CLI integration tests in `cli/commands/tests/files.rs::workspace_layout_check` (`passes_on_fresh_new_layout`, `bails_when_master_worktree_present`, `bails_when_sparse_checkout_config_present`, `bails_only_when_a_listed_connection_has_artifacts`).
> - **End-to-end smoke** against a fake pre-F workspace at `/tmp/fake-old-workspace`: both JSON-mode (correct `workspace_needs_reinit` payload + exit 1) and human-mode (three-step recovery prompt + exit 1) verified.
> - **End state:** `cargo build --workspace` zero warnings; **733 cargo tests pass** (+9 from H.3's 714 + 10 from H.1.5's lock tests = 724 baseline; the +9 is exact); `cargo fmt --check` clean; `yarn lint` from repo root clean; napi smoke tests 3/3 green.

Smallest slice that gets the safety net in place before the cutover. No behavior changes for new workspaces; just refuses on old ones.

- ✅ Add `detect_old_layout(workspace_dir)` to `shared/layout.rs`. Returns `OldLayoutDetection { connections_with_master_worktree, connections_with_sparse_checkout }`.
- ✅ Hook into the entry point of every mutating CLI command (`files accept`, `files reject`, `files discard`, `files upload`, `files publish`, `files download`) and every listing command (`files unreviewed`, `files unpushed`, `files unpublished`).
- ✅ Output: structured `workspace_needs_reinit` error (JSON mode) + human message (non-JSON mode). Exit code non-zero.
- ✅ Tests: 9 total (5 unit tests on `WorkspaceLayout::detect_old_layout` + 4 CLI-side tests covering both detection conditions, the negative case, and the dir-name-filtering edge case).

**Done when:** any CLI op against a pre-F workspace exits non-zero with the structured error. New workspaces (created post-F.1 with the old init code, since F.2 hasn't shipped) still init fine — F.1 doesn't change init.

### F.2 — Rewrite `setup_connection` + retarget schema sync

> **Status: F.2.a + F.2.b SHIPPED 2026-05-20.** Split into two commits for
> review-effort sanity:
>
> - **F.2.a** — Pure renames. `WorkspaceLayout::dirty_checkout_path` →
>   `worktree_path`; `ConnectionContext::dirty_dir` → `worktree_dir`;
>   `ConnectionPaths::dirty_dir` → `worktree_dir`. ~196 lines across 12 files.
>   Path semantics unchanged. (Sub-effect: `reviewed_dirty_checkout_path` →
>   `reviewed_worktree_path` via substring match in the sed pass — fine
>   because F.3 deletes it entirely.) 733 cargo tests still green, zero
>   warnings.
> - **F.2.b** — The actual cutover.
>   - **New `git_ops`**: `setup_full_worktree`, `ensure_full_worktree` (idempotent),
>     `worktree_reset_mixed`, `worktree_checkout_path` (re-checkout a single
>     pathspec without touching the rest of the working tree).
>   - **`materialize_main_worktree`** in `workspaces.rs` replaces
>     `materialize_dirty_checkout`. Idempotent via `ensure_full_worktree`:
>     valid existing worktree → no-op; broken dir (non-empty, no `.git`
>     gitlink) → fail loudly with a "remove via `workspaces unsync`" message.
>   - **`setup_connection` rewritten**: `git_clone_bare` (skip if bare repo
>     exists) → `materialize_main_worktree` → `reconcile_data_folder_dirs` →
>     `sync_schema_files_from_worktree_paths`. ~30 fewer lines, simpler
>     phases.
>   - **Deleted helpers**: `materialize_dirty_checkout`,
>     `include_schemas_in_sparse_checkout`,
>     `sync_schema_files_from_master_checkout`, the local
>     `sync_schema_files_dir` in `workspaces.rs`. The dead `git_ops` helpers
>     `ensure_sparse_worktree` + `worktree_reset_hard` also went.
>   - **`review_ops::sync_schema_files_from_master` → `sync_schema_files_from_worktree`**.
>     Source: `paths.worktree_dir.join(".scratch")` (was `paths.master_dir.join(".scratch")`).
>     The body now also handles `views/*.json` so the init-time + runtime
>     callers share one implementation. New
>     `sync_schema_files_from_worktree_paths(worktree_dir, scratch_dir)`
>     variant for init callers without a built `ConnectionPaths`. ~15 caller
>     renames across `files.rs`.
>   - **`update_master_worktree` → `update_main_worktree_after_pull`**.
>     Replaced `ensure_sparse_worktree` + `worktree_reset_hard` against
>     `master_dir` with `worktree_reset_mixed` (sync index) +
>     `worktree_checkout_path(_, _, ".scratch")` (refresh tracked schemas
>     without touching record files) against the user worktree.
>   - **`teardown_connection` / `detach_connection`** rename `master_dir` →
>     `legacy_master_dir` and document that the cleanup is back-compat-only;
>     `legacy_reviewed_dir` follows the same shape. F.3 deletes both.
>   - **Idempotency baked in**: re-running `init_v2` on a populated
>     workspace is a no-op (`bare_repo.exists()` skips the clone;
>     `ensure_full_worktree` skips the worktree add when the gitlink + HEAD
>     resolve). Verified end-to-end in
>     `init_v2_produces_workspace_structure_expected_by_desktop` which calls
>     `init_v2` twice and asserts a planted user edit survives the second
>     invocation.
>   - **Tests** (+2 new in `workspaces.rs`, +1 rewritten,
>     `init_v2_…_desktop` expanded with new assertions + idempotency check):
>     `sync_schema_files_from_worktree_copies_schema_and_view_into_cache`
>     (rewritten), `materialize_main_worktree_refuses_to_overwrite_non_worktree_dir`,
>     `materialize_main_worktree_is_idempotent_on_valid_worktree`. The
>     `init_v2_…_desktop` test now asserts (a) `.scratch/` IS in the
>     worktree, (b) no `.git/info/sparse-checkout` config, (c) NO master
>     worktree directory, (d) re-init preserves user edits.
>   - **End-to-end smoke** via `git --git-dir=<bare> worktree add --force
>     <worktree> main` against a synthetic remote: confirmed `.git` gitlink
>     file + non-sparse `.scratch/` + `Posts/` data files materialize as
>     expected.
>   - **F.1 still works**: re-ran the fake-old-workspace fixture from F.1;
>     the `workspace_needs_reinit` JSON payload still fires with exit 1.
>   - **End state**: `cargo build --workspace` zero warnings; **735 cargo
>     tests pass** (+2 from F.2.a's 733); `cargo fmt --check` clean;
>     `yarn lint` from repo root clean; napi smoke 3/3 green.

The cutover.

- `setup_connection` rewritten: `git clone --bare` → `git worktree add --no-detach <worktree_dir> main` (shell-out for now; verify gix support in a follow-up per parent plan risks) → `reconcile_data_folder_dirs` → first-pass `sync_schema_files_from_worktree` to populate the cache.
- **Idempotency required.** Re-running `setup_connection` on a workspace where the bare repo or worktree (or both) already exist must succeed without duplicate work:
  - If `<workspace>/.repos/<id>.git/` exists and is a valid bare repo → skip clone, optionally `git fetch` to refresh refs.
  - If `<workspace>/<connector>/` exists and `git -C <worktree> rev-parse --is-inside-work-tree` succeeds with HEAD on `main` → skip `git worktree add`.
  - If the worktree dir exists but is broken (no `.git` gitlink, or HEAD not on `main`) → fail loudly with a "this directory exists but isn't a valid worktree; remove it and re-run" error rather than silently nuking it. (Manual `workspaces unsync` or `rm -rf` is the user's tool for clearing a stuck state.)
  - `sync_schema_files_from_worktree` is already idempotent (overwrites cache with current source).
  - Tests in F.2 must include a "re-run init against an existing valid layout is a no-op" assertion.
- `materialize_dirty_checkout`, `include_schemas_in_sparse_checkout`, `git_checkout_branch_from_bare`, `sync_schema_files_from_master_checkout` (the init-time helper) all deleted from `workspaces.rs`.
- `ConnectionContext::master_dir` field removed; `dirty_dir` → `worktree_dir`.
- `ConnectionPaths::master_dir` field removed; `dirty_dir` → `worktree_dir`.
- `review_ops::sync_schema_files_from_master` → `sync_schema_files_from_worktree`. Source changed from `master_dir.join(".scratch")` to `worktree_dir.join(".scratch")`. ~13 callers updated.
- `WorkspaceLayout::dirty_checkout_path` → `worktree_path`. ~30 call sites updated.
- `WorkspaceLayout::master_worktree_path` deleted along with its remaining callers.
- `teardown_connection` / `detach_connection` lose the `master_dir` removal.
- `DIRTY_BRANCH` constant deleted; any remaining test fixtures that set up a `dirty` ref get reworked to use `main`.

Migration: F.1's `detect_old_layout` still fires on any old workspace, so this is safe to ship — old workspaces refuse on the entry-point check before they reach any code that assumes the new layout.

Tests:

- Init test in `tests/workspaces.rs` asserts (1) one worktree per connection, (2) worktree is on `main`, (3) no sparse-checkout config, (4) no master directory, (5) `.scratch/connections/scratch/<conn>/schema.json` populated.
- Smoke test for `accept` / `discard` / `upload` / `download` against the new layout (existing tests should pass with `dirty_dir` → `worktree_dir` rename).

**Done when:** a fresh `init` produces one non-sparse `main` worktree per connection; all post-Slice-B CLI commands work against it; `cargo test --workspace` green; `yarn lint` + `yarn build` clean.

### F.3 — Clean up `WorkspaceLayout::reviewed_dirty_checkout_path` + legacy refs

Pure deletion. Nothing references these paths after F.2 except dead code.

- `WorkspaceLayout::reviewed_dirty_checkout_path` deleted.
- `teardown_connection` / `detach_connection` lose the `remove_path(&reviewed_dirty_dir)` line. (Pre-F.3 workspaces are guaranteed gone by the F.1 refusal + user-triggered re-init.)
- Any leftover `DIRTY_BRANCH` references in `service/`, `plan_publish.rs`, etc. that are now unreachable get deleted.

**Done when:** `grep -r "reviewed_dirty\|DIRTY_BRANCH\|master_worktree" src/cli src/shared` returns nothing.

### F.4 — Init perf measurement + parent-plan status update

Not code-shaped; a measurement + a doc update.

- Run `SCRATCHMD_PROFILE=1 scratchmd workspaces init wkb_3qH9SlxsNq` against the Monorepo workspace (5 connectors, 135k files).
- Update the parent plan's [Problem](2026-05-17-simplify-local-workspace-architecture.md#problem) table with the post-F numbers. Today's table shows `materialize_dirty_checkout (sparse: dirty)` at 15.7s + `setup_sparse_worktree (reviewed-dirty)` at 11.8s (Phase 3'd) + `git_checkout_branch_from_bare (main)` at 12.8s for Stripe = ~40s of avoidable work. Expected post-F: a single non-sparse worktree add at ~15s for Stripe.
- Update the parent plan's [Status table](2026-05-17-simplify-local-workspace-architecture.md#status), [Phase 4+5 status block](2026-05-17-simplify-local-workspace-architecture.md#phase-4--5--retire-dirty-branch-switch-to-accepted-patchesjson-merged-2026-05-19) slice F row, and the spec's "Done when" checklist.

**Done when:** the parent plan reflects what F shipped.

## Test strategy

### F.1 (refusal)

- `detect_old_layout_returns_true_when_master_worktree_present`
- `detect_old_layout_returns_true_when_sparse_checkout_config_present`
- `detect_old_layout_returns_false_on_fresh_new_layout`
- Integration-style test: spin up a fake workspace with the old layout, run `scratchmd --json files unreviewed`, assert exit code non-zero + JSON payload shape.

### F.2 (cutover)

- `setup_connection_produces_main_worktree`
- `setup_connection_does_not_create_master_dir`
- `setup_connection_does_not_set_sparse_config`
- `setup_connection_populates_schema_cache_from_worktree_scratch`
- Existing accept/reject/discard/upload/download tests run against the new layout (mostly mechanical rename `dirty_dir` → `worktree_dir`).
- `download_single_repo` test (from slice D) re-runs cleanly — the pull flow doesn't depend on which branch the worktree is on, only on `refs/heads/main`.

### F.3 (cleanup)

- No new tests; deletions break the build if anything still depends on the removed paths.

### F.4 (measurement)

- Manual; output captured in the parent plan's Problem table.

## Open decisions

| #   | Question                                                                                                  | Proposed                                                                                                  | Why                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Schema cache: retarget the source (option c) or repoint all readers (option d)?                          | **(c) retarget the source.** Reader migration is post-F.                                                  | ~10 reader sites; out-of-scope churn would push F over a week. The cache copy is sub-second.                                                                                                          |
| Q2  | Migration: auto-rebuild patch from `dirty vs main` (option a) or refuse-and-re-init (option b)?           | **(b) refuse + re-init prompt.**                                                                          | Population is 2-5 desktop users; option (a) is one-shot debt. The escape hatch (`files publish` → re-init) is already in the user's hands.                                                            |
| Q3  | Should F.2 verify gix's `worktree add` support before defaulting to shell-out?                            | **Shell-out for F.2.** Track gix support as a follow-up.                                                  | Hot path is one call per connection at init. Shell-out is well-understood. The parent plan's [E3 follow-up](2026-05-17-simplify-local-workspace-architecture.md#eng-review-follow-ups) tracks this.    |
| Q4  | Should the worktree's in-tree `.scratch/` be hidden from the desktop UI's file browser?                   | **Out of scope for F.** Desktop already filters dotfiles; verify post-F.2 that the UI looks clean.        | Desktop's grid view reads through `read-records`, not by listing the worktree directly. The dotfile filter is the catch.                                                                              |
| Q5  | Should F.1's refusal check fire on `workspaces show` / `workspaces list` / `workspaces unsync`?           | **No.** Read-only inspection + teardown ops skip the check.                                               | The user needs a way to inspect or remove a stuck workspace without first re-initializing it.                                                                                                         |

## Risks

- **gix `worktree add` gaps.** Same as the parent plan flagged. F.2 ships with shell-out; if gix supports it natively now, it's a one-line swap as a follow-up.
- **In-tree `.scratch/` directory visible in the user-facing worktree.** Today's sparse-checkout intentionally hid it. Post-F, it's there. Desktop UI filters dotfiles; macOS Finder hides dotfiles; the risk is mainly a Power-User-with-`ls -la` aesthetic concern, not a correctness one.
- **Old-layout workspaces that the F.1 refusal doesn't catch.** If a workspace has *both* the old master worktree deleted *and* the sparse-checkout config removed (e.g. user manually deleted dirs), F.1's detection misses it. The new code paths still try to operate against the worktree; behavior depends on the connector. Mitigation: if either detection condition fires, refuse — but document that manually-tampered workspaces are unsupported.
- **Schema cache staleness on rapid pull → accept.** Today, `sync_schema_files_from_master` runs at every accept/reject/discard call to keep the cache fresh from `master`. Post-F, the same call refreshes from the new worktree's `.scratch/`. After a `pull`, the worktree's `.scratch/` updates atomically with the rest of the working tree (single `git checkout` step), so the cache stays correct. No new staleness window.
- **`refs/heads/dirty` left dangling in `<workspace>/.repos/<id>.git/`.** Post-F.2, the local bare repo still has a `dirty` ref (cloned from the server). It's never used locally and never advanced. Cosmetic; deleting it would require an extra `git update-ref -d` at init time. Out of scope for F; could be cleaned in a tiny follow-up.

## Post-F follow-ups

Required cleanup work that F deliberately defers. These are not "maybe" items — they should be tracked and scheduled.

| #   | Item                                                                                                                                                                                                                                                                                                                          | Why deferred from F                                                                                                                                                                  | Effort       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| PF1 | **Drop schema cache; repoint readers (option d).** Update `shared/validators/mod.rs`, `shared/plan_publish.rs`, `shared/index.rs`, `cli/commands/validation.rs`, and any other `connection_scratch_path` reader of `schema.json` to read directly from `<workspace>/<connector>/.scratch/`. The cache directory continues to hold local-only files (`validation.json` etc.) but stops holding git-tracked schemas. `sync_schema_files_from_worktree` becomes dead code; delete it. | ~10 reader sites across multiple modules; auditing each one for "git-tracked vs. local-only" is real work and bundling it into F widens the cutover risk. F ships with the dup cache. | ~half a day  |
| PF2 | **Delete dangling local `refs/heads/dirty` from bare repos.** Local clones still carry the server's `dirty` ref. Add a `git update-ref -d refs/heads/dirty` step to `setup_connection` after clone, or a one-shot migration in `setup_connection` that prunes it on workspace open.                                                                  | Cosmetic only — nothing reads the ref locally. Out of F's hot path.                                                                                                                  | ~15 min      |
| PF3 | **Verify gix `worktree add` support and drop the shell-out.** Parent plan's [E3 follow-up](2026-05-17-simplify-local-workspace-architecture.md#eng-review-follow-ups) tracks this; F.2 ships with shell-out.                                                                                                                                          | One-line swap if gix supports it natively now; not worth blocking F.                                                                                                                 | ~30 min      |
| PF4 | **Confirm desktop UI hides the in-tree `.scratch/` directory.** Post-F, the user-facing worktree contains a `.scratch/` dotdir with tracked schemas. Verify the grid view + file browser don't surface it.                                                                                                                                              | Out of F's Rust-side scope; requires a desktop dogfood pass.                                                                                                                          | ~15 min      |

## Done when

- ✅ A fresh `scratchmd workspaces init` produces one bare repo + one non-sparse `main` worktree per connection. No `master` worktree directory exists.
- ✅ `<workspace>/.scratch/connections/scratch/<connector>/` is populated from the new worktree's tracked `.scratch/`.
- ✅ Accept / reject / discard / upload / download / unreviewed / unpushed all work against the new layout.
- ✅ Pre-F workspaces are refused with a structured error on any mutating or listing CLI op; `workspaces show` / `unsync` still work.
- ✅ `WorkspaceLayout::master_worktree_path` and `reviewed_dirty_checkout_path` removed; `dirty_checkout_path` renamed to `worktree_path`.
- ✅ `ConnectionContext::master_dir` removed; `dirty_dir` renamed to `worktree_dir`.
- ✅ `DIRTY_BRANCH` constant deleted from `workspaces.rs`.
- ✅ `cargo build --workspace` zero warnings; `cargo test --workspace` green; `yarn lint` + `yarn build` from repo root clean; `server/yarn lint-strict` clean.
- ✅ Init-time PhaseTimer numbers captured in the parent plan's [Problem](2026-05-17-simplify-local-workspace-architecture.md#problem) table.
- ✅ Phase 6 unblocked — the per-connection loop in `workspaces.rs::init_v2` can now fan out via rayon without shared mutable state.
