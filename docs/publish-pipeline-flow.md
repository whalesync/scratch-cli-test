# Publish Pipeline Flow

The publish pipeline takes changes from the dirty git branch and pushes them to external connectors (e.g. Airtable, Webflow). It runs in two stages: **build** (planning) and **run** (execution).

## High-level flow

### Build phase (`publish-plan-build.service.ts`)

1. Create/reuse a pipeline record in DB
2. Rebase dirty branch onto main (ensure clean diff base)
3. Diff dirty vs main to get changed files — categorize as modified/added/deleted
4. Optionally filter changes by connectorAccountId, folderPath, or filePath
5. For **deleted files**: bulk-lookup record IDs, find inbound references to those deleted files across both branches
6. **Phase 1 (edit)**: Process modified files + files referencing deleted records. For each: strip refs to deleted records (pass 1), strip pseudo-refs (pass 2), compute `changedFields` diff vs main, create plan operations. If pseudo-stripping changed anything, also create a **backfill** operation with the pass-1 content.
7. **Phase 2 (create)**: Process added files. Same two-pass stripping. Also adds **rename-files** operations for files with pending-publish IDs.
8. **Phase 3 (delete)**: Create delete operations for each deleted file.
9. Mark pipeline as `Planned`.

### Run phase (`publish-plan-run.service.ts`)

1. Resume from last completed phase (supports restart after interruption)
2. Execute phases in order: **edit → create → delete → backfill → rename-files**
3. Each phase: fetch pending operations grouped by dataFolder, batch them, dispatch to the connector (update/create/delete), commit results to main branch, sync final content to dirty branch
4. **Retry**: After each phase, re-process `failed-batch` entries individually
5. After all phases: rebase dirty onto main so published changes disappear from the diff

## How files are categorized (create vs. update vs. delete)

This comes directly from the git diff status. `scratchGitService.getRepoStatus(repoId)` returns each changed file with a `status` field:

- **`modified`** → edit (update)
- **`added`** → create
- **`deleted`** → delete

Files that only appear because they _reference_ a deleted record (but aren't themselves modified/added) are also processed in the edit phase, but only if the ref-stripping actually changes them.

## Pseudo-ref handling

> The canonical definition of the `@/…` reference format (workspace-absolute, connection folder first) lives in [`pseudo-refs.md`](./pseudo-refs.md); it wins on any conflict. This section covers only how the publish pipeline strips and resolves them.

Pseudo-refs are references to records that don't yet have a real remote ID (they have scratch pending-publish IDs). The handling is a **two-pass strip + later backfill** pattern:

### During build

- **Pass 1** (`stripDeletedRecordRefs`): Removes references to records being deleted in this publish.
- **Pass 2** (`stripPseudoRefs`): Removes any remaining pseudo-refs (refs with pending-publish IDs) from the content. The edit/create operation uses this stripped version so the connector never sees unresolved refs.
- If pass 2 changed anything, a **backfill** operation is created with the pass-1 content (which still has the pseudo-refs). This is queued to run _after_ creates, so by then the referenced records will have real IDs.

### During run

- `refResolverService.resolveBatchPseudoRefs(workbookId, rawContents)` is called in both `dispatchUpdateBatch` (for edit and backfill phases) and `dispatchCreateBatch`. This resolves the pseudo-refs to real remote IDs by looking them up in the file index (which gets populated during the create phase when the connector returns real IDs).

### Summary

The flow is: **strip pseudo-refs → create records → get real IDs → backfill phase resolves pseudo-refs using those real IDs → update the records that referenced them**.

The actual resolution logic lives in `RefResolverService` and `RefCleanerService`, but the orchestration is in the build and run services.

## Key services involved

| Service                   | Role                                                    |
| ------------------------- | ------------------------------------------------------- |
| `PublishPlanBuildService` | Diffs branches, plans operations                        |
| `PublishPlanRunService`   | Executes planned operations against connectors          |
| `RefCleanerService`       | Strips deleted-record refs and pseudo-refs during build |
| `RefResolverService`      | Resolves pseudo-refs to real IDs during run             |
| `FileIndexService`        | Maps filenames to remote record IDs                     |
| `FileReferenceService`    | Tracks inter-file references for ref-clearing           |
| `SchemaHelperService`     | Resolves table specs and schemas for data folders       |
| `ScratchGitService`       | Git operations (diff, read, commit, rebase, rename)     |
