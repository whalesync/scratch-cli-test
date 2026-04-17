# CLI Upload / Download

## Intro

The CLI works with five versions of the same logical data:

1. `remote master`
2. `remote dirty`
3. `local master`
4. `local dirty`
5. `working tree`

For the CLI model, the important meanings are:

- `local dirty` = approved local changes
- `working tree` = `local dirty` plus unapproved local edits
- `remote dirty` = latest approved state on the server

Both **upload** and **download** reconcile these states using 3-way merges.
The main rule is that approved state is merged at the `dirty` layer first, and then the working tree is rebased on top of the new `local dirty`.

Publish is the most involved flow because it is:

1. `UPLOAD`
2. wait for the server-side publish job
3. `DOWNLOAD`

One valid history before publishing can look like this:

```text
(m) ---- (o/m) ---- (o/d)
  \
   (d) ---- (w)
```

Where:

- `m` = local `master`
- `o/m` = `origin/master`
- `o/d` = `origin/dirty`
- `d` = local `dirty`
- `w` = working tree based on local `dirty`

In this shape, the real merge base of `d` and `o/d` is `m`, not `o/m`.
In other histories, the real merge base can be later than `m`.
That is why both upload and download must compute the true merge base every time instead of assuming `master`.

## Implementation Note

At the moment, for a single connection, the CLI reads the relevant file state into memory before it reconciles it.
That means it holds the needed file maps for the merge in memory rather than streaming files one by one.

We do this because it makes the code much easier to reason about and much easier to test.
The merge logic becomes a straightforward function over `base`, `local`, and `remote` maps, and the same representation can be reused for upload, download, and working-tree rebasing.

This should be completely fine for thousands of records in the current usage model, because this is a single-user workflow running on a local machine that will usually have many gigabytes of memory.

Once the full correctness of the approach is validated, it should be fairly straightforward to optimize this by keeping only paths and object IDs in memory first, and then reading file contents on demand in a later step only for the paths that actually need content comparison or merging.
See [CLI_NO_MEMORY.md](/Users/ijd/repos/spinner/scratch-git-2/docs/CLI_NO_MEMORY.md) for the follow-up refactor sketch.

## Publish Flow

### 1. Starting State

Before publish starts:

- `local dirty` contains approved local edits
- `working tree` contains `local dirty` plus any unapproved edits
- `remote dirty` contains the latest approved state already on the server
- `local master` and `remote master` represent the published baseline

Only approved changes belong in publish.
Unapproved working-tree edits MUST survive the flow, but must not be uploaded.

### 2. Upload Phase

For each connection, upload works like this:

1. Read `local dirty` from `refs/heads/dirty`.
2. Read the current working tree from disk.
3. Read local publish-plan files from `.scratch/.publish-plans/...`.
4. Fetch `origin`.
5. Compute the real git merge base of:
   - `refs/heads/dirty`
   - `refs/remotes/origin/dirty`
6. Reconcile approved state with a 3-way merge:
   - `base = merge-base(local dirty, origin/dirty)`
   - `local = local dirty`
   - `remote = origin/dirty`
7. Re-add local publish-plan files to the merged result.
   These plan files are uploaded as metadata for publish.
   Unapproved working-tree edits are not uploaded.
8. If the merged result already equals `origin/dirty`, there is nothing new to push.
   The CLI still advances local refs to that reconciled server state.
9. Otherwise, the CLI creates a new local `dirty` commit with:
   - `parent = origin/dirty`
   - `tree = merged approved state`
10. Push that new `dirty` commit to the server.
    In the normal case this is a fast-forward push.
11. If the remote moved between fetch and push, the CLI retries:
    - refetch
    - recompute merge base
    - recompute merged dirty
    - try push again

After upload succeeds, the CLI also rebases the working tree from the old `local dirty` to the new `local dirty`:

- `base = old local dirty`
- `local = working tree`
- `remote = new local dirty`

This keeps unapproved local edits, but moves them onto the new approved baseline.

### 3. Wait For Publish

After upload, the server-side publish job runs against the uploaded approved state and the uploaded publish-plan files.

Conceptually, this is the point where:

- `remote dirty` may advance again
- `remote master` may advance
- published records may be rewritten into their canonical post-publish state

