# Backfill publish leaves a stale `@/...` pseudo-ref in `accepted-patches.json`

**Status**: open, root cause confirmed
**Surfaced via**: `scratch-cli-tests/tests/driver-publish.spec.ts` — the two `pseudo-ref FK` driver scenarios fail with `Unexpected reviewed dirty paths after final download. Expected: (none); got: public/posts/post-1.json.`
**Investigated**: 2026-06-01

## TL;DR

When a user accepts an edit that sets a field to a pseudo-ref (`authorId: "@/public/authors/author-1.json"`) and then publishes, the **server** now resolves the pseudo-ref to the real ID (`1`) as part of building the publish plan, calls the connector, and commits the resolved value to `main`. The CLI's `accepted-patches.json`, however, still carries the *un-resolved* pseudo-ref string. After publish the CLI runs `reconcile_accepted_after_publish` → `re_anchor_patches`, whose no-op detection is a strict byte-equality comparison. `"@/..."` does not byte-equal `1`, so re-anchor keeps the patch. The patch is then re-applied on top of the freshly-downloaded `main` blob, silently un-resolving `authorId` in the working tree and causing the file to show up as "unpublished" indefinitely.

Symptoms only fire for publishes that contain at least one pseudo-ref field — pure-edit, pure-create, and pure-delete cycles are unaffected.

## Root cause

The CLI's re-anchor model assumed that the on-disk patch and the post-publish blob agree on form. That invariant was broken by the move of publish-plan execution from the client to the server.

**Pre-refactor** (publish plan client-side):
- The CLI resolved `@/...` to a real ID itself before uploading.
- `accepted-patches.json` either carried the resolved form, or was cleared atomically with the publish.
- Re-anchor's `apply(new_main, patch) == new_main` check naturally matched.

**Post-refactor** (publish plan server-side, what we ship today):
- The CLI uploads the patch verbatim. `authorId: "@/..."` is sent as-is.
- The server applies the patch on its private branch, builds the publish plan, resolves pseudo-refs against the workbook's file index, calls the connector, and commits the **resolved** row to `main` (`authorId: 1`).
- The CLI fetches `main`. `new_main` blob has `authorId: 1`.
- Re-anchor runs over `accepted-patches.json` entries, each still containing `"authorId": "@/public/authors/author-1.json"`.
- `is_noop_against` (`src/shared/re_anchor.rs:182`):

  ```rust
  (PatchKind::Update, Some(n)) => &merge_patch::apply(n, &entry.patch) == n
  ```

  `apply({..., authorId: 1, ...}, {authorId: "@/..."})` → `{..., authorId: "@/...", ...}`, which **is not equal to** `{..., authorId: 1, ...}`. The patch is retained.
- Working tree is rebuilt as `new_main` + retained patches → `authorId` reverts to `"@/..."`.
- `scratchmd files unpublished` reports `public/posts/post-1.json` as still-dirty.

## Repro

```bash
cd scratch-cli-tests
yarn test:integration:driver
# 2 of 5 tests fail (FK scenarios). Edit/create/delete pass.
```

Or run the driver script directly with `--no-cleanup --stop=local-download-complete` to inspect on-disk state:

```bash
node scripts/driver-run.js --count 1 --add-fk 1-1 --no-cleanup --stop=local-download-complete
```

After the stop, in the preserved workspace:
- `.repos/coa_*.git` `main:public/posts/post-1.json` → `authorId: 1` ✓ (server resolved + committed correctly)
- `.scratch/connections/Smoke Postgres/accepted-patches.json` → still contains `"authorId": "@/public/authors/author-1.json"` ✗ (should be empty, like in the passing edit case)
- Working tree `Smoke Postgres/public/posts/post-1.json` → `authorId: "@/..."` ✗ (`main` + stale patch overlay)

Compare with `--count 1` (no `--add-fk`): `accepted-patches.json` ends with `"patches": []` post-publish, working tree matches `main`, file is not "unpublished".

## Affected code

