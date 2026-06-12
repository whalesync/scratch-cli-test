---
name: test-generic-connector
description: Test the read-only GENERIC_API connector against one external service at a time — the connector that points Scratch at ANY REST/GraphQL JSON API rather than having bespoke per-service code. Mirrors /connector-build's discipline (resumable coverage doc, timestamp-tracked template, browser + CLI dual verification) but reframed for a read-only, config-driven connector: each endpoint is an entity, schemas are inferred by probing, there is no push/pull round-trip, and there are NO foreign keys. The flow is seed-in-browser → fetch → verify counts → seed more → re-fetch. Produces ONE coverage doc per service at server/src/remote-service/connectors/library/generic-api/coverage/<service>.md listing entities, reference fields, and which entities can/can't be fetched with the reason. Crucially, it feeds connector-improvement candidates through a GENERALITY GATE: a gap earns a connector change only if it's expected to recur across multiple services (or the fix is trivial); one-off quirks are declared UNSUPPORTED so the generic connector never rots into a ball of edge cases.
---

# Test the Generic API connector

The **GENERIC_API** connector (`server/src/remote-service/connectors/library/generic-api/`) is not a per-service connector — it's a single connector that points Scratch at **any REST or GraphQL JSON API**, read-only, driven entirely by a user-supplied config of endpoints. This skill tests it **one service at a time** and records what works per service, while keeping the connector itself lean.

It deliberately reuses the **mental model of [/connector-build](../connector-build/SKILL.md)** — a resumable, timestamp-tracked coverage doc, browser-on-one-side / CLI-on-the-other verification, a milestones tracker, and the **PLAN.md / ARCHIVE.md** improvement flow — but the task is shaped differently. Read that skill's "The docs" and template-versioning sections; the same machinery applies here.

## How this differs from /connector-build

