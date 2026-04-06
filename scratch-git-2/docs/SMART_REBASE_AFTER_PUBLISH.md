# Smart Rebase After Publish

## Goal

Speed up the final `publish-from-git` cleanup step.

Today, after the publish counters reach `N / N`, the job still runs a generic `dirty -> main` rebase. For large publishes this is expensive because it re-walks and rereads every changed file since `merge_base`, even though the publish path has already been updating `main` and `dirty` incrementally.

## Current Behavior

During `publish-from-git`, the server updates Git as it goes:

- `edit` / `backfill`
  - publish to remote
  - write the resolved content into `main`
  - write the same content into `dirty` when there is no later phase for that file
- `create`
  - publish to remote
  - write the returned record into `main`
  - write it into `dirty` when there is no later phase
- `delete`
  - delete remotely
  - delete from `main`
  - delete from `dirty`
- `rename`
  - rename in `dirty`
  - rename in `main` when the file already exists there
  - reuse existing blob OIDs for the renamed file content

After all of that, we still run the generic service rebase:

- compare `merge_base -> dirty`
- read dirty/base/main content for changed files
- force `dirty = main`
- replay surviving edits
- write a new dirty commit
- move `merge_base`

That generic rebase is correct, but it is often redundant after a successful publish.

## Main Observation

After a successful publish, the new local `main` branch is already our local source of truth.

That is already how the current system behaves:

- we do not generally refetch records after update
- we trust the resolved payload we committed into `main`
- for creates, we may use the connector-returned record, but not a second fetch

So after a successful publish we can usually assume:

- `main` contains the published state we want
- many or all published paths in `dirty` have already been synchronized
- the expensive generic rebase is mostly just rediscovering that fact

## Proposed Strategy

Use a publish-aware finalize step instead of a generic rebase.

There are two levels.

### Level 1: Cheap Fast Path

After publish succeeds:

1. Read current `main` OID.
2. Read current `dirty` OID.
3. If the `main` and `dirty` tree OIDs are equal:
   - do not run generic rebase
   - just move `merge_base` to current `main`
   - finish the job

Why this helps:

- in the common case, publish has already fully synchronized `dirty`
- the final generic rebase becomes unnecessary
- this should collapse the long `10k / 10k` tail into a nearly constant-time finalize

### Level 2: Publish-Aware Smart Finalize

If `dirty` is not equal to `main`, build the new dirty state directly instead of using the generic `merge_base -> dirty` diff3 rebase.

High-level algorithm:

1. Let `main_end` be the current `main`.
2. Let `dirty_end` be the current `dirty`.
3. Treat `main_end` as the authoritative published state.
4. Compute the residual dirty-only delta that still needs to survive after publish.
5. Build a new dirty tree as:
   - start from `main_end`
   - reapply only the residual dirty-only changes
6. If the resulting tree equals `main_end`, fast-forward `dirty` to `main_end`.
7. Otherwise write one squashed dirty commit on top of `main_end`.
8. Move `merge_base` to `main_end`.

## How To Compute The Residual Dirty Delta

The most practical version is:

- compare `main_end` vs `dirty_end`
- preserve only the files that still differ at the end of publish

That is better than diffing `merge_base_start -> dirty_start`, because:

- publish may have already rewritten some files in `dirty`
- create may have replaced temporary IDs with real remote IDs
- rename may have changed file paths while reusing blob OIDs

So the best input for finalize is the end state, not the pre-publish state.

Residual dirty-only cases:

- added in `dirty_end`: keep the file in new dirty
- modified in `dirty_end`: keep the dirty version in new dirty
- deleted in `dirty_end`: keep the deletion in new dirty

For untouched files that still differ at the end:

- reuse the blob OID from `dirty_end`
- do not reread and rewrite content if the OID is already known

This matches the existing tree builder design, which already supports `FileChange { oid: Some(...) }`.

## Important Optimization

For surviving dirty-only files, reuse existing Git objects instead of rebuilding content.

That means:

- if a file survives exactly as it exists in `dirty_end`, carry its blob OID forward
- only the enclosing trees need to be rewritten
- untouched content does not need to be reparsed, remerged, or rewritten

