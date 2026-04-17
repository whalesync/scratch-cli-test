# Desktop App: Per-Session Branch Design

## Background

The desktop app (via the `scratchmd` CLI) currently shares the `dirty` branch with the web app for every connection repo. Each connection repo has exactly two permanent branches:

| Branch | Purpose |
|--------|---------|
| `main` | Published truth — only written by pull/publish jobs |
| `dirty` | Shared mutable working copy — both web and desktop write here |

The desktop maintains a **local bare repo** (`.repos/{connectorAccountId}.git`) that tracks `origin/dirty`. When the user accepts file changes locally, they are committed to the local `refs/heads/dirty`. The `files upload` command merges local `refs/heads/dirty` with `refs/remotes/origin/dirty` (3-way merge) and pushes. The server reads `dirty` to build publish plans and execute publishes.

### Current Pain Points

1. **Shared mutable state**: Web app edits to `dirty` can conflict with desktop edits during upload's 3-way merge. The merge resolution favors neither source — it applies git content merging, which can produce unwanted results.
2. **Discard coupling**: When a user discards a newly created record locally, the server's `dirty` branch still has it (since it was uploaded). The `discard_remote_dirty_changes` endpoint exists solely to patch this up — it's a documented short-term workaround (see `files.rs:1556`).
3. **Multi-client collisions**: Two desktop clients sharing the same workbook collide on `dirty` at upload time.
4. **Publish scope confusion**: The publish plan is built from the full `dirty` diff, which may include web-originated changes the desktop user didn't intend to include.

---

## Proposed Design: Per-Session UUID Branch

Each workspace init generates a UUID and creates a private branch `desktop/{uuid}` on the server, forking from `main` at that moment. All desktop operations read/write this branch exclusively. The web app continues using `dirty` unchanged.

### Branch Naming

```
desktop/{uuid}     # e.g. desktop/f47ac10b-58cc-4372-a567-0e02b2c3d479
```

- The `desktop/` namespace prefix makes it easy to list, audit, and garbage-collect all desktop branches.
- The UUID is a v4 UUID generated at `workspaces init` time.
- Stored in `.scratch/.scratchmd` as a new field `desktop_branch_id`.

---

## Flow Changes Per Operation

### `workspaces init`

**Current**: clones the remote and checks out `dirty` branch locally.

**New**:
1. Generate a UUID (or receive one from server — see discussion below).
2. Call a new API endpoint `POST /workbooks/{workbookId}/connectors/{connectorAccountId}/desktop-branch` with `{ branchName: "desktop/{uuid}" }`.
3. Server creates `desktop/{uuid}` as a copy of `main`'s current HEAD on the server-side bare repo.
4. Clone the bare repo locally (`.repos/{connectorAccountId}.git`).
5. Check out `desktop/{uuid}` (not `dirty`) as the working branch in both the editing worktree (`{ConnectorDirName}/`) and the reviewed-dirty snapshot (`.scratch/connections/dirty/{ConnectorDirName}/`).
6. Still check out `main` into `.scratch/connections/master/{ConnectorDirName}/`.
7. Write `desktop_branch_id: {uuid}` into `.scratch/.scratchmd`.

**Key insight**: At init time, the starting point is `main`, not `dirty`. This means the user begins with a clean slate — no pending web-app changes bleed into their desktop session. Web-originated pending changes on `dirty` are simply invisible to the desktop workflow.

### `files download`

**Current**: fetches `origin/dirty`, 3-way merges with local `dirty`, applies merge actions to working tree.

**New**:
1. `git fetch origin main` — fetch only `main`, nothing else.
2. If `origin/main` has advanced: rebase local `refs/heads/desktop/{uuid}` onto the new `origin/main`.
   - Standard case: server published something, `main` moved forward.
   - Rebasing UUID onto new `main` = "incorporate published changes, keep pending work on top."
3. Apply resulting changes to working tree.

**Local changes stay local.** The UUID branch is never fetched from the remote during download — it only goes up on upload. There is no `origin/desktop/{uuid}` to reconcile with. This eliminates the remote-dirty 3-way merge entirely and means download is a pure "pull in what was published" operation.

### `files accept` / `accept-all`

No change in mechanics. The commit target is now `refs/heads/desktop/{uuid}` instead of `refs/heads/dirty`. The function `commit_file_map_to_dirty_ref` should be renamed or parameterized to `commit_file_map_to_branch(branch_name)`.

### `files upload`

**Current**: 3-way merges local `refs/heads/dirty` with `refs/remotes/origin/dirty`, pushes to `origin/dirty`.

**New**: Force-push `refs/heads/desktop/{uuid}` to `origin/desktop/{uuid}`.

