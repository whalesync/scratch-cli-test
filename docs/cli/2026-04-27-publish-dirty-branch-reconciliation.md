# Publish Dirty Branch Reconciliation

**Date**: 2026-04-27
**Status**: Draft

## Summary

Scratch currently uses `main` as the published baseline, `dirty` as the reviewed unpublished branch, and `merge_base` as the baseline for rebasing `dirty` onto `main`. That model is workable when there is exactly one dirty branch and the remote accepts our payload as-is. It becomes unclear once we have multiple dirty branches, partial publishes, or connectors that rewrite the data we send.

The core problem is simple:

- the publish plan is built from a dirty-vs-main diff
- publish then mutates branch state while that plan is being executed
- the remote's canonical result may not equal the payload we submitted

This doc lays out the invariants we actually need, describes the current behavior, and lists concrete broken states we should reproduce in tests before we change the model.

## Problem

Today the publish plan is derived from the reviewed unpublished delta. In the server-side planner, `PublishPlanBuildService.buildPipeline()` first calls `rebaseDirty(repoId)` and then builds the plan from `getRepoStatus(repoId)`. In other words, we intentionally normalize the baseline first and then plan from the remaining dirty delta.

That means the plan is based on a snapshot of unpublished intent, but `main` and `dirty` continue changing while the phases run.

Two facts make this hard:

1. `dirty` should stop looking unpublished after a successful publish.
2. The remote may return a canonical result that is not identical to what we wrote, because connectors can normalize HTML, trim strings, assign ids, rewrite timestamps, or ignore some fields entirely.

In Whalesync we mostly sidestep this by treating the returned version as canonical truth and accepting it with the original version timestamp so it does not boomerang back as another update. Scratch cannot do that blindly because Scratch has branch state and partial publishes.

## Terms

- `main`: published canonical local baseline
- `dirty`: reviewed unpublished branch used for planning
- `merge_base`: snapshot of `main` at the last dirty rebase
- `publish scope`: the records included in the current publish plan
- `canonical phase result`: the best local representation of what the remote now has after a successful phase
- `remaining publish delta`: the part of the original user intent that still has not reached the remote because later phases are still pending

## Invariants We Need

1. Successful published work must disappear from the unpublished diff.
2. Unpublished work outside the current publish scope must survive unchanged.
3. Connector canonicalization must flow back into `dirty`, otherwise `dirty` will try to undo the remote normalization on the next publish.
4. Partial phase success must preserve only the remaining publish delta, not the whole original dirty file.
5. Retry after failure must be deterministic. The branch should clearly say "this part already published, this part is still pending."
6. Desktop local state and shared remote unpublished state should not be implicitly merged as if they were one branch.

## Current Behavior

### Planning

- `PublishPlanBuildService.buildPipeline()` rebases `dirty` onto `main` before diffing.
- The planner strips deleted refs, pseudo-refs, and asset pseudo-refs.
- If stripping removed pseudo-refs or asset refs, the planner creates a later `backfill` operation.
- Creates with `scratch_pending_publish_*` filenames also get a later `rename-files` operation.

### `publish-from-git` execution

Current `PublishFromGitService` behavior is:

- `edit` / `backfill`
  - push update to connector
  - try to refetch the updated rows by id
  - commit refreshed content to `main`
  - sync the same content to `dirty` only if there is no later `backfill` or `delete`
  - `backfill` itself always syncs to `dirty`
- `create`
  - send stripped create payload
  - use the returned record, or the submitted payload as fallback
  - commit it to `main`
  - sync it to `dirty` only if there is no later `backfill` or `delete`
  - note: `rename` is not treated as a blocking later phase for this decision
- `delete`
  - delete from remote
  - delete from both `main` and `dirty`
- `rename`
  - rename in `dirty`
  - rename in `main` if the old path exists there
- after the loop, call `rebaseDirty(repoId)` again, even on failure

### Important subtlety

The final rebase only knows about `merge_base`, `dirty`, and `main`. It does not know which fields were already successfully published and which fields are still pending a later phase.

For conflicting JSON leaf edits, the diff3 merge falls back to "ours wins" on conflict. In practice that means dirty wins for that field.

### Runner discrepancy

We already have two slightly different notions of "canonical after publish":

- `PublishFromGitService` tries to refetch updated rows after `edit` / `backfill`, so `main` can pick up canonical remote formatting.
- `PublishPlanRunService` writes the resolved payload straight into `main` and `dirty` without refetching, so canonicalization can be lost.

So the system is already inconsistent about what "accept the remote result as truth" means.

## Why Multiple Dirty Branches Make This Worse

With one shared `dirty`, there is already tension between:

- "dirty is the publish queue"
- "dirty is my local reviewed work"

With multiple dirty branches there is no safe default answer to "apply the new main to dirty":

- if we apply `main` wholesale, we can erase pending changes that were intentionally held back for later phases
- if we preserve old dirty wholesale, we can requeue already-published pre-canonical content
- if desktop local state is linked to shared remote dirty, a publish can also blend in someone else's unpublished work

This is why the first design move should be to unlink the desktop branch from shared remote dirty.

## Recommended Model

### 1. Unlink desktop reviewed state from shared remote dirty

The desktop app should have its own branch rooted at `main` rather than implicitly sharing the server's `dirty`.

That gives us:

- a stable local reviewed branch
- no accidental inclusion of web-app unpublished changes in a desktop publish
- a much clearer answer to "which dirty branch should be rewritten during publish?"

