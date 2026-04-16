# Repo-Level Locking Plan

## Problem

The existing `DataFolder.lock` field prevents concurrent operations on a single folder, but a
connection (ConnectorAccount) maps to a single git repo shared by all its folders. Two jobs on
different folders of the same connection can run simultaneously and write to the same git repo
concurrently, causing data races.

## Solution

Add a repo-level lock to `ConnectorAccount`. Any job that writes to a connection's git repo must
hold this lock for its duration.

---

## Schema Change

Add to `ConnectorAccount` in `prisma/schema.prisma`:

```prisma
repoLockAt     DateTime? // When the lock was last acquired or renewed
repoLockReason String?   // Human-readable reason: 'pull', 'publish', 'publish-from-git', etc.
```

The timestamp doubles as both an acquisition time and a heartbeat — long-running jobs renew it
periodically. A lock whose `repoLockAt` is older than `REPO_LOCK_MAX_AGE` is considered expired
and may be stolen by the next operation.

---

## Utility: `RepoLockService`

Create `server/src/scratch-git/repo-lock.service.ts`.

### Constants

```ts
const REPO_LOCK_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes
```

### `isLocked(repoLockAt: Date | null): boolean`

```ts
function isLocked(repoLockAt: Date | null): boolean {
  if (!repoLockAt) return false;
  return Date.now() - repoLockAt.getTime() < REPO_LOCK_MAX_AGE_MS;
}
```

### `acquire(connectorAccountId, reason): Promise<void>`

Uses a single conditional `updateMany` to atomically check-and-set, avoiding the TOCTOU race of
read-then-write:

```ts
async acquire(connectorAccountId: string, reason: string): Promise<void> {
  const expiry = new Date(Date.now() - REPO_LOCK_MAX_AGE_MS);
  const result = await prisma.connectorAccount.updateMany({
    where: {
      id: connectorAccountId,
      OR: [
        { repoLockAt: null },
        { repoLockAt: { lt: expiry } },   // expired lock — safe to steal
      ],
    },
    data: { repoLockAt: new Date(), repoLockReason: reason },
  });

  if (result.count === 0) {
    // Read current state for a user-friendly error
    const current = await prisma.connectorAccount.findUnique({
      where: { id: connectorAccountId },
      select: { repoLockReason: true, repoLockAt: true },
    });
    throw new ConflictException(
      `Connection is currently locked by a ${current?.repoLockReason ?? 'running'} operation. Try again shortly.`,
    );
  }
}
```

### `renew(connectorAccountId): Promise<void>`

Called from job checkpoints to keep the lock alive for long-running jobs:

```ts
async renew(connectorAccountId: string): Promise<void> {
  await prisma.connectorAccount.updateMany({
    where: { id: connectorAccountId, repoLockAt: { not: null } },
    data: { repoLockAt: new Date() },
  });
}
```

### `release(connectorAccountId): Promise<void>`

```ts
async release(connectorAccountId: string): Promise<void> {
  await prisma.connectorAccount.updateMany({
    where: { id: connectorAccountId },
    data: { repoLockAt: null, repoLockReason: null },
  });
}
```

### `releaseForDataFolder(dataFolderId): Promise<void>`

Convenience for job handlers that only have `dataFolderId`:

```ts
async releaseForDataFolder(dataFolderId: string): Promise<void> {
  const folder = await prisma.dataFolder.findUnique({
    where: { id: dataFolderId },
    select: { connectorAccountId: true },
  });
  if (folder?.connectorAccountId) {
    await this.release(folder.connectorAccountId);
  }
}
```

---

## Where to Acquire

Lock is acquired **before** enqueueing the BullMQ job, in the same place the existing
`DataFolder.lock` is set. The caller that detects a conflict gets an immediate HTTP 409 rather than
queueing work that will fail later.

| Callsite | File | Reason |
|---|---|---|
| `POST :id/publish` | `data-folder.controller.ts` | Publish a single folder |
| `POST :id/pull-files` | `data-folder.controller.ts` | Pull individual files |
| `pullAllFolders` / bulk pull | `workbook.service.ts` | Pull all folders in a workbook |
| `POST /linked/download` | `cli-linked.controller.ts` | CLI-triggered pull |
| `enqueuePublishFromGitJob` callers | `publish-plan.controller.ts` and others | CLI publish-from-git |