| | /connector-build (per-service connectors) | /test-generic-connector (GENERIC_API) |
|---|---|---|
| Unit of work | one connector = one service, with bespoke code | one connector, **many services**; one **coverage doc per service** |
| Schema | discovered from the service's metadata endpoint | **inferred by probing** records (no schema endpoint) — page 1 + page 2, walk records → JSON Schema (`generic-api-schema-inference.ts`) |
| Entities | declared in connector code (`listTables`) | **each configured endpoint IS an entity/table** (`extras.endpoints[]`) |
| Foreign keys | declared via `x-scratch-foreign-key`, tested with CLI move | **none — the connector has zero FK support.** Record reference fields as observations only |
| Writes | full CRUD round-trip (create/edit/delete → publish) | **read-only** — `create/update/deleteRecords` throw. **No push.** Verify by seed-then-fetch |
| Auth | per-connector (OAuth, API key, params) | **API key only**, sent as a header (`bearer`/`token`/`raw`/`custom-header`) |
| Connector change per service | expected | **avoided** — see [the generality gate](#stage-f--connector-improvement-candidates-the-generality-gate) |

**The single most important rule of this skill:** testing a service must **not** result in a service-specific branch in the connector. The generic connector's value is that it's generic. When a service doesn't work, the default outcome is **"declared unsupported in that service's coverage doc"**, not "added a special case." Only gaps that recur across services (or trivial fixes) earn connector code. This gate is [Stage F](#stage-f--connector-improvement-candidates-the-generality-gate).

## The config — what a connection carries

A GENERIC_API connection stores a non-secret config blob on `connector_account.extras` plus an encrypted `apiKey`. Shape (`packages/shared-types/src/connector/metadata.ts`):

```jsonc
{
  "apiType": "rest",                 // or "graphql"
  "authHeader": { "style": "bearer" },   // bearer | token | raw | custom-header (+ headerName for custom)
  "endpoints": [
    {
      "id": "<uuid>",                // stable; survives reorder
      "name": "Projects",            // display name; one endpoint == one entity/table
      "method": "GET",               // GET | POST (POST body is STATIC — never mutated between pages)
      "url": "https://api.example.com/v1/projects",
      "overrides": {                 // OPTIONAL — replaces auto-detection wholesale for this endpoint
        "paginationType": "cursor",  // cursor | offset | graphql | link-header | page | none
        "request":  { "cursorParam": "cursor", "limitParam": "limit", "maxPageSize": 100 },
        "response": { "cursorPath": "next_cursor", "dataPath": "data", "idPath": "id" }
      }
    }
  ]
}
```

There is **no base-URL field** — each endpoint carries its full `url`. When `overrides` is absent, the engine **auto-detects** pagination + the data/cursor/id paths from the first response. The two AI prompts at `generic-api/ai-prompts/{rest,graphql}-prompt-v1.md` are the **authoritative spec** of what the config can express and its hard limits — read them before building config or judging a gap.

## Step 0 — resume / detect (always first)

1. **Identify the service** (argument, or ask). Slugify it for the filename (`Linear` → `linear`).
2. **Read the coverage doc** `server/src/remote-service/connectors/library/generic-api/coverage/<service>.md` if it exists → resume from the first unverified entity / open TODO. Missing → create it from [service-coverage-template.md](service-coverage-template.md) once you've picked the service and account.
3. **Reconcile the template version** exactly as /connector-build does: compare the doc's `Template version` to the template's; apply any newer `Template changelog` entries, then bump.
4. **Read the connector-wide PLAN.md** (`library/generic-api/PLAN.md`) if present — clear `APPROVED` improvement items before sweeping for new gaps.

## Connection setup — automatable via the API token

**Server: run this against a [`/start-parallel-session`](../start-parallel-session/SKILL.md) server, not the shared `:3010` dev stack.** The generic connector compiles into the server build and pulls run in the worker, so test it against a server running **this worktree's branch code** with its **own isolated Redis/queue**. Run `/start-parallel-session <N>` (N≥1) to bring up a monolith on `http://localhost:<3010+N>` (own Redis on `<6379+N>`, shared Postgres/scratch-git), then target every step at that URL: `SCRATCH_SERVER=http://localhost:<3010+N>` for the helper below, `--scratch-url http://localhost:<3010+N>` for `scratchmd`. A fresh worktree first needs `yarn install` at the repo root **and** a shared-types build (`yarn --cwd packages/shared-types build`) or the server build fails with `Cannot find module '@spinner/shared-types'`. Confirm `ENABLE_GENERIC_CONNECTOR` is on for the acting user before creating the connection. Use a **dedicated, connector-prefixed workbook** (e.g. `generic-<service>`) so it's scannable in the shared DB — don't reuse another connector's workbook.

You can stand up a GENERIC_API connection **fully programmatically** — no UI. The `scratchmd` CLI **cannot** do it (its create request drops `extras`), so use the **web** REST endpoint directly with the CLI's API token:

```
POST {server}/workbooks/{workbookId}/connections
Authorization: API-Token <token from ~/.scratchmd/credentials.yaml → environments[<host>].apiToken>
Content-Type: application/json

{ "service": "GENERIC_API", "displayName": "<svc>", "userProvidedParams": { "apiKey": "<key>" }, "extras": { ... } }
```

The helper [`setup-generic-connection.sh`](setup-generic-connection.sh) wraps this (reads the token, POSTs a body file, pretty-prints the result). Hard requirements, all enforced server-side:

- **Feature flag:** `ENABLE_GENERIC_CONNECTOR` must be on for the acting user (`connector-account.service.ts` → `assertGenericConnectorEnabled`, 403 otherwise). The probe controller has its own PostHog gate too — enable the generic-connector flag for the test user first.
- **Live auth probe at create time:** the server probes the first endpoint with the key before any row is written (`probeAuthOnly`). A bad/placeholder key → no connection. So the key must already be valid.
- **SSRF guard:** endpoint URLs must be public HTTPS that resolve to public IPs (no localhost / private / metadata IPs).

**The human gate (cannot be automated):** obtaining the target service's **API key / PAT**. A human logs into the service in the browser and generates a long-lived key. The generic connector does **no OAuth** for arbitrary services — if the service only issues OAuth tokens, the service is **unsupported** (record it; don't try to build OAuth into the generic connector). Pause for the human exactly here, the same way /connector-build pauses for login/billing/captcha gates.

## The flow — read-only, so seed then fetch

There is no publish. You prove an entity works by **putting data into the service and then fetching it**, comparing counts. Stages:

**Browser tooling — gstack or chrome, your pick.** The browser-driven steps in this flow (logging into the service in Stage A, seeding and observing records in the service's UI in Stage D) can use **either** the gstack `/browse` skill **or** the claude-in-chrome MCP tools — the exact same principle as /connector-build's browser work. Default to gstack `/browse` for isolated headless runs; reach for chrome when you need the user's real, already-logged-in session or to coordinate tabs (there, always create your **own** tab so parallel agents don't collide). Pause for the human at any login / captcha / 2FA gate.