### 2. Reconcile records, not whole dirty branches

For records in the publish scope, the branch content after each successful phase should be:

`dirty_record_after_phase = canonical_main_record_after_phase + remaining_publish_delta`

That is the key rule.

It means:

- after a terminal successful phase, `remaining_publish_delta = 0`, so dirty matches main and the diff disappears
- after a non-terminal successful phase, dirty keeps only the unresolved part of the intent
- outside the publish scope, dirty is untouched

### 3. Remaining publish delta must be explicit

The remaining delta should come from the publish plan and phase state, not from a generic post-hoc rebase.

Examples:

- after `create` succeeds but `backfill` is still pending, dirty should be the created canonical record plus only the unresolved relationship fields
- after `edit` succeeds but a `backfill` is still pending, dirty should be the canonical edited record plus only the unresolved pseudo-ref fields
- after `delete` succeeds, the record is gone from both branches
- after `rename` succeeds, the canonical filename should exist in both branches immediately

## Concrete Broken States We Should Reproduce

### 1. Edit succeeds, remote canonicalizes a field, later phase fails

Setup:

- `dirty` changes `title`
- the same record also contains a pseudo-ref, so it has a later `backfill`
- the remote trims or reformats `title` during `edit`

Current behavior:

- `edit` writes canonical `title` to `main`
- because `backfill` is pending, `dirty` can keep the old pre-canonical file
- publish then fails before `backfill`
- final `rebaseDirty()` sees both `main` and `dirty` changed `title` relative to `merge_base`
- the diff3 JSON merge resolves that leaf to dirty

Broken result:

- `dirty` keeps the old non-canonical `title`
- the next publish tries to change the remote back to the pre-canonical value

This is exactly the class of bug we want to eliminate.

### 2. Create succeeds, backfill is still pending, wholesale `main -> dirty` loses intent

Setup:

- new `posts/post4.json` references a just-created author via pseudo-ref
- `create` succeeds
- `backfill` has not run yet

If we naively copy `main` to `dirty` after the partial success:

- `main` contains the created record without the unresolved relation
- applying `main` wholesale to `dirty` removes the pending relation edit

Broken result:

- the relationship change silently disappears
- the later `backfill` either has nothing meaningful to do, or the user's intent is lost

This is the clearest argument against "just refetch master and apply it to both master and dirty" during partial publishes.

### 3. Create succeeds, rename has not run yet, repo is left with canonical data under a temporary filename

Setup:

- new filename is `scratch_pending_publish_123.json`
- publish plan includes `create` and later `rename-files`

Current behavior:

- `create` commits the returned record back to both branches using the old path
- `rename-files` is not treated as a blocking later phase for dirty-sync decisions
- if the job fails before rename, both branches can contain canonical record content under the temporary filename

Broken result:

- the repo state is semantically half-published
- the record has a real remote id but the local filename is still the temporary one
- retry and UX around "what is still unpublished?" become confusing

### 4. WordPress `raw` / `rendered` makes the push a noop but dirty still changes

Setup:

- WordPress pull returns `{ field: { raw, rendered } }`
- user edits `raw`
- `WordPressConnector.fileToWordPressRecord()` sends `rendered` whenever the object has that shape

Current behavior:

- the user-visible dirty change is on `raw`
- the publish payload is based on `rendered`
- the push can be a noop, or can ignore the edited part entirely

Broken result:

- if we keep dirty as-is, it looks like there is a persistent unpublished change that can never land
- if we overwrite dirty from `main` after refresh, we silently erase the user's edit

This is not only a branch-reconciliation problem. It also shows that "pulled shape" and "writable shape" are not the same thing, so planning and dirty diffs may need to operate on a writable projection instead of raw pulled JSON.

### 5. Shared remote dirty causes publish scope confusion

Setup:

- desktop user has reviewed changes locally
- web app or another client also writes to shared remote `dirty`

Current behavior:

- upload and download three-way merge local dirty and `origin/dirty`
- the publish plan is still based on the moving dirty branch
- post-publish download has to merge against a force-rewritten dirty branch

Broken result:

- a desktop publish can include remote unpublished work the user never intended to publish
- post-publish pull can mishandle local unreviewed edits because the dirty history was rewritten underneath it

This is the product reason to separate desktop branch state from shared server dirty.

## Recommended Next Steps

1. Adopt the branch split: desktop session branch separate from shared remote dirty.
2. Define the publish-time record reconciliation rule formally as `canonical main + remaining publish delta`.
3. Treat `rename` as part of the unresolved phase set when deciding whether a create is final.
4. Make canonicalization behavior consistent across publish runners. Either both refetch updated rows, or both explicitly declare that submitted payload is canonical.
5. Add targeted tests for the five broken scenarios above before changing the reconciliation algorithm.
6. Decide whether dirty diffing and planning should operate on raw pulled JSON, writable JSON, or both for connectors like WordPress.

## Open Questions

- Do we want a dedicated publish snapshot branch or ref instead of planning directly from a moving dirty branch?
- Should partial publish reconciliation be path-scoped only at first, or field-scoped from day one?
- For connectors that return non-writable read shapes like WordPress `raw` / `rendered`, should we normalize dirty into a writable projection, or should we block edits to non-publishable fields?
- After partial failure, should the next retry resume from persisted phase state, or should we rebuild the plan from the reconciled dirty branch?
