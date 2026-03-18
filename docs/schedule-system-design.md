# Schedule System Design: Pull, Push & Sync Jobs

## Context

Today, pull, push (publish), and sync jobs are triggered exclusively via manual REST API calls. There is no way for users to set up recurring schedules (e.g. "pull from Airtable every 15 minutes"). This document describes a system for user-defined schedules that trigger these jobs automatically, with proper concurrency control and debouncing.

### Existing Infrastructure

- **Cron service** (`server/src/cron/`) — Uses `@nestjs/schedule`, loads when `SERVICE_TYPE=cron` or `monolith`. Currently has only a placeholder `ExampleCronService`.
- **Worker/enqueuer** (`server/src/worker-enqueuer/`, `server/src/worker/`) — BullMQ + Redis queue with concurrency of 2. Jobs are persisted in the `DbJob` table alongside BullMQ entries.
- **Lock mechanism** — DataFolder has a `lock` column (string, nullable) set to `'pull'` or `'publish'` while a job is in progress for that folder.
- **Job types** — `pull-linked-folder-files`, `publish-data-folder`, `sync-data-folders`, `publish-plan`, `publish-run`.

## Database Schema

### `Schedule` Table

```prisma
model Schedule {
  id        String   @id // ScheduleId
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  workbook   Workbook @relation(fields: [workbookId], references: [id], onDelete: Cascade)
  workbookId String

  /// The organization that owns this schedule. Primary owner — deleting
  /// the org cascades to its schedules.
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  organizationId String

  /// The user who created this schedule. Combined with organizationId to
  /// construct the Actor when enqueuing jobs. SetNull on delete so the
  /// schedule keeps running under the org even if the user is removed.
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)
  userId String?

  /// Human-readable label, e.g. "Hourly Airtable pull"
  name String

  /// The operation to perform: "pull", "publish", or "sync"
  action ScheduleAction

  /// Generic reference to the target entity.
  /// - PULL / PUBLISH → DataFolderId (one schedule per folder)
  /// - SYNC → SyncId
  /// No foreign key constraint — validated at the application level so a
  /// single column can reference either table.
  entityId String

  /// Cron expression (standard 5-field: minute hour dom month dow).
  /// Examples: "*/15 * * * *" (every 15 min), "0 9 * * 1-5" (weekdays 9am)
  cronExpression String

  /// Whether this schedule is active. Disabled schedules are not evaluated.
  enabled Boolean @default(true)

  /// The last time this schedule fired (successfully enqueued a job).
  lastTriggeredAt DateTime?

  /// The next calculated fire time. Updated after each trigger or when
  /// the cron expression changes. Used by the polling loop.
  nextRunAt DateTime?

  @@unique([workbookId, action, entityId]) // One schedule per action+entity
  @@index([workbookId])
  @@index([enabled, nextRunAt])
  @@index([entityId])
}

enum ScheduleAction {
  PULL
  PUBLISH
  SYNC
}
```

### Entity ID Mapping

Each schedule targets exactly one entity via `entityId`. The interpretation depends on `action`:

| Action    | `entityId` references | Example                              |
| --------- | --------------------- | ------------------------------------ |
| `PULL`    | `DataFolder.id`       | Pull one linked folder on a schedule |
| `PUBLISH` | `DataFolder.id`       | Publish one folder on a schedule     |
| `SYNC`    | `Sync.id`             | Run one sync on a schedule           |

**Why no FK constraint?** A single column references either the `DataFolder` or `Sync` table depending on the action. Application-level validation on create/update ensures the referenced entity exists and belongs to the workbook. If the entity is deleted, the `Schedule` should be cleaned up via application logic (or a periodic sweep).

**Why one entity per schedule?** This keeps the model simple and composable. To schedule a pull for 3 folders, create 3 schedules — they can share the same cron expression. This also gives per-entity concurrency control and debouncing for free.

**Unique constraint** — `@@unique([workbookId, action, entityId])` prevents duplicate schedules for the same action on the same entity.

