# Git tree corruption: empty path segments (scratch-git-2 + server)

**Date**: 2026-04-09  
**Status**: Proposed

## Investigation questions (distilled)

1. **Why does the Scratch Git HTTP backend report “possible repository corruption” when local Git commands still seem to work?**  
   The smart HTTP path runs `git http-backend`, which serves fetches via `upload-pack` → `git pack-objects`. That walk must parse every tree object on the reachable graph. Lighter commands (for example `git ls-remote` on a bare repo, or operations that never traverse bad objects) can succeed while pack construction fails.

2. **What does `git fsck` mean by `error: empty filename in tree entry`?**  
   A tree object in the object database contains a line whose path name is empty. Valid Git trees never have empty names; `git fsck` and `pack-objects` treat this as corruption.

3. **Why does this show up when multiple data folders for one connector (e.g. Spotify) load at the same time?**  
   Connectors typically share **one bare repository per connection** (V2 layout: `org/.../coa_<id>.git`). Many folders mean many commits into the same repo, which increases exposure to bad paths. The underlying issue is **path shape**, not necessarily scheduling; parallel loads correlate because they increase traffic and surface path-construction bugs.

4. **Is this a concurrency bug inside scratch-git-2?**  
   Writes to the same repo and branch are serialized via `WriteLockManager` in normal commit routes. The primary failure mode identified is **invalid tree writes** from malformed paths, not interleaved pack files. A separate concern: some routes (for example rename) may not take the same lock and deserve review under load.

## Problem summary

Scratch stores workbook record files in **bare Git repositories**. The Rust service (`scratch-git-2`) builds tree objects with **gix** by splitting file paths on `/` and using each segment as a Git tree entry name.

The service path builder **`apply_changes_to_tree`** (`scratch-git-2/src/service/git/tree_builder.rs`) does **not** normalize paths. If a logical path contains an **empty segment**—most commonly from a **double slash** (`a//b`) or a **leading slash** in a segment after prefix stripping—the code can emit a tree entry whose **filename is the empty string**. gix writes that object; canonical Git then rejects it: `git fsck` reports `empty filename in tree entry`, and `git pack-objects` dies during HTTP fetch/clone.

The CLI-side tree builder in **`write_tree_from_file_map`** (`scratch-git-2/src/cli/git_ops/local.rs`) **filters out empty segments** (`split('/').filter(!empty)`), so the same path string can be **accepted on one code path and turned into invalid objects on another**.

On the server, **`buildGitFilesFromConnectorFiles`** (`server/src/worker/jobs/job-definitions/connector-file-utils.ts`) builds paths as `prefix + '/' + fileName`. If `parentPath` (from `DataFolder.path`) ever includes a **trailing slash**, the result contains `//` before the filename. Downstream code often strips only a **single** leading slash before sending paths to scratch-git, so **internal** double slashes can survive and trigger the bug.

## Goals

- Never write Git tree objects with empty path components, regardless of caller bugs.
- Normalize connector/file paths at the server when building git file lists.
- Align service behavior with the CLI’s “no empty segments” rule.
- Restore confidence in `git fsck` and HTTP clone/fetch for affected repos (may require one-time repair or re-init for already-corrupted local stores).

## Non-goals

- Automatic repair of historically corrupted object databases in this document (operational playbook can be separate).
- Changing the domain model of `DataFolder.path` beyond safe normalization at commit boundaries.

## Fix plan

### A. scratch-git-2 (defense in depth)

1. **Normalize paths at the boundary of `apply_changes_to_tree`**  
   - For each `FileChange.path`, apply the same semantics as `insert_path` in `local.rs`: split on `/`, drop empty segments, reject if the result is empty or contains `.` / `..` as components (match or call shared helper).  
   - Rejoin with `/` for the internal algorithm.  
   - Optionally centralize in a small module (e.g. `git_path.rs`) used by both CLI `insert_path` and service tree building to avoid drift.

2. **Validate before `write_tree_from_entries`**  
   - Assert every entry `name` is non-empty (and optionally forbid `.` / `..`).  
   - Return a clear `400`/`internal` error instead of writing bad objects.

3. **Audit other writers**  
   - Any code path that constructs `FileChange` or calls `write_tree_from_entries` should either use the normalizer or be proven safe.

4. **Locking (follow-up)**  
   - Ensure every mutating route (including rename / squashed dirty updates) uses the same `write_locks.with_lock(repo_id, branch)` pattern where two writers could touch the same ref.

5. **Tests**  
   - Unit tests in `tree_builder.rs`: paths like `a//b`, `//a/b`, `a/b//c` normalize or error; never produce empty entry names.  
   - Regression test that `git fsck` passes on a repo after committing such inputs (normalized).

### B. Server (stop generating `//`)

1. **`buildGitFilesFromConnectorFiles`**  
   - Normalize `parentPath` before concatenation: trim `/` from both ends, collapse repeated slashes, treat `/` and empty as “root” consistently.  
   - Build `fullPath` without producing `//` (e.g. join with a single `/` between normalized prefix and file name).

2. **Call sites**  
   - Confirm `pull-files` and `pull-linked-folder-files` (and any similar batch commit paths) pass normalized folder paths or rely on the helper above.

3. **Tests**  
   - Extend `connector-file-utils` / job specs: `parentPath` with trailing slash, double slashes, and `//`-only edge cases; assert committed paths have no empty segments.

### C. Verification

1. After changes: `git fsck --full` on a fresh connector repo after multi-folder pull simulation.  
2. HTTP: clone or fetch against scratch-git-2’s `git-upload-pack` for that repo; confirm no `git-pack-objects` / corruption stderr.  
3. Optional: grep or telemetry for paths containing `//` before commit in dev.

## References (code)

| Area | File |
|------|------|
| Service tree application | `scratch-git-2/src/service/git/tree_builder.rs` |
| CLI safe path insert | `scratch-git-2/src/cli/git_ops/local.rs` (`insert_path`) |
| Tree entry write | `scratch-git-2/src/service/git/repo.rs` (`write_tree_from_entries`) |
| HTTP git backend | `scratch-git-2/src/service/routes/smart_http.rs` |
| Write locks | `scratch-git-2/src/service/git/lock.rs`, `scratch-git-2/src/service/routes/write.rs` |
| Path construction from pulls | `server/src/worker/jobs/job-definitions/connector-file-utils.ts` |
| Pull job batching | `server/src/worker/jobs/job-definitions/pull-files.job.ts`, `pull-linked-folder-files.job.ts` |
