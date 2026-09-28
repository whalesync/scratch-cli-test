# Live Export run-store engine

A second engine for Live Export routine runs (`Workbook.managedBy = ws_export`). Instead of persisting every
record through git and the Postgres file indexes, a run works in a **disposable per-run store** on the git
service and keeps no git or Postgres file state at all. Design and rationale:
[docs/plans/2026-09-25-live-export-git-free-run-store](../../../docs/plans/2026-09-25-live-export-git-free-run-store/2026-09-25-live-export-git-free-run-store.md).
The store's server side: [scratch-git-2/docs/RUN_STORE.md](../../../scratch-git-2/docs/RUN_STORE.md).

## Turning it on

Per Live Export, through the workbook settings map (Whalesync's developer options set this):

```
POST  /workbook                { "managedBy": "ws_export", "liveExportEngine": "run_store" }   // at creation
PATCH /workbook/:id/settings   { "updates": { "live_export_engine": "run_store" } }   // on
PATCH /workbook/:id/settings   { "updates": { "live_export_engine": null } }          // back to classic
```

The key and values are exported from `@spinner/shared-types` (`LIVE_EXPORT_ENGINE_WORKBOOK_SETTING_KEY`,
`LiveExportEngine`). The engine is decided **once per run**, when the run is first driven
(`LiveExportEngineService`), and stored on `RoutineRun.liveExportEngine` (also on the routine-run API), so a
setting changed mid-run applies from the next run. A run falls back to classic — and logs why — unless all of:
the workbook is a Live Export, its settings ask for `run_store`, the routine is the Live Export shape
(a discard first, then pulls / one sync / publish), every pull is full, the pulls cover every folder the sync
reads (its source and destination folders and every FK / lookup target), and the sync uses no asset
transformers. It also goes classic while the `LIVE_EXPORT_RUN_STORE_ENGINE_DISABLED` PostHog kill switch is on,
and when the git service's run-store byte budget (`GIT_LE_RUN_STORE_MAX_BYTES`, 5 GiB) has no room: the store
is created as part of the decision, so a full budget never fails a run. A redelivered sync job clears its dead
attempt's output first, so re-running converges.

## How a run flows

| step     | classic                                                           | run store                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| discard  | reset `dirty` to `main`                                           | `createOrClearRunStore(le-<rrn>)` (fails with a clear message when the git service's run-store byte budget is used up)                                                                                                                                                                                                                                             |
| pull     | stage → index → commit → rebase → GC                              | `RunStorePullSink`: each connector page → `records:<folderId>` in one bulk write; the spec → `schemas`; `DataFolder.recordCount` from the store's exact count; always a full pull, watermarks untouched                                                                                                                                                            |
| sync     | ports over git + `SyncMatchKeys`/`SyncRemoteIdMapping`            | `createRunStoreSyncStoragePorts`: ONE bundle for the whole job; records read in bulk with one table pair cached in memory; match keys, mappings and the `lookup_field` cache in memory; output staged per table and merged into `sync-output:<folderId>` in one transaction; destination reads see this run's output through an overlay (the classic `dirty` view) |
| publish  | plan = git diff `main..dirty`; statuses in `PublishPlanOperation` | `RunStorePublishPlanBuilder` plans from `records` vs `sync-output` with the same per-record functions as the classic build (`plan-operations-for-record.ts`); `RunStorePublishPlanRunStorage` persists statuses in the store (a redelivered job resumes), records created ids for backfills and `@/…` refs; failures are copied to `LiveExportRunFailure`          |
| run ends | —                                                                 | `LiveExportRunLifecycleService` deletes the store (the staging-dir reaper is the backstop: 24 h, byte budget)                                                                                                                                                                                                                                                      |

The same pipeline code runs in both engines — `syncTableMapping`, `PublishPlanRunService.runPipeline`, the pull
job — through the storage ports introduced in steps 1–3b of the plan. Only the adapters in this folder differ.

## Files

| file                                                                                                                                                                 | what                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `run-store-client.ts`                                                                                                                                                | the store contract (`RunStoreClient`: collections of `{key, meta, body}` entries)      |
| `http-run-store-client.ts` / `in-memory-run-store-client.ts`                                                                                                         | scratch-git client; in-process reference used by tests                                 |
| `run-store-collections.ts`                                                                                                                                           | every collection name / entry key the adapters use, and the publish pipeline id format |
| `run-store-pull-sink.ts`, `run-store-sync-storage.ts`, `run-store-publish-plan-builder.ts`, `run-store-publish-plan-run-storage.ts`, `run-store-table-spec-store.ts` | the adapters                                                                           |
| `live-export-engine.service.ts`, `live-export-run-lifecycle.service.ts`                                                                                              | the per-run engine decision and the store's lifecycle                                  |

## Tests

- `test/integration/live-export-engine-equivalence.spec.ts` runs the same Live Export through both engines
  (mixed changes, first export, steady state) and requires identical connector writes, and that the run-store
  run touches no git and writes no per-record Postgres rows; plus publish redelivery and failure persistence.
- `test/integration/http-run-store-client.spec.ts` runs the store contract against a real scratch-git.
- `__tests__/` unit-tests every adapter against the in-memory store.
