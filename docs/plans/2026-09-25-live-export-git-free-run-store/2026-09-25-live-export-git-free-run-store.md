# Live Export: run on an ephemeral run store instead of the git pipeline

**Status:** In Progress. **Created:** 2026-09-25. **Author:** Ryder Ziola (with Claude). **Linear:** _(none yet)_. **Evidence:** overnight investigation of prod run `rrn_uoOqi5UKmk` plus a same-shape local reproduction and a working prototype (`server/src/scripts/live-export-fastpath-prototype.ts` on the `minnetonka` branch).

## Summary

A Live Export run (`Workbook.managedBy === ws_export`) is a routine run with five child jobs: discard → pull source → pull destination → sync → publish. Today every one of those jobs persists its intermediate state through the full Scratch storage stack — staging files, git commits on `main` and `dirty`, FileIndex/FileReference/Asset rows, SyncMatchKeys/SyncRemoteIdMapping rows, PublishPlanOperation rows — and the next run throws all of it away (`discard-pending-changes`, a full re-pull, a full match-key rebuild). None of that state is ever read by a human: nobody opens a `ws_export` workbook in the desktop app or CLI, and there is no review step.

This plan replaces the storage behind those five jobs, for Live Export workbooks only, with a **per-run, disposable run store**: plain JSON files plus a small SQLite manifest under `staging/le-<runId>/` on the scratch-git VM. The five jobs, the routine run, the `RoutineRunStep` rows Dusky reads, all connectors, and all per-record logic (transformers, matching, diffing, publish phases) stay exactly as they are. Nothing changes for non-Live-Export workbooks.

Measured on the prod workbook's exact shape (32 tables, 309,691 records), the steady-state run drops from **18.7 min to about 13 s of compute** on the same machine; in prod the run becomes bounded by the external service's read throughput, so we expect **5–10 minutes** for the workbook that takes 131 minutes today.

## Motivation

`wkb_2De3VHK6wS` (Supabase → Supabase, 310k records) took 131 min on 2026-09-25 to publish 1,800 changes. Where the time went, measured from step timestamps, scratch-git's slow-call log, the nginx access log and the Cloud SQL slow-query log:

| step                    | wall     | scratch-git calls from the worker | git time (calls > 100 ms) | Postgres queries > 5 s |
| ----------------------- | -------- | --------------------------------- | ------------------------- | ---------------------- |
| Pull Source (0 changes) | 38.0 min | ~7,700                            | 3.3 min                   | 13.2 min               |
| Pull Destination        | 37.7 min | ~7,700                            | 4.6 min                   | 20.4 min               |
| Run Sync (0 changes)    | 54.3 min | ~2,600                            | 6.4 min                   | 21.4 min               |
| Publish (1,800 updates) | 1.2 min  | 308                               | 0                         | 0                      |

Two separate problems are visible:

1. **55 min is a Postgres generic-plan bug** on bulk `IN (...)` lookups, fixed in `64735a01b` (on master, not yet in the prod build that ran this). Deploying it brings the run to roughly 75 min. That is a prerequisite, not part of this plan.
2. **The remaining ~75 min is the persistence pipeline, not the work.** The connectors' share is seconds. Every record is staged to scratch-git's disk, read back over HTTP in batches of 100, indexed into three Postgres tables, checkpointed to Redis and Postgres, committed in 1,000-file batches that each rewrite the folder's git tree, and then re-read from git five more times by the sync (1,836 paginated reads of 1,000 full records, each call re-listing and sorting the whole folder). A run that changes nothing does all of it.

The local reproduction (same table shape, Postgres on both ends, everything on one machine so connector I/O is ~free) isolates the pipeline's own cost:

| job                                        | wall        | of which scratch-git | of which Postgres                                        | of which connector |
| ------------------------------------------ | ----------- | -------------------- | -------------------------------------------------------- | ------------------ |
| Pull Source, no changes                    | 187 s       | 167 s (89%)          | 32 s                                                     | 10 s               |
| Pull Destination, no changes               | 563 s       | 242 s (43%)          | 32 s                                                     | 11 s               |
| Run Sync, no changes                       | 368 s       | 230 s (62%)          | 94 s                                                     | —                  |
| Publish, no changes                        | 1 s         |                      |                                                          |                    |
| **steady-state run, zero changes**         | **1,119 s** |                      |                                                          | **~20 s**          |
| first export (310k creates), for reference | 91 min      |                      | publish alone: 2,419 s in `PublishPlanOperation` queries |                    |

