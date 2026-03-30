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
5. **Reuse existing infrastructure** — Scheduling uses the existing `Schedule` table and `ScheduleEvaluatorService` with a new `ROUTINE` action type.

## Routine File Format

Routine files live in `.scratch/routines/` within the workbook's git repo.

```yaml
# .scratch/routines/daily-content-sync.yaml
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

### Step Fields

| Field        | Required | Description                                                                   |
| ------------ | -------- | ----------------------------------------------------------------------------- |
| `action`     | Yes      | One of: `pull`, `sync`, `publish-plan`, `publish`                             |
| `folder`     | No       | Target folder path (e.g. `/blog/posts`). If omitted, applies to all folders.  |
| `connection` | No       | Target connection name. If omitted, applies to all connections in the folder. |

### Available Actions

| Action         | Description                                                   | Maps to Job Type           |
| -------------- | ------------------------------------------------------------- | -------------------------- |
| `pull`         | Pull data from external service into Scratch                  | `pull-linked-folder-files` |
| `sync`         | Run a sync (transform/copy between folders)                   | `sync-data-folders`        |
| `publish-plan` | Build a publish plan (diff dirty vs main)                     | `publish-plan`             |
| `publish`      | Execute the publish plan, pushing changes to external service | `publish-run`              |

### Validation Rules

- `name` must be a non-empty string
- `steps` must contain at least one step
- `action` must be one of the allowed action types
- `folder`, if provided, must be a valid POSIX path starting with `/`
- `schedule`, if provided, must be valid 5-field cron syntax with a minimum interval of 5 minutes
- File must have a `.yaml` or `.yml` extension

## Architecture

### Key Insight: No Routine Table

The YAML file is the routine definition. The database never stores the definition — it only stores:

1. **Schedule records** — for routines that have a `schedule:` field, a `Schedule` row with action type `ROUTINE` tells the existing schedule evaluator when to fire.
2. **Execution history** — `RoutineRun` and `RoutineRunStep` records track what happened when a routine ran.

This means there is no drift between "what the file says" and "what the database thinks." The file is always authoritative.

### Discovery: Reload Routines

The **Reload Routines** action reads all `.scratch/routines/*.yaml` files from the workbook's git repo and:

1. Parses and validates each YAML file
2. For routines with a `schedule:` field — upserts a `Schedule` record (action = `ROUTINE`, entityId = file path)
3. For routines whose `schedule:` field was removed — deletes the corresponding `Schedule` record
4. For routine files that were deleted — deletes the corresponding `Schedule` record

Future enhancement: automatically reload routines after git operations (pull, publish, commit).

### Data Model

```
┌─────────────────────────────────────────────────────┐
│  Git Repo (.scratch/routines/)                      │
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

**Existing `Schedule` table** — add a new action type:

```prisma
enum ScheduleAction {
  PULL
  PUBLISH
  SYNC
  ROUTINE  // NEW — triggers a routine run
}
```

For `ROUTINE` schedules, `entityId` stores the routine file path (e.g. `.scratch/routines/daily-sync.yaml`). This is the key used to find and parse the YAML at trigger time.

**New tables** — execution history only:

```prisma
model RoutineRun {
  id        String   @id // RoutineRunId
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  workbook   Workbook @relation(fields: [workbookId], references: [id], onDelete: Cascade)
  workbookId String

  /// The routine file path, e.g. ".scratch/routines/daily-sync.yaml"
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

  /// "pending" | "running" | "completed" | "failed" | "skipped"
  status String @default("pending")

  startedAt  DateTime?
  finishedAt DateTime?

  /// Error message if this step failed
  error String?

  /// Reference to the DbJob created for this step (if applicable)
  jobId String?

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
  RoutineController          ScheduleEvaluatorService
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
                            │   ├─ Map action to job type
                            │   ├─ Enqueue job via BullEnqueuerService
                            │   ├─ Wait for job completion (poll DbJob)
                            │   ├─ On success → step status "completed", next step
                            │   └─ On failure → step status "failed", run status "failed", stop
                            │
                            └─ All steps done → run status "completed"
```

### Schedule Integration

When `reload` finds a routine with a `schedule:` field, it upserts a `Schedule` record:

```typescript
// Pseudo-code in routine.service.ts
async reloadRoutines(workbookId: string) {
  const yamlFiles = await this.scratchGitService.listFiles(repoId, '.scratch/routines/');

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

The existing `ScheduleEvaluatorService` already handles the cron evaluation loop, atomic claims, and multi-instance safety. For `ROUTINE` action, instead of enqueuing a single job, it calls `RoutineService.triggerRun()`.

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

## Relationship to Existing Schedule System

The existing `Schedule` table and `ScheduleEvaluatorService` (from `schedule-system-design.md`) handle per-entity scheduling for pull, publish, and sync. Routines reuse this infrastructure by adding a `ROUTINE` action type.

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

6. Create `routine-executor.service.ts` — sequential step execution with job polling
7. Map routine actions to existing `BullEnqueuerService` methods
8. Add manual trigger endpoint + cancel endpoint
9. Wire up `RoutineRun` and `RoutineRunStep` status tracking

### Phase 3: Schedule Integration

10. Extend `ScheduleEvaluatorService` to handle `ROUTINE` action — call `RoutineService.triggerRun()` instead of enqueuing a single job
11. Test end-to-end: YAML with `schedule:` → reload → schedule fires → routine executes

### Phase 4: Client UI

12. Add Routines sidebar section to workbook UI
13. Routine list with status indicators and "Run" / "Reload" buttons
14. Run history panel with per-step detail
15. Wire up API calls

### Phase 5: Cleanup & Polish

16. Run history cleanup job (delete runs older than 30 days)
17. Workbook deletion cleanup (cascades handle `RoutineRun` via FK; application logic cleans up `Schedule` records with action `ROUTINE`)
18. Error handling and logging throughout

## Open Questions

1. **Step timeout** — 30 minutes per step is a reasonable default, but some publish operations on large folders could take longer. Should timeout be configurable per step?
2. **Folder resolution** — When a step specifies `folder: /blog/posts`, how do we resolve this to a `DataFolderId`? By exact path match in the workbook? What if the folder doesn't exist yet?
3. **Sync resolution** — When a step specifies `action: sync`, how do we identify which sync to run? By folder? By sync name? Syncs currently have auto-generated names.
4. **Publish semantics** — Should `publish` as a routine step always include both plan + run? Or should the user explicitly list both `publish-plan` and `publish` steps? The explicit approach is more transparent.
5. **Notification (future)** — When we add notifications, should they be per-routine or per-workbook? Email, in-app, or webhook?
6. **Routine file conflicts** — If two users edit the same routine file, git handles the merge. But if a routine is running when its definition changes, should the in-progress run use the old or new definition? (Current design: old — the YAML is read once at trigger time and snapshotted into the run.)
