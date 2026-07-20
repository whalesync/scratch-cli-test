# DEV-10885 — Clean up orphaned FileIndex / FileReference rows on connection delete + reset (and GC the ~93.5k already on prod)

- **Date:** 2026-07-19
- **Status:** In Progress (Phase A)
- **Author:** Curtis Fonger
- **Linear:** [DEV-10885](https://linear.app/whalesync/issue/DEV-10885/connection-deletereset-orphans-fileindex-filereference-rows-no-cleanup)
- **Spawned from:** [DEV-10880](https://linear.app/whalesync/issue/DEV-10880) (pseudo-ref canonicalization — the `FileIndex.connectorAccountId` discriminator it added is what makes the scoped cleanup here possible)

## Problem

`FileIndex` and `FileReference` have **no foreign key** to `Workbook` / `ConnectorAccount` / `DataFolder`, so nothing cascades. Two connection-lifecycle paths bulk-delete DataFolders but never touch these index tables, orphaning every one of the connection's index rows against the still-living `workbookId`:

- `ConnectorAccountService.removeConnectionData` (`server/src/remote-service/connector-account/connector-account.service.ts:520`) — cleans schedules, publishPlans, `UploadPatchMeta`, `RecreatedIdMap`, then `dataFolder.deleteMany` — but **not** `FileIndex` / `FileReference`.
- `ConnectorAccountService.resetConnection` (`:587`) — same `dataFolder.deleteMany`, same omission (and also re-inits the git repo, so the next pull runs against stale index rows).

`WorkbookService.delete` is fine — it calls `fileIndexService.deleteForWorkbook` / `fileReferenceService.deleteForWorkbook` wholesale. Only the *connection-level* paths bypass cleanup.

A secondary leak: `DataFolderService.delete`'s per-folder cleanup uses an **exact** `folderPath` match (`fileIndexService.removeAll`), so records stored under a `folderPath` *deeper* than the DataFolder's path survive even a normal single-folder delete (see the Shopify GID case below).

### Impact

- **Correctness (the real driver):** `FileIndex`'s unique key is `(workbookId, folderPath, recordId)`. Re-creating a folder at the same path (reconnect the same service, or `resetConnection`) with a colliding `recordId` **upserts the orphaned row instead of inserting**, resurrecting stale state. Same class of risk for `FileReference` link resolution.
- **Bloat:** both tables grow unbounded across connection churn.
- **Noise:** pollutes any `folderPath → connection` reasoning (it made the DEV-10880 backfill a near no-op).

### Evidence (measured read-only on prod during DEV-10880)

`FileIndex`: 2,112,265 total; **94,432 unscoped** (`connectorAccountId IS NULL`) across 28 workbooks; **~93,556 (99.1%) are orphans** (their `folderPath` has no live DataFolder). All the existing orphans are `connectorAccountId IS NULL` — so the forward, `connectorAccountId`-scoped fix does **nothing** for them; they need a detection-based GC.

## Design decisions

The ticket bundles three fixes. They async differently, and two of them share one subtle algorithm.

### Decision 1 — Delete = async durable job; Reset = inline. (Settled)

The crux is the **collision window** (the correctness hazard above).

- **Delete → enqueue a durable BullMQ job.** The connection is gone; re-colliding requires a deliberate reconnect + re-pull minutes+ later, so a few-seconds window is a non-issue. The user's delete request must not hard-block on an unbounded `deleteMany` (one workbook had 41,848 rows; `connectorAccountId` isn't indexed, so it's a workbook-scan + filter + bulk delete). A durable job (persisted `DbJob`, retried, survives restart) guarantees the cleanup eventually runs.
- **Reset → clean inline.** Reset is the collision-*critical* path: same `connectorAccountId`, same paths, and the user's next move is to re-pull into them. Reset is already heavyweight (wipes DataFolders, re-inits git) and not latency-sensitive, so a scoped delete there is proportionate and closes the race for free. Async-ing reset would reintroduce the exact bug we're fixing.

### Decision 2 — FileReference does **not** get a `connectorAccountId` column. (Settled)

DEV-10880 added the column to FileIndex to fix a **read-time** ambiguity (`(workbookId, folderPath, filename) → recordId` is ambiguous when two connections share a folder name; the column disambiguates via `pickPreferredRecordId`). FileReference has **no analogous ambiguous read** — `findRefsToFiles` keys on the *target*, `updateRefsForFiles` keys on `sourceFilePath`. A column would be pure cleanup sugar, and cleanup already works: `deleteForFolder` prefix-deletes on `sourceFilePath` (`startsWith`), so FileReference has **no nested-path gap** and needs no migration/backfill. Cross-connection correctness also confirms "source, not target" is the only sensible key, which `sourceFilePath`-prefix already is. Revisit only if FileReference cleanup becomes a measured perf pain or a read path needs source-connection discrimination (neither today).

### Decision 3 — GC the existing ~93.5k via a one-time **code-migration**, not a recurring cron. (Reversed from earlier lean — see note)

> **Note / reversal:** In the initial chat I leaned toward a recurring cron "orphan sweep" (it doubles as a permanent backstop and matches the "background process" instinct). After grounding the orphan definition, I'm reversing to a **one-shot, dry-runnable code-migration**, because:
> 1. The delete is **heuristic** ("row whose `folderPath` has no live DataFolder owner") and would be the **first destructive (`deleteMany`) code-migration** in the repo — every existing one is a non-destructive update. A heuristic destructive sweep running **unattended forever** is the wrong risk posture; a one-shot lets us dry-run the whole fleet, eyeball counts, canary one workbook, and verify in the DB (exactly the `runbook-running-prod-code-migrations.md` envelope).
> 2. The forward fix (Decision 1, scoped by `connectorAccountId`) is **deterministic** and stops all *new* orphans, so there's no steady-state need for a recurring sweep. Its only marginal value would be catching a crashed delete-job — and BullMQ already retries.
>
> The migration is idempotent and re-runnable, so if we want a periodic "run it again" later, we can — without an always-on unattended deleter. **Mitigant that bounds the whole risk:** FileIndex/FileReference are *derived caches*, rebuildable by a re-pull — so even a mistaken delete is recoverable (worst case: re-resolve / re-pull), it is never user data.

### Decision 4 — New dedicated JobType for the delete-time cleanup. (Settled)

Cleaner, retriable, visible in job tooling vs. folding into the delete flow. Name: `CleanupConnectionIndexRows`.

## The one algorithm that matters: **longest-prefix DataFolder ownership**

A blind subtree-prefix delete (`folderPath startsWith "<deletedPath>/"`) is **NOT safe**, and this is the subtlety that shapes fixes #2 and #3:

- **Live child DataFolders nest inside a parent's path.** Webflow secondary-locale collections are *separate, independent* `DataFolder` rows at `/<Site>/Collections/<Collection>/<Locale>` — strictly inside the primary collection's `/<Site>/Collections/<Collection>`. There is **no DataFolder→DataFolder FK**, so deleting the primary leaves the locale folder fully alive. A prefix delete on the primary's path would wipe the live locale folder's index rows.
- **But some deeper `folderPath`s are genuine artifacts, not folders.** Shopify Product Variants with slash-bearing GID ids (`gid://shopify/ProductVariant/123`) and no usable slug produce `FileIndex.folderPath = "Product Variants/gid://shopify/ProductVariant"` under a DataFolder at `/Product Variants`. No DataFolder lives there; its true owner is `/Product Variants`. Exact-match `removeAll("Product Variants")` misses these — the fix #2 gap.

**Owner rule:** a FileIndex row belongs to the live DataFolder whose path is the **longest prefix** of the row's `folderPath` (where "prefix" means `folderPath === P` or `folderPath.startsWith(P + "/")`, on the no-leading-slash forms). Then:

- **Fix #2 (single-folder delete):** after the DataFolder is gone, delete rows under its subtree **for which the just-deleted folder was the longest-prefix owner** — i.e. no *other* live DataFolder claims them more specifically. → sweeps the Shopify GID artifacts, preserves the live Webflow locale rows.
- **Fix #3 (GC):** delete rows for which **no** live DataFolder is a prefix-owner at all. → preserves Shopify artifacts (owner `/Product Variants` still lives) and Webflow locale rows (they own themselves), deletes only rows from folders that no longer exist.

Fix #1 (whole-connection delete/reset) does **not** need this: it removes the entire connection, so FileIndex `deleteMany({workbookId, connectorAccountId})` + FileReference prefix-delete over *all* the connection's folder paths is complete and can't over-delete anything live.

**Efficient implementation:** operate on the *distinct* `folderPath` set (few per workbook), not per row — compute the orphan folderPath set in JS against the live DataFolder paths, then `deleteMany({ workbookId, folderPath: { in: <orphanFolderPaths, batched> } })`. Mirror for FileReference via `sourceFilePath` folder prefix.

## Phase A — implemented (2026-07-19)

Tasks 1–4 are done; `yarn build`, root/`server` `lint-strict`, and the touched unit suites are green. Two correctness refinements surfaced while building and are baked in:

1. **Single-folder delete is now `connectorAccountId`-scoped** (not just prefix-aware). Because folder paths carry no connection prefix, an exact-path delete could nuke a *sibling connection's* same-named folder rows; scoping by the folder's `connectorAccountId` closes that (legacy `NULL` rows are left for Phase B's GC, consistent with the whole-connection path). Combined with the longest-prefix-owner guard, this preserves live nested children (Webflow locales) while sweeping GID artifacts.
2. **Reset must be inline, not async** — a stronger reason than latency: reset keeps the *same* `connectorAccountId`, so an async cleanup racing the user's re-pull could delete the *freshly pulled* rows. Delete stays async only because the account id is dead afterward, so nothing can re-pull into it.
3. **Async delete's FileReference cleanup is guarded at run time (two review findings).** The FileIndex delete is race-free (dead `connectorAccountId`), but FileReference is keyed by folder path with no connection prefix — so deleting connection A, then reconnecting the same service (which reuses A's freed folder paths) and re-pulling *before the job drains* (worker backlog / stalled-job redelivery — window not seconds-bounded) would wipe the new connection's fresh refs. Fix: the handler re-queries live `DataFolder`s at run time and handles **both reclaim shapes**, mirroring the single-folder path: (a) *ancestor-or-self* — skip any path a live folder owns at-or-above it (`folderPathOwns`); (b) *descendant* — when a live folder was recreated strictly under a deleted path but its parent wasn't (e.g. a Webflow locale child without its parent collection), exclude that subtree via `deleteForFolderExcludingLiveChildren`. Impact absent the fix was a derived-cache gap (pseudo-ref/reverse-dep lookups until next pull), not data loss — but it reintroduced the race the inline reset path avoids. Covered by three handler unit tests (abandoned sweep, ancestor-or-self skip, descendant exclude).

Also added: a dedicated `CleanupConnectionIndexRows` BullMQ JobType with its own custom metrics (completed/failed/canceled/stalled), wired through the enqueuer, dispatch switch, migration-lock job→account mapping, and metrics maps. Unit coverage: `folderPathOwns` / `isDeeperFolderPathOrphanedByDelete` (Shopify-GID vs Webflow-locale cases), `deleteForConnection`, `deleteRowsOwnedByDeletedFolder`, and the delete-time enqueue assertion.

Files touched: `file-index.service.ts`, `file-reference.service.ts`, `data-folder.service.ts`, `connector-account.service.ts` + `.module.ts`, `job-types.ts`, `union-types.ts`, `bull-enqueuer.service.ts`, `job-handler.service.ts`, `migration-lock.service.ts`, `custom-metrics.ts`, new `cleanup-connection-index-rows.job.ts`, + specs.

## Implementation plan

Phase A (Tasks 1–4) stops the bleeding and is shippable on its own. Phase B (Task 5) is the ops GC of existing rows and can land as a follow-up MR.

### Task 1 — Shared connection-scoped cleanup helper
- `FileIndexService.deleteForConnection(workbookId, connectorAccountId)` → `deleteMany({ workbookId, connectorAccountId })` (covers nested sub-paths for free; `file-index.service.ts`).
- Add a small private helper on `ConnectorAccountService`, e.g. `deleteConnectionIndexAndReferenceRows(workbookId, connectorAccountId, connectionFolderPaths)`:
  - `fileIndexService.deleteForConnection(workbookId, connectorAccountId)`
  - for each of `connectionFolderPaths`: `fileReferenceService.deleteForFolder(workbookId, pathNoSlash)` (already `startsWith`-based; catches nested + GID artifacts).
- Reused by Task 2 (reset, inline) and Task 3 (delete job).

### Task 2 — Reset: clean inline
In `resetConnection` (`connector-account.service.ts:587`): fetch the connection's DataFolder paths **before** `dataFolder.deleteMany` (it currently doesn't), then call the Task 1 helper inline. Order relative to the DataFolder/publishPlan deletes doesn't matter (no FK), keep it in the same method.

### Task 3 — Delete: enqueue durable cleanup job
New JobType `CleanupConnectionIndexRows` end-to-end (files, per the wiring map):
1. `packages/shared-types/src/job-types.ts` — add `CleanupConnectionIndexRows: 'cleanup-connection-index-rows'` to the `JobType` const.
2. `server/src/worker/jobs/job-definitions/cleanup-connection-index-rows.job.ts` — new def type (payload `{ workbookId, connectorAccountId, connectionFolderPaths: string[] }`) + handler calling the Task 1 helper (handler can call `FileIndexService` / `FileReferenceService` directly).
3. `server/src/worker/jobs/union-types.ts` — add def to the `JobDefinition` union.
4. `server/src/worker-enqueuer/bull-enqueuer.service.ts` — `enqueueCleanupConnectionIndexRowsJob(...)` (mirror `enqueueDeleteWorkbookJob`).
5. `server/src/worker/job-handler.service.ts` — `case JobType.CleanupConnectionIndexRows:` in `getHandler` (inject `FileIndexService`/`FileReferenceService` into `JobHandlerService` if not already available; ensure their module is imported by `workers.module.ts`).
6. Callsite: in `removeConnectionData`, capture `dataFolders` paths (already fetched at `:524`) and, after `connectorAccount.delete`, enqueue the job. **Best-effort:** wrap in try/catch + `WSLogger.error`; the connection is already deleted, so a failed enqueue must not throw back to the user. Inject `BullEnqueuerService` into `ConnectorAccountService` (mirror `WorkbookService`'s enqueue callsite) and make sure the module imports `WorkerEnqueuerModule`.
7. Tracking (decided during review): **dedicated CustomMetrics only** (completed/failed/canceled/stalled) — no separate audit-log/PostHog event for the enqueue. The user-facing action (connection delete) is already audit-logged in `remove()`; this job is an internal derived-cache housekeeping consequence, not a distinct user activity, so the CLAUDE.md "track async jobs on a core entity" guidance (which targets user-initiated workflows like pulls) is satisfied by operational metrics. Revisit if we ever want per-cleanup audit visibility.

> Note: `createAndEnqueue` skips enqueue for workbooks pending delete — not a problem here (the *workbook* still lives; only a connection is removed). If the workbook is also being deleted, `WorkbookService.delete`'s wholesale cleanup covers it.

### Task 4 — Fix the nested-path exact-match gap in single-folder delete
- Add `FileIndexService.deleteOrphanedRowsUnderFolder(workbookId, deletedFolderPathNoSlash, liveDataFolderPathsNoSlash)` implementing the **longest-prefix owner** rule over distinct folderPaths (delete rows the deleted folder owned; keep rows a live child folder owns).
- In `DataFolderService.delete` (`data-folder.service.ts:762`), replace the exact-match `fileIndexService.removeAll(...)` with the new owner-aware delete (load the workbook's *other* live DataFolder paths). Keep `FileReferenceService.deleteForFolder` in sync using the same owner set (its `startsWith` already handles the artifact depth; the guard is to not delete a live child locale's refs).

### Task 5 — One-time GC code-migration (Phase B)
New migration `fileindex-filereference-orphan-gc` mirroring `fileindex-connector-account-backfill` (workbook-scoped, `ids`=workbooks / `qty`=N-workbooks, `supportsDryRun: true`):
1. Registry entry in `AVAILABLE_MIGRATIONS` + dispatch `case` (`code-migrations.controller.ts`).
2. Pure core file `code-migrations/fileindex-filereference-orphan-gc.ts` + `__tests__/` spec: for a workbook, load live DataFolder paths, compute orphan folderPaths (no prefix-owner) over distinct FileIndex folderPaths, and (when not dryRun) `deleteMany` FileIndex by `folderPath IN` batches + matching FileReference by `sourceFilePath` prefix. Return counts (`wouldDelete` / `deleted`, per table).
3. Because it's the first destructive migration: dry-run the fleet, canary one workbook, log the deleted counts per workbook, verify against the DB before/after. (Bounded risk: derived cache → re-pull rebuilds.)

## Testing

- **Integration:** connection **delete** leaves zero `FileIndex`/`FileReference` rows for that connection (after the enqueued job runs); connection **reset** leaves zero, inline; a **Webflow-locale-shaped** setup (parent + nested child DataFolder) — deleting the parent single folder removes the parent's own + GID-artifact rows but **preserves** the child's rows (Task 4); the **GC** deletes only orphans and preserves live rows (incl. Shopify GID artifacts + Webflow locale rows).
- **Unit:** the longest-prefix-owner helper (Shopify GID artifact → orphan of its `/Product Variants` owner; Webflow locale → owned/preserved; exact match; sibling `Foo` vs `Foo Extra` non-prefix).
- Run `yarn build`, root `yarn lint`, **`yarn lint-strict` in `server/`**, and `yarn test:integration`. No CLI-suite impact expected (no publish/pull/sync round-trip shape change), but re-check if the job handler touches shared services.

## Files (quick index)

- `server/src/remote-service/connector-account/connector-account.service.ts` — `removeConnectionData` (:520), `resetConnection` (:587)
- `server/src/publish-plan/file-index.service.ts`, `file-reference.service.ts`
- `server/src/workbook/data-folder.service.ts` (:762 cleanup block)
- `packages/shared-types/src/job-types.ts`; `server/src/worker/jobs/{union-types.ts,job-definitions/*}`; `server/src/worker-enqueuer/bull-enqueuer.service.ts`; `server/src/worker/job-handler.service.ts`
- `server/src/code-migrations/*` + `docs/ops/runbook-running-prod-code-migrations.md`

## Resolved decisions (2026-07-19)

1. **Two separate MRs.** Phase A (forward fix, Tasks 1–4) lands + deploys first to stop the bleeding; Phase B (Task 5 — GC + first destructive migration) is a separate, more carefully-reviewed MR.
2. **No deleted-row snapshot in the GC migration.** "A re-pull rebuilds the derived cache" is sufficient recoverability — the migration logs counts + a small sample only, not the full deleted `(folderPath, recordId)` set.