The prototype (real connectors, real `applyColumnMappings`, real `deriveCanonicalMatchKey` and `computeChangedFields`, in-memory match/diff, no git, no index tables) on the same steady state: **12.9 s**, same verdict (`309,691 unchanged, 0 changes`). It also publishes: after deleting 1,000 destination rows it re-created them in 12 s and the next run was again a clean no-op.

## Design

### The rule: no git or Postgres file state for these workbooks

A workbook in run-store mode does **not** keep its git repos or its Postgres file indexes up to date — at all. Every Live Export routine run starts from a completely fresh, empty folder in temporary storage: it downloads everything into that folder, does all of its indexing there, syncs within the folder, publishes from the folder, and when the folder is garbage-collected nothing survives except the **run results** (`RoutineRun` / `RoutineRunStep` stats and per-record failures). After a run, the workbook's git repos, FileIndex / FileReference / Asset rows, SyncMatchKeys / SyncRemoteIdMapping / SyncForeignKeyRecord rows and PublishPlan / PublishPlanOperation rows may be stale or empty, and that is correct: nothing reads them for a Live Export workbook (nobody opens a `ws_export` workbook in the desktop app or CLI).

What stays in Postgres is configuration and bookkeeping that is not per-record file work: connections and credentials, folder rows and options, the sync mappings, the routine and its runs, and job state.

Any per-record or per-file read or write of git or Postgres left on a run-store codepath is a bug against this rule. The table in "Where the code changes" lists every one found so far.

### The run store

One directory per routine run on the scratch-git VM, created by the first child job and deleted by the last:

```
{staging_dir}/le-<runId>/
  manifest.db                       SQLite: records(side, folder, record_id, path, bytes), match_keys(folder, match_id, record_id, path),
                                    plan(folder, op, record_id, status, error), created(folder, path, remote_id), meta(key, value)
  schema/<side>/<folder>.json       the table spec the pull fetched from the connector for this run
  source/<folder>/<record_id>.json  verbatim connector output (Connector Prime Directive still holds — it's the same bytes the pull writes today)
  destination/<folder>/<record_id>.json
  plan/<folder>/<record_id>.json    transformed destination record + changedFields for update ops
```

`<runId>` is the routine run's `rrn_…` id, which every child job already carries in `runContext.routineRunId`, so no new plumbing is needed to share the directory between jobs. (Not the `run_…` id: `RoutineExecutorService.execute()` mints a fresh `run_…` each time it re-enters a run, e.g. resuming after a redeploy, so a store keyed on it would come back empty on resume.)

**Where it lives: a plain folder on the scratch-git VM.** The workers can't hold it: they are Cloud Run gen1 services with an in-memory filesystem that counts against the memory limit (3 GiB in prod, shared by `WORKER_CONCURRENCY` = 10 jobs), and one run of the 310k workbook is ~1.2 GB. A run is also five separate BullMQ jobs that can land on different worker instances. The scratch-git VM has the data disk and outlives every job, so it hosts the folder and acts as a plain file server for it. Real local disk on the workers (a GCE/GKE pool with local SSD, or running this compute on the VM itself) would remove the network hop but is a large infrastructure change; the transfer design below should make it unnecessary, and step 4 measures that.

The store is served by scratch-git-2 through the existing staging surface (`routes/staging.rs`), extended with what the sync and publish jobs need: paged read of a folder in `record_id` order, read-by-ids, match-key writes and reads, plan-entry writes and status updates, and created-record ids. It is a file server here: no git objects are created for these runs. The existing `POST /api/staging/{key}/files` write path (atomic file write + one SQLite transaction per batch) is reused.

### Moving data between the workers and the run store

The records live on the VM and the logic runs on the workers, so every byte crosses the network. The measured cost of the staging endpoints (~100 ms per 500-record write, ~12 ms per 100-record read) is per-request overhead, not bandwidth — 1.2 GB of JSON is little inside the VPC. So the API is built for bulk, and each record body crosses the wire a small, fixed number of times:

1. **Big pages.** Reads and writes move ~5,000 records per request (tunable), not 100–500: a full pass over the 310k workbook is ~60 requests.
2. **Compression.** Request and response bodies are gzip-compressed; record JSON compresses several-fold.
3. **Parallel streams.** Tables are read and written several at a time per side, as the pull already fetches them.
4. **Each record body crosses a bounded number of times:** written once by the pull; read once per side by the sync; written once as a plan entry; read once by publish.
5. **The sync reads each table once.** `syncTableMapping` walks the source twice (Pass 1, Pass 2) and the destination twice (Pass 1, Pass 3) — deliberate in classic mode, which streams to stay under the worker's memory limit (DEV-11194). The run-store `SyncRecordSource` keeps one table pair's pages in memory after the first read and serves the second pass from it, falling back to re-reading above a per-job byte budget. No change to the shared sync logic; the largest table pair in the 310k workbook is ~220 MB.
6. **Match keys are computed once and persisted.** Pass 1 derives each record's canonical match key, holds the table pair's keys in memory, and writes them in batches to the manifest's `match_keys` table (key, record id and path only — ~30 MB for 310k records, small next to the record bodies). Pass 3 and the FOREIGN_KEY_MAPPING phase read them back instead of re-deriving, and memory is released between table pairs. They persist only for the run; every run starts fresh.

Target, to be confirmed by measurement in step 4: seconds to low minutes of transfer for the 310k workbook, well under the connectors' own 5–10 minutes.

### The five jobs, diverted

Each job keeps its handler, its checkpoint/resume contract with BullMQ, and its `RoutineRunStep` reporting. Only its storage adapter changes.

