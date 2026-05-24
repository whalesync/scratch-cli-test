# Gix Patterns

How `scratch-git-2` uses the [`gix`](https://crates.io/crates/gix) crate today. Pinned at `0.70` — see [GIX_UPGRADE.md](GIX_UPGRADE.md) for the version-bump rationale, transport-stack discussion, and the standing decision not to upgrade yet.

This doc is the working reference for "I need to touch some git plumbing — where does it live and which API should I reach for?" It exists because, until now, only a handful of files knew the conventions and the bus factor on those files was one.

## When to use gix vs shell out to `git`

The crate uses both, deliberately. The split is by operation, not by file.

| Operation                                     | What we use                                                       | Why                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git open` (bare or worktree)                 | `gix::open`                                                       | Fast, no subprocess.                                                                                                                                                                     |
| `git rev-parse <ref>`                         | `gix::Repository::rev_parse_single`                               | Cheap and direct.                                                                                                                                                                        |
| `git update-ref`                              | `gix::Repository::reference`                                      | Atomic loose-ref write; no need to invoke `git`.                                                                                                                                         |
| Write blob / tree / commit objects            | `gix::Repository::write_blob/write_object`                        | Test-only fixture builder in `cli/git_ops/local.rs`. Production builds via the service-side tree builder (`service/git/tree_builder.rs`).                                                |
| `git status` (index vs worktree)              | `gix::Repository::status`                                         | Index-backed, parallel. Measured at parity with `git status` warm and ~7× faster cold. Used in `detect_unreviewed_fast` (`cli/commands/files.rs:2657`).                                  |
| 3-way text merge                              | `gix::merge::blob::builtin_driver::text`                          | Already a transitive dep; avoids spawning `git merge-file`. See `shared/merge.rs`.                                                                                                       |
| Bulk blob reads from a tree                   | **Shell-out** to `git ls-tree -r` piped to `git cat-file --batch` | gix per-blob lookups are O(seconds) for ~20k-file trees. `cat-file --batch` is O(hundreds-of-ms) for the same workload. See `shared::git_local::read_tree_files_filtered`.               |
| `git fetch` / `git clone --bare` / `git push` | **Shell-out** to `git`                                            | gix's transport stack is usable but there's no high-level `prepare_push`. See [GIX_UPGRADE.md § Push: no gix support in any version](GIX_UPGRADE.md#push-no-gix-support-in-any-version). |
| `git worktree add/prune/remove`               | **Shell-out** to `git worktree`                                   | gix 0.70 has no drop-in equivalent. One call per connection on init; not a hot path. See `cli/git_ops/local.rs`, `service/worktree.rs`, `cli/commands/workspaces.rs`.                    |
| `git ls-tree` (path enumeration only)         | **Shell-out**                                                     | Faster than walking the tree with gix for the enumeration-only case. See `shared::git_local::list_tree_paths_filtered`.                                                                  |
| `git diff --name-status`                      | **Shell-out** to `git diff`                                       | We need rename detection and the `R<score>` status flag. See `cli/git_ops/local.rs:diff_name_status`.                                                                                    |

The unifying rule: **use gix for single-object reads, ref mutation, and writes; shell out for anything that walks the whole tree or talks to a remote**.

## Layout of the gix surface

```
src/
├── shared/
│   ├── git_local.rs        ← pure read helpers (open, rev_parse, read_tree_files)
│   │                          shared by CLI + napi; no remote or mutation logic
│   └── merge.rs            ← gix::merge::blob driver wrapper (service rebase path)
├── cli/
│   └── git_ops/
│       ├── local.rs        ← ref mutation, test fixture commit-builder, diff helpers
│       └── remote.rs       ← clone / fetch (shell-out — see GIX_UPGRADE.md)
└── service/
    ├── git/
    │   └── tree_builder.rs ← in-memory tree writer used by /upload-patch/commit
    ├── routes/
    │   └── index.rs        ← bare-repo tree walker (`collect_blobs`)
    ├── worktree.rs         ← shell-out `git worktree add/prune` orchestration
    └── error.rs            ← `From<gix::open::Error>` for the service AppError
```

The split exists for a reason: napi cannot depend on `cli/git_ops/` because that pulls in CLI-orchestration concerns (clap, the API client, worktree shell-outs). Slice H.1.5 (DEV-10144) moved the pure read helpers into `shared/git_local.rs` precisely so `shared/review_ops.rs` could drive accept/discard end-to-end without dragging the CLI's full git surface into the napi cdylib.

If you're adding a new git helper, ask: does it mutate state, talk to a remote, or orchestrate a worktree? If yes, it belongs in `cli/git_ops/` or `service/`. If it's a pure read against a bare repo, it belongs in `shared/git_local.rs` so both the CLI and the napi binding can call it.

## Common patterns

### Open a bare repo

```rust
use crate::shared::git_local::open_bare_repo;

let repo: gix::Repository = open_bare_repo(&ctx.bare_repo)?;
```

`open_bare_repo` wraps `gix::open` with a `with_context` for the path, so the error message names the repo when it fails.

### Resolve a ref to a hex object id

```rust
use crate::shared::git_local::rev_parse_optional_to_string;

// Returns None when the ref doesn't exist (e.g. a fresh connection that
// hasn't been published yet). Errors only when the repo itself can't be opened.
let head: Option<String> = rev_parse_optional_to_string(&ctx.bare_repo, "refs/heads/main")?;
```

The CLI's `git_ops::local::git_rev_parse_optional` is a thin re-export for legacy call-sites.

### Bulk-read a tree's blobs

**Always prefer the shell-out path for >1 blob.** gix per-blob lookups dominate at scale.

```rust
use crate::shared::git_local::read_tree_files_filtered;

// Filter at the ls-tree step so cat-file only sees the matching subset.
let blobs = read_tree_files_filtered(
    &ctx.bare_repo,
    "refs/heads/main",
    |path| path.starts_with("Companies/") && path.ends_with(".json"),
)?;
```

`read_tree_files` is `read_tree_files_filtered` with a `|_| true` predicate. Both pipe `ls-tree -r <treeish>` into `cat-file --batch` via a writer thread so the read side can't deadlock on a full pipe buffer. Both normalize CRLF to LF on the way out (matches the rest of the codebase's blob expectations).

If you only need the path list (no blob content), use `list_tree_paths_filtered` — it skips `cat-file` entirely. Sub-second on 20k+ record folders vs the multi-second blob walk that `read_tree_files_filtered` does.

### Walk a tree via gix (service-side only)

The service's `/index/build` path walks the bare repo's tree via gix without ever spawning a process — there's no on-disk worktree to bulk-read from. The pattern is an iterative DFS to avoid borrow-checker conflicts from recursive `find_object` calls while a `TreeRef` is alive:

```rust
fn collect_blobs(
    repo: &gix::Repository,
    root_tree_oid: gix::ObjectId,
) -> Result<Vec<(String, gix::ObjectId)>, AppError> {
    let mut result = Vec::new();
    let mut stack = vec![(root_tree_oid, String::new())];

    while let Some((tree_oid, prefix)) = stack.pop() {
        let obj = repo.find_object(tree_oid)?;
        let tree = obj.try_into_tree()?;

        // Drain into owned data BEFORE dropping `tree`. Recursing into another
        // `find_object` call here while `tree` is live trips the borrow checker.
        let mut children: Vec<(String, gix::ObjectId, bool)> = Vec::new();
        for entry_ref in tree.iter() {
            if let Ok(entry) = entry_ref {
                let name = std::str::from_utf8(entry.filename()).unwrap_or("").to_string();
                let full_path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                children.push((full_path, entry.object_id().into(), entry.mode().is_tree()));
            }
        }
        drop(tree);

        for (full_path, oid, is_tree) in children {
            if is_tree { stack.push((oid, full_path)); }
            else { result.push((full_path, oid)); }
        }
    }
    Ok(result)
}
```

See `service/routes/index.rs:399` for the production version. **Do not** convert the loop body to a recursive call without first reading the lifetime constraints on `TreeRef::iter()`; the iterator borrows `tree`, and any nested `find_object` call needs `tree` already dropped.

### Detect "working tree differs from index"

```rust
let repo = gix::open(&ctx.worktree_dir)?;
let platform = repo.status(gix::progress::Discard)?;
let iter = platform.into_index_worktree_iter(Vec::<gix::bstr::BString>::new())?;

use gix::status::index_worktree::iter::Summary;
for item in iter {
    let item = item?;
    let Some(summary) = item.summary() else { continue };
    match summary {
        Summary::Modified | Summary::Added | Summary::Removed => { /* mutated */ }
        Summary::Renamed | Summary::Copied => { /* treat as modified — see note */ }
        Summary::Conflict | Summary::TypeChange | Summary::IntentToAdd => continue,
    }
}
```

Caveats — both surfaced in production:

1. **Rename detection is on by default but won't fire unless our adds line up with deletes by content similarity.** In practice we never see `Renamed`/`Copied`; treat them defensively as `Modified` (see `detect_unreviewed_fast`).
2. **The status compares the working tree against the index, not the index against `HEAD`.** If you advance `refs/heads/main` and don't reset the index, every just-published file looks "Modified" on the next status call. Call `worktree_reset_mixed(&ctx.worktree_dir, new_head_hash)` (a thin `git reset --mixed <hash>` shell-out — see `cli/git_ops/local.rs`) after any ref advance to keep the index in sync. This is why `update_main_worktree_after_pull` and `reconcile_accepted_after_publish` both run a `worktree_reset_mixed` after `git update-ref`.

### Build a commit with custom author/committer

Test-only today (Slice F.5 deleted the production commit-to-`dirty` chain), but the pattern is the canonical way to write commits via gix in this crate:

```rust
let time = gix::date::Time::now_local_or_utc();
let author = gix::actor::SignatureRef {
    name: "Scratch CLI".into(),
    email: "cli@scratch.md".into(),
    time,
};
let commit = gix::objs::Commit {
    tree: tree_id,
    parents: vec![parent_oid].into(),
    author: author.to_owned(),
    committer: author.to_owned(),
    encoding: None,
    message: message.into(),
    extra_headers: vec![],
};
let commit_id = repo.write_object(&commit)?;
repo.reference(refname, commit_id.detach(),
    gix::refs::transaction::PreviousValue::Any, "scratchmd commit")?;
```

See `cli/git_ops/local.rs:54` for the full helper. Note `PreviousValue::Any` — we trust our own ref mutations and don't gate on the prior value.

### Write a tree from a `FileMap`

```rust
// FileMap = HashMap<String, Vec<u8>> — path → blob content.
let tree_id = write_tree_from_file_map(&repo, &files)?;
```

The implementation in `cli/git_ops/local.rs:110` builds the tree as a nested `BTreeMap<String, TreeNode>` first, then walks it bottom-up writing subtrees before their parents. Two non-obvious bits:

1. **Tree entries must be sorted with trailing-slash semantics for directories.** Git's canonical tree-entry order treats `foo/` as if it were `foo\x2f`, which sorts after `foo.txt` even though `/` < `.` in ASCII. The sort comparator in `write_tree_entries` reproduces this by appending a `/` to directory names before comparing. Get this wrong and gix happily writes the tree, but the resulting object hash won't match what `git mktree` would produce, breaking any downstream tool that expects canonical hashes.
2. **Path normalization runs through `shared::git_path::normalize_logical_git_path`** so `.` / `..` / backslashes get rejected before we write anything. Skipping this would let a malicious patch escape the repo root.

### Open a worktree and resolve refs from it

```rust
let worktree_repo = gix::open(&ctx.worktree_dir)?;
```

This works because the worktree's `.git` file points back to the bare repo, and gix follows the gitlink. The CLI uses this in two places: the `gix::status` call in `detect_unreviewed_fast`, and a few diagnostic helpers in `cli/commands/files.rs`. Don't reach into the bare repo for working-tree-relative operations — the bare repo doesn't know about the worktree's checkout.

## Pitfalls

1. **Don't `gix::find_object` in a loop over `tree.iter()`** — `tree` borrows the object data and `find_object` needs an exclusive borrow of the repo's object cache. Drain entries into owned data first, then walk them. See the `collect_blobs` pattern above.
2. **Don't use gix's tree-walk APIs for bulk blob reads.** Per-blob `find_object` round-trips are O(seconds) at 20k+ files. Always use `read_tree_files_filtered` (shell-out to `ls-tree | cat-file --batch`) for bulk reads.
3. **Don't forget to reset the index after a ref advance** when downstream code calls `gix::Repository::status`. Otherwise every changed path looks "Modified" on the next status call. Use `worktree_reset_mixed` from `cli/git_ops/local.rs`.
4. **Don't call gix's remote APIs and expect them to work like the CLI.** The `0.70` remote stack supports clone and fetch but the project regressed to system `git` for both (commit `39a1fe63`) and has never had push support. See [GIX_UPGRADE.md § Current status of the CLI gix migration](GIX_UPGRADE.md#current-status-of-the-cli-gix-migration).
5. **CRLF normalization is the caller's responsibility for bulk reads.** `read_tree_files_filtered` calls `normalize_crlf` on each blob; if you bypass that path and read blobs another way, do the normalization yourself or you'll get spurious diffs on Windows-authored content.
6. **`gix::Repository::status` is parallel by default.** The `progress::Discard` you see in the call site disables progress reporting, not parallelism. The walk uses Rayon under the hood; no need to wrap it.

## Adding a new gix-backed helper

Decision tree:

- **Pure read against a bare repo, no mutation, no remote, useful to both CLI and napi?** → `shared/git_local.rs`.
- **Mutation of a ref or object in a bare repo, CLI-only?** → `cli/git_ops/local.rs`.
- **Remote transport (fetch, clone, push)?** → `cli/git_ops/remote.rs`. Use shell-out unless you're explicitly tackling the system-`git`-removal goal (see GIX_UPGRADE.md).
- **Service-side bare-repo walking or in-memory tree construction?** → `service/git/tree_builder.rs` or `service/routes/<route>.rs`.
- **Worktree orchestration (`git worktree add/prune/remove`)?** → Shell-out only. Existing call sites: `cli/git_ops/local.rs:288,372`, `service/worktree.rs:29,88`, `cli/commands/workspaces.rs:815`.

Then wire a unit test under the same module. The pattern in `shared/git_local.rs:251` (the `make_bare_repo` test fixture that runs `git init`, writes files, commits, and `git clone --bare`s into a temp dir) is the standard way to build a real-bare-repo fixture without a server round-trip. Guard the test with a `git_available()` skip for environments where the `git` binary isn't on `PATH`.

## Quick lookup — "where do I find an example of..."

| You want to do                             | Look at                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Open a bare repo                           | `shared/git_local.rs::open_bare_repo`                                                                          |
| Resolve a ref to a SHA                     | `shared/git_local.rs::rev_parse_optional_to_string`, `cli/git_ops/local.rs::rev_parse_to_string`               |
| Detect "what changed?" in the working tree | `cli/commands/files.rs::detect_unreviewed_fast`                                                                |
| Read all blobs from a tree                 | `shared/git_local.rs::read_tree_files`                                                                         |
| Read a filtered subset of blobs            | `shared/git_local.rs::read_tree_files_filtered`                                                                |
| Enumerate filenames in a tree (no content) | `shared/git_local.rs::list_tree_paths_filtered`                                                                |
| Walk a tree via gix (service-side)         | `service/routes/index.rs::collect_blobs`                                                                       |
| Build + write a tree                       | `cli/git_ops/local.rs::write_tree_from_file_map` (test), `service/git/tree_builder.rs` (production)            |
| Build + write a commit                     | `cli/git_ops/local.rs::commit_file_map_to_ref` (test fixture; no production commit-writer post Slice F.5)      |
| Update a ref (CAS or force)                | `cli/git_ops/local.rs::update_ref`                                                                             |
| Three-way text merge                       | `shared/merge.rs::merge_text_contents`                                                                         |
| Benchmark gix status                       | `examples/gix_status_spike.rs` (spike file kept for future benchmarking)                                       |

## When to add a new pattern here

Add a section when you find yourself wishing this doc had answered "how do other parts of the codebase do X with git" — especially when the answer is non-obvious (e.g. "why shell out instead of using gix"). The bus factor on gix knowledge in this repo is small; capturing the reasoning beats re-deriving it.

## See also

- [GIX_UPGRADE.md](GIX_UPGRADE.md) — version pinning rationale, push migration options.
- [REPO_STRUCTURES.md](REPO_STRUCTURES.md) — on-disk layout (bare repos, worktrees, refs).
- [REVIEW_MODEL.md](REVIEW_MODEL.md) — the `accepted-patches.json` format that drives the field-level accept/reject/discard surface in `shared/review_ops.rs`.
