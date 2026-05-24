# Pull After Publish

How the local workspace re-syncs with the server after a publish lands.

## Why this matters

The publish pipeline runs entirely on the server: it applies RFC 7396 patches to the connection repo's `dirty` branch, executes them against the remote SaaS service, and advances `refs/heads/main` as records actually land. The local workspace is unaware of any of this until it explicitly fetches.

Without a sync, the desktop would keep showing stale "unpublished" badges for records that were just published, and the user's `accepted-patches.json` would still contain entries for records that are now live on `main`. The next `files upload` would try to re-publish them.

## Two paths that handle the sync

### CLI: `scratchmd files publish`

After a successful run-job, the CLI calls `reconcile_accepted_after_publish` (`cli/commands/files.rs`) on each connection:

1. Snapshot `old_main = refs/heads/main` (pre-fetch).
2. `git fetch origin main`.
3. Run `re_anchor::re_anchor_patches` over `accepted-patches.json` against `(old_main, refs/remotes/origin/main)`:
   - Patches whose outcome matches the new `main` blob byte-for-byte are dropped (the server published them).
   - Patches for connector batches that failed survive verbatim — the records didn't land, so the user's edits stay queued.
   - Same-field collisions between the user's accepted patch and the server's new `main` go to `.scratch/conflicts.log` (user wins; the patch is preserved).
4. Atomically save the re-anchored `accepted-patches.json` (`.tmp` → fsync → rename) **before** advancing the ref, so a crash mid-reconcile leaves recoverable state.
5. `git update-ref refs/heads/main refs/remotes/origin/main`.

