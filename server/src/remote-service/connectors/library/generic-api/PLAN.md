# GENERIC_API connector — improvement plans

Connector-wide improvement plans promoted from per-service coverage docs (`coverage/<service>.md`) through the **generality gate**. Only **GENERAL** candidates live here — gaps expected to recur across a meaningful share of services. Service-specific quirks stay declared UNSUPPORTED in their coverage doc and never reach this file.

Flow (same as `/connector-build-execute`): a candidate enters as `FOR_REVIEW`. A human approves → `APPROVED` → built → moved to `ARCHIVE.md`. **Every item leads with a concrete before/after example**; the prose is secondary.

Status: `FOR_REVIEW` (awaiting human) · `APPROVED` (build it) · `BLOCKED`.

---

## 1. CLI can set up GENERIC_API connections & tables (today it can do neither)
**Status:** `FOR_REVIEW` · **Source:** `coverage/companycam.md` (2026-06-12) · **Generality:** every generic-connector CLI user, every service.

Two gaps make the generic connector **web-UI-only for setup** — the CLI can create neither the connection nor a table.

**Gap A — the CLI cannot create a generic CONNECTION.** `scratchmd connections create` **drops the `extras` blob** (the `apiType` / `authHeader` / `endpoints` that *define* a generic connection), so there's no way to make a usable GENERIC_API connection from the CLI at all. Confirmed in code: the CLI connection-create DTO/handler has no `extras` field, and this skill's [`setup-generic-connection.sh`](../../../../../../.claude/skills/test-generic-connector/setup-generic-connection.sh) exists specifically to work around it by POSTing to the **web** `…/connections` endpoint instead.

_Now:_ no command exists — you must use the web UI or hand-POST the web endpoint.
_After:_ `scratchmd connections create --service GENERIC_API --extras @extras.json` persists `extras` (auth + endpoints) instead of silently dropping them.

**Gap B — the CLI cannot create a generic TABLE.** Even with a connection in place, `linked add` never runs the probe the connector requires:

```
$ scratchmd linked add --connection-id coa_XXX \
    --table-id "GET,https://api.companycam.com/v2/projects?page=1&per_page=100" --name Projects
Error: Server error (500): Generic API error: Endpoint
  "GET,…/v2/projects?page=1&per_page=100" has not been probed yet.
  Re-pick this endpoint from the table picker to run the probe.
```

_After:_ the CLI does the two-step (probe → create-with-probe) server-side:

```
$ scratchmd linked add --connection-id coa_XXX --table-id "GET,…/v2/projects?…" --name Projects
Linked "Projects" (dfd_XXX): probed page 1 (1 record) + page 2 (0) — pagination=page, idPath=id.
```

This test had to work around **both** by hand — POST the connection to the web `…/connections` endpoint, then POST `data-folder/create` with a manually-fetched `probe` in `options.genericApi`.

**Why it's GENERAL (not service-specific):** nothing here touches a particular service — it's the generic connector's CLI setup path. Any service used via the CLI hits it. It's the difference between "generic connector is scriptable / automatable" and "click-only."

**Open question for the reviewer:** is web-only setup an intentional v1 boundary (the web probe is interactive — shows "fetched N from page 1…" and lets the user confirm idPath drift)? If so, the CLI equivalent needs a non-interactive default (auto-accept the probe) plus `--show-probe` to print what it detected. Scope: the connections-create DTO/handler (add `extras`) + `cli-linked.controller.ts createLinkedTable` (run `probeEndpointForTable` before `createFolder`).

---

## 2. Auto-detect camelCase cursor fields (`nextPageToken` / `pageToken`)
**Status:** `FOR_REVIEW` · **Source:** `coverage/quo.md` (2026-06-12) · **Generality:** any API using Google-style camelCase cursors (Quo/OpenPhone, many JS/TS APIs); already flagged across services in `apiget-fixtures/compatibility.md`.

**Here is what happens now:**

