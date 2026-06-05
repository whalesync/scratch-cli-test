# HighLevel (GoHighLevel) connector — endpoint & entity reference

Quick reference for every HighLevel object/entity, what the connector does with it, and the
key per-endpoint quirks. Source: official OpenAPI specs in
[`GoHighLevel/highlevel-api-docs`](https://github.com/GoHighLevel/highlevel-api-docs)
(`apps/*.json`) — the rendered docs at marketplace.gohighlevel.com are JS-rendered/ClickUp-embedded
and not machine-readable.

## Cross-cutting facts (apply to every endpoint)

| Fact             | Value                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base host        | `https://services.leadconnectorhq.com` (v1 `rest.gohighlevel.com` is EOL 31 Dec 2025 — do not use)                                                                  |
| Mandatory header | `Version: 2021-07-28` on **every** request (omitting it fails obscurely)                                                                                            |
| Auth (current)   | Private Integration Token (PIT) — `Authorization: Bearer <token>`, scoped to one Location                                                                           |
| Auth (future)    | OAuth2 auth-code; agency installs return a Company token → exchange for a Location token                                                                            |
| Location scoping | Most endpoints need the Location ID **explicitly** — but the param name/placement is **not** consistent (see notes)                                                 |
| Rate limits      | 100 req / 10s burst, 200k/day, **per app per location**                                                                                                             |
| Pagination       | **NOT standardized** — each entity paginates differently (see table)                                                                                                |
| Schema source    | System fields are **static** (enumerated from the OpenAPI). Custom fields are **discovered dynamically** per Location and only exist for some entities (see below). |

## Unified object table

`Implemented` = **true if the object is at least readable (pullable) in Scratch today**.
`Scope` = how the records are addressed: **location** (location-wide list), **object** (via the
Objects API, dynamically discovered), **contact** (only listable per-contact), **funnel** (needs a
parent funnel id). **Writes (publish) are implemented for Contacts, Opportunities, and Custom
Objects** (create/update/delete); Pipelines and the generic location entities stay read-only. The
`Writable (API)` column reflects whether the HighLevel API itself supports writes (audited where
✅/❌; `—` = not audited, we only pull).

Write quirks: custom-field values are sent as `{ id, field_value }` (read shapes `value`/`fieldValue`
are mapped on publish); `locationId` is required in the **body** for contact/opportunity/object
_creates_ but as a **query param** for object _updates_ (PUT records/{id}); custom-object updates send
the full `properties` bag (the records API replaces it). Opportunity create requires
pipelineId/name/status/contactId (+ injected locationId).

| Object              | Implemented | Scope    | List endpoint                          | Pagination                  | Custom fields       | Writable (API) |
| ------------------- | ----------- | -------- | -------------------------------------- | --------------------------- | ------------------- | -------------- |
| **Contacts**        | ✅          | location | `POST /contacts/search`                | `searchAfter` (per-item) ⚠️ | ✅ key `value`      | ✅ CRUD+upsert |
| **Opportunities**   | ✅          | location | `GET /opportunities/search`            | `startAfter`+`startAfterId` | ✅ key `fieldValue` | ✅ CRUD+status |
| **Pipelines**       | ✅          | location | `GET /opportunities/pipelines`         | none                        | ❌                  | ❌ reference   |
| **Custom Objects**¹ | ✅          | object   | `POST /objects/{key}/records/search`   | `page` ⚠️                   | ✅ `properties` bag | ✅ records API |
| **Calendars**       | ✅          | location | `GET /calendars/`                      | none                        | ❌                  | —              |
| **Calendar Groups** | ✅          | location | `GET /calendars/groups`                | none                        | ❌                  | —              |
| **Campaigns**       | ✅          | location | `GET /campaigns/`                      | none                        | ❌                  | —              |
| **Conversations**   | ✅          | location | `GET /conversations/search`            | `startAfterDate`+`id` ⚠️    | ❌                  | —              |
| **Forms**           | ✅          | location | `GET /forms/`                          | `limit`+`skip`              | ❌                  | —              |
| **Trigger Links**   | ✅          | location | `GET /links/`                          | none                        | ❌                  | —              |
| **Products**        | ✅          | location | `GET /products/`                       | `limit`+`offset`            | some                | —              |
| **Proposals**       | ✅          | location | `GET /proposals/document`              | `limit`+`skip`              | ❌                  | —              |
| **Surveys**         | ✅          | location | `GET /surveys/`                        | `limit`+`skip`              | ❌                  | —              |
| **Users**           | ✅          | location | `GET /users/`                          | none                        | ❌                  | —              |
| **Workflows**       | ✅          | location | `GET /workflows/`                      | none                        | ❌                  | —              |
| **Blog Authors**    | ✅          | location | `GET /blogs/authors`                   | `limit`+`offset`            | ❌                  | —              |
| **Blog Categories** | ✅          | location | `GET /blogs/categories`                | `limit`+`offset`            | ❌                  | —              |
| Tasks               | ❌          | contact  | `GET /contacts/{id}/tasks`             | —                           | ❌                  | ✅             |
| Notes               | ❌          | contact  | `GET /contacts/{id}/notes`             | —                           | ❌                  | ✅             |
| Appointments        | ❌          | contact  | `GET /contacts/{id}/appointments`      | —                           | ❌                  | —              |
| Calendar Events     | ❌          | location | `GET /calendars/events`                | none                        | ❌                  | —              |
| Funnels (pages)     | ❌          | funnel   | `GET /funnels/page`                    | `limit`+`offset`            | ❌                  | —              |
| Payments            | ❌          | location | `GET /payments/orders`,`/transactions` | `limit`+`offset`            | ❌                  | —              |
| Associations        | ❌          | location | `GET /associations/`                   | `limit`+`skip`              | ❌                  | —              |
| Email Templates     | ❌          | location | `GET /emails/builder`                  | `limit`+`offset`            | ❌                  | —              |

¹ **Custom Objects** is one row but expands to **N tables** — discovered at runtime from
`GET /objects/` (one table per object, grouped "Custom Objects"). The standard `business`
object surfaces here too (often labeled "Companies"); standard `contact`/`opportunity` are
excluded since they have dedicated tables.

### Why the ❌ rows are not implemented

- **Tasks / Notes / Appointments** — **contact-scoped only**: no location-wide list, so a standalone
  table would require an N+1 fan-out over every contact. Instead they're available as **opt-in
  deep-fetched sub-arrays on the Contact record** — enable "Include contact notes/tasks/appointments"
  in the Contacts advanced settings and they're embedded as `record.notes` / `.tasks` /
  `.appointments` (one extra request per contact when enabled; off by default).
- **Calendar Events** — needs required `startTime`/`endTime` params (not a plain list).
- **Funnels (pages)** — needs a required `funnelId` (parent-scoped, not location-wide).
- **Payments** — addressed by `altId`/`altType`, not `locationId` — different param model.
- **Associations / Email Templates** — the list response isn't a clean records-array envelope
  in the spec; skipped pending a verified shape.

## Implementation notes & quirks

### The 3 built-in business objects

- **Contacts pagination is the one unverified piece.** `SearchBodyV2DTO` is empty in the OpenAPI
  and the `searchAfter` mechanism is undocumented; we implement the community pattern (each
  contact carries a `searchAfter` array; pass the last item's value back). Needs empirical
  confirmation for >100-contact accounts. `searchAfter` is **stripped from each record before
  storage** (pagination transport, not data).
- **Opportunities** uses `location_id` (snake*case) — the \_only* endpoint that does; Contacts uses
  `locationId` in the body, everything else uses `locationId` in the query. Its `customFields`
  value key is `fieldValue` (Contacts use `value`). `pipelineId`/`contactId` are annotated as
  foreign keys to the Pipelines/Contacts tables.
- **Pipelines** has no get-by-ID endpoint, so `pullRecordFilesByIds` re-fetches all and filters.

### Custom fields (the dynamic part of the schema)

- For Contacts/Opportunities: discovered from `GET /locations/{locationId}/customFields` →
  `{ customFields: [{ id, name, fieldKey, dataType, picklistOptions, model, ... }] }`, filtered by
  `model` (`contact` vs `opportunity`). Stored verbatim as a `{ id, <valueKey> }` array; the
  id→name/type mapping is documented in an `x-scratch-agent-instructions` annotation.
- For Custom Objects: field defs come from `GET /objects/{key}?fetchProperties=true`; record values
  live in a keyed **`properties`** bag (keyed by `fieldKey`).
- `dataType` values: `TEXT`, `LARGE_TEXT`, `NUMERICAL`, `PHONE`, `MONETORY`, `SINGLE_OPTIONS`,
  `MULTIPLE_OPTIONS`, `DATE`, `CHECKBOX`, `FILE_UPLOAD`, `RADIO`, `EMAIL`.
- Pipelines and the generic location entities have **no custom fields** — fully static / permissive
  (`id` + `additionalProperties: true`, stored verbatim).

### Generic location entities (the config-driven set)

The location-scoped read-only tables (Calendars … Blog Categories above) share one generic schema
builder + one generic paginated pull, driven by `gohighlevel-entities.ts`. Each config declares its
list path, response array key, `idField` (`id`, or `_id` for products/proposals/blogs), and
pagination style (`none` / `skip` / `offset` / `conversations`). Offset/skip pulls stop on a short
page; Conversations cursors on the last record's date + id (⚠️ best-effort, verify live).

⚠️ **Per-endpoint `limit` caps.** HighLevel caps `limit` differently per endpoint and the OpenAPI
descriptions are **wrong** (forms says "max 50" but accepts 100). Exceeding the cap returns
`422 "limit must not be greater than N"` which **silently fails the whole folder pull** (empty
folder, job still reports success). Empirically verified caps (set via `pageLimit` in the config):
**proposals = 20**, **surveys = 50**, **blog authors/categories = 50**; forms, products,
conversations (and contacts/opportunities/objects, which use 100) accept 100. When adding a new
location entity, **probe its real `limit` cap at 100 first** rather than trusting the docs.

### Custom Objects API

| Method | Endpoint                              | Purpose                                   | Used by connector   |
| ------ | ------------------------------------- | ----------------------------------------- | ------------------- |
| GET    | `/objects/`                           | List object definitions (`standard` flag) | ✅ `listTables`     |
| GET    | `/objects/{key}?fetchProperties=true` | Object definition + field definitions     | ✅ schema discovery |
| POST   | `/objects/{schemaKey}/records/search` | List records (page-based)                 | ✅ pull             |
| GET    | `/objects/{schemaKey}/records/{id}`   | Get one record                            | ✅ pull-by-id       |

- The table `wsId` is a sanitized slug; the **real object key** (e.g. `custom_objects.pet`) rides in
  `EntityId.remoteId[0]`.
- ⚠️ `SearchRecordsBody` requires `locationId`, `page`, `pageLimit`, `query`, `searchAfter` (all). We
  send `query: ''` + `searchAfter: []`, paginate by `page`, and stop on the first **empty** page
  (robust to the API capping page size). Empty-query "match all" is the assumption to verify.
- If the token lacks the objects scope, `listTables` **warns and falls back** to the built-in tables.

> Note: contact **custom-field definitions** come from the **Locations** API
> (`/locations/{locationId}/customFields`), **not** the v2 `/custom-fields/` API — that one only
> covers Custom Objects and the Company object.
