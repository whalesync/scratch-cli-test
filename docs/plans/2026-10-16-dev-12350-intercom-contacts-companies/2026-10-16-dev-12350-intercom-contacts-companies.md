# Intercom Contacts & Companies — Read-only Live Export Sources

**Linear:** [DEV-12350 — Intercom connector: add read-only Contacts and Companies tables for Live Export](https://linear.app/whalesync/issue/DEV-12350) (related: [DEV-10924 — Live Export: Launch Intercom](https://linear.app/whalesync/issue/DEV-10924))
**Goal:** Add Intercom **Contacts** (users + leads) and **Companies** to the Scratch Intercom connector as read-only tables, so Whalesync Live Export can export them.
**Date:** 2026-10-16
**Author:** Chris Hoefgen
**Status:** In Progress
**Updated:** 2026-10-19
- Incremental pull for Contacts and Companies is out of scope; both tables are full-pull only (§4.2).
- Contacts API behavior was checked read-only against the live Whalesync Intercom workspace (§3.1). As a result, the contacts walk moved from `GET /contacts` to `POST /contacts/search` sorted by `created_at` (§4.3).
- Companies API behavior was checked on a throwaway seeded test workspace (§3.2). Findings: scroll leaves out companies with no contacts, the scroll lock is per workspace, scroll pages are 100, and the list `total_count` is unreliable during churn. §4.4, §4.5 and §8 were revised to match.

---

## Implementation status (2026-10-19)

**Contacts and Companies: built**, on branch `macau-v2/intercom-contacts-companies` (uncommitted). The Companies design was first verified on a seeded test workspace (§3.2).

What shipped for Contacts, and where it differs from §4:
- **Walk:** `IntercomApiClient.listAllContactsInCreationOrder` (§4.3) plus `getContact` and `listDataAttributes`. 401/403 on any of them is rethrown naming the "Read and list users and companies" permission (§4.8).
- **Schema:** `buildIntercomContactsJsonTableSpec(id, contactAttributeDefinitions)` (§4.5). The device/marketing long tail is optional; `role` is the closed `user | lead` set.
- **View:** the per-table rules refactor landed (`VIEW_RULES_BY_TABLE_TYPE`, typed over every `IntercomTableType`, so a new table must declare its rules). Articles, Collections and Conversations keep their exact previous rules. Contacts:
  - **Custom attributes go in a "Custom Attributes" banner group** (the GoHighLevel pattern), one column per attribute, named by the attribute. A name that collides with a standard column is qualified, e.g. `Custom Attributes (Email)`. The raw bag stays as a hidden column.
  - `tags` is flattened to tag **ids**, since the stubs carry no names. Hydrating names from `GET /tags` is a follow-up (§9).
  - `companies` is **hidden** until the Companies table exists. The Contact → Companies FK column (§4.7) comes with Companies.
- **Connector:** read-only flags with `disabledReason` and `infoNote`; writes throw for Contacts only (Conversations still skips, §9); file names use email, then name; the `excludeConversationParts` setting is scoped to conversations.
- **Tests:** unit specs for the client, connector, schema and view, plus a new `intercom-live-export.spec.ts`. It locks the plan types: a date attribute becomes Airtable `dateTime` / Postgres `timestamptz`, an attribute with options becomes a select, `role` becomes a select. A read-only Contacts block was added to the live integration spec; it skips without `INTERCOM_ACCESS_TOKEN`.

What shipped for Companies (§4.4–§4.7):
- **Walk:** `IntercomApiClient.listAllCompaniesViaScroll`.
  - `400 scroll_exists` → retry up to 7 times, 15 s apart, then fail with a "another integration is reading companies" message.
  - Restart from scratch on a lost scroll (404/500), at most 3 times, deduplicating by id across restarts. Never returns a partial walk.
  - The first empty page ends the walk.
  - After the walk, `POST /companies/list`'s `total_count` is read **only to log a warning**; it never fails the pull (the §8 recommendation).
  - Limits are overridable (`IntercomCompaniesScrollWalkOptions`), so tests run without real waits.
  - Also added: `getCompany`.
- **Schema:** `buildIntercomCompaniesJsonTableSpec(id, companyAttributeDefinitions)` follows the observed payload: set-only keys are optional and `plan` accepts `{}`. `buildIntercomCustomAttributeProperties` is shared with Contacts.
- **View:** Companies rules include:
  - one `Plan` column at `plan.name`;
  - tag names;
  - `segments`, `app_id` and `type` hidden;
  - the "Custom Attributes" banner.
- **Contact → Companies link:**
  - The schema annotates `companies.data[].id` (`CONTACT_COMPANIES_FOREIGN_KEY`).
  - The view's `Companies` column at `companies.data` declares the FK, flattens the ids, and extracts them with `codec.toCore`. This is the HubSpot association pattern.
  - In a generated plan the column becomes `{kind: 'foreignKey', target: {ref: 'companies'}}` when Companies is exported, and `needs_target` otherwise (`intercom-live-export.spec.ts`).
- **Connector:**
  - read-only flags;
  - a `disabledReason`;
  - an `infoNote` explaining that only companies with a contact are listed;
  - writes throw;
  - checkpoint is always `{}`;
  - file names use `name`, then `company_id`.

**Verified on the throwaway workspace, through the real connector:**
- **197 companies** pulled, all unique (two scroll pages), none with zero contacts, checkpoints always `{}`.
- All 7 custom attributes became columns (including `creation_source`).
- **0 schema failures** across all companies and all 44 contacts.
- **All 201 contact → company link ids resolve to a pulled company.**
- The live integration spec's Contacts and Companies blocks pass (10/10).

**Verified against the live Whalesync workspace (local dev, read-only):**
- A Contacts folder created in `wkb_2U82xickIe` (`dfd_Z84o4ntyfX`) pulled **19,386 records, exactly Intercom's total, in 161 s** through the running dev server.
- **All 19,386 live contacts validate against the schema the server stored**, with 0 failures. All 23 non-relationship custom attributes were discovered.

## 1. Summary

- **The work is all in the connector. Whalesync needs no changes.**
  - `INTERCOM` is already in Whalesync's `LIVE_EXPORT_SOURCE_SERVICES` default (`whalesync/api/bottlenose/src/experiments/flag-defaults.ts:72`).
  - Neither repo keeps a per-table allowlist. Dusky, the public API and the MCP tools all list whatever the connector's `listTables()` returns.
  - Live Export takes its fields from the connector's default view.
- **Read-only is enough.** A Live Export source never needs create, update or delete. Pulling, the schema and the default view are all it uses.
- **Full pull only.** Neither table supports incremental pull, in Live Export or in Scratch workbooks. This removes watermark handling, filtering by update time, and any reason to move off API 2.11. It doesn't remove the hard parts below, because those come from full pulls, which Live Export already always runs (§4.2).
- **The hard parts:**
  1. **A pull must fetch every record, or fail.** Live Export source pulls are always full (`routine-generator.ts:66,116`). A full pull deletes records it didn't see (`pull-linked-folder-files.job.ts:1116`), so a pull that comes up short deletes rows in the destination. That is the DEV-11283 lesson.
     - **Contacts:** `GET /contacts` is sorted by `last_seen_at`, which changes every time a contact is active. A contact that becomes active while the walk is under way can move behind the cursor and be skipped. Walk `POST /contacts/search` sorted by `created_at` instead, which never changes. A live run confirmed it returns exactly the same contacts (§3.1, §4.3).
     - **Companies** need the scroll API, which can't be resumed and allows only one open scroll per app. These are still unverified, because the Whalesync workspace has no companies.
  2. **Custom attributes** are the most valuable data on contacts and companies. Today the view hides `custom_attributes`, and a hidden column is dropped from Live Export. The attributes have to be discovered (`GET /data_attributes`) and typed so they become exportable columns.
  3. **The default-view rules apply to every table.** Hidden fields, flattened tags and composite objects are keyed by field name across all tables. Contacts and Companies have differently shaped `tags`, so these rules need to become per-table.

## 2. What exists today

| Table         | Pull                                                                                    | Write                                       | Incremental                               |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| Articles      | `GET /articles`, page-number pagination with an unstable sort. Uses `listWithFaithfulPageWalk`: dedupes, checks `total_count`, and re-walks with a page-size ladder | Full CRUD                                   | No                                        |
| Collections   | `GET /help_center/collections`, same faithful walk                                      | Full CRUD                                   | No                                        |
| Conversations | `GET /conversations` (cursor); hydrated per id unless `excludeConversationParts` is set | `disabled*` flags; writes skipped silently | Yes, `POST /conversations/search` on `updated_at` |

- `IntercomTableType = 'articles' | 'collections' | 'conversations'` (`intercom-types.ts:2`).
- Specs are hand-written TypeBox with nothing discovered at runtime, in `intercom-json-schema.ts`. Records are stored exactly as the API returns them.
- Auth is an access token only (`user_provided_params`), pinned to `Intercom-Version: 2.11` (`intercom-api-client.ts:20`). There is no Intercom OAuth provider (see DEV-12089).
- **Conversations' read-only handling is not the pattern to copy.** `createRecords` and `deleteRecords` skip it, and `updateRecords` echoes the file back (`intercom-connector.ts:326-413`). A write therefore appears to succeed. Use Copper's `resolveEntityType` throw (`copper-connector.ts:317-323`) or Gong's `readOnlyError()` instead.

## 3. Intercom API facts that drive the design

The connector pins **v2.11**. The newest stable version is **2.17**. Nothing in this design needs a newer version (§4.9).

| Concern | Detail |
| --- | --- |
| **List contacts** | `GET /contacts` returns users and leads together. Cursor pagination via `starting_after` from `pages.next.starting_after`; the end is reached when `next` is missing. `per_page` max is **150**; larger values are silently capped at 150. The envelope has `total_count`. The docs don't state an order and there's no sort parameter, but the live run showed it is **sorted by `last_seen_at`, newest first, with never-seen contacts last** (§3.1). Intercom's pagination guide warns that because cursors are stateless, "if items are updated between 2 paginated queries, this can lead to duplicate or missed records". Merged contacts are excluded. |
| **Contact shape** | Scalars: `id`, `external_id`, `role` (`user`/`lead`), `email`, `phone`, `name`, `owner_id`, flags. **Timestamps are Unix seconds:** `created_at`, `updated_at`, `signed_up_at`, `last_seen_at`, `last_replied_at`, `last_contacted_at`, `last_email_opened_at`, `last_email_clicked_at`. `location` is an object, `custom_attributes` is a free-form object. The `tags`, `notes`, `companies` and opted-in/out subscription lists are `{type:'list', data, url, total_count, has_more}`, and **Intercom inlines at most 10 items of each**; segments are not inlined at all. **A contact's `tags[]` items are `{id, type, url}` and carry no `name`.** |
| **List companies** | `POST /companies/list` uses page numbers, is sorted by `last_request_at`, **stops at 10,000 companies**, and **leaves out companies with no users**. **`GET /companies/scroll`** is Intercom's recommended way to iterate every company: you pass `scroll_param`, and the walk ends on an empty page. **Each app may have only one scroll open**, an idle scroll **expires after 1 minute**, and a timeout returns HTTP 500 with "restart the scroll". There is **no way to resume** a scroll part-way. |
| **Company shape** | `id`, `company_id` (user-defined), `name`, `plan {type,id,name}`, `size`, `website`, `industry`, `monthly_spend`, `session_count`, `user_count`. Timestamps in seconds: `created_at`, `updated_at`, `remote_created_at`, `last_request_at`. `custom_attributes`. `tags` is `{type:'tag.list', tags:[{id,name}]}`, the same shape as on conversations. No truncation is documented. **2.15+** adds `notes`. |
| **Search contacts** | `POST /contacts/search` returns the same envelope and cursor pagination, at **150 per page**, and accepts `sort`. **Used here to list every contact, not to filter by update time** (§4.3). The query `created_at > 0` matches everything, so the pre-2.17 rule that timestamps match by calendar day doesn't matter. That rule would only bite an updated-since filter, which this design doesn't have. Newly created contacts can take "a few minutes" to appear in search results. Companies have no search before 2.17. |
| **Custom attribute definitions** | `GET /data_attributes?model=contact\|company` (no pagination) returns `name`, `full_name` (e.g. `custom_attributes.plan_tier`), `label`, `data_type`, `custom`, `archived`, and `options` when an attribute has them. The documented `data_type` values are `string`/`integer`/`float`/`boolean`/`date`, and **2.17** adds `datetime`. **The live run also returned `relationship`, which isn't documented** (§3.1). |
| **Deletes and archives** | On 2.11, archived contacts can't be listed and merged contacts are excluded, so a removal shows up as a record missing from a full scan. That is exactly how a full pull already detects deletes, so 2.17's `GET /contacts/deleted` and `GET /contacts/activities` aren't needed. |
| **Associations** | `GET /contacts/{id}/companies` and `GET /companies/{id}/contacts` use page numbers, 15 per page by default. A contact can have up to 1,000 companies. |
| **Permissions** | Contacts, companies and bulk reads need **"Read and list users and companies"**. "Read one user and one company" is not enough to list them. Reading tags is a separate permission. Articles and conversations use different scopes, so an existing token may lack this one. |
| **Rate limits** | 10,000 requests/min per app and 25,000/min per workspace, enforced in 10-second windows. Already handled: the limiter allows 150/s (`intercom-connector.ts:468`), and 429s are retried with backoff. No limits are documented for individual endpoints. |
| **2.16 / 2.17 breaking changes** | `owner_id` changes from integer to string, merged source contacts return 410, and data attributes can report `datetime`. |

Sources:
- [2.11 reference](https://developers.intercom.com/docs/references/2.11/rest-api/api.intercom.io/) and [latest reference](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/)
- [cursor pagination guide](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/pagination-cursor)
- [OAuth scopes](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/oauth-scopes)
- [changelog](https://developers.intercom.com/docs/references/changelog)

### 3.1 Verified against the live Whalesync Intercom workspace (2026-10-19)

**How it was run:** read-only, through the local-dev connection `coa_9vCHzKoHRc` (workbook `wkb_2U82xickIe`), on API 2.11.
- Every call was a read: GET requests plus the `POST /companies/list` and `POST /contacts/search` endpoints, 277 requests in total. The probes printed only types and counts, never contact or company values.
- The probe scripts sit in the gitignored `.context/intercom-probe/` folder and are not committed.

| Question | Result |
| --- | --- |
| Contacts list order | **Sorted by `last_seen_at`, newest first.** There were 0 out-of-order steps across the 14,845 contacts that have a value. The 4,541 contacts with a null `last_seen_at` come last, starting at position 14,846. |
| Full `GET /contacts` walk | 130 pages, **19,386 unique contacts, 0 duplicates**, `total_count` 19,386 at both start and end, **114 s (~0.88 s per request, one at a time)**. No contact became active during the walk, so this run didn't actually catch a skip. On a busy workspace, or during a walk that lasts hours, active contacts are expected. |
| Full `POST /contacts/search` walk (`created_at > 0`, sorted by `created_at` ascending) | 130 pages, **19,386 unique, 0 duplicates, 0 out-of-order steps**, `total_count` 19,386, 117 s. **Exactly the same contact ids as the list walk** (0 found by only one of the two walks). No result cap at 10k. |
| `per_page` above 150 | Silently capped at 150, no error |
| Roles | 16,896 `user`, 2,490 `lead` |
| Title and file-name candidates | `name` is null on 1,646 contacts (8.5%); `email` is null on only 5. |
| Nested lists on a contact | `tags` items are `{id, type, url}`, with **no name** (confirmed); at most 8 tags on any contact, so none was truncated. No contact has any `companies` or `notes`, so **the 10-item truncation couldn't be observed**. `social_profiles` is `{type, data}` only. `segments` is never included. |
| `GET /contacts/{id}` vs the list item | Same keys |
| Extra contact keys (beyond §3) | `sms_consent`, `unsubscribed_from_sms`, `browser`, `browser_version`, `browser_language`, `os`, `android_*`, `ios_*`, `utm_*`, `referrer`, `language_override`, `avatar`. `owner_id` is a number on 2.11. Many keys are null on most records. |
| Contact data attributes | 61 definitions, of which 27 are custom: string 12, integer 2, float 3, boolean 3, date 3, **`relationship` 4 (undocumented)**. **The 4 `relationship` attributes never appear in any contact's `custom_attributes`.** No definition here had `options`. Archived attributes are not returned by default. |
| Date custom attributes | All 3 are stored as **Unix epoch seconds** on the records (899 values checked). |
| Custom-attribute keys on records | Sparse: in a 450-contact sample, 3 of the 23 non-relationship custom attributes never appeared at all, and many values were `null`. No record had a key that isn't in the definitions. |
| Companies | **The Whalesync workspace has 0 companies.** `POST /companies/list` returned `total_count` 0, and the scroll's first page was empty. Company custom attribute definitions: 0. |
| Scroll mechanics (empty workspace) | The first scroll page returned `{type, data:[], pages:null, total_count:null, scroll_param}`. Following that `scroll_param` returned **404 `not_found: scroll parameter not found`**. Starting a second scroll while the first was open returned 200 (empty), not an error. With no companies, it's unclear whether that second scroll replaced the first. |
| Rate limit | `X-RateLimit-Remaining` started near 1,666 per 10-second window (10,000 per minute), consistent with §3. |

The questions this workspace couldn't answer are covered in §3.2.

### 3.2 Verified on a throwaway seeded test workspace (2026-10-19)

**How it was run:** a throwaway Intercom workspace with no real data, using an access token the user provided, on API 2.11.
- The workspace was seeded through the API with `fable_qa_*` data:
  - 260 companies, with custom attributes of every type, including a string attribute created with `options`;
  - 40 contacts (30 users, 10 leads), most linked to 1–2 companies;
  - a "hub" contact linked to 15 companies, with 12 tags and 12 notes;
  - later, contacts linked to companies 52–200, and the only contact unlinked from one company.
- The scripts sit in the gitignored `.context/intercom-probe/` folder. The token is stored only there.

| Question | Result |
| --- | --- |
| **Does scroll include companies with no contacts?** | **No.** After the seed, `POST /companies/list`, `GET /companies` (no filter) and the full scroll all returned **exactly the same 49 companies**: Intercom's 4 sample companies plus the 45 seeded companies that had a contact linked. The other 215 seeded companies (`user_count: 0`) never appeared in any listing, even after 10+ minutes. They exist: `GET /companies/{id}` and `GET /companies?company_id=…` return them. **On 2.11 there is no endpoint that enumerates companies without contacts.** A company linked only to a lead counts as having contacts (company 51 was listed). |
| **Scroll page size** | **100**, fixed. There is no `per_page`. Walks of 197 companies paged as `[100, 97]`, and an earlier one as `[100, 59]`. At one request per ~0.9 s, 10k companies take ~100 requests and 100k take ~1,000. |
| Visibility lag | **Linking:** 149 companies linked to contacts in one go appeared in the scroll over 2–4 minutes (49 → 159 → 197). **Unlinking:** the company's own `user_count` reads 0 immediately via `GET /companies/{id}`, but its presence in the scroll **flapped** for about 3 minutes (present, absent, present, then absent for good) before settling. A pull inside that window could delete and then re-add it. |
| `POST /companies/list` `total_count` vs scroll | Equal once settled (197 = 197), but **not reliable while the index churns**: at the same moment the list reported 94 against 159 in the scroll, then 194 against 197. A later read went *down* to 188 before settling at 197. |
| **A second scroll while one is open** | **`400 scroll_exists: scroll already exists for this workspace`.** The lock is **per workspace**, not per app as the docs say: any integration on the customer's workspace scrolling companies blocks ours, and the reverse. The first scroll kept working after the rejected attempt. **A finished scroll** (empty page reached) **frees the lock immediately.** **An abandoned scroll holds it for about 60 s** after its last use (a new scroll first succeeded at 62 s). The lock doesn't affect `POST /companies/list`. |
| Idle expiry | Following a `scroll_param` after 70 s idle returned **`404 not_found: scroll parameter not found`**. The docs say a timed-out scroll returns 500. Following the `scroll_param` that came with the final empty page also returns 404. |
| Scroll envelope | `{type:'list', data, pages:null, total_count:null, scroll_param}`. **No `total_count`**, but `POST /companies/list`'s `total_count` matched the scroll's count exactly (49 = 49), so it can serve as the completeness check. |
| Company record keys | `type`, `company_id`, `id`, `app_id`, `name`, `created_at`, `updated_at`, `monthly_spend`, `session_count`, `user_count`, `tags`, `segments`, `plan`, `custom_attributes`. Also `remote_created_at`, `size`, `website` and `industry`, but **only when set** (absent on Intercom's sample companies). **`last_request_at` never appeared**, and there is no `notes` on 2.11. `GET /companies/{id}` returns the same keys as a scroll item. |
| Company nested shapes | `tags` is `{type:'tag.list', tags:[{type, id, name}]}`, so **tag names are present**, the same shape as on conversations. `segments` is `{type:'segment.list', segments:[…]}`. **`plan` is `{}` (empty object) when unset**, `{type, id, name}` when set; it is never null. |
| Company custom attributes | Values arrive with their types (string, number, boolean). **Date attributes are Unix epoch seconds.** Intercom adds its own custom attribute, **`creation_source`** (`custom: true` in the definitions, value `"api"` for API-created companies). A string value of 2,000 characters was **rejected (`422 … length too long`)**; 250 was accepted. |
| `options` on attribute definitions | **Not returned**, even for attributes created with `options` (contact and company). So on 2.11 a list attribute arrives as an open string. |
| Contact nested-list truncation | Confirmed on the hub contact: `companies` inlines **10 of 15** (`total_count: 15`, `has_more: true`, `url` set); `tags` 10 of 12; `notes` 10 of 12. Items are `{id, type, url}`. `GET /contacts/{id}/companies?per_page=50` returned all 15. |
| Contacts search vs list | Both reported `total_count` 44 (40 seeded + 4 samples), and search returned all 44, about 15 minutes after seeding. |
| Company upsert under concurrency | `POST /companies` occasionally returned a transient **`409 resource_conflict`** when 6 creates ran in parallel. The company was not created; a retry succeeded. This only matters for seeding test data. |

## 4. Proposed design

### 4.1 Tables and read-only behavior

- Add `'contacts' | 'companies'` to `IntercomTableType`. This also lets `intercomForeignKeyLinkedTableId('companies')` exist.
- In `listTables()`, give both new tables:
  - all three `disabled*` flags;
  - a `disabledReason`;
  - for Contacts, an `infoNote` warning that large workspaces export many records (see §5, record limits).
- When all three flags are set, the web and desktop pickers force the folder's `readOnly` option on, and publish skips read-only folders.
- **Writes throw** for both tables, following Copper's `resolveEntityType`. The server never enforces the `disabled*` flags itself, so a folder created another way could still reach the write methods.
- **Every top-level field is `x-scratch-readonly`**, the same rule `intercom-json-schema.spec.ts:277-284` enforces for conversations.

### 4.2 Full pull only (no incremental)

Decided 2026-10-19: neither Contacts nor Companies supports incremental pull, in Live Export or in Scratch workbooks.

- **The gate needs no change.** `intercomIncrementalPullSupport` (`intercom-connector.ts:69-71`) already returns `NOT_SUPPORTED` for every table except `conversations`.
  - When a folder asks for an incremental pull, the pull job demotes it to full (`pull-linked-folder-files.job.ts:689`).
  - The folder UI already reports incremental as unsupported for these tables, through the registry resolver (`intercom-connector.ts:469`).
  - Add a unit test that pins `NOT_SUPPORTED` for both tables, so a later edit can't turn it on by accident.
- **Don't annotate `updated_at` with `X_SCRATCH_LAST_MODIFIED_FIELD`.** That annotation only exists so incremental pulls can find the watermark field automatically (`CONNECTOR_GUIDE.md:379`).
- **Not needed:**
  - filtering by update time, in any form. The contacts walk does use `POST /contacts/search`, but only to list every contact in a stable order (§4.3), never to filter.
  - any company search
  - watermark capture and its lookback margin
  - 2.17's to-the-second search, and `/contacts/deleted` or `/contacts/activities`
  - any change to `intercom-incremental.ts`, `docs/incremental-pull-connector-support-matrix.md` or the incremental section of `CONNECTOR_GUIDE.md`
- **How deletes are detected:** the same way as in every full pull. A record missing from a complete walk is removed (`pull-linked-folder-files.job.ts:1116`). A resumed walk skips deletion (`classic-git-pull-sink.ts:453-461`), so those deletes happen on the next walk that isn't interrupted.
- **What it doesn't simplify:** the hard parts. Live Export source pulls were already always full, so §4.3 and §4.4 still apply.
  - The completeness checks now protect *every* pull of these tables, not only Live Export pulls, since Scratch workbook pulls are full too and every full pull can delete.
  - A scheduled Scratch pull of a large Contacts table re-downloads the whole table each time.
- **User-facing text:** `incrementalPullInstructions` (`intercom-connector.ts:101-102`) names Articles and Collections as the tables that always re-download in full. Add Contacts and Companies to it, and to the doc comment on `intercomIncrementalPullSupport`.

### 4.3 Contacts pull

- **Walk `POST /contacts/search`, not `GET /contacts`.** Use the body `{ query: { field: 'created_at', operator: '>', value: 0 }, sort: { field: 'created_at', order: 'ascending' }, pagination: { per_page: 150, starting_after } }`.
  - **Why:** the list endpoint is ordered by `last_seen_at`, newest first (§3.1). That value changes whenever a contact is active. A contact still ahead of the cursor that becomes active moves to the front of the list, behind the cursor, so the walk never reaches it. A full pull then deletes it from Scratch and from the Live Export destination, and it comes back on the next run. That churn loses destination record ids and links.
  - **`created_at` never changes.** Existing contacts can't move. New contacts land at the end, where the walk still reaches them, and a contact created after the walk passes the end simply arrives on the next run.
  - **Verified:** both walks returned the identical 19,386 ids with no duplicates. Both cost 130 requests and took about 2 minutes (§3.1).
  - Search's few-minute indexing delay only holds back *new* contacts, which aren't in Scratch yet, so it can't cause a delete.
  - The request shape mirrors the existing `searchConversationsUpdatedSince` (`intercom-api-client.ts:657-685`), with the `created_at > 0` query and `created_at` sort instead.
- **Its own walk, not a shared cursor loop.** The contacts walk (`listAllContactsInCreationOrder`) is a standalone generator rather than a generic loop pulled out of `paginateConversations`: it needs dedupe and the completeness check, which the conversations loop doesn't have, and the conversations loop is tied to hydration. The existing `IntercomPaginatedResponse<T>` type already matches the contacts envelope.
- **List contacts without hydrating them,** 150 per page. Store each contact exactly as returned, nested lists of up to 10 included (by decision, §8).
- **Check the walk is complete before a full pull may delete.** Dedupe by id. Fail the pull with a user-facing `IntercomError` if the number of unique ids is below the **smaller of the first page's and the last page's `total_count`**, as `listWithFaithfulPageWalk` does for articles.
  - Contacts created during the walk raise both what the walk sees and the final total. Contacts deleted before the walk reaches them lower both. Using the smaller total therefore needs no arbitrary tolerance.
  - On a sort key that never changes, this check should never fire. It stays as a guard against a page Intercom silently drops.
  - Re-walking a million contacts is too expensive for the articles-style page-size ladder, so fail rather than retry. The next scheduled run tries again.
- **Checkpoint** `{ startingAfter }`, Intercom's opaque cursor. A resumed run already skips delete detection (`classic-git-pull-sink.ts:453-461`).
- **`pullRecordFilesByIds`:** add `getContact(id)` (`GET /contacts/{id}`, 404 → null).
- **File names:** add a contacts branch to `getSuggestedRecordFileNames` that uses `email` and falls back to `id`. `name` is null on 8.5% of contacts and `email` on only 5 of 19,386 (§3.1). Brevo does the same (`brevo-connector.ts:357-362`).

### 4.4 Companies pull

Revised after the test-workspace probe (§3.2).

- **The table is "companies that have at least one contact".** On 2.11 no endpoint lists a company with no contacts: list, plain `GET /companies` and scroll all leave them out (§3.2). Say so in the table's `infoNote`.
  - **Consequence:** when a company loses its last contact, it drops out of the scroll within about a minute, so the next full pull deletes it from Scratch and the Live Export destination. That mirrors what Intercom's API exposes; it is not a walk fault. A contact being linked or unlinked can make a company appear or disappear.
- **Use `GET /companies/scroll`.** It returns the same set as `POST /companies/list`, but the paged list is documented to stop at 10,000. That cap is untested; it would need 10k companies with contacts.
- **Checkpoint `{}` throughout.** A scroll can't be resumed, so a crashed run starts over. The job already handles an empty checkpoint as "not resumable".
- **The first empty page ends the walk.** Never follow the `scroll_param` that comes with an empty page; it returns 404 (§3.1, §3.2).
- **The scroll lock is per workspace (`400 scroll_exists`).** Any other integration scrolling this customer's companies blocks our start, and our open scroll blocks theirs. A finished scroll frees the lock at once; an abandoned one holds it for about 60 s (§3.2). So when starting the walk returns `scroll_exists`, retry every ~10–15 s for about 90 s, then fail with a message saying another integration is reading companies from this Intercom workspace. **Always walk to the empty page** (or let an error end the walk), so we never leave our own scroll holding the lock.
- **Restart from scratch, a limited number of times,** when a `scroll_param` the walk is following comes back **404** (expired after a minute idle, verified), or **500** (the docs' "restart the scroll"; not observed).
  - Deduplicate by id across restarts, so a restart re-yields only companies not already yielded. Re-yielding would be idempotent anyway.
  - Once the restarts run out, throw. **Never return part of a walk.**
  - `INTERCOM_RETRY_OPTS` deliberately doesn't retry 500s (`intercom-api-client.ts:58-83`, because creates may already have been saved), so this restart loop sits at the walk level, not on individual requests.
- **Keep each page well inside the one-minute idle window.** The job writes each yielded page before the generator asks for the next one, so a callback slower than 60 s would expire the scroll. Pages are small and writes are fast, so a restart covers the rare slow page; buffering the whole walk in memory isn't needed.
- **Completeness:** the scroll reports no `total_count`. `POST /companies/list`'s `total_count` matched the scroll once the index settled, but **while it churned the list total lagged, ran ahead, and even moved backwards** (94 against 159, 194 against 197, then down to 188; §3.2). A strict "seen ≥ list total" check would fail healthy pulls after every batch of changes. See the completeness decision in §8.
- **`pullRecordFilesByIds`:** add `getCompany(id)` (`GET /companies/{id}`). It returns a company even when it has no contacts.

### 4.5 Schemas and custom attributes

- **Write the TypeBox schemas by hand to match the real payloads.**
  - Make fields nullable with unions wherever the API returns null, and mark fields optional where list payloads omit them. This is the DEV-11286 lesson.
  - Put `unixTimestampOptions()` (`intercom-json-schema.ts:17-23`) on every epoch field. Without it, the timestamps export as numbers (DEV-11284).
  - `idPath` is Intercom's `id`, not the user-defined `company_id`.
  - `titlePath`: contacts use `email`, because `name` is null on 8.5% of contacts while `email` is almost always present (§3.1), and the title becomes the Airtable primary field. Companies use `name`.
  - Include the extra contact keys the live run found (§3.1: `sms_consent`, `browser*`, `android_*`/`ios_*`, `utm_*`, …), all nullable.
- **Discover custom attributes.** In `fetchJsonTableSpec`, call `GET /data_attributes?model=contact|company`. This makes the spec builder call the API, which is acceptable because dynamic connectors already do it. Then emit one typed property under `custom_attributes` for each non-archived `custom: true` definition, keyed by its `name`:
  - `string` → `Type.String`, `integer`/`float` → `Type.Number`, `boolean` → `Type.Boolean`
  - `date` → an epoch-seconds number with the unix-timestamp annotation (verified: Unix epoch seconds, §3.1)
  - **Skip `relationship`.** Intercom returns this undocumented type, but its values never appear in a contact's `custom_attributes` (§3.1). Log any other unknown `data_type` and skip it, rather than failing the spec.
  - `options` → an enum, only when the array is non-empty. Unverified: no definition in the live workspace had options.
  - Every leaf is a nullable union, readonly, and marked with `X_SCRATCH_CUSTOM_FIELD` (Zoho and GoHighLevel precedent).
  - **Every leaf is optional.** The keys are sparse: an attribute a contact has never had set is missing from the record entirely, not null (§3.1).
  - Keep `additionalProperties` open so that an attribute created after discovery still round-trips verbatim.
- **⚠️ The `custom_attributes` container must not carry any `x-scratch-*` key itself,** including `X_SCRATCH_READONLY`. The schema flattener treats any object carrying a non-container `x-scratch-*` key as one opaque leaf (`schema-helpers.ts:33-54`), which would hide every discovered attribute from the Live Export plan. Annotate the leaves instead, the same way HubSpot's `properties` works.

- **Companies schema (from §3.2):**
  - Required keys: `type`, `id`, `company_id`, `app_id`, `name`, `created_at`, `updated_at`, `monthly_spend`, `session_count`, `user_count`, `tags`, `segments`, `plan`, `custom_attributes`.
  - **Optional** (absent until set): `remote_created_at`, `size`, `website`, `industry`, `last_request_at`. `last_request_at` is documented but never observed.
  - `plan` is an object whose `type`/`id`/`name` are all optional, because an unset plan is `{}`, not null.
  - Timestamps (`created_at`, `updated_at`, `remote_created_at`, `last_request_at`) and date custom attributes get the Unix-seconds annotation.
  - Custom attributes are discovered from `GET /data_attributes?model=company`, including Intercom's own `creation_source`. Reuse `buildIntercomCustomAttributeSchema`, which is model-agnostic.
  - `titlePath`/`slugPath` = `name`; `idPath` = Intercom's `id`, not `company_id`.

### 4.6 Default view (`intercom-default-view.ts`)

- **Make the rules per-table.** Today `HIDDEN_FIELDS`, `COMPOSITE_OBJECT_FIELDS` and `FLATTENED_LIST_FIELDS` (`:22-61`) are keyed by field name across every table. Change them to `Record<IntercomTableType, …>`. The new tables need these rules:

  | Field | Contacts | Companies | Why |
  | --- | --- | --- | --- |
  | `custom_attributes` | visible (expanded) | visible (expanded) | Hidden means dropped from Live Export |
  | `tags` | ids (built) | names via `$.tags[*].name` | Contact tags have no names; company tags do (verified §3.2) |
  | `location` | composite (country / region / city) | — | |
  | `plan` | — | one `Plan` column at `plan.name` | `{}` when unset, so the column is simply empty |
  | `notes`, `opted_*_subscription_types`, `social_profiles`, `segments` | hidden | `segments` hidden | Segment items couldn't be observed: segments can't be created through the API |

- **Add `PRIORITY_FIELDS`:**
  - contacts: `email, name, role, id, external_id, phone, created_at, updated_at, last_seen_at, signed_up_at`
  - companies: `name, company_id, id, website, industry, plan, user_count, monthly_spend, created_at, updated_at`
- **Datetime columns need no new code.** `buildUnixTimestampCol` (`:223-236`) already builds a `logicalType: 'datetime'` column with the `epoch_to_iso` codec for every annotated field.

### 4.7 Foreign keys

- **Contact → Companies:** `companies.data[].id` becomes a view-declared multi-valued FK.
  - Copy HubSpot's `buildAssociationForeignKeyCol` (`hubspot-default-view.ts:408`):
    - `path: 'companies'`
    - `foreignKey: { linkedTableId: 'companies', linkedTableRemoteId: ['companies'] }`
    - a display transformer of `$.data[*].id` joined with commas
    - a jsonpath `codec.toCore` that returns an array
    - `readonly: true`
  - It has to be declared on the view column. Neither `extractSchemaFields` nor scratch-git's FK walk looks inside array items, and the readonly container is opaque anyway.
  - Known limits:
    - Intercom inlines at most 10 linked companies per contact (verified: 10 of 15, `has_more: true`, §3.2). **By decision, a contact links only those first 10** (§8).
    - Supabase and Postgres keep only the first value. The plan generator marks the FK `downgraded` (`schema-builder-plan-generator.ts:868-886`), and dusky leaves downgraded FKs unselected by default.
- **Conversation → Contacts: defer.** It would be a view FK on `contacts.contacts[].id`, but dusky won't let you select an FK field unless its target table is in the export (`whalesync/dusky/routes/live-export/live-export-fk.ts:137-144`).
  - That turns today's deliberate JSON-text `contacts` column (`intercom-default-view.ts:48-50`) into a field that can't be selected in exports that include only conversations.
  - This would be a regression for existing Intercom exports, so it is a product decision (§8).
- **Leave as plain values, not FKs:** `owner_id` points at admins, which have no table, and `source.author.id` can refer to a user, admin or bot.

### 4.8 Auth and permissions

- `testConnection` only calls `/me` (`intercom-connector.ts:134`, `intercom-api-client.ts:299`). A token without **"Read and list users and companies"** passes the connection test and then fails at pull time with a generic 401/403.
- Fix: catch 401/403 on the contacts, companies and data-attribute calls and throw an actionable `IntercomError` naming the missing permission.
- When Intercom OAuth is built (DEV-12089), request that scope.

### 4.9 API version and small fixes

- **Stay on 2.11.** This is settled now that there's no incremental pull.
  - What 2.17 adds that's relevant here is to-the-second search, company search and `/contacts/deleted`. All of it serves incremental pulls or delete detection, and full walks already detect deletes (§4.2).
  - Moving would only bring the breaking changes, such as `owner_id` becoming a string.
- **Scope the `excludeConversationParts` advanced setting** (`intercom-connector.ts:117-125`) to conversations with `forTableWsIds: ['conversations']`, so it doesn't appear on the new tables.
- **Update stale docs:** the class doc ("Two tables", `:52-59`), and the incremental text (§4.2).

## 5. Live Export integration

**Works without changes once the connector exposes the tables:**
- **Picking tables:** the dusky picker, the public API and MCP tools (`live_export_list_source_tables` and `live_export_list_source_fields`), and the Scratch web and desktop pickers. Labels come from `displayName`.
- **Fields:** taken from the stored default view (`schema-builder-field-selection.ts`). `logicalType: 'datetime'` becomes a datetime destination column, and a view `foreignKey` with `linkedTableRemoteId` is used even under opaque containers (DEV-12144).
- **FK handling:** binding, the `SYNC_DRAFT_FK_TARGET_MISSING` validation, the FK resolution transformers, and narrowing multi-valued FKs to a single value where the destination needs it.
- **Running exports:** scheduling, the choice between the run-store and classic engines, and failure emails (`WhalesyncRunNotifierService`).

**Risks:**
- **Always-full pulls of large Contacts tables.** With no incremental pull (§4.2), this applies to scheduled pulls in Scratch workbooks too, not just Live Export runs.
  - Every scheduled run re-walks all contacts: about 6,700 requests per million contacts at 150 per page.
  - Requests go one after another along a single cursor, so latency, not the rate limit, decides how long a pull takes. **Measured at about 0.88 s per request** (§3.1), that is about 2 minutes for Whalesync's 19k contacts and **about 1 h 40 min per million contacts**, before the git or run-store write cost.
  - For comparison, the last large Intercom conversations pull took about 7h for 151k records, but that included per-conversation hydration (`48d817696`).
- **Record limits.** `LiveExportRecordLimitEnforcer` gates only Publish and SyncDataFolders, not pulls, and counts records across the whole org.
  - Adding Contacts to one export can push the org over its limit, which blocks **every** Live Export in the org.
  - An over-limit org still runs the multi-hour pull before it fails at the sync step.
  - Setup gives no warning, because new folders show `recordCount` 0. The `infoNote` is the cheap mitigation.
- **One HTTP 500 fails a multi-hour run.** No 500 is retried, including on read-only GETs. Retrying 500 on GETs is safe (see §9).
- **Shared rate limiter.** The 150 req/s limit applies per connector account, so all five tables share it during a run.

## 6. Change checklist

The per-table logic is string `switch`es and if-chains with **no `assertUnreachable`**. A forgotten branch therefore silently skips: `pullRecordFilesByIds` skips unknown tables, and the file-name helper falls back to `name`. Walk every one of them:

- `intercom-types.ts`: the table union, `IntercomContact`, `IntercomCompany`, and the data-attribute and scroll response types
- `intercom-api-client.ts`:
  - the generic cursor loop
  - `listAllContactsByCreatedAt` (the search walk, §4.3), `getContact`
  - the companies scroll walk, `getCompany`
  - `listDataAttributes`
- `intercom-json-schema.ts`: the contacts and companies spec builders, with discovered custom attributes
- `intercom-connector.ts`:
  - `listTables`, `fetchJsonTableSpec`, `pullRecordFiles`, `pullRecordFilesByIds`
  - throwing writes, file names
  - permission error mapping, settings scope, docs, the incremental text (the gate itself is unchanged, §4.2)
- `intercom-default-view.ts`: per-table rules, priority fields, the Contact → Company FK column
- Tests:
  - `__tests__/intercom-{connector,api-client,json-schema,default-view}.spec.ts`
  - new `__tests__/intercom-live-export.spec.ts`, modelled on `gong/__tests__/gong-live-export.spec.ts`. It locks the chain from view to plan field to logical type to destination column, for datetimes, custom attributes and the FK.
  - `server/test/integration/intercom-connector.spec.ts`
- Docs: `intercom/STATE.md` (still mostly the unfilled template) and the Intercom row in `connector-build/existing-connectors.md`

## 7. Testing and verification

1. **Unit specs.**
   - Contacts: the search request body (the `created_at > 0` query, ascending `created_at` sort, 150 per page), pagination, and checkpoints.
   - The scroll walk: an empty page ends it without following its `scroll_param`; restarts on 500 or a 404 scroll param; no partial results; and a thrown error once restarts run out.
   - The shortfall check against the smaller of the first-page and last-page `total_count`.
   - Custom-attribute discovery skips `relationship` and unknown types.
   - Writes throw.
   - `supportsIncrementalPull` is false for both new tables.
   - Every field is readonly and every timestamp is annotated.
   - Custom-attribute discovery, including that the container has no `x-scratch-*` keys.
   - Per-table view rules.
   - The FK column's shape.
2. **Live integration spec**, using the Gong read-only block pattern: read-only flags, spec + `buildDefaultView`, one page of each table, by-id fetch, writes throw.
3. **The live Whalesync workspace is enough for contacts, not companies.** The local-dev connection (§3.1) can run a real full Contacts pull and a Live Export of it from local dev.
   - It has no companies, no contact↔company links and no notes, and no contact has more than 8 tags. So the companies walk, the Contact → Company FK and the 10-item truncation all need a **separate seeded test workspace**.
   - Never seed the live Whalesync account; it is read-only.
4. **Live Export audit tooling.** DEV-11282 cites `tools/live-export-audit/seeds/intercom/seed.mjs`, `crud-pass.mjs` and `intercom/LIVE_EXPORT_AUDIT.md`, **but none of them exist in the repo or its history**, so recreate them.
   - The seed should cover:
     - 200+ contacts (pagination gate) with both `user` and `lead` roles
     - companies, including one with no users
     - a contact attached to more than 10 companies (truncation)
     - tags, custom attributes of every data type, unicode and long text
     - conversations linked to contacts
   - It should be idempotent and use `fable_qa_*` names.
5. Run `/test-live-export INTERCOM AIRTABLE,SUPABASE` (one wide-typed destination and one relational), then `/review-live-export INTERCOM AIRTABLE,SUPABASE` until it PASSes.
   - `audit.mjs` auto-selects at most 6 tables. Use `--tables contacts,companies,conversations` to target these.

## 8. Open decisions

- **~~Whether to fully load nested lists truncated at 10~~ — decided 2026-10-19: keep Intercom's cap.** A contact links only the **first 10 companies** Intercom includes on the contact record. Nothing is fetched to fill in the rest, and the record is stored exactly as returned.
  - Why: `GET /contacts/{id}/companies` returns **full company objects**, while the contact record holds `{id, type, url}` stubs (verified, §3.2). Filling in the list would mix two item shapes in one array, and building stubs ourselves would break the Prime Directive.
  - `tags` and `notes` stay truncated the same way: tags export as ids, and notes are hidden.
  - Revisit if customers need complete links for contacts in more than 10 companies. The fix would be one extra request per affected contact, using the full objects; the link column reads `$[*].id`, so it works with either shape.
- **Companies completeness check.** The scroll is a server-side snapshot, so a concurrent change can't make it silently skip a company, and its failure modes (404 expiry, `scroll_exists`) are explicit errors. Comparing against `POST /companies/list`'s `total_count` would false-fail for about a minute after a contact is unlinked, because the list total lags the scroll (§3.2).
  - **Recommendation:** don't fail on a count mismatch. Log a warning, with the counts, when the unique companies seen fall below the list total. The list total is too noisy during index churn to gate deletes on (§3.2).
- **Conversation → Contacts FK** (§4.7): it improves exports that include Contacts but regresses exports that include only conversations. A middle option is to keep the JSON column and add the FK as a separate view column, if two columns can share a source path. Verify that before choosing it.

## 9. Follow-ups (notes, not tickets)

- **Segments, Notes and Tags as tables** of their own.
- **Contact tag names:** hydrate the tag stubs with names from `GET /tags` (one call per pull; filling a stub in place is allowed by the Prime Directive). Note that reading tags may need Intercom's separate "Read tags" permission.
- **Retry HTTP 500 on read-only GETs** (§5).
- **Intercom OAuth** (DEV-12089): request "Read and list users and companies".
- **Existing bugs found during this analysis:**
  - `server/test/integration/intercom-connector.spec.ts` treats conversation pages as arrays, though the yielded value is `{ items, nextCursor }`. It also expects `updateRecords` to resolve to `undefined`, but it returns an array. Nobody noticed because CI skips the spec when no token is set.
  - Conversations' write methods appear to succeed when they actually skip the write (§2).