This is the same idea already used by the rename route.

## Safety Rules

The smart finalize should only run when all of these are true:

- the publish job succeeded
- every batch that was supposed to write `main` or `dirty` completed successfully
- we are finalizing one repo in one atomic service-side operation

Fallback behavior:

- if any invariant looks wrong, fall back to the current generic `rebase_dirty("diff3")`

Examples of fallback conditions:

- unexpected missing file index entries during rename handling
- a connector batch reported success but local Git writes for that batch failed
- dirty/main state is internally inconsistent in a way the publish-aware logic does not expect

## Possible Problems

### 1. Local `main` Is Only As Correct As The Publish Path

For updates, we usually do not refetch the remote record after publish.

That means the smart finalize assumes:

- the content we wrote into `main` is the canonical local truth

This is not a new risk; it is already the contract of the current publish flow.

### 2. Partial Failure Semantics

If some batches succeeded and others failed, the publish-aware finalize gets harder.

In that case, the safest behavior is probably:

- keep the current generic rebase
- or skip finalize entirely and fail the job

Do not try to be clever in mixed-success states on day one.

### 3. Rename Handling Must Be Explicit

Rename is path-based, not just content-based.

The finalize step must treat rename as:

- delete old path
- add new path

Using the end-state `dirty` tree avoids most of the complexity here, because rename has already been applied.

### 4. Deletes Need Tree Surgery, Not Blob Reuse

For surviving deletes there is no blob to reuse.

The smart finalize still needs to express:

- remove path from the new dirty tree

That is straightforward, but different from the add/modify OID-reuse path.

### 5. Scope Must Match Current Rebase Rules

The current generic compare skips dotfiles and `.scratch` content.

The smart finalize should preserve the same effective scope unless we intentionally change the model.

### 6. Atomicity Matters

This should stay a service-side operation on the bare repo.

Do not materialize temp worktrees for this optimization:

- it adds filesystem IO
- it is likely slower than object-level tree surgery
- it reintroduces linked-worktree operational risk

## Recommended Implementation Plan

### Phase 1

Add the cheap fast path:

- if `dirty` tree OID equals `main` tree OID at end of publish
- just update `merge_base`
- skip generic rebase

This is the highest-value, lowest-risk improvement.

### Phase 2

Add a dedicated `finalize_after_publish()` helper in the scratch-git service:

- input: current `main`, current `dirty`
- output: finalized `dirty` and updated `merge_base`

Behavior:

- if trees equal: fast-forward dirty + move `merge_base`
- else build new dirty from `main_end + residual dirty-only delta`

### Phase 3

Only if needed, keep the old generic rebase as a fallback path for:

- partial failure recovery
- unexpected state mismatches
- debug mode

## Implementation Difficulty

### Phase 1: Easy

Difficulty: low

Why:

- only needs tree OID comparison plus tag/ref update
- very small surface area
- easy to test

Expected result:

- should eliminate the long tail for the common case where `dirty` already matches `main`

### Phase 2: Medium

Difficulty: medium

Why:

- needs a new publish-aware finalize helper
- needs careful handling of add/modify/delete semantics
- needs good tests around rename and mixed table phases

Why it is still tractable:

- the repo layer already supports tree rewriting and OID reuse
- the rename route already contains a similar “smart dirty commit” pattern
- the logic can operate entirely on bare repo objects without materializing a worktree

### Phase 3: Hard Only If We Try To Handle Every Edge Case Up Front

The tricky part is not the happy path. The tricky part is:

- partial failures
- ambiguous connector behavior
- future workflow changes that stop synchronizing `dirty` during publish

So the best path is:

- implement the simple fast path first
- measure
- only add the publish-aware rebuild if the fast path does not cover enough real cases

## Recommendation

Start with the smallest useful optimization:

- after a fully successful publish, if `dirty` already equals `main`, only move `merge_base`

If that still leaves real tail latency, add the publish-aware finalize that rebuilds `dirty` from `main_end` plus the residual dirty-only delta using OID reuse.

Do not switch to temp worktrees for this. The current object-level approach is the right foundation; the missing piece is a smarter finalize algorithm, not a different storage model.
