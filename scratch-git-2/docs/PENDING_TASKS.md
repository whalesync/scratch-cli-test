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

### 3. Service temp materialization refactor

Status: pending, non-blocking

Context:
- The original refactor plan still includes moving service materialization to the structured `.temp/...` layout using `WorkspaceLayout::for_service()`.
- This has not been implemented yet.

Recommended follow-up:
- Update [worktree.rs](/Users/ijd/repos/spinner/scratch-git-2/src/service/worktree.rs) and related service callers to use structured temporary materialization without changing the production repo/index storage contract.
