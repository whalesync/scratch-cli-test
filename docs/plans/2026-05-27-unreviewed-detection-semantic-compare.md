# Unreviewed Detection: Semantic JSON Compare for All Modified Files

Author: Chris Hoefgen
Created: 2026-05-27

## Problem

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

## Goals

- Eliminate false-positive unreviewed flags for files that are byte-different from `main` but JSON-equivalent.
- Keep the fast path fast in the common case (no modifications, or modifications limited to a tiny set).
- No new code paths that disagree with the existing "patched path" branch on what counts as unreviewed.

## Non-goals

- Canonicalizing user edits on accept/upload. We assume editors produce JSON in whatever shape they produce it; the unreviewed detector should be the place that absorbs harmless byte differences.
- Making `gix::status` itself semantic. It stays a byte compare; the semantic check is layered on top.

## Design

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

## Key decisions

1. **One unified branch, not two.** Rather than duplicate the JSON-compare logic into the "unpatched" branch, collapse both into a single second-pass loop. The `Option<&PatchEntry>` shape on each iteration says "is this a patch reconciliation, or a plain main-blob check?" — the compare function is the same in both.

2. **`main_map` is read at most once per call.** Currently it's loaded only if at least one ambiguous path exists; preserve that gate. With every modified data path now ambiguous, the gate fires whenever `gix::status` flags any data file — which is exactly when we'd want to pay the cost.

3. **Non-data paths still skipped.** `is_data_path_in_folder(&rel_path, "")` stays as a pre-filter; `.scratch/` files and other tracked-but-non-record paths don't enter the ambiguous set. (Materialize/sync owns those; the unreviewed gate is about user record edits.)

4. **No change to the `accepted-patches.json` semantics.** Patches whose `apply(main, patch)` equals working bytes still count as approved-pending-publish, not unreviewed. Patches whose working bytes diverge still count as stacked-unreviewed-on-top-of-accepted (today's behavior).

5. **No change to `json_content_differs`.** It already handles both sides being parseable JSON (semantic compare) and the fallback (byte compare on parse failure). The fallback is the safety net for non-JSON files that somehow reach this point.

## Risks

- **Performance on large modification sets.** If a user has thousands of modified data files (e.g., a rogue script touched everything), the second pass reads `main_map` and parses both sides per path. `main_map` is one tree read, amortized. Per-file work is one `std::fs::read` + two `serde_json::from_slice`. Bounded and parallelizable, but worth measuring on a large fixture before shipping.
- **True unreviewed edits get a slightly slower fail.** Today: gix::status flags it, function returns immediately. After: function reads `main_map` (one tree walk) before flagging. Acceptable — the unreviewed-blocked flow is already user-facing and not a hot loop.
- **Edge case: file in working tree but absent from `main_map`.** `expected` is `None`. `json_content_differs(None, Some(bytes))` returns `true` — flagged as unreviewed. That matches today's behavior for the "Added" gix status (a file the user created that isn't on `main`). Good — preserved.

## Test plan

1. **Add a unit test for the new branch** in `detect_unreviewed_fast`:
   - Set up a worktree with one record file whose bytes differ from `main` (e.g., trailing newline removed) but parse to identical JSON. Empty `accepted-patches.json`. Assert `detect_unreviewed_fast` returns no entries.
   - Same setup but with a real content change. Assert one entry returned.

2. **Revert the publish.spec.ts test-side workaround.** The test edit at `publish.spec.ts:240` currently appends `\n` to match server canonical format. After this change lands, drop the `+ "\n"` so the test exercises the byte-mismatch path end-to-end. The "download succeeds (no unreviewed gate)" step should still pass.

3. **Smoke the publish-gate short-circuit.** Manual: in a workspace with one truly-unreviewed file plus several formatting-only-different files, `scratchmd files publish` should still block. Today it would block on the first byte-modified path (often correctly, sometimes wrongly); after the change it must still block, just via the second pass.

4. **Run the full CLI integration suite.** [scratch-cli-tests/](../../scratch-cli-tests/) — `files.spec.ts`, `publish.spec.ts`, `driver-publish.spec.ts`. None should regress.

## Rollout

Single PR against `scratch-git-2`. No schema changes, no migrations, no on-disk format changes. The change is internal to `detect_unreviewed_fast`. Ship behind the same release as the publish.spec.ts test revert (step 2 in the test plan) so the end-to-end coverage proves the path on the way in.
