# Routines: File-Defined Workflow Pipelines

## Overview

Routines bring GitLab-style pipelines to Scratch, letting users chain discrete actions (pull, sync, publish-plan, publish) into sequential workflows. Aimed at non-technical users, routines are defined as YAML files stored in the workbook's git repo and executed by the server.

### Why "Routines"?

The term "routine" is approachable for non-technical users. It conveys something that runs regularly and predictably — a set of steps that happen in order, like a morning routine.

## Design Principles

1. **Postgres is the source of truth; YAML is the editing format** — A routine definition is the verbatim YAML text of one `routines/<name>.yaml` file, stored as a `RoutineDefinition` row and parsed on every read (DEV-11399). The file path remains the routine's identity. `routines/*.yaml` in the workbook config git repo is only the one-time import source for workbooks that predate the table, plus a transitional one-way mirror. See [Storage and migration](#storage-and-migration).
2. **Minimal UI** — No visual workflow builder. Users edit routine files through Scratch's existing file editor. The UI shows which routines exist and their run status.
3. **Sequential execution** — Steps run one after another. If a step fails, the routine stops.
4. **One at a time** — A routine can only have one active run at a time.
5. **Reuse existing infrastructure** — Scheduling uses the existing `Schedule` table and `SchedulerService` with a new `ROUTINE` action type.

## Routine File Format

