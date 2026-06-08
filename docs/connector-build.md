# Connector-build playbook — cross-connector tricks & problems

Helper file for the **`/connector-build`** skill. This is the **accumulated, cross-connector** catalog of edge cases, tricks, and gotchas. The per-connector coverage lives in each connector's `TESTING.md`; **this file is the shared memory** so every new connector starts forewarned.

**How to use:** read this at **Step 0** before building/testing a connector. When you discover a new quirk (Stage E), **append a short entry here** (service · trick/problem · how it surfaced · what to do). Keep entries terse and concrete. Grow it every run — the compounding catalog is the point.

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

## Per-service tricks

### Notion (dynamic)
- **Page content is record-by-record.** The bulk/list endpoint returns page *metadata* only; the page **content (blocks)** must be fetched per page via a separate call. Pull-of-content is a distinct path from pull-of-metadata.

### YouTube (static)
- **Transcripts are a separate, trickier fetch** than the video metadata — not part of the normal video record pull.

### Webflow (dynamic CMS)
- **Live vs draft = two states that behave like two tables.** Items exist as draft and/or published; the **status field is special** and changing it is a dedicated operation, not a normal field write.

### GoHighLevel / HighLevel (mixed: static + per-Location custom fields + Custom Objects)
- **`limit`-cap → silent empty pull (generalizable trap).** Each list endpoint caps `limit` differently and the OpenAPI docs are *wrong*; exceeding it returns `422` that **fails the whole folder pull while the job still reports success** — you get an empty folder, not an error. **Always probe a new entity's real `limit` cap (start at 100)** rather than trusting docs. Watch for this shape on any connector.
- **Pagination is per-entity, not standardized** (searchAfter / startAfter+id / page / skip / offset / date-cursor). Pagination tokens like `searchAfter` are **stripped from each record before storage** (transport, not data) — make sure your connector does this so cursors don't leak into the saved JSON.
- **Mandatory version header** (`Version: 2021-07-28`) on every request — omitting it "fails obscurely." Many APIs have a required version/date header; check first.
- **Inconsistent location/tenant param** across endpoints (`locationId` in body vs `location_id` snake_case vs query). Per-entity scoping param is a common foot-gun.
- **Per-entity value-key drift:** Contacts custom-field value key is `value`, Opportunities is `fieldValue`. Same concept, different key per object — verify per entity.
- **Reference object with no get-by-id** (Pipelines) → pull-by-id must re-fetch all and filter.
- **Writable subset:** only Contacts, Opportunities, Custom Objects records are writable; the rest are reference/config (pull-only). Don't assume every entity round-trips.
- **`GET /contacts/{id}` omits fields the search endpoint returns** (`companyName`, `city`, `businessName`, …). Verifying a contact write via GET-by-id nearly produced a false "didn't land". **Verify contact writes via the connector's pull / the search endpoint**, not GET-by-id. (Generalizable: a service's single-record GET and its list/search can return different field sets — verify writes with the same read path the connector uses.)
- **Create can silently fail per-record while the publish reports connection success.** Verified 2026-06-05: a Contacts create published as "Published 1 connection(s)" but never landed (no remote id, not in GHL, still in `files unpublished`) — while Opportunity create *did* land. **After any push, confirm each write actually landed** (re-pull or service read) **and check `files unpublished` is empty.** A connection-level "success" is not a record-level guarantee.

### Copper (static CRM · custom fields = mixed) — verified 2026-06-05
- **Filename is a name-slug, not the remote id.** Records save as e.g. `scratchpull-testco-0605.json`; the Copper `id` lives **inside** the file. New local records receive their `id` **after** publish.
- **FKs are plain id fields** on the record (`primary_contact_id` → People via `x-scratch-foreign-key`). No special association endpoint observed.
- **`assignee_id` is a Copper User id**, not a linked Scratch table — leave it as a plain number.
- **Auth = `user_provided_params`** (apiKey + email) → connectable from the CLI.

---

## General Scratch / CLI / browser gotchas (apply to every connector)

- **CLI publish is 3 steps:** `files accept` → `files upload` → `files publish`. `linked publish` alone **no-ops yet prints "completed"** (it never uploads the accepted patches). Always upload first.
- **Confirm pushes against the service API, not a Scratch pull.** A pull replays still-pending accepted patches over `main`, so the local file can look right while the service is unchanged.
- **`files publish` is 403'd** unless `User.settings.cliCanPublish = true` (web app Settings → Integrations).
- **Read-only fields** (`x-scratch-readonly`: ids, `date_created/modified`, computed) are dropped on publish by design — omit them from new records. But never *silently* strip a user's edit to a read-only field; let the service reject it.
- **CLI can create connections** only for `user_provided_params` services (`scratchmd connections add --service <S> --param k=v`). **OAuth** services must be connected via the web app's browser flow.
- **Browser ambiguous clicks:** when a toolbar button and a menu item share a name, `$B click` errors "matched multiple elements" — fall back to `$B js` to click the precise DOM node. JS `.click()` also bypasses overlay coverage (e.g. a survey toast over a Save button).
- **Wedged local state** (dirty branch / accepted-patches / SQLite index): don't fight it — `workspaces unsync` + re-`init` + re-`pull`; the service and server git are the source of truth.
- **Same-named folders across two connections collide in publish (was a real bug, fixed 2026-06-05).** If a workbook has two connections that each expose a folder with the same path (e.g. a CRM and a generic-api connection both have `/Contacts`), the publish plan-build used to resolve the DataFolder by path alone and could hand one connector the *other* connector's schema/table-id — mis-routing writes (a HighLevel contact create went to `POST /objects/GET/records` → 400, silently lost). Fixed by scoping `SchemaHelperService.getDataFolderInfo` by `connectorAccountId`. **When testing a connector in a multi-connection workbook, watch for same-named tables across connections** and confirm writes actually land (the CLI may still print "Published" — DEV-10175). The reliable check after a push: `files unpublished` is empty AND the record carries a remote id AND it's in the service API.
