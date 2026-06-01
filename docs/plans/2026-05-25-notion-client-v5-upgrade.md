# Upgrade `@notionhq/client` 3.1.3 → 5.22.0

**Date**: 2026-05-25
**Status**: Phases 1-3 complete; Phase 4 (SDK bump) and Phase 5 (2026-03-11 adoption) pending
**Linear**: DEV-8910
**Author**: Chris Hoefgen
**Branch**: `dev-8910-upgrade-notion-client-notionhqclient-from-313-to-latest-5xx`

**Scope**: Upgrade the server's Notion SDK from `^3.1.3` to `5.22.0`. This crosses two major versions and pulls in the Notion API's **2025-09-03 data sources** redesign plus the smaller **2026-03-11** changes (`archived` → `in_trash`, block `after` → `position`, `transcription` → `meeting_notes`). Affects the NotionConnector, its schema parser, incremental pull, block diff executor, and ~11 test files.

Out of scope: changing the OAuth flow (the provider at [notion-oauth.provider.ts](server/src/oauth/providers/notion-oauth.provider.ts) hand-rolls `fetch` against `api.notion.com/v1/oauth/`* and doesn't touch the SDK), and any Notion-specific UI changes in the client.

> **Note — page content writes are not currently supported by the Notion connector.** [notion-json-schema.ts](server/src/remote-service/connectors/library/notion/notion-json-schema.ts) flags `page_content` with `X_SCRATCH_READONLY: true`, and [notion-connector.ts](server/src/remote-service/connectors/library/notion/notion-connector.ts)'s `updateRecords` only sends `properties` to `pages.update`. The block-diff push machinery (`createNotionBlockDiff` + `NotionBlockDiffExecutor`, including its `delete`/`create`/`update`/`update_children` operations) is wired up to a `private updatePageContent` method that **is unreferenced** — it has been dead code since commit `28e1e423` ("Removed old file publishing"). Any phase that re-introduces page-content writes is a separate work item, not part of DEV-8910. Manual testing of the block-diff executor (Appendix A § 6) is **deferred** for the same reason.

---

## Problem

`@notionhq/client@3.1.3` targets the `2022-06-28` Notion API version. The Notion team:

1. Released the **2025-09-03 API version** that introduces **data sources** — a database is now a *container* of one or more data sources, and properties + rows live on the data source rather than the database. The legacy `databases.query` endpoint is deprecated; queries go to `dataSources.query` instead.
2. Released the **2026-03-11 API version** with three smaller cleanups (`archived` → `in_trash` on pages, block append `after` → `position`, block type `transcription` → `meeting_notes`).
3. Shipped `@notionhq/client@5.x` to match. `**databases.query` is removed from the SDK** (not just deprecated) and `DatabaseObjectResponse.properties` no longer exists — properties moved to a new `DataSourceObjectResponse` type.

Failure mode if we ignore this: today our integration still works against single-source databases on the old API version, but the moment a Notion user adds a second data source to one of their databases (a UI affordance Notion has been rolling out), every read/write against that database fails with no warning. The longer we wait, the more user surface area is exposed to this silent breakage.

---

## Current state inventory

### Version pin

[server/package.json:52](server/package.json#L52):

```json
"@notionhq/client": "^3.1.3",
```

Target: `5.22.0` (latest as of plan date).

### Files that import from `@notionhq/client`


| File                                                                                                                                                                              | Imports                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [notion-connector.ts:1-13](server/src/remote-service/connectors/library/notion/notion-connector.ts#L1-L13)                                                                        | `Client`, `APIErrorCode`, `APIResponseError`, `RequestTimeoutError`, `DatabaseObjectResponse`, `PageObjectResponse`, `BlockObjectResponse`, `CreatePageParameters`, `QueryDatabaseParameters` |
| [notion-incremental.ts:15](server/src/remote-service/connectors/library/notion/notion-incremental.ts#L15)                                                                         | `QueryDatabaseParameters`                                                                                                                                                                     |
| [notion-json-schema.ts:1](server/src/remote-service/connectors/library/notion/notion-json-schema.ts#L1)                                                                           | `DatabaseObjectResponse`                                                                                                                                                                      |
| [notion-schema-parser.ts](server/src/remote-service/connectors/library/notion/notion-schema-parser.ts)                                                                            | `DatabaseObjectResponse`, `PageObjectResponse`                                                                                                                                                |
| [property-types.ts:1](server/src/remote-service/connectors/library/notion/property-types.ts#L1)                                                                                   | `DatabaseObjectResponse`, `PageObjectResponse`                                                                                                                                                |
| [conversion/notion-block-diff-executor.ts:1-2](server/src/remote-service/connectors/library/notion/conversion/notion-block-diff-executor.ts#L1-L2)                                | `Client`, `BlockObjectRequest`                                                                                                                                                                |
| [conversion/notion-block-value-types.ts:7](server/src/remote-service/connectors/library/notion/conversion/notion-block-value-types.ts#L7)                                         | `RichTextItemResponse`                                                                                                                                                                        |
| [conversion/notion-rich-text-conversion.ts:1-5](server/src/remote-service/connectors/library/notion/conversion/notion-rich-text-conversion.ts#L1-L5)                              | `BlockObjectResponse`, `RichTextItemResponse`, `TextRichTextItemResponse`                                                                                                                     |
| [conversion/notion-rich-text-push.ts:1](server/src/remote-service/connectors/library/notion/conversion/notion-rich-text-push.ts#L1)                                               | `TextRichTextItemResponse`                                                                                                                                                                    |
| [conversion/notion-rich-text-push-types.ts:1](server/src/remote-service/connectors/library/notion/conversion/notion-rich-text-push-types.ts#L1)                                   | `RichTextItemResponse`                                                                                                                                                                        |
| [conversion/notion-markdown-converter.ts:1](server/src/remote-service/connectors/library/notion/conversion/notion-markdown-converter.ts#L1)                                       | `RichTextItemResponse`                                                                                                                                                                        |
| [sync/transformers/implementations/notion-to-html.transformer.ts:1-6](server/src/remote-service/connectors/sync/transformers/implementations/notion-to-html.transformer.ts#L1-L6) | `BlockObjectResponse`, `RichTextItemResponse`, `TableBlockObjectResponse`, `TableRowBlockObjectResponse`                                                                                      |


Tests that `jest.mock('@notionhq/client', ...)`:

- [notion-connector-update-records.spec.ts](server/src/remote-service/connectors/library/notion/__tests__/notion-connector-update-records.spec.ts)
- [notion-connector-incremental.spec.ts](server/src/remote-service/connectors/library/notion/__tests__/notion-connector-incremental.spec.ts)
- [notion-connector-extract-assets.spec.ts](server/src/remote-service/connectors/library/notion/__tests__/notion-connector-extract-assets.spec.ts)
- [notion-block-diff-executor.spec.ts](server/src/remote-service/connectors/library/notion/conversion/__tests__/notion-block-diff-executor.spec.ts) — imports `Client` directly

### Client API surface in use


| Call                                                                           | Location                                                                                                                               | Status in v5                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Client({ auth })`                                                         | [notion-connector.ts:132](server/src/remote-service/connectors/library/notion/notion-connector.ts#L132)                                | OK — also add `notionVersion: '2025-09-03'` (or `2026-03-11`)                                                                                                                                               |
| `client.search({ filter: { property: 'object', value: 'database' } })`         | [notion-connector.ts:150,197,208](server/src/remote-service/connectors/library/notion/notion-connector.ts#L150)                        | **Breaking** — filter value `'database'` removed, replaced with `'data_source'`                                                                                                                             |
| `client.databases.retrieve`                                                    | [notion-connector.ts:227](server/src/remote-service/connectors/library/notion/notion-connector.ts#L227)                                | Endpoint still exists, but response **no longer has `properties`**; instead has `data_sources: Array<{ id, name }>`                                                                                         |
| `client.databases.query`                                                       | [notion-connector.ts:340-346](server/src/remote-service/connectors/library/notion/notion-connector.ts#L340-L346)                       | **Removed from SDK.** Replace with `client.dataSources.query`                                                                                                                                               |
| `client.pages.retrieve`                                                        | [notion-connector.ts:394](server/src/remote-service/connectors/library/notion/notion-connector.ts#L394)                                | OK                                                                                                                                                                                                          |
| `client.pages.create({ parent: { database_id }, ... })`                        | [notion-connector.ts:454](server/src/remote-service/connectors/library/notion/notion-connector.ts#L454)                                | **Breaking** — `parent.database_id` no longer guaranteed to work on multi-source databases. Switch to `parent: { type: 'data_source_id', data_source_id }` (works against old API too, so safe to do early) |
| `client.pages.update({ properties })`                                          | [notion-connector.ts:648](server/src/remote-service/connectors/library/notion/notion-connector.ts#L648)                                | OK                                                                                                                                                                                                          |
| `client.pages.update({ archived: true })`                                      | [notion-connector.ts:665](server/src/remote-service/connectors/library/notion/notion-connector.ts#L665)                                | **Breaking on 2026-03-11** — rename to `in_trash: true`                                                                                                                                                     |
| `client.blocks.retrieve`                                                       | [notion-connector.ts:482](server/src/remote-service/connectors/library/notion/notion-connector.ts#L482)                                | OK                                                                                                                                                                                                          |
| `client.blocks.children.list`                                                  | [notion-connector.ts:167,544](server/src/remote-service/connectors/library/notion/notion-connector.ts#L167)                            | OK                                                                                                                                                                                                          |
| `client.blocks.children.append({ ..., after })`                                | [notion-block-diff-executor.ts:125](server/src/remote-service/connectors/library/notion/conversion/notion-block-diff-executor.ts#L125) | **Breaking on 2026-03-11** — `after` replaced with `position: { type: 'after_block', after_block: { id }                                                                                                    |
| `client.blocks.update`                                                         | [notion-block-diff-executor.ts:197](server/src/remote-service/connectors/library/notion/conversion/notion-block-diff-executor.ts#L197) | OK                                                                                                                                                                                                          |
| `client.blocks.delete`                                                         | [notion-block-diff-executor.ts:207](server/src/remote-service/connectors/library/notion/conversion/notion-block-diff-executor.ts#L207) | OK                                                                                                                                                                                                          |
| `APIResponseError.isAPIResponseError`, `APIErrorCode.`*, `RequestTimeoutError` | [notion-connector.ts:42-50,843-900](server/src/remote-service/connectors/library/notion/notion-connector.ts#L42-L50)                   | OK (verify enum names didn't change)                                                                                                                                                                        |


### Storage model — where `database_id` lives today

The connector identifies tables via `EntityId.remoteId: string[]` (see [CONNECTOR_GUIDE.md:108](server/src/remote-service/connectors/CONNECTOR_GUIDE.md#L108)). Notion uses a single-element array:

```ts
const [databaseId] = tableSpec.id.remoteId; // notion-connector.ts:295, 447
```

`tableSpec.id.remoteId` is `string[]`, so there is **room to add `data_source_id` as `remoteId[1]`** without a Prisma schema migration. The folder's remoteId is serialized into the [DataFolder record at schema.prisma:597](server/prisma/schema.prisma#L597) and round-trips through Postgres as a string array.

This is the key decision point: we have a place to put `data_source_id` already, but every existing DataFolder for Notion will need backfill (a one-time migration that calls `databases.retrieve` for each Notion folder and stores `data_sources[0].id` as `remoteId[1]`).

---

## The breaking changes, ranked

### Tier 1 — hard breaks that block compilation

These will fail TypeScript build the moment the SDK is bumped, regardless of which `Notion-Version` we pin to.

1. `**client.databases.query` is removed.** No deprecated alias, no runtime shim. Every callsite (just one: [notion-connector.ts:340-346](server/src/remote-service/connectors/library/notion/notion-connector.ts#L340-L346), but it's the hot path for `pullRecordFiles`) must become `client.dataSources.query({ data_source_id, ... })`.
2. `**DatabaseObjectResponse.properties` is removed.** The type kept its name but lost its `properties` field; properties moved to the new `DataSourceObjectResponse`. Affects [notion-json-schema.ts](server/src/remote-service/connectors/library/notion/notion-json-schema.ts) (`buildNotionJsonTableSpec(db)` reads `db.properties` end-to-end) and [notion-schema-parser.ts](server/src/remote-service/connectors/library/notion/notion-schema-parser.ts).
3. `**QueryDatabaseParameters` type is gone**, replaced by `QueryDataSourceParameters`. Affects [notion-incremental.ts:15](server/src/remote-service/connectors/library/notion/notion-incremental.ts#L15) where we type our filter builders against it.

### Tier 2 — runtime breaks under API 2025-09-03 / 2026-03-11

These compile cleanly but fail at runtime once `notionVersion` is set:

1. `**search({ filter: { property: 'object', value: 'database' } })`** returns nothing — replace `'database'` with `'data_source'`. (Note: the query string still matches against the database title, but results are data sources. Display-name behavior changes for users.)
2. `**pages.create({ parent: { database_id } })`** fails on multi-source databases. Switch to `parent: { type: 'data_source_id', data_source_id }`. Notion documents this shape as accepted on **both** old and new API versions, so it's safe to migrate even before the SDK bump.
3. `**pages.update({ archived: true })`** → `pages.update({ in_trash: true })` (2026-03-11).
4. `**blocks.children.append({ ..., after: id })`** → `blocks.children.append({ ..., position: { type: 'after_block', after_block: { id } } })`. The new `position` field also supports `{ type: 'start' }` and `{ type: 'end' }` (2026-03-11).
5. **Block type `transcription` → `meeting_notes`** (2026-03-11). Our code [doesn't currently handle either](server/src/remote-service/connectors/library/notion/conversion/notion-block-value-types.ts) — we just pass blocks through as opaque shapes — so this is likely a no-op for us. Confirm during implementation by grep.

### Tier 3 — silent behavior changes worth verifying

1. `error.headers['retry-after']` — confirm header key didn't change in v5.
2. `BlockObjectRequest` type used at [notion-block-diff-executor.ts:2](server/src/remote-service/connectors/library/notion/conversion/notion-block-diff-executor.ts#L2) — confirm the union still covers every block type we emit.
3. The internal import path `@notionhq/client/build/src/api-endpoints` is used by 7 of our files. Confirm it still resolves in v5 — if not, types are exported from the top-level package now and we need a sweep of the imports.

---

## Migration strategy

Two viable shapes:

- **Big-bang**: bump SDK and migrate all code in a single MR. Smallest total diff, but the diff is large and the PR is risky to back out — any bug in the data-sources backfill takes the whole Notion integration down for everyone.
- **Phased** (recommended): land 4 smaller MRs, each independently revertable. Total diff is slightly larger because of transitional shims, but every intermediate step keeps Notion working on every existing database.

Recommendation: **phased**. Notion is a paid-tier connector and we have customers actively syncing — a multi-hour outage from a botched single-MR upgrade is a real cost. The phasing below front-loads the risky part (data source ID backfill) so that any production issue is isolated from the SDK bump itself.

### Phase 0 — Prep (no code changes shipped)

- Read the `@notionhq/client@5.22.0` `api-endpoints.d.ts` locally (after `yarn add` in a scratch worktree) to confirm:
  - Whether the `build/src/api-endpoints` deep-import path still exists in v5 (this affects how many import sites we touch).
  - Exact name of the new query types (`QueryDataSourceParameters` vs `QueryDataSourceBodyParameters` etc).
  - Whether `DatabaseObjectResponse.data_sources` is `Array<{id, name}>` or something richer.
- Validate the OAuth provider at [notion-oauth.provider.ts](server/src/oauth/providers/notion-oauth.provider.ts) doesn't need updating for 2025-09-03 — it talks to `/v1/oauth/`* which is API-version-independent. Should be a 5-minute check.

### Phase 1 — Land a Notion integration test backstop (no SDK changes yet) — **Complete**

Goal: close the test gap before any migration code ships, so every subsequent phase has a real-API regression backstop. Today's 11 Notion unit specs all `jest.mock('@notionhq/client')` and assume the v3 response shapes — they will happily keep passing even if the SDK migration silently corrupts data.

The existing integration tests cluster into two patterns:

- **Live-API** (Airtable, Attio, Brevo, Stripe, Affinity, Intercom): instantiate the connector with a real key from `process.env.<SERVICE>_API_KEY` and run against a real workspace. Skipped automatically in CI via `const describeIfKey = API_KEY ? describe : describe.skip`. Pattern: see [airtable-connector.spec.ts:22-31](server/test/integration/airtable-connector.spec.ts#L22-L31) and [attio-connector.spec.ts:40-51](server/test/integration/attio-connector.spec.ts#L40-L51).
- **Fake-API server** (Hubspot at [hubspot-connector.spec.ts:4](server/test/integration/hubspot-connector.spec.ts#L4)): point the connector at a local server via `API_URL_OVERRIDES`. Higher upfront cost; lower fidelity.

Use the **live-API pattern**. The whole point is to catch SDK / API-version regressions, so we want real Notion responses, not assumed shapes. Auto-skip-when-no-key keeps CI green without a credential.

Concrete deliverable: `server/test/integration/notion-connector.spec.ts` covering, at minimum:


| Suite                                 | What it asserts                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `testConnection`                      | Returns without throwing on a valid key; throws a specific error class on an invalid key                                                                                                                                                                                                                                                                           |
| `listTables` / `searchTables`         | Returns at least the known seed database; `parentPath` populated correctly                                                                                                                                                                                                                                                                                         |
| `fetchJsonTableSpec`                  | Returns a `BaseJsonTableSpec` whose `schema.properties` covers every property type in the seed database (title, rich_text, number, select, multi_select, date, files, relation, rollup, formula, people, status, url) — this is the single most important regression check for the SDK upgrade since it touches `notion-json-schema.ts` end-to-end                 |
| `pullRecordFiles` (full)              | Yields all seed pages in batched callbacks; each `ConnectorFile` has `page_content` populated; final `newWatermark` returned                                                                                                                                                                                                                                       |
| `pullRecordFiles` (incremental)       | Edit one record, run incremental from a past watermark, verify only the edited record (plus the boundary `on_or_after` overlap) comes back                                                                                                                                                                                                                         |
| `pullRecordFilesByIds`                | Fetch a specific set of page IDs; handles `ObjectNotFound` gracefully                                                                                                                                                                                                                                                                                              |
| `create → update → delete round-trip` | Create a page with mixed property types, update one writable property, archive it, verify each step via `pages.retrieve` between operations. Use the Attio round-trip helpers pattern at [attio-connector.spec.ts:264](server/test/integration/attio-connector.spec.ts#L264) and [attio-roundtrip-helpers.ts](server/test/integration/attio-roundtrip-helpers.ts). |
| Read-only property handling           | `updateRecords` with a `rollup` / `formula` / `created_time` change in `changedFields` should not 400 — the connector strips them silently                                                                                                                                                                                                                         |


Setup work (one-time, documented in the spec's header comment):

1. Create a dedicated Notion workspace + internal integration ("Scratch Integration Tests"); attach it to a test database with the property types listed above. Stash the workspace URL + integration token in 1Password.
2. Add `NOTION_API_KEY=secret_...` to `.env.integration` (gitignored) and to the team's shared secret store.
3. Document the seed database ID + a canonical seed page ID as exported constants in the spec — kept in source so anyone can re-provision from scratch.

This phase is also where we **add a snapshot/baseline** of the v3 `fetchJsonTableSpec` output for the seed database — a JSON fixture checked into `__fixtures__/` that Phase 3 (the data-sources migration) will diff against to confirm the v5 path produces the same schema. The fixture is the closest thing to a contract between the two SDK eras.

**Risk**: a live-API integration test will hit Notion's rate limits if run repeatedly in tight loops. Mitigate by reusing the existing seed data across describe blocks and only creating new pages in the round-trip suite (cleaning them up in `afterAll`).

### Phase 2 — Backfill `data_source_id` into `remoteId` (still on SDK v3) — **Complete**

Goal: get every existing Notion DataFolder to carry its `data_source_id` as `remoteId[1]`, while the connector still uses `remoteId[0]` (the database id) for all queries. Reversible: no behavior changes yet.

**Delivery**: shipped as a `CodeMigration` (admin-only) rather than a standalone script, so it inherits each environment's runtime config (DATABASE_URL, ENCRYPTION_MASTER_KEY) and DI graph (OAuth refresh, audit logging) without SSH tunneling or local secret copying. Triggered manually per environment via the existing `POST /code-migrations/run` endpoint with `migration: 'notion-data-source-backfill'`.

1. Per-folder decision logic lives in [server/src/code-migrations/notion-data-source-backfill.ts](server/src/code-migrations/notion-data-source-backfill.ts):
  - **Single-source case (`data_sources.length === 1`)**: rewrite `remoteId` to `[databaseId, data_sources[0].id]`. Transparent.
  - **Multi-source case (`data_sources.length > 1`)**: rewrite the existing folder to `data_sources[0]` AND create one new DataFolder per remaining source. New rows ship empty and populate on the user's next pull. Tagged with audit-log marker `notion_multisource_backfill` for traceability and rollback.
  - Skips folders already at `remoteId.length === 2` (idempotent).
  - On `ObjectNotFound` / `Unauthorized` from Notion, logs and continues to the next folder.
2. Orchestration lives in `CodeMigrationsController.runNotionDataSourceBackfill`:
  - Reads each environment's encrypted credentials via `CredentialEncryptionService` + auto-refreshes OAuth tokens via `OAuthService.getValidAccessToken`.
  - Constructs a script-local Notion `Client` with `notionVersion: '2025-09-03'` so `databases.retrieve` returns the `data_sources` array. The production connector's Client is unchanged this phase — Phase 3 bumps it in lockstep with `fetchJsonTableSpec`'s switch to `dataSources.retrieve` (the response shape under 2025-09-03 no longer carries `db.properties`, so the two changes must land together).
  - Returns the standard `MigrationResult` envelope (`migratedIds`, `remainingCount`, `migrationName`). `remainingCount` is computed against post-run state and filters to folders with `tableId.length < 2`, so the operator knows when to stop iterating.
3. Trigger the migration manually in dev → test → prod via `POST /code-migrations/run` (admin token required). Run with `qty: 1` first as a canary, then `qty: 50`, then bulk runs until `remainingCount === 0`. Per-folder errors are logged; rerun with the same parameters to retry transient failures (rate-limit hiccups, momentarily-expired tokens).
4. Update [notion-schema-parser.ts](server/src/remote-service/connectors/library/notion/notion-schema-parser.ts)'s `parseDatabaseTablePreview` to populate `remoteId` with **both** IDs going forward — **deferred to Phase 3** because reading `db.data_sources` requires bumping the production `Client`'s `notionVersion`, and that bump breaks `fetchJsonTableSpec`'s read of `db.properties`. Both must land together. Until Phase 3, new folders discovered via `listTables` get a 1-element `remoteId` and need a follow-up backfill run; idempotent re-runs handle this cheaply.

**Risk**: the backfill is a network-bound batch over every Notion folder. Rate-limited (3 req/sec per integration today, configurable). For an org with 200 Notion folders this is ~70s. The CodeMigration endpoint runs synchronously inside the API request, so wall-time per call is `qty × ~350ms`. Use `qty: 100` or smaller per call to stay inside any HTTP timeout limits on the deployed environments.

### Phase 3 — Migrate runtime code to data sources (still on SDK v3) — **Complete**

Goal: stop calling `databases.query` for queries — but keep the type bindings on `QueryDatabaseParameters` (since we're still on v3) using `notion.request()` as the raw escape hatch where the typed method doesn't exist.

This phase is optional and can be folded into Phase 4 if the team prefers fewer MRs. I'd recommend keeping it separate because it's the largest behavioral change and the bug surface differs from a pure SDK bump.

Concrete edits:

1. [notion-connector.ts:340-346](server/src/remote-service/connectors/library/notion/notion-connector.ts#L340-L346) — replace `client.databases.query` with:
  ```ts
   const dataSourceId =
     tableSpec.id.remoteId[1] ?? (await this.resolveDataSourceId(databaseId));
   const response = await this.withRetry(() =>
     this.client.request({
       method: "POST",
       path: `data_sources/${dataSourceId}/query`,
       body: { start_cursor, page_size, filter: notionFilter },
     }),
   );
  ```
   `resolveDataSourceId` is a per-instance memoized fallback for folders not yet backfilled — it calls `databases.retrieve` and grabs `data_sources[0].id`. Removable after the backfill catches everything.
2. [notion-connector.ts:226-228](server/src/remote-service/connectors/library/notion/notion-connector.ts#L226-L228) — `fetchJsonTableSpec` does `databases.retrieve` and reads `.properties`. Change to call `data_sources/{id}` (via `client.request`) and use `data_source.properties`. Same `resolveDataSourceId` fallback applies.
3. [notion-connector.ts:454](server/src/remote-service/connectors/library/notion/notion-connector.ts#L454) — `pages.create` parent → `{ type: 'data_source_id', data_source_id }`. **This is the one change in this phase that uses a typed SDK method** — and Notion documents that the new parent shape is accepted under both old and new API versions, so we don't need to gate it.
4. [notion-connector.ts:150,197,208](server/src/remote-service/connectors/library/notion/notion-connector.ts#L150) — `search({ filter.value: 'database' })` → `'data_source'`. **Only after** `Client` is constructed with `notionVersion: '2025-09-03'`; in 2022-06-28 the `data_source` value isn't recognized. Either:
  - (a) Bump `notionVersion` in the constructor now (this phase, Phase 3), accepting that the rest of the SDK methods continue to work under the new version, OR
  - (b) Defer this search-filter change to Phase 4 (after SDK bump).
   Recommend (a): the new API version is backwards compatible enough at the HTTP level that all our other v3 SDK calls continue to work (the v3 SDK doesn't validate response shapes strictly), and it lets us validate `data_source`-style search end-to-end before the SDK bump.
5. [notion-json-schema.ts](server/src/remote-service/connectors/library/notion/notion-json-schema.ts) — `buildNotionJsonTableSpec(db)` reads `db.properties`. Change the signature to accept the data source object (or `{ properties }` extracted from it). This is the largest type churn in the phase — touches `notion-schema-parser.ts`, [notion-default-view.ts](server/src/remote-service/connectors/library/notion/notion-default-view.ts), and their tests.
6. Update all four `jest.mock('@notionhq/client', ...)` tests to model the new `databases.retrieve` response (with `data_sources`) and a `client.request` mock for the query path.
7. **Re-run the Phase 1 integration test suite end-to-end** and diff `fetchJsonTableSpec`'s output against the v3 fixture captured in Phase 1. Any diff outside whitelisted shape-only changes (e.g. new `data_sources` field surfacing) is a regression that must be resolved before this phase merges.

### Phase 4 — SDK bump (3.1.3 → 5.22.0)

After Phase 3 ships, this PR should be near-mechanical:

1. `cd server && yarn add @notionhq/client@5.22.0` — yarn lockfile updates.
2. Replace `client.request({ path: 'data_sources/.../query' })` with the now-typed `client.dataSources.query({ data_source_id, ... })`.
3. Replace `client.request({ path: 'data_sources/...' })` with `client.dataSources.retrieve({ data_source_id })`.
4. Fix any imports that broke — particularly the `@notionhq/client/build/src/api-endpoints` deep-imports, if v5 reorganized them (check during Phase 0).
5. Re-type `notion-incremental.ts` against `QueryDataSourceParameters` (or whatever Notion named it).
6. Re-type `notion-block-diff-executor.ts` against the v5 `BlockObjectRequest` and `AppendBlockChildrenParameters`.
7. Add `notionVersion: '2025-09-03'` explicitly to the Client constructor (even though v5 may default to it; explicit pins make later upgrades intentional).
8. Run `yarn build && yarn lint` from the repo root. The TypeScript compiler is the friend here — it will surface every remaining incompatibility from the SDK swap.
9. Re-run the Phase 1 integration suite — every test should pass without source modifications (the only legitimate diff is the typed `client.dataSources.query` replacing `client.request`).

### Phase 5 — Adopt 2026-03-11 cleanups

After Phase 4 is stable in production for ~1 week:

1. Bump the Client constructor to `notionVersion: '2026-03-11'`.
2. [notion-connector.ts:665-668](server/src/remote-service/connectors/library/notion/notion-connector.ts#L665-L668) — `pages.update({ archived: true })` → `pages.update({ in_trash: true })`.
3. [notion-block-diff-executor.ts:125](server/src/remote-service/connectors/library/notion/conversion/notion-block-diff-executor.ts#L125) — `blocks.children.append({ ..., after })` → `{ ..., position: { type: 'after_block', after_block: { id: after } } }`.
4. Grep for `transcription` (likely no hits); if any, rename to `meeting_notes`.
5. Optional: update Notion webhook subscription version in the Notion developer portal — guide describes it as a no-op upgrade.

---

## Risks

### Critical

- **Multi-source databases**: a Notion user can attach a second data source to a database at any time. On API 2025-09-03+, the moment they do, all our reads/writes that go through `database_id` (not `data_source_id`) start failing for that database. The Phase 2 backfill captures `data_sources[0].id` only — if the database has multiple data sources by then, we silently pick the first one. **Mitigation**: in the backfill, log loudly when `data_sources.length > 1` and surface a count to the audit log. Decide post-backfill whether to (a) support multi-source by treating each as a separate folder, or (b) keep the first-data-source-only behavior with a user-facing warning. See Open Question #1.
- `**fetchJsonTableSpec` migration is the highest-risk single change**. It feeds schema into every downstream piece — JSON schema, default view, asset extraction, file-name suggestion, slug column resolution. A bug here can corrupt schema for every Notion folder on the next sync. **Mitigation**: the Phase 1 fixture (captured v3 `fetchJsonTableSpec` output for the seed database) plus the Phase 3 step 7 diff-against-fixture gate is the primary safety net. Back it up with extensive unit-test updates before Phase 3 ships.
- **Backfill failure modes**: a folder whose underlying Notion database has been deleted or revoked. The backfill should catch `ObjectNotFound` / `Unauthorized` per-folder, log, and continue rather than abort the whole run.

### Medium

- **Type-only imports from `@notionhq/client/build/src/api-endpoints`** (7 files). If v5 hoists these to top-level exports and deletes the deep path, we have a sweep of imports to update. Easy fix but expands the diff. Verify in Phase 0.
- **Test mocks** assume v3 shapes (notably `databases.retrieve` returning `properties`). All four mocked test files need updating in lockstep with Phase 3's source changes, or they'll start passing tests for the wrong contract.
- **Rate-limit header parsing** at [notion-connector.ts:46](server/src/remote-service/connectors/library/notion/notion-connector.ts#L46) — confirm `'retry-after'` (lower-cased) is still the header v5 surfaces. The SDK normalizes headers; a casing change here would be silent (the regex falls through to no retry-after, hitting the standalone retry default).
- **OAuth scope**: when re-authenticating, Notion's data-sources rollout may have added a new scope for data-source-level operations. The current OAuth flow at [notion-oauth.provider.ts:18](server/src/oauth/providers/notion-oauth.provider.ts#L18) doesn't request scopes explicitly — Notion grants integration-wide access per the user's integration config. **Action**: confirm in Phase 0 by re-checking Notion's OAuth docs that no new scope is required.

### Low

- The `transcription` → `meeting_notes` block-type rename. Our code passes blocks through opaquely, so we likely don't reference either string. Grep at Phase 5 time.
- Search semantics shift: post-Phase 3 step 4, `client.search(...)` returns data sources (not databases), so result `id` fields are now data-source IDs. We map results through `schemaParser.parseDatabaseTablePreview` which takes the response object and a `TablePreview` — the field that becomes `remoteId[0]` needs to remain a *database* ID for backward compatibility, and `remoteId[1]` the new data-source ID. The data-source search response includes the parent database id, but verify the field name (`parent.database_id` or similar).

---

## Testing strategy

### Per-phase unit tests

- **Phase 1 (integration test backstop)**: see phase description for the suite list. Ship the v3 `fetchJsonTableSpec` fixture in the same MR.
- **Phase 2 (backfill)**: write the script with a `--dry-run` flag and ship dry-run output in code review before live execution.
- **Phase 3 (data sources migration)**: update all four mocked tests to provide `databases.retrieve` returning `data_sources` and a `client.request` (or `client.dataSources.`*) mock for queries. Add a regression test for the case where `remoteId.length === 1` (un-backfilled folder) so the `resolveDataSourceId` fallback is exercised.
- **Phase 4 (SDK bump)**: the existing test suite is the safety net. If Phase 3 was thorough, this phase should compile-and-pass with at most mock-shape tweaks for the `client.dataSources.query` typed call.
- **Phase 5 (2026-03-11)**: add a test for `deleteRecords` asserting `pages.update` is called with `in_trash: true` (not `archived: true`), and a test for `notion-block-diff-executor` asserting `append` uses `position`.

### Integration

- Run `yarn test:integration` from repo root **after every phase from Phase 1 onward**. With the Phase 1 backstop in place, this becomes the primary green-light gate before each MR merges.
- **Manual smoke before each phase ships** (in addition to the automated integration suite): connect a test Notion workspace, create a single-source database with mixed property types, run a full pull, edit a record in Notion, run an incremental pull, verify the watermark filter works. Then push an edit from Scratch and verify it appears in Notion. Then archive a record from Scratch and confirm it lands in Notion's trash.
- **Multi-source manual test before Phase 5**: create a database with two data sources and confirm the connector picks up the first one without erroring (this is the lowest-coverage area in our test suite).

### Build/lint gate

- `yarn build && yarn lint` from repo root at the end of every phase (per [CLAUDE.md](server/CLAUDE.md) workflow rules).

---

## Rollout plan

Per-phase MRs against `master`:

1. **Phase 1** — Integration test backstop + v3 baseline fixture. Test-only — zero production behavior change. Land first.
2. **Phase 2** — Backfill script. Self-contained, low risk. Run the backfill in dev → test → prod across a single week.
3. **Phase 3** — Data sources migration on v3 SDK. Largest semantic change. Hold for one full week in production before Phase 4 ships, watching the Notion integration's PostHog `pull_completed` and `push_completed` event volumes for any regression.
4. **Phase 4** — SDK 5.22.0 bump. Should be near-mechanical after Phase 3. Watch error rates closely for the first 24h; the new SDK may surface response-shape strictness our v3 mocks let slide.
5. **Phase 5** — 2026-03-11 adoption. Lowest stakes. Can land at any time after Phase 4 is green for a week.

### Rollback story

- Phase 1 is test-only — no rollback needed.
- Phase 2 is data-only and idempotent — to roll back, run a reverse script that trims `remoteId` to its first element. Or leave it; Phase 3+ doesn't ship until Phase 2 is verified.
- Phase 3 is reverted by reverting the MR. The backfilled `remoteId[1]` becomes inert (no consumer reads it), and the connector returns to v3-only behavior.
- Phase 4 is reverted by reverting the lockfile + the MR; Phase 3's code continues to work against v3 SDK.
- Phase 5 is reverted by reverting the MR and re-pinning `notionVersion: '2025-09-03'`.

---

## Open questions for review

1. **Multi-source databases**: should the connector model each data source as its own DataFolder (richer, lets users sync each source independently) or surface only the first (simpler, matches today's behavior)? I'd default to "first source only with audit-log warning" for now and revisit when a customer asks for multi-source support. The Phase 2 backfill needs this answered.
2. `**notionVersion` timing**: Phase 3 step 4 proposes bumping to `2025-09-03` while still on SDK v3. Acceptable risk, or hold the version bump until Phase 4?
3. **One MR or many**: I've framed this as five phased MRs. If the team prefers fewer, the natural collapse is Phase 1 + Phase 2 + (Phase 3 ∪ Phase 4) + Phase 5 — i.e. the SDK bump rides with the data-sources migration. Saves a week of calendar time at the cost of a larger atomic change.
4. **OAuth re-grant**: do we need to ask existing Notion-connected customers to re-authenticate? Likely no (no new scopes), but Phase 0 should confirm.
5. **Notion-Version persistence**: should the version string be a constant in `notion-connector.ts`, an env var, or a per-credential setting? Constant is simplest; env var lets us flip back without a deploy if a Notion-side bug surfaces.
6. **Test workspace ownership**: who provisions and maintains the dedicated Notion integration-test workspace from Phase 1? The other live-API integration tests (Airtable, Attio, etc.) presumably have an owner — confirm and document in the Phase 1 spec header.

---

## Appendix A — Phase 4 manual testing plan

Targeted at what changed in Phase 4 specifically (SDK 3.1.3 → 5.22.0), not a generic Notion smoke test. Phase 5 cleanups (`in_trash`, `position`, `meeting_notes`) are explicitly **not** in scope here.

### Prerequisites

- Local dev server up (`yarn dev` from repo root)
- A Notion workspace with an internal integration token loaded into the server's connection credentials
- A test database in that workspace containing the property types from the Phase 1 plan table: title, rich_text, number, select, multi_select, date, files, relation, rollup, formula, people, status, url
- A previously connected Workbook that has been through the Phase 2 backfill (so `tableSpec.id.remoteId[1]` is populated) — confirm in the DB before starting

### Test matrix

#### 1. Connection & discovery (search → typed `client.search`) ✅

- **Connect a fresh Notion integration** through the UI. Confirm `testConnection` succeeds (exercises `users.me` indirectly via the SDK constructor path). ✅
- **Browse tables** in the connection flow. Confirm databases show up in the picker with correct titles and parent paths.
  - *Why:* The `searchDataSources` call switched from `client.request({ path: 'search' })` to typed `client.search({ filter: { property: 'object', value: 'data_source' } })`. A miswiring here would make the table picker empty.
- **Search with a query string** in the table picker. Confirm filtering works. ✅

#### 2. Schema fetch (`dataSources.retrieve` + `isFullDataSource` guard) ✅

- **Add a new folder** to a Workbook pointing at the seed database. Confirm `fetchJsonTableSpec` completes and the resulting folder's JSON schema reflects every property type listed above (open the folder, inspect the column headers in the UI).
- **Inspect server logs during the schema fetch** — confirm no `partial response for <id>` errors. If the guard ever fires, the error wraps `dataSources.retrieve returned a partial response` ([notion-connector.ts](server/src/remote-service/connectors/library/notion/notion-connector.ts)).

#### 3. Full pull (typed `client.dataSources.query`) ✅

- **Run a full pull** of the seed folder. Confirm all expected records appear as files in the workbook. ✅
- **Verify `page_content` is populated** on at least one record file. This exercises the blocks-children listing path that was *not* changed in Phase 4 but rides on top of the new query response shape. ✅

#### 4. Incremental pull (`QueryDataSourceParameters['filter']` retype)

- **Edit one record in Notion** (e.g. change a title). Wait ~30s. 
- **Run incremental pull** from the existing watermark. Confirm only the edited record (plus the `on_or_after` boundary overlap) comes back. ✅
- **Submit a complex pre-existing filter** through the connector options (whatever the UI surfaces — e.g. a saved filter on the folder). Confirm pull still returns the right set. ✅
  - *Why:* `notion-incremental.ts` retyped `NotionFilter` against the new param type, so `combineNotionFilters` and `buildNotionLastEditedFilter` are now flowing through a structurally different (but compatible) type. Runtime should be unchanged; verify with at least one nested compound.

#### 5. Create / update / delete round-trip (typed `pages.create` parent)

- **Create a new record from Scratch** with values across as many property types as the UI lets you set (title, rich_text, number, select, multi_select, date, url at minimum). Confirm the page appears in Notion with the correct parent (the data source, not just the database). ✅
- **Edit a writable property in Scratch and push** (e.g. change a select value). Confirm the update lands in Notion. ✅
- **Archive/delete the record from Scratch**. Confirm it moves to Notion's trash. ✅
  - *Note for Phase 4:* `pages.update` still uses `archived: true` here; the `in_trash` rename is a Phase 5 change. Verify the archive flow still works under the 2025-09-03 API version.
- **Include a read-only field** (rollup / formula / created_time) in `changedFields` and confirm the connector silently strips it rather than 400ing. ✅
  - TESTING NOTE: the publish didn't do anything but the change did get applied locally and on the server in the dirty branch. Since the change got filtered out, no actual publishing occured so it didn't revert back to value and the change stayed around.  This is a publishing bug, not a notion bug

#### 6. Block diff executor (`BlockObjectRequest` retyped) — **DEFERRED**

The Notion connector does not currently push `page_content` changes back to Notion. The block-diff executor is still retyped against the v5 `BlockObjectRequest` / `AppendBlockChildrenParameters` (verified by `yarn build` and unit tests), but there is no production code path that exercises it end-to-end — `updatePageContent` is `private` and unreferenced. These manual checks are deferred until page-content writes are re-introduced as a separate work item.

Originally planned (kept here for reference once the write path is wired up):

- ~~**Edit page_content** on a record file (add a paragraph, a heading, and a bulleted list). Push. Confirm the page in Notion picks up exactly the edited blocks at the right positions.~~
- ~~**Delete a block** from page_content and push. Confirm it disappears in Notion.~~
- ~~**Reorder blocks** by removing one and re-adding it. Confirm the order matches in Notion.~~
  - *Note for Phase 4:* `blocks.children.append` still passes `after: id` (the `position` rename is Phase 5). Verify the v5 SDK still accepts the legacy field under `2025-09-03`.

**Manual finding (2026-05-29)**: deleting a block locally and publishing reports success, but no API call reaches Notion — the publish-plan diff includes `page_content`, but `updateRecords` only maps `properties`, so a `page_content`-only delta becomes a no-op (`Object.keys(properties).length === 0` skips even the `pages.update` call). Confirms the deferred status above and is **not** a Phase 4 regression.

#### 7. Rich text annotations (alias rebase) ✅

- **Push content with mixed inline formatting** — bold + italic + colored + a link — in a single paragraph. Confirm Notion renders each annotation correctly.
- **Pull a Notion page that already contains annotated rich text** and inspect the rendered HTML in Scratch. Confirm formatting survives the round trip.
  - *Why:* `NotionAnnotations` was rebased from `TextRichTextItemResponse['annotations']` to `RichTextItemResponse['annotations']`. The types are structurally identical at the SDK level, but this is the area most likely to bite if the v5 union ever subtly diverges.

**Manual finding (2026-06-01)**: Edited a description field changing annotations and ahe update back to Notion reflected the changes correctly

#### 8. Rate-limit retry header (`readRetryAfterHeader`)

This is hard to trigger naturally; do whichever of these is feasible:

- **Best-effort load test**: kick off pulls on 3–5 folders simultaneously. If the server logs a `RateLimited` error, confirm it retried with the right delay (not the standalone fallback). Look for a log line with `retry-after` in it.
- **Or, point a temporary unit test at the helper** with both a `Headers` instance and a plain `Record<string, string>` and confirm both return the seconds value — fast, deterministic, gives the same coverage.

#### 9. Backfill controller compatibility (`isFullDatabase` guard)

- **Re-run** `POST /code-migrations/run` with `migration: 'notion-data-source-backfill', qty: 1` against a workbook that already has all folders backfilled. Confirm it returns idempotently with `remainingCount: 0`. ✅
- **Add a fresh Notion folder** (single-element `remoteId`), then run the backfill with `qty: 1`. Confirm the new folder ends up with `remoteId.length === 2` and the audit log records the action.  ✅
  - *Why:* [code-migrations.controller.ts](server/src/code-migrations/code-migrations.controller.ts) now uses `isFullDatabase` rather than a structural cast. Confirms the v5-typed `databases.retrieve` response still flows correctly through the backfill path.

#### 10. Multi-source database (sanity check, not full coverage) ✅

The Phase 5 plan calls for full multi-source manual testing — but it's worth a single check now to verify Phase 4 doesn't regress the existing first-source-only behavior.

- **In Notion, add a second data source** to one of your test databases (UI: "+" in the data source tabs at the top of a database).
- **Run a pull** on the corresponding Scratch folder. Confirm it still pulls records from the first data source without erroring. Don't expect multi-source records — just confirm no crash and consistent results vs. before adding the second source.

### Stop conditions

If any of the following happen, stop and investigate before proceeding to Phase 5:

- A `partial response for <id>` error surfaces from either guard
- `pullRecordFiles` returns zero results on a folder that worked under v3
- `pages.create` fails with a Notion 400 about the `parent` shape
- Rich-text annotations come back without formatting (round-trip loss)
- Build or lint fails after applying the diff cleanly

### Cleanup

- Delete any test pages created during the round-trip suite
- Remove the second data source from the multi-source test database if you added it