Because local changes are never fetched back down, and the UUID branch is private to this session, the remote is always behind or equal — force push is safe and correct. No merge needed.

**Open question: do we need to upload the full record data, or just the publish plan?**

The server only needs the UUID branch content to execute `publish-from-git`. That execution reads the plan files (`plan.json` + phase files). The actual record JSON files are used only to *build* the plan locally via `plan-publish`, which already runs on the local UUID branch before upload. Two possible scopes for upload:

- **Full branch upload** (current mental model): push all record files + plan files. Simpler — the server has a complete copy of the desktop's state. Required if we ever want the server to re-build the plan (e.g., server-side plan validation).
- **Plan-only upload**: cherry-pick only the plan artifact commits onto the remote UUID branch, leaving the record data local. Smaller push, less data on the server. Sufficient for `publish-from-git` today.

**Recommendation**: start with full branch upload (simpler, no special logic). Revisit plan-only if push size becomes a practical concern — e.g., workbooks with large record JSON files.

### `plan-publish`

**Current**: diffs `dirty` vs `main` to identify what to publish.

**New**: diffs `desktop/{uuid}` vs `main`. The reviewed-dirty snapshot at `.scratch/connections/dirty/{ConnectorDirName}/` already mirrors the UUID branch (since init checks out UUID there). No changes needed in `build_publish_plan_with_scratch_dir` — it reads from the snapshot directory, which is still correct.

Plan files are committed back to `desktop/{uuid}` on the server (currently they go to `dirty` — the API endpoint `plan_publish.rs` → service-side `build_plan` needs the branch name parameter).

### `publish-from-git`

**Current**: `POST /workbooks/{workbookId}/publish-v2/run-from-git` with `connectorAccountId`. Server reads plan from `dirty`.

**New**: Same endpoint, add `branchName: "desktop/{uuid}"` to the request body. Server reads plan from and executes against `desktop/{uuid}`.

After publish, the server's existing post-publish rebase logic (`rebase_dirty()`) runs on `desktop/{uuid}` instead of `dirty`. This rebases the UUID branch onto the new `main`, which removes already-published files from the diff naturally.

### `discard-created-record`

**Current**: Two-phase operation — local discard + `discard_remote_dirty_changes` server call (the documented workaround).

**New**: Local discard only. Because the UUID branch is private to this desktop session, there is no risk of the file re-appearing from another client's perspective. The discard removes the file from local `refs/heads/desktop/{uuid}`. On the next `files upload`, the deletion propagates to `origin/desktop/{uuid}`.

The `discard_remote_dirty_changes` endpoint and the workaround comment at `files.rs:1556` become unnecessary once all desktop workspaces migrate to UUID branches.

---

## Post-Publish Branch Lifecycle

This is the most nuanced part of the design. There are three scenarios:

### Scenario A: Full Publish (all accepted records published)

1. User has accepted 10 files → all committed to `desktop/{uuid}`.
2. Runs `plan-publish` covering all 10 files.
3. Publish succeeds.
4. Server rebases `desktop/{uuid}` onto new `main`.
5. The diff between `desktop/{uuid}` and `main` is now **empty** — every accepted record is now on main.
6. **The UUID branch can be deleted.**

Detection: after rebase, if `git diff main..desktop/{uuid}` produces no file changes, the branch is a candidate for deletion. The server can return a `{ branchClean: true }` signal in the publish response, and the CLI can either leave it (for future accepts) or trigger cleanup.

**Recommendation**: Do not auto-delete on the server. Instead, the CLI detects the empty diff and re-uses the same UUID branch for the next accept cycle. Branch deletion should be explicit (on `workspaces unsync` or by a TTL cleanup job).

### Scenario B: Partial Publish (one record from many)

This is the user's key concern. Say the user has 10 accepted records on `desktop/{uuid}`, but only wants to publish 1 (`plan-publish --filter path/to/record.json`).

