# Publish Next Steps

## Current state

`scratchmdv4 plan-publish` is fully implemented:
- Diffs dirty vs master, classifies into raw phases (modified / added / deleted)
- Ref-clearing candidates found via SQLite `file_references` index
- Three-pass stripping: FK refs to deleted records, `@/` pseudo-refs, `@asset/` pseudo-refs
- `changedFields` sparse diff (only changed keys sent to remote)
- Backfill entries (restore pseudo-refs after creates resolve pending IDs)
- Rename markers for `scratch_pending_*` files
- Plan written to `{ConnName}/.scratch/publish-plans/{timestamp}/` with per-phase subfolders
- `plan.json` with `deleteIndex` and `changedFields` maps
- Reporting: `(raw diff)  →  (plan phases)` arrow per folder
- 42 tests covering all pure functions and integration scenarios

---

## Execute-publish architecture

Execute-publish is **server-driven**, not a Rust CLI command.

The flow is:
1. **CLI: push** — `scratchmdv4 push` commits dirty changes and pushes to the remote bare repos (already implemented)
2. **CLI: push plan** — push the publish plan folder to the remote repo (to be added to `scratchmdv4 push`, or as a separate step)
3. **NestJS: trigger** — a new NestJS endpoint receives a `POST /publish/execute` with `{ connectionId, planId }`, reads the plan from the remote git repo, and runs all phases

The server already has a `PublishPlanRunService` that this maps to.

---

## Phase execution order

Phases run in this fixed order (matches old server):

```
asset-upload  →  edit  →  create  →  delete  →  backfill  →  rename-files
```

- `asset-upload` — upload `@asset/` files to remote service first; skipped for now
- `edit` — PATCH existing records (stripped content + `changedFields`)
- `create` — POST new records; connector returns assigned remote IDs
- `delete` — DELETE records; remote IDs come from `plan.json deleteIndex`
- `backfill` — PATCH again after creates resolved pending `@/` refs (restores stripped pseudo-refs)
- `rename-files` — rename `scratch_pending_*.json` → `{remoteId}.json` in dirty + master

The server tracks plan status across phases (`edits-running`, `edits-completed`, etc.) so an interrupted pipeline can resume from where it left off.

---

## Per-phase execution detail

For each phase (except `asset-upload`):

1. **Group entries by folder** (each folder maps to a remote table)
2. **Resolve table spec** from schema cache (needed by the connector for field mapping)
3. **Chunk per folder** — process 100 records at a time (or connector-specific batch size)
4. **Call connector** — `updateRecords` / `createRecords` / `deleteRecords`
5. **On batch failure** — mark entries as `failed-batch`, retry individually at end of phase
6. **Update file_index** — after creates, store returned remote IDs
7. **Commit to git** — write the final content to the **master** bare repo via `POST /api/repos/upsert-files`
8. **Sync to dirty** — write to the **dirty** bare repo, but only for files where this is their final operation:
   - `backfill` and `delete` are always final — always sync
   - `edit` and `create` — only sync if no later `backfill` or `delete` entry is pending for that file

After all phases complete:
9. **`rebase-dirty`** — fast-forward dirty branch on top of master so dirty === master

---

## What the NestJS endpoint needs to implement

```
POST /publish/execute
Body: { connectionId: string, planId: string }
```

Steps inside the handler:
1. Find the connection's remote git repo
2. Read plan folder from remote repo (via `GET /git/{repoPath}` or a new read-files API call)
3. Parse `plan.json` to get `deleteIndex`, `changedFields`, `summary`, `entries`
4. For each phase in order: use `entries[phase]` to discover which files to read, execute in batches of 100 per folder

> **Note — future simplification:** the `entries` map in `plan.json` exists so NestJS can discover phase files
> without traversing the git tree. A cleaner alternative would be to drop the map entirely and instead do a
> single `diff` (or tree-list) call against the plan folder at the start of execution, walking the
> `.scratch/publish-plans/{planId}/{folder}/{phase}/` tree directly. Keeping the map for now since it works,
> but worth revisiting when the plan format stabilises.
5. After `create`: store returned IDs in `file_index`, resolve `@/` pseudo-refs in backfill entries
6. After all phases: call `rebase-dirty` on the bare repo
7. Optionally: delete the plan folder from dirty branch (cleanup)

---

## What to skip for now

- **Asset upload** — `@asset/` stripping is done in planning but upload phase is skipped
- **Rename detection** — same-content different-filename is treated as delete + create (safe, slightly wasteful)
- **Cross-connection ordering** — connections publish independently, no dependency ordering between them
- **Resumability** — can be added later; restart from the beginning for now
