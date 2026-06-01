# Unreviewed Detection: Semantic JSON Compare + Rematerialize After Publish

Author: Chris Hoefgen
Created: 2026-05-27
Updated: 2026-05-28 — added Option 2 (rematerialize in `reconcile_accepted_after_publish`).

## Problem

There are two linked bugs that both surface as "the post-publish working tree disagrees with `main`":

### Bug A — false-positive unreviewed flag

`detect_unreviewed_fast` in [scratch-git-2/src/cli/commands/files.rs](../../scratch-git-2/src/cli/commands/files.rs) uses `gix::status` to find files whose **bytes** differ from the index, then routes paths through two branches:

1. **Path is in `accepted-patches.json`** → falls back to a semantic JSON compare via `apply_patch_entry_to_blob` + `json_content_differs`. A byte difference that's semantically equivalent does not count as unreviewed.
2. **Path is not in `accepted-patches.json`** → flagged as unreviewed immediately, with no semantic check.

Branch 2 produces false positives whenever a working-tree file is byte-different from `main` but semantically equivalent. Concretely, the post-publish flow ends up in exactly this state:

- The user accepts an edit. `accepted-patches.json` contains a patch entry for the file.
- The patch lands server-side via `files publish`.
- `reconcile_accepted_after_publish` drops the entry (the patch is now in `main`) and runs `worktree_reset_mixed` so the gix index reflects new `main`.
- The next `files download` pre-flight runs `detect_unreviewed_fast`. The working-tree file still holds the bytes the user originally wrote (the reconcile does not rewrite the working tree). If those bytes differ from new `main` for any reason — trailing newline, key ordering, whitespace — the file gets flagged as unreviewed and download bails with `blocked_unreviewed`.

The CLI integration test [scratch-cli-tests/tests/publish.spec.ts](../../scratch-cli-tests/tests/publish.spec.ts) (the "download succeeds (no unreviewed gate)" case) caught this concretely: the test wrote with `JSON.stringify(data, null, 2)` (no trailing newline) while the server canonical format is `JSON.stringify(data, null, 2) + '\n'`. The bytes diverged by exactly one byte and the file got flagged.

A test-side workaround (append `\n`) was applied so the test passes against the current code, but the underlying gap remains: any byte-vs-content mismatch in the working tree of an unpatched file produces a false positive on the unreviewed gate.

### Bug B — CLI `files publish` never re-canonicalizes the worktree

