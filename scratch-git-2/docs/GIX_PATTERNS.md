# Gix Patterns

How the `scratch-git-2` codebase uses [gix](https://docs.rs/gix) (`gitoxide`) for local git operations. Companion to [GIX_UPGRADE.md](GIX_UPGRADE.md), which covers the version pin (0.70) and why we haven't upgraded.

This is a quick reference for "where do I look when I need to do X with git" — every pattern below is in production today.

## When to reach for gix vs. shelling out

| Operation                                 | Use                                                 | Why                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Open a repo (bare or worktree)            | `gix::open`                                         | Cheap, in-process, no subprocess.                                                                                                           |
| Resolve a ref (`refs/heads/main` → SHA)   | `repo.rev_parse_single`                             | Same.                                                                                                                                       |
| Check "what changed in the working tree?" | `repo.status(...).into_index_worktree_iter(...)`    | Index-backed, parallel by default. Measured ~210ms warm on 110k files vs ~1.6s cold for `git status --porcelain`.                           |
| Build trees / commits / update refs       | `repo.write_object` + `repo.reference(...)`         | In-process; no fork/exec; lets us treat objects as Rust values.                                                                             |
| Read **many** blobs from a tree           | Shell out to `git ls-tree` + `git cat-file --batch` | gix's per-blob lookup loop is ~80× slower (0.5s vs 39s for 23k files). See [`read_tree_files_filtered`](../src/shared/git_local.rs).        |
| Worktree add                              | Shell out to `git worktree add`                     | gix 0.70 has no equivalent; we paid this cost in `setup_sparse_worktree` historically and one call per connection at init isn't a hot path. |
| `git fetch` / `git clone`                 | Shell out to system `git` (currently)               | See [GIX_UPGRADE.md § Current status of the CLI gix migration](GIX_UPGRADE.md#current-status-of-the-cli-gix-migration).                     |
| `git push`                                | Shell out to system `git`                           | gix doesn't ship push in any released version (gitoxide issue #306, open since 2022).                                                       |

## The four patterns we use most

### 1. Open a repo

```rust
use std::path::Path;

pub fn open_bare_repo(bare_repo: &Path) -> anyhow::Result<gix::Repository> {
    gix::open(bare_repo.to_path_buf())
        .with_context(|| format!("failed to open git repo {}", bare_repo.display()))
}
```

Works for both bare repos and worktrees — gix figures it out from the `.git` file/dir. Cheap (~0.5–2.5ms in the spike).

Canonical site: [`shared/git_local.rs:28`](../src/shared/git_local.rs).

### 2. Resolve a revision

```rust
pub fn rev_parse_optional_to_string(bare_repo: &Path, rev: &str) -> anyhow::Result<Option<String>> {
    let repo = open_bare_repo(bare_repo)?;
    match repo.rev_parse_single(rev) {
        Ok(id) => Ok(Some(id.detach().to_string())),
        Err(_) => Ok(None),
    }
}
```

`rev_parse_single` accepts anything `git rev-parse` does — `refs/heads/main`, `HEAD`, `abc1234`, `main^`, etc. Returns a `gix::Id<'_>` borrowed against the repo; call `.detach()` to free the borrow and turn it into an owned `ObjectId`.

Use `Option<String>` for "ref may not exist yet" (e.g. a freshly-cloned repo before `refs/heads/main` is wired up). Errors only when the repo itself can't be opened.

Canonical site: [`shared/git_local.rs:36`](../src/shared/git_local.rs).

### 3. Detect working-tree changes (the fast path)

The single biggest win we get from gix. The CLI's "is there anything to upload?" check (`detect_unreviewed_fast` in `cli/commands/files.rs`) ran multi-second tree walks before; the gix `status` API is index-backed and parallel:

```rust
let repo = gix::open(&worktree_dir)?;
let platform = repo.status(gix::progress::Discard)?;
let iter = platform.into_index_worktree_iter(Vec::<gix::bstr::BString>::new())?;

use gix::status::index_worktree::iter::Summary;
for item in iter {
    let item = item?;
    let Some(summary) = item.summary() else { continue };
    let rel_path: String = String::from_utf8_lossy(item.rela_path()).into_owned();
    let status = match summary {
        Summary::Modified => "modified",
        Summary::Added => "added",
        Summary::Removed => "deleted",
        Summary::Renamed | Summary::Copied => "modified",
        Summary::Conflict | Summary::TypeChange | Summary::IntentToAdd => continue,
    };
    // ...
}
```

Measured ~210ms warm / ~235ms cold on the 110k-file Stripe worktree (vs ~1.6s cold for `git status --porcelain`). The index must reflect `refs/heads/main` for the result to mean "differs from main"; we keep it in sync via [`worktree_reset_mixed`](../src/cli/git_ops/local.rs) after init and after pull.

Canonical site: [`cli/commands/files.rs:2657`](../src/cli/commands/files.rs) (`detect_unreviewed_fast`). The original perf spike lives in `examples/gix_status_spike.rs` for future benchmarking.

### 4. Read many blobs from a tree — shell out

gix has per-blob lookups (`repo.find_object(id)?.into_blob().data`), but a loop of them on the Stripe tree (23k JSON files) took ~39 seconds. The equivalent `git ls-tree` + `git cat-file --batch` pipeline finishes in ~500ms because `cat-file --batch` reuses a single pack-index lookup pass.

So when you need "every blob in this tree" or "the blobs for this folder's records," use the helpers in `shared/git_local.rs`:

- `read_tree_files(bare_repo, treeish)` — read all blobs at a tree.
- `read_tree_files_filtered(bare_repo, treeish, |path| ...)` — read only matching blobs. `ls-tree` enumerates everything (cheap, metadata-only), `cat-file` only processes the matching subset.
- `list_tree_paths_filtered(bare_repo, treeish, |path| ...)` — paths only, no content. Sub-second on 38k-record folders; right for "I just need filenames" callers like `findRecordOffset` on the desktop.

These shell out to `git`, not gix — that's intentional. The pattern is exposed as `FileMap` (`HashMap<String, Vec<u8>>`) so callers don't have to think about which engine produced the bytes.

Canonical sites: [`shared/git_local.rs:47`](../src/shared/git_local.rs), [`shared/git_local.rs:58`](../src/shared/git_local.rs), [`shared/git_local.rs:108`](../src/shared/git_local.rs).

## Building trees, commits, and refs (test-only today)

The production CLI no longer writes commits locally (publishing is a server-side HTTP call after the Phase 1 migration). The test fixture builder in `cli/git_ops/local.rs` still uses gix for this so tests can seed known trees:

```rust
let tree_id = write_tree_from_file_map(&repo, files)?;       // returns gix::ObjectId
let time = gix::date::Time::now_local_or_utc();
let author = gix::actor::SignatureRef {
    name: "Scratch CLI".into(),
    email: "cli@scratch.md".into(),
    time,
};
let commit = gix::objs::Commit {
    tree: tree_id,
    parents: parents.into(),
    author: author.to_owned(),
    committer: author.to_owned(),
    encoding: None,
    message: message.into(),
    extra_headers: vec![],
};
let commit_id = repo.write_object(&commit)?;
repo.reference(
    refname,
    commit_id.detach(),
    gix::refs::transaction::PreviousValue::Any,
    "scratchmd commit",
)?;
```

Trees are built via `gix::objs::Tree::empty()` + pushing `gix::objs::tree::Entry { mode, filename, oid }` rows (must be sorted — git rejects unsorted entries). The service side at `service/git/tree_builder.rs` does the same dance for production tree writes.

Canonical sites: [`cli/git_ops/local.rs:54`](../src/cli/git_ops/local.rs) (test-only), [`service/git/tree_builder.rs`](../src/service/git/tree_builder.rs) (service-side production), [`service/git/repo.rs`](../src/service/git/repo.rs).

### Updating refs

```rust
let oid = gix::ObjectId::from_hex(hex_sha.as_bytes())?;
repo.reference(
    "refs/heads/main",
    oid,
    gix::refs::transaction::PreviousValue::Any,
    "scratchmd update-ref",
)?;
```

The `PreviousValue` arg is the CAS guard — `Any` is "force update," `MustExistAndMatch(id)` is "only update if it's still at `id`" (use for safe-advances after a fetch).

Canonical site: [`cli/git_ops/local.rs:29`](../src/cli/git_ops/local.rs) (`update_ref`).

## What we deliberately don't use gix for

- **`git fetch` / `git clone`** — the gix transport API is functional (commit `65cb4dd6` proved this) but the follow-up reorg reverted to shell-out. The path back is documented in [GIX_UPGRADE.md § Clone and fetch: regression back to system git](GIX_UPGRADE.md#clone-and-fetch-regression-back-to-system-git).
- **`git push`** — gix doesn't ship push. See [GIX_UPGRADE.md § Push: no gix support in any version](GIX_UPGRADE.md#push-no-gix-support-in-any-version). The CLI's only push site (`upload`) routes through the server's `/upload-patch` endpoint instead, so the CLI no longer pushes at all post-Phase-1.
- **Worktree `add` / `prune` / `remove`** — gix 0.70 has limited worktree support. The four call sites (`cli/git_ops/local.rs`, `cli/commands/workspaces.rs`, `service/worktree.rs` historically) shell out to system `git`. Hot path is one `worktree add` per connection at init; not worth a gix migration.
- **Merge** — `shared/merge.rs` uses `gix::merge::blob::builtin_driver` for the text-merge driver, but the orchestration (three-way + conflict markers) is hand-rolled around it. No top-level `gix::merge` we could call.

## Quick lookup — "where do I find an example of..."

| You want to do                             | Look at                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Open a bare repo                           | `shared/git_local.rs::open_bare_repo`                                                                          |
| Resolve a ref to a SHA                     | `shared/git_local.rs::rev_parse_optional_to_string`, `cli/git_ops/local.rs::rev_parse`                         |
| Detect "what changed?" in the working tree | `cli/commands/files.rs::detect_unreviewed_fast`                                                                |
| Read all blobs from a tree                 | `shared/git_local.rs::read_tree_files`                                                                         |
| Read a filtered subset of blobs            | `shared/git_local.rs::read_tree_files_filtered`                                                                |
| Enumerate filenames in a tree (no content) | `shared/git_local.rs::list_tree_paths_filtered`                                                                |
| Build + write a tree                       | `cli/git_ops/local.rs::write_tree_from_file_map` (test), `service/git/tree_builder.rs` (production)            |
| Build + write a commit                     | `cli/git_ops/local.rs::commit_file_map_to_ref` (test), `service/git/repo.rs::commit_with_parents` (production) |
| Update a ref (CAS or force)                | `cli/git_ops/local.rs::update_ref`                                                                             |
| Three-way text merge                       | `shared/merge.rs`                                                                                              |
| Benchmark gix status                       | `examples/gix_status_spike.rs`                                                                                 |

## When to add a new pattern here

Add a section when you find yourself wishing this doc had answered "how do other parts of the codebase do X with git" — and especially when the answer is non-obvious (e.g. "why shell out instead of using gix"). The bus factor on gix knowledge in this repo is small; capturing the reasoning beats re-deriving it.
