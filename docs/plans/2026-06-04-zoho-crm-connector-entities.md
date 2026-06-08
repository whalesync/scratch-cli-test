# Zoho CRM Connector — Recommended Entity Support

**Status**: In Progress
**Author**: Ivan Dimitrov
**Date**: 2026-06-04
**Linear**: [DEV-10300](https://linear.app/whalesync/issue/DEV-10300)

> **Implementation status (2026-06-04):** v1 foundation + Tier 1 read/write path built in `server/src/remote-service/connectors/library/zoho/` (api-client, dynamic discovery, schema engine, pull with `page_token`+incremental, write with sanitizer). Auth v1 = `user_provided_params` (Client ID/Secret + Refresh Token + Data Center); OAuth-redirect provider deferred. Lint/typecheck green; 21 unit tests pass; read path + an update round-trip **live-validated** against the test org. **Remaining:** the read-only `users` reference table (separate endpoint, not in `/settings/modules`), live create/delete (test org is at its 5000-record cap), Tier 2 modules (absent in the low-edition test org), then subforms/assets/Bulk Read per the tiers below.

## Summary

This document recommends which **Zoho CRM entities** a new Scratch connector should support, and how each maps onto Scratch's connector model. The goal is a first-class Zoho CRM connector that pulls every CRM module into Scratch as a table of raw JSON record files, round-trips edits back through the published/approved/local review ladder, and supports incremental pulls — matching and then exceeding Whalesync's existing iApp-based Zoho connector.

The headline recommendation is **dynamic discovery, not a hardcoded module list**. The connector should enumerate tables from Zoho's `GET /settings/modules` metadata endpoint and build each table's field schema from `GET /settings/fields?module={api_name}` at runtime. This is mandated by Scratch's "Discover schemas dynamically; don't hardcode" principle and is directly enabled by Zoho's metadata API: `/settings/modules` returns every standard, custom, linking, and subform module — with `api_name`, `generated_type`, `api_supported`, and `creatable`/`editable`/`deletable` flags — so an admin who adds a custom module or field in Zoho sees it appear in the Scratch picker with **zero connector code change**. HubSpot is the precedent to copy (standard objects from a known set, custom objects appended dynamically via `getCustomObjectSchemas()`); Zoho should drive the *entire* list from `/settings/modules`. If that metadata call fails, the connector **retries with backoff and then surfaces a clear error** — it does **not** fall back to a hardcoded list, which would reintroduce the very hardcoding this design removes and silently hide the failure (violating "surface failures; never silently succeed").

In Scratch terms, **"supporting an entity" means a Zoho module becomes a selectable Scratch table (a DataFolder) whose schema is discovered dynamically and whose records are stored 1-file-per-record as the verbatim raw API response.** Concretely the connector must (1) **list** the module as a `TablePreview` from `listTables()` with `EntityId = { wsId: <api_name>, remoteId: [<api_name>] }`; (2) **describe** it via `fetchJsonTableSpec(id)` that maps each Zoho field to a TypeBox sub-schema annotated with `x-scratch-*` extensions (readonly, connector-data-type, foreign-key, enums); (3) **read** it by streaming records verbatim through `pullRecordFiles` with a resumable progress cursor and an incremental (`Modified_Time`) path; and (4) **write** it via `createRecords`/`updateRecords`/`deleteRecords` that respect Zoho's batch limits and surface API rejections rather than silently stripping read-only edits. Storing the verbatim record — lookup objects as `{id, name}`, subforms as nested arrays, picklists as their stored value — is what gives Scratch round-trip fidelity that Whalesync's display-name-collapsing model loses. (Fidelity caveat: v1 stores a **best-effort full-field projection** — every field, assembled from Zoho's response and field-batched where a module has >50 fields, so it is verbatim in *content* but not always the single literal payload — and it **excludes** subforms, multi-select-lookups, and assets, which need single-record fetch or binary download. True verbatim-with-subforms lands with the subform read path — see Decisions.)

## How Scratch beats Whalesync

Whalesync's Zoho connector is a thin delegate over the external iApp/Membrane framework. Its limitations are the opportunity:

- **Dynamic vs. static module list.** Whalesync hardcodes **14** static collection keys (`Deals`, `Tasks`, `Calls`, `Campaigns`, `Contacts`, `Events`, `Leads`, `Notes`, `Vendors`, `Accounts`, the synthetic `deals-by-pipeline` view, plus org-metadata `users`/`roles`/`profiles`) and only discovers *custom* modules dynamically. Scratch discovers **all** modules via `/settings/modules`, so standard modules Whalesync omits appear automatically.
- **More standard modules.** Scratch adds the modules Whalesync's custom-module path can't surface (they're standard, not custom): **Quotes, Sales_Orders, Purchase_Orders, Invoices, Price_Books, Products, Cases, Solutions, Attachments**, and the read-only **Activities** aggregate.
- **Custom modules, schema for free.** Both surface custom modules; Scratch gets their full *field schema* (including custom fields) free from `/settings/fields` — no per-field mapping. (Write behavior is not free: custom modules can carry custom layouts, required fields, subforms, and permission constraints — handled by the eligibility policy, not assumed away.)
- **File/image asset fields.** Whalesync hard-disables every `Record_Image` field (`mappingDisabled: true`, DEV-4270) and all file fields. Scratch can model `fileupload`/`imageupload`/`Record_Image` as asset fields (read-only in v1; see Open Questions) instead of dropping them.
- **Full verbatim records, not a 50-field projection.** Whalesync caps fetches at ~50 mapped fields and fetches only mapped columns — a sparse projection that conflicts with Scratch's verbatim-full-record model. Scratch fetches every field (batching `>50` field requests where required) so the on-disk record is the complete Zoho response.
- **Stable IDs for lookups, not display-name drift.** Whalesync collapses lookups/picklists to the **display name**, losing the stable Zoho ID (DEV-4362); a renamed option silently breaks a previously-matching write. Scratch stores the raw `{id, name}` object verbatim and resolves display in the schema/view layer — robust to renames, and `id` is the authoritative write key.
- **True incremental pull.** Whalesync has **no** timestamp watermark — it re-polls full tables every session and leans on iApp webhooks for change capture. Scratch can implement real incremental pull via Zoho's `If-Modified-Since` header + `Modified_Time` (server-side predicate), capturing the watermark before the first call — drastically cutting the API-quota pressure that drives Whalesync's "map at most 5 tables" advisory.
- **Subforms & related lists.** Whalesync exposes neither. Scratch can hydrate subform arrays (line items on Quotes/Orders/Invoices) in place as part of the verbatim record, and optionally model related lists.
- **Currency / polymorphic lookups.** Whalesync drops currency-code context and disables polymorphic/multi-module lookups (DEV-4360). Scratch can model these from dynamic metadata.

## Recommended entities

R/W key: **Read+Write** = create/update/delete supported; **Read-only** = pull only. **Incremental** = `Modified_Time` system field present (server-side `If-Modified-Since`). **WS parity**: ✅ already in Whalesync / 🆕 new in Scratch. Tiers: **1** core CRM, **2** sales-cycle + support + notes, **3** org-metadata read-only reference + custom modules.

Rows ordered by Tier, then Category. Per-entity specifics (notable fields + relationships) are in the companion table below to keep this one readable.

| Entity | Zoho `api_name` | Category | What it is | R/W | Incremental | Volume / quota | WS parity | Tier |
|---|---|---|---|---|---|---|---|---|
| Leads | `Leads` | Sales | Unqualified prospects; convertible to Contact+Account+Deal | Read+Write | Yes | High | ✅ in WS | 1 |
| Contacts | `Contacts` | Sales | People / individual customers | Read+Write | Yes | High | ✅ in WS | 1 |
| Accounts | `Accounts` | Sales | Companies / organizations | Read+Write | Yes | High | ✅ in WS | 1 |
| Deals | `Deals` | Sales | Opportunities/Potentials in a sales pipeline | Read+Write | Yes | High | ✅ in WS | 1 |
| Tasks | `Tasks` | Activities | To-do items linked to a record | Read+Write | Yes | High | ✅ in WS | 1 |
| Calls | `Calls` | Activities | Logged/scheduled phone calls | Read+Write | Yes | High | ✅ in WS | 1 |
| Meetings (Events) | `Events` | Activities | Calendar events/meetings (label "Meetings") | Read+Write | Yes | Med–High | ✅ in WS | 1 |
| Quotes | `Quotes` | Inventory | Sales quotes (has `Product_Details` subform) | Read+Write | Yes | Med | 🆕 new in Scratch | 2† |
| Sales Orders | `Sales_Orders` | Inventory | Confirmed customer orders (subform) | Read+Write | Yes | Med | 🆕 new in Scratch | 2† |
| Purchase Orders | `Purchase_Orders` | Inventory | Orders placed to vendors (subform) | Read+Write | Yes | Med | 🆕 new in Scratch | 2† |
| Invoices | `Invoices` | Inventory | Customer invoices/billing (subform) | Read+Write | Yes | Med | 🆕 new in Scratch | 2† |
| Products | `Products` | Inventory | Goods/services sold or procured | Read+Write | Yes | Med | 🆕 new in Scratch | 2 |
| Price Books | `Price_Books` | Inventory | Pricing models (has `Pricing_Details` subform) | Read+Write | Yes | Low | 🆕 new in Scratch | 2 |
| Vendors | `Vendors` | Inventory | Suppliers / procurement sources | Read+Write | Yes | Low–Med | ✅ in WS | 2 |
| Campaigns | `Campaigns` | Marketing | Marketing campaigns | Read+Write | Yes | Med | ✅ in WS | 2 |
| Cases | `Cases` | Support | Customer support tickets | Read+Write | Yes | Med | 🆕 new in Scratch | 2 |
| Solutions | `Solutions` | Support | Knowledge-base solution articles | Read+Write | Yes | Low | 🆕 new in Scratch | 2 |
| Notes | `Notes` | Notes & Files | Free-text notes attached to records (polymorphic parent) | Read+Write | Yes | High | ✅ in WS | 2 |
| Attachments | `Attachments` | Notes & Files | Attachment **metadata** (file name/size/type); binary download deferred to v2 | Read-only · metadata (v1) | Yes | High | 🆕 new in Scratch | 2 |
| Appointments | `Appointments__s` | Service | Scheduled service appointments (newer module) | Read+Write | Yes | Low–Med | 🆕 new in Scratch | 2 |
| Services | `Services__s` | Service | Bookable services catalog (for Appointments) | Read+Write | Yes | Low | 🆕 new in Scratch | 2 |
| Users | `users` (`GET /users`) | Org metadata | CRM users — target of every `Owner`/`Created_By` lookup | **Read-only** | Yes (`If-Modified-Since`) | Low | ✅ in WS | 3 |
| Roles | `roles` (`GET /settings/roles`) | Org metadata | Role hierarchy (self-referential) | **Read-only** | No | Low | ✅ in WS | 3‡ |
| Profiles | `profiles` (`GET /settings/profiles`) | Org metadata | Permission profiles | **Read-only** | No | Low | ✅ in WS | 3‡ |
| Currencies | `currencies` (`GET /org/currencies`) | Org metadata | Multi-currency definitions (feature-gated) | **Read-only** | No | Low | 🆕 new in Scratch | 3‡ |
| Territories | `territories` (`GET /settings/territories`) | Org metadata | Sales territory hierarchy (feature-gated, Ent+) | **Read-only** | No | Low | 🆕 new in Scratch | 3‡ |
| Tags | `tags` (`GET /settings/tags?module=X`) | Org metadata | Tag definitions per module | **Read-only** (defs) | No | Low–Med | 🆕 new in Scratch | 3‡ |
| Custom modules | `<label-derived>` (e.g. `Students`) | Custom | User-created modules discovered dynamically | Read+Write (per metadata flags) | Yes | Varies | ✅ in WS | 3 |

**† Subform-gated (Decision #3):** `Quotes`/`Sales_Orders`/`Purchase_Orders`/`Invoices` ship **after** the subform read path lands, so records aren't missing their line items (the subform is the bulk of the record). The rest of Tier 2 ships first.
**‡ Deferred past v1 (Decision #5):** only `users` ships in the first org-metadata pass; `roles`/`profiles`/`currencies`/`territories`/`tags` use bespoke non-uniform endpoints and come later.

### Companion table — per-entity specifics

Notable fields and relationships are characteristic examples discovered from `/settings/fields`; exact `api_name`s should be confirmed at runtime since orgs rename/add fields.

| Entity | Notable / characteristic fields (`api_name`) | Key relationships (lookups → target table) |
|---|---|---|
| `Leads` | `Last_Name`, `Company`, `Email`, `Phone`, `Lead_Source`, `Lead_Status`, `Owner` | `Owner`→`users`; convertible to Contacts/Accounts/Deals |
| `Contacts` | `Last_Name`, `First_Name`, `Email`, `Phone`, `Mailing_City`, `Account_Name` | `Account_Name`→`Accounts`; `Reporting_To`→`Contacts`; `Owner`→`users` |
| `Accounts` | `Account_Name`, `Phone`, `Website`, `Industry`, `Annual_Revenue` | `Parent_Account`→`Accounts`; `Owner`→`users` |
| `Deals` | `Deal_Name`, `Amount`, `Closing_Date`, `Stage`, `Pipeline`, `Probability`, `Expected_Revenue`, `Next_Step` | `Account_Name`→`Accounts`; `Contact_Name`→`Contacts`; `Campaign_Source`→`Campaigns`; `Stage`/`Pipeline`→Pipelines metadata; `Owner`→`users` |
| `Tasks` | `Subject`, `Due_Date`, `Status`, `Priority` | `What_Id`→parent record (Accounts/Deals/…); `Who_Id`→Leads/Contacts; `Owner`→`users` |
| `Calls` | `Subject`, `Call_Type`, `Call_Start_Time`, `Call_Duration`, `Call_Result` | `What_Id`→parent; `Who_Id`→Leads/Contacts; `Owner`→`users` |
| `Events` | `Event_Title`/`Subject`, `Start_DateTime`, `End_DateTime`, `Venue`, `Participants`, `Recurring_Activity` (RRULE) | `What_Id`→parent; `Who_Id`→Leads/Contacts; `Participants`→Users/Contacts/Leads |
| `Quotes` | `Subject`, `Quote_Stage`, `Valid_Till`, `Grand_Total`, `Product_Details` (subform) | `Account_Name`→`Accounts`; `Contact_Name`→`Contacts`; `Deal_Name`→`Deals`; line items→`Products` |
| `Sales_Orders` | `Subject`, `Status`, `Grand_Total`, `Due_Date`, `Product_Details` (subform) | `Account_Name`→`Accounts`; `Quote_Name`→`Quotes`; `Deal_Name`→`Deals` |
| `Purchase_Orders` | `Subject`, `Status`, `Tracking_Number`, `Grand_Total`, `Product_Details` (subform) | `Vendor_Name`→`Vendors`; `Contact_Name`→`Contacts`; line items→`Products` |
| `Invoices` | `Subject`, `Status`, `Invoice_Date`, `Grand_Total`, `Product_Details` (subform) | `Account_Name`→`Accounts`; `Sales_Order`→`Sales_Orders`; line items→`Products` |
| `Products` | `Product_Name`, `Product_Code`, `Unit_Price`, `Product_Category`, `Qty_in_Stock`, `Product_Active` | `Vendor_Name`→`Vendors`; `Owner`→`users` |
| `Price_Books` | `Price_Book_Name`, `Active`, `Pricing_Model`, `Pricing_Details` (subform) | line items→`Products`; `Owner`→`users` |
| `Vendors` | `Vendor_Name`, `Phone`, `Email`, `Website`, `Category`, `City` | `Owner`→`users`; referenced by `Products` & `Purchase_Orders` |
| `Campaigns` | `Campaign_Name`, `Type`, `Status`, `Start_Date`, `End_Date`, `Expected_Revenue`, `Budgeted_Cost` | `Owner`→`users`; members→Leads/Contacts via related lists |
| `Cases` | `Subject`, `Status`, `Priority`, `Case_Origin`, `Type`, `Reason` | `Account_Name`→`Accounts`; `Contact_Name`→`Contacts`; `Product_Name`→`Products`; `Deal_Name`→`Deals` |
| `Solutions` | `Solution_Title`, `Solution_Number`, `Status`, `Question`, `Answer`, `Published` | `Product_Name`→`Products`; `Owner`→`users` |
| `Notes` | `Note_Title`, `Note_Content`, `$se_module` | `Parent_Id`→**polymorphic** parent (any module); `Owner`→`users` |
| `Attachments` | `File_Name`, `Size`, `$type`, `$se_module` | `Parent_Id`→**polymorphic** parent (any module) |
| `Appointments__s` | `Appointment_For`, `Appointment_Start_Time`, `Duration`, `Status` | `Appointment_For`→**multi-module lookup** (Contacts/custom); `Service`→`Services__s`; `Contact_Name`→`Contacts` |
| `Services__s` | `Name`, `Duration`, `Price`, `Location`, `Job_Sheet_Required` | referenced by `Appointments__s` |
| `users` | `id`, `full_name`, `email`, `status`, `time_zone`, `locale` | `role`→`roles`; `profile`→`profiles` |
| `roles` | `id`, `name`, `display_label`, `share_with_peers` | `reporting_to`→`roles` (self-hierarchy) |
| `profiles` | `id`, `name`, `category`, `permission_details` | assigned to `users` |
| `currencies` | `iso_code`, `symbol`, `exchange_rate`, `is_base`, `is_active` | base-currency flag; target of currency fields |
| `territories` | `id`, `name`, `criteria`, `permission_type` | `parent_territory`→`territories`; `manager`→`users` |
| `tags` | `id`, `name`, `color_code` | scoped per module; applied to records via `Tag` array |
| custom modules | dynamic (per `/settings/fields`) | dynamic lookups per field metadata |

> **Note on `Org`.** A single `GET /org` record (company name, currency, license details) is better surfaced as **workbook metadata** than as a syncable folder — it is a singleton and not record data. Not listed as a table above.
>
> **Note on `deals-by-pipeline`.** Whalesync invents this as a separate fake table. Scratch should **not** create a duplicate table — pipeline grouping is a server-computed table-view concern (group `Deals` by the `Pipeline` field, order stages by the pipeline's `maps[]`), exposed declaratively through the column metadata, not as connector branching in the frontend.

## Entity tiers & rollout

**Tier 1 — Core CRM (ship first).** `Leads`, `Contacts`, `Accounts`, `Deals`, and the three activity modules (`Tasks`, `Calls`, `Events`). These are universally present (all editions, Free+), high-volume, and the records every Zoho user thinks of as "their CRM." This tier proves the full pipeline end-to-end: dynamic discovery, schema generation with FK/picklist annotations, verbatim pull, incremental pull via `Modified_Time`, and read+write round-trip. The deprecated read-only `Activities` aggregate is **skipped** (see Decisions) — `Tasks`/`Calls`/`Events` cover the data.

**Tier 2 — Sales cycle, support, notes, service (non-subform first).** `Products`, `Price_Books`, `Vendors`, `Campaigns`, support (`Cases`, `Solutions`), `Notes`/`Attachments`, and the newer `Appointments__s`/`Services__s`. Polymorphic lookups here (`Notes`/`Attachments` `Parent_Id`, MML `Appointment_For`) are stored **verbatim with no FK** (Decision #2) — no per-row publish transform needed. Inventory and Support are Professional-edition+ and simply won't appear via discovery on Free/Standard orgs, so no edition branching is needed.

**Tier 2† — Subform-heavy inventory (after the subform read path).** `Quotes`, `Sales_Orders`, `Purchase_Orders`, `Invoices`. These are mostly their `Product_Details` line-item subform, so they ship once subform reads exist — shipping them without line items would mean shipping gutted records (Decision #3). `Price_Books`/`Pricing_Details` subform reads land here too.

**Tier 3 — Org-metadata reference (read-only) + custom modules.** v1 ships **`users` only** (target of every `Owner`/`Created_By` lookup). `roles`/`profiles`/`currencies`/`territories`/`tags` are deferred (bespoke non-uniform endpoints, Decision #5). Custom modules ride along automatically once dynamic discovery is in place — no dedicated tier work, but their write capability is gated by per-module `creatable`/`editable`/`deletable` flags.

**Suggested implementation order:** dynamic discovery + schema generation engine → `users` reference table (so Tier 1 owner lookups resolve) → Tier 1 (full pull/push/incremental via `page_token` + `Modified_Time`) → Tier 2 non-subform modules → subform read path → Tier 2† inventory → asset fields, deferred org-metadata, and custom-module polish.

## Field-type mapping

Drive the JSON-schema primitive from `json_type` and the view/column type + special handling from `data_type`. Set `x-scratch-readonly` whenever `data_type ∈ {formula, rollup_summary, autonumber}` **OR** `field_read_only == true` **OR** `operation_type.api_update == false` — this generically catches all system fields (`id`, `Created_Time`, `Modified_Time`, `Created_By`, `Modified_By`, `Last_Activity_Time`). Store Zoho's `api_name` on every field via `x-scratch-remote-field-id`.

| Zoho `data_type` | JSON-schema type | Scratch annotation / handling | Read-only? |
|---|---|---|---|
| `text`, `textarea`, `email`, `phone`, `website` | `string` (`format: email`/`uri` where apt; `maxLength` from `length` via `x-scratch-max-length`) | plain text; `x-scratch-connector-data-type: zoho/<type>` | No |
| `picklist` | `string` | **enum** — `Type.Union([...Type.Literal(actual_value), Type.Null()])` from `pick_list_values` filtered to `type==="used"`, ordered by `sequence_number`; carry `display_value`+`colour_code` to view layer | No |
| `multiselectpicklist` | `array` of `string` | enum-constrained array (`json_type: jsonarray`) | No |
| `boolean` | `boolean` | — | No |
| `integer` | `integer` | — | No |
| `bigint` | `string` (preserve >2^53 precision) | treat as string end-to-end (also applies to record `id`) | No |
| `double`, `currency`, `percent` | `number` | honor `decimal_place`; currency value is a bare number — record-level `Currency`/`Exchange_Rate` carry the code/rate | No |
| `date` | `string` | `format: date` (`YYYY-MM-DD`) | No |
| `datetime` | `string` | `format: date-time`; preserve ISO-8601 **with offset** verbatim (don't normalize to UTC) | No |
| `lookup` | `object` `{id, name}` (or `null`) | **`x-scratch-foreign-key` { linkedTableId: `<lookup.module.api_name>` }**; store raw `{id, name}`, write `{id}` | No |
| `ownerlookup`, `userlookup` | `object` `{id, name, email}` | `x-scratch-foreign-key` → `users`; `Owner` writable, `Created_By`/`Modified_By` read-only | `Owner` no; audit yes |
| `multiselectlookup` | `array` of FK | multi-valued FK via junction module; **returned only on single-record fetch**; publish writes junction sub-records (Enterprise+) | No |
| `multimodulelookup` (MML) | `object` `{module:{api_name}, id, name}` | store **verbatim, no FK** (Scratch FK is single-target); key is `module.api_name`+`id` (Decision #2) | No |
| `subform` | `array` of `object` | nested line-items, hydrate-in-place verbatim; **ID-aware publish** (see Quirks); returned only on single-record fetch | No (but ID-aware) |
| `formula` | per `json_type` | **`x-scratch-readonly`** | **Yes** |
| `rollup_summary` | `number` | **`x-scratch-readonly`** | **Yes** |
| `autonumber` | `string` | **`x-scratch-readonly`** | **Yes** |
| `fileupload`, `imageupload` | `string`/`object` (token/IDs) | **`x-scratch-asset-field` { urlExpires: true }**; recommend read-only in v1 (out-of-band binary download/upload) | v1: Yes |
| `Record_Image` / `profileimage` | `string` (opaque encrypted token) | asset field; **read-only** (no public URL, separate `/photo` multipart endpoint) | **Yes** |
| `consent_lookup` (GDPR) | `object` | nested object, store verbatim; present only if GDPR enabled | No |
| `RRULE` (`Recurring_Activity`) | `object` w/ iCalendar `RRULE` string | store string verbatim, don't parse | No |

## Module & field eligibility policy (from eng review)

Drive selectability and writability from the flags Zoho already returns in `/settings/modules` and `/settings/fields` — never show a table or field as editable that the API will reject. This applies "surface failures" *before* publish instead of after.

- **List only usable modules.** Show a module in `listTables()` only when `api_supported` (and visible / status active). Unsupported or hidden modules are not listed.
- **Module create-gating.** When a module's metadata is `creatable: false`, set `disabledCreates: true` + a `disabledReason` on its `TablePreview` — the framework supports this (`TablePreview` has `disabled?` / `disabledCreates?` / `disabledReason?`). Pull and edit still work; only new-record creation is blocked, with the reason shown.
- **Read-only fields → `x-scratch-readonly`.** Non-editable, system, formula, rollup, and autonumber fields are marked read-only in the schema so the UI renders them **locked before publish**, and the write-payload sanitizer strips them.
- **Required fields in the schema.** Mark Zoho-required fields as `required` in the TypeBox schema and seed them in `getNewFile`, so a new record carries the fields Zoho needs rather than failing create with a "required field missing" error.
- **v1 uses the default layout.** Required/read-only/picklist values can differ per layout; v1 builds the schema from the module's default layout and documents multi-layout handling as a known limitation (revisit if customers lean on non-default layouts).

## Implementation notes (from eng review)

**Pull flow (v1):**

```
 GET /settings/modules ──▶ [module list] ──▶ listTables()
      │  (fail: retry w/ backoff, then error — NO static fallback)
      ▼
 GET /settings/fields?module=X ──▶ field metadata
      ▼
 build TypeBox schema   (data_type → json type + x-scratch-* ;
   readonly if formula/rollup/autonumber | field_read_only | !api_update)
      ▼  fetchJsonTableSpec()
 watermark = server time (resp Date / max Modified_Time) + small overlap  ◀── BEFORE first call
      ▼
 GET /{module}?fields=…&per_page=200  [+ If-Modified-Since when incremental]
      │  ├─ split >50 fields across calls, merge
      │  ▼
      │  callback(files, {nextPageToken}) ──▶ git commit + checkpoint
      ▲  │
      └──┘ follow page_token until more_records=false   (cap 100k → Bulk Read later)
      ▼
 GET /{module}/deleted?type=all  [If-Modified-Since] ──▶ tombstone removed records
```

- **One declarative `data_type` map.** Implement the `data_type` → schema mapping (table above) as a single lookup/`switch` with an `assertUnreachable` default (server `CLAUDE.md` convention) so a new Zoho `data_type` fails the build instead of silently degrading to `string`.
- **Cover every required `Connector` member.** Beyond list/fetch/pull/CRUD, the implementation must define `getSuggestedRecordFileNames` (title field differs per module — `Deal_Name`/`Last_Name`/`Subject`/`Product_Name`, via `tableSpec.titleColumnRemoteId`), `getBatchSize` (Zoho write cap = **100 records/call**), `getNewFile`, and `extractConnectorErrorDetails`.
- **Escape JSON-pointer segments at publish time.** Use `escapePointerToken` (CONNECTOR_GUIDE → "Reading annotations back") when reading `x-scratch-readonly`/`x-scratch-foreign-key` back, so a custom field whose api_name contains `/` or `~` can't silently leak a read-only field into the write payload.
- **Discovery failure is loud.** `/settings/modules` failure → retry with backoff → clear error; no hardcoded fallback list.
- **Reuse Scratch's `RateLimiter`.** Register `rateLimiterSpec` and call `ctx.createRateLimiter(connectorAccount.id)` (like Pipedrive `pipedrive-connector.ts:309`), tuned to Zoho's concurrency (~10 in-flight) with 429 → backoff-and-resume (the pull is idempotent/resumable, so a 429 mid-run is safe).
- **Fetch each module's field metadata once.** `/settings/fields` is read in `fetchJsonTableSpec` and reused for the whole pull — don't re-fetch per page. Note the cost: a module with >50 fields needs `ceil(fields/50)` record calls per page, so a 120-field module is ~3× the backfill credits; incremental pull keeps steady-state cheap.

## Testing

**v1 ships two focused unit suites** (decided in eng review, hardened against the Codex challenge); broader pull/write coverage stays live/manual via Ivan's API key.

**Committed in v1 (pure-function unit tests — no API, no credits):**

- **`fetchJsonTableSpec` schema mapping** — one case per Zoho `data_type` (~20) asserting json type + `x-scratch-*` annotation (mirror `library/attio/__tests__/attio-json-schema.spec.ts`); plus readonly detection, picklist enum, lookup→FK, polymorphic→verbatim-no-FK, and >50-field split/merge.
- **Write-payload sanitizer** — read-only/system fields stripped, lookup written as `{id}`, JSON-pointer escaping, action-endpoint-only fields excluded.
- **CRITICAL:** `listTables` discovery-failure — retry-then-throw, no static fallback.

These two surfaces are where silent bugs hide (a mishandled data type, a read-only field leaking into a write) and they're pure functions, so they're cheap and deterministic.

**Verified live/manual in v1 (Ivan provides an API key):** endpoint shapes, pagination, incremental, and write round-trip against a real Zoho org as code is written.

**Later automated target (fake/live-API integration):** `page_token` loop, watermark + resume-from-checkpoint, `If-Modified-Since` incremental, deleted-record tombstoning, write batch ≤100 / created-IDs / 404-tolerant delete. Tooling: Jest.

## Quirks & risks to handle

- **Lookup ID ⇄ display-name is a read convenience, not a write contract.** On read, every lookup is `{id, name}` — store `id` as the FK value and `name` as display (zero transformation, matches `x-scratch-foreign-key`). On **write, `id` is authoritative**; there is no general "resolve by display name" path in v8 (only External ID via the `X-EXTERNAL` header). Publish must send `{id}`; if only a name is known, resolve it first or **warn-and-skip** — never blindly send a name. This is the failure mode behind Whalesync's display-name collapse (DEV-4362).
- **Polymorphic / per-row FK targets.** MML (`Appointment_For`), `Notes`/`Attachments` (`Parent_Id.module.api_name`), and multi-select-lookup junctions carry a per-row target module. Scratch's `x-scratch-foreign-key` is fixed-target (one `linkedTableId`, `json-schema.ts:89`) and `VirtualFieldDef` is display-only with no write-back (`json-schema.ts:97`), so v1 stores these **verbatim as plain `{module, id, name}` objects with no FK** (Decision #2). Native polymorphic-FK support would be a separate framework change spanning the server and all three frontends.
- **Relationships mutated via action endpoints, not field writes.** `Tag` (a multi-valued field on the record) is changed via `add_tags`/`remove_tags`, and multi-select-lookups via junction records — not by PUT-ing the array. The connector adapts internally; the frontend keeps seeing a plain multi-value field.
- **Subform publish is ID-keyed and additive (not full-replace).** Preserve each line's `id` on pull and replay it on publish; an omitted `id` *creates a duplicate*. Removing a line requires the explicit `{id, _delete: null}` sentinel; `[]` deletes all; omitted lines are unchanged. Max 100 lines/subform.
- **Single-record-fetch requirement for subforms / multi-lookups.** Subforms, `multiselectlookup`, and multi-user-lookups are **not returned in list responses** — only on `GET /{module}/{id}` (or via Bulk Read). A verbatim full pull that needs subform fidelity must fan out one GET per record or use Bulk Read — a real quota cost (see below).
- **50-fields-per-request / field-selection limit.** Zoho caps a single records fetch at ~50 fields, and `fields` is mandatory. Scratch's verbatim-full-record model must **batch field requests** (split a module's >50 fields across calls and merge) to capture the complete record — unlike Whalesync's sparse 50-field projection.
- **API credit / daily quota.** Credit-based daily limits scale by edition (Free 5,000 → Pro cap 3M); writes cost 1 credit/10 records, reads ~1/page. Concurrency is 5–25 in-flight (sub-concurrency 10 for search/COQL/composite/bulk). 429 = back off and resume (idempotent/resumable). This is why Whalesync advises "map ≤5 tables"; Scratch's incremental pull + quota-aware throttling/backoff should remove the need for that cap. For very large modules prefer **Bulk Read** (200k records/job) over `page`/`page_token` walking (`page` caps at 2,000; `page_token` at 100,000; can't mix the two).
- **File/image fields are expensive.** Tokens/IDs not URLs; bytes require an out-of-band authenticated binary download per file (N+1 fan-out) and a *different* multipart upload endpoint (`/photo` for Record_Image). Recommend read-only/verbatim-token in v1.
- **Edition gating is automatic.** Inventory (Pro+), Cases/Solutions (Pro+), subforms/MML/territories (Ent+), multi-currency (Std+) — gated modules/fields simply don't appear in `/settings/modules` or `/settings/fields` for orgs without them. Dynamic discovery handles this naturally; **do not hardcode any edition checks**.
- **Layout-scoped picklists/stages.** Valid `Stage` values and required/read-only flags can differ per layout; build picklist options layout-aware (or union values across layouts). The deals-by-pipeline grouping is server-computed view metadata, not frontend logic.
- **Multi-DC OAuth.** Never hardcode the API host — use the `api_domain` returned in the OAuth token response (US/EU/IN/AU/JP/CA/CN/SA differ). Access token = 1h; persist and reuse one long-lived refresh token per connection (`access_type=offline`). Scopes: `ZohoCRM.modules.ALL`, `ZohoCRM.settings.{modules,fields}.READ`, `ZohoCRM.users.READ`, `ZohoCRM.org.READ`, plus `ZohoCRM.bulk.*` if Bulk Read is used.
- **Deletions.** A complete incremental pull pairs `GET /{module}` (`If-Modified-Since`, upserts) with `GET /{module}/deleted?type=all` (same header) to tombstone removed records. Retention: recycle-bin ~60 days, permanent-deleted IDs ~120 days.
- **CRITICAL — modules above the 100k `page_token` ceiling have no v1 pull path.** `page_token` caps at 100,000 records and Bulk Read is deferred. A module with >100k records would otherwise **silently truncate** the backfill. v1 must detect the ceiling (token exhausted while `more_records` is still true) and **surface a clear error** ("module too large for v1 pull; Bulk Read required") rather than committing a partial table. This is the trigger to prioritize Bulk Read. (Reaffirmed in eng review against the Codex challenge: Bulk Read stays deferred for v1, and this ceiling is the explicit, documented trigger to build it.)

## Decisions

Resolved by Ivan Dimitrov on 2026-06-04. **Q4 (pull strategy) and Q7 (editable tags) are deferred** — analysis is captured below for context, but the decision is left for later.

1. **Asset fields → defer to v2.** No file/image support in v1: `fileupload`/`imageupload`/`Record_Image` get **no** binary download/upload and **no** asset-field treatment. The raw token/value Zoho returns still lands in the verbatim record (stored read-only, per the raw-fidelity principle); the actual asset pipeline is v2.

2. **Polymorphic FK → store verbatim, no foreign key (revised in eng review).** The earlier split/virtual-field approach is not implementable: `VirtualFieldDef` (`packages/shared-types/src/connector/json-schema.ts:97`) is display-only (no FK, no write-back) and `ForeignKeyOptionSchema` (`:89`) is single-target (`{ linkedTableId: string }`). The only working transform writes synthetic `customerId`/`dealId` fields into the on-disk record, which breaks the "store verbatim raw API response" principle. **Decision:** store polymorphic lookups (`Notes`/`Attachments` `Parent_Id`, MML `Appointment_For`, multi-select-lookup junctions) **verbatim as the raw `{module, id, name}` object with no `x-scratch-foreign-key`**. The frontend renders them as structured values, not clickable cross-table links. If polymorphic FK navigation later proves important, extend `ForeignKeyOptionSchema` to support per-row targets as its own scoped framework change (server + 3 frontends) — not a record transform inside the connector.

3. **Subform writes → v2.** A subform is a nested line-item table embedded in a parent record — e.g. `Product_Details` on Quotes / Sales Orders / Purchase Orders / Invoices (each line = product + qty + price + discount + tax) and `Pricing_Details` on Price Books. Editing line items (ID-aware additive semantics, the `{id, _delete: null}` sentinel) is v2. Subform **reads** are also effectively v2 — see Q4: list/cursor pulls don't return subforms and we are not paying the per-record fetch cost in v1.

4. **Pull strategy → `page_token` + incremental (decided in eng review; was deferred).** v1 uses **`page_token` cursor pagination + incremental `If-Modified-Since`/`Modified_Time`** for every module: full-fidelity JSON, up to 100k records, tiny post-backfill runs. The watermark is captured **before** the first API call (per the CONNECTOR_GUIDE incremental contract) so records modified mid-run are re-pulled next time. **Bulk Read** stays deferred as a later escape hatch for modules exceeding ~100k records on initial backfill (async job → CSV, no subforms). **COQL** unused (2k-row ceiling). **No per-record `GET /{module}/{id}` subform fan-out** in v1 (see Decision #3). Promoted from deferred because this gates the entire read path — Tier 1 cannot be implemented without it. **Hardening (Codex challenge):** the incremental watermark comes from **server-observed time** (response `Date` / max `Modified_Time` seen), not bare local `now()`, with a small overlap window so clock skew can't skip records (re-pulling a few already-seen records is safe — the pull is idempotent). The resume cursor captures `{watermark, page_token, field-batch index, delete-phase}`; since a `page_token` can expire, an expired-token error **restarts the module from the watermark** rather than failing the job.

5. **Org-metadata tables → `users` only in v1 (revised in eng review); defer the rest.** Ship the read-only `users` table (target of every `Owner`/`Created_By` lookup). `roles`, `profiles`, `currencies`, `territories`, `tags` each use a **different bespoke endpoint and response envelope** (`/settings/roles`, `/org/currencies`, `/settings/tags?module=X`, …) — not the uniform `/{module}/records` path — so they're deferred to keep the v1 read path uniform (6 one-off readers is more than "low effort" implied). Revisit when reference-table display value (currency codes, role names) justifies the per-endpoint readers.

6. **`Activities` aggregate → skip.** Don't expose the deprecated read-only `Activities` aggregate; `Tasks`/`Calls`/`Events` already cover the data. Removed from the recommended-entities tables above.

7. **Tags → DEFERRED (whether the per-record `Tag` field is editable in v1).** Decision left for later. Clarification for when we revisit: tags *do* carry `id` + `name`, and there are two distinct concepts — **tag definitions** (the `{id, name, color_code}` catalog, per module, via `/settings/tags`), which are read-only reference data covered by Q5; and the **per-record `Tag` field** (the array of tags applied to a record). The record `Tag` field cannot be changed by a normal record `PUT` — Zoho requires the action endpoints `POST /{module}/actions/add_tags` and `remove_tags`. If we make it editable, publish **diffs** desired-vs-current and calls `add_tags`/`remove_tags` only for the delta, so existing assignments are never wiped (answering the "do we drop assignments?" concern: no). **Consistency note (eng review):** the tag *definitions* table is **deferred too** (Decision #5 ships `users` only), so v1 ships no tag table and no tag editing; the open call is purely when the per-record `Tag` field becomes editable.

## What already exists (reuse, don't rebuild)

The connector is net-new code in `server/src/remote-service/connectors/library/zoho/` plus a `Service.ZOHO` constant, a `connectorRegistry.register(...)` entry, a logo, and OAuth config. Everything else is reused:

- **`Connector` abstract base + registry** (`connector.ts`, `connector-registry.ts`).
- **HubSpot connector** — the standard-objects + dynamic custom-objects discovery pattern to copy for Zoho's `/settings/modules` discovery.
- **Pipedrive connector** — Fields-API schema discovery, custom-field cache, `rateLimiterSpec` + `createRateLimiter`, OAuth/apiKey factory (`pipedrive-connector.ts`).
- **Attio / Notion** — `VirtualFieldDef` and json-schema builder patterns.
- **`x-scratch-*` annotations + `BaseJsonTableSpec`** (`packages/shared-types/src/connector/json-schema.ts`).
- **Incremental-pull contract + worked examples** (CONNECTOR_GUIDE → "Incremental Pulls").
- **`RateLimiter`** (`src/rate-limiter`), **OAuth refresh + encrypted credentials** infra, **`escapePointerToken`** (`connectors/utils/json-pointer`), **`asset-extraction-helpers.ts`** (for v2 asset fields).

## NOT in scope (v1)

| Deferred | Why |
|---|---|
| Asset / file / image fields | Decision #1 → v2; raw token stays in the verbatim record, read-only. |
| Subform reads **and** writes; the 4 subform-heavy inventory modules (Tier 2†) | Decision #3; no per-record fan-out in v1 (Decision #4). |
| Bulk Read | Escape hatch for >100k-record modules; built when the ceiling is hit. |
| Org-metadata except `users` | Decision #5; bespoke non-uniform endpoints. |
| Editable per-record `Tag` field | Q7 deferred; definitions table also deferred (Decision #5). |
| COQL querying | 2k-row ceiling; not needed for pull. |
| Polymorphic FK navigation | Stored verbatim, no FK (Decision #2); native support is a separate framework change. |
| Automated test suite | Live ad-hoc verification only for v1 (see Testing). |
| `deals-by-pipeline` synthetic table | Server-side view concern, not a table. |
| `Org` singleton as a table | Surfaced as workbook metadata instead. |

## Parallelization

**Mostly sequential, with one real split.** The **foundation** — OAuth + `zoho-api-client.ts`, the `data_type`→schema mapping in `zoho-json-schema.ts`, and their unit tests — is separable from the **read/write methods** in `zoho-connector.ts` and can be built by a second person with clear file ownership (Lane A: api-client + schema-gen + tests; Lane B: `listTables`/`pullRecordFiles`/CRUD, which depend on Lane A). Beyond that the read and write methods share `zoho-connector.ts`, so splitting *them* invites merge conflicts — keep those sequential. Build order: foundation (Lane A) → `users` reference table → Tier 1 pull/push/incremental → Tier 2 non-subform → subform read path → Tier 2† inventory.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | **CLEAR** | 13 issues across 4 sections; 1 critical gap (>100k pull path) found + mitigated; 0 unresolved |
| Codex Review | `/codex` outside voice | Independent 2nd opinion | 1 | issues raised (informational) | 20 findings; eligibility policy + incremental/resume hardening + min unit tests folded in; Bulk Read reaffirmed deferred |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (backend connector) |
| DX Review | `/plan-devex-review` | Developer-experience gaps | 0 | — | not run |

- **CODEX:** outside-voice challenge ran (gpt-5.5, high reasoning). Caught the tags/subform doc contradictions, the module-eligibility gap, incremental clock-skew + `page_token` expiry, and pushed (rejected) on promoting Bulk Read and (accepted) on adding minimum unit tests.
- **CROSS-MODEL:** Bulk Read — review + user kept deferred (100k = build trigger); tests — Codex's "add schema-map + sanitizer unit tests" accepted.
- **UNRESOLVED:** 0. Explicitly deferred (documented, not unresolved): Bulk Read, subform read/write + the 4 inventory modules, assets (v2), org-metadata beyond `users`, per-record `Tag` editability, polymorphic-FK framework support.
- **VERDICT:** ENG CLEARED — ready to implement.
