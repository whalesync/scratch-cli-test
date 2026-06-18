# Routines: File-Defined Workflow Pipelines

## Overview

Routines bring GitLab-style pipelines to Scratch, letting users chain discrete actions (pull, sync, publish-plan, publish) into sequential workflows. Aimed at non-technical users, routines are defined as YAML files stored in the workbook's git repo and executed by the server.

### Why "Routines"?

The term "routine" is approachable for non-technical users. It conveys something that runs regularly and predictably — a set of steps that happen in order, like a morning routine.

## Design Principles

1. **Git is the source of truth** — Routine definitions are YAML files in the git repo. The database stores only execution history and schedule pointers — never the routine definition itself.
2. **Minimal UI** — No visual workflow builder. Users edit routine files through Scratch's existing file editor. The UI shows which routines exist and their run status.
3. **Sequential execution** — Steps run one after another. If a step fails, the routine stops.
4. **One at a time** — A routine can only have one active run at a time.
5. **Reuse existing infrastructure** — Scheduling uses the existing `Schedule` table and `SchedulerService` with a new `ROUTINE` action type.

## Routine File Format

Routine files live in `routines/` at the root of the workbook config repo — the same repo that already holds `syncs/` and `transformers/`. They are deliberately **not** stored under `.scratch/`: the CLI's config-repo checkout excludes that path, which would hide routines from local workspaces. See [CLI Support](#cli-support).

```yaml
# routines/daily-content-sync.yaml
name: Daily Content Sync
schedule: "0 9 * * MON-FRI" # optional, 5-field cron expression
steps:
  - action: pull
    folder: /blog/posts
  - action: sync
    folder: /blog/posts
  - action: publish-plan
    folder: /blog/posts
  - action: publish
    folder: /blog/posts
```

### Fields


| Field      | Required | Description                                                    |
| ---------- | -------- | -------------------------------------------------------------- |
| `name`     | Yes      | Human-readable label for the routine                           |
| `schedule` | No       | Cron expression (5-field). If omitted, routine is manual-only. |
| `steps`    | Yes      | Ordered list of steps to execute                               |
| `comment`  | No       | Optional note or comment to provide context or reminders       |


### Step Fields


| Field        | Required | Description                                                                                          |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `action`     | Yes      | One of: `pull`, `sync`, `publish-plan`, `publish`                                                    |
| `name`       | No       | Optional. Human-readable label for the step                                                          |
| `folder`     | No       | Target folder path (e.g. `/blog/posts`) OR DataFolderId (dfd_*). If omitted, applies to all folders. |
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
- `folder`, if provided, must be a valid POSIX path starting with `/` OR if it starts with `dfd`_. In either case the folder must resolve to a DataFolder in the workbook
- `schedule`, if provided, must be valid 5-field cron syntax with a minimum interval of 5 minutes
- Step `name`, if provided, must be unique inside the list of steps
- `options`, if provided, must contain only recognized keys, and each key must be valid for the step's action (e.g. `fullPull` is only valid on `pull` steps). Routine pulls are incremental by default; `options.fullPull: true` forces a full re-pull.
- File must have a `.yaml` or `.yml` extension

## Architecture

### Key Insight: No Routine Table

The YAML file is the routine definition. The database never stores the definition — it only stores:

1. **Schedule records** — for routines that have a `schedule:` field, a `Schedule` row with action type `ROUTINE` tells the existing schedule evaluator when to fire.
2. **Execution history** — `RoutineRun` and `RoutineRunStep` records track what happened when a routine ran.

This means there is no drift between "what the file says" and "what the database thinks." The file is always authoritative.

### Discovery: Reload Routines

The **Reload Routines** action reads all `routines/*.yaml` files from the workbook config repo and:

1. Parses and validates each YAML file
2. For routines with a `schedule:` field — upserts a `Schedule` record (action = `ROUTINE`, entityId = file path)
3. For routines whose `schedule:` field was removed — deletes the corresponding `Schedule` record
4. For routine files that were deleted — deletes the corresponding `Schedule` record

Future enhancement: automatically reload routines after git operations (pull, publish, commit).

### Data Model