1. Plan covers only the 1 filtered record.
2. Publish succeeds; `main` now includes that 1 record.
3. Server rebases `desktop/{uuid}` onto new `main`.
   - The rebase removes the 1 published record from the UUID diff (it's now identical to `main`).
   - The 9 remaining records are still diverged from `main` and stay in the UUID branch.
4. **UUID branch must survive** — it still has 9 records pending publish.
5. CLI runs `files download` post-publish, which fast-forwards local UUID branch from the rebased `origin/desktop/{uuid}`.
6. User runs `plan-publish` again for the remaining 9.

**There is no loss of pending work in this scenario.** The UUID branch accumulates records, publishes peel them off one at a time, and the branch naturally converges toward `main` as more records are published.

### Scenario C: Failed Publish

1. Publish starts for 5 records, 3 succeed, 2 fail.
2. Server writes the 3 successfully published records to `main`.
3. Server rebases `desktop/{uuid}` onto new `main` — the 3 successes drop out of the diff.
4. The 2 failed records stay in `desktop/{uuid}`.
5. CLI pulls down the partial success state.
6. User sees 2 remaining unpublished records; can retry or investigate.

This is identical to the current `dirty`-branch behavior after a partial publish. No regression.

---

## Impact on Server Code

### `scratch-git-2` service (`/scratch-git-2/src/service/`)

**New route**: `POST /repos/{repoId}/branches` (or route `manage.rs`) — creates branch `desktop/{uuid}` from current `main` HEAD. Returns the branch ref. Idempotent: if branch already exists, return it.

**Modified `rebase.rs`** (`rebase_dirty`): parameterize `source_branch` instead of hardcoding `DIRTY_BRANCH`. The server-side rebase after publish should target `desktop/{uuid}` when called from a desktop publish.

**Modified `plan_publish.rs` (service)**: accept `branch_name` in the build-plan request. The branch name determines which worktree to materialize for the diff and where to commit plan files back.

**Modified `manage.rs`** (`reset`): the `discardChanges` endpoint currently resets a path on `dirty` to its `main` state. For UUID branches, the same endpoint can accept a `branchName` parameter. (Or: since discard no longer needs server coordination, this endpoint becomes unused for desktop flows.)

### NestJS server (`/server/src/`)

**New endpoint**: `POST /workbooks/{workbookId}/connectors/{connectorAccountId}/desktop-branch` in `cli-workbook.controller.ts`. Calls new `scratchGitService.createBranchFromMain(repoId, branchName)`.

**Modified publish endpoint** (`publish-from-git.service.ts`): accept optional `sourceBranch` parameter (defaults to `"dirty"` for backward compatibility). The `rebase_dirty` call after publish passes `sourceBranch`.

**Modified publish plan endpoint** (`publish-plan-build.service.ts`): accept `branchName` to scope the plan to a specific branch.

**`WorkbookService.delete`**: iterate all `desktop/*` branches in each connection repo and delete them (via `scratchGitService.deleteBranch`). Currently only repos are deleted in bulk — branch cleanup within repos is handled by the repo deletion itself, so this may be a no-op if repos are deleted entirely. Worth auditing.

**Branch cleanup job** (new): a scheduled job that deletes `desktop/{uuid}` branches with no commits in N days (e.g., 30 days), for workbooks that haven't been explicitly unsynced.

---

## Impact on CLI Code (`/scratch-git-2/src/cli/`)

### `workspaces.rs` (`init_v2`)

1. Generate `uuid::Uuid::new_v4()` as `desktop_branch_id`.
2. Call new API `POST .../desktop-branch` with `{ branchName: format!("desktop/{}", desktop_branch_id) }`.
3. In `setup_connection()`: replace all references to `DIRTY_BRANCH` ("dirty") with the UUID branch name.
4. Write `desktop_branch_id` to `.scratchmd` config.

### `files.rs`

1. Load `desktop_branch_id` from workspace context (`.scratchmd`).
2. All `DIRTY_BRANCH` references in download/upload/accept/reject should use the UUID branch name.
3. Remove `discard_remote_dirty_changes` server call from `run_discard_created_record` (simplify to local-only).

### Constants (`workspaces.rs` line 11)

`DIRTY_BRANCH = "dirty"` remains for workspaces that haven't migrated (backward compat). Add `DESKTOP_BRANCH_PREFIX = "desktop/"` and a `ConnectionContext` field `working_branch: String` populated at load time from `.scratchmd`.

### `plan_publish.rs`

Pass `working_branch` to the server-side publish and plan endpoints.

### Struct additions

```rust
pub struct ScratchConfig {
    // existing fields ...
    pub desktop_branch_id: Option<String>,  // None = legacy dirty-branch workspace
}

impl ScratchConfig {
    pub fn working_branch(&self) -> &str {
        match &self.desktop_branch_id {
            Some(id) => /* "desktop/{id}" */ ,
            None => DIRTY_BRANCH,
        }
    }
}
```

This `Option<String>` makes the migration non-breaking: existing workspaces without `desktop_branch_id` continue using `dirty` transparently.

---

## Impact on Desktop App (`/scratch-desktop/src/main/`)

### `scratchmd.ts`

`discardCreatedRecord`: remove the `discard_remote_dirty_changes` API call (currently in `run_discard_created_record` in `files.rs`, proxied through `scratchmd`). The function simplifies to just the local discard step.

No other changes needed — the desktop app doesn't inspect branch names directly; it delegates everything to the CLI binary.

### `index.ts`

No changes needed at the IPC layer.

---

## Migration Strategy

### Phase 1 (server + CLI): Non-breaking parallel support

- Server gains the new `POST .../desktop-branch` endpoint and the `branchName` parameter on publish/plan endpoints.
- CLI reads `desktop_branch_id` from `.scratchmd`; if absent, falls back to `dirty` for all operations.
- No existing workspaces break.

### Phase 2: New workspace inits use UUID branches

- `workspaces init` now generates the UUID and creates the branch.
- Existing workspaces (created before Phase 2) continue using `dirty` until the user runs `workspaces init` again.
- Consider adding `scratchmd workspaces migrate` to upgrade a workspace in-place: creates the UUID branch from current `dirty` HEAD, writes `desktop_branch_id` to `.scratchmd`. This preserves any accepted-but-unpublished work.

### Phase 3 (future): Deprecate shared dirty for desktop

- Once all desktop workspaces are on UUID branches, remove the `discard_remote_dirty_changes` endpoint and the workaround comment.
- The `dirty` branch continues to exist and be used by the web app. Desktop never touches it.

---

## Edge Cases and Open Questions

### Same workspace init on two machines

If a user clones their workspace directory to a second machine (copies the `.scratchmd` file), both machines would share the same `desktop_branch_id`. The first machine's push would succeed; the second's would require a 3-way merge.

**Options**:
1. Disallow sharing workspace directories (document it). Each machine must `workspaces init` separately.
2. Allow sharing but treat it like today's dirty-branch sharing (with 3-way merge on upload).
3. Generate a new sub-branch per machine: `desktop/{workspaceUuid}/{machineId}`. Adds complexity.

**Recommendation**: Option 1 for now — document that each machine needs its own `workspaces init`. This is arguably already true for the current setup (two machines sharing a `.repos/` directory would have filesystem conflicts).

### Web app and desktop diverge on the same record

A user approves a record on the desktop (it's in `desktop/{uuid}`, not `dirty`). A web app user edits the same record (it's in `dirty`). Both publish.

- If desktop publishes first: record goes to `main` from UUID branch. Web app then publishes, overwriting with its version. Standard last-write-wins, same as today.
- No special handling needed — the isolation between UUID and dirty branches doesn't change conflict semantics at the publish stage.

### Many old desktop branches accumulating

Over time, `desktop/` branches multiply on the server (one per workspace init). A workbook with 10 developers who each re-init every month would accumulate 10 branches/month.

**Mitigation**:
1. `workspaces unsync` must delete the UUID branch on the server (add this step).
2. TTL cleanup job: delete branches with no commits after 30 days (soft; log before delete).
3. `WorkbookService.delete` already tears down all repos — this covers hard cleanup.

### Plan files on the UUID branch

Today, `plan-publish` commits plan artifacts (phase files, `plan.json`) into the `dirty` branch so they're available server-side for `publish-from-git`. These need to go to `desktop/{uuid}` instead. The server-side plan-build endpoint must materialize from and commit back to the UUID branch.

If a plan is built but upload hasn't happened yet, the plan files exist only locally (same as today). The existing pre-publish step `files upload` before `publish-from-git` covers this. No change in the user's workflow.

### Fetch performance

Download fetches only `origin/main` — a single refspec. With many `desktop/{uuid}` branches accumulating on the server repo, the old `git fetch origin` (all refs) would have grown unbounded. This is no longer an issue: the download path is always a single-ref fetch regardless of how many desktop branches exist.

---

## Summary

| Concern | Current (shared dirty) | Proposed (UUID branch) |
|---------|------------------------|------------------------|
| Web/desktop isolation | None — share dirty | Full — separate branches |
| Init starting point | From remote dirty | From main |
| Download complexity | 3-way merge with remote dirty | Fetch main only, rebase UUID onto it |
| Upload complexity | 3-way merge + push to dirty | Force push UUID branch (local changes stay local until upload) |
| Discard-created workaround | Required (server sync) | Not needed |
| Partial publish | All-or-nothing UUID | UUID branch survives, rebased onto main |
| Full publish | Branch usable for next cycle | Branch empty, can reuse or delete |
| Multi-client safety | Dirty merges are messy | Each client has its own UUID |
| Migration | Automatic fallback via `Option` | Incremental via Phase 1/2/3 |

**The UUID branch design eliminates the root causes of the three biggest pain points** (shared dirty collisions, discard workaround, publish scope confusion) while maintaining full backward compatibility through the `working_branch()` fallback pattern.