This used to be a blind `accepted_patches::clear()` at the end of publish — see [DEV-10175](https://linear.app/whalesync/issue/DEV-10175/scratchmd-files-publish-clears-accepted-patchesjson-even-when), fixed on `mr17`.

### Desktop UI: post-publish refresh

The desktop's publish modal (`scratch-desktop/src/renderer/src/pages/workspace/PublishChangesModal.tsx`) drives the publish via direct HTTP calls (`/upload-patch` then `/publish-v2/plan-job` then `/publish-v2/run-job`) instead of shelling out to `scratchmd files publish`. After the run-job reaches a terminal state, it calls `window.scratchDesktop.pullWorkspaceChanges(localPath)` — which shells out to `scratchmd files download`. That triggers the full pull flow below.

## What `files download` does

```
acquire .scratch/lock
detect_unreviewed_for_pull(ctx)
  └─ if any field is unreviewed → exit with blocked_unreviewed (no fetch)
read old_head = refs/heads/main
load accepted-patches.json
git fetch origin main
if refs/remotes/origin/main == old_head → "up to date", no work
re_anchor_patches(patches, old_head, new_head)
  └─ conflicts append to .scratch/conflicts.log (best-effort)
materialize_local_repo(approved_map_new, local_map)
  └─ for each server-changed path:
       - no patch entry → write new main blob (or delete if main removed it)
       - patch entry    → write apply(new_main_blob, re_anchored_patch)
save accepted-patches.json atomically
git update-ref refs/heads/main refs/remotes/origin/main
```

The atomic save happens **before** the ref bump so that a crash between the two leaves a consistent state on next run (the patches reflect the new head; the next pull will see `up-to-date`).

## Refuse vs. stash

Earlier designs (see decision log entries under "Pull stash mechanism" in the workspace-simplification plan) tried to stash the user's unreviewed working-tree edits into a `working-patches.json` file, replay them after the fetch, and offer a `--clear-stash` recovery flag. The shipped design is simpler: refuse the pull when any field is unreviewed, return a structured `blocked_unreviewed` payload listing the offending paths, and require the user to `files accept-all` or `files discard-all` first.

This is symmetric with git's "commit or stash before pull" UX. The desktop pattern-matches on `blocked_unreviewed` and surfaces a three-button modal: Accept all & refresh / Discard all & refresh / Cancel.

## Failure handling & retry policy

The post-publish fetch is best-effort across both code paths. There is no automatic retry, no exponential backoff, and no surfaced user error when it fails. The rationale is symmetry: if the fetch fails this minute, the next publish or pull will retry it for free, and nothing on disk diverges in the meantime — the local `accepted-patches.json` keeps the user's edits queued and the local `refs/heads/main` stays at its previous (now slightly stale) value.

### CLI: `scratchmd files publish`

`reconcile_accepted_after_publish` calls `git_ops::fetch_origin` (one shell-out to `git fetch origin +refs/heads/*:refs/remotes/origin/*`, no retry). If the fetch fails:

- The function returns an error to `publish_single_connection`, which converts it into a `PublishConnectionOutcome::PublishedWithReconcileWarning`. The publish itself is reported as **succeeded** for that connection — only the local refresh is marked as a non-fatal warning (F9).
- `run_publish` continues with the remaining connections (F8) and exits non-zero only if a true plan/run failure occurred. A workspace where every connection published but one or more reconciles failed exits **0** with `Warning (<conn>): post-publish refresh failed: …` on stderr; the JSON output carries the same data under `warnings[]` and each connection's `warning.phase = "reconcile"`.
- No state on disk is left half-written: `reconcile_accepted_after_publish` does the atomic `save_atomic` of the re-anchored patch file before advancing `refs/heads/main`, so a fetch failure (which happens before any of that) leaves the workspace in its pre-publish state — `accepted-patches.json` is still anchored against `old_main` and the next `files publish` or `files download` re-attempts the same reconcile.

### Desktop: post-publish refresh

`PublishChangesModal` (`scratch-desktop/src/renderer/src/pages/workspace/PublishChangesModal.tsx`) drives publish via direct HTTP and calls `window.scratchDesktop.pullWorkspaceChanges(localPath)` once when all per-connection publishes reach a terminal state. The main-process handler at `scratch-desktop/src/main/index.ts` shells out to `scratchmd files download`.

- Single attempt: the call is wrapped in `try/catch` and on failure logs to `console.debug('Post-publish pull failed:', err)`. The modal does not surface a user-facing error and does not retry.
- The modal then transitions to its `complete` (or `error` for failed publishes) mode regardless of whether the refresh succeeded.
- Side effects on failure: the desktop's "unpublished" badges, the `accepted-patches.json` file, and `refs/heads/main` all stay at their pre-publish view. The user can recover by clicking Refresh (which calls the same `pullWorkspaceChanges` IPC) or by running `scratchmd files download` from the terminal.

### Why no retry

- The `fetch_origin` shell-out is already idempotent and cheap — retrying inside `reconcile_accepted_after_publish` would add latency to the success path with no correctness win.
- Both the next `files publish` and the next `files download` perform a fresh `git fetch origin main` as their first step, so a transient network blip resolves on the next user action without a background retry loop.
- The publish itself succeeded server-side (`publish-v2/run-job` reached `completed`); the fetch failure only delays the local view-of-state catching up. Surfacing it as a modal error would over-state the impact.

If sustained fetch failures become a real problem (e.g. a corporate proxy that intermittently blocks port 443 to the git origin), the right place to add retry is `git_ops::fetch_origin` itself, with an exponential backoff bounded to a few seconds — both callers would benefit.

## Same-field conflicts

When the user accepted a patch on key `K` and the server also changed `K` to a different value between `old_main` and `new_main`, the user wins: the patch entry is preserved, the meaning shifts from "change A→B" to "set to B." A line goes to `.scratch/conflicts.log`:

```jsonl
{
  "ts": "2026-05-22T18:08:51Z",
  "connectorAccountId": "ca_...",
  "path": "Companies/rec123.json",
  "conflictingKeys": [
    "properties.industry"
  ]
}
```

The log uses POSIX `O_APPEND` for single-write atomicity (entries are well under `PIPE_BUF`). At 2 MB the file rotates to `conflicts.log.1` (overwriting any prior rotated file). There's no UI for surfacing these yet — they're an audit trail.

## See also

- [REVIEW_MODEL.md](REVIEW_MODEL.md) — accept/reject/discard semantics; the patch file format.
- [REPO_STRUCTURES.md](REPO_STRUCTURES.md) — on-disk layout (`.scratch/connections/<conn>/`, `refs/heads/main`, etc.).
- [The workspace-simplification plan](../../docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md) — slice D (refuse-or-replay pull), `mr17` (publish reconcile), `mr35` (publish staleness gate).
