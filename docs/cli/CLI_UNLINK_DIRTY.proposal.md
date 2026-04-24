# CLI Unlink Dirty

This note proposes a cleaner CLI model where local approved state and remote approved state are no longer implicitly merged into each other.

The current model in [CLI_UPLOAD_DOWNLOAD.md](./CLI_UPLOAD_DOWNLOAD.md), [upload.drawio](./upload.drawio), and [download.drawio](./download.drawio) makes `dirty` do two jobs at once:

1. local approved state
2. local mirror of `origin/dirty`

That coupling is the root of most of the mental-model and correctness pain.

## Problem Statement

Today the default flows do all of this automatically:

- `workspaces init` clones all refs and materializes local `dirty` from the remote repo
- `files upload` merges local `dirty` with `origin/dirty`
- `files download` merges local `dirty` with `origin/dirty` again
- both upload and download then rebase the working tree on top of the new local `dirty`
- `publish-from-git` still expects the publish plan to be pushed into `dirty`

This means local `dirty` is not really "my approved local branch". It is a moving blend of:

- my approved local changes
- remote unpublished server state
- publish metadata that exists only to drive a publish run

That causes several concrete problems:

- init pulls in remote unpublished work even when the user only wanted a local workspace
- upload mutates local approved state as a side effect of pushing
- download mutates local approved state as a side effect of fetching
- partial publish is hard to reason about because post-publish canonical state comes back through the same `dirty` path
- it is difficult to explain which branch is authoritative for what

## Design Goal

Make the states explicit:

- `main` is the canonical published baseline
- local `dirty` is approved local work only
- `origin/dirty` is remote approved work only
- the working tree is still local `dirty` plus unapproved edits
- publish runs from an immutable snapshot ref, not from a moving dirty branch

The key behavior change is:

`origin/dirty` is no longer part of normal init, upload, or download.

It only enters local state through an explicit command.

## Proposed State Model

| Ref / View | Meaning | Updated By |
|---|---|---|
| `refs/remotes/origin/main` | Canonical published server state | fetch, server publish |
| `refs/heads/main` | Local mirror of published state | download |
| `refs/heads/dirty` | Approved local state only | accept/reject/discard/rebase-local |
| working tree | `dirty` plus unapproved edits | user edits |
| `refs/remotes/origin/dirty` | Remote approved queue | explicit sync, server-side dirty rebase |
| `refs/tags/publish-plan/<planId>` | Immutable publish snapshot | plan-publish + publish |

If renaming the local branch is too invasive, we can keep the actual branch name `dirty` and only change its meaning. The important change is semantic unlinking, not the ref name.

## New Default Flows

### 1. `workspaces init`

Recommended behavior:

1. Fetch `main` only.
2. Create local `refs/heads/main` from `origin/main`.
3. Create local `refs/heads/dirty` from local `main`.
4. Materialize the working tree from local `dirty`.
5. Do not fetch or materialize `origin/dirty` by default.

This makes a new workspace deterministic: it always starts from published state, not from unpublished remote queue state.

### 2. `files download`

Recommended behavior:

1. Fetch `origin/main`.
2. Fast-forward local `main`.
3. Rebase local `dirty` onto the new local `main`.
4. Rebase the working tree onto the new local `dirty`.
5. Refresh schema files and rebuild the local index.

Important change:

- `files download` does **not** merge `origin/dirty` into local `dirty`

So download becomes "refresh published canonical state", not "implicitly blend local and remote approved queues".

### 3. `files merge-remote-dirty`

This is the explicit operation that brings remote approved work into the local approved branch.

Recommended behavior:

1. Fetch `origin/dirty` on demand.
2. Require `origin/dirty` to be rebased on top of `origin/main`.
3. Merge `origin/dirty` into local `dirty` with `main` as the conceptual base.
4. Rebase the working tree onto the new local `dirty`.

This should reuse the same high-level strategy as local `dirty` rebasing, but it should be an explicit command, not a hidden side effect of download.

Strong recommendation:

- do not silently default to "ours wins" here
- if both sides changed the same JSON field, stop or surface a conflict

Once this is explicit, silent conflict resolution becomes much harder to justify.

### 4. `files sync-changes`

This replaces the current overloaded upload behavior.

Purpose:

- update `origin/dirty`
- do **not** mutate local `dirty`
- do **not** mutate the working tree

Recommended behavior:

1. Fetch `origin/main` and `origin/dirty`.
2. Compute the remote queue result from:
   - `base = origin/main`
   - `remote = origin/dirty`
   - `local = local dirty`
3. Create a new commit on top of `origin/dirty`.
4. Push that commit to `origin/dirty`.
5. Retry on non-fast-forward by refetching and recomputing.

Important change:

- this command pushes approved local state to the server
- it does not rewrite local approved state to match whatever got pushed

That keeps the local branch stable and avoids the current "push also mutates my local baseline" behavior.

Also:

- `sync-changes` should sync approved data only
- publish-plan files should not be smuggled through this command

Publish should use its own immutable snapshot ref instead.

## Publish Flow

### High-Level Shape

Publish should stop depending on `origin/dirty` as the transport branch for the exact publish input.

Instead:

1. build a local publish plan from local `dirty` vs local `main`
2. create an immutable publish snapshot ref
3. push that snapshot ref
4. publish from that snapshot ref
5. reconcile `main`, `origin/dirty`, local `dirty`, and the working tree after publish completes

### Why a Snapshot Ref Matters

The current CLI writes plan files to disk under `.scratch/.publish-plans/...`, but they are not part of the committed local `dirty` state.

So "tag the local dirty branch tip and publish from that" is not quite enough on its own.

We need one of these:

1. commit plan files into local `dirty`
2. create a separate snapshot commit that includes local `dirty` plus the plan files

