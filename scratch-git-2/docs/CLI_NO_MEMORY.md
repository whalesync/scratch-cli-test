# CLI No-Memory Plan

This note describes the follow-up refactor for the CLI reconciliation code.
The goal is to keep the current correctness model while eliminating unnecessary
blob reads and disk scans.

## The Invariant We Already Have

The git index of the dirty worktree is kept in sync with the committed dirty
state by `update_dirty_worktree_index`, which calls `git reset --mixed <hash>`
after every CLI operation that commits to dirty:

- `accept` / `accept-all` / `accept-field` → commit to dirty → `git reset --mixed`
- `reject-field` (when dirty changes) → same
- `upload` → commit merged dirty → same
- `download` → commit new dirty → same

The index is **not** automatically updated when a file changes on disk.
Manual edits to files in the dirty dir live in the gap between the index and
disk until the user accepts them.

So at any point in time:

```
index           = most recent dirty commit
disk            = most recent dirty commit + unapproved edits
git status      = disk minus index = exactly the unapproved edits
```

`unreviewed_entries_from_status` already exploits this — it calls
`git status --porcelain` to list changed files without reading any content.
The same idea extends to the full merge path.

## The Two-Phase Strategy

### Phase 1 — Hash-first classification for git trees

For any git tree (merge-base, local dirty, origin/dirty), `git ls-tree -r` gives
`{path → blob_hash}` for every file. Comparing hashes is enough to classify
merge actions without reading any blob content:

- `base_hash == local_hash`: file unchanged in local → apply remote version
- `base_hash == remote_hash`: file unchanged in remote → apply local version
- `local_hash == remote_hash`: both sides changed identically → either hash wins
- all three differ: text merge needed → add to a "needs content" set

After classification, load blobs in a single targeted `git cat-file --batch`
call for only the paths in the "needs content" set.

**New functions needed:**
- `read_tree_index(bare_repo, treeish) -> HashMap<String, String>` — runs
  `git ls-tree -r` only, no cat-file
- `read_blobs_by_hash(bare_repo, hashes) -> HashMap<String, Vec<u8>>` — targeted
  `cat-file --batch` for a specific list of hashes

`compute_merge_actions` takes `&HashMap<String, String>` (TreeIndex) instead of
`&FileMap`. The classification logic does not change.

### Phase 2 — Working tree via git index

Because the index always reflects the committed dirty state, `git status` gives
us exactly the files that have unapproved disk edits. Everything else on disk
matches the dirty commit byte-for-byte.

For the working-tree reconciliation step (`apply_remote_changes_to_working_copy`):

1. Call `git status --porcelain -uall` in the dirty worktree.
2. Paths **absent from the output**: disk = dirty blob hash. No disk read needed.
   Compare the dirty blob hash against the new dirty hash to decide the action.
3. Paths **present in the output** (modified, deleted, untracked): unapproved
   edit present. Read from disk. Load the corresponding dirty and new-dirty blobs
   for the 3-way text merge.

This replaces the full recursive `read_dirty_disk` scan with a `git status` call
and targeted reads for only the files that actually have unapproved edits.

**Edge cases that stay correct:**

| Scenario | Handled how |
|---|---|
| Remote deletes a file, working tree is clean | File absent from status output → no disk read → delete from disk |
| Remote deletes a file, working tree has edits | File present in status output → read from disk → KeepLocal with warning |
| Remote adds a new file | WriteRemote → load that blob, write to disk |
| Untracked file at same path as remote-added file | Present in status as `??` → read from disk → KeepLocal (no base) |

### Phase 3 — Hash-based tree construction for commits

Currently `commit_file_map_to_ref` takes a `FileMap` (full bytes for every path).
After Phases 1 and 2, most paths in the output tree are unchanged blobs — we
have their hashes but never loaded their bytes.

New output type:

```rust
enum BlobRef {
    ExistingHash(String),  // existing git object — no write needed
    NewContent(Vec<u8>),   // merged result — write new blob
}

type MergedTree = HashMap<String, BlobRef>;
```

`commit_file_map_to_ref` accepts a `MergedTree`:
- `ExistingHash`: reference the blob directly when building the tree object
- `NewContent`: call `git hash-object -w` to write the blob, then reference by hash

## Expected Gains

For a workspace with 10,000 records, 5 changed remotely, 2 with unapproved local
edits:

| Step | Current | After refactor |
|---|---|---|
| Approved-state merge | Load all blobs for 3 trees (~30k reads) | `git ls-tree` × 3, then load ≤5 blobs |
| Working-tree reconciliation | Scan all 10,000 disk files | `git status` + read 2 disk files + 2 blobs |
| Total content I/O | ~30,002 blob/file reads | ~9 |

For the common case (no local edits, no remote conflicts), upload and download
become almost entirely metadata operations.

## What Does Not Change

- The 5-state correctness model
- `merge_content` / `merge_file_contents` — unchanged
- `materialize_local_repo` — still writes bytes to disk for all changed paths
- The merge classification logic — same rules, operating on hashes instead of bytes
- Unit tests — in-memory FileMaps map trivially to TreeIndex by computing a
  content hash per path; tests can stay fully in memory

## What Must Not Break

The git index invariant is load-bearing for Phase 2:

> After every CLI operation that commits to dirty, `update_dirty_worktree_index`
> must be called. Any code path that writes a dirty commit and skips this call
> will leave the index stale, causing `git status` to report false positives and
> corrupting the working-tree merge classification.

This invariant is already maintained everywhere. Do not add commit paths that
bypass it.

## Non-Sparse Worktree Fallback

When `is_sparse_worktree` returns false (legacy or test workspaces not set up as
git worktrees), the current full-scan path remains as a fallback. Phase 2 only
applies when the dirty dir is a sparse worktree.

## Incremental Order

1. Split `read_tree_files_batched` into `read_tree_index` + `read_blobs_by_hash`.
   Keep `read_git_tree` as a wrapper that calls both (no behaviour change yet).

2. Rewrite `compute_merge_actions` to accept `&TreeIndex` and add a
   `NeedsTextMerge` variant so content loading is deferred.

3. Add targeted blob loading after classification. Verify unit tests pass.

4. Switch `upload_single_repo` and `download_single_repo` to the new path.
   Verify integration tests and driver pass.

5. Rewrite `apply_remote_changes_to_working_copy` to use `git status` + targeted
   disk reads (Phase 2).

6. Introduce `BlobRef` / `MergedTree` and update `commit_file_map_to_ref`
   (Phase 3). Most invasive change — do it last.