## Architecture

### Where It Runs

The schedule evaluator runs inside the **cron** (or **monolith**) microservice, alongside the existing `@nestjs/schedule` infrastructure. It does **not** run inside the worker service.

```
┌─────────────────────────────────────────────────┐
│  CRON / MONOLITH service                        │
│                                                 │
│  ScheduleEvaluatorService                       │
│    @Cron(EVERY_MINUTE)  ──► evaluateSchedules() │
│         │                                       │
│         ├─ Query due schedules from DB           │
│         ├─ Check concurrency locks               │
│         ├─ Debounce duplicate triggers           │
│         └─ Enqueue jobs via BullEnqueuerService  │
│                                                 │
│  ScheduleCrudService                            │
│    create / update / delete / list               │
└─────────────────────────────────────────────────┘
          │
          ▼ (BullMQ / Redis)
┌─────────────────────┐
│  WORKER service     │
│  (processes jobs)   │
└─────────────────────┘
```

### Module Structure

```
server/src/schedule/
├── schedule.module.ts
├── schedule.controller.ts        # REST API
├── schedule.service.ts           # CRUD operations
├── schedule-evaluator.service.ts # Cron-based trigger loop
├── schedule.types.ts             # Config types, constants
├── dto/
│   ├── create-schedule.dto.ts
│   └── update-schedule.dto.ts
└── __tests__/
    ├── schedule.service.spec.ts
    └── schedule-evaluator.service.spec.ts
```

**Module registration:**

- `ScheduleModule` is always imported in `AppModule` (CRUD endpoints needed for the API).
- `ScheduleEvaluatorService` is conditionally registered only when `isCronService()` is true, following the existing pattern.

```typescript
// schedule.module.ts
@Module({
  imports: [
    DbModule,
    ScratchConfigModule,
    WorkerEnqueuerModule,
    JobModule,
    WorkbookModule,
  ],
  controllers: [ScheduleController],
  providers: [
    ScheduleService,
    // Only register evaluator on cron/monolith
    ...(ScratchConfigService.isCronService() ? [ScheduleEvaluatorService] : []),
  ],
  exports: [ScheduleService],
})
export class ScheduleModule {}
```

## Schedule Evaluation Loop

The evaluator runs every minute via `@Cron(CronExpression.EVERY_MINUTE)`.

### Algorithm

```
Every minute:
  1. SELECT schedules WHERE enabled = true AND nextRunAt <= NOW()
  2. For each due schedule:
     a. Check entity-level concurrency (is the target DataFolder/Sync busy?)
     b. Check recency debounce (was a job for this entity created in the last 60s?)
     c. If locked or debounced → skip, do NOT update nextRunAt (retry next minute)
     d. If clear → atomically claim schedule + enqueue the job
     e. UPDATE schedule SET lastTriggeredAt = NOW(), nextRunAt = <next cron tick>
  3. Log summary: "Evaluated N schedules, triggered M, skipped K (busy/debounced)"
```

### Computing `nextRunAt`

Use a cron-parsing library (e.g. `cron-parser`) to compute the next occurrence from the cron expression. `nextRunAt` is updated:

- On schedule creation
- On schedule update (cron expression change)
- After each successful trigger
- After each skip due to lock (advance to next tick so we don't re-fire the same missed window repeatedly — the debounce logic below handles rapid retries)

### Multi-Instance Safety

If multiple cron instances run (e.g. during rolling deploys), use an **atomic claim** pattern to prevent double-firing:

```sql
UPDATE "Schedule"
SET "lastTriggeredAt" = NOW(),
    "nextRunAt" = $nextRunAt
WHERE "id" = $id
  AND "nextRunAt" <= NOW()
RETURNING *;
```

If the `UPDATE` returns 0 rows, another instance already claimed it. This is a lightweight alternative to distributed locks.

## Concurrency Control

### Requirement

Pull, push, and sync jobs must not run concurrently for the same entity. Since each schedule targets a single DataFolder or Sync, the lock check is naturally scoped to that entity.

### Approach: Entity-Level Lock Check

Before enqueuing, the evaluator checks whether the target entity already has an active job.

**For PULL / PUBLISH** (entityId = DataFolderId):

```typescript
async isDataFolderBusy(dataFolderId: string): Promise<boolean> {
  // Check the folder's lock column
  const folder = await this.db.client.dataFolder.findUnique({
    where: { id: dataFolderId },
    select: { lock: true },
  });
  if (folder?.lock) return true;

  // Also check DbJob for active jobs targeting this folder
  const activeJobs = await this.db.client.dbJob.count({
    where: {
      dataFolderId,
      status: { in: ['created', 'active'] },
    },
  });
  return activeJobs > 0;
}
```

**For SYNC** (entityId = SyncId):

Sync jobs don't have a single `dataFolderId` on the DbJob — they reference a sync which spans multiple folders. Check by matching the sync ID in the job data:

```typescript
async isSyncBusy(syncId: string): Promise<boolean> {
  const activeJob = await this.db.client.dbJob.findFirst({
    where: {
      type: 'sync-data-folders',
      status: { in: ['created', 'active'] },
      // syncId is stored inside the JSON data column
      data: { path: ['syncId'], equals: syncId },
    },
  });
  return activeJob !== null;
}
```

If busy, the schedule is skipped for this cycle and retried the next minute.

### Workbook-Level Guard (Optional)

As an additional safety net, the evaluator can also check for any active jobs on the workbook before enqueuing. This prevents scenarios where a pull on folder A conflicts with a sync that writes to folder A (since the sync's target folders aren't always obvious from the schedule alone).

```typescript
async isWorkbookBusy(workbookId: string): Promise<boolean> {
  const activeJobs = await this.db.client.dbJob.count({
    where: {
      workbookId,
      status: { in: ['created', 'active'] },
    },
  });
  return activeJobs > 0;
}
```

This can be enabled as a conservative default and relaxed later as we gain confidence in the entity-level checks.

## Debouncing

### Problem

If a schedule fires every minute but a job takes 5 minutes, we don't want 5 queued copies. Also, if a user manually triggers a pull and a schedule fires at the same time, we should not duplicate.

### Approach

Debouncing is handled by two mechanisms working together:

1. **Concurrency lock check** (above) — If a job is already running for this workbook, skip. This prevents queue buildup.

2. **Recency check** — Before enqueuing, check if a job of the same type was recently created for the same entity:

```typescript
async wasRecentlyTriggered(
  schedule: Schedule,
  windowMs: number = 60_000, // 1 minute default
): Promise<boolean> {
  const jobType = actionToJobType(schedule.action);
  const cutoff = new Date(Date.now() - windowMs);

  if (schedule.action === 'SYNC') {
    // For sync, check by matching syncId in the job data
    const recentJob = await this.db.client.dbJob.findFirst({
      where: {
        workbookId: schedule.workbookId,
        type: jobType,
        createdAt: { gte: cutoff },
        data: { path: ['syncId'], equals: schedule.entityId },
      },
    });
    return recentJob !== null;
  }

  // For pull/publish, check by dataFolderId
  const recentJob = await this.db.client.dbJob.findFirst({
    where: {
      dataFolderId: schedule.entityId,
      type: jobType,
      createdAt: { gte: cutoff },
    },
  });
  return recentJob !== null;
}
```

This catches the case where a manual trigger just happened for the same entity, preventing the scheduled trigger from enqueuing a duplicate.

### Debounce Window

The debounce window should be at least the schedule's minimum interval. A sensible default is **60 seconds** (matching the evaluation frequency). This means: if a job of the same type was created for this entity in the last 60 seconds (by any source — manual or schedule), skip.

## REST API

```
POST   /workbooks/:workbookId/schedules          Create a schedule
GET    /workbooks/:workbookId/schedules          List schedules for workbook
GET    /workbooks/:workbookId/schedules/:id      Get schedule by ID
PATCH  /workbooks/:workbookId/schedules/:id      Update schedule
DELETE /workbooks/:workbookId/schedules/:id      Delete schedule
```

### Create Schedule DTO

```typescript
class CreateScheduleDto {
  @IsString()
  name?: string;

  @IsEnum(ScheduleAction)
  action?: ScheduleAction;

  @IsString()
  entityId?: string;

  @IsString()
  cronExpression?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

type ValidatedCreateScheduleDto = Required<
  Pick<CreateScheduleDto, "name" | "action" | "entityId" | "cronExpression">
> &
  CreateScheduleDto;
```

**Validation on create/update:**

- Verify `entityId` references a valid DataFolder (for PULL/PUBLISH) or Sync (for SYNC)
- Verify the referenced entity belongs to the workbook in the URL path
- For PULL: verify the DataFolder has a `connectorAccountId` (is a linked folder)

### Cron Expression Validation

Validate `cronExpression` on create/update:

- Must be valid 5-field cron syntax
- Minimum interval: **5 minutes** (prevent overly aggressive schedules)
- Use `cron-parser` to validate and compute next run time

### Preset Intervals

The client can offer preset friendly options that map to cron expressions:

- Every 5 minutes: `*/5 * * * *`
- Every 15 minutes: `*/15 * * * *`
- Every hour: `0 * * * *`
- Every 6 hours: `0 */6 * * *`
- Daily at midnight: `0 0 * * *`

## Action-to-Job Mapping

```typescript
function actionToJobType(action: ScheduleAction): string {
  switch (action) {
    case "PULL":
      return "pull-linked-folder-files";
    case "PUBLISH":
      return "publish-data-folder";
    case "SYNC":
      return "sync-data-folders";
  }
}
```

When enqueuing, the evaluator calls the same `BullEnqueuerService` methods used by the manual API:

- `PULL` → `enqueuePullLinkedFolderFilesJob(workbookId, actor, entityId as DataFolderId)`
- `PUBLISH` → `enqueuePublishDataFolderJob(workbookId, actor, [entityId as DataFolderId])`
- `SYNC` → `enqueueSyncDataFoldersJob(workbookId, entityId as SyncId, actor)`

The schedule's `organizationId` and `userId` are used to construct the `Actor` (`{ userId, organizationId }`). If `userId` is null (user was deleted), the evaluator falls back to the organization's owner or a system actor for that org. This ensures schedules keep running even after the creating user is removed.

## Implementation Steps

### Phase 1: Core Infrastructure

1. Add `Schedule` and `ScheduleAction` to Prisma schema, run migration
2. Create `schedule` module with CRUD service + controller + DTOs
3. Add `cron-parser` dependency (`yarn add cron-parser`)

### Phase 2: Evaluation Loop

4. Create `ScheduleEvaluatorService` with `@Cron(EVERY_MINUTE)` trigger
5. Implement workbook-level concurrency check
6. Implement recency-based debounce
7. Implement atomic claim for multi-instance safety
8. Wire evaluator into `ScheduleModule` (conditional on `isCronService()`)

### Phase 3: API & Client

9. Add REST endpoints + auth guards
10. Client UI for creating/managing schedules (out of scope for this doc)

### Phase 4: Enhancements (Future)

11. Schedule execution history / audit log
12. Webhook-triggered schedules (not cron, but event-driven)
13. Per-schedule error tracking and auto-disable after N failures
14. Cascade cleanup when a DataFolder or Sync is deleted (delete associated schedules)

## Open Questions

1. **Minimum interval** — Is 5 minutes aggressive enough, or should the floor be higher (e.g. 15 minutes) to protect connector API rate limits?
2. **Auto-disable on failure** — Should schedules be automatically disabled after N consecutive failures? If so, what's N?
3. **Schedule limits** — Should there be a maximum number of schedules per workbook or per organization? Tied to billing plan?
4. **Timezone** — Should cron expressions be evaluated in UTC or the user's timezone? UTC is simpler; user timezone requires storing a `timezone` field.
