# Incremental Polling

**Date**: 2026-05-14
**Status**: In progress
**Linear**: [DEV-9757](https://linear.app/whalesync/issue/DEV-9757/incremental-polling)
**Scope**: Server-only. UI changes deferred to a follow-up. **Airtable is the only connector implemented in this initial phase** — the full pipeline (schema, job, scheduler, triggers) goes end-to-end against Airtable so we can validate the design before rolling it out to the other connectors.

## Progress

**Landed (2026-05-14):**

- Prisma schema (not yet migrated): added `lastIncrementalPullAt`, `incrementalCursor`, `lastFullPullAt` to `DataFolder`; added `FULL_PULL` and `INCREMENTAL_PULL` to `ScheduleAction` (with `PULL` marked deprecated) in [server/prisma/schema.prisma](../../server/prisma/schema.prisma). Mirrored the `ScheduleAction` change in [packages/shared-types/src/enums/enums.ts](../../packages/shared-types/src/enums/enums.ts).
- `DataFolderOptions.fullPullOnly?: boolean` added in [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts).
- Connector contract types added in [server/src/remote-service/connectors/types.ts](../../server/src/remote-service/connectors/types.ts):
  - `PullRecordFilesOptions extends DataFolderOptions` with optional runtime `pullMode` / `since` / `cursor`.
  - `PullRecordFilesResult` with optional `newWatermark` / `newCursor` (currently always `{}` — see note below).
- Abstract [`Connector`](../../server/src/remote-service/connectors/connector.ts): `pullRecordFiles` signature switched to `PullRecordFilesOptions` / `Promise<PullRecordFilesResult>`; added `supportsIncrementalPull(options: PullRecordFilesOptions): boolean` defaulting to `false`.
- All 18 concrete connectors under [server/src/remote-service/connectors/library/](../../server/src/remote-service/connectors/library/) updated mechanically: parameter type widened to `PullRecordFilesOptions`, return type widened to `Promise<PullRecordFilesResult>`, `return {};` added at the end of each `pullRecordFiles` body. No incremental logic anywhere — every connector still inherits the base `supportsIncrementalPull() = false`, including Airtable. The three connectors with custom pull-options subtypes (`AirtablePullOptions`, `IntercomPullOptions`, `NotionPullOptions`) now extend `PullRecordFilesOptions`.
- **Airtable incremental implementation (2026-05-15):**
  - `DataFolderOptions.modifiedAtField?: string` added in [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts) — explicit per-folder override of which field to use for the modified-since filter.
  - New schema annotation `X_SCRATCH_LAST_MODIFIED_FIELD = 'x-scratch-last-modified-field'` added in [packages/shared-types/src/connector/json-schema.ts](../../packages/shared-types/src/connector/json-schema.ts). The Airtable schema builder in [airtable-json-schema.ts](../../server/src/remote-service/connectors/library/airtable/airtable-json-schema.ts) sets this to `true` on any field of type `lastModifiedTime`, so an Airtable table with such a column gets incremental support automatically — no per-folder configuration required.
  - Generic helper `findLastModifiedFieldName(tableSpec)` in [server/src/remote-service/connectors/types.ts](../../server/src/remote-service/connectors/types.ts) walks `schema.properties.fields.properties` and returns the first field annotated with `X_SCRATCH_LAST_MODIFIED_FIELD`. Reusable by any future connector that wants schema-driven last-modified detection.
  - `Connector.supportsIncrementalPull` signature widened to `(options, tableSpec)` so connectors can consult either per-folder options or the schema annotation. Default still returns `false`.
  - [`AirtableConnector`](../../server/src/remote-service/connectors/library/airtable/airtable-connector.ts) overrides `supportsIncrementalPull(options, tableSpec)` and routes through a `resolveModifiedAtField(options, tableSpec)` helper that prefers `options.modifiedAtField` and falls back to the schema-annotated field. The same helper drives `pullRecordFiles`, so the capability check and the actual pull stay in lockstep.
  - Incremental branch in `pullRecordFiles`: captures `pullStartedAt` before the first API call, builds `IS_AFTER({<resolvedField>}, '<since - 60s>')`, combines with any user `options.filter` via `AND(...)`, and returns `{ newWatermark: pullStartedAt }`. Full pulls still return `{}` and pass the user filter through unchanged.
  - Formula helpers + clock-skew constant in [airtable-incremental.ts](../../server/src/remote-service/connectors/library/airtable/airtable-incremental.ts) (with escaping for `}` / `\` / `'`).
  - `modifiedAtField` added to `AirtableConnector.advancedSettings` for discoverability (acts as an override when auto-detection isn't enough — e.g. a table with multiple last-modified-time columns).
  - Unit tests in [__tests__/airtable-connector.spec.ts](../../server/src/remote-service/connectors/library/airtable/__tests__/airtable-connector.spec.ts), [__tests__/airtable-incremental.spec.ts](../../server/src/remote-service/connectors/library/airtable/__tests__/airtable-incremental.spec.ts), and [__tests__/airtable-json-schema.spec.ts](../../server/src/remote-service/connectors/library/airtable/__tests__/airtable-json-schema.spec.ts): capability check (explicit + auto-detect + neither), incremental formula injection, AND-combination with user filter, field-name escaping, watermark return, full-pull no-op, schema annotation set on `lastModifiedTime` fields, explicit-overrides-auto precedence.
- **`PullLinkedFolderFilesJob` incremental support (2026-05-15):**
  - Job data shape gains `pullMode?: 'full' | 'incremental'` (default `'full'`); `PullLinkedFolderFilesPublicProgress` gains `mode?: 'full' | 'incremental'` (set per-folder during Phase 2).
  - `loadFolderAndConnector` resolves effective mode per folder via the plan's four-step rule: requested → `fullPullOnly` override → connector capability (with `tableSpec`) → bootstrap (`lastIncrementalPullAt === null`). Each demotion is logged at info level.
  - `FolderContext` carries `effectiveMode`, `pullStartedAt` (captured before any work), `since`, and `resumeCursor`. `FolderFetchResult` carries `newWatermark` and `newCursor`.
  - `fetchFolder` builds the connector call options (`{ ...pullOptions, pullMode, since, cursor }`) and captures the connector's returned `newWatermark` / `newCursor`. For incremental runs it prefers the connector's reported watermark, falling back to `pullStartedAt`.
  - `processFolder` skips `deleteStaleFiles` entirely on incremental. `finalizeFolder` atomically clears the lock and persists watermarks: full runs bump both `lastFullPullAt` and `lastIncrementalPullAt` to `pullStartedAt` and clear `incrementalCursor` (`Prisma.DbNull`); incremental runs bump only `lastIncrementalPullAt` and persist the returned cursor when provided.
  - PostHog `trackPullCompleted` gains an optional `mode` field, populated from `data.pullMode ?? 'full'`.
  - `BullEnqueuerService.enqueuePullLinkedFolderFilesJob` accepts an optional `pullMode` argument and threads it into the job data (no defaulting in the enqueuer — that's the job's responsibility).
  - Unit tests in [pull-linked-folder-files.job.spec.ts](../../server/src/worker/jobs/job-definitions/__tests__/pull-linked-folder-files.job.spec.ts) cover all six cases from the plan: bootstrap demote, happy-path incremental call args, capability demote, incremental success (no delete + watermark advance), full-pull bumps both watermarks + clears cursor, `fullPullOnly` demote (skips the capability check).
- `yarn build` and `yarn lint` pass from the repo root.

**Still to do (in roughly this order):**

1. Generate and apply the two Prisma migrations (enum + `DataFolder` columns; then `UPDATE "Schedule" SET "action" = 'FULL_PULL' WHERE "action" = 'PULL'`). See [Data migration — convert existing `PULL` rows to `FULL_PULL`](#data-migration--convert-existing-pull-rows-to-full_pull).
2. ~~Airtable incremental implementation (`supportsIncrementalPull(options)` override checking `modifiedAtField`; incremental branch in `pullRecordFiles`; clock-skew overlap). See [Airtable (in scope)](#airtable-in-scope).~~ Landed 2026-05-15.
3. ~~Job changes in [`PullLinkedFolderFilesJob`](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts): effective-mode resolution, `since`/`cursor` injection into `pullOptions`, watermark/cursor persistence, conditional `deleteStaleFiles`. See [Job changes](#job-changes).~~ Landed 2026-05-15.
4. Scheduler: derive `pullMode` from `Schedule.action`; update `SCHEDULE_ACTION_TO_JOB_TYPE`. See [Scheduler changes](#scheduler-changes).
5. `schedule.service.ts` CRUD: accept the two new actions; keep accepting legacy `PULL`.
6. HTTP `mode` parameter on the pull-folder endpoint; CLI `--mode` flag on `scratchmd pull`. See [Trigger paths](#trigger-paths).
7. `CONNECTOR_GUIDE.md` update documenting the new contract.
8. Verification per [Verification](#verification).

**Open question — how the job learns which mode actually ran**: today `PullRecordFilesResult` only carries optional `newWatermark` / `newCursor`. Adding `pullMode: 'full' | 'incremental'` to the result so connectors must report which mode they actually executed (in case a connector demotes incremental → full internally) was considered and rolled back. The job-side capability check (`if requestedMode === 'incremental' && !connector.supportsIncrementalPull(options) → demote`) is the current contract; revisit if a connector ends up needing to demote *after* `supportsIncrementalPull` has already approved the call.

## Context

Every pull today is a full scan: the connector iterates every record in the remote table, regardless of whether anything changed. For large tables this is slow and burns API quota — especially painful for connectors with strict rate limits (HubSpot, Notion) or per-row read costs. We need a way to ask "what changed since the last pull?" for connectors whose APIs can answer that, and to make the choice between full and incremental pulls configurable per [DataFolder](../../server/prisma/schema.prisma).

The intended outcome: a folder configured for incremental polling does a one-time full scan to bootstrap, then on each subsequent run pulls only records modified since the previous run. A folder can still be force-pulled in full mode (manually or on a separate, slower schedule) to catch deletions and drift. The connector interface gains an explicit, opt-in incremental contract; connectors whose APIs can't support it stay on full scans transparently.

## Approach

Three pieces fit together:

1. **Connector contract.** Extend the existing `pullRecordFiles` on the [`Connector`](../../server/src/remote-service/connectors/connector.ts) abstract class to accept the pull mode and incremental inputs (watermark, cursor) via its `options` parameter, and to return the new watermark/cursor for incremental runs. Add a `supportsIncrementalPull` capability flag — connectors whose remote APIs can answer "what changed since X?" override it to return `true`. Connectors that don't support incremental ignore the mode and continue full-scanning; the job demotes the run to `full` for them so state stays consistent.

2. **Polling state.** Store a per-folder high-water mark on `DataFolder` (`lastIncrementalPullAt`) and an optional opaque cursor (`incrementalCursor`). Add a single user-facing knob `fullPullOnly: boolean` to `DataFolder.options` that disables incremental polling for that folder (forces all pulls to be full). No `pollMode` field — the trigger (schedule/HTTP/CLI) drives mode by default, and `fullPullOnly` is the per-folder opt-out. Connectors that need to know which field on the remote table holds the last-modified timestamp resolve it in two layers: (a) an explicit `DataFolderOptions.modifiedAtField` override, and (b) schema-driven auto-detection via the `x-scratch-last-modified-field` annotation set by the connector's schema builder.

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

In addition to `options`, the capability flag (`supportsIncrementalPull`) is given the `tableSpec` so connectors can inspect schema-level metadata — see [Schema annotation: `x-scratch-last-modified-field`](#schema-annotation-x-scratch-last-modified-field) for the auto-detection mechanism that lets connectors enable incremental pulls without per-folder configuration.

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
/**
 * Default: connectors do not support incremental polling. Override per connector.
 * Both `options` and `tableSpec` are passed so the connector can decide based on
 * per-folder configuration (e.g. an explicit `modifiedAtField`) or schema-level
 * metadata (e.g. a field annotated with `x-scratch-last-modified-field`).
 */
supportsIncrementalPull(options: PullRecordFilesOptions, tableSpec: BaseJsonTableSpec): boolean {
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

### Schema annotation: `x-scratch-last-modified-field`

Connectors that auto-detect the last-modified column from the remote schema do so via a new JSON Schema annotation:

- `X_SCRATCH_LAST_MODIFIED_FIELD = 'x-scratch-last-modified-field'` is defined alongside the other `x-scratch-*` keys in [packages/shared-types/src/connector/json-schema.ts](../../packages/shared-types/src/connector/json-schema.ts).
- The annotation value is the literal boolean `true`. It's set per-field in the connector's schema builder when that field is known to hold the row's server-side last-modified timestamp.
- Airtable's schema builder ([airtable-json-schema.ts](../../server/src/remote-service/connectors/library/airtable/airtable-json-schema.ts)) tags every field whose Airtable type is `lastModifiedTime`. Future connectors with a typed "last modified" field (Notion `last_edited_time`, HubSpot `hs_lastmodifieddate`, PostgreSQL columns the user opts in) annotate analogously.
- A generic helper `findLastModifiedFieldName(tableSpec)` in [server/src/remote-service/connectors/types.ts](../../server/src/remote-service/connectors/types.ts) walks `tableSpec.schema.properties.fields.properties` and returns the first annotated field name, or `undefined`. Connectors call this from `supportsIncrementalPull` and from the incremental branch of `pullRecordFiles`, typically wrapped in a `resolveModifiedAtField(options, tableSpec)` helper that prefers an explicit `options.modifiedAtField` over the auto-detected value.

Resolution precedence (used by Airtable, recommended for future connectors):

1. `DataFolderOptions.modifiedAtField` if set — explicit user override (useful when a table has multiple last-modified-time fields and the user wants to pick one).
2. The first field annotated with `x-scratch-last-modified-field` in the table schema — auto-detected.
3. Otherwise `supportsIncrementalPull()` returns `false` and the job demotes the run to a full pull.

Connectors whose remote APIs expose a service-wide change feed (no per-table field needed) ignore both layers and override `supportsIncrementalPull` to return `true` unconditionally.

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

This initial phase implements **Airtable only**. All other connectors keep `supportsIncrementalPull() = false` and continue full-scanning — they only need the trivial `return {}` added to their existing `pullRecordFiles` so the new return type compiles. Once the Airtable path is validated end-to-end (schema, job, scheduler, CLI), a follow-up plan covers the rest using the same framework.

### Airtable (in scope — landed 2026-05-15)

[`server/src/remote-service/connectors/library/airtable/`](../../server/src/remote-service/connectors/library/airtable/)

- **API support**: `filterByFormula` parameter on the list endpoint. Combined with a `LAST_MODIFIED_TIME()` field on the table, an expression like `IS_AFTER({Last Modified Time}, '2026-05-14T12:00:00.000Z')` returns only changed rows. Pagination via the existing offset cursor is unaffected.
- **Field resolution (two-layer)**: an Airtable folder gets incremental support when the connector can locate a last-modified field on the table. Precedence:
  1. Explicit `DataFolderOptions.modifiedAtField` — the user names a field directly. Useful when a table has multiple `lastModifiedTime` columns and the user wants to pick one (e.g. one scoped to data columns and another tracking schema changes).
  2. Auto-detection: the [schema builder](../../server/src/remote-service/connectors/library/airtable/airtable-json-schema.ts) annotates every Airtable `lastModifiedTime` field with `x-scratch-last-modified-field: true` (see [Schema annotation: `x-scratch-last-modified-field`](#schema-annotation-x-scratch-last-modified-field)). The connector falls back to `findLastModifiedFieldName(tableSpec)` when no explicit option is set, so a table that already has a Last Modified Time column gets incremental support with zero configuration.
  3. Neither → `supportsIncrementalPull()` returns false, the job demotes to full.
- **Capability flag**: `supportsIncrementalPull(options, tableSpec): boolean` — override the base signature; both `options` and `tableSpec` are needed so the per-folder option check and schema-annotation lookup can both run. Delegates to a private `resolveModifiedAtField(options, tableSpec)` helper used by both the capability check and the pull body, so they can't disagree.
- **Incremental branch in `pullRecordFiles`**:
  1. Resolve the field via `resolveModifiedAtField(options, tableSpec)`. If unresolved or `options.pullMode !== 'incremental'` or `options.since` is missing → fall through to existing full-scan code, `return {}`.
  2. Capture `pullStartedAt = new Date()` BEFORE the first API call (used as the watermark to return).
  3. Build the incremental formula: `IS_AFTER({<resolvedField>}, '<options.since - 60s>')`. If a user-defined `options.filter` is also set, combine with `AND(...)`.
  4. Reuse the existing offset-cursor pagination via the connector's async generator (`AirtableApiClient.listRecords`); only the formula differs.
  5. Return `{ newWatermark: pullStartedAt }`. Airtable's API doesn't surface a server-side change-token, so `newCursor` stays unset — `lastIncrementalPullAt` is the only state needed.
- **Filter combination**: extracted into [airtable-incremental.ts](../../server/src/remote-service/connectors/library/airtable/airtable-incremental.ts) (`buildAirtableModifiedSinceFormula`, `combineAirtableFormulas`, `AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS`). Includes Airtable formula escaping for `\`, `}`, and `'`. Reusable when other connectors with similar formula syntax are added later.
- **Discoverability**: `modifiedAtField` is exposed as an entry in `AirtableConnector.advancedSettings` (placeholder: `e.g. Last Modified Time`) so the future folder-settings UI can render it. With auto-detection in place, most users won't need to touch it.
- **Edge case — clock skew**: Airtable's `LAST_MODIFIED_TIME` is server-side; `pullStartedAt` is captured on Scratch's server. If their clocks drift, a record modified seconds before `pullStartedAt` could be missed. Mitigation: `AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS = 60_000` is subtracted from `options.since` when building the formula. Idempotent file commits absorb any duplicates this overlap creates.

### All other connectors (deferred to a follow-up)

Mechanical change only: add `return {}` to the end of each existing `pullRecordFiles` so the new `Promise<PullRecordFilesResult>` return type compiles. `supportsIncrementalPull()` inherits the base `false`. When each connector's incremental implementation lands, it can reuse the [`x-scratch-last-modified-field`](#schema-annotation-x-scratch-last-modified-field) annotation + `findLastModifiedFieldName` helper so the auto-detection path stays identical across connectors — only the formula/filter syntax differs.

The list of connectors that will eventually be implemented (with sketches) is preserved here for future reference:

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

- [server/src/remote-service/connectors/connector.ts](../../server/src/remote-service/connectors/connector.ts) — `supportsIncrementalPull(options, tableSpec)` (default `false`); `pullRecordFiles` returns `PullRecordFilesResult`. ✅ Landed.
- [server/src/remote-service/connectors/types.ts](../../server/src/remote-service/connectors/types.ts) — `PullRecordFilesOptions`, `PullRecordFilesResult`, and `findLastModifiedFieldName(tableSpec)` helper. ✅ Landed.
- [packages/shared-types/src/connector/json-schema.ts](../../packages/shared-types/src/connector/json-schema.ts) — `X_SCRATCH_LAST_MODIFIED_FIELD` annotation constant. ✅ Landed.
- [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts) — `DataFolderOptions.fullPullOnly` ✅ + `DataFolderOptions.modifiedAtField` ✅.
- [server/src/remote-service/connectors/CONNECTOR_GUIDE.md](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md) — document the new contract (mode in options, return shape, capability flag, `x-scratch-last-modified-field` annotation) using Airtable as the worked example. ⏳ Pending.
- [server/src/remote-service/connectors/library/airtable/](../../server/src/remote-service/connectors/library/airtable/) — incremental branch in `pullRecordFiles`; `supportsIncrementalPull(options, tableSpec)` override; `resolveModifiedAtField` helper; schema builder annotates `lastModifiedTime` fields. Helpers in `airtable-incremental.ts`. ✅ Landed.
- All other connectors under [server/src/remote-service/connectors/library/](../../server/src/remote-service/connectors/library/) — trivial `return {}` already added so the new return type compiles. Capability flag inherits base `false`. ✅ Landed.
- [server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts) — resolve effective mode per folder; pass `tableSpec` to `supportsIncrementalPull`; augment `options` with `pullMode`/`since`/`cursor`; conditional `deleteStaleFiles` in Phase 2; persist new watermark/cursor. ✅ Landed.
- [server/src/schedule/scheduler.service.ts](../../server/src/schedule/scheduler.service.ts) — map `Schedule.action` (`FULL_PULL` / `INCREMENTAL_PULL` / legacy `PULL`) to job `pullMode` at enqueue. ⏳ Pending.
- [server/src/schedule/schedule.service.ts](../../server/src/schedule/schedule.service.ts) — surface the two new actions in CRUD; `PULL` remains valid (equivalent to `FULL_PULL`). ⏳ Pending.
- [server/src/schedule/schedule.types.ts](../../server/src/schedule/schedule.types.ts) — update `SCHEDULE_ACTION_TO_JOB_TYPE` with the new actions. ⏳ Pending.
- [server/prisma/schema.prisma](../../server/prisma/schema.prisma) — `DataFolder` columns; add `FULL_PULL` / `INCREMENTAL_PULL` to the `ScheduleAction` enum and mark `PULL` deprecated. ✅ Landed (not yet migrated).
- [server/prisma/migrations/](../../server/prisma/migrations/) — two migrations: (1) add the new enum values + `DataFolder` columns, (2) `UPDATE "Schedule" SET "action" = 'FULL_PULL' WHERE "action" = 'PULL'`. ⏳ Pending.
- [packages/shared-types/src/job-types.ts](../../packages/shared-types/src/job-types.ts) — job `data.pullMode` typing. ⏳ Pending.
- [server/src/workbook/data-folder.controller.ts](../../server/src/workbook/data-folder.controller.ts) — accept `mode` on pull endpoint. ⏳ Pending.
- [server/src/worker-enqueuer/bull-enqueuer.service.ts](../../server/src/worker-enqueuer/bull-enqueuer.service.ts) — optional `pullMode` arg added; threads into job data. ✅ Landed.
- [scratch-git-2/src/cli/](../../scratch-git-2/src/cli/) — `--mode` flag for `scratchmd pull`. ⏳ Pending.

Existing utilities to reuse — not to reinvent:

- [`FileIndexService`](../../server/src/publish-plan/file-index.service.ts) — `upsertBatch` already updates `lastSeenAt`; we keep using it on incremental pulls so a future enhancement can use stale-detection for delete inference if needed.
- [`ScratchGitService.commitFilesToBranch`](../../server/src/scratch-git/scratch-git.service.ts) — idempotent file commits; safe to receive the same record twice across runs.
- [`AssetExtractorService`/`AssetIndexService`](../../server/src/asset/) — already invoked from the per-batch callback; no change needed.
- [`BullEnqueuerService.enqueuePullLinkedFolderFilesJob`](../../server/src/worker-enqueuer/bull-enqueuer.service.ts) — extend its signature, don't add a new enqueue method.
- Connector progress / job progress checkpoint infrastructure ([`base-types.ts`](../../server/src/worker/jobs/base-types.ts), [`bull-worker.service.ts`](../../server/src/worker/bull-worker.service.ts)) — incremental pulls use the existing `connectorProgress` for mid-run resumption; only the cross-run watermark needs new storage on `DataFolder`.

## Verification

1. **Unit**: `pull-linked-folder-files.job.spec.ts` — add cases for (a) bootstrap (null watermark → full), (b) incremental happy path (watermark set, connector called with `since`), (c) connector without support → forced to full, (d) incremental success updates `lastIncrementalPullAt`, doesn't run `deleteStaleFiles`, (e) full run on incremental folder bumps both watermarks, (f) `fullPullOnly = true` demotes incremental to full.
2. **Airtable connector unit tests** ✅ (landed 2026-05-15): `pullRecordFiles` with `pullMode === 'incremental'` (a) injects `IS_AFTER({<resolvedField>}, '<since>')` into the formula, (b) combines correctly with a user-provided `options.filter`, (c) applies the clock-skew overlap, (d) returns `{ newWatermark }`, (e) returns `{}` when `pullMode === 'full'`. `supportsIncrementalPull(options, tableSpec)` returns false when neither `modifiedAtField` is set nor the schema has an annotated field, true when either is present, and explicit `modifiedAtField` takes precedence over the schema annotation. Plus schema-builder tests asserting `lastModifiedTime` Airtable fields get tagged with `x-scratch-last-modified-field: true`.
3. **Integration** (`yarn test:integration`): end-to-end against a real Airtable test base with a `Last Modified Time` field — bootstrap pull, modify a record, incremental pull, assert only the modified record's file changed in git, watermark advanced.
4. **Manual** (Airtable):
   - **Auto-detection path**: Create an Airtable folder against a table that already has a Last Modified Time field. Leave `dataFolder.options.modifiedAtField` unset. Trigger `scratchmd pull --mode incremental` → full bootstrap, `lastIncrementalPullAt` populated. Modify one record, trigger again → only that file touched in git. Verify the schema written to git contains `x-scratch-last-modified-field: true` on that field.
   - **Explicit override path**: Add a second Last Modified Time field to the same Airtable table (scoped to different columns). Set `dataFolder.options.modifiedAtField` to the second field's name. Trigger `--mode incremental` → formula uses the second field, not the auto-detected one.
   - **No last-modified field**: Use an Airtable table with no `lastModifiedTime` column and no `modifiedAtField` set. Trigger `--mode incremental` → silently runs full with a logged warning (`supportsIncrementalPull() = false`).
   - Modify one record in Airtable. Trigger `scratchmd pull --mode incremental` → only that file touched in git, no deletions, watermark advanced.
   - Delete a remote record. Incremental pull → not detected (expected). Full pull → deleted in git, `lastFullPullAt` updated, `lastIncrementalPullAt` also advanced.
   - Set `dataFolder.options.fullPullOnly = true`. Trigger `--mode incremental` → silently runs full (log entry confirms demotion); incremental state unchanged.
   - Create two schedules on the same Airtable folder — `action = INCREMENTAL_PULL` at `*/5 * * * *` and `action = FULL_PULL` at `0 3 * * *`. Verify both rows insert cleanly under the existing `@@unique([workbookId, action, entityId])` constraint and `SchedulerService` enqueues each with the correct `pullMode`.
   - Before deploying, seed a test DB with `action = 'PULL'` rows; after running the migration, verify all are now `'FULL_PULL'` (their `id`, `cronExpression`, `nextRunAt` unchanged) and continue firing on schedule.
   - Verify a new `action = 'PULL'` row inserted post-migration still fires and behaves identically to `FULL_PULL` (runtime tolerance is preserved).
   - Trigger `--mode incremental` on a non-Airtable connector → silently runs full with a logged warning (capability flag still false everywhere else).
5. `yarn build` and `yarn lint` from repo root pass.

Once this end-to-end loop is validated against Airtable, a follow-up plan implements the remaining connectors using the same framework.
