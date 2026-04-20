# Job System

## Overview

Scratch uses a job system for long-running async operations like pulling data from external services, publishing content, and syncing folders. The system is built on **BullMQ** (Redis-backed queue) for job distribution and **PostgreSQL** (via Prisma) for durable state tracking.

The architecture is designed around **Cloud Run's ephemeral nature**: instances can shut down at any time without graceful termination, so the system assumes jobs can be interrupted and must be recoverable.

## How It Works

When a user pulls data from Airtable, publishes to Webflow, or syncs folders, that operation runs as a **job** — a background task that executes on a separate machine from the one serving the user's request.

Here's what happens end to end:

1. **User triggers an action** (click "Pull" in the UI, run a CLI command, or a scheduled sync fires).
2. **A job record is created** in the database and placed on a queue. The user sees the job appear immediately with a "pending" state.
3. **A worker picks up the job** from the queue and starts executing it. The worker runs on Cloud Run — a separate, ephemeral instance that can be shut down at any time.
4. **The worker checkpoints progress** as it goes — how many records pulled, which folders are done. These checkpoints stream back to the UI in real time, and they're saved to the database so the job can resume if the worker dies.
5. **The job finishes** (success, failure, or user cancellation) and the final status is recorded.
6. **Cleanup runs in the background** — a cron job reaps stuck jobs every 5 minutes, and another deletes old job records after 60 days.

The core design constraint is that **workers are ephemeral**. Cloud Run can kill a worker at any moment, so the system can't assume a job will run to completion on a single machine. Everything important — progress, pagination cursors, which folders are done — is checkpointed to the database so another worker can pick up where the last one left off.

## Architecture

```
┌──────────────┐      ┌─────────────────┐
│  Client /    │      │   Enqueuer      │
│  CLI / Cron  │─────▶│                 │
└──────────────┘      └──────┬──────────┘
                             │ writes to both
                  ┌──────────┼──────────┐
                  │                     │
         ┌────────▼────────┐   ┌────────▼────────┐
         │  PostgreSQL     │   │  BullMQ Queue   │
         │  (DbJob record) │   │  (Redis)        │
         └────────▲────────┘   └────────┬────────┘
                  │                     │ dispatches to
                  │            ┌────────▼────────┐
                  │            │  Worker         │
                  │            │  (Cloud Run)    │
                  ├────────────┤  runs handler   │
                  │  updates   │  checkpoints    │
                  │            └────────┬────────┘
                  │                     │
                  │            ┌────────▼────────┐
                  │            │  Redis Pub/Sub  │
                  └────────────│  (events +      │
                   reads for   │   cancellation) │
                   cancel check└─────────────────┘
```

There are two stores of truth for a job, and they serve different purposes:

- **BullMQ (Redis)**: Owns queue position, dispatch, lock management, and stall detection. This is the "hot" state that controls which worker is running what.
- **PostgreSQL (DbJob)**: Owns durable job history, progress, and user-facing status. This is the "cold" state that survives Redis flushes and worker restarts.

The enqueuer writes to both. The worker reads from BullMQ for dispatch and writes to Postgres for durability. There is no periodic reconciliation between the two stores. If they diverge, the system only notices at specific touchpoints: the stale job reaper catches `created` DbJobs with no BullMQ counterpart, and the cancellation flow checks BullMQ state before acting. A DbJob stuck in `active` after its BullMQ job is lost (e.g., Redis flush) is a known gap — nothing currently catches that automatically.

### Service Types

The same NestJS codebase runs as different microservice types controlled by `SERVICE_TYPE`:

- **WORKER**: Runs the BullMQ worker — processes jobs
- **CRON**: Runs maintenance cron jobs (stale reaper, old job cleanup)
- **FRONTEND**: Runs the REST API — serves client requests
- **MONOLITH**: Runs everything (local dev)

## Job Types

| Type                                             | Description                                     |
| ------------------------------------------------ | ----------------------------------------------- |
| Pull Linked Folder Files                         | Fetch records from an external service into git |
| Refresh Records                                  | Re-pull specific files                          |
| Publish / Publish Data Folder / Publish From Git | Push records to an external service             |
| Sync Data Folders                                | Copy data between folders with transforms       |
| Rehost Assets                                    | Download and re-host external assets            |
| Plan Pipeline / Run Pipeline                     | Pipeline execution                              |