```
┌─────────────────────────────────────────────────────┐
│  Workbook config repo (routines/)                   │
│                                                     │
│  daily-content-sync.yaml ─► Routine definition      │
│  weekly-full-publish.yaml ─► Routine definition     │
└─────────────────────────────────────────────────────┘
        │
        │  "Reload Routines" reads YAML files
        │
        ├─► Schedule table (existing) ── only for routines with schedule: field
        │     action: ROUTINE
        │     entityId: file path
        │
        └─► At trigger time, reads YAML from git, creates:
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

  /// Target folder path (if specified)
  folder String?

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

When `reload` finds a routine with a `schedule:` field, it upserts a `Schedule` record:

```typescript
// Pseudo-code in routine.service.ts
async reloadRoutines(workbookId: string) {
  const yamlFiles = await this.scratchGitService.listFiles(repoId, 'routines/');

  for (const file of yamlFiles) {
    const content = await this.scratchGitService.readFile(repoId, file.path);
    const routine = this.routineParser.parse(content);

    if (routine.schedule) {
      await this.scheduleService.upsert({
        workbookId,
        action: 'ROUTINE',
        entityId: file.path,       // file path is the identifier
        name: routine.name,
        cronExpression: routine.schedule,
        enabled: true,
      });
    } else {
      // Remove schedule if it existed before
      await this.scheduleService.deleteByEntity(workbookId, 'ROUTINE', file.path);
    }
  }

  // Clean up schedules for deleted routine files
  await this.scheduleService.deleteOrphanedRoutineSchedules(workbookId, yamlFiles.map(f => f.path));
}
```

The existing `SchedulerService` already handles the cron evaluation loop, atomic claims, and multi-instance safety. For `ROUTINE` action, instead of enqueuing a single job, it calls `RoutineService.triggerRun()`.

### Waiting for Job Completion

The executor needs to know when each step's job finishes.

**v1: Poll DbJob status.** Check every 5 seconds until the job reaches a terminal state. Timeout after 30 minutes per step (configurable).

**Future:** Subscribe to BullMQ job completion events for lower latency.

## REST API

```
POST   /workbooks/:workbookId/routines/reload                  Reload routines from git repo
GET    /workbooks/:workbookId/routines                          List routines (reads YAML files)
POST   /workbooks/:workbookId/routines/trigger                  Trigger a manual run
GET    /workbooks/:workbookId/routine-runs                      List runs for a workbook
GET    /workbooks/:workbookId/routine-runs/:runId               Get run details (with steps)
POST   /workbooks/:workbookId/routine-runs/:runId/cancel        Cancel a running routine
```

### Notes

- `reload` reads the git repo and syncs `Schedule` records for routines with schedules. Returns the list of discovered routines.
- `GET /routines` reads YAML files from git on every request (they're small). Returns parsed routine definitions with schedule status and latest run info joined from the DB.
- `trigger` accepts `{ filePath: string }` in the body. Reads and parses the YAML, creates a `RoutineRun`, and begins execution. Returns 409 if the routine is already running.
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

## CLI Support

The `scratchmd` CLI needs **no new code** to make routine files available locally — storing them at `routines/` (config-repo root) is precisely what makes that work. This section explains the materialization path and what is intentionally deferred.

### How routine files reach the local workspace

Routine files ride along with the workbook config repo, exactly like `syncs/` and `transformers/`:

1. At `scratchmd workspaces init`, the CLI clones the workbook config repo (bare) and checks it out into `<workspace>/.scratch/workspace/`.
2. That checkout is a **sparse worktree** whose pattern is `/*` minus `.scratch` — i.e. *everything at the repo root except a `.scratch/` directory* (`setup_sparse_worktree` in [scratch-git-2/src/cli/git_ops/local.rs](/scratch-git-2/src/cli/git_ops/local.rs)).
3. Because `routines/` lives at the repo root (not under `.scratch/`), it is included by `/*` and materializes to `<workspace>/.scratch/workspace/routines/*.yaml`, right next to `syncs/` and `transformers/`. The user reads and edits routine YAML through the same flow they already use for those files.

> **This is the entire reason routines are stored at `routines/` and not `.scratch/routines/`.** Under `.scratch/`, the bare clone would still fetch the objects, but the sparse checkout would exclude them and they would never appear in the user's workspace. The server is unaffected either way — it reads YAML directly from the bare repo's git tree (via the git service), never from a materialized worktree.

### ⚠️ No incremental pull of the config repo

The CLI materializes the workbook config repo **only at `workspaces init`** (and on `workspaces init --force`, which re-clones). There is currently **no incremental pull that refreshes the config repo** — `scratchmd files download` operates on per-connection record repos, not the config repo. Consequences:

- A routine added or edited on the server (or by another user) will **not** appear in an already-initialized local workspace until it is re-initialized.
- Locally edited routine YAML has no dedicated push-back command; it round-trips only through git plumbing the user runs by hand.

Keeping local routines in sync on an ongoing basis would be **new CLI work** (an incremental config-repo fetch + re-materialize) and is independent of the storage-path decision above.

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
4. Create `routine.service.ts` — reload logic (read YAML from git, upsert/delete Schedule records)
5. Add `js-yaml` dependency (`yarn add js-yaml @types/js-yaml`)

### Phase 2: Execution Engine

1. Create `routine-executor.service.ts` — sequential step execution with job polling
2. Map routine actions to existing `BullEnqueuerService` methods
3. Add manual trigger endpoint + cancel endpoint
4. Wire up `RoutineRun` and `RoutineRunStep` status tracking

### Phase 3: Schedule Integration

1. Extend `SchedulerService` to handle `ROUTINE` action — call `RoutineService.triggerRun()` instead of enqueuing a single job
2. Test end-to-end: YAML with `schedule:` → reload → schedule fires → routine executes

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

