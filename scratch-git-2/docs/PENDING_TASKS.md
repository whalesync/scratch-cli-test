# Pending Tasks

These items are intentionally tracked as follow-up work, not current merge blockers.

## Non-blocking follow-ups

### 1. Service-side worktree leak on legacy publish-plan route

Status: pending, non-blocking

Context:

- The git service still has a legacy route at `/api/repo/publish-plan/{id}/build`.
- That route creates linked git worktrees for `dirty` and `main` via [`TempWorktree`](/Users/ijd/repos/spinner/scratch-git-2/src/service/worktree.rs).
- If cleanup does not happen cleanly, the repo can be left with `dirty` checked out in a linked worktree.
- When that happens, later CLI uploads to `dirty` fail with a push rejection like `branch is currently checked out`.

Notes:

- This is currently considered non-blocking because the active creator appears to be a manual/devtool action used on test workbooks.
- The currently known caller is the web app devtool action in [use-git-actions.ts](/Users/ijd/repos/spinner/client/src/hooks/use-git-actions.ts), exposed through [use-connection-menu.tsx](/Users/ijd/repos/spinner/client/src/hooks/use-connection-menu.tsx) as `Build Publish Plan`.

Recommended follow-up:

- Replace service worktree materialization with the planned structured `.temp` layout.
- Or disable/remove the legacy route if it is no longer needed.
- Or harden cleanup so leaked linked worktrees cannot block later pushes.

### 2. Improve CLI upload error reporting for leaked worktrees

Status: pending, non-blocking

Context:

- The CLI upload retry loop currently collapses repeated remote push rejections into:
  `Upload failed after 5 attempts due to concurrent changes on the server`
- In the leaked-worktree case, that message is misleading.

Recommended follow-up:

- Preserve and surface the final underlying git push error when retries are exhausted.
- Prefer a message that distinguishes true concurrent changes from server-side branch/worktree rejection.

### 3. Upload silently discards accepted local changes

Status: pending, bug

Context:

- `upload_single_repo` in `src/cli/commands/files.rs` reads the current dirty ref into `base_map` (line 496-497), then calls `prepare_upload_merge(&base_map, &base_map, &remote_map, attempt)` (line 520).
- Passing `base_map` as both the base (common ancestor) and the local side tells the three-way merge there are no local changes.
- After `accept-all` commits changes to the dirty ref, `base_map` includes those changes. But the merge treats them as the baseline, not as new work. The merge result equals the remote, so the upload concludes "Remote already has all local changes" and resets the dirty ref to match origin/dirty (line 535), destroying the accepted changes.

Reproduction:

1. `scratchmd linked pull` to get files
2. Edit a record file on disk
3. `scratchmd files accept-all` (commits the change to local dirty ref)
4. `scratchmd files upload` → reports "Remote already has all local changes", accepted commit is gone

Fix:

- The local side of the merge should be the current dirty tree (with accepted changes).
- The base should be the last known common state with the remote (e.g., origin/dirty before fetching, or the pre-accept-all dirty hash).

### 4. Upload appears to hang on large workspaces (no progress output)

Status: **fixed** (2026-04-05)

Context:

- The `scratchmd files upload` command appeared to hang on a production workspace (wkb_wi45a7p30d, ~23,500 files). Root cause: per-blob `gix::find_blob()` calls took ~39s per tree read (called 3 times = ~117s), with no user-visible output.

Fix applied (three changes):

1. **Progress output**: upload now prints phase status ("Reading local state...", "Fetching remote changes...", "Merging...", "Pushing...") to stderr. Suppressed in `--json` mode.
2. **Tree cache**: `TreeCache` avoids redundant reads of the same git tree hash during a single upload.
3. **Batched blob reads**: replaced per-blob `gix::find_blob()` with `git ls-tree` piped into `git cat-file --batch`. Each tree read dropped from ~39s to ~3s.

Result: upload time on the 23,500-file workspace went from **124s → 11.6s** (10.7x faster).

Remaining follow-up: consider adding a timeout on git network operations (`fetch`/`push`) to catch actual network hangs.

### 5. Service temp materialization refactor

Status: pending, non-blocking

Context:

- The original refactor plan still includes moving service materialization to the structured `.temp/...` layout using `WorkspaceLayout::for_service()`.
- This has not been implemented yet.

Recommended follow-up:

- Update [worktree.rs](/Users/ijd/repos/spinner/scratch-git-2/src/service/worktree.rs) and related service callers to use structured temporary materialization without changing the production repo/index storage contract.
