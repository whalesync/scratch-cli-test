# Incremental Pull — Connector Support Matrix

**Date**: 2026-06-03
**Author**: Chris Hoefgen
**Status**: In Progress
**Linear**: [DEV-9757](https://linear.app/whalesync/issue/DEV-9757/incremental-polling) (rollout epic); recent connector work tracked under DEV-10312 (Moco), DEV-10311 (Pipedrive), and DEV-10158 (HubSpot)

**Purpose**: A single living reference for **how every connector handles incremental pull** — the methodology where it is implemented, and the difficulty/risk where it is still pending. It replaces the per-connector status that was scattered across the part-3 plan and the feasibility appendix, and is the doc to consult before picking up the next connector.

## How incremental pull works (one paragraph)

The server pipeline (landed in the base + follow-up plans) gives every connector a generic contract: a connector overrides `incrementalPullSupport(options, tableSpec): IncrementalPullSupport` (`SUPPORTED` / `NEEDS_CONFIGURATION` / `NOT_SUPPORTED`) and implements an incremental branch in `pullRecordFiles` that captures `newWatermark = new Date()` **before** the first API call, asks the remote "what changed since `options.since`?" via a server-side predicate, subtracts a per-connector clock-skew margin (60s everywhere so far), and returns `{ newWatermark }`. Full pulls fall through unchanged and `return {}`. Flipping `ConnectorMetadata.incrementalPull: true` lights up the generic, capability-gated Web/desktop UI automatically — no client work per connector. Every connector here is the **server-side-predicate** archetype (a `modified-since` filter / sort / change feed on the list endpoint the connector already calls); client-side filtering after a full enumeration is explicitly **not** counted as incremental support, because it pages the whole table and saves no API calls.

The recurring **sub-patterns**:

- **Fixed system field** — the remote guarantees a modified-at field on every entity (Notion `last_edited_time`, Linear `updatedAt`, Moco `updated_at`, Pipedrive `update_time`). `incrementalPullSupport` is unconditional; no field resolver, no advanced setting.
- **Resolver + override (annotation-gated)** — the modified-at field varies, so the connector auto-detects it from the schema (`X_SCRATCH_LAST_MODIFIED_FIELD`) and lets the user override it (Airtable, PostgreSQL/Supabase, HubSpot). Folders with no resolvable field demote to full.
- **Capability-gated** — only some tables/entity types accept the predicate, so support is gated per table/entity (Intercom conversations-only, Shopify query-filterable entities, WordPress non-taxonomy collections, Brevo contacts/templates).

## Summary matrix

| Connector | Status | Mechanism (endpoint + param → field) | Sub-pattern | Difficulty | Notes |
| --- | --- | --- | --- | --- | --- |
| **Airtable** | ✅ Landed | `filterByFormula: IS_AFTER(LAST_MODIFIED_TIME(), since)` → annotated field | resolver + override | — | First connector; proves the contract |
| **PostgreSQL** | ✅ Landed | `WHERE <col> > $since` → user-declared `modifiedAtField` | resolver + override | — | No fixed field; column is user-configured |
| **Supabase** | ✅ Landed | `WHERE <col> > $since` (shares `pg-common`) | resolver + override | — | Same engine as PostgreSQL |
| **Notion** | ✅ Landed | `dataSources.query` JSON filter `last_edited_time` on-or-after | fixed system field | — | Single-level compound-filter nesting limit |
| **WordPress** | ✅ Landed | REST `?modified_after=<iso>` → `modified` | capability-gated (annotation) | — | Taxonomy demotes to full; site-timezone conversion |
| **Linear** | ✅ Landed | GraphQL `filter: { updatedAt: { gt } }` | fixed system field | — | Per-entity `FILTER_TYPE_MAP` |
| **Intercom** | ✅ Landed | Search `POST /conversations/search` `updated_at > <unix s>` | capability-gated (table) | — | Conversations only; Unix-seconds |
| **Moco** | ✅ Landed | REST `?updated_after=<iso8601 UTC>` → `updated_at` | fixed system field | — | All 3 entities; seconds-precision, UTC |
| **Pipedrive** | ✅ Landed | REST `?updated_since=<rfc3339>` → `update_time` | fixed system field | — | All 3 entities (deals/persons/orgs); whole-second RFC3339 (ms stripped — v2 parser rejects fractional seconds) |
| **HubSpot** | ✅ Landed | CRM Search `POST /crm/v3/objects/{type}/search`, `<field> GTE <epoch-ms>` → annotated property | resolver + override | — | Switches list→Search; associations omitted + 10k window (both reconciled by `FULL_PULL`) |
| **Webflow** | ✅ Landed | REST v2 `lastUpdated[gte]=<iso>` (+ `sortBy=lastUpdated` asc) → `lastUpdated` | capability-gated (table) | — | CMS collections only; Assets/Pages tables full-pull. SDK removed → pure-REST client passes the v2 filter directly; ms-precision ISO UTC, no stripping |
| **Shopify** | 🟡 Feasible | GraphQL root `query: "updated_at:>'<iso>'"` | capability-gated (entity) | Medium | Only some root connections accept `query:` |
| **QuickBooks** | 🟡 Feasible | CDC `GET /cdc?entities=…&changedSince=<iso>` → `MetaData.LastUpdatedTime` | fixed system field | Low–Med | Different endpoint; 30-day CDC window |
| **Brevo** | 🟡 Feasible | `GET /contacts?modifiedSince=<iso>` → `modifiedAt` | capability-gated (table) | Low | Contacts + templates only; lists stay full |
| **Attio** | ❌ Blocked | query endpoints filter, but records expose only `created_at` | — | — | No `updated_at` → catches creates, not edits |
| **Affinity** | ❌ Blocked | v2 list endpoints — no time filter | — | — | v1 `changed_after` gone; connector is v2-only |
| **Audienceful** | ❌ Blocked | `/people/` cursor list — no modified-since param | — | — | No `updated_at`; docs sparse (unconfirmed) |
| **Memberstack** | ❌ Blocked | `/members` cursor list — `limit`/`after`/`order` only | — | — | Webhooks are the only change signal |
| **Stripe** | ❌ Blocked | list filters on `created[gte]`, not last-modified | — | — | Only update feed is the Events API (new archetype) |
| **YouTube** | ❌ Blocked | `playlistItems.list` (no filter); `search.list` `publishedAfter` only | — | — | `publishedAfter` = creation, not modification |
| **Wix Blog** | 🚧 Special | base `pullRecordFiles` is a stub | — | — | Re-evaluate after the base pull lands |
| **Generic API** | ⚠️ Deferred | user-declared `modifiedAtField` + query-param name | resolver + override (user-configured) | High | Foot-gun: misconfig → silent data loss; v2 |

**Next batch (all Low difficulty, all proven fixed-system-field / capability-gated pattern):** QuickBooks, Brevo. **Shopify** is the last remaining part-3 connector (HubSpot landed under DEV-10158). Webflow **landed** under DEV-10310 once the `webflow-api` SDK was removed in favour of a pure-REST client — the v2 `lastUpdated` filter the SDK had hidden is now reachable. The remaining ❌ rows are blocked by the upstream API.

---

## Landed — methodology

### Airtable — `filterByFormula`, resolver + override

Builds an `IS_AFTER(LAST_MODIFIED_TIME(), '<since − skew>')` formula fragment and combines it with any user-supplied `filterByFormula`. The modified-at field is auto-detected from the schema annotation and user-overridable (`modifiedAtField`); a table with no resolvable last-modified field demotes to full. 60s clock-skew (`LAST_MODIFIED_TIME()` is server-side, watermark client-side).

### PostgreSQL / Supabase — SQL `WHERE <col> > $since`, resolver + override

Adds a `WHERE <modified_col> > $since` predicate (clock-skewed) to the enumeration query. SQL has no universal modified-at column, so the column is **user-declared** via the `modifiedAtField` advanced setting (no annotation to auto-detect); without it the run demotes to full. Supabase reuses the shared `pg-common` predicate/support helpers verbatim. 60s clock-skew.

### Notion — `dataSources.query` filter on `last_edited_time`, fixed system field

Every Notion page carries the system `last_edited_time`, so support is unconditional. Incremental adds a `last_edited_time` "on or after" member to the `dataSources.query` JSON filter, combined with the user's existing filter. Caveat: Notion limits compound filters to a single level of nesting, so the combiner refuses rather than over-nests. 60s clock-skew.

### WordPress — REST `?modified_after`, capability-gated by collection

Post-type and media collections accept `?modified_after=<iso>` and expose `modified` (annotated). **Taxonomy** collections have neither, so they demote to full. Caveat: `modified_after` filters against `post_modified` in the **site's timezone**, not GMT — `formatWordPressModifiedAfter` resolves the site timezone from the REST index and renders the watermark as site-local wall-clock; it degrades to UTC if the index can't be read (and `FULL_PULL` reconciles). 60s clock-skew.

### Linear — GraphQL `filter: { updatedAt: { gt } }`, fixed system field

Every Linear entity has a server-side `updatedAt` and every list connection accepts a typed `filter`. The query builder injects `$filter` of the entity's filter-input type (`FILTER_TYPE_MAP`: `issues → IssueFilter`, etc., SDK-verified) with `{ updatedAt: { gt: <since − skew> } }`. `gt` is exclusive, so the 60s margin matters; idempotent commits absorb the boundary re-pull.

### Intercom — Conversations Search API, capability-gated by table

Only **Conversations** can filter server-side: `POST /conversations/search` with `query: updated_at > <unix-seconds>`, ascending sort, cursor pagination. Articles/Collections have no `updated_at` filter and stay full-scan. This is the table where it matters most — a full pull hydrates one API call per conversation. Timestamps are **Unix seconds** (not ms). Ascending sort keeps stateless cursor pagination stable (a record updated mid-page moves to the tail → possible duplicate, never a miss). 60s clock-skew.

### Moco — REST `?updated_after`, fixed system field

Every Moco resource (companies, contacts/people, projects) carries `updated_at`, and Moco accepts `?updated_after=<iso8601-utc>` on all three list endpoints, so support is unconditional. Unlike WordPress, `updated_after` is documented as **UTC**, so no timezone conversion — but Moco's parser requires **seconds precision** and rejects the fractional-second component `Date.toISOString()` emits with a 400, so the milliseconds are stripped. Deletions aren't covered by the filter (Moco recommends delete-webhooks; out of scope, `FULL_PULL` reconciles). 60s clock-skew.

### Pipedrive — REST `?updated_since`, fixed system field

deals, persons, and organizations all carry a server-side `update_time`, and all three v2 list endpoints (`getDeals`/`getPersons`/`getOrganizations`) accept `?updated_since=<rfc3339>` (verified against the installed `pipedrive@31.2.1` SDK request types), so support is unconditional. An optional `updatedSince` is threaded into `listEntities` and added to the v2 request params; the existing opaque-cursor pagination is unchanged. `updated_since` is **inclusive (`>=`)**, but the watermark is client-side so the 60s margin still applies. Like Moco, Pipedrive's v2 `updated_since` parser rejects the fractional-second component, so `buildPipedriveUpdatedSince` strips milliseconds and emits whole-second RFC3339 UTC (`YYYY-MM-DDTHH:mm:ssZ`). `update_time` is annotated with `X_SCRATCH_LAST_MODIFIED_FIELD` for the UI picker. Only the filter is used (no `sort_by`) — the predicate already returns the changed set and cursor pagination is stable, matching Moco.

### HubSpot — CRM Search API, resolver + override

The standard list endpoint (`GET /crm/v3/objects/{type}`) can't filter by modified date, so incremental **switches endpoints** to the **CRM Search API** (`POST /crm/v3/objects/{type}/search`) with a `<field> GTE <epoch-ms>` filter sorted **ascending** by that field, cursor-paged via the search `after` offset (`searchRecordsModifiedSince` in `hubspot-api-client.ts`; the body builder + 60s `HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS` live in `hubspot-incremental.ts`). The watermark is rendered as **epoch milliseconds** — the format the Search API accepts uniformly across object types. The modified-date property is object-type-dependent (`hs_lastmodifieddate` for most objects, `lastmodifieddate` for contacts, custom objects vary), so it's the Airtable-style resolver + override: the schema builder annotates whichever candidate the object exposes (`X_SCRATCH_LAST_MODIFIED_FIELD`, preferring `hs_lastmodifieddate`), `resolveHubspotModifiedAtField` prefers an explicit `modifiedAtField` advanced setting over the annotation, and an object with neither reports `NEEDS_CONFIGURATION`. `GTE` is inclusive but the watermark is client-side → 60s clock-skew; ascending sort keeps cursor pagination stable.

- **Caveat — associations**: the Search API returns `properties` but **not** `associations`, so incremental pulls don't refresh association data — the periodic `FULL_PULL` reconciles association drift (same philosophy as deletions). The heavier search-IDs-then-batch-read-with-associations path is deferred.
- **Caveat — 10k window**: a single Search result set is capped at 10,000 records. Steady-state deltas are small; bootstrap is always a full pull; the watermark advances by what returned and the next run continues. `FULL_PULL` is the safety net.

### Webflow — REST `lastUpdated[gte]`, fixed system field (capability-gated by table)

Every Webflow CMS item carries a server-side `lastUpdated`, and the v2 List Collection Items endpoint accepts a `lastUpdated[gte]=<iso>` range filter (the "Enhanced filtering and sorting" 08/08/2025 changelog: `createdOn`/`lastUpdated`/`lastPublished`, each `gte`/`lte`, plus `sortBy`/`sortOrder`). Incremental threads an optional `lastUpdatedSince` into `WebflowApiClient.listCollectionItems` → `lastUpdated[gte]` plus `sortBy=lastUpdated&sortOrder=asc`, so under offset pagination an item updated mid-pull migrates to the tail (re-pulled, never skipped). `lastUpdated` is annotated with `X_SCRATCH_LAST_MODIFIED_FIELD` like Moco/Pipedrive, but the field is fixed (no resolver, no `modifiedAtField` advanced setting). Support is **capability-gated by table type**: only real CMS collections take the filter — the synthetic site-level **Assets** and **Pages** tables have no changed-since filter and demote to full. The gate keys off the collection remote id (`DataFolder.tableId[1]`), so the REST capability layer resolves it without a schema read (no `incrementalPullAutoDetectsFromSchema`). `lastUpdated[gte]` is **inclusive (`>=`)** and the watermark is client-side, so the 60s clock-skew margin applies; unlike Moco/Pipedrive, Webflow emits — and accepts — millisecond-precision ISO-8601 UTC, so `buildWebflowLastUpdatedFilter` keeps the milliseconds (no stripping). Deletions aren't covered by the filter; `FULL_PULL` reconciles them.

- **Unblocked by the SDK removal.** The block was never the API — it was that the vendored `webflow-api@3.2.1` SDK didn't surface the `lastUpdated` filter. With the SDK removed (DEV-10313) the connector now calls v2 REST through its own axios client (`WebflowApiClient`), which passes the filter param directly. *(Wire-format caveat: Webflow's reference doesn't print a literal example of the `lastUpdated[gte]` bracket serialization. Axios percent-encodes the brackets (`lastUpdated%5Bgte%5D`), which a conformant server decodes — verify against a live request when exercising the connector.)*

---

## Planned — methodology, difficulty, and caveats

### Shopify — GraphQL `query:` search, capability-gated by entity · **Medium**

Every resource has a server-side `updatedAt`, and root connections accept `query: "updated_at:>'<iso>'"` — **but only some root connections support `query:`** (products, orders, customers, draftOrders, articles, blogs, metaobjects, …). So support is gated by a static `SHOPIFY_QUERY_FILTERABLE` set (derive/verify from `ENTITY_REGISTRY` + Shopify's documented searchable connections); non-filterable entities demote to full. Child entities hydrate through their parent, so incremental applies at the parent level. Shopify search `>` is exclusive → 60s margin matters.

### QuickBooks — Change Data Capture endpoint, fixed system field · **Low–Medium**

Every QBO entity carries `MetaData.LastUpdatedTime`, and Intuit ships a purpose-built incremental endpoint: `GET /v3/company/{realmId}/cdc?entities=<types>&changedSince=<iso8601>`. Slightly more than a query param because CDC is a **different endpoint** with a different response envelope (one `CDCResponse` with per-entity arrays) — add a `cdcSince(entities, since)` client method rather than threading a param into the existing SQL-`query` path.

- **Caveat — 30-day window**: CDC only spans the last 30 days; a folder dormant >30 days falls back to full (the job already bootstraps full and `FULL_PULL` is the periodic safety net).
- **Caveat — response cap**: a single CDC response is capped; page/segment as the API allows.

### Brevo — `modifiedSince`, capability-gated by table · **Low**

`GET /contacts?modifiedSince=<iso>` (and the templates list takes the same filter) → `modifiedAt`. **Mailing lists have no modified timestamp**, so they stay full-scan — Intercom-style per-table gate. Fixed field, no resolver/advanced-setting. Add a `brevo-incremental.ts` helper (param builder + 60s constant).

---

## Not currently upgradeable (with the current API)

- **Attio** — query endpoints support `$gt`/`$gte` date filters, **but the records the connector models expose only `created_at`, no `updated_at`**. Filtering on `created_at` catches new records but misses edits → not a true incremental pull. Revisit if Attio exposes a record-level last-modified timestamp.
- **Affinity** — built entirely on v2 endpoints (`/persons`, `/companies`, `/opportunities`, `/notes`, `/lists/{id}/list-entries`); none accept a modified-since param, and the core records expose no last-modified field. (v1 had `changed_after` on lists; the connector is v2-only.)
- **Audienceful** — single People table via cursor list; no documented modified-since param and no `updated_at` field (only `created_at`/`last_activity`). Docs sparse — treat as *unconfirmed*, revisit if the vendor documents a filter.
- **Memberstack** — Members cursor list accepts only `limit`/`after`/`order`; members carry `createdAt`/`lastLogin` but no last-modified field. Webhooks are the only change signal — a different archetype, out of scope.
- **Stripe** — list endpoints filter on `created[gte]` (creation), **not** last-modified. The only update signal is the **Events API** (`*.updated` events), an opaque-cursor/change-feed pattern over a separate endpoint — a genuine future option, but a new archetype not implemented in the framework.
- **YouTube** — enumerates the uploads playlist via `playlistItems.list` (no temporal filter) then hydrates by id. `search.list` offers `publishedAfter`, but that is publish (creation) time, not modification, and there is no change feed for metadata edits.

## Special cases

- **Wix Blog — blocked on a missing base pull.** `pullRecordFiles` is currently a stub that returns empty files. Incremental is premature: the base full pull must land first. When it does, `queryDraftPosts` + Wix Query Language supports `$gt`/`$gte` on `editedDate`, so this could become an annotation-gated `editedDate` connector. Re-evaluate after the base pull lands.
- **Generic API — feasible but deliberately deferred.** No fixed schema or upstream API — each connection points at an arbitrary REST/GraphQL endpoint. Incremental *could* be supported with two per-endpoint advanced settings (a user-declared `modifiedAtField` and a `modifiedSinceParam`), making it an annotation-gated, user-configured variant. The risk is a foot-gun: a wrong field/param silently filters out changed records (data loss) with no way to validate against a known API. **Recommendation: not v1.** If pursued, gate behind probe-time validation (only advertise incremental when a sample response contains the declared field and the param demonstrably narrows results) and surface clear misconfiguration errors.

## Verification notes

- **Pipedrive `updated_since`** — verified against the installed SDK type definitions (`node_modules/pipedrive/dist/versions/v2/api/{deals,persons,organizations}-api.d.ts`); all three list requests expose `updated_since` (inclusive `>=`), `updated_until`, and `sort_by`. **Landed** (DEV-10311) using `updated_since` only; `sort_by` was available but unnecessary.
- **Linear `FILTER_TYPE_MAP`** — verified against `@linear/sdk`'s generated documents; all six filter input types exist and each exposes `updatedAt?: DateComparator`.
- **Attio / Affinity / Audienceful / Memberstack** — verdicts rest on the connector's own TypeScript models exposing no last-modified field, cross-checked against vendor docs. Audienceful is doc-sparse — treat its "No" as "unconfirmed, no evidence of a filter."
- **Webflow** — **Landed** (DEV-10310). With the `webflow-api` SDK removed (DEV-10313), `WebflowApiClient.listCollectionItems` issues the v2 REST `lastUpdated[gte]` filter directly (`sortBy=lastUpdated` asc for stable offset pagination). Capability-gated by table (CMS collections only; Assets/Pages full-pull) via `webflowIncrementalPullSupport(collectionRemoteId)`. The one detail to confirm against a live request is the bracket serialization of `lastUpdated[gte]` (axios percent-encodes it to `lastUpdated%5Bgte%5D`, which a conformant server decodes); Webflow's docs don't print a literal example.
- **QuickBooks / Brevo / Stripe / YouTube** — external-API capabilities confirmed against current vendor documentation. For QuickBooks (CDC envelope) and Brevo (templates-list filter parity), re-confirm the exact request/response shape against the installed SDK at implementation time.
