# Git Scaling Strategy

Analysis and recommendations for scaling the git-based storage layer in Scratch (scratch-git) to handle 100k-1M files per repo with frequent updates and many concurrent users.

## Table of Contents

- [Current Architecture](#current-architecture)
- [Known Problems](#known-problems)
- [Sources of Repo Bloat](#sources-of-repo-bloat)
- [Object Creation Analysis](#object-creation-analysis)
- [Strategy 1: Prevent Repo Size Explosion](#strategy-1-prevent-repo-size-explosion)
- [Strategy 2: SQLite Index Layer](#strategy-2-sqlite-index-layer)
- [Strategy 3: Replace isomorphic-git Hot Paths](#strategy-3-replace-isomorphic-git-hot-paths)
- [Strategy 4: Full isomorphic-git Replacement](#strategy-4-full-isomorphic-git-replacement)
- [Implementation Priority](#implementation-priority)

---

## Current Architecture

### Components

- **scratch-git** (`/scratch-git`): Standalone Node.js microservice on port 3100 (API) and 3101 (git HTTP backend)
- **Server** (`/server/src/scratch-git`): NestJS HTTP client that proxies requests to scratch-git

### Storage Model

- **One bare git repository per workbook**, stored in a configurable `GIT_REPOS_DIR` (default: `repos/`)
- **Two persistent branches** per repo:
  - `main` — published/committed state
  - `dirty` — work-in-progress user changes
- **No working directory** — all operations use isomorphic-git's plumbing APIs (readBlob, writeBlob, readTree, writeTree, walk, etc.)
- **No checkout** — this was a deliberate design choice to avoid data corruption bugs from checkout-based operations depending on hidden "current branch" state

### isomorphic-git Primitives Used

The entire git layer uses exactly 11 isomorphic-git APIs:

| API               | Purpose               | Complexity            |
| ----------------- | --------------------- | --------------------- |
| `resolveRef()`    | Branch OID lookup     | O(1)                  |
| `readCommit()`    | Commit metadata       | O(1)                  |
| `readBlob()`      | File content by OID   | O(1)                  |
| `writeBlob()`     | Create blob object    | O(file size)          |
| `readTree()`      | Directory entries     | O(1) per subtree      |
| `writeTree()`     | Create tree object    | O(entries)            |
| `writeCommit()`   | Create commit         | O(1)                  |
| `writeRef()`      | Update branch pointer | O(1)                  |
| `walk()`          | Traverse entire tree  | **O(n) — bottleneck** |
| `findMergeBase()` | Common ancestor       | O(commit graph)       |
| `init()`          | Create repo           | O(1)                  |

### Concurrency

Write locks are in-memory per `repoId:ref` pair (`scratch-git/src/services/git-lock.ts`). This serializes writes within a single Node.js process but does **not** handle multi-instance deployments.

### Key Service Files

| File                                                  | Purpose                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `scratch-git/src/services/base-repo.service.ts`       | Tree walking, ref resolution, file reads, commit comparison |
| `scratch-git/src/services/repo-write.service.ts`      | Commits, deletes, renames, rebase (largest: ~540 lines)     |
| `scratch-git/src/services/repo-read.service.ts`       | File listing, pagination, archive generation                |
| `scratch-git/src/services/repo-diff.service.ts`       | Dirty status detection                                      |
| `scratch-git/src/services/repo-manage.service.ts`     | Init, delete, reset                                         |
| `scratch-git/src/services/repo-checkpoint.service.ts` | Tag-based snapshots (exists but not actively used by UI)    |
| `scratch-git/src/services/git-lock.ts`                | In-memory write lock per ref                                |

---

## Known Problems

### 1. Repo size explosion

isomorphic-git stores every `writeBlob()` as a loose object file under `.git/objects/`. It has no packfile creation or garbage collection. A test repo with ~100k files accumulated ~1M loose objects and grew to 27 GB. This made native `git http-backend` unable to serve the repo for cloning until a manual `git repack` was run.

### 2. Slow dirty file loading

`getDirtyStatus()` calls `compareCommits()` which calls `getTreeFiles()` twice — once for each branch. Each call uses `git.walk()` to traverse the **entire** tree. For a 100k-file repo, this is 200k tree entries visited per dirty status check. The UI (used to) poll this every 10 seconds.

### 3. Event loop blocking

isomorphic-git is CPU-bound JavaScript running on the Node.js event loop. Tree walks of 100k files take 3-10 seconds and block all other requests. With multiple concurrent users, this causes cascading latency.

### 4. No rebase with custom merge driver

The 3-way merge (using `node-diff3`) is hand-rolled in `repo-write.service.ts`. Implementing a JSON-aware merge driver or leveraging git's built-in merge machinery would require replacing isomorphic-git.

### 5. No garbage collection

No `git gc`, `git prune`, or packfile optimization exists. Loose objects accumulate indefinitely. Unreachable objects (from rebases, old commits) are never cleaned up.

### 6. Inefficient job granularity (Data Folder based polling)

Current poll jobs are Data Folder based. This is suboptimal because:

- **API quota is per-connection**: There is no benefit in parallelizing work into multiple jobs if they all share the same connection quota.
- **Git locking**: Git is locking by nature; multiple jobs attempting to write to the same repository simultaneously create contention and potential bottlenecks.

Publish jobs are already connection-based, which avoids these issues as they do not result in API or Git locking conflicts.

---

## Sources of Repo Bloat

### 1. Loose objects with no packing

Every `writeBlob()` creates a file at `.git/objects/xx/yyyy...`. Native git periodically compresses these into packfiles with delta compression. isomorphic-git never does. Every version of every file is stored as a full, individually zlib-compressed loose object.

### 2. Unreachable objects that never get pruned

When `rebaseDirty()` runs, old dirty commits become unreachable (no ref points to them). Their blobs and trees remain on disk. Similarly, `applyChangesToTree()` creates new tree objects for modified directories, making old tree objects unreachable.

### 3. Dual-branch architecture doubles tree objects

When dirty diverges from main — even by one file — the tree objects for every parent directory diverge too. A single edit to `data/table1/record_abc.json` creates new tree objects for `data/table1/`, `data/`, and the root tree on the dirty branch.

### 4. No history depth limit

Every commit is retained forever. Daily syncs over a year = 365+ commits, each with a root tree pointing to 100k blobs.

### 5. Checkpoints (if activated)

The checkpoint system creates git tags (`main_{name}` + `dirty_{name}`) that make entire commit trees permanently reachable. Each tag pins ~100k blobs that `git gc` cannot collect. **Note:** Checkpoints exist in the codebase but are not currently triggered by the UI or background jobs.

---

## Object Creation Analysis

### Per-operation object creation

For a user with 100k Airtable records doing a sync → edit → publish → re-sync cycle:

| Step                        | Blobs     | Trees    | Commits | Notes                                 |
| --------------------------- | --------- | -------- | ------- | ------------------------------------- |
| Initial sync (100k files)   | ~100k     | ~100     | 1       | One blob per record, one batch commit |
| Rebase dirty onto main      | 0-100     | 0-100    | 0-1     | Only if diverged                      |
| Edit 1000 records + publish | ~6k       | ~600     | ~10     | 5 pipeline phases × 2 branches        |
| Re-sync 100k records        | ~5k       | ~100     | 1       | Only changed records write new blobs  |
| **One cycle total**         | **~111k** | **~800** | **~13** |                                       |

### Disk size estimates (loose objects)

- First sync: ~100k blobs × ~5KB avg = **~500 MB**
- After 10 sync cycles with 10% churn: **~150k loose objects, ~750 MB**
- After months of daily syncs: **millions of loose objects, tens of GB**

### Disk size estimates (with packfiles)

The JSON files use consistent key ordering with one key/value per line. This format is ideal for git's delta compression — a one-field change in a 50-field record produces a delta of ~100 bytes.

- Same 100k-file repo with packing: **~50-100 MB**
- With packing + history truncation: **~10-50 MB**

---

## Strategy 1: Prevent Repo Size Explosion

### 1.1 `git gc` and `git repack`

Shell out to native git for garbage collection. This is the single most important fix.

```typescript
// In RepoManageService or a new RepoMaintenanceService
async runGc(repoId: string, aggressive = false): Promise<void> {
  const repoPath = this.getRepoPath(repoId);
  const args = aggressive
    ? ['gc', '--aggressive', '--prune=now']
    : ['gc', '--auto'];
  await execFile('git', args, { cwd: repoPath });
}
```

**When to run:**

- `git gc --auto` after every publish cycle (runs only when loose object count exceeds threshold)
- `git gc --aggressive --prune=now` on a nightly cron per repo
- After any bulk sync operation

**Packfile tuning** (set in each repo's `.git/config`):

```ini
[pack]
    window = 250        # Compare 250 objects for delta (default 10) — better for similar JSON
    depth = 50          # Max delta chain depth
    threads = 0         # Use all CPU cores

[gc]
    auto = 1000         # Run gc after 1000 loose objects (default 6700)
    autoPackLimit = 10  # Repack when >10 packfiles
    pruneExpire = 1.day # Prune unreachable objects after 1 day (default 2 weeks)
```

The `window = 250` is key for JSON records — git finds deltas by comparing each object against the N most similar recent objects. Larger window = better delta matches for structured data.

**Expected impact:** 5-10x repo size reduction from packfile compression alone. With the well-formatted JSON, potentially 50-100x for historical versions.

### 1.2 Content normalization (verify hash-before-write)

Every unnecessary new blob costs ~5KB and makes gc slower. The sync service already has an `isEqual` check to skip unchanged records, but verify that:

1. **Comparison happens on serialized bytes**, not parsed objects. `isEqual` on objects could miss formatting differences that `writeBlob` would see.
2. **JSON serialization is deterministic.** Consistent key ordering + one key/value per line is already in place (confirmed). This means two identical records always produce the same blob SHA.
3. **Volatile fields are stripped.** If the source API returns `lastModified`, `lastSyncedAt`, or other timestamps that change on every read but aren't meaningful content, strip them before writing to git. Each volatile field on 100k records means 100k new blobs per sync with zero real changes.

**Expected impact:** For a sync with 0% real changes, this should produce 0 new blobs instead of 100k.

### 1.3 Shallow history (squash commits older than N days)

Repos don't need deep history — they're content stores, not source code. Squash commits older than a retention window (e.g., 30 days) to bound the reachable object set.

#### The merge base constraint

`rebaseDirty()` uses `findMergeBase(main, dirty)` to find the common ancestor for 3-way merge. If history is truncated carelessly, the merge base may not exist, causing the rebase to fall through to the "no common ancestor" case and **silently discard user edits**.

**Safe rule:** Only truncate commits older than the merge base of main and dirty.

#### Implementation (isomorphic-git)

After every publish/rebase (when dirty is at or near main), rewrite the commit chain so the oldest commit within the retention window becomes an orphan root:

```typescript
async squashOlderThan(days: number): Promise<void> {
  const dir = this.getRepoPath();
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

  // 1. Collect main's linear history, newest first
  const mainHead = await this.resolveRef(MAIN_BRANCH);
  const history: Array<{ oid: string; commit: CommitObject }> = [];
  let cursor = mainHead;

  while (cursor) {
    const { commit } = await git.readCommit({ fs, dir, gitdir: dir, oid: cursor });
    history.push({ oid: cursor, commit });
    if (commit.parent.length === 0) break;
    cursor = commit.parent[0];
  }

  // 2. Find first commit older than cutoff (scanning newest→oldest)
  const cutoffIdx = history.findIndex(h => h.commit.committer.timestamp < cutoff);
  if (cutoffIdx <= 0) return; // Nothing to squash

  // 3. Make cutoff commit an orphan root, replay everything newer on top
  const oldToNew = new Map<string, string>();

  const rootEntry = history[cutoffIdx];
  const newRoot = await git.writeCommit({
    fs, dir, gitdir: dir,
    commit: { ...rootEntry.commit, parent: [] },
  });
  oldToNew.set(rootEntry.oid, newRoot);

  for (let i = cutoffIdx - 1; i >= 0; i--) {
    const entry = history[i];
    const newParents = entry.commit.parent.map(p => oldToNew.get(p) ?? p);
    const newOid = await git.writeCommit({
      fs, dir, gitdir: dir,
      commit: { ...entry.commit, parent: newParents },
    });
    oldToNew.set(entry.oid, newOid);
  }

  // 4. Update main ref
  await this.forceRef(MAIN_BRANCH, oldToNew.get(mainHead)!);

  // 5. Update dirty ref (may point to main or have its own commits)
  const dirtyHead = await this.resolveRef(DIRTY_BRANCH);

  if (oldToNew.has(dirtyHead)) {
    await this.forceRef(DIRTY_BRANCH, oldToNew.get(dirtyHead)!);
  } else {
    // Dirty has commits not on main — walk and rewrite
    const dirtyOnly: Array<{ oid: string; commit: CommitObject }> = [];
    let dCursor = dirtyHead;

    while (dCursor && !oldToNew.has(dCursor)) {
      const { commit } = await git.readCommit({ fs, dir, gitdir: dir, oid: dCursor });
      dirtyOnly.push({ oid: dCursor, commit });
      if (commit.parent.length === 0) break;
      dCursor = commit.parent[0];
    }

    for (let i = dirtyOnly.length - 1; i >= 0; i--) {
      const entry = dirtyOnly[i];
      const newParents = entry.commit.parent.map(p => oldToNew.get(p) ?? p);
      const newOid = await git.writeCommit({
        fs, dir, gitdir: dir,
        commit: { ...entry.commit, parent: newParents },
      });
      oldToNew.set(entry.oid, newOid);
    }

    await this.forceRef(DIRTY_BRANCH, oldToNew.get(dirtyHead)!);
  }

  // 6. Old commits are now unreachable — follow with git gc
}
```

After this, the graph is:

```
main:  C' ← D' ← E'        (C' = orphan root, 30 days of history)
                   \
dirty:              E' ← F'  (user edits preserved, merge base = E')
```

**When to trigger:** After every successful publish cycle, or on a nightly cron. Always follow with `git gc --prune=now`.

#### Simpler alternative: squash to 1 commit

If no history is needed, create a single orphan commit with the current tree after every publish:

```typescript
async truncateAllHistory(): Promise<void> {
  const dir = this.getRepoPath();
  const mainCommit = await this.resolveRef(MAIN_BRANCH);
  const { commit } = await git.readCommit({ fs, dir, gitdir: dir, oid: mainCommit });

  const newRoot = await git.writeCommit({
    fs, dir, gitdir: dir,
    commit: {
      tree: commit.tree,
      parent: [],
      message: 'History truncated',
      author: commit.author,
      committer: commit.committer,
    },
  });

  const dirtyCommit = await this.resolveRef(DIRTY_BRANCH);

  if (dirtyCommit === mainCommit) {
    await this.forceRef(MAIN_BRANCH, newRoot);
    await this.forceRef(DIRTY_BRANCH, newRoot);
  } else {
    const { commit: dirtyObj } = await git.readCommit({ fs, dir, gitdir: dir, oid: dirtyCommit });
    const newDirty = await git.writeCommit({
      fs, dir, gitdir: dir,
      commit: { ...dirtyObj, parent: [newRoot] },
    });
    await this.forceRef(MAIN_BRANCH, newRoot);
    await this.forceRef(DIRTY_BRANCH, newDirty);
  }
}
```

### 1.4 Checkpoint expiry (if checkpoints are activated)

If the checkpoint feature is enabled in the future, add expiry policies:

- **Max count:** Keep the N most recent checkpoints, delete the rest
- **Max age:** Delete checkpoints older than M days
- **Delete tags properly:** Call `git.deleteTag()` for both `main_{name}` and `dirty_{name}` so the tagged commits become unreachable

Without expiry, each checkpoint permanently pins ~100k blobs that `git gc` cannot collect.

### 1.5 Periodic full rewrite (for legacy repos)

For repos that have already accumulated massive bloat, create a fresh repo with just the current state:

```typescript
async compactRepo(repoId: string): Promise<void> {
  // 1. Init fresh repo at tmpDir
  // 2. Copy current main tree files into fresh repo
  // 3. Copy current dirty tree files
  // 4. Swap old repo with fresh repo
}
```

This gives a repo with exactly 2 commits, zero history, zero unreachable objects.

### 1.6 Summary of size management strategies

| Strategy                               | Effort   | Impact                                        |
| -------------------------------------- | -------- | --------------------------------------------- |
| `git gc --auto` after heavy operations | 1 day    | 5-10x size reduction via packfile compression |
| Verify hash-before-write               | 1 day    | Prevents 90%+ of unnecessary blob creation    |
| Shallow history (squash old commits)   | 1-2 days | Eliminates all historical bloat               |
| Checkpoint expiry                      | 0.5 days | Unblocks gc from collecting old trees         |
| Packfile tuning (gc config)            | 0.5 days | Better compression for JSON data              |
| Full rewrite (legacy repos)            | 1 day    | Recovers already-bloated repos                |

Strategies 1-3 together would keep a 100k-file repo under ~100-200 MB indefinitely, even with daily syncs. That's ~100x improvement over the current trajectory.

---

## Strategy 2: SQLite Index Layer

### Problem

The dominant bottleneck for reads is `getTreeFiles()` in `base-repo.service.ts` — it calls `git.walk()` which visits every blob in the tree. This is O(n) where n = total files. With an index, reads become O(1) or O(k) where k = results needed.

### Operations that benefit

| Operation                | Before (git.walk)                          | After (SQLite)                                   | Speedup    |
| ------------------------ | ------------------------------------------ | ------------------------------------------------ | ---------- |
| `list(folder)`           | Walk 100k entries, filter by prefix        | `SELECT ... WHERE path GLOB 'folder/*'`          | ~100-1000x |
| `getDirtyStatus()`       | Walk both trees (200k entries), diff in JS | `LEFT JOIN` on path, compare OIDs                | ~100-1000x |
| `getDirtyStatusCount()`  | Same full diff, then `.length`             | `SELECT COUNT(*)` with same join                 | ~100-1000x |
| `getFolderDirtyStatus()` | Full diff, filter by prefix                | Same join + `AND path GLOB 'folder/*'`           | ~100-1000x |
| `readFilesPaginated()`   | Walk all, slice                            | `SELECT ... LIMIT ? OFFSET ?`                    | ~100-1000x |
| `readFilesFromFolder()`  | Walk all, filter, batch read               | `SELECT path, oid WHERE ...` then batch readBlob | ~10x       |
| `getFileContent()`       | readBlob by path (needs OID lookup)        | `SELECT oid WHERE path=?` then readBlob          | ~2-5x      |
| `hasDirtyFiles()`        | Already optimized (tree OID compare)       | Keep as-is                                       | ~same      |

### Why this is so much faster

The ~100-1000x speedup sounds extreme but is real. The key is understanding what `git.walk()` actually does vs. what SQLite does for the same logical operation.

**Current approach (`compareCommits` via `git.walk()`):**

1. **Recursively read tree objects from disk.** Git stores files in a tree hierarchy. For `data/products/rec_abc.json`, git reads: root tree → `data` subtree → `products` subtree → blob entry. Each tree object is a separate file under `.git/objects/`, individually zlib-compressed. For 100k files across ~100 directories, that's ~100 tree object reads, each requiring: open file → read bytes → zlib decompress → parse binary format.
2. **Visit every blob entry.** `git.walk()` yields every entry. For each of the 100k entries, isomorphic-git: resolves the tree path, allocates a JS object with `{path, oid, type, mode}`, pushes it through the async iterator. That's 100k JS object allocations, 100k async iterations (each going through the microtask queue), 100k `Map.set()` calls.
3. **Do it again for the second branch.** Another 100k entries.
4. **Diff in JS.** Iterate one map, compare against the other. Another 100k iterations.

Total: ~200k reads from git's object store, ~200k JS objects allocated, ~200k async iterations, all single-threaded with GC pauses.

**SQLite approach (single query):**

```sql
SELECT d.path, d.oid, m.oid
FROM files d
LEFT JOIN files m ON d.path = m.path AND m.branch = 'main'
WHERE d.branch = 'dirty'
  AND (m.oid IS NULL OR d.oid != m.oid)
```

1. **B-tree index scan.** SQLite walks the `(branch, path)` index for `branch = 'dirty'` — sequential scan through a sorted B-tree. The entire index is in a single file, likely already in the OS page cache.
2. **Merge join.** For each dirty entry, B-tree lookup into `branch = 'main'` — O(log n), ~17 comparisons for 100k entries, all on in-memory pages.
3. **String comparison.** `d.oid != m.oid` is a 40-byte string compare. No deserialization.
4. **Return only changed rows.** If 500 files are dirty, SQLite returns 500 rows, not 200k.

Total: one index scan + ~100k B-tree lookups, all in compiled C on memory-mapped pages. <1ms for 100k entries.

**Where the factors multiply:**

| Factor            | git.walk()                           | SQLite                        | Ratio               |
| ----------------- | ------------------------------------ | ----------------------------- | ------------------- |
| Disk reads        | ~200 tree objects (random I/O)       | 1 file (sequential, cached)   | ~100x               |
| Decompression     | ~200 zlib decompressions             | None                          | ~50x                |
| Object allocation | ~200k JS objects                     | 0 (C structs, reused)         | ~100x               |
| Async overhead    | ~200k promise resolutions            | 0 (synchronous C)             | ~50x                |
| Comparison        | JS Map iteration + lookups           | B-tree merge join in C        | ~10x                |
| GC pauses         | Significant (200k young gen objects) | None                          | variable            |
| Result size       | Always returns all 200k entries      | Returns only the ~500 changed | ~400x for filtering |

The speedup is most dramatic at scale because `git.walk()` is always O(total files) while the SQLite query's useful work scales with the result set size.

### Schema

One SQLite database per repository:

```
repos/
├── workbook-abc.git/
└── workbook-abc.idx.sqlite
```

```sql
CREATE TABLE files (
    branch  TEXT NOT NULL,      -- 'main' or 'dirty'
    path    TEXT NOT NULL,      -- 'data/products/rec_abc123.json'
    oid     TEXT NOT NULL,      -- blob SHA-1
    size    INTEGER,            -- blob size in bytes
    PRIMARY KEY (branch, path)
);

CREATE INDEX idx_files_folder ON files (branch, path);

CREATE TABLE index_state (
    branch      TEXT PRIMARY KEY,
    commit_oid  TEXT NOT NULL      -- the commit SHA this index reflects
);
```

### When to update

Update after every successful commit, in `commitChangesToRef()`. The `changes` array is already available:

```typescript
async updateIndex(repoId: string, branch: string, changes: FileChange[], newCommitOid: string) {
  const db = this.getIndexDb(repoId);
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO files (branch, path, oid, size) VALUES (?, ?, ?, ?)'
  );
  const del = db.prepare('DELETE FROM files WHERE branch = ? AND path = ?');

  db.transaction(() => {
    for (const change of changes) {
      if (change.type === 'delete') {
        del.run(branch, change.path);
      } else {
        upsert.run(branch, change.path, change.oid, change.content?.length ?? 0);
      }
    }
    db.prepare('INSERT OR REPLACE INTO index_state (branch, commit_oid) VALUES (?, ?)')
      .run(branch, newCommitOid);
  })();
}
```

For `resetDirtyToMain()` (moves dirty ref to main):

```sql
DELETE FROM files WHERE branch = 'dirty';
INSERT INTO files (branch, path, oid, size)
  SELECT 'dirty', path, oid, size FROM files WHERE branch = 'main';
UPDATE index_state SET commit_oid = ? WHERE branch = 'dirty';
```

### Consistency and recovery

On every read, verify the index is current:

```typescript
async ensureIndexCurrent(repoId: string, branch: string): Promise<void> {
  const db = this.getIndexDb(repoId);
  const indexed = db.prepare('SELECT commit_oid FROM index_state WHERE branch = ?').get(branch);
  const actual = await this.resolveRef(branch);

  if (!indexed || indexed.commit_oid !== actual) {
    await this.rebuildIndex(repoId, branch);  // Full tree walk, one-time cost
  }
}
```

Rebuild falls back to the existing `getTreeFiles()` walk but writes results to SQLite. Worst case = same as current performance. Common case (index is current) = skip the walk entirely.

### Library choice

Use **better-sqlite3** (synchronous, ~5-10x faster than async alternatives). For 100k rows, queries complete in <1ms.

### What this doesn't solve

- **Write performance** — `applyChangesToTree()` still does recursive tree manipulation
- **Event loop blocking** — isomorphic-git writes still block (but with reads offloaded, this is much less frequent)
- **Repo size** — still need `git gc` / shallow history

---

## Strategy 3: Replace isomorphic-git Hot Paths

### Hybrid approach: isomorphic-git for writes, native git for reads

Replace the slow O(n) tree walks with native git commands while keeping isomorphic-git for the write path (where the "no checkout" plumbing approach works well).

### Key replacements

| isomorphic-git call           | Native git replacement                | Notes                               |
| ----------------------------- | ------------------------------------- | ----------------------------------- |
| `git.walk()` (tree traversal) | `git ls-tree -r <ref>`                | Lists 100k files in <500ms vs 3-10s |
| `git.walk()` (diff)           | `git diff-tree -r <main> <dirty>`     | Outputs only changed files directly |
| `git.readBlob()` (bulk)       | `git cat-file --batch` (long-running) | Single process, feed OIDs on stdin  |
| `git.readBlob()` (single)     | `git show <ref>:<path>`               | Simple one-shot                     |
| `git.findMergeBase()`         | `git merge-base <a> <b>`              | One-shot, fast                      |

### Long-running `git cat-file --batch`

The key trick for bulk blob reads without per-call process spawn overhead:

```typescript
class GitCatFile {
  private proc: ChildProcess;

  constructor(repoPath: string) {
    this.proc = spawn("git", ["cat-file", "--batch"], { cwd: repoPath });
  }

  async readBlob(oid: string): Promise<Buffer> {
    this.proc.stdin.write(oid + "\n");
    // Read response: "<oid> blob <size>\n<content>\n"
    return this.readResponse();
  }
}
```

Keep 2-3 long-running processes per active repo:

1. `git cat-file --batch` — blob reads
2. `git cat-file --batch-check` — existence/size checks
3. One-off commands for writes (`git hash-object`, `git mktree`, `git commit-tree`)

### Write path with native git

Replace `applyChangesToTree()` with native plumbing:

| isomorphic-git                   | Native equivalent                             |
| -------------------------------- | --------------------------------------------- |
| `writeBlob(content)`             | `echo content \| git hash-object -w --stdin`  |
| `readTree(oid)`                  | `git ls-tree <oid>`                           |
| `writeTree(entries)`             | `git mktree` (entries on stdin)               |
| `writeCommit(tree, parent, msg)` | `git commit-tree <tree> -p <parent> -m <msg>` |
| `writeRef(ref, oid)`             | `git update-ref <ref> <oid>`                  |

### Comparison: native git vs SQLite index

These are complementary, not competing:

- **SQLite index** makes reads O(1) regardless of git backend — useful even with native git
- **Native git** makes writes faster and unlocks `git gc` naturally — useful even with SQLite
- **Together**, reads are instant (SQLite) and writes are fast (native git), with automatic repo maintenance (gc)

### Implementation effort

~1 week for the hot paths. Replace one method at a time:

1. `getTreeFiles()` → `git ls-tree -r` (~2 hours)
2. `compareCommits()` → `git diff-tree -r` (~2 hours)
3. Bulk blob reads → `git cat-file --batch` (~1 day)
4. `applyChangesToTree()` → `git ls-tree` + `git mktree` (~2-3 days)

---

## Strategy 4: Full isomorphic-git Replacement

### Options compared

|                         | isomorphic-git (current) | Native git plumbing (Strategy 3) | Go child process (go-git) | gitoxide (Rust)       |
| ----------------------- | ------------------------ | -------------------------------- | ------------------------- | --------------------- |
| **Tree walk 100k**      | 3-10s                    | 0.3-0.5s                         | 0.3-1s                    | 0.1-0.3s              |
| **Bulk blob read 10k**  | 2-5s                     | 0.5-1s                           | 0.5-1.5s                  | 0.3-0.8s              |
| **Packfile support**    | None                     | Native                           | Native                    | Native                |
| **GC support**          | None                     | Native                           | Shell out to git          | Native                |
| **Event loop blocking** | Yes                      | Partial (child procs)            | No (separate process)     | No (separate process) |
| **New language**        | No                       | No                               | Go                        | Rust                  |
| **Migration effort**    | N/A                      | ~1 week                          | ~3-4 weeks                | ~3-4 weeks            |
| **Concurrent users**    | Poor                     | Medium                           | Excellent                 | Excellent             |

### Option A: Shell out to git plumbing (recommended near-term)

See Strategy 3 above. Best bang-for-buck: native git speed, no new language, incremental migration.

### Option B: Go child process with go-git

Spawn a Go binary communicating over stdin/stdout with length-prefixed messages (like LSP servers). The Go process holds repos open in memory.

**Where go-git excels:**

- Tree walking with real parallelism via goroutines
- Native packfile handling (no loose object explosion)
- Efficient memory model (no V8 GC pauses)
- Multiple repos processed concurrently

**Where go-git has gaps:**

- No `git gc` implementation — still need to shell out to native git
- Basic merge support only — keep node-diff3 logic in TypeScript
- Occasional correctness issues with edge cases (packfile negotiation, unusual ref formats)

**API mapping:**

```go
func (s *GitService) ResolveRef(repoPath, ref string) (string, error)
func (s *GitService) ReadBlob(repoPath, oid, filepath string) ([]byte, error)
func (s *GitService) WriteBlob(repoPath string, content []byte) (string, error)
func (s *GitService) ReadTree(repoPath, oid string) ([]TreeEntry, error)
func (s *GitService) WriteTree(repoPath string, entries []TreeEntry) (string, error)
func (s *GitService) WriteCommit(repoPath string, tree, parent, msg string) (string, error)
func (s *GitService) UpdateRef(repoPath, ref, oid string) error
func (s *GitService) ListFiles(repoPath, ref string) ([]FileEntry, error)
func (s *GitService) FindMergeBase(repoPath, a, b string) (string, error)
func (s *GitService) InitRepo(repoPath string) error
```

**Implementation effort:** 3-4 weeks. New language, IPC protocol, build pipeline.

### Option C: gitoxide (Rust) as child process

Same architecture as Go option. gitoxide is the fastest git implementation available (~100ms for 100k-entry tree walk). The Git API is well-defined and encapsulated, making it reasonable to "vibecode" this even without deep Rust experience. The existing Node implementation can serve as a template for the rewrite, as it already addresses various edge cases.

### Option D: libgit2 via Node.js bindings

Not recommended. `nodegit` is effectively abandoned. The Node.js native binding ecosystem for libgit2 is fragile.

### Recommendation

**Near-term:** Native git plumbing (Option A). 80% of the Go child process benefit at 20% of the cost.

**Long-term (if concurrent user scaling requires it):** Go child process (Option B). The API surface is already clean — the 11 isomorphic-git primitives map directly to Go functions.

## Strategy 5: Repo-per-Connection Architecture

Instead of one monolithic git repository per workbook, split the data into multiple repositories based on their source connection.

### The Granularity "Sweet Spot"

While it might be tempting to go even further (e.g., one repo per folder), per-folder repositories are too granular and create excessive management overhead. **Per-connection is the sweet spot.** Since background job parallelization is already bound by per-connection API quotas, using one repository per connection keeps the system perfectly symmetrical.

### Encapsulation and Sharding

Creating one repository per connection ensures that each connection's data is well-encapsulated. This architectural shift significantly improves sharding capabilities:

- **Independent Sharding**: Connection-level repositories can be distributed across worker nodes or storage instances without dependencies.
- **Localized Indexing**: The SQLite indexing layer can also be split per connection. Since there are no cross-connection foreign keys or data dependencies, this provides a clean boundary for horizontal scaling.

### Performance and Locking

Smaller repositories reduce the overhead of critical git operations like tree walks and diffs. Furthermore, it aligns git's locking granularity with the API quota granularity, eliminating the locking contention currently caused by parallel Data Folder based jobs writing to the same workbook repository.

## Strategy 6: Merge-Base UI Diffing

Modify the UI to display the `diff(merge_base, dirty)` instead of `diff(main, dirty)`.

### Problem: Phantom Deletes

Currently, if the `main` branch moves ahead (e.g., due to a pull or another user's activity) and the `dirty` branch is not immediately rebased, any rows added to `main` will appear as "deleted" in the `dirty` diff view. This is because the diff logic compares the current WIP state against the latest `main` state. This is highly confusing for users.

### Solution: Stable Baseline

By diffing against the `merge_base` (the common ancestor where `dirty` originally diverged from `main`), the UI maintains a stable baseline. New additions on `main` are simply ignored in the `dirty` view until the user explicitly rebases.

### Synergy with Repo-per-Connection

This strategy is particularly powerful when combined with a **Repo-per-Connection** architecture:

- **Independent Squashing**: We can pull data and squash it into a single clean commit on the `main` branch of a connection-specific repo without needing to rebase the `dirty` branch immediately.
- **Workflow Decoupling**: One connection can be busy pulling and writing to `main` while another has active user edits on `dirty`. The user's WIP view remains clean and focused only on their own changes relative to their starting point.

---

## Implementation Priority

| Phase         | Change                                           | Effort    | Impact                                               |
| ------------- | ------------------------------------------------ | --------- | ---------------------------------------------------- |
| **1 (now)**   | `git gc --auto` after heavy operations           | 1 day     | Prevents repo size explosion                         |
| **1 (now)**   | **Repo-per-connection architecture**             | 2-3 days  | Encapsulation, sharding, and reduced lock contention |
| **1 (now)**   | Verify hash-before-write (no unnecessary blobs)  | 1 day     | Prevents most churn                                  |
| **1 (now)**   | **Merge-base UI diffing**                        | 1 day     | Fixes phantom deletes and enables cleaner squashing  |
| **2 (soon)**  | Shallow history (squash commits >30 days)        | 1-2 days  | Bounds disk usage permanently                        |
| **2 (soon)**  | SQLite index for reads                           | 3-5 days  | 100-1000x faster file listing and dirty status       |
| **3 (next)**  | Native `git ls-tree` / `git diff-tree` for reads | 3-5 days  | 5-10x faster even without index                      |
| **3 (next)**  | Worker threads for remaining isomorphic-git ops  | 2-3 days  | Unblocks event loop                                  |
| **4 (later)** | Full native git plumbing for writes              | 1 week    | Native performance + gc for free                     |
| **5 (scale)** | Go/Rust child process                            | 3-4 weeks | Full solution for concurrent users                   |
| **5 (scale)** | Repo sharding across instances                   | 1-2 weeks | Horizontal scaling                                   |

Each phase compounds on the previous one and is independently valuable. No big-bang rewrite required.

---

## Appendix: Other Scaling Considerations

### Concurrent writes across instances

The in-memory write lock doesn't protect against multi-instance deployments. Solutions:

- **Distributed locking** (Redis-based, keyed on repo path)
- **Repo sharding** (each repo has exactly one scratch-git owner)
- **Advisory file locks** (`flock`) if instances share a filesystem

### Backup and disaster recovery

Git repos are ideal for backup — `git bundle` creates a single-file snapshot. A nightly cron that bundles each active repo to GCS provides cheap insurance against disk failure.

### Directory sharding at scale

With 10,000+ workbooks, a flat `repos/` directory hits filesystem limits. Use a sharding scheme:

```
repos/ab/cd/workbook-abcd1234.git
```

### File structure for large repos

Structure files hierarchically (e.g., `data/{folder}/{first-2-chars-of-id}/{file}.json`) so subtree reads scope to a smaller portion of the tree. This makes both git walks and SQLite queries faster for the common case of browsing a single folder.

### Monitoring

Track per-repo metrics:

- Loose object count
- Packfile size
- Total repo size on disk
- Time for key operations (dirty status, file listing, commit)
- Alert when a repo exceeds a size threshold

### Repo-per-table (structural alternative)

Instead of one repo per workbook (with all tables), use one repo per table:

- Tree walks scope to 10k files instead of 100k
- `git gc` runs faster on smaller repos
- Tables can be gc'd/truncated independently
- Deleting a table = delete the repo

Tradeoff: more repos to manage, cross-table operations become harder.

### The long-term question: do you need git?

Git is optimized for source code (thousands of files, text, human-speed changes). Scratch uses it for structured data (hundreds of thousands of files, JSON, API-speed changes). Alternatives that provide git semantics without git's filesystem assumptions:

- **Dolt** — MySQL-compatible database with branch/merge/diff at the row level
- **lakeFS** — Git-like branching for object storage (S3/GCS), designed for millions of objects
- **Custom content-addressable store** — Store blobs by hash, maintain a DAG in a database, implement diff/merge as application logic

Git works well today and the strategies above extend its useful life significantly. But if the product scales to millions of files or needs sub-second latency on all operations, a purpose-built versioned data store may be worth evaluating.

---

## Appendix: How Microsoft Scaled Git (VFS for Git → Scalar)

Microsoft's journey scaling git for the Windows monorepo (3.5M files, 300GB) is the most instructive case study for "git as a data store at scale." Their evolution went through three phases, each with lessons for Scratch.

### Phase 1: VFS for Git (2017)

**Problem:** The Windows repo was too large for git. `git status` took 10+ minutes. Cloning was impractical.

**Solution:** A virtual filesystem layer that intercepts file reads and lazily downloads git objects on demand. The working directory appears to contain all 3.5M files, but only files the developer actually opens get downloaded from the server. Git thinks the full tree is checked out; the VFS fakes it.

**Why it worked:** Developers only touch ~50k of the 3.5M files. The VFS avoided downloading the other 3.45M.

**Why they moved on:** Apple deprecated the macOS kernel features VFS for Git depended on (kext extensions). It was also fragile — a kernel-level filesystem shim that intercepted every file operation had a large surface area for bugs and performance issues.

**Lesson for Scratch:** The core insight — _you never need the entire tree materialized_ — applies directly. When a user opens a folder in the Scratch UI, only that subtree's files need to be loaded. The SQLite index strategy achieves the same effect at the application level: the index knows what exists everywhere, but blob content is only read for what the user is actually viewing.

### Phase 2: Scalar as .NET wrapper (2019-2021)

**Problem:** Needed VFS for Git's performance benefits without the virtual filesystem.

**Solution:** Scalar configured git's native features to achieve similar performance:

- **Sparse checkout (cone mode):** Only populate the working directory with files in specified directories. The team contributed "cone mode" to git itself, which matches directories instead of individual file patterns — reducing sparse-checkout evaluation from 40 minutes to seconds on the Windows repo.
- **Partial clone:** Clone the repo without downloading all blob objects. Blobs are fetched on demand when accessed. This turns a multi-hour clone into a minutes-long metadata download.
- **Background maintenance:** Hourly background fetches, automatic commit-graph and multi-pack-index maintenance, filesystem monitor integration. The repo stays optimized without developer intervention.
- **Filesystem monitor:** On macOS/Windows, a daemon watches for file changes so `git status` doesn't need to scan the entire working directory. Reduces `git status` from minutes to milliseconds.

**Lesson for Scratch:** Several of these translate directly:

- **Background maintenance** = the `git gc --auto` / cron strategy from this doc. Scalar proves that automated, scheduled maintenance is the right pattern.
- **Multi-pack-index** = an index layer over packfiles for fast object lookups, analogous to the SQLite index strategy. Both solve the same problem: avoid scanning everything to find what you need.
- **Commit-graph** = a precomputed file that accelerates `findMergeBase` and other commit-graph traversals. If `findMergeBase` becomes slow with deep history, `git commit-graph write` is a one-line fix.
- **Sparse checkout** = conceptually similar to the "only load the subtree the user is viewing" principle. The UI should never trigger a full 100k-file tree walk just because the user opened a folder with 50 files.

### Phase 3: Scalar in core git (2022+)

Scalar was rewritten from >10,000 lines of .NET code to <3,000 lines of C and merged into git itself (v2.38+). It's now just a thin CLI that sets optimal git config values and registers repos for background maintenance.

The key git features Scalar enables are all available in standard git today:

| Feature                | Git config                                                 | What it does                                |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Commit-graph           | `core.commitGraph=true`, `fetch.writeCommitGraph=true`     | Precomputed graph for fast ancestry queries |
| Multi-pack-index       | `core.multiPackIndex=true`                                 | Index across multiple packfiles             |
| Filesystem monitor     | `core.fsmonitor=true`                                      | Watch for changes instead of scanning       |
| Sparse checkout        | `core.sparseCheckout=true`, `core.sparseCheckoutCone=true` | Only populate needed directories            |
| Background maintenance | `maintenance.auto=true`                                    | Scheduled gc, prefetch, pack                |
| Incremental repack     | `maintenance.strategy=incremental`                         | Repack without rewriting everything         |

**Lesson for Scratch:** You don't need Scalar itself (it's designed for repos with working directories), but you can enable the same git config settings on your bare repos. In particular:

```ini
# In each repo's .git/config:
[core]
    commitGraph = true
    multiPackIndex = true

[gc]
    auto = 1000
    writeCommitGraph = true
```

The commit-graph and multi-pack-index are the most relevant — they accelerate exactly the operations that matter for Scratch (`findMergeBase` via commit-graph, object lookups via multi-pack-index).

### Key takeaway

Microsoft's entire journey was about avoiding work that doesn't need to happen: don't download blobs you won't read (partial clone), don't populate files you won't open (sparse checkout), don't scan files that haven't changed (fsmonitor), don't recompute graphs you've already computed (commit-graph). Every strategy in this doc follows the same principle — the SQLite index avoids tree walks, `git gc` avoids loose object overhead, history truncation avoids accumulating unreachable data.

### References

- [The Story of Scalar — GitHub Blog](https://github.blog/2022-10-13-the-story-of-scalar/)
- [Introducing Scalar — Azure DevOps Blog](https://devblogs.microsoft.com/devops/introducing-scalar/)
- [Scalar Philosophy — microsoft/git](https://github.com/microsoft/git/blob/vfs-2.37.3/contrib/scalar/docs/philosophy.md)
- [microsoft/scalar — GitHub](https://github.com/microsoft/scalar)