For example, a connector may:

- assign a real remote ID to a newly-created file
- populate server-managed timestamps such as `lastUpdated`
- normalize or enrich the stored record shape before it is written back to git

For `publish-from-git`, the server-side rule is:

- refreshed canonical content is always written to `main`
- refreshed canonical content is written to `dirty` only if this is the last publish phase for that path

That "last phase only" behavior matters because a later `backfill` or `delete` phase must still run against the same record without prematurely clearing approved state from `dirty`.

The local CLI does not guess this result.
It waits and then reconciles by downloading the new server state.

### 4. Download Phase

After publish completes, the CLI downloads again.

For each connection, download now works like this:

1. Fetch `origin`.
2. Read `local dirty`.
3. Read `origin/dirty`.
4. Compute the real git merge base of:
   - `refs/heads/dirty`
   - `refs/remotes/origin/dirty`
5. Reconcile approved state with the same 3-way merge shape:
   - `base = merge-base(local dirty, origin/dirty)`
   - `local = local dirty`
   - `remote = origin/dirty`
6. If the merged approved state already equals `origin/dirty`, the CLI can fast-forward local `dirty` to that remote commit.
7. Otherwise, the CLI creates a new local `dirty` commit with:
   - `parent = origin/dirty`
   - `tree = merged approved state`

That means download does not simply overwrite `local dirty` with `origin/dirty`.
It first preserves and rebases any approved local changes that still exist only locally.

### Special Case: Same-Path Create With No Merge Base

There is one especially important publish roundtrip case:

- a user creates a brand new local file
- publish creates the remote record from that file
- the server writes back the same path with canonical fields added

In this case, the 3-way merge for `local dirty` vs `origin/dirty` sees:

- `base = missing`
- `local = locally-created file`
- `remote = remotely-created canonical file`

The CLI now intentionally prefers `remote` for that path.

Why:

- the remote version is the authoritative post-publish record
- it may contain fields that did not exist locally before publish, such as server-assigned IDs or server-managed timestamps
- keeping the local version in this no-base case would incorrectly preserve the pre-publish create payload and make the canonical fields look like a revert

This rule is intentionally specific to the "same path added on both sides with no base" case.
Normal 3-way merge behavior still applies when a merge base exists.

Once the new `local dirty` is computed, the CLI reconciles the full materialized local state:

- `base = old local dirty`
- `local = current materialized workspace`
- `remote = new local dirty`

This keeps:

- unapproved local data-file edits
- local publish-plan files
- other local-only scratch files

while still moving approved files onto the new `local dirty` baseline.

After that, the CLI updates:

- `local dirty`
- the local reviewed-dirty checkout
- the materialized working tree

The surrounding `files download` flow then updates `local master` from `remote master` and refreshes schema files from `master`.

This means the practical publish flow used by the desktop app is:

1. upload approved changes
2. trigger and wait for publish
3. run `files download`

The critical correctness property is that this post-publish download must make the canonical server version visible in all three local views:

- `local master`
- `local dirty`
- `working tree`

For updated existing records, this comes from ordinary 3-way merge behavior.
For newly-created records at the same path, this now depends on the "prefer remote when base is missing" rule above.

### 5. End Result

After a successful publish flow:

- approved local changes have been uploaded from `local dirty`
- unapproved local edits were never uploaded
- server-side publish changes have been pulled back down
- `local dirty` has been rebased onto the latest `remote dirty`
- the working tree has been rebased onto the new `local dirty`
- `local master` has been refreshed from `remote master`

So the local state stays internally consistent:

- approved state lives in `local dirty`
- unapproved state lives only as a delta in the working tree
- both upload and download preserve that model

## Efficiency And Possible Improvements

The current implementation is reasonably efficient:

- git trees are read in batch using `git ls-tree` and `git cat-file --batch`
- repeated tree reads are cached by hash
- file comparison is byte-based, so we do not parse JSON just to detect changes

The biggest remaining improvements are:

- avoid scanning the full repo tree for small publish/download scopes
- use path-limited reconciliation derived from the local dirty diff and publish plans
- short-circuit more aggressively using object IDs before reading blob contents