Even if Bug A is fixed, the CLI publish flow leaves the worktree byte-different from `main`. `reconcile_accepted_after_publish` ([scratch-git-2/src/cli/commands/files.rs:3097](../../scratch-git-2/src/cli/commands/files.rs#L3097)) currently:

1. fetches `origin/main`,
2. re-anchors `accepted-patches.json` (drops successfully-published patches via semantic compare),
3. saves the patch file atomically,
4. advances `refs/heads/main`,
5. runs `worktree_reset_mixed` (index-only — working tree untouched).

The working tree still holds the user's original bytes. A subsequent `scratchmd files download` sees `refs/heads/main == refs/remotes/origin/main` and short-circuits "up to date" at [PULL_AFTER_PUBLISH.md:41](../../scratch-git-2/docs/PULL_AFTER_PUBLISH.md#L41) — `materialize_local_repo` never runs, and the byte difference persists indefinitely. `gix::status` will keep reporting the path as `Modified` until the user happens to overwrite it.

The desktop flow does not hit Bug B in isolation: it shells out to `scratchmd files download` after a direct-HTTP publish, so `materialize_local_repo` does run there. But its dependency chain still goes through the unreviewed gate (Bug A), so both bugs need fixing for the desktop's post-publish refresh to complete a hard-reset-style snap.

## Goals

- Eliminate false-positive unreviewed flags for files that are byte-different from `main` but JSON-equivalent. **(Bug A)**
- After a successful `scratchmd files publish`, the local working copy reflects `refs/heads/main` byte-for-byte (modulo any failed-publish patches that remain in `accepted-patches.json`). The user-visible behavior is a clean hard-reset to the post-publish canonical state. **(Bug B)**
- Keep the fast path fast in the common case (no modifications, or modifications limited to a tiny set).
- No new code paths that disagree with the existing "patched path" branch on what counts as unreviewed.

## Non-goals

- Canonicalizing user edits on accept/upload. We assume editors produce JSON in whatever shape they produce it; the unreviewed detector should be the place that absorbs harmless byte differences.
- Making `gix::status` itself semantic. It stays a byte compare; the semantic check is layered on top.
- Clobbering unreviewed working-tree edits on unrelated paths. The rematerialize step targets only paths the reconcile actually touched (see Design below).

## Design

The fix is two changes in one PR. Bug A's detector fix and Bug B's reconcile change are independent of each other (either compiles and ships standalone), but the end-to-end desktop post-publish flow only works correctly when both land — otherwise the detector still blocks the materialize that the rematerialize call is trying to make redundant for the CLI path.

## Design — Bug A: detector

### Current shape (paraphrased)

```rust
for item in gix_status_iter {
    let rel_path = item.rela_path();
    if !is_data_path(rel_path) { continue; }

    if patched_paths.contains(&rel_path) {
        ambiguous.push((rel_path, status));        // defer to JSON compare
    } else {
        entries.push(unreviewed_entry(...));      // flag immediately
        if short_circuit { return; }
    }
}

// Second pass: load main_map once, then JSON-compare each ambiguous path
// against apply_patch_entry_to_blob(main_blob, entry).
```

### Proposed shape

Treat **every** modified data path as ambiguous and resolve all of them in the second pass. The "expected" bytes are derived per-path:

- Path **is** in `accepted-patches.json` → expected = `apply_patch_entry_to_blob(main_blob, entry)`. (Today's behavior — preserved.)
- Path **is not** in `accepted-patches.json` → expected = `main_blob` (verbatim). New.

```rust
for item in gix_status_iter {
    let rel_path = item.rela_path();
    if !is_data_path(rel_path) { continue; }
    ambiguous.push((rel_path, status));
}

if !ambiguous.is_empty() {
    let main_map = read_main_tree(&ctx.bare_repo)?;
    for (rel_path, status) in ambiguous {
        let main_blob = main_map.get(&rel_path).map(|v| v.as_slice());
        let expected = match accepted_file.patches.iter().find(|p| p.path == rel_path) {
            Some(entry) => review_ops::apply_patch_entry_to_blob(main_blob, entry)?,
            None => main_blob.map(|b| b.to_vec()),
        };
        let actual = std::fs::read(ctx.worktree_dir.join(&rel_path)).ok();
        if json_content_differs(expected.as_deref(), actual.as_deref()) {
            entries.push(unreviewed_entry(...));
            if short_circuit { return; }
        }
    }
}
```

### Short-circuit semantics

`short_circuit: true` is used by callers that only need a boolean ("any unreviewed?") — currently the publish-action gate. With the new shape, short-circuit returns as soon as the second pass confirms one truly-unreviewed file, not on the first byte-modified path. That's a behavior change for the publish gate: it now reads `main_map` once whenever any data file is byte-different. The cost is bounded by the size of the modified set, not the worktree.

In the common cases (`scratchmd files download` right after a publish, where the only "modifications" are formatting differences) this is the regression we're fixing — short-circuit currently returns true and blocks the user; with the change it returns false and lets the operation proceed.

## Design — Bug B: rematerialize in `reconcile_accepted_after_publish`

### Current tail (lines 3145-3159 of `scratch-git-2/src/cli/commands/files.rs`)

```rust
let new_accepted = AcceptedPatchesFile { patches: re_anchored.patches };
accepted_patches::save_atomic(&connection_dir, &new_accepted)?;

if let Some(hash) = new_main_hash.as_deref() {
    git_update_ref(&ctx.bare_repo, "refs/heads/main", hash)?;
    if ctx.worktree_dir.join(".git").exists() {
        worktree_reset_mixed(&ctx.worktree_dir, hash)?;   // index only
    }
}
```

### Proposed tail

Mirror `download_single_repo`'s post-re-anchor sequence — compute `approved_map_new`, read the worktree, then materialize before the atomic save and ref bump.

```rust
let new_accepted = AcceptedPatchesFile { patches: re_anchored.patches };
let approved_map_new = compute_accepted_state(&main_map_new, &new_accepted)?;
let local_map = read_materialized_repo(ctx)?;

// Rematerialize the worktree to the post-publish canonical state:
//   - successfully-published paths snap to new_main bytes,
//   - failed-publish paths snap to apply(new_main, surviving_patch),
//   - all other paths are skipped (preserves unreviewed edits on
//     unrelated files; see Risks).
materialize_local_repo(ctx, &approved_map_new, &local_map)?;

accepted_patches::save_atomic(&connection_dir, &new_accepted)?;

if let Some(hash) = new_main_hash.as_deref() {
    git_update_ref(&ctx.bare_repo, "refs/heads/main", hash)?;
    if ctx.worktree_dir.join(".git").exists() {
        worktree_reset_mixed(&ctx.worktree_dir, hash)?;   // bring gix index in sync
    }
}
```

### Why this ordering

Same crash-recovery argument as `download_single_repo` ([files.rs:3261-3266](../../scratch-git-2/src/cli/commands/files.rs#L3261-L3266)): `save_atomic` must precede `git_update_ref` so a crash between them leaves the patches still anchored against old `main` (next run re-runs reconcile cleanly). `materialize_local_repo` slots in **before** `save_atomic` because it's idempotent — a crash between materialize and save leaves a worktree at the new canonical bytes but a patch file still anchored at old `main`; the next run re-anchors, sees nothing to drop, re-materializes (no-op because bytes already match), saves, and advances the ref.

`worktree_reset_mixed` stays at the end. After materializing we need to bring the gix index in sync with `refs/heads/main` so the next `gix::status` call doesn't see every just-canonicalized file as `Modified`. Without it, even the fixed detector (Bug A) would do unnecessary second-pass JSON parses on the next call.

### Scoping: which paths get materialized

`materialize_local_repo` already handles "skip files where current_content == target_content byte-for-byte" ([files.rs:3853](../../scratch-git-2/src/cli/commands/files.rs#L3853)). So in practice the worktree write only fires on paths where the on-disk bytes differ from `approved_map_new` — which is exactly:

- paths that were just published (worktree had the user's pre-canonical bytes, target is `new_main` bytes), and
- paths the server changed independently (rare in the publish flow, but possible if another writer raced).

Paths the user is editing unreviewed but never accepted are still in `approved_map_new` as the `new_main` blob (not the user's working bytes), so they would be clobbered. See Risks below.

### Why not just hard-reset

`git reset --hard refs/heads/main` would also achieve the goal for the no-failed-publish case, but it would clobber failed-publish patches' applied versions on disk (those need `apply(new_main, surviving_patch)`, not `new_main` verbatim). `materialize_local_repo(approved_map_new, ...)` is the right shape because it already encodes the "main + accepted patches" rule that the download path uses — reusing it keeps the two flows consistent and centralizes the materialize semantics in one function.

## Key decisions

1. **One unified branch, not two.** Rather than duplicate the JSON-compare logic into the "unpatched" branch, collapse both into a single second-pass loop. The `Option<&PatchEntry>` shape on each iteration says "is this a patch reconciliation, or a plain main-blob check?" — the compare function is the same in both.

2. **`main_map` is read at most once per call.** Currently it's loaded only if at least one ambiguous path exists; preserve that gate. With every modified data path now ambiguous, the gate fires whenever `gix::status` flags any data file — which is exactly when we'd want to pay the cost.

3. **Non-data paths still skipped.** `is_data_path_in_folder(&rel_path, "")` stays as a pre-filter; `.scratch/` files and other tracked-but-non-record paths don't enter the ambiguous set. (Materialize/sync owns those; the unreviewed gate is about user record edits.)

4. **No change to the `accepted-patches.json` semantics.** Patches whose `apply(main, patch)` equals working bytes still count as approved-pending-publish, not unreviewed. Patches whose working bytes diverge still count as stacked-unreviewed-on-top-of-accepted (today's behavior).

5. **No change to `json_content_differs`.** It already handles both sides being parseable JSON (semantic compare) and the fallback (byte compare on parse failure). The fallback is the safety net for non-JSON files that somehow reach this point.

6. **Reuse `materialize_local_repo` rather than reimplement.** The download path already correctly handles failed-publish patches via `approved_map_new = compute_accepted_state(main_map_new, accepted)`. Calling the same function from reconcile keeps the two flows aligned and means any future change to the materialize semantics propagates to both.

7. **No pre-flight unreviewed gate in reconcile.** The UI already refuses to start a publish while any path is unreviewed (the user must accept or reject all unreviewed changes first), so at the moment `reconcile_accepted_after_publish` runs there are by policy no unreviewed working-tree edits to protect. Adding another gate here would be redundant.

## Risks

- **Performance on large modification sets.** If a user has thousands of modified data files (e.g., a rogue script touched everything), the second pass reads `main_map` and parses both sides per path. `main_map` is one tree read, amortized. Per-file work is one `std::fs::read` + two `serde_json::from_slice`. Bounded and parallelizable, but worth measuring on a large fixture before shipping.
- **True unreviewed edits get a slightly slower fail.** Today: gix::status flags it, function returns immediately. After: function reads `main_map` (one tree walk) before flagging. Acceptable — the unreviewed-blocked flow is already user-facing and not a hot loop.
- **Edge case: file in working tree but absent from `main_map`.** `expected` is `None`. `json_content_differs(None, Some(bytes))` returns `true` — flagged as unreviewed. That matches today's behavior for the "Added" gix status (a file the user created that isn't on `main`). Good — preserved.

### Bug B risks

1. **`read_materialized_repo` cost on every publish.** Reconcile currently only reads the two main trees. After this change it also walks the worktree. For workspaces with thousands of files this adds non-trivial latency to publish. Mitigation: `read_materialized_repo` already exists and is used by every download — its cost is well-understood. If profiling shows it dominates, the next iteration can pass a path filter (only paths in the union of `accepted` + server-changed) to bound the read.

2. **Materialize failure mid-reconcile.** Today, reconcile-internal errors degrade to `PublishConnectionOutcome::PublishedWithReconcileWarning` ([PULL_AFTER_PUBLISH.md:68](../../scratch-git-2/docs/PULL_AFTER_PUBLISH.md#L68)). Materialize errors (disk full, permissions) should follow the same path — the publish itself succeeded server-side, only the local refresh is degraded. Surface as a warning, not a publish failure. The atomic-save ordering means a crash after a partial worktree write still recovers cleanly on the next pull.

3. **Failed-publish path semantics.** When a connector batch failed, the patch survives in `accepted-patches.json`. `compute_accepted_state` applies it on top of `new_main`, so the worktree shows `apply(new_main, surviving_patch)` — the user's intended-but-failed value, not the server's current value. This is the same behavior as `files download`, so it should match user expectations from that flow. The post-publish "unpublished" badge will correctly stay on for these paths because `accepted-patches.json` still has them.

The "stacked unreviewed edit on a just-published path" scenario is not a risk: the UI enforces accept-or-reject of all unreviewed changes before publish can start, so by the time reconcile runs there is no unreviewed working-tree state to preserve.

## Test plan

### Bug A — detector

1. **Add a unit test for the new branch** in `detect_unreviewed_fast`:
   - Set up a worktree with one record file whose bytes differ from `main` (e.g., trailing newline removed) but parse to identical JSON. Empty `accepted-patches.json`. Assert `detect_unreviewed_fast` returns no entries.
   - Same setup but with a real content change. Assert one entry returned.

2. **Revert the publish.spec.ts test-side workaround.** The test edit at `publish.spec.ts:240` currently appends `\n` to match server canonical format. After this change lands, drop the `+ "\n"` so the test exercises the byte-mismatch path end-to-end. The "download succeeds (no unreviewed gate)" step should still pass.

3. **Smoke the publish-gate short-circuit.** Manual: in a workspace with one truly-unreviewed file plus several formatting-only-different files, `scratchmd files publish` should still block. Today it would block on the first byte-modified path (often correctly, sometimes wrongly); after the change it must still block, just via the second pass.

### Bug B — rematerialize in reconcile

4. **Add a unit/integration test for `reconcile_accepted_after_publish` rewriting the worktree.**
   - Fixture: worktree file with a whitespace-only byte diff vs. `new_main` (e.g., no trailing newline). Accepted-patches entry whose intended outcome matches `new_main` semantically.
   - Run reconcile. Assert: `accepted-patches.json` is empty, `refs/heads/main` == post-publish hash, and the worktree file's bytes are now byte-equal to the `new_main` blob (including the trailing newline).

5. **Add a failed-publish preservation test.**
   - Fixture: two accepted patches; one matches `new_main` (published), one does not (failed). Run reconcile.
   - Assert: the failed patch survives in `accepted-patches.json`, and the corresponding worktree file is `apply(new_main, surviving_patch)` byte-for-byte (not raw `new_main` and not the user's pre-reconcile bytes).

6. **Run the full CLI integration suite.** [scratch-cli-tests/](../../scratch-cli-tests/) — `files.spec.ts`, `publish.spec.ts`, `driver-publish.spec.ts`. None should regress. The "download succeeds (no unreviewed gate)" assertion in `publish.spec.ts` should now also be reachable without a fresh fetch (since the publish itself canonicalized the worktree).

7. **Manual desktop smoke.** In the desktop, publish a single-field edit on a record file. Confirm:
   - The publish modal completes without an unreviewed-block modal.
   - The "unpublished" badge on the published record clears.
   - `git status` on the local repo shows the path as clean.

## Rollout

Single PR against `scratch-git-2` covering both Bug A and Bug B. No schema changes, no migrations, no on-disk format changes. Changes are internal to `detect_unreviewed_fast` and `reconcile_accepted_after_publish`. Ship behind the same release as the `publish.spec.ts` test revert (step 2 in the test plan) so the end-to-end coverage proves the combined path on the way in.