## Job Lifecycle

### State Machine

```
                    ┌──────────┐
                    │ created  │  DbJob written to Postgres
                    └────┬─────┘
                         │
              ┌──────────┼──────────────────────┐
              │                                 │
              │  Worker picks up from BullMQ    │  Enqueue failed, or
              │                                 │  reaped by stale job reaper
         ┌────▼─────┐                      ┌────▼─────┐
         │  active  │  Worker processing,  │  failed  │
         │          │  checkpointing       │          │
         └────┬──▲──┘                      └──────────┘
              │  ╰── stall recovery: BullMQ re-dispatches
              │      to new worker, stays active ──╯
              │
   ┌──────────┼───────────┐
   │          │           │
┌──▼───────┐ ┌▼────────┐ ┌▼──────────┐
│completed │ │ failed  │ │ canceled  │
└──────────┘ └─────────┘ └───────────┘
```

- **created**: DbJob exists in Postgres, BullMQ job enqueued and waiting
- **active**: Worker has dequeued the job and is executing the handler. On stall recovery, BullMQ re-dispatches to a new worker — the DbJob stays `active` (it doesn't return to `created`).
- **completed**: Handler returned successfully
- **failed**: Handler threw an error, enqueue failed, or job was reaped by the stale job reaper
- **canceled**: User requested cancellation, handler threw `JobCanceledError`

### Creation and Enqueuing

Job creation is a two-step operation:

1. **Create DbJob** in Postgres with status `created`
2. **Enqueue to BullMQ** with a deterministic job ID (e.g., `pull-${workbookId}-${uniqueId}`)

If enqueuing fails after the DbJob is created, the DbJob is immediately marked as `failed` with the enqueue error. This prevents orphaned `created` records that never get picked up.

### Processing

When BullMQ dispatches a job to a worker:

1. **Look up DbJob** — find the DbJob by `bullJobId`. If none exists (edge case), create one as a fallback.
2. **Set status to `active`** — update status and `processedOn` timestamp.
3. **Resolve handler** — map the job type to a handler class.
4. **Execute handler** — pass `checkpoint`, `abortSignal`, and any prior `progress` (for resume after stall).
5. **Record outcome** — update DbJob to `completed`, `failed`, or `canceled`.

### How Job Handlers Are Written

Each job type is implemented as a single `run()` method. There is no built-in mechanism for breaking a job into steps or stages — the handler is one function that runs from start to finish.

When a job stalls (worker dies) and BullMQ re-dispatches it, `run()` is called again from the top with the last checkpointed `progress`. The handler is responsible for using that progress to skip work it already completed:

- **jobProgress** tracks high-level completion (e.g., `completedFolderIds` — which folders to skip)
- **connectorProgress** tracks API pagination state (e.g., a cursor token to resume fetching mid-page)

This means resume is **opt-in per handler and per connector**. The framework provides the checkpoint/restore plumbing, but each handler must be written to actually use it. All active connectors now persist their pagination cursor — see [Connector Resume Plan](/docs/plans/resolved/2026-04-14-connector-resume-plan.md) for details.

## Checkpointing and Progress

Checkpointing is the core mechanism for progress tracking, lock renewal, cancellation detection, and crash recovery. Job handlers call `checkpoint()` at regular intervals (typically once per batch of records).

### What Happens at Each Checkpoint

```
checkpoint(progress)
  │
  ├─ 1. Add timestamp to progress
  ├─ 2. Update BullMQ job progress          → Redis (refreshes lock)
  ├─ 3. Write progress to DbJob             → Postgres (crash-durable)
  │     └─ Atomically read cancelRequestedAt → Cancellation check
  ├─ 4. If cancelRequestedAt set → abort
  └─ 5. If abortSignal.aborted → throw JobCanceledError
```

### Progress Structure

Progress has three layers, each serving a different audience:

```typescript
type Progress = {
  publicProgress; // Sent to clients — folder name, file counts, paths
  jobProgress; // Internal resumability — which folders are done
  connectorProgress; // Connector pagination cursors — API tokens, offsets
  timestamp;
};
```

### Why Checkpointing Matters

1. **Lock renewal**: BullMQ's `lockDuration` (2 min default) is a heartbeat. Updating progress resets the lock timer. Without regular checkpoints, BullMQ assumes the worker is dead and marks the job as stalled.
2. **Crash recovery**: Progress persisted to Postgres survives worker death. When a stalled job is re-dispatched, the new worker picks up from the last checkpoint.
3. **Cancellation detection**: The DB `cancelRequestedAt` flag is polled at each checkpoint (slow path). This catches cancellations even if the Redis pub/sub message was missed.

## Cancellation

Cancellation is **immediate in Postgres** and **eventually consistent in BullMQ**. When a user clicks Cancel:

```
User clicks Cancel
  → DbJob.status = 'canceled' immediately (UI reflects it right away)
  → DbJob.cancelRequestedAt = now()
  → Publish to Redis channel 'job-cancel:{jobId}' (fast path to abort worker)
```

The worker is still running after the DB update. It stops via two complementary paths:

### Fast Path: Redis Pub/Sub

```
Worker receives pub/sub message
  → AbortController.abort()
  → Handler throws JobCanceledError
```

Latency: near-instant.

### Slow Path: Database Flag

For jobs where pub/sub might not reach (worker restarted, message lost):

```
At next checkpoint():
  → Worker reads cancelRequestedAt from Postgres
  → AbortController.abort()
  → Handler throws JobCanceledError
```

Latency: up to one checkpoint interval (typically seconds to a minute).

### Race Protection

The worker may finish before the abort signal fires. To prevent it from overwriting the `canceled` status, `updateJobStatus` uses a conditional update: it will not transition a job **out of** the `canceled` state. If the worker calls `updateJobStatus({ status: 'completed' })` after the user canceled, the update is a no-op.

### Cancellation Edge Cases

- **Job already terminal**: Returns the current status, no action taken
- **Job missing from BullMQ but DbJob exists**: Already marked `canceled` by the initial update
- **BullMQ says job is already completed/failed**: Overwrites the `canceled` status to match BullMQ's terminal state (BullMQ is authoritative for terminal states)

## DataFolder Locking

Jobs set a lock on DataFolders to prevent concurrent operations on the same folder:

```
DataFolder.lock: 'pull' | 'publish' | null
```

The lock lifecycle:

1. **Set** before or during enqueue
2. **Cleared** on completion, failure, or cancellation by the handler
3. **Emergency cleared** by the stale job reaper if the job is reaped
4. **Defensive backstop**: Pull V2 jobs include a `finally` block that clears locks on any folder not explicitly resolved

If a folder is locked, new operations on that folder are rejected.

## Cloud Run and Stall Recovery

### The Problem

Cloud Run instances are ephemeral. They can be shut down at any time without graceful termination. When a worker dies mid-job:

1. The BullMQ lock expires (after `lockDuration`, default 2 min)
2. BullMQ marks the job as **stalled**
3. BullMQ re-dispatches the job to another worker

### Stall Tolerance

`maxStalledCount` is set to **20** — a job tolerates up to 20 consecutive worker deaths before BullMQ gives up and fails it. This is deliberately high because Cloud Run shutdowns are routine, not exceptional. At 2 minutes per lock, that's ~40 minutes of worst-case tolerance.

After exceeding `maxStalledCount`, BullMQ moves the job to `failed`. The stale job reaper will then clean up the DbJob and release any locks.

### Resume After Stall

When BullMQ re-dispatches a stalled job to a new worker:

1. The worker finds the existing DbJob (status still `active`) and loads its persisted `progress`
2. The handler receives this progress and can skip already-completed work:
   - **jobProgress.completedFolderIds** — skip fully-processed folders
   - **connectorProgress** — resume API pagination from the last cursor

All active connectors support cursor-based resume. See [Connector Resume Plan](/docs/plans/resolved/2026-04-14-connector-resume-plan.md) for details.

### What Causes Stalls (and What Doesn't)

Stalls only occur when the **worker process dies** (Cloud Run shutdown, OOM kill, etc.). Long async I/O — like waiting 30 seconds for a Stripe API response — does **not** cause stalls, because it doesn't block the Node.js event loop, so BullMQ can still renew the lock internally.

## Stuck Job Recovery

### Stale Job Reaper (every 5 minutes)

Catches jobs stuck in `created` status — the DbJob was written to Postgres but the BullMQ job was lost or never picked up.

```
Every 5 minutes:
  Find DbJobs where status = 'created' and age > 5 minutes
  For each:
    If BullMQ job still exists and is active → skip
    Otherwise:
      Mark DbJob as failed ("Reaped: stuck in created status")
      Clear any DataFolder locks held by this job
```

This handles:

- BullMQ job lost from Redis (e.g., Redis restart)
- Worker crashed between enqueue and processing
- Race conditions in the create-and-enqueue flow

### Old Job Cleanup (daily at 3 AM)

Deletes terminal DbJob records older than **60 days**.

```
Daily at 3 AM:
  Find runs where all jobs are terminal and older than 60 days
  Delete entire runs atomically
  Process in batches of 100 runs
```

Runs are deleted atomically (all jobs sharing a `runId`) to prevent partial run data in the UI. Runs with any active or recent job are preserved entirely.

## Real-Time Client Updates

```
Job Handler
  → checkpoint(progress)
  → WorkbookEventService publishes to Redis pub/sub
  → Channel: 'workbook-{workbookId}'
  → All server instances receive the event (multi-instance fan-out)
  → WebSocket gateway pushes to connected clients
```

Redis pub/sub enables multi-instance broadcasting — the worker running the job and the frontend serving the WebSocket connection are typically different Cloud Run instances.

## Error Handling

### Single-Folder Jobs

If the handler throws, the worker catches it and marks the DbJob as `failed`. The error message is stored in `DbJob.error`.

### Multi-Folder Jobs (Pull V2)

Pull V2 uses a two-phase architecture with **per-folder error isolation**:

- **Phase 1 (Fetch)**: Parallel folder fetches from external APIs. If one folder fails, it's marked failed (lock cleared, event sent) but other folders continue.
- **Phase 2 (Process)**: Sequential processing — git commits, index updates. Failed Phase 1 folders are skipped.
- **Finally**: Defensive backstop clears any remaining locks, cleans staging files, and runs git maintenance.
- **Outcome**: If any folder failed, the job is tracked as a failure in analytics, even though successful folders committed their data.

### JobCanceledError

A special error type for intentional cancellation. The worker maps it to `status: 'canceled'` (not `'failed'`) and records cancellation metrics instead of failure metrics.

## Configuration

| Env Variable             | Default         | Description                                                 |
| ------------------------ | --------------- | ----------------------------------------------------------- |
| `WORKER_CONCURRENCY`     | 2               | Concurrent jobs per worker instance                         |
| `WORKER_LOCK_TIMEOUT_MS` | 120,000 (2 min) | BullMQ lock duration / checkpoint heartbeat                 |
| `SERVICE_TYPE`           | —               | Microservice role: `WORKER`, `CRON`, `FRONTEND`, `MONOLITH` |

### BullMQ Queue Settings

| Setting            | Value | Why                                                         |
| ------------------ | ----- | ----------------------------------------------------------- |
| `removeOnComplete` | 100   | Keep last 100 completed jobs in Redis for debugging         |
| `removeOnFail`     | 100   | Keep last 100 failed jobs in Redis for debugging            |
| `attempts`         | 1     | No automatic retries — resume is handled via stall recovery |
| `maxStalledCount`  | 20    | Tolerate Cloud Run's frequent non-graceful shutdowns        |

## API Endpoints

All endpoints require authentication via `ScratchAuthGuard`.

| Method | Path                                | Description                                             |
| ------ | ----------------------------------- | ------------------------------------------------------- |
| GET    | `/jobs`                             | List jobs (paginated, filterable by workbook/type/sync) |
| GET    | `/jobs/workbook/:workbookId/active` | Active jobs for a workbook                              |
| GET    | `/jobs/:jobId/progress`             | Single job progress                                     |
| GET    | `/jobs/:jobId/raw`                  | Raw BullMQ + DB data (debugging)                        |
| POST   | `/jobs/:jobId/cancel`               | Request job cancellation                                |
| GET    | `/jobs/run/:runId`                  | All jobs in a run                                       |
| POST   | `/jobs/bulk-status`                 | Bulk progress for multiple jobs                         |

## Metrics

Each job type emits metrics at terminal states:

- `JOB_{TYPE}_COMPLETED` — successful completion
- `JOB_{TYPE}_FAILED` — error during processing
- `JOB_{TYPE}_CANCELED` — user-initiated cancellation
- `JOB_{TYPE}_STALLED` — BullMQ lock expired (worker died)
- `JOB_WORKER_ERROR` — worker-level infrastructure failure

## Known Gaps and Future Improvements

### No reconciliation for stuck `active` jobs

The stale job reaper only catches jobs stuck in `created`. If a BullMQ job is lost while a DbJob is in `active` status (e.g., Redis flush, BullMQ bug), the DbJob stays `active` forever and its DataFolder lock is never released. A periodic scan that checks `active` DbJobs against BullMQ state would close this gap.

### No framework-level resume abstraction

Each handler is responsible for its own resume logic — reading `completedFolderIds` from progress, skipping finished work, tracking what's done. The framework provides checkpoint/restore plumbing but no higher-level abstraction like "process these items, skip completed ones." This means every handler reinvents the pattern, and it's easy for a new handler to not implement resume at all without anyone noticing.

### Deletion safety on resume

When a pull job resumes after a stall, it doesn't have a complete picture of which files were pulled before the stall. Running the deletion phase (removing files that no longer exist in the source) with an incomplete `pulledPaths` set would incorrectly delete files that were pulled pre-stall. Deletion is currently skipped on resumed runs as a safety measure. See [Pull Job Refactor Plan](/docs/pull-job-refactor-plan.md).

### No dead-letter queue

Jobs that exceed `maxStalledCount` (20) are moved to `failed` by BullMQ, but there's no dead-letter queue or alerting specifically for this case. These jobs are only visible through the `JOB_{TYPE}_STALLED` metric hitting 20 times and the eventual `JOB_{TYPE}_FAILED` metric.

### No job-level timeout

There is no maximum runtime for a job. BullMQ's `lockDuration` (2 min) is a heartbeat, not a timeout — each checkpoint resets it. A job that keeps checkpointing will run indefinitely. BullMQ supports a per-job `timeout` option, but it's not configured.

### Enqueue is not truly atomic

The enqueuer writes to Postgres first, then BullMQ. If the process crashes between the two writes, a `created` DbJob exists with no BullMQ counterpart. The stale job reaper catches this after 5 minutes, but there's a window where the job appears stuck. A transactional outbox pattern would eliminate this gap.

---

## Appendix: Code Map

| Component                         | File                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Job CRUD, cancellation logic      | `server/src/job/job.service.ts`                                                             |
| REST API controller               | `server/src/job/job.controller.ts`                                                          |
| Job entity & status types         | `server/src/job/entities/job.entity.ts`                                                     |
| Job type enum                     | `packages/shared-types/src/job-types.ts`                                                    |
| Enqueuer (create + enqueue)       | `server/src/worker-enqueuer/bull-enqueuer.service.ts`                                       |
| BullMQ worker (processing)        | `server/src/worker/bull-worker.service.ts`                                                  |
| Handler factory                   | `server/src/worker/job-handler.service.ts`                                                  |
| Handler base types                | `server/src/worker/jobs/base-types.ts`                                                      |
| Progress type definition          | `server/src/types/progress.ts`                                                              |
| JobCanceledError                  | `server/src/worker/job-errors.ts`                                                           |
| Stale job reaper                  | `server/src/cron/stale-job-reaper.service.ts`                                               |
| Old job cleanup                   | `server/src/cron/old-job-cleanup.service.ts`                                                |
| Redis pub/sub infrastructure      | `server/src/redis/redis-pubsub.service.ts`                                                  |
| Workbook event broadcasting       | `server/src/workbook/workbook-event.service.ts`                                             |
| Worker config (concurrency, lock) | `server/src/config/scratch-config.service.ts`                                               |
| Custom metrics definitions        | `server/src/metrics/custom-metrics.ts`                                                      |
| Prisma schema (DbJob model)       | `server/prisma/schema.prisma`                                                               |
| Connector resume plan             | [`docs/connector-resume-plan.md`](/docs/plans/resolved/2026-04-14-connector-resume-plan.md) |
| Pull job performance plan         | [`docs/pull-job-performance-plan.md`](/docs/pull-job-performance-plan.md)                   |