The second option is cleaner.

Recommended rule:

- local `dirty` stays clean and represents approved content only
- publish creates a temporary snapshot commit that includes the plan files
- the snapshot commit is tagged with the publish plan id

That gives publish an immutable input without polluting the normal local branch with ephemeral plan artifacts.

### Recommended Publish Steps

1. Run `plan-publish` against local `dirty` vs local `main`.
2. Build a publish snapshot commit:
   - tree = local `dirty`
   - plus `.scratch/.publish-plans/<planId>/...`
3. Tag that commit as `refs/tags/publish-plan/<planId>`.
4. Push the tag.
5. Call `publish-from-git` with both:
   - `ref = refs/tags/publish-plan/<planId>`
   - `planPath = .scratch/.publish-plans/<planId>`
6. Server publishes from that immutable ref and writes canonical results to `main`.
7. Server rebases `origin/dirty` onto the new `main`, removing the paths that were just published.
8. Client runs normal `files download`.
9. Client rebases local `dirty` onto the new local `main`, with `main` winning only inside the published scope.
10. Client rebases the working tree onto the new local `dirty`.

## Critical Improvements Over The Raw Proposal

### 1. Do not globally apply "main wins" after publish

"Main wins" is correct for the paths that were just published, because the server may have written canonical data:

- server-assigned IDs
- timestamps
- normalized field formats
- connector-managed rewrites

But global `main wins` is too destructive for partial publish.

Example:

- local `dirty` contains changes in `posts/` and `authors/`
- publish only includes `posts/`
- after publish, `main` is authoritative for `posts/`
- local approved changes in `authors/` still need to survive

So the rebase rule should be:

- for paths inside the published scope: `main` wins on conflict
- for paths outside the published scope: keep local approved changes

This is the biggest improvement I would make to the original idea.

### 2. Rebase `origin/dirty` by subtracting the published scope

After publish, `origin/dirty` should not simply be "old dirty rebased on new main".

If the published snapshot overlaps with `origin/dirty`, blindly rebasing the whole old tree leaves already-published changes queued again.

Safer rule:

1. start from new `main`
2. keep only the remote dirty changes that were **not** part of the published scope
3. replay those remaining changes onto new `main`

In the first version this can be path-scoped.
Later it can become field-scoped using publish-plan metadata.

### 3. Publish should not depend on `sync-changes`

`sync-changes` and `publish` are different operations:

- `sync-changes` updates the remote approved queue
- `publish` consumes an immutable snapshot

The user should be able to:

- sync without publishing
- publish without first mutating `origin/dirty`

That separation makes both commands easier to reason about and easier to test.

### 4. `origin/dirty` should be rebased on `main` as an invariant

This proposal becomes much simpler if the server keeps:

`merge-base(origin/main, origin/dirty) == origin/main`

after every successful publish.

That turns remote dirty into "queued approved delta on top of main", which is much easier to merge into local dirty and much easier to push into from local dirty.

## Command-Level Model

Recommended CLI shape:

| Command | Meaning |
|---|---|
| `workspaces init` | fetch `main`, seed local `dirty` from `main` |
| `files download` | refresh `main`, rebase local `dirty`, rebase working tree |
| `files merge-remote-dirty` | explicitly bring `origin/dirty` into local `dirty` |
| `files sync-changes` | explicitly push local `dirty` into `origin/dirty` |
| `plan-publish` | build plan from local `dirty` vs local `main` |
| `publish-from-git` | publish from immutable snapshot ref |

If we want to keep backward compatibility, `files upload` can temporarily remain as an alias for `files sync-changes`, but its behavior should stop mutating local dirty/worktree.

## Implementation Impact

This proposal maps fairly directly onto the current code:

- `scratch-git-2/src/cli/commands/workspaces.rs`
  - init should clone/fetch `main` only
  - local `dirty` should be seeded from local `main`, not materialized from remote `dirty`

- `scratch-git-2/src/cli/git_ops/remote.rs`
  - fetch should support ref-specific on-demand fetches instead of always fetching every branch

- `scratch-git-2/src/cli/commands/files.rs`
  - `download_single_repo` should stop reading `origin/dirty`
  - current upload logic should split into:
    - `merge-remote-dirty`
    - `sync-changes`
  - post-publish rebase should become scope-aware

- `scratch-git-2/src/cli/commands/plan_publish.rs`
  - publish should create and push a snapshot ref

- `server/src/cli/cli-workbook.controller.ts`
  - publish endpoint should accept a git ref, not implicitly read from `dirty`

- `server/src/publish-plan/publish-from-git.service.ts`
  - plan loading should read from the supplied ref instead of hardcoding the dirty branch

## Migration Strategy

Recommended rollout:

1. Keep the local branch name `dirty`, but change its semantics to local-only.
2. Make `workspaces init` and `files download` main-only.
3. Add explicit `files merge-remote-dirty`.
4. Split current upload into explicit `files sync-changes`.
5. Add immutable publish snapshot refs.
6. Make post-publish reconciliation scope-aware.
7. Only after that, remove the old implicit local/remote dirty merge path.

This reduces churn while still changing the mental model in the right order.

## Bottom Line

The proposal is directionally correct and worth doing.

The core win is not just "fetch less on init". The real win is:

- local `dirty` stops being a transport branch
- `origin/dirty` stops being part of normal local refresh
- publish runs from an immutable snapshot
- post-publish canonical state comes back through `main`

The two changes I would insist on are:

1. publish from a snapshot commit/tag, not directly from the raw local dirty tip
2. after publish, apply `main wins` only inside the published scope, not globally

Without those two refinements, the design is still cleaner than today, but partial publish and canonical post-publish reconciliation will still be too lossy.
