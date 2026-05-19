# Incremental Polling — Follow-up: More Connectors + Web UI

**Date**: 2026-05-16
**Status**: Track 1 — **PostgreSQL + Supabase + Notion landed 2026-05-17** (Webflow deferred — see Out of scope) · **Track 2 (Web UI) landed 2026-05-16**. All in-scope Track 1 connectors complete (integration test deferred — see Track 1 tests note).
**Linear**: [DEV-9757](https://linear.app/whalesync/issue/DEV-9757/incremental-polling)
**Depends on**: [2026-05-14-incremental-polling.md](2026-05-14-incremental-polling.md) (server pipeline + Airtable, landed; scheduler/API/CLI landed in `7fd093ce`)
**Scope**: Two independent tracks that can ship separately —

1. Extend the incremental-pull contract to **PostgreSQL, Supabase, Notion**.
2. **Web client UI** on the Workspace page: incremental pull menu actions, separate full/incremental schedules, and the last-modified-field control in Advanced Settings.

> **Update 2026-05-17:** `fullPullOnly` was dropped from the feature entirely — removed from `DataFolderOptions`, the pull-job demotion logic, and the Advanced Settings UI. References to it below are retained for history but struck through where they described removed behavior.
>
> **Update 2026-05-17:** Webflow incremental pull (§1a) is **deferred** (user decision) — not implemented in this iteration. `incrementalPull` stays `false` for Webflow; it full-scans as today. The §1a design is retained below marked DEFERRED; all active Track 1 references (status, variant table, tests, critical files, open questions) exclude Webflow, and Webflow is listed under Out of scope.

## Context

The initial plan landed the full server pipeline (connector contract, `PullLinkedFolderFilesJob`, scheduler/API/CLI mode plumbing) and proved it end-to-end against **Airtable only**. Every other connector still inherits `supportsIncrementalPull() = false` and full-scans. There is **no UI** — `fullPullOnly`, `modifiedAtField`, and the `FULL_PULL` / `INCREMENTAL_PULL` schedule actions are reachable only via API/CLI. `PullScheduleModal` still hardcodes the deprecated `ScheduleAction.PULL`.

This follow-up does two things: (1) implement the incremental branch in three more connectors using the Airtable pattern, adapted to each API's modified-since mechanism; (2) expose the whole feature in the web client so users can actually configure and trigger it.

The two tracks are independent. Track 1 needs no UI; Track 2's manual-trigger and schedule pieces work against Airtable today and light up automatically for the new connectors as Track 1 lands. The only shared dependency is the **connector capability flag** (below), which Track 2 needs to gate UI and Track 1 sets per connector.

## Approach

### Shared: advertise incremental capability to the client

`Connector.supportsIncrementalPull(options, tableSpec)` is a _runtime, per-folder_ resolver (it depends on the folder's options and the table schema). The UI needs a _static, per-connector_ answer — "does this connector type implement incremental pulls at all?" — to decide whether to show incremental menu items, the `fullPullOnly` switch, and the incremental schedule row.

Add a static flag to `ConnectorMetadata` rather than overloading the runtime method:

- [packages/shared-types/src/connector/metadata.ts](../../packages/shared-types/src/connector/metadata.ts): add `incrementalPull: boolean` to `ConnectorMetadata`; default `false` in `DEFAULTS`.
- Set `incrementalPull: true` in the `connectorMetadata({...})` call of each connector that implements the contract: Airtable (already implemented), plus PostgreSQL, Supabase, Notion as Track 1 lands them. (Webflow deferred — see Out of scope; stays `false`.)
- This is the same pattern as `supportedAuthMethods` / `visible`. It is already fetched globally by the client via `useConnectorsMetadata()` (keyed by `Service`), so both the tree context menus and the Advanced Settings modal can read it with no new endpoint.

This static flag is the single source of truth for "show the incremental UI." The runtime `supportsIncrementalPull(options, tableSpec)` still governs whether a given _folder's_ run actually goes incremental or gets demoted to full by the job — unchanged from the base plan. A folder whose connector advertises `incrementalPull: true` but has no resolvable last-modified field still demotes to full at job time (existing behavior); the UI may optionally warn about this (see [2d](#2d-advanced-settings-last-modified-time-field-dropdown)).

---

## Track 1 — Extend connector support

The Airtable reference implementation (see base plan, landed) establishes the pattern:

1. **Schema annotation** (where the API has a typed last-modified field): the connector's JSON-schema builder tags that field with `X_SCRATCH_LAST_MODIFIED_FIELD = 'x-scratch-last-modified-field'` so `findLastModifiedFieldName(tableSpec)` (in [connectors/types.ts](../../server/src/remote-service/connectors/types.ts)) auto-detects it.
2. **`advancedSettings`** entry `modifiedAtField` (string) for the explicit override, registered through `connectorRegistry.register({ ..., advancedSettings })`.
3. **`resolveModifiedAtField(options, tableSpec)`** private helper: prefer trimmed `options.modifiedAtField`, else `findLastModifiedFieldName(tableSpec)`.
4. **`supportsIncrementalPull(options, tableSpec)`** override: `return this.resolveModifiedAtField(...) !== undefined` (or unconditional `true` for connectors with a fixed system field — Notion).
5. **`pullRecordFiles` incremental branch**: capture `newWatermark = new Date()` _before the first API call_; build a modified-since predicate from `options.since` (minus a clock-skew margin); combine with any user `options.filter`; return `{ newWatermark }`. Full pulls fall through unchanged and `return {}`.
6. Set `ConnectorMetadata.incrementalPull: true` for the connector (see Shared section).

Each connector differs only in step 1 (which field) and step 5 (the API's modified-since mechanism). The variants below are summarized first, then detailed.

| Connector  | Modified-since mechanism                                        | Last-modified field                                             | Clock-skew margin                                                             |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| PostgreSQL | SQL `WHERE <col> > $since` via Knex builder                     | user-declared `modifiedAtField` (no convention)                 | 60s                                                                           |
| Supabase   | identical to PostgreSQL (shared `KnexPGClient`)                 | user-declared `modifiedAtField`                                 | 60s                                                                           |
| Notion     | `databases.query` `filter` on `last_edited_time`                | fixed system field `last_edited_time` (always present)          | 0 (Notion timestamp is server-side and the filter is inclusive `on_or_after`) |

Reuse the Airtable helper-module idea: each connector gets a small `*-incremental.ts` with its predicate builder + filter-combiner + clock-skew constant, mirroring [airtable-incremental.ts](../../server/src/remote-service/connectors/library/airtable/airtable-incremental.ts). Do **not** try to share one helper across connectors — the predicate syntaxes (Airtable formula, SQL, Notion JSON, JS comparison) have nothing in common; only the _shape_ of the code is shared.

### 1a. Webflow — ⏸️ DEFERRED (2026-05-17 — not in this iteration)

> **Deferred by user decision (2026-05-17).** Webflow incremental pull is **not being implemented at this time**. The design below is retained for a possible future iteration; it is **not** active Track 1 work and Webflow is listed under [Out of scope](#out-of-scope). Skip to [1b](#1b-postgresql--supabase-shared-pg-common) for active work. Everything in this subsection is design-only until the deferral is lifted.

[server/src/remote-service/connectors/library/webflow/](../../server/src/remote-service/connectors/library/webflow/)

Webflow's CMS/Assets/Pages list endpoints have **no `modified_since` parameter**. `pullRecordFiles` has three fetch paths (collection items via `client.collections.items.listItems`, assets via `pullAssets`, pages via `pullPages`), each offset-paginated and each returning a `lastUpdated` ISO timestamp per record.

- **Schema annotation** ([webflow-json-schema.ts](../../server/src/remote-service/connectors/library/webflow/webflow-json-schema.ts)): add `[X_SCRATCH_LAST_MODIFIED_FIELD]: true` to the `lastUpdated` property in the **collection-items schema, the assets schema, and the pages schema** (three sites in the file). Auto-detection then works for all three table types with zero configuration.
- **`advancedSettings`**: currently `[]`. Add a `modifiedAtField` string entry (placeholder `e.g. lastUpdated`) and register it via the connector's `connectorRegistry.register({ ..., advancedSettings: WebflowConnector.advancedSettings })`. Auto-detection covers the default; the override exists for parity.
- **`supportsIncrementalPull`**: `resolveModifiedAtField(...) !== undefined` (will be defined via auto-detect on all three table types).
- **Incremental branch** — because there is no server-side filter, this is a **client-side filter applied during pagination**:
  1. Capture `newWatermark = new Date()` before the first list call.
  2. Compute `cutoff = options.since - WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS` (60_000).
  3. In each of the three fetch paths, after fetching a page, drop records whose `lastUpdated <= cutoff` before handing them to the `callback`. Keep paginating to the end (Webflow does not guarantee modified-time ordering, so we cannot early-terminate safely unless we explicitly request sort order — see note).
  4. Combine with the existing behavior: Webflow does not support a user `options.filter` today, so there is nothing to combine; just apply the cutoff predicate.
  5. Return `{ newWatermark }`.
  - **Optimization note (optional, document but not required for v1):** if the Webflow SDK exposes `sortBy`/`sortOrder` on `listItems`, request `lastUpdated` descending and early-terminate once a full page is older than `cutoff`. Verify SDK support before relying on it; assets/pages endpoints may not support sort, so the safe default is full pagination + client-side filter. The cost saved is network/processing only — Webflow's quota is per-request, and we still page through everything, so the primary win for Webflow is **skipping git writes for unchanged records**, not API quota.
- **Helper module** `webflow-incremental.ts`: `WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS`, `isWebflowRecordModifiedSince(record, cutoff, modifiedAtField)`.

### 1b. PostgreSQL & Supabase (shared `pg-common`)

[postgres/postgres-connector.ts](../../server/src/remote-service/connectors/library/postgres/postgres-connector.ts), [supabase/supabase-connector.ts](../../server/src/remote-service/connectors/library/supabase/supabase-connector.ts), shared client [pg-common/knex-pg-client.ts](../../server/src/remote-service/connectors/library/pg-common/knex-pg-client.ts).

Both connectors are independent classes but both pull via `KnexPGClient.selectAll(schema, tableName, columns, primaryId, limit, offset, filter?)`. SQL has no last-modified convention, so there is **no schema annotation** — incremental support is gated entirely on the user declaring `modifiedAtField`.

- **`KnexPGClient.selectAll`**: extend the signature with two optional trailing params:
  ```ts
  filter?: string,
  modifiedSinceColumn?: string,
  modifiedSinceDatetime?: Date,
  ```
  When both `modifiedSinceColumn` and `modifiedSinceDatetime` are provided, append a **parameterized** Knex predicate: `query.where(ref(modifiedSinceColumn), '>', modifiedSinceDatetime)` using Knex column-ref quoting — never string-interpolate the column name or the date. This composes with the existing raw `whereRaw(filter)` (Knex ANDs them). The change is in `pg-common`, so both connectors inherit it; nothing else in `selectAll` changes (ordering/offset pagination unchanged).
- **Each connector** (`postgres-connector.ts`, `supabase-connector.ts`) — symmetric changes:
  - Add `advancedSettings` with a `modifiedAtField` string entry (placeholder `e.g. updated_at`), registered via that connector's `connectorRegistry.register({ ..., advancedSettings })`.
  - `resolveModifiedAtField(options, tableSpec)`: explicit `options.modifiedAtField` only (no `findLastModifiedFieldName` fallback — no annotation exists for SQL). Keep the helper shape identical for consistency.
  - `supportsIncrementalPull`: `return this.resolveModifiedAtField(options) !== undefined`.
  - `pullRecordFiles` incremental branch: capture `newWatermark = new Date()` before the first `selectAll`; compute `since - PG_INCREMENTAL_CLOCK_SKEW_MS` (60_000); pass `modifiedSinceColumn` + adjusted date into every paginated `selectAll` call; return `{ newWatermark }`.
  - Validate the user-supplied column name against the table schema before use (it comes from user options): confirm `modifiedAtField` exists in the columns built from `information_schema.columns` and reject otherwise, so a typo fails fast rather than producing a SQL error mid-pull. Reuse the column list the connector already fetches when building the schema.
- **Helper module** `pg-common/pg-incremental.ts` (shared by both): `PG_INCREMENTAL_CLOCK_SKEW_MS`, and a thin wrapper if useful. Keep it in `pg-common` since both connectors and `KnexPGClient` live there.

### 1c. Notion — ✅ landed 2026-05-17

[notion/notion-connector.ts](../../server/src/remote-service/connectors/library/notion/notion-connector.ts), [notion/notion-json-schema.ts](../../server/src/remote-service/connectors/library/notion/notion-json-schema.ts), [notion/notion-incremental.ts](../../server/src/remote-service/connectors/library/notion/notion-incremental.ts).

Notion has a **fixed system field** `last_edited_time` on every page and a real server-side filter via `databases.query({ filter, sorts, start_cursor })`. `NotionPullOptions extends PullRecordFilesOptions` already exists (`filter`, `excludePageContent`, `childContentMaxDepth`, `pageSize`).

- **Schema annotation** ([notion-json-schema.ts](../../server/src/remote-service/connectors/library/notion/notion-json-schema.ts)): add `[X_SCRATCH_LAST_MODIFIED_FIELD]: true` to the top-level `last_edited_time` property. This is mostly for the UI dropdown (2d) — the connector itself can hardcode the field since it is always `last_edited_time`.
- **`advancedSettings`**: leave the three existing entries; **do not** add `modifiedAtField` — Notion's last-modified field is not user-selectable. (If a `modifiedAtField` is ever set in options it is ignored.)
- **`supportsIncrementalPull`**: return `true` unconditionally — `last_edited_time` is guaranteed present on every Notion database.
- **Incremental branch** in `pullRecordFiles`:
  1. Capture `newWatermark = new Date()` before the first `databases.query`.
  2. Build the timestamp filter: `{ timestamp: 'last_edited_time', last_edited_time: { on_or_after: options.since.toISOString() } }`. `on_or_after` is inclusive, so no clock-skew subtraction is needed (idempotent commits absorb the boundary record); `NOTION_INCREMENTAL_CLOCK_SKEW_MS = 0` for documentation parity.
  3. Combine with the parsed user filter: if `options.filter` is present, wrap as `{ and: [ <userFilter>, <timestampFilter> ] }`; else use the timestamp filter alone. **Edge case:** Notion compound filters allow only one level of nesting. If the user's filter is itself a compound `and`/`or`, wrapping it in another `and` exceeds Notion's nesting limit and the query will 400. Detect a top-level compound user filter and, in that case, **demote to full pull with a logged warning** rather than constructing an invalid query (the job already tolerates connector-side demotion conceptually; here the connector simply does a full scan and returns `{}`). Document this limitation in `CONNECTOR_GUIDE.md`.
  4. Pass cursor-based pagination through unchanged (`start_cursor` / `has_more`); the filter is constant across pages.
  5. Return `{ newWatermark }`.
- **Helper module** `notion-incremental.ts`: `buildNotionLastEditedFilter(since)`, `combineNotionFilters(userFilter, tsFilter)` (with the nesting-limit guard), `NOTION_INCREMENTAL_CLOCK_SKEW_MS = 0`.

### 1d. CONNECTOR_GUIDE.md

The base plan left the guide update pending. Complete it here with the now-multiple worked examples, documenting the three modified-since archetypes so future connectors pick the right one:

- **Server-side predicate** (Airtable formula, SQL `WHERE`, Notion filter) — preferred; combine with user filter.
- **Client-side filter during pagination** — when the API has no `modified_since` param; filter records in-process while paginating. **No connector implements this yet** (the Webflow design that would have is deferred — see Out of scope); document the archetype and why early-termination needs guaranteed sort order so the first connector to need it picks the right pattern.
- **Opaque cursor / change feed** (none yet; keep the base plan's note).

Document: the `resolveModifiedAtField` two-layer precedence, the `X_SCRATCH_LAST_MODIFIED_FIELD` annotation, the watermark-before-first-call rule, per-connector clock-skew rationale, the `ConnectorMetadata.incrementalPull` static flag, and the Notion nesting-limit demotion.

### Track 1 tests

Per connector, mirroring the Airtable specs:

- `supportsIncrementalPull` truthiness (PG/Supabase: with/without resolvable field; Notion: always true).
- `pullRecordFiles` with `pullMode: 'incremental'`: predicate built correctly, combined with a user filter, clock-skew applied (where applicable), `{ newWatermark }` returned; `pullMode: 'full'` returns `{}` and ignores `since`.
- Schema-builder spec: Notion `last_edited_time` gets `x-scratch-last-modified-field: true`.
- `KnexPGClient.selectAll` spec: with `modifiedSinceColumn`+`modifiedSinceDatetime` emits a parameterized `> ` predicate that ANDs with an existing raw filter; absent → query unchanged.
- Notion compound-filter nesting-limit guard demotes to full.
- Integration (`yarn test:integration`) against a real test source per connector where infra exists (at minimum Notion and one SQL): bootstrap full → modify one record → incremental → only that record's file changes in git, watermark advances.
  - **Status 2026-05-17:** Notion unit + schema-builder + nesting-limit specs landed (`notion-incremental.spec.ts`, `notion-json-schema.spec.ts`, `notion-connector-incremental.spec.ts`; all green, 129/129 in the notion suite). The SQL integration test landed with §1b. **A Notion `test:integration` round-trip is still pending** — it needs a dedicated Notion test database + credentials wired into the integration harness, which is not yet in place; tracked as remaining Track 1 follow-up, not a blocker for the connector landing.

---

## Track 2 — Web client UI (Workspace page)

All paths are relative to [client/](../../client/). Read [client/src/app/components/UI_SYSTEM.md](../../client/src/app/components/UI_SYSTEM.md) before writing UI. Server endpoints already accept `mode` (`pull-files` DTO + `WorkbookService.pullFiles(..., pullMode)`, landed `7fd093ce`) and the `FULL_PULL`/`INCREMENTAL_PULL` schedule actions (`schedule.service.ts`, `scheduleActionToPullMode`, landed). The client just needs to drive them.

### 2a. Thread `mode` through the client pull path

- [client/src/lib/api/workbook.ts](../../client/src/lib/api/workbook.ts) `pullFiles(id, dataFolderIds?)` → add `mode?: 'full' | 'incremental'`; include `mode` in the POST body to `/workbook/:id/pull-files` (server DTO already validates it).
- [client/src/hooks/use-workbook.ts](../../client/src/hooks/use-workbook.ts) `pullFolders(folderIds?)` → add `opts?: { mode?: 'full' | 'incremental' }`; pass through to `workbookApi.pullFiles`. Keep the default (`undefined` → server resolves to `'full'`) so all existing callers are unchanged.
- Analytics: add a `mode` property to the existing `trackPullFiles` call (per [client/CLAUDE.md](../../client/CLAUDE.md): track in the hook; never log credentials).

### 2b. Incremental pull menu actions

[client/src/app/workbook/[id]/components/Sidebar/TreeNode.tsx](../../client/src/app/workbook/[id]/components/Sidebar/TreeNode.tsx)

Gate both items on the connector's static capability. The component already has `connectorAccount`/`group` with the `Service`; read `useConnectorsMetadata()` and check `metadata[service]?.incrementalPull`. When false, render only the existing full-pull items (no disabled/greyed item — keep the menu clean).

- **Connector menu** (`ConnectionNode`, `extraItemsBefore` ~L467): add `{ label: 'Pull All Tables (Incremental)', icon: CloudDownloadIcon, onClick: handlePullAllIncremental }` directly under the existing "Pull All Tables". `handlePullAllIncremental` = `pullFolders(connectionFolderIds, { mode: 'incremental' })`.
- **Table menu** (`TableNode` context menu ~L811): add `{ label: 'Pull this table (Incremental)', icon: CloudDownloadIcon, onClick: handlePullTableIncremental }` under "Pull this table". `handlePullTableIncremental` = `pullFolders([folder.id], { mode: 'incremental' })`.

Behavior note for the plan reviewer: a folder configured `fullPullOnly` or lacking a resolvable last-modified field still demotes to full at job time (base-plan behavior). The menu item triggering a full pull in that case is acceptable and consistent with the base design; no client-side pre-check needed.

### 2c. Advanced Settings — `fullPullOnly` switch — ❌ REMOVED (2026-05-17)

Implemented, then dropped. `fullPullOnly` no longer exists anywhere: removed from `DataFolderOptions` ([dtos.ts](../../packages/shared-types/src/connector/dtos.ts)), from the per-folder demotion in [pull-linked-folder-files.job.ts](../../server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts) (and its job-spec case), and from the Advanced Settings modal. Per-folder demotion to full now stacks only on capability + bootstrap. There is no replacement control — a folder that shouldn't run incremental simply isn't given an `INCREMENTAL_PULL` schedule and isn't triggered with `mode=incremental`.

### 2d. Advanced Settings — "Last modified time field" dropdown

Today `modifiedAtField` is a `type: 'string'` `ConnectorSettingDefinition` rendered by the generic `ConnectorSettingField` as a free-text `TextInput`. Replace that with a searchable Select populated from the folder's actual schema, while keeping a free-text fallback (SQL columns may not be typed as timestamps, and we shouldn't block a valid-but-untyped choice).

Two implementation options — **recommended: option A** (keeps the generic settings renderer reusable):

- **Option A — new setting type.** Add `'field-select'` to `ConnectorSettingDefinition.type` in [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts). In `ConnectorSettingField`, render a Mantine `Select` (`searchable`, with an Autocomplete-style "use typed value" fallback) when `setting.type === 'field-select'`. Change each SQL connector's `modifiedAtField` entry to `type: 'field-select'`. The field options come from a new prop the modal passes down (schema field list).
- **Option B — special-case `modifiedAtField`** in the modal by key. Less invasive to shared-types but leaks a magic key into the generic renderer; not recommended.

Field-options source: fetch the folder's flattened schema fields via the existing **`GET /data-folder/:id/schema-paths`** endpoint ([client/src/lib/api/data-folder.ts](../../client/src/lib/api/data-folder.ts) — add a `getSchemaPaths` fn + `SWR_KEYS.dataFolders.schemaPaths` key if not present; server returns `SchemaField[]` with name/path/type, already traversal-aware for nested vs flat schemas). Build options as:

1. Fields whose schema node carries `x-scratch-last-modified-field: true` first, labeled "(auto-detected)" — this requires the raw schema, so prefer `GET /data-folder/:id/schema` (already wired as `dataFolderApi.getSchema` / `SWR_KEYS.dataFolders.schema`) and walk it, OR have `schema-paths` surface the annotation. Pick whichever is least server change; the raw-schema walk reusing `findLastModifiedFieldName`-equivalent logic on the client is acceptable.
2. Then date/datetime-typed fields.
3. Then all remaining fields (searchable), plus accept a custom typed value.

Pre-select the auto-detected field as the placeholder/hint so users with a typed last-modified column (Airtable auto) see it works with no input. Notion does not expose `modifiedAtField` so this control simply does not render for Notion (no such advancedSetting).

### 2e. Separate full vs incremental schedules

[client/src/app/workbook/[id]/components/shared/PullScheduleModal.tsx](../../client/src/app/workbook/[id]/components/shared/PullScheduleModal.tsx) and the list view [client/src/app/workbook/[id]/components/MainPane/ScheduledRunsView.tsx](../../client/src/app/workbook/[id]/components/MainPane/ScheduledRunsView.tsx).

Today the modal is a single frequency `Select` hardcoded to `ScheduleAction.PULL`. The DB allows one schedule per `(workbookId, action, entityId)`, so a folder can hold one `FULL_PULL` **and** one `INCREMENTAL_PULL` simultaneously.

Redesign the modal to two independent frequency rows:

- **Full pull** row → manages the `FULL_PULL` schedule. Always shown.
- **Incremental pull** row → manages the `INCREMENTAL_PULL` schedule. Shown only when the connector's `incrementalPull` capability is true (read from `useConnectorsMetadata()` by `folder.connectorService`).

Each row independently does create / update (`cronExpression`) / delete (switch to "Manual only"), using `scheduleApi`, parameterized by action — generalize the current single-schedule save logic into a per-action helper. Read existing schedules from `folder.schedules` (already includes all actions).

**Legacy `PULL` handling:** treat an existing `PULL` schedule as the folder's full-pull schedule for display. On save of the Full row when a legacy `PULL` schedule exists: since `UpdateScheduleDto` cannot change `action`, delete the `PULL` row and create a `FULL_PULL` row with the chosen cron (preserving name). This converges the DB to the new naming through normal use, consistent with the base plan's data-migration intent. Document this; it is the only place the UI mutates legacy rows.

`ScheduledRunsView` `getActionLabel()` / `getActionColor()`: add `FULL_PULL` → "Full Pull", `INCREMENTAL_PULL` → "Incremental Pull"; relabel legacy `PULL` → "Full Pull (legacy)" so the two are visually distinct in the runs table.

Server already validates these actions in `schedule.service.ts` (`isPullAction`, `scheduleActionToPullMode`) and the scheduler maps them to `pullMode` — no server change required for this sub-feature. `CreateScheduleDto` accepts the enum via `@IsEnum(ScheduleAction)`.

Optional nicety (note, not required for v1): if the incremental row is enabled but the folder has no resolvable last-modified field (connector advertises `incrementalPull` but `modifiedAtField` unset and nothing auto-detected), show an inline warning that incremental runs will demote to full until a field is configured. Detecting this client-side reuses the 2d schema/annotation lookup.

### Track 2 tests

- Client unit/component tests where the repo has them: `pullFolders`/`pullFiles` thread `mode`; menu items hidden when `incrementalPull` false; Advanced Settings reads/writes `fullPullOnly` and `modifiedAtField`; `PullScheduleModal` create/update/delete per action and the legacy-`PULL`→`FULL_PULL` conversion path.
- Manual: against an Airtable folder (already incremental) and one Track-1 connector — trigger each menu item and confirm job mode; set/unset `fullPullOnly` and confirm demotion; pick a `modifiedAtField` from the dropdown; configure both a `FULL_PULL` and `INCREMENTAL_PULL` schedule on one folder and confirm both rows persist under the unique constraint and the runs view labels them distinctly.
- `yarn build` and `yarn lint` from repo root.

---

## Out of scope

- Connectors beyond PostgreSQL / Supabase / Notion (HubSpot, Shopify, Linear, WordPress, etc. remain `false`; the base plan's table tracks them).
- **Webflow incremental pull — deferred (2026-05-17, user decision).** Not implemented in this iteration; `incrementalPull` stays `false` for Webflow and it full-scans as today. The §1a design is retained (marked DEFERRED) for a future iteration.
- Removing the `PULL` enum value (still deferred to the base plan's cleanup migration; this plan only converges rows opportunistically via the schedule modal).
- Webhook / change-data-capture / deletion feeds.
- Connector-level (workbook-wide) schedule management — schedules remain per-DataFolder; only the modal gains a second action row.

## Critical files

**Track 1 — server**

- [packages/shared-types/src/connector/metadata.ts](../../packages/shared-types/src/connector/metadata.ts) — add `ConnectorMetadata.incrementalPull` (default false). ✅ landed 2026-05-16 (Track 2)
- ~~[server/src/remote-service/connectors/library/webflow/](../../server/src/remote-service/connectors/library/webflow/) — annotate `lastUpdated` (items/assets/pages); `advancedSettings`; `supportsIncrementalPull`; client-side filter branch; `webflow-incremental.ts`; `incrementalPull: true` metadata.~~ ⏸️ DEFERRED (2026-05-17) — see §1a / Out of scope.
- [server/src/remote-service/connectors/library/pg-common/knex-pg-client.ts](../../server/src/remote-service/connectors/library/pg-common/knex-pg-client.ts) — `selectAll` gains `modifiedSinceColumn`/`modifiedSinceDatetime` (parameterized `knex.ref(col) > date`, ANDs with raw filter). ✅ landed 2026-05-17
- [server/src/remote-service/connectors/library/postgres/postgres-connector.ts](../../server/src/remote-service/connectors/library/postgres/postgres-connector.ts) & [supabase/supabase-connector.ts](../../server/src/remote-service/connectors/library/supabase/supabase-connector.ts) — `advancedSettings` (`modifiedAtField` field-select), resolver, `supportsIncrementalPull` override, incremental branch, column validation, `incrementalPull: true` metadata, registered `advancedSettings`. ✅ landed 2026-05-17
- [server/src/remote-service/connectors/library/pg-common/pg-incremental.ts](../../server/src/remote-service/connectors/library/pg-common/) — new shared helper (`PG_INCREMENTAL_CLOCK_SKEW_MS`, `resolvePgModifiedAtField`, `applyPgClockSkew`, `assertModifiedAtColumnExists`); exported via `pg-common/index.ts`. ✅ landed 2026-05-17
- [server/src/remote-service/connectors/library/notion/notion-connector.ts](../../server/src/remote-service/connectors/library/notion/notion-connector.ts) & [notion-json-schema.ts](../../server/src/remote-service/connectors/library/notion/notion-json-schema.ts) — annotated top-level `last_edited_time` with `X_SCRATCH_LAST_MODIFIED_FIELD`; `supportsIncrementalPull()` returns `true` unconditionally; `pullRecordFiles` incremental branch with compound-filter nesting-limit demotion; new `notion-incremental.ts` helper; `incrementalPull: true` metadata. ✅ landed 2026-05-17
- [server/src/remote-service/connectors/CONNECTOR_GUIDE.md](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md) — added "Incremental Pulls" section: the full contract (static `incrementalPull` flag, `resolveModifiedAtField` precedence, `X_SCRATCH_LAST_MODIFIED_FIELD`, watermark-before-first-call, clock-skew), the three archetypes, and the SQL + Notion server-side-predicate worked examples (Notion incl. the nesting-limit demotion). ✅ landed 2026-05-17. (Webflow worked example deferred with §1a.)

**Track 2 — client / shared-types — ✅ landed 2026-05-16**

- [packages/shared-types/src/connector/metadata.ts](../../packages/shared-types/src/connector/metadata.ts) — `ConnectorMetadata.incrementalPull` (default `false`); set `true` on Airtable. ✅
- [client/src/lib/api/workbook.ts](../../client/src/lib/api/workbook.ts), [client/src/hooks/use-workbook.ts](../../client/src/hooks/use-workbook.ts), [client/src/lib/posthog.ts](../../client/src/lib/posthog.ts) — `pullFiles`/`pullFolders` thread `mode`; `trackPullFiles` records it. ✅
- [client/src/app/workbook/[id]/components/Sidebar/TreeNode.tsx](../../client/src/app/workbook/[id]/components/Sidebar/TreeNode.tsx) — two incremental menu items, capability-gated via `useConnectorsMetadata`. ✅
- [client/src/app/workbook/[id]/components/shared/AdvancedFolderSettingsModal.tsx](../../client/src/app/workbook/[id]/components/shared/AdvancedFolderSettingsModal.tsx) — `field-select` rendered as a schema-fed `Autocomplete` with auto-detected hint. ✅ (`fullPullOnly` switch removed 2026-05-17 — see 2c.)
- [packages/shared-types/src/connector/dtos.ts](../../packages/shared-types/src/connector/dtos.ts) — `ConnectorSettingDefinition.type` gains `'field-select'` (Option A); Airtable `modifiedAtField` switched to it. ✅
- [client/src/app/workbook/[id]/components/shared/PullScheduleModal.tsx](../../client/src/app/workbook/[id]/components/shared/PullScheduleModal.tsx) — two-row full/incremental schedule UI; legacy `PULL` updated/deleted in place (no modal-driven convergence — handled by a separate migration script per open-question #3). ✅
- [client/src/app/workbook/[id]/components/MainPane/ScheduledRunsView.tsx](../../client/src/app/workbook/[id]/components/MainPane/ScheduledRunsView.tsx) — distinct labels/colors for `FULL_PULL`/`INCREMENTAL_PULL`/legacy `PULL`. ✅
- Schema field source: used the already-wired raw-schema fetch (`dataFolderApi.getSchema` + `SWR_KEYS.dataFolders.schema`, `'view'` mode) and walked it client-side — no new endpoint or SWR key needed (the 2d "least server change" option).

**Already in place (no change needed) — confirmed during research**

- `pull-files` DTO + `WorkbookService.pullFiles(..., pullMode)` accept `mode` (landed `7fd093ce`).
- `ScheduleAction` enum (`FULL_PULL`/`INCREMENTAL_PULL`), `schedule.service.ts` CRUD, `scheduleActionToPullMode`, scheduler mode mapping (landed).
- `PullLinkedFolderFilesJob` effective-mode/watermark logic, `findLastModifiedFieldName`, `X_SCRATCH_LAST_MODIFIED_FIELD`, `PullRecordFilesOptions/Result` (base plan, landed).

## Open questions

1. ~~**Webflow early-termination**~~ — **moot**: Webflow incremental deferred (2026-05-17). See Out of scope / §1a.
2. **Field-select setting type (2d)**: Option A (new shared-types `type`) vs Option B (modal special-cases the key). Recommendation: Option A for a reusable renderer; flagged here because it touches shared-types consumed by client + server.
   ANSWER: use option A
3. **Legacy `PULL` convergence (2e)**: convert `PULL`→`FULL_PULL` on edit via delete+recreate (recommended, converges DB) vs leave `PULL` untouched and only ever create new `FULL_PULL`/`INCREMENTAL_PULL` rows (less DB churn, slower convergence). The base plan's data migration is the primary converger; this is belt-and-suspenders.
   ANSWER: I will manually do a migration script to convert exsting PULL actions to FULL_PULL