- `scratch-git-2/src/cli/commands/files.rs:3740` — `reconcile_accepted_after_publish`
- `scratch-git-2/src/shared/re_anchor.rs:111` — `re_anchor_one`
- `scratch-git-2/src/shared/re_anchor.rs:175` — `is_noop_against` (the byte-equality check that fails)

## Remediation options

Listed roughest-but-bluntest first, cleanest last.

### Option A: server returns the resolved patch alongside the publish response (recommended)

The server has the full pseudo-ref → ID mapping while it's building the plan (`publish-plan-run.service.ts`). Add a `resolvedPatches: { path, resolvedFields }[]` field to the publish-job status payload (or to a sibling endpoint that the CLI hits post-run). The CLI then rewrites its in-memory `accepted-patches.json` entries with the resolved values before handing them to `re_anchor_patches`, restoring the invariant that on-disk patches and post-publish blobs agree on form.

Why this is the right shape: it's the same pattern as the Step-2 `UPDATE_RECORDS_RETURNS_REMOTE_DATA` work — "the publisher tells you what it did." Source of truth (server) feeds the cache (CLI patch file). No semantic divergence between sides.

Trade-offs:
- Touches the CLI/server contract (versioning, server build + client build coupling).
- Need to decide whether the server returns the diff or the full resolved patch — diff is smaller, full is simpler to consume.

### Option B: make `re_anchor` pseudo-ref aware

Teach `is_noop_against` that `"@/..."` is a placeholder. Specifically: walk the merge patch object; for each field whose patch value is a `"@/..."` string, if the corresponding field on `new` is *any non-`@/` value*, treat that field as satisfied and drop it from the patch. Keep any other unsatisfied fields.

Trade-offs:
- Localized to `scratch-git-2/src/shared/re_anchor.rs` — no contract change.
- Encodes a server-side semantic ("`@/` means resolve me") at the CLI layer. Two implementations of pseudo-ref semantics drifting over time is plausible.
- Doesn't handle other future server-side rewrites (formatting normalization, default fills, etc.) — only solves the pseudo-ref case.

### Option C: clear patches by upload identity, not by content equality

Tag each accepted-patch with the run-job ID at upload time. When `reconcile_accepted_after_publish` sees a successful run-job for that ID, drop the corresponding patches outright, bypassing content comparison.

Trade-offs:
- Sidesteps content comparison entirely → robust to *any* server-side rewrite (pseudo-ref, formatting, defaults, …).
- Bigger contract change: needs an upload-time identifier propagated through upload → plan → run-job, plus persistence on the patch record.
- Loses the safety net DEV-10175 introduced — if a run-job reports success but the underlying connector batch silently failed (e.g. Airtable 401), this option would clear patches that haven't actually landed. Would need the run-job's per-file success signal to be reliable end-to-end before this is safe.

## Why this slipped past existing tests

- The 5 driver tests in `scratch-cli-tests/tests/driver-publish.spec.ts` (including the two FK scenarios) were `it.skip`ped on 2026-05-22 in commit `85e82790a` ("revised for local post-worskpace refactor") with an XXX comment requesting a driver-script rewrite. The rewrite landed 2026-05-29 but the tests stayed skipped until 2026-06-01.
- The server-side `sync-publish-e2e.spec.ts` covers the publish path but mocks the connector and does not exercise the CLI's accepted-patches reconcile flow at all — the CLI is the layer where the bug surfaces.
- Manual flows surface the bug as "the post still shows as edited after I published it", but the user can work around it by re-pulling, so it can easily look like a transient UI issue.

## Owner / Acceptance

Owner: TBD.
Acceptance criteria:
- The two FK driver scenarios in `scratch-cli-tests/tests/driver-publish.spec.ts` are un-skipped and pass.
- A focused unit test in `scratch-git-2/src/shared/re_anchor.rs` (or wherever the chosen fix lands) locks in the pseudo-ref → resolved-ID no-op detection.
- No regression in the existing edit/create/delete driver scenarios.
