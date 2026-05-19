# Incremental Polling — Part 3: WordPress, Linear, HubSpot, Shopify

**Date**: 2026-05-18
**Status**: Planned
**Linear**: [DEV-9757](https://linear.app/whalesync/issue/DEV-9757/incremental-polling)
**Depends on** (both now resolved):

- [resolved/2026-05-14-incremental-polling.md](resolved/2026-05-14-incremental-polling.md) — server pipeline + Airtable (landed)
- [resolved/2026-05-16-incremental-polling-followup.md](resolved/2026-05-16-incremental-polling-followup.md) — PostgreSQL/Supabase/Notion + Web UI (landed; Webflow deferred)

**Scope**: Server-only. Extend the incremental-pull contract to four more connectors — **WordPress, Linear, HubSpot, Shopify** — using the framework established by Airtable/Notion/PostgreSQL. **No client work**: the Web UI landed in the follow-up is generic and capability-gated; flipping `ConnectorMetadata.incrementalPull: true` per connector lights up the incremental menu items, the incremental schedule row, and the last-modified-field control automatically. No scheduler / job / CLI / Prisma changes (all landed in `7fd093ce`).

## Context

The base plan built the whole server pipeline (`PullRecordFilesOptions`/`PullRecordFilesResult`, `supportsIncrementalPull`, `PullLinkedFolderFilesJob` effective-mode/watermark logic, scheduler/API/CLI mode plumbing) and proved it on Airtable. The follow-up added PostgreSQL, Supabase, and Notion, plus the full Web client UI (incremental menu actions, separate `FULL_PULL`/`INCREMENTAL_PULL` schedule rows, the schema-fed last-modified-field control) — all driven by the static `ConnectorMetadata.incrementalPull` flag (`packages/shared-types/src/connector/metadata.ts:23`, default `false` at line 48).

Every remaining connector still inherits `supportsIncrementalPull() = false` and full-scans. This plan implements the incremental branch in WordPress, Linear, HubSpot, and Shopify. All four use the **server-side-predicate** archetype (the preferred one in `CONNECTOR_GUIDE.md`) — each remote API can answer "what changed since X?", so none need the unimplemented client-side-filter archetype (that was the deferred Webflow design; Webflow stays out of scope).

The four connectors fall into two of the established sub-patterns:

| Connector  | Modified-since mechanism                                                  | Last-modified field                                                                  | Sub-pattern                          | Clock-skew |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------ | ---------- |
| WordPress  | REST `?modified_after=<iso>` query param on the list endpoint             | fixed `modified` (posts/pages/CPT/media); **absent on taxonomy terms**                | annotation-gated (Notion-like)       | 60s        |
| Linear     | GraphQL connection arg `filter: { updatedAt: { gt: $since } }`            | fixed `updatedAt`, universal across all entity types                                  | fixed system field (Notion-like)     | 60s        |
| HubSpot    | **CRM Search API** `/crm/v3/objects/{type}/search`, `hs_lastmodifieddate` | object-type-dependent (`hs_lastmodifieddate` vs `lastmodifieddate`; custom-obj varies) | resolver + override (Airtable-like)  | 60s        |
| Shopify    | GraphQL root connection arg `query: "updated_at:>'<iso>'"`               | fixed `updatedAt`, universal — but only some root connections accept `query:`         | fixed system field, capability-gated | 60s        |

## Shared prerequisite — generalize `findLastModifiedFieldName` to non-Airtable schema shapes

`findLastModifiedFieldName(tableSpec)` ([server/src/remote-service/connectors/types.ts:178-195](../../server/src/remote-service/connectors/types.ts#L178)) currently only walks the **Airtable-nested** shape `schema.properties.fields.properties`. The four connectors here use different schema shapes:

- **WordPress** — flat top-level `schema.properties.{fieldId}` (`wordpress-json-schema.ts`).
- **Linear / Shopify** — flat top-level TypeBox `Type.Object({ ... })`, one static schema per entity type.
- **HubSpot** — top-level `{ id, properties: { ...userProps }, createdAt, updatedAt, archived, associations }`; the modified-date property lives under the nested `properties` object.

If the auto-detect layer (and the client's 2d last-modified-field dropdown, which reuses the same annotation) is to work for these connectors, the lookup must understand more than the Airtable nesting. Generalize the helper additively:

1. Keep the existing `properties.fields.properties` scan first (Airtable — unchanged behavior).
2. If that yields nothing, scan top-level `schema.properties.{name}` for `X_SCRATCH_LAST_MODIFIED_FIELD === true` (WordPress, Linear, Shopify).
3. If still nothing and a nested `schema.properties.properties.{name}` object exists (HubSpot), scan that.

Return the first annotated field name (using the path the connector's own schema reader expects — for HubSpot the property key, since its `resolveModifiedAtField` consumers operate on the property name). Add unit coverage for each shape. This is a small, additive change to one shared helper and is the natural framework extension for part 3 — it keeps every connector's `resolveModifiedAtField`/auto-detect path identical to Airtable's, and the client's annotation walk (which the follow-up's 2d control does client-side) consistent.

> Linear and Shopify could alternatively hardcode `updatedAt` (Notion-style) and skip auto-detect entirely. We still annotate `updatedAt` in their schema builders for the **UI** picker (the follow-up's 2d control surfaces annotated fields first), exactly as Notion annotates `last_edited_time` even though its connector hardcodes the field. So the generalized helper is needed regardless for the UI path.

## The per-connector contract (recap)

Each connector follows the six-step contract documented in `CONNECTOR_GUIDE.md:331-342`:

1. `ConnectorMetadata.incrementalPull: true` in the `connectorMetadata({ ... })` call.
2. `resolveModifiedAtField(options, tableSpec)` private helper (explicit `options.modifiedAtField` → annotated field) — **except** connectors with a guaranteed fixed system field, which skip it.
3. `supportsIncrementalPull(options, tableSpec)` override.
4. `advancedSettings` `modifiedAtField` (`field-select`) entry — only where the field is user-selectable (HubSpot custom objects). Omitted where the field is fixed (WordPress/Linear/Shopify).
5. Watermark-before-first-call: `newWatermark = new Date()` before the first API call.
6. Per-connector clock-skew margin subtracted from `options.since`.

Plus a per-connector `*-incremental.ts` helper (predicate builder + filter-combiner + clock-skew constant), mirroring the _shape_ of `airtable-incremental.ts` / `notion-incremental.ts` / `pg-common/pg-incremental.ts` — **not** a shared cross-connector helper (the predicate syntaxes have nothing in common).

Full pulls fall through unchanged and `return {}`. None of these connectors expose an opaque change token, so `newCursor` stays unset — `lastIncrementalPullAt` is the only cross-run state.

---

## 3a. WordPress — REST `modified_after`, annotation-gated

[server/src/remote-service/connectors/library/wordpress/](../../server/src/remote-service/connectors/library/wordpress/)

WordPress's REST list endpoint supports a server-side `modified_after=<ISO8601>` filter for post-type and media collections. Taxonomy (category/tag/term) collections have **no** `modified` field and no `modified_after` param — those folders must demote to full. This makes WordPress annotation-gated rather than unconditional.

- **Schema annotation** ([wordpress-json-schema.ts](../../server/src/remote-service/connectors/library/wordpress/wordpress-json-schema.ts), `buildWordPressJsonTableSpec` ~L209-312): set `[X_SCRATCH_LAST_MODIFIED_FIELD]: true` on the `modified` property **only when the OPTIONS-derived schema is for a post-type or media collection** (i.e. the collection exposes `modified`). Do not annotate taxonomy schemas (they have no `modified`). `modified_gmt` is already excluded by the `'gmt'` substring filter and stays excluded — we filter on `modified` and let WordPress map it server-side.
- **`resolveModifiedAtField(options, tableSpec)`**: explicit `options.modifiedAtField` (trimmed) → `findLastModifiedFieldName(tableSpec)` (now flat-shape aware). The field name is effectively always `modified` when present; the override exists only for unusual CPTs that expose a differently named modified column.
- **`supportsIncrementalPull(options, tableSpec)`**: `return this.resolveModifiedAtField(options, tableSpec) !== undefined`. Auto-detect makes post/media folders incremental with zero config; taxonomy folders resolve to `undefined` → job demotes to full.
- **`advancedSettings`**: currently `[]` (wordpress-connector.ts ~L400). Leave empty — `modified` is fixed and not user-selectable; auto-detection covers it. (If a future CPT needs an override, add the `modifiedAtField` `field-select` entry then; not required for v1.)
- **API client** ([wordpress-http-client.ts](../../server/src/remote-service/connectors/library/wordpress/wordpress-http-client.ts), `pollRecords(tableId, offset, pageSize)` ~L113-126): widen the signature to `pollRecords(tableId, offset, pageSize, modifiedAfter?: Date)`. When `modifiedAfter` is provided, add `modified_after` to the assembled `searchParams` as an ISO-8601 string. Offset pagination is unchanged; the `status=any` / `context=edit` params stay.
- **Connector** ([wordpress-connector.ts](../../server/src/remote-service/connectors/library/wordpress/wordpress-connector.ts) `pullRecordFiles` ~L138-166): the method currently ignores `_options`. Switch to `options: PullRecordFilesOptions`. Incremental branch:
  1. Resolve the field; if unresolved, or `options.pullMode !== 'incremental'`, or `options.since` missing → full scan, `return {}`.
  2. `newWatermark = new Date()` before the first `pollRecords` call.
  3. `cutoff = options.since - WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS`; pass `cutoff` into every paginated `pollRecords(..., cutoff)`.
  4. WordPress has no user `options.filter` today — nothing to combine.
  5. `return { newWatermark }`.
- **Helper** `wordpress-incremental.ts`: `WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS = 60_000`, `applyWordPressClockSkew(since)`. (No formula/JSON to build — the param is the bare ISO string — but keep the module for parity and the clock-skew constant.)
- **Metadata**: add `incrementalPull: true` to `connectorMetadata({ ... })` (wordpress-connector.ts ~L50-82).
- **Note — timezone**: WordPress `modified_after` filters against `post_modified` in the **site's timezone**, not GMT, while our watermark is UTC. The 60s clock-skew margin partially absorbs small offsets, but a site with a large non-UTC timezone could miss records. Document this in the connector and `CONNECTOR_GUIDE.md`; idempotent commits + the periodic `FULL_PULL` reconcile any gap. (A precise fix — converting the watermark to the site timezone — is a follow-up; not in v1 scope.)

## 3b. Linear — GraphQL `filter: { updatedAt: { gt } }`, fixed system field

[server/src/remote-service/connectors/library/linear/](../../server/src/remote-service/connectors/library/linear/)

Every Linear entity (Issue, Project, Team, User, IssueLabel, Cycle) has a server-side `updatedAt` and every list connection accepts a typed `filter` input with an `updatedAt: { gt: <DateTime> }` comparator. `updatedAt` is universal, so Linear is the Notion-style "fixed system field" variant.

- **Schema annotation** ([linear-json-schema.ts](../../server/src/remote-service/connectors/library/linear/linear-json-schema.ts)): set `[X_SCRATCH_LAST_MODIFIED_FIELD]: true` on the top-level `updatedAt` property of each entity's TypeBox schema (mirrors how Notion annotates `last_edited_time` for the UI picker even though the connector hardcodes the field).
- **`supportsIncrementalPull`**: `override supportsIncrementalPull(): boolean { return true; }` — `updatedAt` is guaranteed on every Linear entity type. No `resolveModifiedAtField`, no `modifiedAtField` advancedSetting (fixed, not user-selectable). Keep `advancedSettings: []`.
- **API client** ([linear-api-client.ts](../../server/src/remote-service/connectors/library/linear/linear-api-client.ts), `listEntities` ~L185-203): the generic query builder currently emits `query List${rootField}($first: Int!, $after: String) { ${rootField}(first: $first, after: $after) { nodes pageInfo } }`. Extend it to optionally inject a filter:
  - Add a `FILTER_TYPE_MAP` alongside the existing `ROOT_FIELD_MAP` mapping each `entityType` → its Linear GraphQL filter input type name (`issues → IssueFilter`, `projects → ProjectFilter`, `teams → TeamFilter`, `users → UserFilter`, `issueLabels → IssueLabelFilter`, `cycles → CycleFilter`). **Verify each input-type name and that it exposes `updatedAt` against the Linear SDK / introspection during implementation** (open question #3).
  - When a filter is supplied, emit `query List${rootField}($first: Int!, $after: String, $filter: ${FilterType}) { ${rootField}(first: $first, after: $after, filter: $filter) { ... } }` and pass `{ filter }` in the variables. When absent, emit the existing query unchanged (full scan — zero behavior change).
  - Thread an optional `filter` arg through `listEntities(entityType, pageSize, resumeCursor, filter?)`.
- **Connector** ([linear-connector.ts](../../server/src/remote-service/connectors/library/linear/linear-connector.ts) `pullRecordFiles` ~L134-156, currently ignores `_options`): switch to `options`. Incremental branch:
  1. `options.pullMode !== 'incremental'` or no `options.since` → full scan, `return {}`.
  2. `newWatermark = new Date()` before the first `listEntities`.
  3. Build `filter = buildLinearUpdatedAtFilter(options.since)` → `{ updatedAt: { gt: (since - skew).toISOString() } }`; pass it into the async generator.
  4. No user `options.filter` for Linear today — nothing to combine.
  5. `return { newWatermark }`.
- **Helper** `linear-incremental.ts`: `LINEAR_INCREMENTAL_CLOCK_SKEW_MS = 60_000`, `buildLinearUpdatedAtFilter(since)`. `gt` is **exclusive** and the watermark is client-side, so the 60s margin matters (boundary record + skew). Idempotent commits absorb the re-pull.
- **Metadata**: add `incrementalPull: true` (linear-connector.ts ~L63-83).

## 3c. HubSpot — CRM Search API, resolver + override (Airtable-like)

[server/src/remote-service/connectors/library/hubspot/](../../server/src/remote-service/connectors/library/hubspot/)

HubSpot's standard list endpoint (`/crm/v3/objects/{type}`, used today by `listRecords` ~L160-191) **cannot** filter by modified date. Incremental requires the **CRM Search API** (`POST /crm/v3/objects/{type}/search`) with a `hs_lastmodifieddate GTE <since>` filter, sorted ascending. The modified-date property name is object-type-dependent (`hs_lastmodifieddate` for companies/deals; `lastmodifieddate` for contacts; custom objects vary), so HubSpot is the Airtable-style resolver+override variant, not a fixed-field one.

- **Schema annotation** ([hubspot-json-schema.ts](../../server/src/remote-service/connectors/library/hubspot/hubspot-json-schema.ts) ~L84-139): the builder already fetches all properties per object type via `client.getProperties(objectType)`. Set `[X_SCRATCH_LAST_MODIFIED_FIELD]: true` on whichever of `hs_lastmodifieddate` / `lastmodifieddate` is present in the object's property set (prefer `hs_lastmodifieddate` if both exist). These live under the nested `properties` object — the generalized `findLastModifiedFieldName` (shared prerequisite, step 3) handles that shape.
- **`resolveModifiedAtField(options, tableSpec)`**: explicit `options.modifiedAtField` (trimmed) → `findLastModifiedFieldName(tableSpec)`. Identical shape to Airtable's.
- **`supportsIncrementalPull(options, tableSpec)`**: `return this.resolveModifiedAtField(options, tableSpec) !== undefined`. Standard objects auto-detect; custom objects without a recognizable modified property need the explicit override (or demote to full).
- **`advancedSettings`**: currently `[]` (hubspot-connector.ts ~L436-450). Add a `modifiedAtField` `field-select` entry (placeholder `e.g. hs_lastmodifieddate`) and register it via the connector's `connectorRegistry.register({ ..., advancedSettings })`, so a user can declare the field for a custom object that the annotation missed.
- **API client** ([hubspot-api-client.ts](../../server/src/remote-service/connectors/library/hubspot/hubspot-api-client.ts)): add a `*searchRecordsModifiedSince(objectType, propertyNames, modifiedAtField, since, after?)` async generator hitting `POST /crm/v3/objects/{type}/search` with body:
  ```jsonc
  {
    "filterGroups": [{ "filters": [{ "propertyName": "<modifiedAtField>", "operator": "GTE", "value": "<epoch-ms or ISO>" }] }],
    "sorts": [{ "propertyName": "<modifiedAtField>", "direction": "ASCENDING" }],
    "properties": [...propertyNames],
    "limit": 100,
    "after": "<cursor>"
  }
  ```
  Keep `listRecords` (full scan) untouched.
- **Connector** ([hubspot-connector.ts](../../server/src/remote-service/connectors/library/hubspot/hubspot-connector.ts) `pullRecordFiles` ~L150-168, currently ignores `_options`): switch to `options`. Incremental branch: resolve field → if unresolved / not incremental / no `since` → full scan via `listRecords`, `return {}`. Else `newWatermark = new Date()` before the first search call; `since - HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS`; paginate `searchRecordsModifiedSince`; `return { newWatermark }`.
- **Helper** `hubspot-incremental.ts`: `HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS = 60_000`, `buildHubspotModifiedSinceSearch(modifiedAtField, since, propertyNames, after?)`. GTE is inclusive but the watermark is client-side, so keep the 60s margin for clock drift; idempotent commits absorb the overlap.
- **Metadata**: add `incrementalPull: true` (hubspot-connector.ts ~L48-65).
- **Limitation — associations** (open question #1): the Search API returns `properties` but **not** `associations`; the request body has no `associations` field. The current full-scan `listRecords` passes `associations` and the stored record file includes them. An incremental pull via Search therefore omits association data. **Recommended v1 behavior**: incremental pulls do not refresh associations; association drift is reconciled by the periodic `FULL_PULL` — the same philosophy the base plan applies to deletions ("incremental never deletes; full scans catch drift"). Document this prominently in the connector and `CONNECTOR_GUIDE.md`. (A heavier alternative — Search for changed IDs, then re-read each with associations via a per-id `GET ?associations=` — is deferred; it roughly doubles API calls and is out of v1 scope.)
- **Limitation — Search 10k window** (open question #2): the CRM Search API caps a result set at 10,000 records. Sorted ascending by modified date and paged with `after`, a single incremental run that needs to return >10k changed records will be capped. In steady state the per-run delta is small, so this only bites if a folder is dormant for a long time or a bulk edit touches >10k records between runs; the watermark still advances by what was returned and the next run continues. Bootstrap is always a full pull (job-level), so this never affects the initial load. Document the edge; the periodic `FULL_PULL` is the safety net.

## 3d. Shopify — GraphQL `query: "updated_at:>..."`, capability-gated fixed field

[server/src/remote-service/connectors/library/shopify/](../../server/src/remote-service/connectors/library/shopify/)

Every Shopify resource schema has a server-side `updatedAt` (already `X_SCRATCH_READONLY`). Shopify's root list connections accept a `query:` search string supporting `updated_at:>'<iso>'`, **but only some root connections support `query:`** (e.g. products, orders, customers, draftOrders, articles, blogs, metaobjects) — others do not. So `updatedAt` is a fixed system field but support is capability-gated by entity type.

- **Schema annotation** ([shopify/graphql/schemas/*.schema.ts](../../server/src/remote-service/connectors/library/shopify/graphql/schemas/)): set `[X_SCRATCH_LAST_MODIFIED_FIELD]: true` on the top-level `updatedAt` property of each query-filterable entity's schema (next to the existing `X_SCRATCH_READONLY = true` assignment). For UI parity; the connector hardcodes `updatedAt`.
- **`supportsIncrementalPull(options, tableSpec)`**: return `true` only when the folder's parent entity type is in a static `SHOPIFY_QUERY_FILTERABLE` set. **Derive/verify this set from the connector's `ENTITY_REGISTRY` and Shopify's documented searchable connections during implementation** — child entities (product_variants, order_line_items, …) hydrate through their parent, so incremental applies at the parent level and a parent's children come along when the parent is returned. Entity types not in the set → `false` → job demotes to full. No `resolveModifiedAtField` / `modifiedAtField` advancedSetting (fixed field); keep `advancedSettings: []`.
- **API client** ([shopify-api-client.ts](../../server/src/remote-service/connectors/library/shopify/shopify-api-client.ts), `listEntities` ~L304-348): the generic builder emits `query List${rootField}($first: Int!, $after: String) { ${rootField}(first: $first, after: $after) { nodes pageInfo } }`. Extend it to optionally inject `$query: String` + `query: $query` on the root field for query-filterable entities; when absent, emit the existing query unchanged. Thread an optional `searchQuery` arg through `listEntities(entityType, pageSize, resumeCursor, searchQuery?)`.
- **Connector** ([shopify-connector.ts](../../server/src/remote-service/connectors/library/shopify/shopify-connector.ts) `pullRecordFiles` ~L262-301, currently ignores `_options`): switch to `options`. Incremental branch: not incremental / no `since` / entity not query-filterable → full scan, `return {}`. Else `newWatermark = new Date()` before the first list call; build `searchQuery = buildShopifyUpdatedAtQuery(options.since)`; pass into `listEntities`; `return { newWatermark }`. Child-entity hydration path (`fetchConnection`) is unchanged.
- **Helper** `shopify-incremental.ts`: `SHOPIFY_INCREMENTAL_CLOCK_SKEW_MS = 60_000`, `buildShopifyUpdatedAtQuery(since)` → `updated_at:>'<(since - skew).toISOString()>'`. Shopify search `>` is exclusive and the watermark is client-side, so the 60s margin matters; idempotent commits absorb the overlap.
- **Metadata**: add `incrementalPull: true` (shopify-connector.ts ~L108-141).

## CONNECTOR_GUIDE.md

Extend the existing "Incremental Pulls" section ([CONNECTOR_GUIDE.md:322-423](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md#L322)). All four are the **server-side-predicate** archetype, so add them as worked examples under that archetype rather than introducing a new one (the client-side-filter archetype stays documented-but-unimplemented — note explicitly that none of the part-3 connectors needed it):

- The generalized `findLastModifiedFieldName` schema-shape support (Airtable-nested vs flat top-level vs HubSpot's nested `properties`).
- WordPress: REST `modified_after`, annotation-gated by collection type (taxonomy demotes), the site-timezone caveat.
- Linear: GraphQL `filter: { updatedAt: { gt } }`, fixed system field, the per-entity filter-input-type map.
- HubSpot: switch from list to **CRM Search**, the resolver+override field resolution, and the two documented limitations (associations omitted on incremental; 10k Search window — both reconciled by the periodic `FULL_PULL`).
- Shopify: GraphQL `query:` search, capability-gated by entity type, child-entity hydration note.

## Tests

Per connector, mirroring the Airtable/Notion specs (`__tests__/`):

- **Shared helper**: `findLastModifiedFieldName` unit tests for each schema shape — Airtable-nested (unchanged), flat top-level (WordPress/Linear/Shopify), HubSpot nested `properties`; annotated vs unannotated.
- **WordPress**: `supportsIncrementalPull` truthiness (post/media schema annotated → true; taxonomy schema → false); `pollRecords` adds `modified_after` with clock-skew; `pullRecordFiles` incremental returns `{ newWatermark }`, full returns `{}`; schema-builder annotates `modified` on post/media but not taxonomy.
- **Linear**: `supportsIncrementalPull()` always true; query builder injects `$filter`/`filter:` with the correct per-entity filter-input-type name and `{ updatedAt: { gt } }`; clock-skew applied; full mode emits the unchanged query and `return {}`; schema-builder annotates `updatedAt`.
- **HubSpot**: `supportsIncrementalPull` truthiness (annotated/explicit → true; neither → false); explicit `modifiedAtField` overrides annotation; search request body shape (GTE filter, ASC sort, properties, after); clock-skew applied; `{ newWatermark }` vs `{}`; schema-builder annotates the present modified-date property; a test asserting incremental responses omit associations (documents the limitation).
- **Shopify**: `supportsIncrementalPull` true for a query-filterable entity, false for a non-filterable one; query builder injects `$query`/`query:` and `buildShopifyUpdatedAtQuery` formats `updated_at:>'...'` with skew; full mode unchanged + `return {}`; schema-builder annotates `updatedAt`.
- **Integration** (`yarn test:integration`) where infra exists (at minimum one of the four against a real test source): bootstrap full → modify one record → incremental → only that record's file changes in git, watermark advances. (Like the follow-up's Notion integration round-trip, this may land as a tracked follow-up where test credentials/infra aren't yet wired — not a blocker for the connector landing.)
- `yarn build` and `yarn lint` from the repo root pass.

## Out of scope

- **Webflow** — still deferred (carried from the follow-up, user decision 2026-05-17). `incrementalPull` stays `false`; full-scans as today. Its client-side-filter design remains the future template for that archetype.
- Connectors beyond these four (Attio, Affinity, Audienceful, Brevo, Intercom, Memberstack, Moco, Pipedrive, QuickBooks, Stripe, Wix, YouTube) — remain `false`; revisit per connector.
- **HubSpot association-change capture on incremental** — documented limitation; the periodic `FULL_PULL` reconciles association drift (open question #1).
- **HubSpot >10k Search-window** precise handling — documented edge; `FULL_PULL` is the safety net (open question #2).
- WordPress site-timezone-exact watermark conversion — documented caveat; clock-skew margin + `FULL_PULL` mitigate; precise fix is a follow-up.
- Any client / scheduler / job / CLI / Prisma change — all landed in prior plans; the Web UI is generic and capability-gated.
- Webhook / change-data-capture / deletion feeds.

## Critical files

**Shared**

- [server/src/remote-service/connectors/types.ts](../../server/src/remote-service/connectors/types.ts#L178) — generalize `findLastModifiedFieldName` to flat / HubSpot-nested schema shapes. ✅ (all three shapes implemented + unit-tested in `connectors/__tests__/types.spec.ts`)
- [server/src/remote-service/connectors/CONNECTOR_GUIDE.md](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md#L322) — extend "Incremental Pulls" with the four worked examples + the schema-shape note. ⏳ (schema-shape note + **Linear** worked example landed; WordPress/HubSpot/Shopify examples pending those connectors)

**WordPress**

- [wordpress-connector.ts](../../server/src/remote-service/connectors/library/wordpress/wordpress-connector.ts) — `pullRecordFiles` incremental branch, `supportsIncrementalPull`/`resolveModifiedAtField`, `incrementalPull: true`. ⏳
- [wordpress-http-client.ts](../../server/src/remote-service/connectors/library/wordpress/wordpress-http-client.ts) — `pollRecords` gains `modifiedAfter?`. ⏳
- [wordpress-json-schema.ts](../../server/src/remote-service/connectors/library/wordpress/wordpress-json-schema.ts) — annotate `modified` on post/media schemas (not taxonomy). ⏳
- `wordpress/wordpress-incremental.ts` — new helper. ⏳

**Linear**

- [linear-connector.ts](../../server/src/remote-service/connectors/library/linear/linear-connector.ts) — incremental branch, `supportsIncrementalPull() = true`, `incrementalPull: true`. ✅
- [linear-api-client.ts](../../server/src/remote-service/connectors/library/linear/linear-api-client.ts) — `listEntities`/query builder gain optional `filter` + `FILTER_TYPE_MAP`. ✅
- [linear-json-schema.ts](../../server/src/remote-service/connectors/library/linear/linear-json-schema.ts) — annotate `updatedAt`. ✅
- `linear/linear-incremental.ts` — new helper. ✅ (+ `__tests__/linear-incremental.spec.ts`, `linear-connector-incremental.spec.ts`, `linear-api-client-incremental.spec.ts`, `linear-json-schema.spec.ts`)

**HubSpot**

- [hubspot-connector.ts](../../server/src/remote-service/connectors/library/hubspot/hubspot-connector.ts) — incremental branch via Search, resolver/override, `advancedSettings` (`modifiedAtField` field-select), `incrementalPull: true`. ⏳
- [hubspot-api-client.ts](../../server/src/remote-service/connectors/library/hubspot/hubspot-api-client.ts) — new `searchRecordsModifiedSince` generator (CRM Search). ⏳
- [hubspot-json-schema.ts](../../server/src/remote-service/connectors/library/hubspot/hubspot-json-schema.ts) — annotate the present modified-date property. ⏳
- `hubspot/hubspot-incremental.ts` — new helper. ⏳

**Shopify**

- [shopify-connector.ts](../../server/src/remote-service/connectors/library/shopify/shopify-connector.ts) — incremental branch, capability-gated `supportsIncrementalPull`, `incrementalPull: true`. ⏳
- [shopify-api-client.ts](../../server/src/remote-service/connectors/library/shopify/shopify-api-client.ts) — `listEntities`/query builder gain optional `query:` + `SHOPIFY_QUERY_FILTERABLE` set. ⏳
- [shopify/graphql/schemas/](../../server/src/remote-service/connectors/library/shopify/graphql/schemas/) — annotate `updatedAt` on query-filterable entity schemas. ⏳
- `shopify/shopify-incremental.ts` — new helper. ⏳

**Already in place (no change)** — `ConnectorMetadata.incrementalPull` flag + default; the entire Web UI (menu actions, schedule rows, last-modified-field control); `PullLinkedFolderFilesJob` effective-mode/watermark logic; scheduler/API/CLI mode plumbing; `PullRecordFilesOptions`/`PullRecordFilesResult`; `X_SCRATCH_LAST_MODIFIED_FIELD`.

## Open questions

1. **HubSpot associations on incremental pulls** — Search API does not return associations. Recommended: incremental pulls omit association refresh; the periodic `FULL_PULL` reconciles (consistent with the base plan's deletion philosophy). Confirm acceptable, or require the heavier Search-IDs-then-batch-read-with-associations path (deferred by default).
   ANSWER:
2. **HubSpot >10k Search window** — a single incremental run is capped at 10k results by the Search API. Recommended: accept and document (steady-state deltas are small; bootstrap is always a full pull; watermark advances by what returned; `FULL_PULL` is the safety net). Confirm.
   ANSWER:
3. **Linear filter input-type names** — `FILTER_TYPE_MAP` (`issues → IssueFilter`, etc.) and each type's `updatedAt` comparator must be verified against the Linear SDK / GraphQL introspection during implementation. Implementation detail, not a product decision — flagged so it isn't missed.
   ANSWER: Verified against `@linear/sdk`'s generated documents (`node_modules/@linear/sdk/dist/_generated_documents.d.ts`). All six filter input types exist exactly as predicted — `issues → IssueFilter`, `projects → ProjectFilter`, `teams → TeamFilter`, `users → UserFilter`, `labels → IssueLabelFilter`, `cycles → CycleFilter` — and each exposes `updatedAt?: InputMaybe<DateComparator>`, where `DateComparator.gt` accepts a `DateTimeOrDuration` (an ISO-8601 string). `FILTER_TYPE_MAP` was implemented with these names; the per-entity mapping is asserted in `linear-api-client-incremental.spec.ts`.
