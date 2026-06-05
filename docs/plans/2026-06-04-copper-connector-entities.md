# Copper CRM Connector — Entity Research & Support Plan

**Linear:** [DEV-10301 — Copper connector](https://linear.app/whalesync/issue/DEV-10301/copper-connector) (child of DEV-10297, the CRM epic)
**Goal:** Read/write connector for [Copper CRM](https://www.copper.com/).
**Date:** 2026-06-04
**Author:** Ivan Dimitrov
**Status:** In Review

---

## 1. API shape (what constrains the connector)

Copper exposes a RESTful, JSON API. The facts that drive connector design:

| Concern | Detail |
| --- | --- |
| **Base URL** | `https://api.copper.com/developer_api/v1/` |
| **Auth** | Headers `X-PW-AccessToken` (API key), `X-PW-Application: developer_api`, `X-PW-UserEmail`. OAuth also available. |
| **Listing** | There is **no plain `GET /people`**. You list via **`POST /{entity}/search`** with a JSON body. |
| **Pagination** | Body params `page_number` (1-based), `page_size` (default 20, **max 200**), `sort_by`, `sort_direction`. Page until a short page is returned. No cursor. **Hard ceiling: search returns at most the first 100,000 matching records** — full-scan must partition (e.g. by `date_created` ranges) or **warn-and-log the truncation**, never silently stop (product principle: surface failures). `id` is **not** guaranteed sortable; `date_modified desc` is not stable under concurrent writes. |
| **Bulk writes ≠ read page size** | The 200 above is the **read** page size. Copper's **bulk write** endpoints are beta, **max ~10 records**, **create/update only (no bulk delete)**, and **not offered for every entity** (e.g. Opportunities shows bulk create but not bulk update). They return **`200 OK` with per-record failure objects** — every response item must be inspected; a batch-level success check silently drops failed writes. So `getBatchSize` is small and per-operation/per-entity, *not* 200. |
| **Rate limit** | **180 requests/minute (~3 req/s)**; bulk endpoints share a 3 req/s cap. `429` on exceed. Rate-limit the client accordingly (cf. Pipedrive's `{ points: 10, duration: 2 }`). |
| **Custom fields** | Returned on records as `custom_fields: [{ custom_field_definition_id, value }]`. Definitions discovered via `GET /custom_field_definitions` — **dynamic schema discovery**, no hardcoding. Field identity is **keyed by `custom_field_definition_id`**, with display label separate (never index- or name-keyed — indexes shift, names rename/collide). **`Connect`-type and computed custom fields are read-only** — discovery must mark them `x-scratch-readonly`, or "Connect deferred" is a lie. Update applies **only the fields you send**, so prefer sending the **sparse** changed entries over rebuilding the whole array (see R1). |
| **Incremental** | Every core record has `date_modified` (Unix seconds). Search supports `sort_by: "date_modified", sort_direction: "desc"` (all entities) and a server-side `minimum_modified_date` filter on several entities. Enables incremental pulls. |
| **Terminology gotcha** | The web UI's "Account" is called **Portfolio** in the API. The `GET /account` endpoint returns *your* Copper instance (a singleton), not a CRM "account". |

---

## 2. Suggested entities

**Legend** — CRUD: ✅ supported / ⚠️ partial / ❌ none. "Incremental" = can be pulled changed-only via `date_modified`.

### Tier 1 — Core record tables (pull / sync / publish as files)

These are the editable CRM objects. They are the connector's reason to exist and map cleanly to our file-per-record model.

| Entity | v1? | Endpoint | CRUD | Bulk | List API | Custom fields | Incremental archetype¹ | Key relationships (foreign keys) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **People** | ✅ v1 | `/people` | C R U D | ✅ | `POST /people/search` | ✅ | ⚠️ client-filter (sort `date_modified` desc) | `company_id`→Companies, `assignee_id`→Users, `contact_type_id`→Contact Types. **`email` is a unique key.** |
| **Companies** | ✅ v1 | `/companies` | C R U D | ✅ | `POST /companies/search` | ✅ | ⚠️ client-filter (verify server filter) | `assignee_id`→Users, `contact_type_id`→Contact Types |
| **Opportunities** | ✅ v1 | `/opportunities` | C R U D | ✅ | `POST /opportunities/search` | ✅ | ⚠️ client-filter (verify server filter) | `company_id`→Companies, `primary_contact_id`→People, `assignee_id`→Users, `pipeline_id`→Pipelines, `pipeline_stage_id`→Stages, `customer_source_id`→Customer Sources, `loss_reason_id`→Loss Reasons |
| **Leads** | ✅ v1 | `/leads` | C R U D | ✅ + upsert | `POST /leads/search` | ✅ | ✅ server-predicate (`minimum_modified_date`, confirmed) | `assignee_id`→Users, `customer_source_id`→Customer Sources. Note: `company_name` is a **string**, not a Company FK (leads are pre-conversion). |
| **Tasks** | ✅ v1 | `/tasks` | C R U D | ❌ | `POST /tasks/search` | ✅ | ⚠️ verify server filter | `assignee_id`→Users, `related_resource` `{type,id}`→People/Companies/Opportunities/Leads/Projects |
| **Projects** | ✅ v1 | `/projects` | C R U D | ❌ | `POST /projects/search` | ✅ | ⚠️ verify server filter | `assignee_id`→Users, `related_resource`→parent entity |
| **Activities** | ⏭️ later | `/activities` | ⚠️ user-only | ✅ | `POST /activities/search` | ❌ | ❌ none (no `date_modified`; append-only) | `parent` `{type,id}`→People/Lead/Opportunity/Company, `user_id`→Users, `type`→Activity Types |

> ¹ **Incremental is a fast-follow, not v1 (eng-review decision D3).** When built, it splits into two `CONNECTOR_GUIDE.md` archetypes — and the archetype is **not uniform across entities**, which the API forces:
> - **Server-side predicate** — Leads `/search` accepts `minimum_modified_date` (confirmed). Cheapest; the remote filters. Verify which other entities expose it at implementation time (do **not** assume People does — its docs expose only `minimum_created_date`).
> - **Client-side filter during pagination** — for entities without a `minimum_modified_date` filter (People confirmed; others TBD): sort `date_modified desc` and early-terminate when a record predates the watermark. Works **only because** Copper guarantees the sort order. Capture the watermark *before* the first call (the guide's watermark-before-first-call rule).
> - **Activities** have no `date_modified` at all → no incremental; always full-scan.

**Per-entity quirks to handle:**

- **People / Companies** — contact data is **arrays of typed objects**: `emails: [{email, category}]`, `phone_numbers: [{number, category}]`, `socials`, `websites`. Store verbatim (product principle: preserve external shape; adapt the view, not the data). A `displayTransformer` on the column can flatten these for display in the table view without teaching the frontend about Copper.
- **Opportunities** — the richest FK surface (7 relationships). This is where pipeline/stage/source/loss-reason **lookup tables become foreign-key option sources** (`x-scratch-foreign-key`). `status` ∈ {open, won, lost, abandoned}.
- **Leads** — support **upsert** (by email) and conversion (a lead converts into Person + Company + Opportunity). `company_name` is free text, *not* a relation — don't model it as an FK.
- **Tasks / Projects** — polymorphic parent via `related_resource: {type, id}`. No bulk endpoints → `getBatchSize` = 1.
- **Activities (deferred to a later PR — decision D2)** — **special-cased**: only `category: "user"` activities (incl. Notes) can be created/updated; `category: "system"` activities are **read-only** (writes rejected — let the API reject rather than silently stripping, per our "surface failures" principle). No `custom_fields`. No `date_modified` — they're effectively append-only, so incremental must key off `activity_date` (`minimum_activity_date` in search). Deleted activities are still returned as **stubs**. Annotate the `type.category` field with `x-scratch-agent-instructions` so agents know system activities are read-only. This is exactly why it's split out of v1 — the read-only/append-only fork doesn't fit the CRUD/publish ladder cleanly.

### Tier 2 — Lookup / metadata resources (schema & FK options, **not** editable tables)

These are read during `fetchJsonTableSpec` to **discover the schema dynamically** and to populate **foreign-key option lists** (`x-scratch-foreign-key` + `displayTransformer` to show labels instead of raw IDs). Per our "keep connector knowledge out of the frontends" principle, these resolve IDs → human labels on the server. Default: **do not expose as separate editable tables** — surface them only if a user explicitly wants to browse them (read-only).

| Resource | Endpoint | CRUD | Role in the connector |
| --- | --- | --- | --- |
| **Custom Field Definitions** | `/custom_field_definitions` | R (CRUD avail.) | **Drives dynamic schema** for every Tier-1 entity. Resolve `custom_field_definition_id` → name/type/options. |
| **Users** | `/users/search`, `/users/{id}` | R | FK options + display for every `assignee_id` / `user_id`. |
| **Pipelines (+ Stages)** | `/pipelines` | R | Stages are nested in each pipeline. FK options for Opportunity `pipeline_id` / `pipeline_stage_id`. |
| **Customer Sources** | `/customer_sources` | R | FK options for Lead / Opportunity `customer_source_id`. |
| **Lead Statuses** | `/lead_statuses` | R | FK options + display for Lead `status_id` (was missing — Lead status parity with Opportunity status). |
| **Loss Reasons** | `/loss_reasons` | R | FK options for Opportunity `loss_reason_id`. |
| **Contact Types** | `/contact_types` | R | FK options for People / Companies `contact_type_id`. |
| **Activity Types** | `/activity_types` | R | Resolve Activity `type.id` → label. Splits into `user` + `system` categories. |
| **Custom Activity Types** | `/activity_types/custom` | C R U | Subset of activity types that *are* user-manageable. |
| **Tags** | `/tags` | R | Autocomplete / validation for the `tags: []` string arrays on records. |
| **Account (Portfolio)** | `/account` | R | Singleton (your Copper instance). Useful for `testConnection()`. Not a CRM table. |

### Out of scope (deferred — eng-review decisions)

- **Activities** (`/activities`) — **deferred to a later PR (decision D2).** Doesn't fit the CRUD/publish ladder: only `category: "user"` rows are writable, `system` rows are read-only, there's no `date_modified`, and the entity is append-only. Build the six clean entities first, then revisit Activities with explicit user/system special-casing.
- **Incremental pull** — **deferred to a fast-follow (decision D3).** v1 ships full-scan only. Incremental needs the two per-entity archetypes documented in footnote ¹, and each entity's server-side `minimum_modified_date` support must be verified first.
- **Webhooks** (`/webhooks`) — push notifications. Not needed for the pull/publish model; revisit only if Copper-driven real-time sync is wanted.
- **Related Items** (`/{entity}/{id}/related`) — generic relationship graph. Records carry their key relations inline as FK fields; `/related` is an extra round-trip we don't need.
- **File uploads / Connect Fields** — niche; defer.

---

## 3. Recommended rollout (post eng-review)

1. **v1 — the six writable record entities, full-pull:** People, Companies, Opportunities, Leads, Tasks, Projects. Full CRUD + bulk (where the API offers it), dynamic custom fields, **full-scan pull (no incremental yet)**. Tier-2 lookups wired in as FK option sources + display transformers. Shape = the Pipedrive connector, widened to six entities and a `/search`-based list.
2. **Fast follow:** incremental pull (per-entity archetype, footnote ¹) + the **Activities** entity with user/system read-only special-casing.
3. **Later (only if asked):** Webhooks, Related Items graph, file uploads.

**Implementation notes**, following the existing pattern (closest analog: [`pipedrive-connector.ts`](../../server/src/remote-service/connectors/library/pipedrive/pipedrive-connector.ts)):

- `listTables()` returns the six v1 entity types (static list, like Pipedrive's `ENTITY_TYPES`).
- `testConnection()` calls `GET /account` — lightest authenticated call, confirms the `X-PW-AccessToken` / `X-PW-Application` / `X-PW-UserEmail` headers resolve.
- `fetchJsonTableSpec()` merges a static system-field schema per entity with **dynamically discovered custom fields** from `/custom_field_definitions`, and annotates FK fields with `x-scratch-foreign-key` pointing at the Tier-2 lookups. **Memoize the lookup fetches per connector instance** — Opportunities alone fans out to 6+ lookup calls at 3 req/s, so an unmemoized rebuild is seconds of latency (cf. Pipedrive's `customFieldKeysCache`).
- `pullRecordFiles()` paginates `POST /{entity}/search` with `page_size: 200`. **Pagination is offset-based (`page_number`), not cursor** — checkpoint `page_number` into `connectorProgress` so a stalled BullMQ job resumes mid-table (the guide's WordPress offset archetype), and sort by a stable key (`date_modified` or `id`) so mid-pull inserts don't silently skip rows.
- `getBatchSize(operation)` is **per-operation, decoupled from the 200 read page size**: `create`/`update` = **≤10** for entities that offer bulk write (beta cap), **1** for Tasks/Projects and for any entity without that bulk op; `delete` = **1** (no bulk delete). Inspect **every** item in a bulk `200 OK` response for per-record failures — don't trust batch-level success.
- **`custom_fields` is an array `[{ custom_field_definition_id, value }]`, not a flat map.** Store it verbatim. **Decide the write strategy with a live API contract test first (R1):** Copper applies only the fields sent, so the **preferred** path is to send only the *sparse changed entries* — which sidesteps both array reconstruction and clobbering concurrent Copper-side edits. Full-array resend is the fallback only if sparse updates aren't honored.
- Mark server-computed fields (`date_created`, `date_modified`, `date_last_contacted`, `interaction_count`) `x-scratch-readonly` so they're never sent on write. **Also mark People `company_id` read-only in v1** (it's set via Related Items, which is deferred — R8), plus all `Connect`-type and computed custom fields.
- Store the **verbatim** API response per record (arrays of `{email, category}` etc.) — adapt the view layer, never reshape the data.
- `rateLimiterSpec: { points: 3, duration: 1 }` (~3 req/s); map `429` → `API_QUOTA_EXCEEDED` with retry/back-off in the api-client.

---

## 4. What already exists (reuse, don't rebuild)

| Existing code | What Copper reuses |
| --- | --- |
| [`pipedrive-connector.ts`](../../server/src/remote-service/connectors/library/pipedrive/pipedrive-connector.ts) | Near-exact template: static entity list, dynamic custom fields, `getBatchSize`, axios + `RateLimiter`, registry registration, `customFieldKeysCache`. |
| `hubspot` connector | CRM custom fields under a `properties`-style object; incremental via `resolveModifiedAtField` (for the fast-follow). |
| `attio` / `affinity` connectors | FK option sources + `defaultView` (column layouts, FK dropdowns showing labels not IDs). |
| `extractCommonDetailsFromAxiosError`, `ErrorMessageTemplates`, `RateLimiter`, `connectorRegistry`, `suggestFileNamesFromFieldPaths`, the per-connector `*-incremental.ts` helper shape | Used as-is — no new infrastructure. |

The connector spends **zero innovation tokens** — it's the established pattern. New code = `CopperConnector` + `CopperApiClient` classes plus the schema/types modules, exactly like every other connector.

## 5. Implementation risks (must have a test)

| # | Risk | Why it bites | Guards needed |
| --- | --- | --- | --- |
| R1 | **`custom_fields` write strategy** | Full-array resend from stale local JSON can clobber concurrent Copper edits; wrong splice silently corrupts siblings — no error surfaces | **Live API contract test first:** confirm sparse `custom_fields` updates apply only the sent entries. Then unit-test the chosen path preserves the other N−1 by `custom_field_definition_id` |
| R2 | **`createRecords` id write-back + crash-before-persist** | If the id isn't written back via `writeRecordId` — or Scratch crashes after Copper creates but before persisting the id — the next publish duplicates the record | Test id write-back; for People/Companies lean on Copper's uniqueness (email) and for Leads on upsert as the dedupe backstop; document the residual duplicate window |
| R3 | **Offset pagination correctness (not just resume)** | `page_number` checkpointing fixes re-fetch cost but **not correctness** — rows added/modified mid-pull shift the offset window and can be included or omitted | Sort by `date_modified` (only sortable stable-ish key); accept that idempotent commits absorb dupes; **the periodic full pull is the reconciliation** — note this explicitly |
| R4 | **`429` handling** | 3 req/s is easy to exceed; a bare throw fails the whole job instead of backing off | Test: `429` → `API_QUOTA_EXCEEDED`; api-client honors retry-after |
| R5 | **Polymorphic `related_resource` / `parent`** (Tasks, Projects) | `{type, id}` write shape; wrong type string is rejected | Test: round-trip a Task linked to each parent type |
| R6 | **Bulk partial failure** | Bulk write returns `200 OK` with per-record failure objects; a batch-level success check silently drops failed writes | Test: bulk response with a mixed success/failure body surfaces the failures |
| R7 | **100k search ceiling** | Full-scan silently truncates a CRM with >100k records of one type | Partition the scan (`date_created` ranges) or warn-and-log the cap; test the truncation path emits a warning, never a silent stop |
| R8 | **People `company_id` write requires Related Items** | Changing a Person's company is a Related Items call, not a normal update; with Related Items deferred, that write is a silent no-op | **Decision: `company_id` is read-only in v1** (`x-scratch-readonly`) so we never pretend to write it. Confirm with a live contract test whether update truly ignores it before locking the annotation; revisit (pull minimal Related Items in) in the fast-follow if users need to reassign companies |

## 6. Test plan (ship with implementation, per `CONNECTOR_TEST_PATTERN`)

All 14 planned codepaths need coverage before v1 is "done" (R1 and R2 are the data-loss guards):

```
testConnection()       → GET /account: happy + 401→API_UNAUTHORIZED
listTables()           → returns the six v1 entities
fetchJsonTableSpec()   → custom field of each type → schema; FK annotation on Opportunity; lookup memoized on 2nd build
pullRecordFiles()      → multi-page offset pagination; short last page; resume from mid-table page (R3)
pullRecordFilesByIds() → bulk-ish fetch; 404 skipped
createRecords()        → id written back (R2); custom_fields array sent correctly
updateRecords()        → changedFields → custom_fields array reconstruction preserves siblings (R1, CRITICAL)
deleteRecords()        → already-deleted (404) is a no-op
createRecords/updateRecords (bulk) → 200 OK with per-record failures surfaces them (R6)
pullRecordFiles()      → 100k ceiling: truncation warns/partitions, never silent stop (R7)
getSuggestedRecordFileNames() → name/title field
extractConnectorErrorDetails() → 429→quota (R4), 401→unauthorized
```

> **Contract test (not unit):** before implementing the write path, hit a sandbox Copper instance to confirm (a) sparse `custom_fields` updates apply only the sent entries (R1), and (b) whether `company_id` on People is writable via update or strictly via Related Items (R8).

## 7. Live validation (2026-06-04, test account "Ivan Dimitrov's Company")

Verified against a live Copper test account while implementing:

- **R1 (sparse update) — PASSED.** A `PUT` with only `{title}` changed `title` and left `name`/`details`/`emails` untouched, on both **People** and **Leads**. Connector sends the sparse `changedFields` payload; no full-array reconstruction needed.
- **Full CRUD round-trip — PASSED** for People and Leads: create returns the assigned `id`, sparse update applies only sent fields, delete → 200, get-after-delete → 404.
- **Shapes confirmed:** People/Companies are flat with typed `emails`/`phone_numbers` arrays; **Leads use a single `email` object** (not an array); `status_id` → `lead_statuses` FK resolves.
- **Metadata endpoints return data:** `contact_types`, `customer_sources`, `loss_reasons`, `lead_statuses`, `activity_types`. `custom_field_definitions` is empty on this account (custom-field column expansion still needs a contract test once fields exist).
- **Leads enabled** on the account (`setting_enable_leads = true`); `/lead_statuses` now 200 (was 403).
- **Not yet live-tested:** Opportunities (no pipelines on the account), Tasks, Projects, and the custom-field write path.

---

## Sources

- [Copper Developer API — getting started](https://developer.copper.com/)
- [People overview](https://developer.copper.com/people/overview.html) · [List People (Search)](https://developer.copper.com/people/list-people-search.html)
- [Activities overview](https://developer.copper.com/activities/overview.html) · [List Activities (Search)](https://developer.copper.com/activities/list-activities-search.html)
- [List Leads / Companies / Opportunities / Tasks / Projects (Search)](https://developer.copper.com/) (parallel `/search` endpoints)
- [Paginating search results](https://developer.copper.com/introduction/pagination.html)
- [Rate limits](https://developer.copper.co/api-reference/rate-limits) · [Truto integration guide](https://truto.one/blog/integrate-copper) (180 req/min)
- [API docs & tips — Copper Help Center](https://support.copper.com/en/articles/8823462-api-docs-and-tips)

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 6 issues, 0 critical gaps, scope reduced |
| Outside Voice | Codex (read-only) | Independent 2nd opinion | 1 | issues_found | ~15 findings; auth header, bulk-size, 100k ceiling, computed/Connect CF, company_id-via-Related-Items folded in |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a (backend only) | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **Decisions:** D1 = six writable entities (People/Companies/Opportunities/Leads/Tasks/Projects); D2 = Activities deferred; D3 = incremental deferred to fast-follow.
- **CROSS-MODEL:** T1 (Codex: ship 4 first) → user kept six (machinery is shared, marginal cost low). T2 (People `company_id` via Related Items) → read-only in v1, pending R8 contract test.
- **CODEX:** factual corrections folded into §1 / §3 / §5 (auth header `developer_api`, read-page-size vs bulk-write-size, bulk partial-failure inspection, 100k search ceiling, computed/Connect custom fields read-only, Lead Statuses lookup, sparse `custom_fields` write preferred).
- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED (eng + outside voice) — ready to implement v1. Two contract tests (R1 sparse custom_fields, R8 company_id writability) gate the write path.