For jobs that span multiple connections (`PublishDataFolderJob` with folders from different
connections), acquire all connection locks upfront before enqueueing any of the BullMQ jobs. If any
lock is held, reject the whole request without acquiring any locks (to avoid partial locking).

Sync jobs (`SyncDataFoldersJob`) touch many source and destination connections. Locking all of them
upfront is complex and likely too restrictive. Skip repo-level locking for sync jobs for now — the
sync service already processes table pairs sequentially and is lower risk.

---

## Where to Renew

Long-running jobs must renew the lock on every checkpoint to prevent it from expiring mid-run.
The `checkpoint` callback is already called after each batch in pull jobs and after each table in
sync jobs.

Add a `repoLock.renew(connectorAccountId)` call inside the `checkpoint` wrapper (or inline in the
`onBatch` callback) in:

- `PullLinkedFolderFilesJobHandler` — renew on each batch commit
- `PullLinkedFolderFilesV2JobHandler` — same
- `PullFilesJobHandler` — renew on checkpoint
- `PublishDataFolderJobHandler` — renew on checkpoint per folder
- `PublishFromGitJobHandler` — renew on progress callback

The `REPO_LOCK_MAX_AGE` of 15 minutes gives comfortable headroom: a job that checkpoints every
~30 seconds only needs to renew 1 in 30 checkpoints to stay live, but renewing every checkpoint is
fine and simpler.

---

## Where to Release

Release in every job handler in **both** the success and error paths — mirror exactly where
`DataFolder.lock = null` is already cleared:

| Handler | Current `lock = null` location | Add `repoLock.release` |
|---|---|---|
| `PullLinkedFolderFilesJobHandler` | `finalizeFolder()` + error catch | Same locations |
| `PullLinkedFolderFilesV2JobHandler` | `finally` block | Same `finally` |
| `PullFilesJobHandler` | success + error paths | Same |
| `PublishDataFolderJobHandler` | success + error per folder | Same |
| `PublishFromGitJobHandler` | success + error | Same |

For `PublishDataFolderJob` which can span multiple folders from different connections: release each
connection's lock after that folder finishes (rather than holding all locks until the entire job
completes). This minimises the lock window.

---

## Stale Lock Cleanup

`StaleJobReaperService` runs every 5 minutes and already clears `DataFolder.lock` for stuck jobs.
Extend it to also clear the repo-level lock:

```ts
// After clearing DataFolder.lock:
if (dbJob.dataFolderId) {
  await repoLockService.releaseForDataFolder(dbJob.dataFolderId);
}
```

The `REPO_LOCK_MAX_AGE` TTL is a second backstop: even if the reaper misses a crashed job, the
lock expires on its own after 15 minutes.

---

## Interaction with the Existing `DataFolder.lock`

Keep `DataFolder.lock` as-is — it serves a different purpose (per-folder UI state, shown in the
frontend as "folder is being pulled"). The new repo-level lock is purely a backend concurrency
guard and is invisible to the UI.

Both locks are acquired before enqueueing, both are cleared by the job. The repo-level lock is the
stronger gate: if it is held, the request is rejected before the folder lock is even checked.

---

## Implementation Order

1. **Schema + migration** — add `repoLockAt` / `repoLockReason` to `ConnectorAccount`
2. **`RepoLockService`** — `acquire`, `renew`, `release`, `releaseForDataFolder`, `isLocked`
3. **Controllers** — add `acquire` before enqueue in the 5 callsites above
4. **Job handlers** — add `renew` on checkpoint and `release` on completion/error
5. **Stale job reaper** — add `releaseForDataFolder` alongside existing folder lock clear
6. **Tests** — unit tests for `isLocked` edge cases (null, fresh, expired); integration test for
   the 409 conflict response

---

## What This Does Not Cover

- **Sync jobs**: skipped intentionally (many-to-many connections, low risk of repo corruption)
- **git-receive-pack locking**: already handled in `scratch-git-2` via the Tokio `WriteLockManager`
  — the DB lock operates at a higher level (prevents job dispatch) while the Rust lock prevents
  concurrent git writes within a single service instance
- **Cross-instance atomicity**: the `updateMany` conditional write is atomic within Postgres, so
  this works correctly even with multiple NestJS server instances behind a load balancer
