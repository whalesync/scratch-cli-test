# Incremental Polling

**Date**: 2026-05-14
**Status**: In progress
**Linear**: [DEV-9757](https://linear.app/whalesync/issue/DEV-9757/incremental-polling)
**Scope**: Server-only. UI changes deferred to a follow-up. **Airtable is the only connector implemented in this initial phase** — the full pipeline (schema, job, scheduler, triggers, audit logging) goes end-to-end against Airtable so we can validate the design before rolling it out to the other connectors.

## Progress

**Landed (2026-05-14):**

- Prisma schema (not yet migrated): added `lastIncrementalPullAt`, `incrementalCursor`, `lastFullPullAt` to `DataFolder`; added `FULL_PULL` and `INCREMENTAL_PULL` to `ScheduleAction` (with `PULL` marked deprecated) in [server/prisma/schema.prisma](../../server/prisma/schema.prisma). Mirrored the `ScheduleAction` change in [packages/shared-types/src/enums/enums.ts](../../packages/shared-types/src/enums/enums.ts).
- `DataFolderOptions.fullPullOnly?: boolean` added in [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts).
- Connector contract types added in [server/src/remote-service/connectors/types.ts](../../server/src/remote-service/connectors/types.ts):
  - `PullRecordFilesOptions extends DataFolderOptions` with optional runtime `pullMode` / `since` / `cursor`.
  - `PullRecordFilesResult` with optional `newWatermark` / `newCursor` (currently always `{}` — see note below).
- Abstract [`Connector`](../../server/src/remote-service/connectors/connector.ts): `pullRecordFiles` signature switched to `PullRecordFilesOptions` / `Promise<PullRecordFilesResult>`; added `supportsIncrementalPull(options: PullRecordFilesOptions): boolean` defaulting to `false`.
- All 18 concrete connectors under [server/src/remote-service/connectors/library/](../../server/src/remote-service/connectors/library/) updated mechanically: parameter type widened to `PullRecordFilesOptions`, return type widened to `Promise<PullRecordFilesResult>`, `return {};` added at the end of each `pullRecordFiles` body. No incremental logic anywhere — every connector still inherits the base `supportsIncrementalPull() = false`, including Airtable. The three connectors with custom pull-options subtypes (`AirtablePullOptions`, `IntercomPullOptions`, `NotionPullOptions`) now extend `PullRecordFilesOptions`.
- `yarn build` and `yarn lint` pass from the repo root.

**Still to do (in roughly this order):**

1. Generate and apply the two Prisma migrations (enum + `DataFolder` columns; then `UPDATE "Schedule" SET "action" = 'FULL_PULL' WHERE "action" = 'PULL'`). See [Data migration — convert existing `PULL` rows to `FULL_PULL`](#data-migration--convert-existing-pull-rows-to-full_pull).
2. Airtable incremental implementation (`supportsIncrementalPull(options)` override checking `modifiedAtField`; incremental branch in `pullRecordFiles`; clock-skew overlap). See [Airtable (in scope)](#airtable-in-scope).
3. Job changes in [`PullLinkedFolderFilesJob`](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts): effective-mode resolution, `since`/`cursor` injection into `pullOptions`, watermark/cursor persistence, conditional `deleteStaleFiles`. See [Job changes](#job-changes).
4. Scheduler: derive `pullMode` from `Schedule.action`; update `SCHEDULE_ACTION_TO_JOB_TYPE`. See [Scheduler changes](#scheduler-changes).
5. `schedule.service.ts` CRUD: accept the two new actions; keep accepting legacy `PULL`.
6. HTTP `mode` parameter on the pull-folder endpoint; CLI `--mode` flag on `scratchmd pull`. See [Trigger paths](#trigger-paths).
7. Audit-log entry on `enqueuePullLinkedFolderFilesJob` including `{ folderIds, mode, trigger }`.
8. `CONNECTOR_GUIDE.md` update documenting the new contract.
9. Verification per [Verification](#verification).

**Open question — how the job learns which mode actually ran**: today `PullRecordFilesResult` only carries optional `newWatermark` / `newCursor`. Adding `pullMode: 'full' | 'incremental'` to the result so connectors must report which mode they actually executed (in case a connector demotes incremental → full internally) was considered and rolled back. The job-side capability check (`if requestedMode === 'incremental' && !connector.supportsIncrementalPull(options) → demote`) is the current contract; revisit if a connector ends up needing to demote *after* `supportsIncrementalPull` has already approved the call.

## Context

Every pull today is a full scan: the connector iterates every record in the remote table, regardless of whether anything changed. For large tables this is slow and burns API quota — especially painful for connectors with strict rate limits (HubSpot, Notion) or per-row read costs. We need a way to ask "what changed since the last pull?" for connectors whose APIs can answer that, and to make the choice between full and incremental pulls configurable per [DataFolder](../../server/prisma/schema.prisma).

The intended outcome: a folder configured for incremental polling does a one-time full scan to bootstrap, then on each subsequent run pulls only records modified since the previous run. A folder can still be force-pulled in full mode (manually or on a separate, slower schedule) to catch deletions and drift. The connector interface gains an explicit, opt-in incremental contract; connectors whose APIs can't support it stay on full scans transparently.

## Approach

Three pieces fit together:

1. **Connector contract.** Extend the existing `pullRecordFiles` on the [`Connector`](../../server/src/remote-service/connectors/connector.ts) abstract class to accept the pull mode and incremental inputs (watermark, cursor) via its `options` parameter, and to return the new watermark/cursor for incremental runs. Add a `supportsIncrementalPull` capability flag — connectors whose remote APIs can answer "what changed since X?" override it to return `true`. Connectors that don't support incremental ignore the mode and continue full-scanning; the job demotes the run to `full` for them so state stays consistent.

2. **Polling state.** Store a per-folder high-water mark on `DataFolder` (`lastIncrementalPullAt`) and an optional opaque cursor (`incrementalCursor`). Add a single user-facing knob `fullPullOnly: boolean` to `DataFolder.options` that disables incremental polling for that folder (forces all pulls to be full). No `pollMode` field — the trigger (schedule/HTTP/CLI) drives mode by default, and `fullPullOnly` is the per-folder opt-out.

3. **Trigger paths.** Add two new values to the [`Schedule`](../../server/prisma/schema.prisma) action enum — `FULL_PULL` and `INCREMENTAL_PULL` — and **deprecate** the legacy `PULL` action. `PULL` and `FULL_PULL` are functionally equivalent at runtime so existing `PULL` rows keep working unchanged; a follow-up data migration flips remaining `PULL` rows to `FULL_PULL` and drops the enum value once we've confirmed everything is working in production. The split lets users run, e.g., "every 5 min `INCREMENTAL_PULL` + nightly `FULL_PULL`" on the same folder (the existing `@@unique([workbookId, action, entityId])` constraint already accommodates one row per action per folder). Manual triggers (HTTP and CLI) accept a `mode` parameter. The existing [`PullLinkedFolderFilesJob`](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts) carries the mode and resolves per-folder behavior at execution time.

Incremental polls never delete files — they cannot know which records the connector omitted because they were deleted vs. simply unchanged. Deletions remain the responsibility of full scans, which use the existing [`deleteStaleFiles`](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts) path.

## Schema changes

New Prisma migration (`20260514xxxxxx_datafolder_incremental_polling`):

```prisma
model DataFolder {
  // ... existing fields ...
  lastIncrementalPullAt DateTime?     // null = never bootstrapped; full pull needed first
  incrementalCursor     Json?         // connector-opaque (e.g. { sinceToken: "abc" })
  lastFullPullAt        DateTime?     // tracked separately so full and incremental schedules don't shadow each other
}

enum ScheduleAction {
  PULL              // @deprecated — equivalent to FULL_PULL; kept so any new external/legacy callers still work until a later cleanup migration drops the enum value
  FULL_PULL
  INCREMENTAL_PULL
  PUBLISH
  SYNC
}
```

The existing `@@unique([workbookId, action, entityId])` on `Schedule` is unchanged — because `FULL_PULL` and `INCREMENTAL_PULL` are distinct enum values, a single folder can host one of each.

### Data migration — convert existing `PULL` rows to `FULL_PULL`

As part of this change, every existing `Schedule.action = 'PULL'` row is migrated to `'FULL_PULL'` so the database reflects the new naming as soon as this release ships. Runtime tolerance for `'PULL'` stays in place to absorb any rows that get inserted between the migration and a future caller refactor (see [Scheduler changes](#scheduler-changes)).

Postgres enum migrations need the new value to be committed before it can be referenced in an `UPDATE`, so this lands as **two separate Prisma migrations** rather than one:

1. `20260514xxxxxx_schedule_action_add_pull_variants` — `ALTER TYPE "ScheduleAction" ADD VALUE 'FULL_PULL'; ALTER TYPE "ScheduleAction" ADD VALUE 'INCREMENTAL_PULL';` (also covers the `DataFolder` column additions from the block above).
2. `20260514xxxxxx_schedule_action_migrate_pull_to_full_pull` — `UPDATE "Schedule" SET "action" = 'FULL_PULL' WHERE "action" = 'PULL';`

This is idempotent and safe — no `Schedule` rows are deleted or restructured, only the action value is renamed. Existing `Schedule.id`, `cronExpression`, `nextRunAt`, etc. are preserved so in-flight cron evaluations continue uninterrupted.

A later cleanup migration (deferred — see [Out of scope](#out-of-scope)) will drop the `PULL` value from the enum once we've confirmed nothing creates new `PULL` rows.

`PULL` and `FULL_PULL` behave identically at runtime (see [Scheduler changes](#scheduler-changes)). CRUD still accepts `PULL` so any external/legacy caller that hasn't picked up the new actions yet keeps working.

`DataFolderOptions` (in [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts)) gains a single new persisted field:

```typescript
export interface DataFolderOptions {
  filter?: string | undefined;
  readOnly?: boolean | undefined;
  /** When true, this folder always does full pulls — disables incremental polling regardless of trigger. */
  fullPullOnly?: boolean | undefined;
  [key: string]: unknown;
}
```

The job augments `options` at call time with two non-persisted runtime fields (see [Connector interface](#connector-interface)) — these are the channel through which the job tells the connector "do incremental, start from `since`/`cursor`." They aren't written back to `dataFolder.options`.

Watermark vs. cursor: most connectors will use the timestamp alone. The cursor exists for APIs that return an opaque change token (e.g. a future Stripe events feed) — they ignore `lastIncrementalPullAt` and use the token instead.

## Connector interface

Extend the existing `pullRecordFiles` on [`Connector`](../../server/src/remote-service/connectors/connector.ts) — no new abstract method. The mode and incremental inputs are passed via `options`; the new watermark/cursor flow back through a typed return value.

New supporting types (colocated with `BaseJsonTableSpec` in [connectors/types.ts](../../server/src/remote-service/connectors/types.ts)):

```typescript
/**
 * The full options bag passed to pullRecordFiles. Extends the persisted DataFolderOptions
 * with non-persisted runtime fields set by the job at call time.
 */
export interface PullRecordFilesOptions extends DataFolderOptions {
  pullMode?: 'full' | 'incremental';   // absent / 'full' → existing full-scan behavior
  since?: Date | null;                 // for incremental: timestamp watermark
  cursor?: JsonSafeObject | null;      // for incremental: connector-opaque token (alternative to since)
}

/** Returned from pullRecordFiles. Empty for full pulls; populated by connectors that ran incremental. */
export interface PullRecordFilesResult {
  newWatermark?: Date;
  newCursor?: JsonSafeObject | null;
}
```

The abstract signature on `Connector` becomes:

```typescript
/** Default: connectors do not support incremental polling. Override per connector. */
supportsIncrementalPull(): boolean {
  return false;
}

/**
 * Pull records for a table.
 *
 * `options` is a PullRecordFilesOptions: every persisted DataFolderOptions field
 * (filter, readOnly, fullPullOnly, connector-specific keys) plus the runtime additions:
 *   - pullMode 'full' (default if absent): full scan, existing behavior. Connector ignores since/cursor.
 *   - pullMode 'incremental': pull only records changed since options.since (or since the opaque
 *     options.cursor if the connector uses tokens). Only invoked when supportsIncrementalPull() is true.
 *
 * For incremental runs the connector returns the new high-water mark / cursor to persist for
 * the next run. For full runs the connector returns an empty result.
 */
abstract pullRecordFiles(
  tableSpec: BaseJsonTableSpec,
  callback: (params: { files: ConnectorFile[]; connectorProgress?: TConnectorProgress }) => Promise<void>,
  progress: TConnectorProgress,
  options: PullRecordFilesOptions,
): Promise<PullRecordFilesResult>;
```

### Refactor task: switch `pullRecordFiles` parameter type from `DataFolderOptions` to `PullRecordFilesOptions`

Because `PullRecordFilesOptions extends DataFolderOptions`, every existing field a connector reads today (`options.filter`, `options.readOnly`, the `[key: string]: unknown` connector-specific extras) keeps working without code changes — the type only adds the runtime fields on top. The refactor itself is mechanical:

1. Update the abstract method signature on [`Connector`](../../server/src/remote-service/connectors/connector.ts) (single source).
2. Update each concrete connector's `pullRecordFiles` parameter type from `DataFolderOptions` to `PullRecordFilesOptions` across every file under [server/src/remote-service/connectors/library/](../../server/src/remote-service/connectors/library/) (Airtable, Attio, Affinity, Audienceful, Brevo, HubSpot, Intercom, Linear, Memberstack, Moco, Notion, Pipedrive, PostgreSQL, QuickBooks, Shopify, Stripe, Supabase, Webflow, Wix, WordPress, YouTube — plus `test` and any internal helpers).
3. Add the `return {}` at the end of each existing `pullRecordFiles` so the new return type `Promise<PullRecordFilesResult>` compiles.
4. Update any helper/wrapper that re-uses the parameter type (e.g. retry decorators, rate-limit wrappers, test fakes) to use the new type.
5. Run `yarn build` from the repo root and follow the compile errors to verify nothing was missed.

This is a discrete refactor that should land as its own commit/PR before the per-connector incremental implementations — it keeps the diff for those small and focused on connector-specific behavior rather than signature changes.

The existing `pullRecordFilesByIds` (by-ID pulls used by [`pull-files.job.ts`](../../server/src/worker/jobs/job-definitions/pull-files.job.ts)) is unchanged.

## Per-connector implementation strategy

This initial phase implements **Airtable only**. All other connectors keep `supportsIncrementalPull() = false` and continue full-scanning — they only need the trivial `return {}` added to their existing `pullRecordFiles` so the new return type compiles. Once the Airtable path is validated end-to-end (schema, job, scheduler, CLI, audit logs), a follow-up plan covers the rest using the same framework.

### Airtable (in scope)

[`server/src/remote-service/connectors/library/airtable/`](../../server/src/remote-service/connectors/library/airtable/)

- **API support**: `filterByFormula` parameter on the list endpoint. Combined with a `LAST_MODIFIED_TIME()` field on the table, an expression like `IS_AFTER({Last Modified Time}, '2026-05-14T12:00:00.000Z')` returns only changed rows. Pagination via the existing offset cursor is unaffected.
- **User configuration**: the modified-at field is not guaranteed to exist on every Airtable table — users have to add a "Last modified time" column. The connector therefore reads the field name from a new optional `DataFolderOptions.modifiedAtField?: string`. If absent, `supportsIncrementalPull()` returns false for that folder and the job demotes to full. This keeps incremental opt-in, avoids guessing field names, and matches the deferred PostgreSQL pattern (`modifiedAtColumn`).
- **Capability flag**: `supportsIncrementalPull(options: PullRecordFilesOptions): boolean` — override the base signature to take options so the per-folder field check can run. (The base abstract gets the same signature; default returns `false`.)
- **Incremental branch in `pullRecordFiles`**:
  1. If `options.pullMode !== 'incremental'` or `options.modifiedAtField` is unset → fall through to existing full-scan code, `return {}`.
  2. Build the incremental formula: `IS_AFTER({<modifiedAtField>}, '<options.since.toISOString()>')`. If a user-defined `options.filter` is also set, combine with `AND(...)`.
  3. Reuse the existing offset-cursor pagination via the connector's async generator (`AirtableApiClient.listRecords`); only the formula differs.
  4. Return `{ newWatermark: <pullStartedAt provided by job; the connector echoes it back> }`. Airtable's API doesn't surface a server-side change-token, so `newCursor` stays unset — `lastIncrementalPullAt` is the only state needed.
- **Filter combination**: the existing user-formula path lives in [`AirtableConnector`](../../server/src/remote-service/connectors/library/airtable/airtable-connector.ts) and `airtable-api-client.ts`. Wrap the formula composition in a small helper so the same logic is reusable when other connectors are added later.
- **Edge case — clock skew**: Airtable's `LAST_MODIFIED_TIME` is server-side; the job's `pullStartedAt` is server-side (Scratch's server). If their clocks drift, a record modified seconds before `pullStartedAt` could be missed. Mitigation: subtract a small overlap (e.g. 60 seconds) from `options.since` when building the formula. Document this in the connector's incremental block; idempotent file commits absorb the dupe.

### All other connectors (deferred to a follow-up)

Mechanical change only: add `return {}` to the end of each existing `pullRecordFiles` so the new `Promise<PullRecordFilesResult>` return type compiles. `supportsIncrementalPull()` inherits the base `false`. The list of connectors that will eventually be implemented (with sketches) is preserved here for future reference:

| Connector  | API support                                  | Future plan sketch                                                                  |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Notion     | `filter` on `last_edited_time`               | Wrap user filter with `AND { last_edited_time: { after: since } }`.                 |
| HubSpot    | `hs_lastmodifieddate` search API             | Switch from list endpoint to CRM Search with `hs_lastmodifieddate >= since`.        |
| Shopify    | GraphQL `updated_at:>...` query string       | Add `query` arg to existing GraphQL pull.                                           |
| Linear     | GraphQL `updatedAt: { gt: $since }` filter   | Add filter to existing GraphQL pull.                                                |
| WordPress  | `?modified_after=` REST param                | Add param to existing REST pull.                                                    |
| Webflow    | `last_updated` field in list response        | Sort desc by `lastUpdated`; stop when we cross `since`.                             |
| PostgreSQL | `WHERE modified_at > since`                  | Require user to declare a `modifiedAtColumn` in `DataFolderOptions`.                |
| Stripe     | `created[gte]=` (not modified)               | Defer — exposes create-time, not modify-time, which is insufficient.                |
| All others (Attio, Affinity, Audienceful, Brevo, Intercom, Memberstack, Moco, Pipedrive, QuickBooks, Supabase, Wix, YouTube) | Mixed / unknown | Defer; revisit per connector. |

## Job changes

### `PullLinkedFolderFilesJob` ([pull-linked-folder-files.job.ts](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts))

Extend the job's `data` shape:

```typescript
{
  // ... existing ...
  pullMode?: 'full' | 'incremental';  // omitted → defaults to 'full' (safe default; incremental is strictly opt-in)
}
```

**Default mode is `'full'` everywhere.** To minimize behavior changes from this feature, any caller that doesn't explicitly set `pullMode` (HTTP without `mode`, CLI without `--mode`, legacy `PULL` schedule, internal job-to-job enqueue) gets a full pull — identical to today's behavior. Incremental only runs when something explicitly asks for it (`INCREMENTAL_PULL` schedule, `mode=incremental` on HTTP, `--mode incremental` on CLI).

Per-folder resolution in `loadFolderAndConnector` (around [line 436](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts#L436), where `pullOptions` is built):

```
requestedMode = data.pullMode ?? 'full'                          // safe default — see note above
effectiveMode = requestedMode
if pullOptions.fullPullOnly === true:
   effectiveMode = 'full'                                        // folder opt-out wins
if effectiveMode === 'incremental' AND !connector.supportsIncrementalPull():
   effectiveMode = 'full'                                        // capability fallback (log warning)
if effectiveMode === 'incremental' AND dataFolder.lastIncrementalPullAt IS NULL:
   effectiveMode = 'full'                                        // bootstrap; next run goes incremental
```

Every enqueue site that produces a `PullLinkedFolderFilesJob` must agree on this rule — none of them synthesize `pullMode` from folder options or guess based on capability:

- [`SchedulerService`](../../server/src/schedule/scheduler.service.ts): derives `pullMode` purely from `Schedule.action` (`INCREMENTAL_PULL` → `'incremental'`; `FULL_PULL` and legacy `PULL` → `'full'`).
- [`DataFolderController`](../../server/src/workbook/data-folder.controller.ts) pull endpoint: passes through the request's `mode` param; omitted → `'full'`.
- `scratchmd pull` CLI ([cli-linked.controller.ts](../../server/src/cli/cli-linked.controller.ts)): passes through `--mode`; omitted → `'full'`.
- Any internal/programmatic enqueue from other jobs or services: must omit `pullMode` (which means `'full'`) unless that caller has an explicit reason to request incremental.
- [`BullEnqueuerService.enqueuePullLinkedFolderFilesJob`](../../server/src/worker-enqueuer/bull-enqueuer.service.ts): accepts `pullMode` as an optional argument; does not default to anything other than passing through whatever the caller gave it. The job is the single point that resolves `undefined → 'full'`, so the rule lives in one place.

In `fetchFolder` (Phase 1):

- Capture `pullStartedAt = new Date()` BEFORE calling the connector (used as the new watermark on success regardless of mode).
- Build the call-time options object:
  ```typescript
  const callOptions: PullRecordFilesOptions = {
    ...folderCtx.pullOptions,
    pullMode: effectiveMode,
    since: effectiveMode === 'incremental' ? dataFolder.lastIncrementalPullAt : null,
    cursor: effectiveMode === 'incremental' ? dataFolder.incrementalCursor : null,
  };
  ```
- Single call: `const result = await connector.pullRecordFiles(tableSpec, callback, progress, callOptions);`
- Carry `result.newWatermark` / `result.newCursor` (incremental) or `pullStartedAt` (full) into the existing `FolderFetchResult`.

Watermark policy: use the timestamp captured at the **start** of the pull (`pullStartedAt`), not the connector's reported time. Records modified during the pull may or may not be returned by the API; using start-time guarantees they're re-fetched next run. Idempotent file commits handle the dupe safely. If a connector returns its own `newWatermark`, prefer it (some APIs return server time on the change-feed response, which is more accurate than client wall-clock).

In `processFolder` (Phase 2):

- **Full**: existing `deleteStaleFiles` runs; on success, update `lastFullPullAt = pullStartedAt` and `lastIncrementalPullAt = pullStartedAt` (a full scan is a superset of incremental — see [State transitions](#state-transitions)).
- **Incremental**: **skip `deleteStaleFiles` entirely.** On success, update `lastIncrementalPullAt = newWatermark` and `incrementalCursor = newCursor` atomically with the folder's completion marker.

`FolderContext` (around [line 95](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts#L95)) gains:

```typescript
type FolderContext = {
  // ... existing ...
  effectiveMode: 'full' | 'incremental';
  pullStartedAt: Date;
  since: Date | null;            // only for incremental
  resumeCursor: JsonSafeObject | null;  // only for incremental
};
```

### `PullFilesJob` ([pull-files.job.ts](../../server/src/worker/jobs/job-definitions/pull-files.job.ts))

No changes. `RefreshRecords` is by-ID and already targeted — incremental polling doesn't apply.

### Progress tracking

`PullLinkedFolderFilesPublicProgress` (already at [line 34](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts#L34)) gains:

```typescript
mode: 'full' | 'incremental';  // emitted per-folder so analytics/UI can distinguish
```

PostHog event `trackPullCompleted` ([line 390](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts#L390)) gets a `mode` field. No new event type — same lifecycle.

### Audit logging

The job already emits workbook events and PostHog. Add an audit-log entry on job start in `BullEnqueuerService.enqueuePullLinkedFolderFilesJob` capturing `{ folderIds, mode, trigger }` per the [server CLAUDE.md](../../server/CLAUDE.md) tracking rules ("triggering asynchronous jobs related to a core entity").

## Scheduler changes

[`SchedulerService.evaluateSchedules`](../../server/src/schedule/scheduler.service.ts) (around [line 161](../../server/src/schedule/scheduler.service.ts#L161)) derives `pullMode` from the `Schedule.action` and passes it to `enqueuePullLinkedFolderFilesJob`. Cron evaluation, atomic claim, and debounce logic are unchanged.

Update the `SCHEDULE_ACTION_TO_JOB_TYPE` mapping in [`schedule.types.ts`](../../server/src/schedule/schedule.types.ts):

```typescript
const SCHEDULE_ACTION_TO_JOB_TYPE = {
  PULL: JobType.PullLinkedFolderFiles,             // @deprecated — equivalent to FULL_PULL
  FULL_PULL: JobType.PullLinkedFolderFiles,
  INCREMENTAL_PULL: JobType.PullLinkedFolderFiles,
  PUBLISH: JobType.Publish,
  SYNC: JobType.SyncDataFolders,
};
```

Action → mode resolution at enqueue time:

```typescript
function scheduleActionToPullMode(action: ScheduleAction): 'full' | 'incremental' {
  switch (action) {
    case 'INCREMENTAL_PULL': return 'incremental';
    case 'FULL_PULL':
    case 'PULL':              return 'full';        // PULL and FULL_PULL are equivalent until PULL is removed
    default: throw new Error(...);                  // non-pull action shouldn't reach this code path
  }
}
```

**CRUD** in [`schedule.service.ts`](../../server/src/schedule/schedule.service.ts) accepts all three action values without restriction — `PULL` continues to be a valid input for create/update and behaves the same as `FULL_PULL`. The eventual removal of `PULL` is handled by the follow-up cleanup migration once we're confident the new actions are in use everywhere.

The 30-second debounce window is per-entity-and-action today; with the action-level split, an `INCREMENTAL_PULL` no longer suppresses a `FULL_PULL` scheduled seconds later (they have different action values and therefore different debounce keys). One edge case: a legacy `PULL` and a new `FULL_PULL` row on the same folder would each get their own debounce key despite being equivalent — acceptable for the transition window since the cleanup migration will remove `PULL` rows.

## Trigger paths

### HTTP

`DataFolderController` — add `mode?: 'full' | 'incremental'` to the pull-folder endpoint (the existing endpoint that enqueues `PullLinkedFolderFilesJob`). Defaults to `'full'`. A folder with `fullPullOnly = true` ignores the requested mode and runs full.

`pull-files` endpoint (used by [`pull-files.job.ts`](../../server/src/worker/jobs/job-definitions/pull-files.job.ts)) does not change — it's by-ID.

### CLI

[`scratch-git-2/src/cli/`](../../scratch-git-2/src/cli/) — `scratchmd pull` gains a `--mode full|incremental` flag (default: `full`). Update the `cli-linked.controller.ts` endpoint it calls.

Per [server CLAUDE.md](../../server/CLAUDE.md), CLI interactions must be audit-logged; verify the existing CLI pull audit entry includes the new `mode` field.

## State transitions

- **Bootstrap**: `lastIncrementalPullAt = null`. First pull (regardless of requested mode) runs as a full scan. On success, the job sets `lastIncrementalPullAt = pullStartedAt` and `lastFullPullAt = pullStartedAt`. From then on, incremental requests do incremental.
- **Full run after bootstrap** (manual override or scheduled full): runs a full scan with stale-file deletion. Updates `lastFullPullAt = pullStartedAt`. **Also bumps `lastIncrementalPullAt = pullStartedAt`** — a full scan is a superset of incremental, so the next incremental can start from there. `incrementalCursor` is cleared.
- **Incremental run on a never-bootstrapped folder**: silently promotes to full. Logged at info level.
- **Incremental run on a `fullPullOnly = true` folder**: silently promotes to full. Logged at info level.
- **`fullPullOnly` toggled false → true**: takes effect on the next run; existing watermark/cursor preserved (so toggling back to false later resumes from where it left off).
- **`fullPullOnly` toggled true → false**: next incremental request will bootstrap if no watermark exists, otherwise resumes.
- **Schema change on the remote**: out of scope. Today, schema is refetched at job start ([line 453](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts#L453)). Incremental pulls do the same — if a column is added remotely, the next incremental pull returns records with that column and the schema-write-to-git step covers it.

## Out of scope

- UI for configuring `fullPullOnly` per folder or for choosing `FULL_PULL` / `INCREMENTAL_PULL` when creating schedules. The schema/back-end paths work; UI lands separately.
- Removing the `PULL` value from the `ScheduleAction` enum. The data migration to flip existing `'PULL'` rows to `'FULL_PULL'` ships with this release (see [Data migration](#data-migration--convert-existing-pull-rows-to-full_pull)), but the enum value itself stays for runtime tolerance until a follow-up cleanup migration drops it once we've confirmed nothing creates new `PULL` rows.
- Webhook-driven near-real-time updates (a different feature than scheduled polling).
- Connector capabilities beyond `modified-since` (deletion feeds, full change-data-capture).
- Per-record TTL or selective re-pull triggered by external signals.

## Critical files

- [server/src/remote-service/connectors/connector.ts](../../server/src/remote-service/connectors/connector.ts) — add `supportsIncrementalPull(options)`; change `pullRecordFiles` return type to `PullRecordFilesResult`.
- [server/src/remote-service/connectors/types.ts](../../server/src/remote-service/connectors/types.ts) — add `PullRecordFilesOptions` and `PullRecordFilesResult`.
- [server/src/remote-service/connectors/CONNECTOR_GUIDE.md](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md) — document the new contract (mode in options, return shape, capability flag) using Airtable as the worked example.
- [server/src/remote-service/connectors/library/airtable/](../../server/src/remote-service/connectors/library/airtable/) — implement incremental branch in `pullRecordFiles`; override `supportsIncrementalPull(options)`; read `options.modifiedAtField`; combine user formula with `IS_AFTER`; return `{ newWatermark }`.
- All other connectors under [server/src/remote-service/connectors/library/](../../server/src/remote-service/connectors/library/) — add trivial `return {}` so the new return type compiles. Capability flag inherits base `false`.
- [server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts) — resolve effective mode per folder; augment `options` with `pullMode`/`since`/`cursor`; conditional `deleteStaleFiles` in Phase 2; persist new watermark/cursor.
- [server/src/schedule/scheduler.service.ts](../../server/src/schedule/scheduler.service.ts) — map `Schedule.action` (`FULL_PULL` / `INCREMENTAL_PULL` / legacy `PULL`) to job `pullMode` at enqueue.
- [server/src/schedule/schedule.service.ts](../../server/src/schedule/schedule.service.ts) — surface the two new actions in CRUD; `PULL` remains valid (equivalent to `FULL_PULL`).
- [server/src/schedule/schedule.types.ts](../../server/src/schedule/schedule.types.ts) — update `SCHEDULE_ACTION_TO_JOB_TYPE` with the new actions.
- [server/prisma/schema.prisma](../../server/prisma/schema.prisma) — `DataFolder` columns; add `FULL_PULL` / `INCREMENTAL_PULL` to the `ScheduleAction` enum and mark `PULL` deprecated.
- [server/prisma/migrations/](../../server/prisma/migrations/) — two migrations: (1) add the new enum values + `DataFolder` columns, (2) `UPDATE "Schedule" SET "action" = 'FULL_PULL' WHERE "action" = 'PULL'`.
- [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts) — `DataFolderOptions.fullPullOnly`.
- [packages/shared-types/src/job-types.ts](../../packages/shared-types/src/job-types.ts) — job `data.pullMode` typing.
- [server/src/workbook/data-folder.controller.ts](../../server/src/workbook/data-folder.controller.ts) — accept `mode` on pull endpoint.
- [server/src/worker-enqueuer/bull-enqueuer.service.ts](../../server/src/worker-enqueuer/bull-enqueuer.service.ts) — thread `pullMode` into job data + audit log.
- [scratch-git-2/src/cli/](../../scratch-git-2/src/cli/) — `--mode` flag for `scratchmd pull`.

Existing utilities to reuse — not to reinvent:

- [`FileIndexService`](../../server/src/publish-plan/file-index.service.ts) — `upsertBatch` already updates `lastSeenAt`; we keep using it on incremental pulls so a future enhancement can use stale-detection for delete inference if needed.
- [`ScratchGitService.commitFilesToBranch`](../../server/src/scratch-git/scratch-git.service.ts) — idempotent file commits; safe to receive the same record twice across runs.
- [`AssetExtractorService`/`AssetIndexService`](../../server/src/asset/) — already invoked from the per-batch callback; no change needed.
- [`BullEnqueuerService.enqueuePullLinkedFolderFilesJob`](../../server/src/worker-enqueuer/bull-enqueuer.service.ts) — extend its signature, don't add a new enqueue method.
- Connector progress / job progress checkpoint infrastructure ([`base-types.ts`](../../server/src/worker/jobs/base-types.ts), [`bull-worker.service.ts`](../../server/src/worker/bull-worker.service.ts)) — incremental pulls use the existing `connectorProgress` for mid-run resumption; only the cross-run watermark needs new storage on `DataFolder`.

## Verification

1. **Unit**: `pull-linked-folder-files.job.spec.ts` — add cases for (a) bootstrap (null watermark → full), (b) incremental happy path (watermark set, connector called with `since`), (c) connector without support → forced to full, (d) incremental success updates `lastIncrementalPullAt`, doesn't run `deleteStaleFiles`, (e) full run on incremental folder bumps both watermarks, (f) `fullPullOnly = true` demotes incremental to full.
2. **Airtable connector unit tests**: verify `pullRecordFiles` with `pullMode === 'incremental'` (a) injects `IS_AFTER({<modifiedAtField>}, '<since>')` into the formula, (b) combines correctly with a user-provided `options.filter`, (c) applies the clock-skew overlap, (d) returns `{ newWatermark }`, (e) returns `{}` when `pullMode === 'full'`. Verify `supportsIncrementalPull(options)` returns false when `modifiedAtField` is unset.
3. **Integration** (`yarn test:integration`): end-to-end against a real Airtable test base with a `Last Modified Time` field — bootstrap pull, modify a record, incremental pull, assert only the modified record's file changed in git, watermark advanced.
4. **Manual** (Airtable):
   - Create an Airtable folder, add `modifiedAtField: 'Last Modified Time'` to `dataFolder.options`. Trigger `scratchmd pull --mode incremental` → full bootstrap (no watermark yet). Check `lastIncrementalPullAt` populated.
   - Modify one record in Airtable. Trigger `scratchmd pull --mode incremental` → only that file touched in git, no deletions, watermark advanced.
   - Delete a remote record. Incremental pull → not detected (expected). Full pull → deleted in git, `lastFullPullAt` updated, `lastIncrementalPullAt` also advanced.
   - Set `dataFolder.options.fullPullOnly = true`. Trigger `--mode incremental` → silently runs full (log entry confirms demotion); incremental state unchanged.
   - Unset `modifiedAtField`. Trigger `--mode incremental` → silently runs full with a logged warning (`supportsIncrementalPull() = false`).
   - Create two schedules on the same Airtable folder — `action = INCREMENTAL_PULL` at `*/5 * * * *` and `action = FULL_PULL` at `0 3 * * *`. Verify both rows insert cleanly under the existing `@@unique([workbookId, action, entityId])` constraint and `SchedulerService` enqueues each with the correct `pullMode`.
   - Before deploying, seed a test DB with `action = 'PULL'` rows; after running the migration, verify all are now `'FULL_PULL'` (their `id`, `cronExpression`, `nextRunAt` unchanged) and continue firing on schedule.
   - Verify a new `action = 'PULL'` row inserted post-migration still fires and behaves identically to `FULL_PULL` (runtime tolerance is preserved).
   - Trigger `--mode incremental` on a non-Airtable connector → silently runs full with a logged warning (capability flag still false everywhere else).
5. `yarn build` and `yarn lint` from repo root pass.

Once this end-to-end loop is validated against Airtable, a follow-up plan implements the remaining connectors using the same framework.