| job                                                   | classic adapter (unchanged)                                                                                                                                                        | Live Export adapter                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discard-pending-changes`                             | reset `dirty` to `main` per connection                                                                                                                                             | create (or clear) `le-<runId>/`                                                                                                                                                                                                                                       |
| `pull-linked-folder-files` (source, then destination) | init repo, write schema + view to git, stage → read back → FileIndex/FileReference/Asset → commit → deleteStale → rebase → gc → buildIndex → record counts; advance watermarks     | always a full pull; write the fetched table spec to `schema/<side>/<folder>.json` and each connector page to `<side>/<folder>/`; no git, no index rows, no watermark; step stats = "Pulled N"                                                                         |
| `sync-data-folders`                                   | schemas from git; read pages from `dirty`; match keys in SyncMatchKeys/SyncRemoteIdMapping; read matched files; write via staging + `commit-atomic` to `dirty`                     | schemas and pages from the run store (each table read once, see above); match keys in memory per table pair and persisted to `match_keys`; write ops to `plan/`                                                                                                       |
| `publish`                                             | build plan from `git diff merge_base..dirty`; schemas from git; run phases; resolve `@/…` refs through FileIndex; write back to `main` + `dirty` + FileIndex/FileReference; rebase | no plan build — the plan is the `plan/` tree sync wrote; schemas from the run store; run the same phases; resolve `@/…` refs from the run's `created` table; write back = mark plan entries success/failed and record created ids; delete `le-<runId>/` on completion |

### Where the code changes (the seams)

The principle: **all logic stays shared; only IO moves behind an interface.** Each operation gets a small port that its orchestration already implicitly has, with the classic implementation extracted verbatim from today's code.

| operation     | port                                                                                                                                                                                                               | status                                                                                                                                                                                                                         |
| ---           | ---                                                                                                                                                                                                                | ---                                                                                                                                                                                                                            |
| pull          | `PullSink` (prepare folder / write page / release page state / finish folder / cleanup / finalize)                                                                                                                 | **done** (step 3). Classic sink = staging, indexing, commits, stale deletion, rebase, GC, index rebuild, record counts.                                                                                                        |
| sync          | `SyncRecordSource` (source pages, destination pages, destination files by path)                                                                                                                                    | **done** (step 1)                                                                                                                                                                                                              |
| sync          | `SyncMatchIndex` (match keys, join, source → destination mappings)                                                                                                                                                 | **done** (step 1). The interface already allows an implementation that persists keys to the manifest.                                                                                                                          |
| sync          | `SyncDestinationOutputSink` (queue writes, flush per page, commit as one unit, delete)                                                                                                                             | **done** (step 1)                                                                                                                                                                                                              |
| sync          | `SyncLookupDataProvider` behind `createLookupTools` (referenced-folder mappings, `lookup_field` cache, assets)                                                                                                     | **done** (step 1)                                                                                                                                                                                                              |
| publish       | `PlanStore` (plan reads, operation status, counts)                                                                                                                                                                 | **done** (step 2)                                                                                                                                                                                                              |
| publish       | `RecordWriteback` (post-batch write-back, rename phase, reconcile, commit tags)                                                                                                                                    | **done** (step 2)                                                                                                                                                                                                              |
| sync, publish | **table spec store**: `TableSpecStore` (`server/src/workbook/table-spec-store/`), read by sync (`SyncStoragePorts.tableSpecStore`) and publish (`PublishPlanRunStorage.tableSpecStore`, via `SchemaHelperService`) | **done** (step 3b). Classic: `GitTableSpecStore`.                                                                                                                                                                              |
| pull          | **table spec writes**: `PullSink.storeFolderTableSpec` / `storeFolderDefaultView`, keyed by the same `TableSpecLocation` sync and publish read (was `writeSchemaToGit` / `writeViewToGit` in `loadFolderAndConnector`)                                                                                     | **done** (step 3b)                                                                                                                                                                                                             |
| pull          | **repo setup and folder finalize**: `PullSink.prepareStorageBeforeLoadingFolders` (was the job's `resolveConnectionRepoPath` + `initRepo`) and `PullSink.persistsIncrementalPullBaseline`                          | **done** (step 3b). A sink that isn't the incremental baseline gets a full pull and `finalizeFolder` leaves the watermarks untouched, so they keep describing the classic store. The folder lock, remote URLs and events stay. |
| publish       | **pseudo-ref resolver**: `PublishPlanRunStorage.pseudoRefResolver` (`PublishPseudoRefResolver`)                                                                                                                    | **done** (step 3b). Classic: `RefResolverService` (Postgres FileIndex). Run-store version: path → created remote id from the run's `created` table, keyed by the destination path sync wrote into the ref.                     |
| publish       | **plan build**: `publish-plan-build.service.ts` diffs git                                                                                                                                                          | not a port — bypassed. In run-store mode the publish job runs the plan sync wrote.                                                                                                                                             |
| sync job      | **after-sync git work** in `sync-data-folders.job.ts`: `runGitGc` on each destination repo, and publish-after-sync enqueued through `publishPlanBuildService.createPipeline` (the git-diff plan build) | **to do** (step 5): skip the GC and hand the publish job the run's `plan/` instead of building a plan |
| entry         | `RoutineExecutorService.enqueueForStep` passes `storageMode: 'run-store'` when `managedBy === ws_export` and the flag is on                                                                                        | **to do** (step 5): one branch in `enqueueForStep`; job payloads gain one field                                                                                                                                                |

Known gaps a run-store implementation must handle in step 5:

- **Publish's path-only spec fallback.** When `getTableSpecById` finds no spec, publish falls back to `SchemaHelperService.getTableSpec(workbookId, folderPath)`, which looks the folder up by path without the connection. In a Live Export workbook the source and destination folders often share a path, so the fallback can return the source connection's spec. Classic has the same latent bug; the run-store path should look specs up by data folder id only (or scope by connection) and fail if the spec is missing.
- **A missing spec is not an error today.** Sync and publish treat an unreadable or missing spec as "no schema" (sync then assumes an `id` idPath). For the run store, a missing spec means the pull didn't write it — that should fail the run, not fall back.

Still reading Postgres on the publish path, but not per-record file state: `RecreatedIdMapService` (CLI revert markers; never set for Live Export) and folder/connection metadata. These stay.

Untouched and reused as-is: every connector, `sync-execution.ts` (`applyColumnMappings`, the transformer pipeline, `classifyDestinationRecord`), `record-matching.ts`, `resolve-column-transform-input.ts`, `schema-validator.ts`, `publish-plan/diff-utils.ts`, the routine executor's step loop, `RoutineRun`/`RoutineRunStep` entities, the sync-draft wizard, record-limit enforcement, PostHog/audit hooks.

Not supported in v1 (the job falls back to `classic` when the mapping needs them): asset transformers (`SourceAssetToDestAsset`, which need the Asset index and rehost job) and the incremental destination pull flag (`ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL`, which needs a previous destination snapshot; a fresh-slate run has none).

### Reporting

`RoutineRunStep.result` keeps its `{ summary, stats }` shape. Per-record publish failures, which Dusky reads from `PublishPlanOperation` today, move to a small `LiveExportRunFailure` table (`routineRunId`, `folderPath`, `sourceRecordId`, `phase`, `message`), written by the publish job's `RecordWriteback`. Rows are deleted with the routine run.

### Lifecycle of the run store

This is the part that touches the expensive disk, so it is spelled out:

1. **Size.** One run is `(source + destination + changed) × record size`. For the 310k workbook the local run store was ~1.5 GB pretty-printed, ~1.2 GB with today's compact staging format. Runs are sequential per workbook (the routine executor enforces one active run per routine file), so the steady-state footprint is one run store per concurrently running Live Export, not per workbook.
2. **Normal end.** The publish job deletes `le-<runId>/` in its `finally`, the same contract the classic pull has for `{jobId}/`. Deletion of a 310k-record dir took 33–42 s locally (`DELETE /api/staging/{key}`); it stays asynchronous from the step result so the run does not wait for it.
3. **Failed or cancelled run.** The routine executor already knows when a run reaches a terminal state (`TERMINAL_RUN_STATUSES`); it issues the same delete. A run that fails in the sync step therefore does not keep its two snapshots around.
4. **Orphans (worker death, redeploy mid-run).** The existing hourly `staging-dir-reaper` cron (`server/src/cron/staging-dir-reaper.service.ts`, DEV-11317) already lists every staging dir with its age and size and deletes dirs older than 72 h with no live job. Extend its liveness check to `le-` keys: a dir is live while its `RoutineRun` is non-terminal. Lower the age threshold for `le-` dirs to 24 h (a Live Export run is never resumed a day later; the routine simply runs again).
5. **Boot backstop.** `reap_stale_staging_dirs` in scratch-git-2 already sweeps age-only orphans at boot; `le-` dirs use the same 24 h threshold.
6. **Disk cap.** Add a byte budget for `le-` dirs (env `GIT_LE_RUN_STORE_MAX_BYTES`, default 20 GB on the 50 GB data disk) checked by the reaper: over budget, it deletes the oldest terminal-run dirs first, then alerts if still over. A run that cannot create its dir because of the budget fails its first step with a clear message rather than filling the disk.
7. **Observability.** `GET /api/staging` already reports per-dir age and bytes; add the `le-` prefix to the reaper's log line and to the existing scratch-git disk alert so the total run-store footprint is visible.

What this removes from the disk, for comparison: today each Live Export run leaves loose git objects (every commit's rewritten folder trees on two branches until GC packs them), the staging dir during the run, and per-repo SQLite index files, on top of the repos themselves. The run-store design writes each record once and never creates a git object.

### Expected performance

|                              | today (prod, 310k records)           | after `64735a01b` deploys | with the run store                                                                                                                                                               |
| ---------------------------- | ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| steady-state run, ~0 changes | 131 min                              | ~75 min (estimate)        | 5–10 min, bounded by the external service's read throughput (both sides fetched in parallel, tables 3-wide per side)                                                             |
| first export, 310k creates   | not measured in prod; 91 min locally |                           | dominated by the destination's write throughput; locally the connector inserted 1,000 rows in 0.1 s, and the per-batch `PublishPlanOperation` queries that took 40 min disappear |

Compute on the same laptop, same data, same code paths: classic 1,119 s versus 13 s (in-memory prototype). The run-store version adds the network hop to the VM. At today's small-page staging rates (~100 ms per 500-record write, ~12 ms per 100-record read) that would be 2–4 min for 310k records; with the bulk transfer design above the target is well under that. Step 4 measures it. Worker memory is bounded by the largest table pair (invoice_line_items: ~220 MB) instead of the whole export.

## Implementation plan

Each MR ships on its own and leaves classic behaviour byte-identical, verified by the existing unit, server integration and CLI integration suites (`scratch-cli-tests` `publish`, `driver-publish`, `files`, `linked-folders`, `workspace-sync`).

1. **Sync ports** (`SyncRecordSource`, `SyncMatchIndex`, `SyncDestinationOutputSink`, `SyncLookupDataProvider`). Pure refactor of `sync.service.ts` + `lookup-tools.ts`; the classic adapters are today's code moved, not rewritten. **Done** (MR !3373).
2. **Publish-run ports** (`PlanStore`, `RecordWriteback`). Pure refactor of `publish-plan-run.service.ts`; plan _build_ stays classic-only. **Done** (MR !3373).
3. **Pull port** (`PullSink`). Pure refactor of `pull-linked-folder-files.job.ts`. **Done** (MR !3373).
   - **3b. Remaining seams** (pure refactor, same pattern): a table spec store read by sync and publish, and written by the pull through its sink; the pull job's repo setup and watermark finalize behind the sink; a pseudo-ref resolver port for publish. Found after steps 1–3 once the no-git/no-Postgres rule was made explicit. **Done** (MR !3373).
4. **scratch-git-2 run store**: `le-<rrn_id>` key namespace, manifest schema (records, match_keys, plan, created, meta), schema files, bulk paged / by-id reads and writes (large pages, gzip), plan-status updates, reaper liveness for `le-` keys, byte budget. Rust + a Bruno collection update. Measure transfer rates for a 310k-record run. A first cut exists on the unpushed branch `live-export-run-store-step4-scratch-git-parked`; it needs the match_keys / created tables, schema files, larger pages and compression.
5. **Live Export adapters + job wiring**: the adapters for every port (including the per-table page cache and match-key persistence above), `storageMode` on the job payloads, the `enqueueForStep` branch, `LiveExportRunFailure`, feature flag `ENABLE_LIVE_EXPORT_RUN_STORE` (per user, default off). Fallback to classic when the mapping has asset transformers or the incremental destination pull flag.
6. **Rollout**: internal workbooks first, then the large-tenant workbooks that motivated this, comparing `RoutineRunStep` stats and the destination's own row counts against the classic path (the `/test-live-export` harness already does this comparison).

Rough size: steps 1–3 are two to three days each; step 4 is about a week; step 5 is about a week; total on the order of three to four weeks for one person. The prototype's in-memory `LookupTools` and diff loop carry over.

## Open questions

1. **Incremental destination pull.** The flag exists because full destination pulls are slow on some connectors (Notion). A fresh-slate run has no previous destination snapshot, so "incremental" would mean retaining one run store per workbook until the next run replaces it, which breaks the fresh-slate rule. v1: run-store mode always pulls fully, and a workbook with the flag stays classic. Revisit with data from the first rollouts.
2. **Per-repo SQLite index (`POST /api/repo/index/{id}/build`).** The pull job rebuilds it after every pull (85 s on the prod source pull) and nothing on the server reads it. Worth confirming and removing independently of this plan.
3. **Publish plan size.** The first export of this workbook produced 859,745 plan operations (creates + FK backfills + rename-files). The `rename-files` phase is meaningless without git filenames and disappears in run-store mode; backfill stays.
4. **Where `LiveExportRunFailure` is read.** Dusky and the MCP `live_export_get_run` tool need to switch from `PublishPlanOperation` to the new table for run-store runs.

## References

- Investigation report and raw numbers: `.context/le-perf/REPORT.md` on the `minnetonka` branch (not checked in); prototype at `server/src/scripts/live-export-fastpath-prototype.ts` on the same branch.
- Generic-plan fix: `64735a01b` "[server] Stop FileIndex and sync bulk lookups from burning prod DB CPU".
- Staging reaper: DEV-11317; disk bloat incident: DEV-11253.
- Routine executor: `server/src/routine/routine-executor.service.ts`; routine generator: `server/src/routine/routine-generator.ts`.
