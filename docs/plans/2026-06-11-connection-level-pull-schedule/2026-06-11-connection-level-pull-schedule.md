# Connection-level pull schedule (DEV-10396)

**Date**: 2026-06-11
**Status**: In Progress (implemented; pending review/merge)
**Author**: Curtis Fonger
**Linear**: [DEV-10396](https://linear.app/whalesync/issue/DEV-10396/set-pull-schedule-on-the-entire-connection)

## Problem

Today a pull schedule is set per **table** (DataFolder) via `PullScheduleModal`
("Define how often Scratch automatically pulls data from `<Service>` for this
table."). With many tables this is tedious. We want the same capability on the
**connection** (ConnectorAccount), with a dialog offering two mutually-exclusive
groups:

- Set a pull schedule for the **entire connection** (one schedule covering all of
  the connection's current and future tables), **OR**
- Set a pull schedule for **each individual table** (the existing per-table
  controls, surfaced together in this one dialog).

The connector-level (workbook-wide) schedule was explicitly deferred in the
incremental-polling follow-up (`docs/plans/resolved/2026-05-16-incremental-polling-followup/2026-05-16-incremental-polling-followup.md`,
"Out of scope"). This plan implements it.

## Approach: a first-class connection schedule (not save-time fan-out)

A connection schedule is a **single `Schedule` row** whose `entityId` is the
`ConnectorAccountId` and whose `action` is a new `CONNECTION_FULL_PULL` /
`CONNECTION_INCREMENTAL_PULL`. When it fires, the scheduler looks up every linked
DataFolder in that connection and enqueues one `PullLinkedFolderFiles` job for the
whole set — exactly what the existing "Pull All Tables" menu action does, but on a
cron.

Why this over creating N per-table schedules at save time:

- **Captures intent** — "schedule the whole connection" stays true; tables added
  later are automatically covered with no extra config.
- **Matches the issue's "OR"** — connection vs per-table are genuinely distinct
  rows, not a duplicated fan-out that drifts.
- **No bulk churn** — one row to create/update/delete instead of one-per-table.
- **Reuses the existing pull path** — `enqueuePullLinkedFolderFilesJob` already
  accepts an array of DataFolderIds.

The existing `@@unique([workbookId, action, entityId])` keeps connection rows
(`action=CONNECTION_*`, `entityId=connectorAccountId`) distinct from table rows
(`action=FULL_PULL`, `entityId=dataFolderId`) with no conflict.

### Mutual exclusivity ("OR")

To honor the "OR" and avoid double-pulling the same table, the dialog is a radio
between the two modes, and **saving one mode clears the other** for that
connection:

- Save in **entire-connection** mode → upsert the connection's
  `CONNECTION_FULL_PULL` / `CONNECTION_INCREMENTAL_PULL` rows, and delete any
  per-table `PULL` / `FULL_PULL` / `INCREMENTAL_PULL` rows for tables in this
  connection.
- Save in **each-table** mode → upsert the per-table rows, and delete the
  connection-level rows.

The dialog states this inline ("Scheduling the whole connection replaces any
per-table pull schedules.") so the user is in control before saving. The initial
mode is inferred: if a connection-level schedule exists → entire-connection; else
→ each-table.

> Per-table publish/sync schedules are untouched — only pull-type schedules are
> cleared, since only those overlap.

## Server changes

1. **Enum + migration**
   - `packages/shared-types/src/enums/enums.ts`: add `CONNECTION_FULL_PULL`,
     `CONNECTION_INCREMENTAL_PULL` to `ScheduleAction`.
   - `server/prisma/schema.prisma`: add the two values to the `ScheduleAction`
     enum.
   - New migration `…_connection_pull_schedule_actions/migration.sql`:
     `ALTER TYPE "ScheduleAction" ADD VALUE 'CONNECTION_FULL_PULL';` /
     `… 'CONNECTION_INCREMENTAL_PULL';` (mirrors
     `20260514223400_new_scheduler_actions`).

2. **`server/src/schedule/schedule.types.ts`**
   - `SCHEDULE_ACTION_TO_JOB_TYPE`: map both new actions →
     `JobType.PullLinkedFolderFiles`.
   - Add `isConnectionPullAction(action)`.
   - `scheduleActionToPullMode`: `CONNECTION_FULL_PULL → 'full'`,
     `CONNECTION_INCREMENTAL_PULL → 'incremental'`.

3. **`server/src/schedule/schedule.service.ts`**
   - `validateEntityId`: for connection pull actions, assert `entityId` is a
     `ConnectorAccount` in the workbook (no per-table connectorAccountId check;
     incremental support is not hard-blocked — it demotes per folder at job time,
     consistent with per-table behavior today).
   - `entityExists`: for connection pull actions, check the ConnectorAccount still
     exists (so a deleted connection disables the schedule, same as a deleted
     folder does today).

4. **`server/src/schedule/scheduler.service.ts`**
   - `enqueueJob`: add `CONNECTION_FULL_PULL` / `CONNECTION_INCREMENTAL_PULL`
     cases — query `dataFolder` where `{ workbookId, connectorAccountId: entityId }`
     (`select: { id: true }`); if non-empty, enqueue one
     `enqueuePullLinkedFolderFilesJob(workbookId, actor, folderIds, undefined,
     runContext, scheduleActionToPullMode(action))`; if empty, log and skip.
   - `wasRecentlyTriggered`: short-circuit connection pull actions to `false`
     (no per-entity debounce). Rationale documented in code: `atomicClaim` advances
     `nextRunAt` a full cron interval (≥ the 30s window) so a connection schedule
     can't re-fire within the window, multi-instance double-claim is prevented by
     `atomicClaim`, cross-schedule collisions are serialized by the existing
     `isWorkbookBusy` deferral, and the mutual-exclusivity rule means no folder is
     covered by both a connection and a per-table schedule simultaneously.

No change to `ConnectorAccount` server entity/service — the client reads the
connection's schedules from the existing `GET /workbooks/:id/schedules` list.

## Client changes (`/client`)

1. **Extract shared schedule-row helpers** — new
   `client/src/app/workbook/[id]/components/shared/pull-schedule-helpers.ts`:
   `MANUAL_ONLY`, `PULL_SCHEDULE_OPTIONS`, `DEV_ONLY_OPTION`, and
   `applyScheduleRow({ workbookId, existing, value, action, entityId, name })`
   (create/update-if-changed/delete-on-manual). Consumed by the connection dialog.

2. **New `ConnectionPullScheduleModal.tsx`** (`components/shared/`)
   - Props: `opened`, `onClose`, `workbookId`, `connectorAccount`,
     `dataFolders: DataFolder[]` (the connection's tables, for id/name/service/
     incremental metadata only).
   - Reads current schedule state from `useSchedules(workbookId)` (single source
     of truth — derives connection-level rows by `entityId === connectorAccount.id`
     and per-table rows by `entityId === folder.id`).
   - Header: "Define how often Scratch automatically pulls data from `<Service>`."
   - `SegmentedControl` / `Radio.Group`: **Entire connection** vs **Each table**.
     - Entire connection: Full + (capability-gated) Incremental `Select`s, same
       option set as the per-table modal.
     - Each table: a scrollable list, one row per table, each with Full +
       (capability-gated) Incremental `Select`s.
   - Incremental gating uses `useConnectorsMetadata()[connectorAccount.service]
     ?.incrementalPull` (one service per connection).
   - Save applies the chosen mode via `applyScheduleRow` and clears the other mode
     (delete calls), then `await Promise.all([schedules.refresh(),
     dataFolders.refresh()])` and a success notification.

3. **Wire into the connection menu** — `Sidebar/TreeNode.tsx` `ConnectionNode`:
   add `{ label: 'Pull Schedule', icon: ClockIcon, onClick: openConnectionPullSchedule }`
   to the connection context menu's `extraItemsBefore` (grouped with the pull
   actions), and render `<ConnectionPullScheduleModal … dataFolders={group.dataFolders} />`.
   `ConnectionNode` already has `group.dataFolders`, `connectorAccount`, and the
   `useDisclosure` pattern.

4. **Remove the per-table `PullScheduleModal`** and its table context-menu item.
   The connection dialog's "each table" mode fully replaces it, and a standalone
   per-table dialog is a backdoor around the mutual-exclusivity invariant: it
   doesn't know about a connection-wide schedule, so it could create a per-table
   schedule alongside one and double-pull that table. Scheduling now has a single
   entry point — the connection menu. `pull-schedule-helpers.ts` stays (the
   connection dialog uses it).

## Tests

- **Server unit** (`scheduler.service.spec.ts`): a `CONNECTION_FULL_PULL` /
  `CONNECTION_INCREMENTAL_PULL` schedule fans out to all of the connection's
  folders with the correct `pullMode`; empty connection logs-and-skips;
  `entityExists` true/false on connector-account presence; connection actions are
  not debounced.
- **Server unit** (`schedule.service.spec.ts` if present / add): `validateEntityId`
  accepts a connector-account entityId for connection actions and rejects a
  missing one.
- **Build/lint**: `yarn build`, `yarn lint` (root) and `yarn lint-strict` in
  `server/`.
- **Manual**: connection with ≥2 Airtable tables — set an hourly entire-connection
  full pull, confirm one pull job covers all tables on the tick; switch to
  per-table mode and confirm the connection row is deleted and per-table rows
  created; confirm the reverse clears per-table rows.

## Out of scope / notes

- No new audit-log / PostHog tracking on schedule CRUD (existing schedule CRUD has
  none; keeping parity to avoid scope creep — can add later if desired).
- Desktop app (`/scratch-desktop`) and `scratchmd` CLI: not in scope for this
  issue (web only, mirroring where the per-table modal lives).
- Removing the legacy `PULL` enum value remains deferred (separate cleanup
  migration).

## Decisions

**Mutual exclusivity on save — CONFIRMED (2026-06-11).** It's a switch: a connection
is scheduled *either* entirely *or* per-table, never both. Saving "entire
connection" clears the per-table pull schedules for that connection; saving "each
table" clears the connection-wide schedule. The dialog messages this inline. Only
pull-type schedules are cleared — per-table publish/sync schedules are untouched.
