# Job-based Sync Draft Save (Live Export "Save" button)

Status: **proposal** — [DEV-10875](https://linear.app/whalesync/issue/DEV-10875/saving-sync-needs-to-be-faster-or-give-more-feedback)

## Problem

Saving a Sync Draft from Live Export drives two synchronous HTTP requests —
`POST /sync-drafts/:draftId/materialize` then `POST /sync-drafts/:draftId/apply`
(`server/src/sync-draft/sync-draft.service.ts`). With many tables the work is dominated by
sequential remote calls the server cannot avoid: creating each table and its fields on the
destination service, fetching schemas, and creating a data folder per table. Connector
rate limits (Airtable, Notion, …) put a hard floor under this, so past a modest table
count the Save can never be a snappy synchronous request. Consequences today:

- **No feedback.** The user stares at a spinner for minutes with no indication of progress.
- **Timeout fragility.** A multi-minute request can be killed at the load balancer while
  the server keeps working. The client shows an error; the user retries into a moving
  state. If the first apply finishes meanwhile, the retry gets `409 SYNC_DRAFT_ARCHIVED`,
  which the client has no way to distinguish from a real failure.
- **No single-flight guard.** The advisory lock only covers `getOrCreate`. Double-clicking
  Save (or two tabs) can run two materializes concurrently — both see the same unresolved
  placeholders and both create remote tables — or two applies, which both see
  `resolved.dataFolderId == null` and create duplicate data folders.

A first round of synchronous-path fixes (shared schema caches, stored-schema reads,
`validateAgainstStoredSchemas`) removed the redundant connector fetches, but the
irreducible remote-creation work remains.

## Why a job fits unusually well here

The two phases were already designed idempotent and resumable — the draft row itself is
the checkpoint store:

- `materialize` is re-callable: only unresolved placeholders are attempted, and each
  success is persisted back onto the draft (`resolved.remoteTableId` /
  `resolved.remoteFieldId`) the moment it lands.
- `apply` checkpoints each created data folder (`resolved.dataFolderId`) before moving on,
  and archives the draft only after the sync row is saved.
- `MaterializePlaceholderResult` (`created` / `alreadyResolved` / `failed`, per ref) is
  exactly the granularity a per-table progress UI needs.

So the job body is a thin wrapper around the existing service methods; no pipeline logic
moves.

## Design

### New job: `ApplySyncDraft`

A standard typed job definition in `server/src/worker/jobs/job-definitions/`
(`apply-sync-draft.job.ts`), following the existing contract (`publicProgress`,
`checkpoint()`, `abortSignal`, `job-started`/`job-completed`/`job-failed` workbook
events).

- **Input**: `{ draftId, workbookId, createRoutine }` + actor/runContext like every job.
- **Body**: `materialize(draftId)` → if any placeholder still unresolved, fail the job
  with the per-ref results → `apply(draftId, { createRoutine })` → complete with
  `{ syncId }`.
- **publicProgress** (what the UI renders):

  ```ts
  {
    phase: 'materializing_tables' | 'materializing_fields' | 'creating_folders' | 'saving_sync' | 'done';
    totalPlaceholders: number;      // tables + field additions to create
    resolvedPlaceholders: number;   // running count, from the per-ref checkpoints
    failedRefs: { ref: string; error: string }[];
    syncId?: SyncId;                // set on completion
  }
  ```

  To feed the running count, the service methods accept an optional progress callback
  (invoked at the existing `persistTableMappings` checkpoint sites); the synchronous
  endpoints pass none and behave exactly as today.

### Endpoint changes

- `POST /sync-drafts/:draftId/save` → enqueues the job, returns `202 { jobId }`.
  (Alternative: a `?async=true` flag on `apply`; a dedicated route is clearer since the
  job runs *both* phases.)
- `GET /sync-drafts/:draftId` response gains `activeSaveJobId: JobId | null`, so a cold
  page load (`getOrCreate` → `get`) rediscovers an in-flight save with no client-side
  state. Implementation: store the enqueued job id on the draft row
  (`SyncDraft.activeSaveJobId`), cleared by the job on completion/failure.
- The existing `materialize` / `apply` endpoints stay during rollout (desktop/CLI/back-compat),
  feature-flagged off for Live Export once the job path ships.

### Single-flight

Two layers, both cheap:

1. **Enqueue-time dedup**: BullMQ job id = `apply-sync-draft:<draftId>` (the existing
   `enqueueJobWithId` path). A second Save while a job is active returns the same job id —
   the double-click and two-tab cases collapse into "watch the same job".
2. **Run-time guard**: `materialize` and `apply` take the same transaction-scoped
   Postgres advisory lock `getOrCreate` uses, keyed by `draftId`. This also protects the
   legacy synchronous endpoints against racing the job during rollout.

### Client flow (Whalesync Live Export — separate repo)

1. Save → `POST /sync-drafts/:draftId/save` → `{ jobId }`.
2. Subscribe to workbook events (already flowing over Redis → WebSocket) and/or poll the
   job; render a progress modal from `publicProgress`: "Creating table 7 of 23", with a
   per-ref checklist and inline errors for `failedRefs`.
3. On `job-completed`: navigate to the created/updated sync (`syncId`).
4. On `job-failed` with partial results: show which refs failed and offer **Retry** —
   which just re-enqueues; already-resolved placeholders are skipped (`alreadyResolved`).
5. On page load: if `activeSaveJobId` is set, reopen the progress modal instead of the
   editor — refresh/close mid-save becomes a non-event.
6. Treat `409 SYNC_DRAFT_ARCHIVED` anywhere in this flow as "the save already succeeded":
   fetch the draft (archived drafts carry `appliedSyncId`) and navigate to that sync.

### Failure semantics (unchanged from today, now visible)

- A failed table/field creation fails only its ref; the job completes the rest and
  reports `partial`, mirroring `aggregateMaterializeStatus`. The user retries after
  fixing the cause (e.g. a name collision on the destination).
- A crash mid-job resumes convergently on retry: materialize skips resolved placeholders,
  apply skips folders whose `dataFolderId` is checkpointed. Worst case is litter (an
  orphan remote table or folder), never duplicates — same guarantee as today.
- The job never auto-retries table creation blindly; `attempts: 1` at the BullMQ level,
  retry is a user action (creation against external services should stay deliberate).

## Work items

| # | Item | Where |
| - | ---- | ----- |
| 1 | `ApplySyncDraft` job definition + enqueuer method | `server/src/worker/jobs/job-definitions/`, `worker-enqueuer/bull-enqueuer.service.ts` |
| 2 | Progress callback threading through `materialize`/`apply` | `sync-draft.service.ts` |
| 3 | `POST /sync-drafts/:draftId/save` + `SyncDraft.activeSaveJobId` (schema migration) | `sync-draft.controller.ts`, `schema.prisma` |
| 4 | Advisory lock on `materialize`/`apply` keyed by draftId | `sync-draft.service.ts` |
| 5 | Shared types: save response, job public progress | `packages/shared-types` (+ api-client `syncDrafts.save`) |
| 6 | Live Export progress modal + reload/archived-draft handling | Whalesync repo |
| 7 | Feature flag + rollout, then retire the synchronous two-call flow for Live Export | both |

Items 1–5 are server-side and independently shippable; the synchronous endpoints keep
working throughout, so the Whalesync client can migrate whenever ready.
