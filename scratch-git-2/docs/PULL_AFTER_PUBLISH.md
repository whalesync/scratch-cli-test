# Pull After Publish

## What Changed

After a publish job completes successfully in the desktop app, we now automatically trigger `scratchmd files download` to sync the local workspace with the updated remote state.

## Why

Publish is server-side: the server updates `refs/heads/main` (published records) and force-rewrites `refs/heads/dirty` (rebasing it onto the new main, stripping published records). The local workspace is unaware of these changes until an explicit pull happens. Without this, the desktop app shows stale state — records appear unpublished even though they were just pushed.

## What the Pull Does

1. `fetch_origin` — pulls latest `refs/remotes/origin/*` from remote
2. Overrides local master worktree from new `refs/heads/main`
3. Three-way merges the dirty branch: base=local dirty ref, local=working copy, remote=new remote dirty

## Known Limitation: Force-Rewritten Dirty Branch

The current three-way merge uses the **local dirty ref as the merge base**. After a publish, the server force-rewrites dirty (rebases onto new main), which means local dirty ref and remote dirty ref share no common ancestor. The merge base is therefore wrong, and the merge cannot safely distinguish "server changed this" from "this is unrelated history divergence."

**Impact**: Unreviewed local changes (edits in the working copy not yet committed to the dirty ref) may not survive the merge correctly if the dirty branch was significantly rewritten.

**Next step**: Replace the post-publish three-way merge with a content-delta strategy:
1. Before pulling, snapshot `unreviewed_delta = diff(local_dirty_ref, working_copy)`
2. Completely override local dirty ref from remote
3. Rematerialize working copy from new dirty ref
4. Replay `unreviewed_delta` on top

This makes the merge independent of git history entirely. See also `SMART_REBASE_AFTER_PUBLISH.md` for the server-side rebase strategy.

## Manual Refresh

A manual "Refresh from remote" button on the debug page is a planned companion to this feature, allowing users to re-pull at any time (e.g. if another session or user has made remote changes).