A routine file is identified by its path under `routines/` (e.g. `routines/daily-content-sync.yaml`); that path is what the API, the schedules, the run history and the CLI all key on. The text itself lives in Postgres (see [Storage and migration](#storage-and-migration)); while the transitional git mirror is on it is also written to `routines/` at the root of the workbook config repo — the same repo that already holds `syncs/` and `transformers/` — which is what `scratchmd` binaries older than DEV-12617 read. The current CLI never reads the config repo for routines: it pulls and pushes them over REST into `<workspace>/.scratch/routines/`. See [CLI Support](#cli-support).

```yaml
# routines/daily-content-sync.yaml
name: Daily Content Sync
steps:
  - action: pull
    folders:
      - /blog/posts
      - /blog/authors
  - action: sync
    sync: syn_0123456789
  - action: publish-plan
    folder: /blog/posts
  - action: publish
    folder: /blog/posts
```

### Fields


| Field     | Required | Description                                              |
| --------- | -------- | ------------------------------------------------------- |
| `name`    | Yes      | Human-readable label for the routine                    |
| `steps`   | Yes      | Ordered list of steps to execute                        |
| `comment` | No       | Optional note or comment to provide context or reminders |

> **Scheduling is not part of the routine file.** Following the GitLab pipeline model, the routine
> file defines _what_ runs; _when_ it runs is a separate schedule stored in the database (a `Schedule`
> row with action `ROUTINE`, keyed by the routine file path) and managed from the Schedules UI / API —
> not the YAML. A leftover `schedule:` key in an existing file is tolerated for backward compatibility
> but **ignored** (it surfaces a non-blocking deprecation warning). See DEV-10478.


### Step Fields


| Field        | Required | Description                                                                                          |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `action`     | Yes      | One of: `pull`, `sync`, `publish-plan`, `publish`                                                    |
| `name`       | No       | Optional. Human-readable label for the step                                                          |
| `folders`    | No       | **Pull steps only.** A list of target folder paths (e.g. `/blog/posts`) and/or DataFolderIds (dfd_*). If omitted, applies to all linked folders. Not valid on other actions. |
| `folder`     | No       | **Publish / publish-plan steps only.** A single target folder path (e.g. `/blog/posts`) OR DataFolderId (dfd_*). If omitted, applies to all folders. Not valid on pull steps (use `folders`). |
| `connection` | No       | Target connection name or ID (coa_*). If omitted, applies to all connections in the folder.          |
| `options`    | No       | Action-specific settings as a nested map (see [Step Options](#step-options)).                        |
| `comment`    | No       | Optional note or comment you can add to the step, to provide context                                 |

#### Step Options

`options` holds settings that only apply to a particular action. Keeping them in one nested map (rather than as new top-level fields) means new action options can be added without changing the step shape or adding a database column.

| Option     | Action | Description                                                                                        |
| ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| `fullPull` | `pull` | `true` forces a full re-pull. Omitted/`false` = the default incremental pull (the pull job auto-demotes to full on the first run or when the connector lacks incremental support). |

```yaml
steps:
  - action: pull
    folder: /blog/posts
    options:
      fullPull: true # force a full re-pull instead of the default incremental
```


### Available Actions


| Action         | Description                                                                | Maps to Job Type           |
| -------------- | -------------------------------------------------------------------------- | -------------------------- |
| `pull`         | Pull data from external service into Scratch                               | `pull-linked-folder-files` |
| `sync`         | Run a sync (transform/copy between folders)                                | `sync-data-folders`        |
| `publish-plan` | Build a publish plan (diff dirty vs main) for review; does **not** publish | `publish` (plan only)      |
| `publish`      | Build the plan **and** execute it, pushing approved changes to the service | `publish` (plan + run)     |


> **Note on publish actions.** There is no standalone `publish-plan` or `publish-run` job type. Both `publish-plan` and `publish` run as the single `publish` job (`JobType.Publish`); the only difference is the `runAfterPlan` flag the job carries, plus a synchronous pipeline-creation step in front of it. The user-facing action names are unchanged — only the under-the-hood mapping differs. See [Publishing: Plan vs. Run](#publishing-plan-vs-run).

### Validation Rules

- `name` must be a non-empty string
- `steps` must contain at least one step
- `action` must be one of the allowed action types
- `folders` (pull steps) is a list of one or more entries; each entry must be a valid POSIX path starting with `/` OR start with `dfd_`, and must resolve to a DataFolder in the workbook. All entries must resolve to folders in the **same connection** (a single pull job cannot span connections) — add a `connection:` or split into separate pull steps to satisfy this. `folder` is **not** valid on a pull step.
- `folder` (publish / publish-plan steps) must be a valid POSIX path starting with `/` OR start with `dfd_`; in either case it must resolve to a DataFolder in the workbook. `folders` is **not** valid on a publish step.
- Step `name`, if provided, must be unique inside the list of steps
- `options`, if provided, must contain only recognized keys, and each key must be valid for the step's action (e.g. `fullPull` is only valid on `pull` steps). Routine pulls are incremental by default; `options.fullPull: true` forces a full re-pull.
- File must have a `.yaml` or `.yml` extension

## Architecture

### Key Insight: The YAML text is the definition, and the file path is the key

The routine definition is the verbatim YAML text of one file, stored as a `RoutineDefinition` row (DEV-11399; originally the file lived only in git — see [Storage and migration](#storage-and-migration)). Nothing ever stores a parsed copy, and everything that refers to a routine does so by its file path. Around it the database stores:

1. **Schedule records** — a `Schedule` row with action type `ROUTINE` (keyed by the routine file path) tells the existing schedule evaluator when to fire. Schedules are created and edited directly through the Schedule API / UI, independently of the routine file (the file no longer carries a `schedule:` field).
2. **Execution history** — `RoutineRun` and `RoutineRunStep` records track what happened when a routine ran, with the steps snapshotted at trigger time.

The routine text stays authoritative for _what_ the routine does; the `Schedule` row is authoritative for _when_ it runs. The two are decoupled, so editing one never has to reconcile the other.

### Discovery: Reload Routines

The **Reload Routines** action reads every stored routine definition (running the one-time git import for a workbook that predates the table) and:

1. Parses and validates each YAML file
2. Returns the discovered routines, each joined with its `Schedule` row (if any) and latest-run summary

Reload no longer writes schedules from the YAML (schedules are managed through the Schedule API). It performs one referential cleanup: a `ROUTINE` `Schedule` whose routine file no longer exists is deleted as an orphan.

Future enhancement: automatically reload routines after git operations (pull, publish, commit).

### Data Model

```
┌─────────────────────────────────────────────────────┐
│  RoutineDefinition table (Postgres)                 │
│                                                     │
│  routines/daily-content-sync.yaml ─► YAML text, v3  │
│  routines/weekly-full-publish.yaml ─► YAML text, v1 │
└─────────────────────────────────────────────────────┘
        ▲                                   │
        │ one-time import                   │ one-way mirror (transitional,
        │ (routinesPendingGitImport)        │  ROUTINES_GIT_MIRROR_ENABLED)
        │                                   ▼
┌─────────────────────────────────────────────────────┐
│  Workbook config repo (routines/*.yaml)             │
└─────────────────────────────────────────────────────┘
        │
        │  "Reload Routines" parses every stored definition (discovery only)
        │
        ├─► Schedule table (existing) ── created/edited via the Schedule API/UI
        │     action: ROUTINE
        │     entityId: file path
        │
        └─► At trigger time, parses the stored YAML, creates:
              │
              RoutineRun ──► Execution history
                │
                └── RoutineRunStep ──► Per-step status
```

### Database Changes

**Existing `Schedule` table** — add a new `ROUTINE` action type. Only `ROUTINE` is new; the pull/publish/sync values already exist (the pull action has since been split into full/incremental and connection-wide variants):

```prisma
enum ScheduleAction {
  /// @deprecated Equivalent to FULL_PULL; retained for runtime tolerance until a cleanup migration drops it.
  PULL
  FULL_PULL
  INCREMENTAL_PULL
  CONNECTION_FULL_PULL          // entityId is a ConnectorAccountId; fans out to every linked table
  CONNECTION_INCREMENTAL_PULL   // entityId is a ConnectorAccountId; fans out to every linked table
  PUBLISH
  SYNC
  ROUTINE                       // NEW — triggers a routine run
}
```

For `ROUTINE` schedules, `entityId` stores the routine file path (e.g. `routines/daily-sync.yaml`). This is the key used to find and parse the YAML at trigger time.

**New tables** — execution history only:

```prisma
model RoutineRun {
  id        String   @id // RoutineRunId
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  workbook   Workbook @relation(fields: [workbookId], references: [id], onDelete: Cascade)
  workbookId String

  /// The routine file path, e.g. "routines/daily-sync.yaml"
  /// Stored here so run history is readable even if the file is later deleted.
  routineFilePath String

  /// The routine name at the time of this run (snapshot from YAML)
  routineName String

  /// "pending" | "running" | "completed" | "failed" | "cancelled"
  status String @default("pending")

  /// Which trigger started this run
  trigger String // "manual" | "schedule"

  /// User who triggered (null for schedule-triggered runs)
  triggeredByUserId String?

  startedAt  DateTime?
  finishedAt DateTime?

  /// Error message if the run failed
  error String?

  /// Index of the step currently executing (0-based)
  currentStepIndex Int @default(0)

  steps RoutineRunStep[]

  @@index([workbookId])
  @@index([routineFilePath])
  @@index([status])
}

model RoutineRunStep {
  id        String   @id // RoutineRunStepId
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  run   RoutineRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  runId String

  /// 0-based position in the routine's step list
  stepIndex Int

  /// The action type: "pull", "sync", "publish-plan", "publish"
  action String

  /// Target folder path for a single-folder action (publish / publish-plan). Null on pull steps.
  folder String?

  /// Target folder paths for a `pull` step (snapshot of the step's `folders:` list). Empty otherwise.
  folders String[]

  /// Target connection (if specified)
  connection String?

  /// Action-specific config snapshot from the step's `options:` map (e.g. `{ "fullPull": true }`).
  /// One JSON column so new per-action options don't each need a dedicated column. Null when none.
  options Json?

  /// "pending" | "running" | "completed" | "failed" | "skipped"
  status String @default("pending")

  startedAt  DateTime?
  finishedAt DateTime?

  /// Error message if this step failed
  error String?

  /// Reference to the DbJob created for this step (if applicable)
  jobId String?

  /// For publish-plan / publish steps: the PublishPlan pipeline created for this step.
  /// Lets a staged (plan-only) publish be located from run history. Null for other actions.
  pipelineId String?

  @@unique([runId, stepIndex])
  @@index([runId])
}
```

### Module Structure

```
server/src/routine/
├── routine.module.ts
├── routine.controller.ts           # REST endpoints
├── routine.service.ts              # Reload + trigger logic
├── routine-executor.service.ts     # Runs a routine (step-by-step)
├── routine-parser.service.ts       # YAML parsing + validation
├── routine.types.ts                # Type definitions
├── dto/
│   └── trigger-routine.dto.ts
└── __tests__/
    ├── routine-executor.service.spec.ts
    └── routine-parser.service.spec.ts
```

### Execution Flow

```
User clicks "Run"              Schedule fires (ROUTINE action)
       │                              │
       ▼                              ▼
  RoutineController          SchedulerService
       │                              │
       └──────────┬───────────────────┘
                  ▼
       RoutineService.triggerRun(workbookId, filePath)
                  │
                  ├─ Read YAML file from git repo
                  ├─ Parse and validate
                  ├─ Check: is this routine already running? → reject (409)
                  ├─ Create RoutineRun + RoutineRunStep records
                  └─ Start RoutineExecutorService.execute(runId)
                            │
                            ├─ For each step (sequential):
                            │   ├─ Update step status → "running"
                            │   ├─ Resolve action → job, enqueue via BullEnqueuerService
                            │   │   (publish actions create a pipeline first; see "Publishing: Plan vs. Run")
                            │   ├─ Wait for job completion (poll DbJob)
                            │   ├─ On success → step status "completed", next step
                            │   └─ On failure → step status "failed", run status "failed", stop
                            │
                            └─ All steps done → run status "completed"
```

### Publishing: Plan vs. Run

`publish-plan` and `publish` are **not** two job types — both run as a single `publish` job (`JobType.Publish`). The plan-only vs. plan-and-run distinction is the job's `runAfterPlan` flag, and each publish step is preceded by a synchronous pipeline-creation step. The executor handles a publish step in three calls, mirroring how `SchedulerService` fires a scheduled `PUBLISH`:

1. **Create the pipeline** — `PublishPlanBuildService.createPipeline(workbookId, userId, connectorAccountId)` creates a `PublishPlan` row (status `Planning`) and returns a `pipelineId`. The step's target `folder` is resolved to its `connectorAccountId` for this call (a folder without a `connectorAccountId` is not publishable — fail the step with a clear message).
2. **Enqueue the publish job** — `BullEnqueuerService.enqueuePlanPipelineJob(workbookId, actor, pipelineId, connectorAccountId, runAfterPlan, folderPath, …)`. The single `publish` job builds the plan (diff dirty vs main) and then branches on `runAfterPlan`:
  - `publish-plan` step → `runAfterPlan: false` → the job stops after planning, leaving the plan staged for the user to review and publish manually.
  - `publish` step → `runAfterPlan: true` → the job continues into `PublishPlanRunService.runPipeline(...)`, pushing approved changes to the external service.
3. **Link the job to the pipeline** — `PublishPlanBuildService.setActiveJob(pipelineId, jobId)`.

The resulting `publish` job id is stored on `RoutineRunStep.jobId` and polled for completion exactly like any other step. Consider also recording the `pipelineId` on the step (see [Database Changes](#database-changes)) so a `publish-plan` step's staged plan is discoverable from run history.

### Schedule Integration

A routine's schedule is a `Schedule` row (action `ROUTINE`, `entityId` = the routine file path), created and edited through the **generic Schedule CRUD** — `POST/PATCH/DELETE /workbooks/:id/schedules` — exactly like a pull/publish/sync schedule. The web client exposes this through a cron-picker in the routine panel (`RoutineScheduleModal`). The routine file is never involved:

```typescript
// Set a routine to run every weekday at 9am (client → generic schedule API)
await scheduleApi.create(workbookId, {
  name: routine.name,
  action: 'ROUTINE',
  entityId: 'routines/daily-content-sync.yaml', // the routine file path
  cronExpression: '0 9 * * 1-5',
});
// "Manual only" deletes the row; editing the frequency updates it.
```

`ScheduleService` applies two ROUTINE-specific guards on write: the `entityId` must be a well-formed `routines/*.yaml` path, and the interval must be ≥ 5 minutes (a stricter floor than the 1-minute generic floor, since a routine runs a heavier multi-step pipeline).

The existing `SchedulerService` already handles the cron evaluation loop, atomic claims, and multi-instance safety. For the `ROUTINE` action, instead of enqueuing a single job, it calls `RoutineService.triggerRun()`.

### Waiting for Job Completion

The executor needs to know when each step's job finishes.

**v1: Poll DbJob status.** Check every 5 seconds until the job reaches a terminal state. Timeout after 30 minutes per step (configurable).

**Future:** Subscribe to BullMQ job completion events for lower latency.

## REST API

```
POST   /workbooks/:workbookId/routines/reload                  Reload routines (reconcile schedules)
GET    /workbooks/:workbookId/routines                          List routines (parsed from the stored YAML)
POST   /workbooks/:workbookId/routines/trigger                  Trigger a manual run
GET    /workbooks/:workbookId/routine-runs                      List runs for a workbook
GET    /workbooks/:workbookId/routine-runs/:runId               Get run details (with steps)
POST   /workbooks/:workbookId/routine-runs/:runId/cancel        Cancel a running routine
GET    /cli/v1/workbooks/:workbookId/routines/files             Every routine file + version (+ content unless ?metadataOnly=true)
POST   /cli/v1/workbooks/:workbookId/routines/push              Batch create/edit/delete, guarded per file by baseVersion
```

### Notes

- `reload` reads the stored definitions and returns the list of routines (joined with schedule + latest-run state). It does not write schedules from the YAML; it only orphan-cleans `Schedule` rows whose routine file is gone.
- A routine's **schedule** is created/edited/removed through the generic schedule endpoints (`POST/PATCH/DELETE /workbooks/:id/schedules`) with `action: ROUTINE` and `entityId` = the routine file path — not through any routine endpoint.
- `GET /routines` parses the stored YAML on every request (it's small). Returns parsed routine definitions with schedule status and latest run info joined from the DB.
- `trigger` accepts `{ filePath: string, forceFullPull?: boolean }` in the body. Reads and parses the YAML, creates a `RoutineRun`, and begins execution. Returns 409 if the routine is already running. `forceFullPull: true` writes `options.fullPull: true` onto every pull step of that run's snapshot (the YAML is untouched) — how a Live Export with an incremental destination pull runs a one-off full sync (DEV-11407).
- `cancel` sets the run status to `cancelled` and stops execution after the current step finishes.

## Client UI

The new UI will be built only in the Scratch Web Client and will be guarded by hind the dev tools flag for now. 

NOTE: Scratch Desktop UI is out of scope for the initial implementation.

### Sidebar Section

A new **Routines** section in the workbook sidebar, alongside the existing **Syncs** section.

- Lists all routines by name (from YAML files)
- Shows status indicator per routine: idle, running (with progress), last run result (success/failure)
- Clicking a routine opens the YAML file in the file editor
- "Run" button to trigger a manual run
- "Reload" button to reload routines from git

### Run History

Accessible from the routine's sidebar entry or a detail panel:

- List of recent runs with timestamp, trigger type (manual/schedule), status, duration
- Expandable to see per-step status and errors
- Retained for 30 days

## Storage and migration

**Before DEV-11399** the YAML file in the config git repo *was* the definition: every list, edit and scheduled run did a git round-trip through scratch-git, and a routine only existed once its file was committed to `main`.

**Since DEV-11399** the definition is a `RoutineDefinition` row: `(workbookId, filePath)` unique, `content` = the verbatim YAML text, `version` = an optimistic-concurrency counter bumped on every content change, `source` = who last wrote it (`web` / `cli` / `generated` / `git-import`). Nothing stores a parsed copy — the server parses `content` on every read, so comments and formatting round-trip unchanged through the editor and the CLI, malformed files are still storable (they surface as `parseError`), and a parser change never needs a backfill. `RoutineDefinitionStoreService` (`server/src/routine/routine-definition-store.service.ts`) is the only code that touches the table or reads definitions from git.

**The git fallback is a one-shot import, not a perpetual fallback.** `Workbook.routinesPendingGitImport` is `true` for every workbook that existed when the table was added and `false` for new ones. The first routine read of a flagged workbook (list, get, trigger, scheduled run) copies `routines/*.yaml` into rows (`source: 'git-import'`; a row a user wrote meanwhile wins) and clears the flag. After that git is never consulted for definitions again — a perpetual "read git when the row is missing" would resurrect every deleted routine. The import throws rather than importing a partial set when scratch-git fails, because `reloadRoutines` orphan-cleans ROUTINE schedules against the list it gets and a partial list would delete live schedules. An **empty** listing clears the flag only after scratch-git confirms the repo exists (`/api/repo/manage/:id/exists`): scratch-git answers `[]` for a repo it does not have, and clearing the flag on that answer would silently lose every routine the real repo holds (locally this bites when two checkouts' scratch-git instances, each with its own `local/scratch-git-repos/`, take turns on port 3100). A workbook whose repo is missing keeps its flag and is reported separately by `routine-git-import`.

**Draining the long tail.** The admin code migration `routine-git-import` (`POST /code-migrations/run`) runs the same import over still-flagged workbooks in batches and reports `remainingCount`; when it holds at 0 the fallback code can be deleted.

**The transitional git mirror.** While `ROUTINES_GIT_MIRROR_ENABLED` (default on) every definition change is followed by a full-state one-way mirror of `routines/` into the config repo (`RoutineGitMirrorService`), so `scratchmd routines pull|status|push` binaries older than DEV-12617 keep working. Nothing reads it back — the REST-backed CLI (DEV-12617) doesn't either. Once the old binaries have aged out — the server's `Ignoring deprecated baseHead on routines push` warning stops appearing, since the new CLI never sends `baseHead` — flip the flag off and run the `routine-git-cleanup` code migration (refused while the mirror is on) to delete `routines/*.yaml` from git; history keeps the old copies.

**Workbook export/import.** The dev-tools workbook export (`DevToolsService.exportWorkbook`) carries every definition (`filePath`, `content`, `version`, `source`; DEV-12621), and import recreates them on the new workbook. The one edit import makes to the text is rewriting `coa_`/`dfd_`/`syn_` ids to the imported workbook's new ids, since steps can reference a connection, folder or sync by id; comments and formatting are otherwise untouched. `ROUTINE` schedules already travel and need no remap because they key on the file path. `RoutineRun` history does not travel, and imported definitions are not written to the transitional git mirror.

**Concurrency.** The CLI push carries a per-file `baseVersion` (the `version` it last pulled, or `null` for "expect new"); the whole push is applied in one transaction under a per-workbook advisory lock and refused with `409 blocked_stale` naming the stale files if any version disagrees. The pre-DEV-11399 `baseHead` git SHA is accepted and ignored (logged) — honouring it against the lagging mirror would produce false conflicts. The REST-backed CLI takes each `baseVersion` from its local manifest (see [CLI Support](#cli-support)).

## CLI Support

`scratchmd routines pull|status|push` (DEV-12617) work against the REST API, not the workbook config repo. The CLI edits routine files; it never runs them.

### Local layout

```
<workspace>/.scratch/
  routines/*.yaml        # local copy of every routine file; users edit these
  routines-state.json    # manifest, written only by the CLI
```

The manifest is `{ "formatVersion": 1, "workbookId": "wkb_…", "files": { "routines/<name>.yaml": { "version": n, "sha256": "<hex>" } } }`: per file, the server `version` last pulled or pushed and the SHA-256 of the exact bytes written or sent. Paths are server-relative everywhere (manifest keys, `--json`, API bodies) — `routines/<name>.yaml` lives at `.scratch/routines/<name>.yaml`. The manifest is the merge base for all three commands; a missing (or foreign-workbook) manifest is an empty base, so the first pull in a workspace made by an older CLI simply downloads everything.

### Commands

- **`workspaces init`** runs an initial pull, so `.scratch/routines/` and the manifest exist even with no connections and no routines; a failed initial pull only warns. The config-repo checkout (`.scratch/workspace/`) leaves `routines/` out, so the mirror's copy never lands on disk.
- **`routines pull [--discard-local]`** (`GET /cli/v1/workbooks/:id/routines/files`, with content) merges per file by **content hash** against the manifest: server-only changes are applied, local edits the server didn't touch are kept, identical changes on both sides are just recorded. It refuses — exit 1, nothing written — only when a file changed on both sides to different content; `--discard-local` resets every server-tracked file to the server's copy instead (local-only new files are never touched). Files are written atomically and the manifest last, so a crash leaves files ahead of the manifest and a re-run converges. Hashes rather than versions drive the merge because a delete→recreate restarts `version` at 1.
- **`routines push`** (`POST …/routines/push`) sends each local change with `baseVersion` = its manifest version (`null` for a new file — sent explicitly, since an omitted `baseVersion` disables the guard). The batch applies atomically or fails `409 blocked_stale` naming the stale files; the CLI exits 1 and asks for `routines pull`. On success only the pushed files' manifest entries are updated (the response lists every file, including others' changes this workspace hasn't pulled). If `.scratch/routines/` is missing while the manifest tracks files, push refuses rather than deleting every routine.
- **`routines status`** compares disk vs manifest hashes (local changes) and the metadata-only listing (`?metadataOnly=true`) vs manifest versions (remote changes). Read-only.

Unpushed edits an older CLI left in `.scratch/workspace/routines/` are detected (`git status` in that worktree, only when it is this workspace's linked config worktree) and surfaced: before the first REST-backed pull they block `pull` (unless `--discard-local`) and `push`; afterwards they only warn. This shim goes away with the mirror.

`.scratch/workspace/` (syncs, transformers, validators) is materialized from the config repo at `workspaces init` only; `routines pull|push` no longer touch it.

### Advanced routine support is out of scope for v1

The initial implementation treats the CLI purely as a place to **view and edit** routine files. Driving routines from the CLI — listing routines, triggering a manual run, watching run status, cancelling a run — would mean new CLI commands calling the [REST API](#rest-api) (`POST …/routines/trigger`, `GET …/routine-runs`, etc.). That is **explicitly deferred**: routines are server-executed and managed through the web UI for v1. The CLI gains routine-run commands only if later demand justifies them.

## Relationship to Existing Schedule System

The existing `Schedule` table and `SchedulerService` (in `server/src/schedule/`) handle per-entity scheduling for pull, publish, and sync. Routines reuse this infrastructure by adding a `ROUTINE` action type.

**v1: Coexistence.** Both standalone schedules and routine schedules run through the same evaluator. A sync can have its own schedule AND be a step in a routine.

**Future migration:** Replace standalone schedules with single-step routines. This unifies all automation under routines and gives users a single place to manage workflows.

## Implementation Phases

### Phase 1: Core — Routine Parsing & Reload

1. Add `ROUTINE` to `ScheduleAction` enum, run migration
2. Add `RoutineRun` and `RoutineRunStep` to Prisma schema, run migration
3. Create `routine-parser.service.ts` — YAML parsing, validation, type conversion
4. Create `routine.service.ts` — reload logic (read YAML from git; orphan-clean Schedule records)
5. Add `js-yaml` dependency (`yarn add js-yaml @types/js-yaml`)

### Phase 2: Execution Engine

1. Create `routine-executor.service.ts` — sequential step execution with job polling
2. Map routine actions to existing `BullEnqueuerService` methods
3. Add manual trigger endpoint + cancel endpoint
4. Wire up `RoutineRun` and `RoutineRunStep` status tracking

### Phase 3: Schedule Integration

1. Extend `SchedulerService` to handle `ROUTINE` action — call `RoutineService.triggerRun()` instead of enqueuing a single job
2. Test end-to-end: create a `ROUTINE` schedule via the schedule API → schedule fires → routine executes

### Phase 4: Client UI

1. Add Routines sidebar section to workbook UI
2. Routine list with status indicators and "Run" / "Reload" buttons
3. Run history panel with per-step detail
4. Wire up API calls

### Phase 5: Cleanup & Polish

1. Run history cleanup job (delete runs older than 30 days)
2. Workbook deletion cleanup (cascades handle `RoutineRun` via FK; application logic cleans up `Schedule` records with action `ROUTINE`)
3. Error handling and logging throughout

## Open Questions

1. **Step timeout** — 30 minutes per step is a reasonable default, but some publish operations on large folders could take longer. Should timeout be configurable per step?

- ANSWER: yes, we should support a configurable timeout for each step with an enforced maximum based on the action. For example, pull actions can have a longer timeout than sync actions.

1. **Folder resolution** — When a step specifies `folder: /blog/posts`, how do we resolve this to a `DataFolderId`? By exact path match in the workbook? What if the folder doesn't exist yet?

- ANSWER: yes, this should be the exact path in the workbook

1. **Sync resolution** — When a step specifies `action: sync`, how do we identify which sync to run? By folder? By sync name? Syncs currently have auto-generated names.

- ANSWER: this should use the Sync ID. We can provide tools to the user to easily get the ID

1. **Publish semantics** — Should `publish` as a routine step always include both plan + run? Or should the user explicitly list both `publish-plan` and `publish` steps? The explicit approach is more transparent.

- ANSWER: Start with two options: `publish` does both the plan and runs the publish. `publish-plan` will only run the plan, allowing the user to review an manually trigger the publish. Both map to the single `publish` job, distinguished by its `runAfterPlan` flag — see [Publishing: Plan vs. Run](#publishing-plan-vs-run).

1. **Routine file conflicts** — If two users edit the same routine file, git handles the merge. But if a routine is running when its definition changes, should the in-progress run use the old or new definition? (Current design: old — the YAML is read once at trigger time and snapshotted into the run.)

- ANSWER: use the old version.

## Step Execution Mechanism (BullMQ patterns)

The question of **how the executor waits for each step's job to finish** — and whether the "poll `DbJob` status every 5 s" loop described in [Waiting for Job Completion](#waiting-for-job-completion) is robust against hung runs — is evaluated in depth in a companion document:

**→ [Routines: Step Execution & BullMQ Job Orchestration](./routines-step-execution.md)**

In short: the proposed polling loop is the one coordinator in the system with no durable owner — if the instance running `execute()` restarts mid-run, the step's job still completes but nothing advances the `RoutineRun`, and (unlike `DbJob`s) nothing reaps it. Keeping each action as its own `DbJob` (as this design already does) rules out collapsing the routine into a single job, so that doc recommends modeling the routine as a **BullMQ flow of per-step jobs** — advancement lives durably in Redis rather than in one process's memory — reached via a durable event-driven orchestrator as the v1 stepping-stone. It also proposes a **self-planning publish job** so a publish step is enqueued as one self-contained `DbJob` like `pull` and `sync`. Read it before implementing [Phase 2](#phase-2-execution-engine).

