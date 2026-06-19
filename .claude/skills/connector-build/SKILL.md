---
name: connector-build
description: The autonomous, from-zero process for building AND finishing a Scratch connector — drive the external service in a gstack browser on one side, the scratchmd CLI on the other, confirming EVERY operation with the CLI and the service's own API. `/connector-build <name>` can start from nothing: scaffold the connector code, provision a test account on the service, connect, pull, and exercise every operation — pausing ONLY for human-required gates (service login, credit-card/billing for a trial, captcha/2FA, email verification). Resumable at any stage via a per-connector STATE.md coverage doc. Per entity for static-schema services, per field-type for dynamic-schema services; hunts connector-specific edge cases and tracks covered/uncovered operations.
user-invocable: true
---

# connector-build

A **process** that takes a connector from **zero → finished**, self-driving as far as it can. Two sides:

- **Service side** — a **gstack browser** on the real service (sign up, log in, create records, watch results).
- **Scratch side** — the **`scratchmd` CLI** (scaffold, connect, pull, edit, push, confirm).

Connector *code patterns* are owned by **[CONNECTOR_GUIDE.md](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)**; this skill orchestrates the whole journey around them and proves the result live.

**Source of truth = the coverage doc** `server/src/remote-service/connectors/library/<connector>/STATE.md`. Resumable: read it, continue from the first uncovered cell. A connector may be at 0%, 1%, or 95%. (In flight: **copper** ~most complete, **gohighlevel** partial, **zoho** no code yet.)

**Prime directive: trust nothing you didn't confirm with the CLI or the service API.** A green "completed" is not proof; a Scratch pull is not proof of a push.

## Definition of done — STRICT. Go deep, not broad. (read before declaring anything "built")

**The happy path passing is the START of the work, not the end.** A connector where pull + one edit + one create + one delete succeed is **~10% done**, not done. The job is *exhaustive* coverage of the service's object and field surface — that is where the real bugs live (this skill exists because they do). **Breadth-then-stop is the #1 failure mode of this workflow. Do not do it.** Do not report a connector as "working" / "validated" / "end-to-end" until **every** box below is literally true; if you catch yourself writing "documented as a fast-follow", "representative sample", "v1 scope", or "left as next steps" for something you could have tested, **stop and test it instead.**

**When in doubt about how deep to go, OVERDO it — overtest, never undertest.** The product goal is to **sync everything possible from any system**, so the bar is "what *can* this service represent that we haven't proven we can round-trip?" — not "is the demo path green?". Extra coverage is cheap; a missed object/field that silently doesn't sync is a real user losing real data. Err toward more cases, more types, more probing.

A connector is **not** built until ALL hold — verified in the service, not assumed:

1. **Enumerate first, then cover.** Pull the *complete* surface from the service's own API before testing: every object/entity family, and (dynamic) every custom-field **type the service offers** — not the ones that happen to exist in the test workspace. You can't cover what you didn't enumerate; a short list is a red flag you under-enumerated.
2. **Objects table complete** (coverage-doc item 4): every object family classified (table / record / schema / embedded-verbatim / **not-exposed**), and every *not-exposed* one carries a concrete reason. "Tasks work" is not coverage of "ClickUp". **Extract the structural facts** about how the service models its objects and record them in the coverage doc — e.g. "a ClickUp subtask is just a Task with a `parent` id", "custom-field values live in an array addressed by field id, not as top-level keys", "statuses are per-list, not global". These facts decide whether an object needs its own codepath (see Stage A) and how to test it; **confirm each live, don't assume** (create a subtask and inspect it — don't guess from docs).
3. **Every EXPOSED object** round-trips full CRUD (pull, create→push, edit→push, delete→push), each confirmed in the service API **and** the UI.
4. **Every field type the service supports** is **seeded and round-tripped** — not one representative type. For dynamic connectors that means creating one of *each* custom-field type (text, number, date, single-select, multi-select, checkbox, currency, url/email, relationship/FK, formula=read-only, …), setting a value, pulling it, editing it, pushing it, and confirming. Selects get the id-vs-label check; dates the tz check; relations the FK both-directions check.
5. **Every embedded sub-object's** read fidelity confirmed (checklists, tags, assignees, comments-if-embedded, …) and its write path either implemented+tested or explicitly marked read-only **with the API reason**.
6. **Pass 2 edge cases run** (empty/null, long strings, unicode/emoji, large arrays, boundary numbers, archival, pagination mid-pull, incremental vs full) — see [Stage E](#stage-e--hunt-connector-specific-edge-cases-highest-value).
7. **No `⬜` cell without a one-line concrete blocker.** A genuine human-gate (login/billing/2FA) is a valid blocker → pause + `/read`. **UI flakiness is NOT a blocker** — persist: retry, use `$B js` to click precise nodes, try the alternate UI path (e.g. a field manager), or seed via the API where the API allows it. "The UI was fiddly" is never an acceptable reason to skip a type.
8. **Coverage audit before you finish.** Before the closing `/read`, write a short audit into the run summary: `covered N / total M cells`, and list every remaining `⬜` with its blocker. If the gate isn't met and nothing *human* is blocking you, **you are not done — keep going.**

Scale effort to the surface, not to your patience. A 15-field-type service means ~15 seed-and-round-trip cycles; do all 15.

**Lean on the CLI; reach for the browser only where it's the only option.** The CLI is local and far faster than clicking through a web UI — do reads, edits, creates, deletes, FK wiring, and verification with `scratchmd` whenever you can. The browser earns its cost in two spots: **(1) seeding data through the service UI** at the start (creating records to pull, when there's nothing to pull yet), and **(2) confirming a change actually landed in the UI** the way a user would see it. Default to CLI; use the browser deliberately.

---

## Entry points & the autonomy contract

- `/connector-build <name>` — start from **nothing**: create the connector folder + boilerplate, provision/select a test account, create the connection, pull, and run the test matrix.
- `/connector-build <name> [account: <id|creds|"use the open browser session">]` — same, but use a provided/known account instead of creating one.
- `/connector-build <name> resume` — read `STATE.md` and continue.

