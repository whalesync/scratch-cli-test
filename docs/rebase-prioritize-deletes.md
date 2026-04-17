# Prioritize Deletes In Desktop Sync Rebase

## Goal

Replace the current "modified content beats delete" behavior in the desktop
sync path with a simpler rule:

- if one side deleted a path
- and the other side also changed that path
- the final result should be a delete

In short: delete wins over modify.

This is mainly about the desktop app's normal sync loop:

- `files upload`
- `files download`

Those are the two places where desktop reconciles local and remote dirty state.

## Why This Matters

Today, if one side deletes a file and the other side modifies it, the merge
logic keeps the modified file.

That is the opposite of the proposed strategy, and it is why we ended up adding
special-case cleanup logic for created records after failed publish scenarios.

Delete-priority would make the general merge behavior more predictable:

- if a record is deleted on either side during a real 3-way conflict
- the merged result is that the record is gone

## Current Desktop Sync Path

Desktop itself does not implement the merge logic. It shells out to the CLI:

- `scratch:push-workspace-changes` runs `scratchmd files upload` in
  `scratch-desktop/src/main/index.ts`
- `scratch:pull-workspace-changes` runs `scratchmd files download` in
  `scratch-desktop/src/main/index.ts`

The merge behavior lives in `scratch-git-2/src/cli/commands/files.rs`.

### Upload

`upload_single_repo()` does two reconciliation steps:

1. It merges approved state:
   - `base = merge-base(local dirty, origin/dirty)`
   - `local = local dirty`
   - `remote = origin/dirty`
   - implementation: `prepare_upload_merge(...)`
2. After push succeeds, it rebases the working tree:
   - `base = old local dirty`
   - `local = working tree`
   - `remote = new local dirty`
   - implementation: `apply_remote_changes_to_working_copy(...)`

### Download

`download_single_repo()` does the same two layers:

1. It merges approved state:
   - `base = merge-base(local dirty, origin/dirty)`
   - `local = local dirty`
   - `remote = origin/dirty`
   - implementation: `prepare_upload_merge(...)`
2. It rebases the materialized local files:
   - `base = old local dirty`
   - `local = working tree`
   - `remote = merged local dirty`
   - implementation: `compute_merge_actions(...)` over the materialized repo,
     then `materialize_local_repo(...)`

## Where The Current Behavior Comes From

The shared decision point is:

- `compute_merge_actions(...)` in `scratch-git-2/src/cli/commands/files.rs`

That function is used by:

- `prepare_upload_merge(...)`
- `apply_remote_changes_to_working_copy(...)`
- the download-side working-tree/materialized-state reconciliation

So this one helper already sits underneath both desktop upload and desktop
download.

### Current Delete-vs-Modify Behavior

When both sides changed the same path, the current logic does this:

- `local = Some(...)`, `remote = None`
  - returns `KeepLocal`
  - current warning: `Remote deleted X but local has changes; keeping local version`
- `local = None`, `remote = Some(...)`
  - returns `WriteRemote`

That means:

- remote delete loses to local modify
- local delete loses to remote modify

This is the exact behavior we want to invert.

## Recommended Implementation Point

The best primary insertion point is still:

- `compute_merge_actions(...)`

Reason:

- it is the shared policy function for upload and download
- changing it once updates both approved-state reconciliation and working-tree
  rebasing
- it avoids adding a special case in only one caller

### Proposed Rule In Code Terms

Inside the `local_changed && remote_changed` branch:

- if `local_content.is_none()` or `remote_content.is_none()`
- return `MergeAction::Delete`

That should happen before the current branch that emits:

- `KeepLocal` for `(Some(local), None)`
- `WriteRemote` for `(None, Some(remote))`
- `Merge` for `(Some(local), Some(remote))`

### Sketch

```rust
if local_changed && remote_changed {
    if local_content.is_none() || remote_content.is_none() {
        actions.push(MergeAction::Delete {
            path: path.to_string(),
            warning: Some(...),
        });
        continue;
    }
}
```

## Behavior We Should Keep

The special no-base create case should stay as-is.

Current behavior:

- `base = missing`
- `local = locally created file`
- `remote = remotely created canonical file`
- result = prefer `remote`

That is still correct after publish, because the remote copy may contain the
server-assigned canonical fields.