### Stage A — pick the service & get a key (human gate)
Human logs into the service (browser), generates an API key, and tells you the key + the API docs URL. Record the key's **source** (settings path) in the coverage doc — never the key itself. Confirm the service issues a **long-lived key** (not OAuth-only) — if OAuth-only, stop and mark the service unsupported.

### Stage B — map the API's entities → endpoints (build `extras`)
From the service's API docs, enumerate its **list endpoints** (the collection endpoints — `GET /projects`, `GET /issues`, …). Each becomes one endpoint/entity. For each, decide: method, full URL, auth header style, and whether auto-detection will handle pagination or you need `overrides` (consult the AI prompt). Build the `extras` object. **Maximize the entity list** — include every top-level collection the service exposes, even ones you suspect won't fetch (you'll classify them in Stage E).

### Stage C — create the connection
Run the helper / recipe to create the GENERIC_API connection in the test workbook. Record `workbook` + `connectorAccount` ids and the exact `extras` used in the coverage doc.

### Stage D — per entity: probe, add table, fetch, verify counts

> **Seeding shortcut — the API can write even though the connector can't (ASK FIRST).** The GENERIC_API *connector* is read-only, but **you (the skill) hold the service's API key and can `POST` to the service directly** to seed records far faster and more reliably than clicking through the UI — create a batch of projects/tags/photos in one script, then fetch them back through the connector. This is fair game for testing. **But get the user's explicit go-ahead before writing to their service via the API.** Users frequently assume that because the *connector* is read-only the whole skill is read-only, and will not expect the skill to create data in their account; don't surprise them. Once they say yes, prefer API-seeding for speed, and **record in the coverage doc whether seeding was via API or UI** (and note anything the API can't create — e.g. mobile-only uploads — which still needs manual UI/app seeding).

For each endpoint, drive the **seed → fetch** loop and record it in the doc's verification log:
1. **Seed** a known number of records of that entity — in the service's UI (browser) **or**, with the user's permission, via the service's API (see the shortcut above) — or note the existing count from the service's own API/UI.
2. **Probe + add the table** (the client's `probe-endpoint` flow, or the `apiget-driver.ts` script for a quick check), then **pull**.
3. **Verify**: the fetched record count and a spot-checked record match what you seeded/observed in the service. ✅ only when the live numbers line up.
4. **Seed more** (add a few records in the browser), **re-pull**, confirm the new ones arrive. This is the read-only stand-in for an edit round-trip.

### Stage E — classify fetchability (the core deliverable)
Sort **every** entity into **fetchable ✅** or **not-fetchable ❌**, and for each ❌ give the **reason**, mapped to the known taxonomy (`generic-api/ai-prompts/rest-prompt-v1.md` "Hard limits" + the connector's guards):

- **OAuth-only** — service issues no long-lived key.
- **Cursor-in-POST-body** — service paginates by mutating a POST body cursor (Notion, Attio, Sanity, Plaid). REST POST bodies are static here → would loop on page 1. (GraphQL is the one exception — cursor goes in `variables`.)
- **Request signing** — AWS SigV4 / HMAC chains. Not expressible.
- **Non-HTTPS / private-IP** — blocked by the SSRF guard.
- **Non-JSON response** — `NonJsonResponseError`; JSON only.
- **Composite / object ID** — `idPath` resolves to an object (e.g. Attio `{record_id, workspace_id}`) → pull hard-fails unless overridden to a primitive leaf. Note whether an `idPath` override rescued it.
- **Duplicate IDs** — `idPath` not unique → pull hard-fails.
- **Partial/!wrong pagination override** — config that sets a request param without its response path (stops after page 1).

Record, per entity, whether a **config workaround** (an `overrides` block) made it fetchable, since that's a legitimate generic capability — vs. a true dead end.

### Stage F — connector-improvement candidates (the generality gate)
When Stage D/E surfaces a gap, do **not** reflexively patch the connector. Classify each candidate fix into exactly one bucket and record the decision in the coverage doc's **Improvement candidates** table:

- **GENERAL** — the gap is expected to recur across **a meaningful share of services** (rule of thumb: it would help **≥ ~3 services / some real %**, not just this one). Example: cursor-in-POST-body pagination blocks Notion **and** Attio **and** Sanity **and** Plaid — clearly general. → Promote it to a **plan item in `library/generic-api/PLAN.md`** (status `FOR_REVIEW`), following the /connector-build PLAN/ARCHIVE flow. A human approves before it's built.
- **TRIVIAL** — tiny, local, low-risk fix, even if the trigger is rare (e.g. tolerate a trailing slash, accept one more cursor field name). → Just apply it (the small-fix exception); note it in the doc.
- **TOO-SPECIFIC** — a quirk unique to one service and non-trivial to support generically. → **Declare the entity/service UNSUPPORTED** in the coverage doc with the reason. **Do not change the connector.** This is the default; it's what keeps the connector from becoming a ball of edge cases.

When unsure between GENERAL and TOO-SPECIFIC, **default to TOO-SPECIFIC / unsupported** and write down what additional service would have to hit the same gap to reclassify it as GENERAL. The bar is "does this generalize?", and the burden of proof is on adding code.

**A promoted plan item lives or dies on its example.** When you write a `GENERAL` candidate into `library/generic-api/PLAN.md`, follow /connector-build's single most important PLAN rule: **lead with a concrete before/after example, not prose.** Show a **minimal** real example — the failing call + response and the records the connector produces now, trimmed to only the fields that matter — **"here is what happens now: …"** — then the same call/records as they will look after the fix — **"here is what will happen after the fix: …"**. The explanation still matters, but a clear, concise example a human can grasp in seconds is what makes the item good and is what a reviewer needs to approve it from the example alone.

## The coverage doc — `coverage/<service>.md`

One per service, co-located with the connector at `server/src/remote-service/connectors/library/generic-api/coverage/<service>.md`. Template: [service-coverage-template.md](service-coverage-template.md). It must include, in order:

1. A **do-not-delete** notice (generated/maintained by this skill).
2. **Metadata** — `Template version` this doc is reconciled to, `Last run`, `Tester`, service.
3. **User notes (client-facing brief)** — a one-line pointer to the separate sendable brief `coverage/<service>-user-notes.md` (see below). The brief itself lives in that standalone file, not inline.
4. **Service & connection** — service name, login + API-docs URLs, **where the API key lives** (settings path / decrypt recipe — never the key), auth header style, notable API traits (pagination style, OAuth?).
5. **Connection setup** — test `workbook` / `connectorAccount` ids, how it was created (helper/recipe), and the exact `extras` used.
6. **Entities** table — one row per endpoint considered: name, method + url, pagination type, `idPath`, **fetchable** (✅/❌/➖), records fetched, notes.
7. **Fetchability** — for each ❌, the reason from the [taxonomy](#stage-e--classify-fetchability-the-core-deliverable), and any `overrides` workaround that rescued it.
8. **Reference fields (pseudo-FKs)** — fields observed to point at other entities. The connector does **not** resolve these; record them as data observations (field → likely target entity) so we know the relational shape exists.
9. **Fetch verification log** — timestamped seed→fetch entries (seeded N of X in the service → pulled N), the read-only proof.
10. **Improvement candidates** — the Stage F table: candidate, gap, classification (GENERAL / TRIVIAL / TOO-SPECIFIC→UNSUPPORTED), rationale (how many services it'd help), action (PLAN.md item / fixed now / declared unsupported).
11. **Coverage summary** — counts (entities fetchable / unsupported) and overall status.

Keep `Last run` current; flip a cell to ✅ only after a live fetch confirmed it. Legend: ✅ fetched & verified · ⬜ not yet · ➖ N/A · ❌ not fetchable (see reason).

## Template versioning (same machinery as /connector-build)

The template carries a `Template version` (Metadata) and a `## Template changelog` at the bottom; every coverage doc records the `Template version` it was last reconciled to. **Consuming (every run):** Step 0 reconciles forward via the changelog. **Changing the template** (add/rename/remove a section or required rule): bump the template's `Template version` to today's date **and** add one concise changelog line. This lets any coverage doc diff itself against the template and catch up — so "as of which timestamp was this service covered" is always answerable.

## The docs, for the generic connector

- `…/generic-api/coverage/<service>.md` — **one per service** (this skill). What's been tested for that service.
- `…/generic-api/coverage/<service>-user-notes.md` — **client-facing brief, one per service.** Short, plain-language, sendable as-is: what's supported, what isn't, the gotchas, and a **paste-ready JSON config snippet** of the fetchable endpoints (what the user enters in Scratch) + a note on per-endpoint `overrides` options. The coverage doc's "User notes" section just points here.
- `…/generic-api/PLAN.md` — connector-wide **active** improvement plans (only the GENERAL candidates promoted from coverage docs). Reuses the /connector-build PLAN flow.
- `…/generic-api/ARCHIVE.md` — implemented plans, moved out of PLAN.md once shipped.
- [service-coverage-template.md](service-coverage-template.md) — the per-service template (this skill folder). Improve it here; bump its version when you do.