**Drive yourself end-to-end. PAUSE only for gates a human must clear:**
1. **Service login / SSO** (entering the user's credentials).
2. **Credit card / billing** for a trial or paid signup.
3. **Captcha / 2FA / email or phone verification.**
4. An explicitly **destructive** confirmation (deleting a real account, mass-deleting real data).

Everything else — signup form fill, folder scaffolding, connection creation, pulls, edits, pushes, FK wiring, edge-case probing, coverage updates — you do **without asking**. The bar is: *you should be able to launch ~10 of these in parallel and only get pulled in for billing and login.*

### When blocked, alert the developer out loud
A parallel run that silently stalls wastes time. Whenever you hit a gate above — or any unexpected blocker that needs the user — do this in order:
1. **Post a crisp message**: what you're stuck on, exactly what you need from the user, and where (which service / browser tab). One short paragraph (e.g. "Blocked: log into Acme in the open gstack browser, then say 'go'.").
2. **If a `/read` skill is available** (check the available-skills list for `read`), **invoke it immediately** so the message is read aloud — the developer may be away from the screen running several of these, and the voice cue tells them an input is needed. `/read` reads the *previous* response, so post the message first, then call `/read`.
3. Stop and wait. Resume autonomously once the gate is cleared.

**GCS / gcloud reauth is one of these gates.** If `scratchmd files upload` returns a **500** and the server log shows a GCS signing error (`invalid_rapt` / `SigningError` from `object-storage.service.ts`), the local gcloud ADC has expired and the publish path is blocked for *every* connector. This is **not** a connector bug — do **not** try to fix it in code. Post a one-line message that **GCS must be re-authed** (`gcloud auth application-default login`), `/read` it, and continue with any non-publish work meanwhile (e.g. prove writes via a live-API integration spec). Resume the CLI publish flow once the user says it's reauthed.

### End every run out loud (`/read`)
**Always finish a run by invoking the `/read` skill (if it exists)** — whether you finished cleanly, paused at a gate, or hit a wall. Post a short summary first (what got covered, what's blocked/next), then call `/read` so it's read aloud. The developer may be running several connectors in parallel and away from the screen; the voice cue tells them this one wants attention.

**The summary must carry the coverage audit** from the [Definition of done](#definition-of-done--strict-go-deep-not-broad-read-before-declaring-anything-built) (#8): `covered N / total M`, and every remaining `⬜` with its blocker. **Only the word "done" when the gate is met.** If you're ending because you ran out of patience rather than because every cell is `✅` or genuinely human-blocked, say so plainly — "stopped early at breadth, depth not done" — rather than dressing it up as success. Don't let a tidy summary imply coverage you didn't reach.

## Prerequisite — browser preflight (HARD GATE, before any testing)

Do this **before** pulling/pushing anything. The browser is not optional: create-in-service and UI-link discovery require it, so a CLI-only run does **not** finish a connector.

**Two browser drivers are on the table — gstack is the DEFAULT.** Use gstack unless the **user explicitly asked** to use the Chrome extension.
- **gstack `$B`** (default) — an **isolated headless browser per agent**. Always use this unless told otherwise. It's the default because parallel/autonomous runs need isolation: each agent gets its own browser, zero collisions.
- **Claude-for-Chrome extension** (`mcp__claude-in-chrome__*`) — **only when the user explicitly requests it** ("use the Chrome extension"). It drives the user's **real, logged-in Chrome** (handy for an attended single run that needs existing logins), but it's a **shared** browser with no hard isolation. The user must connect it first via `/chrome` (the agent can't trigger it). **CRITICAL — every time you use it: create your OWN tab with `tabs_create_mcp` and drive only that tab id.** Never `tabs_context_mcp createIfEmpty` and reuse whatever tab is there — two agents race onto the same tab and stomp each other (booking.com → Airbnb mid-action is the symptom). Because there's no real isolation, **don't pick it for parallel runs** — those stay on gstack.

**gstack path (default):**
1. Launch/verify the gstack browser: `$B connect` then `$B status` → must show `Mode: headed`.
2. `$B goto` the service and `snapshot` — confirm you are **logged in** (authenticated UI, not a login wall).

**Chrome-extension path (only if the user asked):** load the tools via ToolSearch → `tabs_create_mcp` to make **your own** tab → `navigate` it to the service → `read_page`/`screenshot` to confirm you're **logged in**. Drive only that tab id for the rest of the run.

**If the browser won't start, the service won't load, or you're not logged in and can't get logged in** (and the user isn't available to log in), **STOP and exit early**: post a one-line warning naming exactly what failed (e.g. "Browser preflight failed: gstack headed mode won't start" / "Not logged into Acme — need a login"), `/read` it, and do not proceed with a partial CLI-only pass. Resume once the gate clears.

---

## Step 0 — Resume & account detection (ALWAYS run first)

**First, load the cross-connector playbook:** read [`docs/connector-build.md`](/docs/connector-build.md) — the accumulated catalog of tricks and problems seen on prior connectors — so you start already knowing what to watch for. You'll append to it in Stage E.

1. **Pick the connector** + folder `server/src/remote-service/connectors/library/<connector>/`; service constant in `service-constants.ts`.
2. **Read `STATE.md`.** Exists → it is the state (resume at first `⬜`); also re-read the **Test account** section so you reuse the same account. Missing → create it from [coverage-template.md](coverage-template.md) once you've classified + picked an account.
   - **Reconcile the template version FIRST.** Compare the doc's `Template version` (Metadata) against the **template's** current `Template version`. If the doc is **older**, the template has moved on — read the template's [Template changelog](coverage-template.md#template-changelog), apply every entry newer than the doc's version (add the new sections / table columns / fields the changelog describes), then **bump the doc's `Template version`** to the template's current value. Do this before resuming coverage, so you're working against the current structure. (If the doc has *no* `Template version`, it predates versioning — reconcile it to the full current template and stamp it.)
   - **Clear the TODOs FIRST.** The STATE.md **TODOs** section is the known-gaps backlog — tasks a prior run already identified (a built-but-untested path, a deferred edge case, a field that needs a write test). On resume, **start by knocking those out** *before* sweeping the coverage tables for fresh `⬜`s. Skip only a TODO explicitly marked **blocked** (a human gate — login/billing/approval). An identified-but-undone TODO is the single thing most likely to be silently shipped as "done", so clear them ASAP and check each off (or promote it to a confirmed `✅`/`❌` cell) as it lands.
3. **Probe each layer with a command, not an assumption:** code exists? (`ls` + registered in `library/index.ts`) · connection exists? (`scratchmd connections --workspace <wkb> list`) · workspace cloned? (`~/.scratchmd/workspaces.yaml`) · browser up + which service is it logged into? (`$B status`, snapshot).
4. **Select the test account — precedence order (do NOT create a new one if an earlier option matches):**
   - **(a) User-provided account / credentials** → use exactly that.
   - **(b) The gstack browser is already authenticated for this service** → **assume that logged-in account IS the test account** and use it. (Don't sign up again.)
   - **(c) The coverage doc names an account** → reuse it.
   - **(d) None of the above** → **provision a new account** ([Stage A0](#stage-a0--provision-the-test-account)).
5. Announce detected position + chosen account in one line, then continue from the earliest gap.

### Adopting a human-built connector (code exists, no STATE.md)
A common starting state: a developer already built part (or all) of the connector but never ran this skill — so there's **substantial code but no STATE.md** (e.g. Affinity). Don't treat it as greenfield, and **don't trust the code as tested.** Reverse-engineer the doc *from the code* first:
1. **Cold-read every connector file** and fill the STATE.md from what the code actually does — Objects tables, entity/field matrix, paths, auth, endpoints, FK, incremental, default view — citing the source, not a test run. Pull the linked issue(s) too (it states the *intended* next step, e.g. "add publishing").
2. **Mark all coverage `⬜`.** Existing code is **not** evidence of a passing round-trip; only a live CLI+service confirmation earns a ✅. A fresh adoption starts unverified even where code clearly exists — say so in a one-line note rather than inferring green.
3. **Seed the TODOs section** (below) from the gaps the code reveals — write methods stubbed/throwing, fields not marked read-only, entities in types but not in `listTables`, no default view, incremental not wired — plus the linked issue's asks.
4. Then run the normal passes (browser preflight → harness → Stage C…), now driven by the doc you just wrote.

---

## Step 1 — Classify the connector (decides what you iterate over)

Read `listTables()`: hardcoded entity list ⇒ **static**; tables discovered from the service ⇒ **dynamic**. Many are **mixed**.

- **Static / opinionated** (CRMs, Stripe, YouTube, WordPress): fixed entities, one endpoint each → **test object-by-object**; record *where each entity is created in the service UI* (screen, form, required fields).
- **Dynamic / open** (Postgres, Supabase, Airtable, Notion): user-defined objects, one endpoint pattern → **test field-types**; build one table with every type and round-trip each.
- **Mixed** (HubSpot, Copper, Pipedrive, Attio): standard entities **plus** custom objects/fields → do both. Mark `Type: STATIC · custom fields supported (mixed)`.

**Where each schema comes from (decide per object family):** **dynamic** data (user-defined objects/fields) → build the schema from the service's **discovery endpoint** at runtime; **static** data (fixed system entities/fields with **no** schema/describe endpoint) → enumerate the fields from the **API docs / OpenAPI** and **hardcode** them in the connector (the sanctioned exception to "discover dynamically"). If a discovery endpoint already returns the static fields *alongside* the dynamic ones, use that one endpoint for both; only hardcode when the static schema is **not exposed by any endpoint**. A static entity whose generic builder emits only an `id` column (no field metadata) is the tell that this enumeration was skipped. See [docs/connector-build.md → Schema & structure](/docs/connector-build.md).

### Check for prior art in Whalesync (the legacy product) — research, don't copy
Whalesync (this company's older sync product) may already have a connector for this service. **If it does, research it for domain knowledge** — the entity surface, field quirks, pagination, rate limits, and gotchas it learned the hard way are a real head start. But treat it as **reference, never a template**, with two hard caveats:
- **iApp-based connectors are low-value references.** Some Whalesync connectors are built on **iApp**, a *generic* third-party integration platform, not a direct integration. **Spinner does direct integrations only**, so an iApp connector tells you little about the real API surface — don't mirror its shape; verify everything against the service's own API.
- **Always target the newest API/SDK, even if Whalesync uses an older one.** A Whalesync connector may be pinned to an old API version or client. Don't inherit that — build the Spinner connector on the service's **latest API version + official/maintained SDK or CLI**, and record the currency verdict in the STATE.md Endpoints "API version & client" line.

**Where it is:** Whalesync is a **sibling repo** of spinner — same parent folder, i.e. `../whalesync` (e.g. `/Users/ijd/repos/whalesync`). Connectors live at **`api/bottlenose/src/connectors/`**: direct ones as `<service>-connector/`, iApp ones under `iapp-connectors/<service>-connector/`. **If `../whalesync` isn't there, don't guess** — ask the user for its path, *or* to confirm this is a new connector you shouldn't look for in Whalesync.

**The Whalesync connector inventory is fixed (these don't change) — only look for these; anything not listed has no Whalesync connector, so don't waste time searching:**
- **Direct integrations** (worth researching): affinity, airtable, bubble, github, hubspot, memberstack, notion, postgres, salesforce, shopify, stripe, supabase, webflow, wix, wordpress (.com), wordpressorg (.org self-hosted), youtube.
- **iApp-based** (generic-platform → low-value reference, see caveat above): apollo, attio, close, copper, dynamics-crm, outreach, pipedrive, sheets (Google Sheets), zoho.

---

## Stage A — Scaffold the connector code (only if missing)

If there is no `<connector>/` folder, create the boilerplate yourself, mirroring an existing connector (e.g. `copper/`) and following **[CONNECTOR_GUIDE.md](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)** for the method bodies:

- `<connector>-types.ts`, `<connector>-api-client.ts`, `<connector>-json-schema.ts`, `<connector>-connector.ts`, `__tests__/`.
- Add the service constant (`service-constants.ts`) and register the factory (`library/index.ts`).
- **Give the connector a logo** (`metadata.logo`) — and **actually upload the asset, then verify the URL returns 200.** New connectors render with **no icon** until you set it. Find an **SVG** of the service's mark on a **white or transparent background** (simpleicons.org, the brand press kit). If the brand has multiple variants, pick the **simplest** one — the **icon/symbol, not the full wordmark** — because it's shown as a **tiny icon** where detail and text are lost; a clean single-color symbol (set `fill` to the brand color) reads best. **The #1 mistake (causes a broken-image icon): setting `metadata.logo` to `https://static.scratch.md/connector-icons/<service>.svg` but never uploading the file** — so the URL 404s. Always: `gcloud storage cp <svg> gs://spv1eu-production-static/connector-icons/<service>.svg --content-type="image/svg+xml"`, then `curl -I https://static.scratch.md/connector-icons/<service>.svg` and confirm **200** before considering the logo done (see CONNECTOR_GUIDE.md → Connector Logo).
- Implement the abstract members (`testConnection`, `listTables`, `fetchJsonTableSpec`, `pullRecordFiles`, and the write methods), storing **raw API responses verbatim** and preferring **dynamic schema discovery**.
- **Label EVERY read-only field `x-scratch-readonly` in the schema — and propagate that into the default view's columns.** Whenever you write/generate schema logic, audit which fields the service **computes or won't accept on write** and mark each one: **server timestamps (`createdAt`/`dateCreated`, `updatedAt`/`dateUpdated`/`dateAdded`)** are the usual miss, plus ids, audit/system fields, and computed/rollup/formula fields. If they're not labeled, the UI lets the user **edit a field that publish silently drops** — a wasted edit. **The schema flag alone isn't enough when you ship a `defaultView`:** the grid honors the column's own `readonly`, so derive each col's `readonly` from the property's `x-scratch-readonly` (don't hardcode "only id" or leave it off). When in doubt a field is read-only, mark it read-only — the service rejects/ignores writes either way, so the only question is whether the user finds out before or after wasting the edit.
- **Build the folder-path hierarchy from the start** (see [Path structure](#path-structure-the-hierarchy-is-the-path) below) — `basePath` on the table spec, not a flat path. Retrofitting paths later churns every record's location.
- **Set `remoteWebUrl` on the table spec when the service has a constructible deep link** to the table in its own web UI (e.g. Airtable `https://airtable.com/{baseId}/{tableId}`, Notion `https://www.notion.so/{databaseId-without-dashes}`, Stripe `https://dashboard.stripe.com/{entity}`). It's persisted to `DataFolder.remoteWebUrl` and lets the client offer an "open in {service}" link. The ids you need are already in `EntityId.remoteId` (the same ids you encode for `basePath`). **Omit it rather than emit a guessed/broken URL** — a wrong link is worse than none. See CONNECTOR_GUIDE.md → `fetchJsonTableSpec()`.
- Get `yarn build` + smoke tests green before live-testing.

### Path structure — the hierarchy IS the path
The record's on-disk path mirrors how a user navigates the service. `data-folder.service` builds `/{basePath…}/{table}/{record}.json`, so **`basePath` is where you encode the structural hierarchy**. Get this right up front:

- **Any level that can have more than one instance MUST be a path segment.** If a connection can see multiple workspaces, the **workspace** goes in the path; multiple spaces → **space** in the path; etc. Omit it and records from different instances **collide** (two workspaces each with a "Team Space/Project 1" would overwrite each other). A level that is **always singular** for a connection (the account the API key belongs to) is the connection scope and stays **out** of the path.
- **Different entity *types* under the same scope must be separable.** A space holding both task-Lists and Docs can't put both at `/{Space}/{Name}/` — give each entity type its **own table** (and, when they'd otherwise collide, a type segment like `…/Docs/…` vs the list's own name). This is the same reason [structurally-different entities get their own codepath](#stage-a--scaffold-the-connector-code-only-if-missing).
- **Mirror the user's mental model:** `workspace → space → folder → list → record` (ClickUp), `base → table → record` (Airtable), `schema → table → record` (Postgres). Examples:
  - ClickUp: `/{Workspace}/{Space}/{Folder}/{List}/{task}.json` for tasks; `/{Workspace}/Users/{user}.json`, `/{Workspace}/Docs/{doc}.json` for the other entities.
  - Postgres: `/{schema}/{table}/{record}.json` · Airtable: `/{base}/{table}/{record}.json`.
- Because `fetchJsonTableSpec` only receives the `EntityId`, **encode the structural ids the path needs into `remoteId`** at `listTables` time (e.g. `['list', teamId, listId]`), then resolve the display **names** for `basePath` from the live API in `fetchJsonTableSpec`.

**Structurally weird objects get their own codepath — don't over-generalize.** The general fetch/push code should handle the **common** objects of the service (the ones that share a shape — e.g. ClickUp Tasks + subtasks, which are just tasks with a `parent`). When an object is **structurally different** (a different endpoint family, a fundamentally different shape, a separate sub-resource like Docs/pages, Comments, time entries, attachments), give it its **own fetch/push methods/path** rather than bending the common code to fit. **Minor per-object exceptions in the main code are fine** (a field that translates differently, a feature-gated field to skip); **structural** weirdness is not — forcing a genuinely different entity through the common path produces silent mis-routing and unmaintainable branching. Use the [structural facts](#definition-of-done--strict-go-deep-not-broad-read-before-declaring-anything-built) you extracted to decide: same shape → shared path; different shape → dedicated path. (Code patterns themselves live in [CONNECTOR_GUIDE.md](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md).)

Do this autonomously; only stop if a real API decision needs the user.

## Stage A0 — Provision the test account

Reached only when Step 0 found no usable account.

1. In the gstack browser, go to the service's **sign-up** page and fill the signup form autonomously (name, work email, company). Prefer the user's email/org if known.
2. **PAUSE** at the first human gate — email/phone verification, captcha, credit-card for a trial, or SSO login — with a one-line ask. Resume after.
3. Once in, capture: account/org id, login email, plan + **trial end date**, and where API credentials are generated.
4. **Record it in the coverage doc immediately** — the **Test account** section (no API key, just where to find it) and, if it's a paid trial, the **TRIAL — CANCEL BY <date>** banner at the very top. This is how nobody gets surprise-charged.

---

## Stage B — Stand up the harness (CLI)

> **Create a Scratch workspace with the CLI ASAP — the moment you have a healthy connection — so the human can monitor records in the desktop app while you keep working.** As soon as a workspace exists, is connected, and one table is pulled, the developer can open it in **Scratch desktop** and watch records land (and edits round-trip) in real time. This is a primary deliverable, not an afterthought: do it early, announce the workspace id, and pull at least one record-bearing table so there's something to see — don't leave the workspace to the end of the run.
>
> **Worktree split:** run the **desktop app and CLI from the *main* checkout** (build them once — they don't change per branch) and run **only the server from the branch worktree** (which has the connector code under test), so you never rebuild the app/CLI per worktree.
>
> **Clones sync through the SERVER, not the filesystem.** The desktop app's download and any `scratchmd workspaces init -o <dir>` clone are **separate git checkouts** of the same workspace. A hand-edit in one folder is invisible to the other — and to the app's UI — until it's **published to the server and pulled** by the other; the desktop app does **not** live-watch raw on-disk edits. So: edit **in-app** or via the **CLI publish flow** (`files accept`→`upload`→`publish`), then **pull/refresh** the other clone. (Note: `workspaces init -o <dir>` re-points the CLI's `workspaces.yaml` entry for that wkb to `<dir>` — so the CLI and desktop can end up on different folders.)

### B0 — Worktree check: are you a parallel session? (decide this FIRST, before the CLI setup)

**One command decides who runs the server — you or the human:**
```bash
[ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] && echo MAIN || echo WORKTREE
```

- **`MAIN`** (the repo's primary checkout) → **you are NOT a parallel session — do nothing special.** The human runs the server themselves (`cd server && yarn dev`) on the default `:3010` (Redis `:6379`), and `scratchmd` uses its default target (no `--scratch-url`). **Skip all the parallel machinery — don't even read `/start-parallel-session`.** Go straight to step 1 below.

- **`WORKTREE`** (a linked git worktree — e.g. a Conductor worktree) → **assume this MUST be its own parallel session** (that's what a worktree is *for*), so **you own the server here.** Set it up *before* the rest of Stage B:
  1. **Pick your session index `N` by inspecting taken ports.** Each session's server is `3010+N` and Redis `6379+N`; a **taken `3010+N` means a sibling session already holds `N`** — so the lowest free one is yours:
     ```bash
     for N in $(seq 1 16); do lsof -nP -iTCP:$((3010+N)) -sTCP:LISTEN >/dev/null 2>&1 || { echo "free N=$N"; break; }; done
     ```
  2. **Run `/start-parallel-session <N>`** (read that skill *now* that you know you need it). It starts the **monolith server on `3010+N` in a background shell — so it dies with this session** — plus an isolated Redis on `6379+N` (its own queue + worker running **this** worktree's branch code), while sharing Postgres / scratch-git / the gstack browser with every other session.
  3. **Carry `--scratch-url http://localhost:$((3010+N))` on every `scratchmd` call** (or drop the per-cwd `scratchmd.config.yaml` it writes) so the CLI hits **your** server, never the default `:3010` or a sibling's.

  **Net:** *worktree* ⇒ the **agent runs the server** (it dies with the session) and always passes the `--scratch-url` port; *main checkout* ⇒ the **human runs the server** and you use the default. The rest of Stage B (build/auth CLI, create workspace, pull) is identical either way — except a worktree session prefixes every `scratchmd` with its `--scratch-url`.

1. **Build + auth the CLI.** `cd scratch-git-2 && cargo build --release --bin scratchmd`; `scratchmd auth status`. **Also build the debug binary** (`cargo build --bin scratchmd`, no `--release`): the **Scratch desktop app invokes `scratch-git-2/target/debug/scratchmd`**, so if only the release binary exists the desktop "Download workspace" fails with `scratchmd binary not found … target/debug/scratchmd`. Build both.
2. **Create the workspace (ASAP).** `scratchmd workspaces create "<name>"` → returns `wkb_<id>`. Tell the developer the name/id so they can open it in the desktop app. **Use a name with NO spaces** (and ideally lower-kebab, e.g. `zoho-crm`, not `Zoho CRM`) — every choosable name that becomes a **folder-path segment** (workspace name, connection `--name`) ends up in on-disk paths, and spaces force quoting/escaping on every `cd`, `files accept "…"`, and shell glob. Same rule for the connection display name.
3. **Create the connection — from the CLI** (works for `user_provided_params` services):
   ```bash
   scratchmd connections --workspace <wkb_id> add --service <SERVICE> --param <k>=<v> [--param ...] --name "<n>"
   # Copper: --service COPPER --param apiKey=<k> --param email=<e>
   # Zoho (user_provided_params, multi-DC): --service ZOHO --param zohoClientId=<id> --param zohoClientSecret=<s> --param zohoRefreshToken=<rt> --param zohoDataCenter=<US|EU|…>
   ```
   Confirm `Health: OK`. The CLI's `--service` help only lists a few names, but it passes the string through — a connector registered on the **running** server connects even if it isn't in that hint list (and even if `visible:false`). **OAuth-redirect services can't be connected from the CLI** — use the web app's browser OAuth flow. (Get the API key from the service's settings while you're logged in.)
4. **Pull a table ASAP for desktop monitoring.** `scratchmd linked available [conn_id]` → `scratchmd linked add …` → `scratchmd linked pull <dfd_id> --mode full`. Pull at least one record-bearing table immediately so the developer sees records in the desktop app right away; pull the rest as you test them.
5. **Clone the workspace (optional, for local CLI edits).** `scratchmd workspaces init <wkb_id> -o <dir>`. (The desktop app downloads its own copy; this is for driving edits from the shell.)
6. **Enable CLI publishing** (one-time, gated by `User.settings.cliCanPublish`): Settings → Integrations, or local dev `UPDATE "User" SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb),'{cliCanPublish}','true') WHERE email='<you>';`. Without it, publish 403s.

---

## Stage C — Run the operations matrix (confirm each with the CLI + service)

**Detailed coverage is the whole point — and it comes in two passes.** Do not call a connector covered after Pass 1. Both passes are **mandatory**; the [Definition of done](#definition-of-done--strict-go-deep-not-broad-read-before-declaring-anything-built) gate is not met until Pass 2 is exhausted.
- **Pass 1 — breadth:** get every entity (static) / **every field-type the service offers** (dynamic) through the basic operations (pull, edit→push, new→push). Goal: the matrix mostly green, fast. This proves the happy path — and **only** the happy path. Finishing Pass 1 is *not* finishing the connector; do not stop, do not report success, here.
- **Pass 2 — depth (where the connector is actually finished):** go back per entity/field and dig — **every** custom-field type seeded and round-tripped (not a representative one), unusual types, boundary/empty/null values, very long strings, unicode/emoji, multi-value arrays, nested objects, status/state transitions, archival, pagination (records added mid-pull), incremental vs full pull, and foreign keys both directions ([Stage D](#stage-d--foreign-keys--associations)). Most real bugs and every [edge case](#stage-e--hunt-connector-specific-edge-cases-highest-value) live here. **If a type is awkward to seed (UI-only, flaky), that is the work — persist; it is never a reason to defer the type.**

For **each entity** (static) or **field-type** (dynamic), cover and mark the cell:

> **What a green ✅ for a *push* op (Edit→Push / New→Push / Delete→Push / FK-write) means — non-negotiable:** you **manually edited the record file on disk and pushed it through the CLI** (`files accept` → `files upload` → `files publish`), then **confirmed the result in the service**. That is the real Scratch publish path a user drives, and it's the only thing that earns the green check. **Driving the connector's create/update/delete directly (an integration spec), or calling the service API yourself, does NOT earn the ✅** — those are useful *evidence* (note them as such), but the checkbox certifies the end-to-end manual-edit → CLI-publish round-trip, nothing less.

| Operation | How / how you CONFIRM |
|-----------|-----------------------|
| **Pull** | record in service → `linked pull` → appears locally, verbatim → **validate its schema** (see below) |
| **Create→Pull** | create in the **service UI** → `linked pull` → appears locally |
| **Edit→Push** | **manually edit** local JSON → `files accept` → `files upload` → `files publish` → **confirm in the service** |
| **New→Push** | **manually create** local JSON (temp name, no read-only fields) → accept → upload → publish → service creates it; **remote id flows back into the file** |
| **Delete→Push** | **delete** local JSON → accept → upload → publish → gone in service |
| **FK** | [Stage D](#stage-d--foreign-keys--associations) |

**Validate the schema right after the first pull — before testing edits.** A connector whose pulled records don't conform to their own `schema.json` has a **broken schema** (usual cause: it over-declares `required`, or generated a type/format the verbatim API response doesn't match). Records are the source of truth — **fix the schema, never reshape the data**. Check it with the CLI's `enforce_schema` validator (read-only; no DB or server needed):

```bash
scratchmd validation dry-run --folder "<connection>/<folder>" --file <record>.json \
  --validation '[{"validator":"enforce_schema"}]'
```

An empty `[]` means the schema is sound. Any `"level":"error"` entry (e.g. `field 'address' is required but missing or null`, or a type/format mismatch) is a schema bug to fix in `<connector>-json-schema.ts` before Pass 1 continues. (`--folder` auto-loads that folder's `schema.json`; the inline `--validation` makes `enforce_schema` fire even when no `validation.json` is configured. To persist results into the problems table instead, use `scratchmd index refresh-folder --folder "<connection>/<folder>" --validate`.) Real example found this way: Copper's Companies schema declared 15 `required` fields while the verbatim API omits blank ones, so pulled records errored — the schema was over-declaring `required`.

### The publish flow is THREE steps, in order
```
scratchmd files accept <path>     # approve (writes accepted-patches.json)
scratchmd files upload            # POST accepted patches to server dirty (creates UploadPatchMeta)
scratchmd files publish           # publish-v2 plan + run → dispatch to the connector → service
```
- ⚠️ **`linked publish` alone is a footgun** — it publishes server dirty-vs-main without uploading your accepted patches; skip `files upload` and it **no-ops yet prints "completed."** Always upload first.
- ⚠️ **Confirm pushes in the SERVICE, not via a Scratch pull** — a pull replays pending accepted patches over `main` and masks failed pushes. ([API verify recipe](#verify-against-the-service-api).)

**Static discipline:** one entity at a time; record its service-UI create path in `STATE.md`. **Dynamic discipline:** one table, every field type; watch for types that don't survive (select→raw string, date tz shift, dropped relation).

**Seeding strategy — seed *every* entity so the human reviewer has visibility and entity-specific issues surface early. API-first, browser-fallback:**
- **Prefer the API** (or the connector's own create): fastest, scriptable, one token. Discover each entity's required fields from its metadata (`system_mandatory`) and fill them — this is where you catch per-entity create requirements (a Call needs `Who_Id`/`What_Id`; an inventory record needs its named line-item subform; a Note needs a parent).
- **For entities the API can't create, seed them through the gstack browser** (the API check is decisive: a create endpoint → seed via API/CLI, easy; **no create endpoint → the browser is the only way**). Two sub-cases: **(a) first-class UI-builder entities** with no create endpoint at all — built only in the service's own builders (e.g. GoHighLevel **Workflows / Campaigns / Proposals / Blog authors**) → **create one directly in the service UI**; **(b) system-generated / side-effect records** ("read-only to the API" rarely means uncreatable) → **trigger the user action that produces them** (change a stage to populate a **stage/field-history** module, send/open an email for **email-analytics**). **If the UI creation is genuinely multi-step/heavy (a full builder flow) and you're not doing it this run, leave the table empty but mark it `UNTESTED` in STATE.md with the reason** ("UI-build-only, no API create") — never let an empty table silently imply coverage. Only a pure system table no UI action can produce is truly unseedable — say so explicitly with the reason.
- **Then re-pull the *whole workspace* so every entity is present** — after seeding, `linked add` each table and `linked pull-all` (or pull each `dfd`) so **all** tables, not just the first few, are fetched. Empty tables included, so a reviewer sees the full surface. The number of linked tables (`linked list`) should equal the number of entities you seeded/exposed; if the human's **desktop app still shows a stale subset, they must re-sync/re-download the workspace** (the desktop clones the repo at open time and doesn't auto-pick-up tables linked afterward).

---

## Stage D — Foreign keys / associations

Declarative: `x-scratch-foreign-key: { linkedTableId: "<table>" }`. Test both directions:
1. **Write — the canonical test is a *CLI move from one parent to another*:** take a pulled record, edit its FK field to point at a *different* parent's remote id → `files accept` → `upload` → `publish` → confirm in the service that the record **re-parented** (moved off the old parent onto the new one). Re-parenting an existing record is a stronger test than setting a blank field — it proves both the new link lands and the old one is replaced.
2. **Read:** link in the service UI → pull → FK field holds the parent's id.
3. **Association endpoints (rare):** some services store relations on a separate endpoint (e.g. HubSpot associations); note it and confirm the connector hits that endpoint.

**Record results in a STATE.md "Foreign keys / associations" *table*** (required): one row per FK (`field → target table`) with a **Read** column and a **Write via CLI (move parent→parent)** column. A cell is only ✅ when *that* test ran — "the connector has FK code" is not coverage. See the table in [coverage-template.md](coverage-template.md).

---

## Stage E — Hunt connector-specific edge cases (highest value)

This is Pass 2's job. Document every quirk in **two** places:
1. **`STATE.md → Edge cases`** — specific to *this* connector.
2. **[`docs/connector-build.md`](/docs/connector-build.md)** — the **cross-connector playbook**. Append a short entry (service · the trick/problem · how it surfaced · what to do) so the next connector's run starts forewarned. You read this file at Step 0; grow it every run — that compounding catalog is the point.

**Auto-add vs confirm-first:**
- A **simple, concrete edge case** (a specific field/behavior on this connector) → **add it automatically** to both files.
- A **general, reusable testing *pattern*** (a new way to test connectors, not a fact about one) → **propose it and ask the user to confirm before adding** it to the playbook's "Testing patterns" section. These shape how every future run works, so they get a human check. (Example of such a pattern: connect the same service to two workbooks, change in one and push, then pull in the other to prove the write is real and round-trips.)

Known shapes to pattern-match: **Notion** page content fetched record-by-record (not bulk); **YouTube** transcripts behind a separate fetch; **Webflow** live-vs-draft status as a dedicated operation. Also probe: rich-text/HTML, computed/read-only fields (dropped on publish by design — never silently strip *user* edits), enum id vs label, attachments, pagination (records created mid-pull), incremental vs full pull, archival/soft-delete, rate limits.

---

## Building views — group by existing mechanics, never invent

A connector can ship a **default view** (`BaseJsonTableSpec.defaultView`, a `TableView` from `@spinner/shared-types`) that drives the grid: column order, labels, type hints, readonly, and — the valuable part — **grouping related columns under a banner** (`TableViewBannerGroup`). It's written to `…/<Table>/views/default.json` on pull and is **Milestone 8**. Build one once a table has enough columns that a flat list is hard to scan, or has a natural grouping. (Working examples in-repo: `airtable-default-view.ts`, `webflow-default-view.ts` — SEO / Open-Graph groups.)

**The one rule: group by structure the service ALREADY has — never invent a grouping.** A banner group must mirror a real, pre-existing concept the user recognizes (the `TableViewBannerGroup` type says it outright: "structural and not thematic; don't invent concepts that aren't already meaningful to the user"). A made-up thematic bucket ("Important fields", "Contact stuff") is worse than no group. Good groupings come straight from the service's / connector's own mechanics:
- **Custom fields** → one group (they're already a distinct set the user defined). E.g. GoHighLevel custom-object `properties` fields → a "Properties" group.
- **Plugin / add-on / app fields** → one group per plugin (a WordPress plugin's fields, a Shopify app's fields) — the plugin *is* the boundary.
- **A nested object's sub-fields** → group under the object's name (Webflow `seo.*` → "SEO", `openGraph.*` → "Open Graph").
- **Real fields vs meta fields** → group the **real/content** fields and leave the **meta/system** fields (id, timestamps, `owner`, `locationId`, internal flags) **ungrouped** beside them. Don't force meta fields into a group; they read fine flat.

If there's no real structural grouping, **don't add groups** — a clean flat view is correct. When you do build one: the view governs display (unlisted columns are hidden-but-toggleable), so list what should show, set each col's `type`/`readonly` from the schema, then **confirm in the desktop** that the banner spans the right columns before flipping Milestone 8 to ✅.

---

## OAuth — the final milestone

Run this **last**, only once everything else is green. All testing is done with an **API key** (`user_provided_params`, CLI-connectable); OAuth isn't needed to prove the connector. This is a **pre-release** step and the **only milestone human collaboration completes** — unlike the autonomous stages above, you do it *with* the user, since they own the developer account, approvals, and billing.

**Goal — either outcome completes Milestone 9:** stand up an OAuth client **with the user via the gstack browser**, **or**, if it's gated/hard, **document exactly what it would take**. Many flows need a developer account, a registered "app", specific scopes, or vendor review — record what you find either way.

1. **Research** the service's OAuth: dev account / app registration needed? scopes? review/approval? Capture the authorize + token URLs and that the redirect URI must be Scratch's callback (`REDIRECT_URI`, e.g. `https://test.scratch.md/oauth/callback`).
2. **Drive the browser + instruct the user.** `$B goto` the developer console; post a crisp, numbered set of instructions, `/read` them, and use the browser to navigate/fill where you can. **Pause at every human gate** (dev-account signup, billing, app review, captcha/2FA) with a one-line ask + `/read`, per the [autonomy contract](#when-blocked-alert-the-developer-out-loud).
3. **Capture** the client id/secret → `server/.env` (`<SERVICE>_CLIENT_ID`/`_SECRET`); record *where they live* in STATE.md, never the secret. The connector-code half (OAuthProvider + wiring) is the CONNECTOR_GUIDE **[Server — OAuth](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)** checklist — link it, don't restate.
4. **Record + flip Milestone 9** in the STATE.md OAuth section. If blocked (approval pending, paid dev account, …), write the requirements + blocker and mark it **documented (not built)** — an acceptable completion for *this* milestone only.

---

## Integration test — the automated backstop

**Required (Milestone 10).** Every connector ships a **live-API integration spec** at
`server/test/integration/<svc>-connector.spec.ts` that exercises the four capabilities —
**get schemas, pull, publish (CRUD), handle errors** — against the real service, then is wired into
the **post-deploy CI job** so it runs on every merge to master and catches connector/API drift. This
is the connector's regression net; the manual CLI round-trips prove it works *once*, the integration
test proves it *keeps* working. (DEV-10304 is the umbrella; the cross-connector status lives in the
**IT 📄 / IT ✅** columns of [`docs/connector-build.md`](/docs/connector-build.md), and each connector's
STATE.md has an **Integration tests** section.)

Build it like the references — `notion-connector.spec.ts` (read-paths + snapshot) and
`attio-connector.spec.ts` (per-object CRUD round-trips via a `buildTestValues` helper):

1. **Make it state-agnostic.** Prefer a suite that **seeds what it needs and cleans up** (create →
   round-trip → `afterAll` delete, unique `scratch-it-<ts>` naming) over one that asserts on
   pre-existing data — fixture-pinned suites rot (see Affinity / DEV-10130). Gate the whole suite on
   its credential with `describeIfKey = KEY ? describe : describe.skip` so CI stays green when unset.
2. **Verify writes independently** — read created records back through a **direct service-API call**
   (not the connector), so a wrong write can't mask itself.
3. **Use a dedicated, durable test account** — free/long-lived, never production (a connector test
   creates/updates/deletes on every run). Record it in STATE.md's Test-account + Integration-tests
   sections; put the key in 1Password and as a masked GitLab CI/CD variable.
4. **Optional but recommended — a seed script.** When the suite needs **long-lived** fixtures that
   can't be created cheaply per-run (custom fields/attributes, lists, reference/lookup records), write
   an **idempotent** `scripts/bootstrap-<svc>-test-data.ts` that provisions them on a fresh account in
   one command (re-running heals a wiped account). Reference: `scripts/bootstrap-attio-test-data.ts`.
   This is what lets a brand-new dedicated account be stood up reproducibly.
5. **Wire CI + flip the docs.** Add `<KEY>: "${INTEGRATION_TEST_<SVC>_*}"` to the post-deploy job in
   `gitlab-ci/stages/06-environment-tests.yml`, create the masked GitLab variable, then update the
   STATE.md Integration-tests section and the `docs/connector-build.md` IT columns.

---

## Recovery — when stuck, nuke and recreate the workspace

Local state (dirty branch, accepted-patches, SQLite index, partial pulls) can wedge. Don't fight it — the service and the server git are the source of truth.
```bash
scratchmd files unpublished                 # (optional) snapshot pending intent
scratchmd workspaces unsync <wkb_id>        # drop local checkout + ~/.scratchmd entry
#   if a broken worktree blocks it:  rm -rf <workspace dir>
scratchmd workspaces init <wkb_id> -o <dir> # recreate from server
scratchmd linked pull <dfd_id> --mode full  # re-pull
# connection wedged (bad creds/health):
scratchmd connections --workspace <wkb> remove <coa_id> && scratchmd connections --workspace <wkb> add --service <S> --param ...
# whole workbook: scratchmd workspaces delete <wkb_id>  (then create + reconnect)
```
Re-confirm with a pull + a service-API check before resuming. Log a reproducible wedge in `STATE.md → Gotchas`.

---

## The docs

- **`server/src/remote-service/connectors/library/<connector>/STATE.md`** — *this* connector's resumable coverage matrix + its own edge cases. One per connector. (What's been covered.)
- **`server/src/remote-service/connectors/library/<connector>/LOG.md`** — *this* connector's human-readable **activity log**: one line per operation actually performed, so a human can review exactly what was done. One per connector. (What was done, step by step — see [The activity log](#the-activity-log--logmd).)
- **`server/src/remote-service/connectors/library/<connector>/PLAN.md`** — *this* connector's **active plans**: atomic, concise plan items for substantial changes, each marked `APPROVED` or `FOR_REVIEW`, awaiting or cleared for execution. One per connector. (What we're about to change — see [The plan docs](#the-plan-docs--planmd--archivemd).)
- **`server/src/remote-service/connectors/library/<connector>/ARCHIVE.md`** — **implemented** plans, moved here out of PLAN.md once they ship so PLAN stays short. One per connector. **Write-mostly history — not read in the normal loop; open it only to revisit how a past change was made (e.g. one that later turns out problematic).** (What we already changed.)
- **[`docs/connector-build.md`](/docs/connector-build.md)** — the **cross-connector playbook**: tricks and problems seen across *all* connectors, so each new run starts forewarned. Read at Step 0, appended in Stage E. One global file. It also holds the **Connector summary table** (per-connector feature support) — **update the relevant cell whenever a connector's auth/feature support changes, and add a row for every connector you review.**

## The coverage doc — `STATE.md`

One per connector at `server/src/remote-service/connectors/library/<connector>/STATE.md`; the resumable state. Template: [coverage-template.md](coverage-template.md). It must include, in order:
1. A **do-not-delete** notice — it's generated/maintained by this skill and the connector work may need it.
2. A **TRIAL — CANCEL BY `<date>`** banner at the very top **if** the test account is on a paid trial (so nobody gets charged). Clear it when there's no trial.
3. A **Test account** section: which account/org + login was used, plan/trial, Scratch wkb/coa, and **where the API key lives** (decrypt recipe / service settings) — **never the key itself**.
4. An **Objects / entity types** overview — the supported-object contract, split into **three tables** (required for **every** connector; don't let the field-types table stand in for it). **These tables describe the best-case FUTURE state — the full set of entities we want to sync — not just what's built today; a `Status` column tracks built/planned per row.** "Not built yet" is never a reason to omit an entity or mis-file it. Enumerate the service's full object surface from its API, then sort every object into exactly one:

   **(a) Structural entities** — the hierarchy that **defines the record's path in Scratch**. For each, state its role and whether it's a **path segment** or **picker grouping** (`parentPath`). **Always write the resulting record path explicitly** — the whole product rests on file paths. This kind of spacing/workspacing/foldering **should reflect as folder-path segments** in Scratch; **identify the hierarchy and implement it as the path from the start** (via `basePath` on the table spec — `data-folder.service` builds `/{basePath…}/{table}/{record}.json`), don't ship a flat path and "go deeper later". Examples:
   - Postgres: `/{schema}/{table}/{record}.json` — schema is a path segment.
   - Airtable: `/{base}/{table}/{record}.json` — base is a path segment.
   - ClickUp: `/{Space}/{Folder}/{List}/{task}.json` — Space/Folder/List are path segments (`basePath = [space, folder]`).

   **(b) Main entities** — **record types / objects** that are (or can be) fetched as an **independent top-level entity**, each mapped to its **own Scratch table**. **Maximize this table** — list every entity we could fetch top-level even if unbuilt, with `Status: planned`. Includes a service's **custom objects** (user-defined record types, e.g. HubSpot/GHL custom objects). It does **NOT** include custom *fields* — a field is a column **on** an entity, not an entity; custom fields live in the field-types section. A structurally-different-but-top-level entity (Docs, Goals) still belongs here, just with its **own codepath** (see [Stage A](#stage-a--scaffold-the-connector-code-only-if-missing)).
      - **Users / Members** (the people/accounts in the service — the logged-in user and teammates) are a near-universal entity worth syncing — put them here. They're **sometimes** a plain top-level list, but **often a special one fetched from a different endpoint** (`GET /team/{id}/member`, `GET /users`, a `/me` + members call) rather than the generic table path — give them their **own fetch codepath** when needed, and **handle them whenever possible**. They're **usually read-only** (a reference table you sync, not something you create/edit/delete through the connector).

   **(c) Scoped / non-top-level entities** — entities that are **not directly fetchable as a top-level entity**, for either reason: **(i) scoped to another entity** and reached only through it — CRM **notes fetched per-user** (`GET /users/{id}/notes`), ClickUp **comments per task** — so they ride the parent's **deep fetch**, embedded into the parent record; or **(ii) weird in some other way** that blocks top-level treatment — e.g. only reachable via search/export with no list endpoint, requires an unsupported auth/scope, returned only as a side-effect of another call, or a shape that can't be a standalone record. Each gets a row: what blocks top-level fetch, how we'd reach it (parent deep-fetch / special path), `Status` built/planned. Still first-class data we want — never silently dropped.

   Every object lands in exactly one table; every unbuilt one carries a `Status` and a one-line plan. "Tasks work" is not coverage of "ClickUp".
5. A **Milestones** table near the top — a 10-row "where are we" tracker so anyone can see the connector's progress at a glance, each row ✅/🔄/⬜: **(1) account ready** (registered/logged into the web app) → **(2) connected** (health OK) → **(3) first fetch** (≥1 record pulled) → **(4) all entities seeded & fetched** → **(5) full write CRUD** (create+edit+delete pushed) → **(6) foreign keys tested** (CLI move parent→parent) → **(7) edge cases & quirks tested** → **(8) view(s) built** (default view with fields grouped logically — see [Building views](#building-views--group-by-existing-mechanics-never-invent)) → **(9) OAuth** (final/pre-release — create the OAuth client with the user via the browser, or document what it requires; see [OAuth — the final milestone](#oauth--the-final-milestone)) → **(10) integration test** (a live-API spec covering schemas/pull/publish/errors, wired into post-deploy CI; see [Integration test — the automated backstop](#integration-test--the-automated-backstop)).

   Directly beneath the table, a **TODOs** section: a short, living checklist of known pending tasks — gaps surfaced while [adopting human-built code](#adopting-a-human-built-connector-code-exists-no-statemd), unfinished entities/fields, deferred edge cases, and follow-up issues — checked off as they land. It complements Milestones (coarse progress) and Open issues (only broken ❌ cells with Linear links).

   **Substantial TODOs become plan items, not inline work.** Anything beyond a small fix shouldn't be acted on straight from this checklist — the substantial TODO gets a corresponding **atomic plan item in `PLAN.md`** and then **points at it by id** (`→ PLAN.md P3`) instead of restating the work, so the two docs never duplicate. Small fixes are the exception — apply them immediately, no plan entry, no approval. The full plan-doc convention (statuses `APPROVED`/`FOR_REVIEW`, the `FOR_REVIEW` approval gate, ship → `ARCHIVE.md`) lives in [The plan docs — `PLAN.md` / `ARCHIVE.md`](#the-plan-docs--planmd--archivemd).
6. The coverage matrix (entities×ops for static, field-types×ops for dynamic, both for mixed), edge cases, gotchas.
7. A **Foreign keys / associations** table — one row per FK (`field → target table`) with **Read** and **Write via CLI (move parent→parent)** columns (see [Stage D](#stage-d--foreign-keys--associations)).
8. A **Bulk operation limits / pagination** table — max records (or fields) per request, with a **row per operation (read / create / update / delete)** since services often cap them differently, plus the pagination mechanism (page/offset/cursor) and any hard ceiling that forces a bulk API. If the service has **per-entity** limits (rare), note them here *and* in that entity's row. Keep org-wide rate/quota limits (daily credits, concurrency, token throttle) separate — they're not bulk-size caps.
   - **In this same section, list the entity's *batch-breaking fields*** — fields whose edit requires its **own dedicated API call** and therefore **cannot be combined** into the main (batched) update. The tell: most fields write through one update endpoint, but this field has a **separate add/remove or sub-resource endpoint**, so a publish that touches it **splits into ≥2 calls** and can't be batched with the rest of the record's changes. This directly bounds how the connector batches a publish (an edit mixing a normal field *and* a batch-breaking field is never one call), so it belongs next to the bulk limits. Identify them by asking, per field: *"if I change only this, does it go through the normal update, or a different endpoint?"* Example: **GoHighLevel** opportunity `followers` — normal fields go via `PUT /opportunities/{id}`, but followers require `POST`/`DELETE /opportunities/{id}/followers`, so editing a follower alongside `name`/stage is two calls, not one (`gohighlevel/STATE.md`).
9. An **Incremental polling** section next to it — whether the service supports it, the driver/last-modified field, how a `since` pull is expressed (header/param/cursor) and how the new watermark is derived, and how deletions are detected (or that they aren't).
10. An **Endpoints** section — a **super-concise** reference of the API endpoints the connector actually calls: a scannable table, **one row per (entity/area × operation)** — entity, op (list/get/create/update/delete + sub-resources), method + path, and a terse note **only** where it matters (param quirk, value-key, limit cap). It's the connector's API surface at a glance. **Distil only what *this* connector calls** — do NOT paste the vendor's full reference / OpenAPI dump (that bloats the doc and mixes object endpoints with mechanics); keep it tight enough to read on one screen. (A sprawling standalone `ENDPOINTS.md` is an anti-pattern — fold it into this section.)
   - **Lead the section with an "API version & client" line — it answers "are we current?" at a glance** (this is exactly what a "review / is it up to date" task asks for). State three things, and **research the service's current offering to fill them** (don't assume the code is current just because it works): **(a) API version** — the version this connector targets (path prefix like `/v2`, or a date-based `Attio-Version: 2026-…` header) and **whether it's the latest the service offers**; if not, name the newest and what upgrading would take, and note any **required version header** the connector must send. **(b) Client/SDK** — whether the connector talks to the service via an **official SDK, a third-party SDK, or a hand-rolled HTTP client** (`createApiClient`/axios). **If it uses an SDK, list the version we pin vs the newest published** (e.g. `attio-sdk 1.2.0` vs newest `2.0.1` → ⚠️ behind) and flag if a major is behind; **if hand-rolled, say so and note whether an official/community SDK exists** that we're deliberately not using (hand-rolled axios is the house default across connectors — not using a vendor SDK is fine, but record that the choice was made, not missed). **(c) Currency verdict** — one phrase: `up to date` / `behind (detail)`. Keep it to a few lines above the endpoint table.
11. A **UI quick-links** section at the bottom — direct URLs to common service screens (login, API-key/token settings, billing/cancel-trial, each entity's list + create form) so future browser passes jump straight there instead of clicking through the UI. **Record a link the moment you discover it** (e.g. you find the clients table at `x.com/ui/clients` → add it). Reusing these is a big time-saver across runs.

Keep `Last run` current; flip `⬜`→`✅` only with confirmation. Legend: ✅ verified in service · ⬜ not yet · ➖ N/A · ❌ broken.

**Template versioning (keep STATE.md docs in sync as the template evolves).** The template carries a `Template version` (Metadata) and a `## Template changelog` at the bottom; every STATE.md records the `Template version` it was last reconciled to. Two rules:
- **Consuming the template (every run):** Step 0 compares the doc's version to the template's and reconciles forward via the changelog — see [Step 0](#step-0--resume--account-detection-always-run-first).
- **Changing the template (when you alter its *structure* — add/rename/remove a section, table column, or required rule):** bump the template's `Template version` to today's date **and** add one **very concise** line to the [Template changelog](coverage-template.md#template-changelog) saying what changed. Don't log wording/typo fixes — only structural changes a STATE.md must mirror. This is what lets any STATE.md diff itself against the template and catch up.

## The activity log — `LOG.md`

One per connector at `server/src/remote-service/connectors/library/<connector>/LOG.md`; a **plain-language, append-only journal** of every operation you actually performed, so a human can review what was done **without** re-reading the transcript or opening the code. STATE.md says *what's covered*; LOG.md says *what was done, in order*.

**Append a line the moment you perform an operation** — don't batch it at the end. Every line is one operation: a **`[hh:mm:ss]` wall-clock time**, then exactly one of five type tags, then a human description and the **literal** call/command/edit. **Date lives in the section header (`## yyyy-mm-dd — …`), time on each row** — so a reader can reconstruct the timeline and how long things took:

- **`[Service UI]`** — something you did in the service's web UI via the gstack browser (sign up, create a record, flip a status, verify a result).
- **`[Service API]`** — a direct call to the service's own API (the actual `curl …` / request), used to seed or to verify a write landed.
- **`[Scratch CLI]`** — a `scratchmd …` command (the actual command line).
- **`[Manual Edits]`** — **a change you made to a local *record* file on disk** (the JSON record you edit to drive an Edit→Push / New→Push / Delete→Push), or a local/DB state change (e.g. flipping `cliCanPublish`). Name the record file and what changed. **This tag is ONLY for record-data / local-state mutations — NOT for reading code, web research, or writing the STATE.md/LOG.md docs** (those are `[Research]`). If you didn't mutate a record file or local/DB state, it isn't a `[Manual Edits]` line.
- **`[Research]`** — investigation and documentation that isn't an operation against the service or a record file: cold-reading the connector code, reading the API docs, web research on API version / SDK currency, tracing the publish pipeline, and **authoring the STATE.md / LOG.md docs themselves**. A pure desk review (code review with no live ops) is *entirely* `[Research]` lines. Note what you looked at and the conclusion.

Group the lines under a **high-level task heading** (a short description ending in `:`), with a blank line between groups. Date in the `## yyyy-mm-dd` header; `[hh:mm:ss]` on every row (get it from `date '+%H:%M:%S'`). Format:

```
## 2026-06-08 — edit → push coverage

Testing edit → push:
[14:02:11] [Manual Edits] Changed status of task-1 to "in progress" — ClickUp/Project 1/task-1.json
[14:02:39] [Scratch CLI] Accepted + uploaded + published — scratchmd files accept "…/task-1.json" && files upload && files publish
[14:03:05] [Service API] Verified the new status landed — curl -H "Authorization: pk_…" https://api.clickup.com/api/v2/task/869dkt3e8
[14:03:20] [Service UI] Confirmed task-1 shows "in progress" in the ClickUp board
```

Rules: never write a real secret (mask tokens as `pk_…` / `***`); keep one operation per line; prefer the exact command so a human can re-run it; stamp each row with the real time it ran. **Backfill** the log if operations were already performed before this doc existed (use best-effort times for backfilled rows).

## The plan docs — `PLAN.md` / `ARCHIVE.md`

One pair per connector, in the connector folder alongside STATE.md and LOG.md. **`PLAN.md` holds the *active* plans; `ARCHIVE.md` holds the *shipped* ones.** STATE.md says what's covered, LOG.md says what was done — PLAN.md says **what we're about to change, and whether it's cleared to act on.**

**Each plan item is one atomic, self-contained unit with an explicit status** — small enough to approve, defer, or ship on its own. Give each a **stable id** (`P1`, `P2`, …) so STATE.md TODOs, LOG.md lines, and humans can refer to it (`"approve P2"`, `"P4 is the null-clear bug"`). Don't renumber on ship — leave the gap; the id stays meaningful in cross-references.

- **`**Status:** APPROVED`** — greenlit; execute freely.
- **`**Status:** FOR_REVIEW`** — needs a human's go-ahead first. **Add `FOR_REVIEW` items freely, but never execute one until a human approves it.** This is the gate for substantial / design / cross-cutting changes (a v1 write codepath, a schema reshape, a platform bug fix).

**Where items come from — and the one rule that keeps the docs from duplicating each other:** the **TODO checklist lives only in STATE.md** (beneath the Milestones table). When a TODO is **substantial** (anything beyond a small fix), it gets a corresponding **plan item in PLAN.md** — and the STATE.md TODO then **points at it by id** (`→ PLAN.md P3`) instead of restating the work. **PLAN.md must not duplicate the TODO list**; it holds the *plan bodies* (symptom, root cause, options, design trade-off) that the one-line TODOs reference. Small fixes skip the plan entirely — apply them immediately, no entry, no approval.

**On ship:** append the item to `ARCHIVE.md` (a concise "what shipped + when + pointer to STATE/LOG" entry) and **delete it from PLAN.md**, so PLAN.md stays short — just the live plans — and never balloons your context. Flip the matching STATE.md TODO/milestone to done in the same pass. **ARCHIVE.md is write-mostly history: don't read it in the normal loop**; open it only to revisit how a past change was made (e.g. one that later turns out problematic).

Authoring a substantial plan item is itself good subagent work: **define the problem in a clear, self-contained prompt and spin a subagent to draft that one item** into PLAN.md (as `FOR_REVIEW`), then carry on with other work while it does.

---

## scratchmd cheat-sheet

```bash
SM=scratch-git-2/target/release/scratchmd
$SM auth status
$SM connections --workspace <wkb> list | add --service <S> --param k=v --name "<n>" | remove <coa>
$SM workspaces create "<name>" | init <wkb> -o <dir> | unsync <wkb> | delete <wkb>
$SM linked list | available [conn] | pull <dfd> --mode full
# edit a file under <dir>/<Connection>/<Entity>/*.json, then:
$SM files accept <path> | upload | publish | unpublished | download
```

### Verify against the service API
Decrypt `ConnectorAccount.encryptedCredentials` (`{iv,salt,encrypted}`), key `ENCRYPTION_MASTER_KEY` (server/.env), AES-256-GCM, AAD `connector-account` (see `server/tools/decrypt-credentials.js`). GET the record from the service API; compare the pushed field + any `*_modified` timestamp.

---

## Browser tips

- `$B = ~/.claude/skills/gstack/browse/dist/browse`. Core: `goto`, `snapshot -i`, `click @e<n>`, `fill @e<n> "v"`, `screenshot`, `js '<expr>'`.
- **Ambiguous clicks** (a toolbar button and a menu item share a name → "matched multiple elements"): fall back to `$B js` and click the precise DOM node; JS `.click()` also bypasses overlay coverage (a survey toast over a Save button).
- Confirm a create landed by reading the record's service id from the URL (`...?context=<entity>-<id>`).

---

## Gotchas (battle-tested)

- `linked publish` no-ops without a prior `files upload`, still prints "completed."
- A Scratch pull replays pending accepted patches over `main` — it masks failed/empty pushes. Confirm in the service.
- `files publish` is 403'd unless `User.settings.cliCanPublish = true`.
- Filenames may be a name-slug (Copper) or the remote id (Airtable/Webflow); the remote id is always **inside** the file. New records get their id **after** publish.
- Read-only fields (`x-scratch-readonly`: ids, `date_created/modified`, computed) are dropped on publish — leave them out of new records.
- OAuth connectors can't be connected from the CLI — use the web app's browser OAuth flow.