So the delete-priority change should only affect true delete-vs-change
conflicts, not the no-base create/create case.

## Important Product Caveat

Delete-priority in the CLI merge logic does **not** fully replace the current
"discard created record" remote cleanup hack by itself.

That hack exists because, today, a delete on one side can lose to a modify on
the other side. So if we only discard the file locally and leave it in remote
dirty, the next pull can bring it back.

It helps on the next normal upload, because:

- local delete vs remote modified record will merge to delete
- `files upload` can then push that delete to `origin/dirty`

But it does **not** immediately clean remote dirty just because the local file
was discarded.

More concretely:

- `files download` will preserve the local delete
- `files download` will **not** delete the file from remote dirty
- only `files upload` can propagate that deletion back to remote dirty

So if product still wants:

- "press discard created locally"
- and remote dirty is cleaned up immediately with no follow-up upload

then the current special remote-discard path still does something that
delete-priority alone does not do.

If we adopt delete-priority and remove the hack, the new contract becomes:

- local discard is immediate
- remote dirty cleanup happens on the next `files upload`

That may be acceptable, but it is a product decision, not just a code change.
The important point is that, once merge/rebase consistently prioritizes
deletes, we should be able to remove the current hack whose only job is to stop
the file from resurfacing on pull.

## Secondary Scope: Service Rebase

There is another rebase implementation in:

- `scratch-git-2/src/service/git/rebase.rs`

This is used by service-side routes such as:

- `scratch-git-2/src/service/routes/write.rs`

That path is not the main desktop upload/download flow, but it has similar
semantics today:

- explicit user delete is preserved
- modify vs upstream delete still resolves in favor of keeping content

So if we want "delete wins" to become a repo-wide rule instead of only a
desktop-sync rule, this service-side rebase should be reviewed in a follow-up.

I would treat that as a second phase, not part of the initial desktop fix.

## Recommended Rollout

### Phase 1: CLI Desktop Sync Only

Change `compute_merge_actions(...)` and add tests around the CLI sync path.

This covers:

- `files upload`
- `files download`
- working-tree rebases after upload/download

### Phase 2: Decide Whether The Remote Discard Hack Stays

After Phase 1 lands, decide whether:

- the special remote dirty cleanup on discard-created-record stays temporarily
- or we switch to "remote cleanup happens on next upload"

### Phase 3: Optional Service-Side Consistency

If we want the same delete-priority rule everywhere, update:

- `service/git/rebase.rs`

and add focused tests for modify-vs-delete there too.

## Concrete Implementation Plan

1. Add tests first in `scratch-git-2/src/cli/commands/tests/files.rs`.

2. Add a unit test for approved-state merge:
   - local delete vs remote modify
   - expected result: delete

3. Add a unit test for approved-state merge:
   - local modify vs remote delete
   - expected result: delete

4. Add a test for working-tree rebase:
   - working tree has an unreviewed local edit
   - new approved dirty state deletes that path
   - expected result: file is removed from the working tree

5. Keep the existing no-base create/create test:
   - verify remote still wins for canonical publish-created records

6. Implement the policy change in `compute_merge_actions(...)`.

7. Update warning text to explain that the delete was intentional, for example:
   - `Remote deleted X and local also changed it; prioritizing delete`
   - `Local deleted X and remote also changed it; prioritizing delete`

8. Re-run the targeted upload/download tests plus the new delete-priority tests.

## Expected User-Visible Effect

After the CLI change:

- if a file was deleted on one side and modified on the other
- desktop sync will converge on the file being deleted

That affects both:

- approved dirty reconciliation
- the later working-tree rebase

The most important consequence is that unreviewed local edits to a file can now
be dropped if the approved side deleted that file. That is consistent with the
proposed strategy, but we should call it out explicitly because it is a real UX
change.

## Recommendation

Recommended first change:

- implement delete-priority in `compute_merge_actions(...)`

Recommended product decision to make before removing the current discard hack:

- are we okay with remote dirty cleanup happening on the next `files upload`,
  instead of immediately at discard time?

If yes, the delete-priority change can likely replace most of the special-case
behavior over time.

If no, then the current remote cleanup hack may still be needed temporarily,
even after the merge policy is fixed.
