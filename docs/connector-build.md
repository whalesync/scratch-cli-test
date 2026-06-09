# Connector-build playbook — cross-connector tricks & problems

Helper file for the **`/connector-build`** skill. This is the **accumulated, cross-connector** catalog of edge cases, tricks, and gotchas. The per-connector coverage lives in each connector's `STATE.md`; **this file is the shared memory** so every new connector starts forewarned.

**How to use:** read this at **Step 0** before building/testing a connector — it's organized by **type of trickiness**, not by connector, so you can scan the *kinds* of problems to watch for and recognize them on the connector in front of you. The **deep, connector-specific specifics live in each connector's `STATE.md`**; this file keeps only the *type* + a one-line example per connector + a pointer. When you discover a new quirk (Stage E): write the full specifics in the connector's `STATE.md`, then **add a one-line example under the matching trick type here** (or open a new type if it's genuinely new). Keep the entries here terse; the compounding *taxonomy* is the point.

---

## Edge-case categories to ALWAYS probe (Pass 2)

A checklist of where connectors tend to misbehave. Run each entity/field through these, not just the happy path:

- **Field types:** boolean, date/datetime (timezone shifts?), single-select & multi-select (id vs label on write?), relation/FK, attachment/asset, formula/computed (read-only?), rich-text/HTML, JSON/nested objects, currency/number precision.
- **Boundary values:** empty string vs null vs missing key, very long strings, special characters / emoji / unicode, large arrays, 0 / negative numbers.
- **State & lifecycle:** status/stage transitions, draft vs published/live, archival/soft-delete vs hard-delete, restore.
- **Bulk vs single:** does the list/bulk endpoint return *everything*, or is some data (content, sub-resources) only available record-by-record?
- **Pull mechanics:** incremental vs full pull, records created mid-pull (pagination ordering), dedupe, deletions detected.
- **Write mechanics:** partial updates (changedFields only), read-only fields silently dropped, required fields on create, server-assigned ids/defaults flowing back.
- **Relations:** FK as a field on the record vs a separate association/relationship endpoint.
- **Auth & limits:** OAuth vs API key (CLI can only do key/param auth), rate limits / 429 backoff, scopes/permissions per entity.

---

## Testing patterns (general — confirm with the user before adding new ones)

Reusable *ways to test*, not facts about one connector. The skill adds simple edge cases automatically but **asks before adding a new pattern here**, because these shape every future run.

