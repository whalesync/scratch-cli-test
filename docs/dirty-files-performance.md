# Dirty Files Performance

## Problem

The app becomes sluggish when a workbook has a large number of dirty files (e.g. 50,000 record edits on the dirty branch). The root cause is the way dirty file status is computed and delivered to the client.

## Current Architecture

```
Client (React)
  useDirtyFiles() hook ─── SWR ──→ GET /scratch-git/:id/git-status
  NavTabs polling (10s) ──────────→ GET /scratch-git/:id/git-status
                                          │
Server (NestJS)                           │
  ScratchGitController ──── HTTP ──→ GET /api/repo/diff/:id/status
                                          │
scratch-git service (Express)             │
  RepoDiffService.getDirtyStatus()        │
    ├── getTreeFiles('main')  ← full tree walk
    ├── getTreeFiles('dirty') ← full tree walk
    └── compare maps → DirtyFile[]
```

### Key files

| Layer       | File                                                                | What it does                                                             |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Client      | `client/src/hooks/use-dirty-files.ts`                               | SWR hook, fetches full list                                              |
| Client      | `client/src/app/workbook/[id]/components/Sidebar/NavTabs.tsx:36-50` | Polls every 10s for badge count, fetches full list just to get `.length` |
| Server      | `server/src/scratch-git/scratch-git.controller.ts`                  | Proxies to scratch-git service                                           |
| Git service | `scratch-git/src/services/repo-diff.service.ts`                     | Resolves main/dirty refs, calls `compareCommits`                         |
| Git service | `scratch-git/src/services/base-repo.service.ts:42-57`               | `compareCommits` — walks both trees, compares maps                       |
| Git service | `scratch-git/src/services/base-repo.service.ts:59-74`               | `getTreeFiles` — `isomorphic-git` `git.walk()` over entire commit tree   |

### What happens on each request

1. `getTreeFiles(mainOid)` — walks **every file** in the main branch tree → `Map<path, oid>`
2. `getTreeFiles(dirtyOid)` — walks **every file** in the dirty branch tree → `Map<path, oid>`
3. Compares the two maps → `DirtyFile[]`
4. Full array is serialized to JSON and sent back through the entire HTTP chain
5. Client receives and stores the full list

With 50k dirty files (and potentially many more unchanged files in the tree), this is expensive on every call.

### Why it compounds

- **NavTabs** (`NavTabs.tsx:48`) polls every 10 seconds via `setInterval`, calling the same endpoint — but it only needs the **count**, not the full list.
- **NavTabs bypasses SWR** — it calls `workbookApi.getStatus()` directly and stores the count in local state, so its requests aren't deduplicated with the `useDirtyFiles` hook.
- **No caching** in the scratch-git service — every request recomputes from scratch.
- **No pagination** — all 50k `DirtyFile` objects returned at once.

## Proposed Improvements

### 1. Add a count-only endpoint

**Impact: High | Effort: Low**

Add `GET /api/repo/diff/:id/status/count` that returns `{ count: number }` instead of the full list. The tree walk is still needed, but we skip serializing/transferring 50k objects. NavTabs should use this endpoint instead of fetching the full list.

Alternatively, the count could be derived more cheaply by walking both trees and just counting mismatches without building the full `DirtyFile[]` array.

### 2. Cache the diff result in scratch-git

**Impact: High | Effort: Medium**

Cache the `compareCommits` result keyed by `(mainOid, dirtyOid)`. Since the OIDs are content-addressed, the cache is automatically invalidated when either branch changes — a new commit produces a new OID, so the old cache key simply won't match.

This means repeated polls return instantly from cache. The only cost is the first request after a branch changes.

### 3. Fix NavTabs to use the SWR hook

**Impact: Medium | Effort: Low**

NavTabs currently bypasses the `useDirtyFiles` SWR hook and makes its own separate API calls. It should use the shared hook (or at minimum use SWR's `refreshInterval` option) so requests are deduplicated with other consumers.

```ts
// Current: separate fetch + setInterval (duplicates requests)
const [dirtyCount, setDirtyCount] = useState<number>(0);
const fetchDirtyCount = useCallback(async () => { ... }, [workbookId]);
useEffect(() => {
  fetchDirtyCount();
  const interval = setInterval(fetchDirtyCount, 10000);
  return () => clearInterval(interval);
}, [fetchDirtyCount]);

// Better: use the shared SWR hook
const { dirtyFiles } = useDirtyFiles(workbookId);
const dirtyCount = dirtyFiles.length;
```

### 4. Reduce polling frequency / use WebSocket push

**Impact: Medium | Effort: Medium**

The infrastructure for WebSocket-based invalidation already exists — `workbook-websocket-store.ts` already listens for `changes-discarded` events and invalidates the SWR cache. This pattern could be extended to push dirty count updates when writes happen to the dirty branch, eliminating the need for polling entirely.

If polling is kept, increase the interval (e.g. 30s or 60s) or use exponential backoff when the count hasn't changed.

### 5. Paginate the full file list

**Impact: Medium | Effort: Medium**

The full dirty file list is only needed when the user opens the Review & Publish view. Even then, loading 50k items at once is unnecessary — paginate or virtualize:

- Server returns a page of results (e.g. 100-500 at a time)
- Client uses virtualized list rendering for the file tree

### 6. Optimize the tree walk itself

**Impact: Variable | Effort: High**

The `isomorphic-git` `git.walk()` visits every node in both trees. Possible optimizations:

- **Tree-level short-circuit**: If a tree object's OID is the same in both commits, skip walking into it entirely. `isomorphic-git` supports walking two trees simultaneously which enables this — the current code walks them separately.
- **Use native git**: Shell out to `git diff --name-status` which is highly optimized in C, rather than walking trees in JavaScript. This is a bigger architectural change since scratch-git currently uses bare repos with isomorphic-git exclusively.