apiget's auto-detect only knows **snake_case** cursor names — request `page_token` / `cursor` / `after`, response `next_cursor` / `next_page_token`. Quo's API returns `{ "data": [...], "nextPageToken": "…" }` and takes `?pageToken=`. Neither is recognized, so a config **without** overrides detects no cursor and the pull **silently stops after page 1** (incomplete, no error). Every Quo endpoint therefore must carry a full override block:

```jsonc
"overrides": { "paginationType": "cursor",
               "request":  { "cursorParam": "pageToken", "limitParam": "maxResults" },
               "response": { "cursorPath": "nextPageToken", "dataPath": "data" } }
```

**Here is what will happen after the fix:**

Add the camelCase variants to the auto-detect constant lists — request cursor params `pageToken` (alongside `page_token`), response cursor fields `nextPageToken` / `nextCursor` (alongside `next_cursor` / `next_page_token`). Then Quo paginates with **no overrides at all**:

```jsonc
{ "name": "Contacts", "method": "GET", "url": "https://api.openphone.com/v1/contacts" }
// → auto-detects cursor=pageToken, cursorPath=nextPageToken, dataPath=data; walks all pages.
```

**Why it's GENERAL:** camelCase cursors are extremely common; this removes the most frequent reason a config needs hand-written overrides. **Risk to weigh:** these names are unambiguous, but adding to the auto-detect lists changes behavior for *every* service — needs regression tests so a field that merely contains `nextPageToken` as data doesn't get misread as the cursor. Scope: the `COMMON_CURSOR_*` constants in `apiget/pagination.ts` + tests.

---

## 3. Surface the inferred schema as table columns (v1 emits empty `properties`)
**Status:** `FOR_REVIEW` · **Source:** discovered debugging "no fields in the desktop app" (2026-06-12) · **Generality:** **every** generic-connector table in **every** frontend (web, desktop, CLI). Arguably the highest-impact gap found — it's the difference between "usable tables" and "tables with no columns."

**Here is what happens now:**

`buildBaseJsonTableSpec` ([`generic-api-connector.ts:560-564`](./generic-api-connector.ts)) builds an **empty** `Type.Object({})` and stashes the real inferred fields on a non-standard `_rawInferredSchema` property — which **nothing reads** (grep across `client/` + `scratch-desktop/` + `server/` → 0 consumers). The frontends render columns from the standard `schema.properties`, which is `{}`, so every generic table shows **no fields** even though inference succeeded. From `CompanyCam/.scratch/Projects/schema.json` (25 fields were inferred):

```jsonc
"schema": {
  "type": "object",
  "properties": {},                 // ← what every frontend renders as columns: nothing
  "_rawInferredSchema": {           // ← the real 25 fields, read by no one
    "properties": { "id": {"type":"string"}, "name": {"type":"string"}, "address": {"type":"object", …}, … }
  }
}
```

**Here is what will happen after the fix:**

Populate `properties` from `inferredSchema` — convert the plain JSON Schema to a real TypeBox object instead of `Type.Object({})`:

```jsonc
"schema": {
  "type": "object",
  "properties": { "id": {"type":"string"}, "name": {"type":"string"}, "address": {"type":"object", …}, … /* all 25 */ }
}
```

Columns light up across all three frontends with **no frontend change** — exactly the "compute schema on the server, hand it to the frontend declaratively" principle. The data already round-trips; this is purely the view layer.

**Secondary (same root area):** the schema is captured at **probe (table-create) time** and **not refreshed by `pull`**. A table created while empty (e.g. Photos at 0 records) stays field-less even after records arrive — only an explicit re-probe rebuilds it. Consider re-inferring on pull, or auto-reprobe when the persisted schema is empty but records were fetched.

**Scope:** `buildBaseJsonTableSpec` (JSON-Schema→TypeBox conversion — handle nested objects/arrays + `anyOf` unions); optionally `pullRecordFiles` for the refresh. **Open question for the reviewer:** was the empty `properties` a deliberate v1 scope cut (ship pull/storage first, schema-UI later) or an oversight? Either way this is what makes generic tables render blank today.

---

## ARCHIVE
Implemented items move to [`ARCHIVE.md`](./ARCHIVE.md). (none yet)