- **CLI-first, browser-where-it-counts.** The CLI is local and much faster than clicking a web UI — do reads, edits, creates, deletes, FK wiring, and verification with `scratchmd` whenever possible. Use the browser for the two things only it can do: **seeding data through the service UI** (when there's nothing to pull yet) and **confirming a change landed in the UI** the way a user sees it.
- **Two-workbook round-trip (push-then-pull-elsewhere).** Connect the **same service to two workbooks**. Make a change in workbook A and push it; then **pull in workbook B** and confirm the change is there and reads back cleanly. This proves the write genuinely reached the service (not just Scratch's `main`) and that it survives a fresh read — stronger than a same-workspace pull, which can replay pending local patches.

## Trick types (the catalog — scan these against the next connector)

Each entry is a *kind* of trickiness with a one-line tell and brief per-connector examples. **Full specifics live in each connector's `STATE.md`** (linked); add a one-line example here when you hit a new instance, deep notes there.

### Fetch / read
- **Heavy fields (N+1 fetch).** A field's real payload is **not** in the bulk/list endpoint and must be fetched **per record** — turning a 1-page pull (1 call) into **N+1 calls**. Tell: list returns metadata/stubs, real content needs a per-id call. Examples: **Notion** page content/blocks (`notion/STATE.md`), **YouTube** transcripts (`youtube/STATE.md`). Plan the pull as light-list + heavy-hydrate; mind rate limits.
- **Bulk vs single field-set mismatch.** The single-record GET returns a **different set of fields** than the list/search endpoint. Tell: a field present in list is missing from get-by-id (or vice-versa). **Verify writes with the same read path the connector uses**, not get-by-id. Example: **GoHighLevel** `GET /contacts/{id}` omits `companyName`/`city`/… that search returns (`gohighlevel/STATE.md`).
- **Reference/config entities & missing get-by-id.** Not every entity round-trips — some are reference/config (pull-only), and a reference object may have **no get-by-id** (must refetch the list and filter). Example: **GoHighLevel** writable subset; Pipelines (no get-by-id) (`gohighlevel/STATE.md`).

### Field shape
- **Read shape ≠ write shape.** A field **reads** as one shape and **writes** as another; store the read shape verbatim, translate only on write. Examples: **ClickUp** `status` object→name, `priority` object→int, dates ms-string→ms-int (`clickup/STATE.md`).
- **State / bucket fields.** A field — usually a *status/state* — is **more than a value: it moves the record into a different bucket**, especially at publish (draft vs live), so changing it is a **dedicated operation**, not a normal field write. Examples: **Webflow** draft↔published live state (`webflow/STATE.md`); watch for the same in any CMS/CRM with publish/approval stages.
- **Value containers: array-by-id vs flat keys.** Custom-field values may live in an **array addressed by field id** (write via a per-field endpoint) instead of flat top-level keys. Examples: **ClickUp** `custom_fields[]` → `POST /task/{id}/field/{field_id}`, **Copper** `custom_fields[]`; contrast Airtable's flat `fields{}` (`clickup/`, `copper/`).
- **Date / number normalization.** The service silently snaps a date to a day/tz boundary or coerces number precision, so the write **doesn't round-trip exactly**. Example: **ClickUp** `due_date` → day boundary in workspace TZ unless `due_date_time:true` (`clickup/STATE.md`).
- **Lossy text encoding (emoji / astral chars).** The service stores text as 3-byte `utf8` (not `utf8mb4`), so BMP unicode survives but **4-byte/astral characters (emoji) are silently replaced with `?`** on write. Tell: accented chars round-trip but `🎯` comes back as `?`. Confirm it's the service (raw API probe), not the connector. Example: **Zoho** text fields (`zoho/STATE.md`).

### Write
- **Feature-gated fields fail the whole write.** A field gated on a service add-on/feature; sending it when the feature is off **errors and fails the entire record write** (not just that field). Tell: a 4xx naming a feature/app. Fix: only send a non-null value the user actually set. Examples: **ClickUp** `points` (Sprint Points ClickApp), `time_estimate` (Time Estimates) → `400 ITEM_227` (`clickup/STATE.md`).
- **Silent success that didn't land.** An op reports success but the data isn't there: a per-record create fails under a connection-level "Published", or a `limit`-cap `422` **empties the folder while the job reports OK**. **Always verify each write in the service API and that `files unpublished` is empty.** Examples: **GoHighLevel** per-record create silent-fail; limit-cap silent-empty-pull (`gohighlevel/STATE.md`).
- **FK / relationship modeling.** A relationship can be a **plain id field**, a **separate association endpoint**, or a **relationship custom-field type** — identify which and test that path both directions. Examples: **Copper** plain id field (`primary_contact_id`), **HubSpot** association endpoint, **ClickUp** `tasks`-type custom field (`copper/`, `clickup/`).
- **Storage / edition caps block ALL creates (test like update instead).** A free/over-quota org can be at a hard **record-count cap**, so every `POST` 4xx's (`MAX_LIMIT_REACHED`) **org-wide** — even a minimal create — while **update/pull keep working**. Tell: minimal create 400s but an existing-record edit succeeds. Don't read it as a connector bug; prove write coverage **non-destructively via `updateRecords` (save-and-restore on an existing record)** and gate create/delete behind an env flag for a green-field org. Example: **Zoho** free-edition 5000-record cap, Accounts at 25k (`zoho/STATE.md`).

### Per-entity & API request quirks
- **Per-entity inconsistency.** The same concept differs **per entity**: value-key, scoping param, pagination style, `limit` cap (docs often wrong — probe the real cap from 100). Don't assume uniformity. Examples: **GoHighLevel** value-key (`value` vs `fieldValue`), location param (`locationId`/`location_id`/query), per-entity pagination & limit caps (`gohighlevel/STATE.md`).
- **Required version/date headers.** A mandatory header on **every** request; omit it → obscure failure. Example: **GoHighLevel** `Version: 2021-07-28` (`gohighlevel/STATE.md`).
- **Pagination cursor leakage.** Pagination tokens are **transport, not data** — strip them from each record before storage so cursors don't leak into the saved JSON. Example: **GoHighLevel** `searchAfter` (`gohighlevel/STATE.md`).

### Schema & structure
- **Schema you can read/set but can't create via API.** Custom fields are readable and value-settable but **UI-only to create** — seed one of each type via the service UI before testing field types. Example: **ClickUp** custom fields (Custom Field Manager) (`clickup/STATE.md`).
- **Structural object modeling.** How the service models sub-objects decides the codepath (and the [path structure](#structural-hierarchy--scratch-folder-paths)): e.g. a **subtask is just a record with a `parent`** (no special path needed), statuses are **per-list not global**. Example: **ClickUp** (`clickup/STATE.md`).

### Identity & auth
- **Filename ≠ id; id lives inside the file.** The filename may be a **name-slug** or the **remote id**; the id is **always inside the file**; new records get their id **after** publish. Examples: **Copper** name-slug, Airtable/Webflow remote id (`copper/STATE.md`).
- **Credential UI quirks.** Masked token fields (copy-only), an SSO re-auth to mint a token, multi-field auth. Examples: **ClickUp** `pk_` token masked + Copy-only + Google SSO re-auth; **Copper** apiKey+email (`clickup/`, `copper/`).

---

## General Scratch / CLI / browser gotchas (apply to every connector)

- **CLI publish is 3 steps:** `files accept` → `files upload` → `files publish`. `linked publish` alone **no-ops yet prints "completed"** (it never uploads the accepted patches). Always upload first.
- **`files upload` needs GCS + valid gcloud creds (local-dev trap).** `upload` → `POST /cli/v1/workbooks/:id/upload-patch/init` issues a **GCS presigned PUT URL** (`object-storage.service.ts`, gated on `GCS_PATCH_UPLOAD_BUCKET`). In local dev the signing uses **impersonated gcloud ADC**; when those expire you get a **500** on upload with `invalid_rapt` / `SigningError` in the server log. Fix: `gcloud auth application-default login` (re-auth the impersonation). This blocks the publish path for **every** connector — when `files upload` 500s, check the server log for the GCS sign error before suspecting the connector. To prove writes meanwhile, run a **live-API integration spec** (`server/test/integration/<svc>-connector.spec.ts`) that drives the connector's create/update/delete directly and reads back via the service API.
- **Confirm pushes against the service API, not a Scratch pull.** A pull replays still-pending accepted patches over `main`, so the local file can look right while the service is unchanged.
- **`files publish` is 403'd** unless `User.settings.cliCanPublish = true` (web app Settings → Integrations).
- **Read-only fields** (`x-scratch-readonly`: ids, `date_created/modified`, computed) are dropped on publish by design — omit them from new records. But never *silently* strip a user's edit to a read-only field; let the service reject it.
- **CLI can create connections** only for `user_provided_params` services (`scratchmd connections add --service <S> --param k=v`). **OAuth** services must be connected via the web app's browser flow.
- **Browser ambiguous clicks:** when a toolbar button and a menu item share a name, `$B click` errors "matched multiple elements" — fall back to `$B js` to click the precise DOM node. JS `.click()` also bypasses overlay coverage (e.g. a survey toast over a Save button).
- **Wedged local state** (dirty branch / accepted-patches / SQLite index): don't fight it — `workspaces unsync` + re-`init` + re-`pull`; the service and server git are the source of truth.
- **Same-named folders across two connections collide in publish (was a real bug, fixed 2026-06-05).** If a workbook has two connections that each expose a folder with the same path (e.g. a CRM and a generic-api connection both have `/Contacts`), the publish plan-build used to resolve the DataFolder by path alone and could hand one connector the *other* connector's schema/table-id — mis-routing writes (a HighLevel contact create went to `POST /objects/GET/records` → 400, silently lost). Fixed by scoping `SchemaHelperService.getDataFolderInfo` by `connectorAccountId`. **When testing a connector in a multi-connection workbook, watch for same-named tables across connections** and confirm writes actually land (the CLI may still print "Published" — DEV-10175). The reliable check after a push: `files unpublished` is empty AND the record carries a remote id AND it's in the service API.
