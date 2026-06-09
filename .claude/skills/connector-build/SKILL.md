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
1. Launch/verify the gstack browser: `$B connect` then `$B status` → must show `Mode: headed`.
2. `$B goto` the service and `snapshot` — confirm you are **logged in** (authenticated UI, not a login wall).

**If the browser won't start, the service won't load, or you're not logged in and can't get logged in** (and the user isn't available to log in), **STOP and exit early**: post a one-line warning naming exactly what failed (e.g. "Browser preflight failed: gstack headed mode won't start" / "Not logged into Acme — need a login"), `/read` it, and do not proceed with a partial CLI-only pass. Resume once the gate clears.

---

## Step 0 — Resume & account detection (ALWAYS run first)

**First, load the cross-connector playbook:** read [`docs/connector-build.md`](/docs/connector-build.md) — the accumulated catalog of tricks and problems seen on prior connectors — so you start already knowing what to watch for. You'll append to it in Stage E.

1. **Pick the connector** + folder `server/src/remote-service/connectors/library/<connector>/`; service constant in `service-constants.ts`.
2. **Read `STATE.md`.** Exists → it is the state (resume at first `⬜`); also re-read the **Test account** section so you reuse the same account. Missing → create it from [coverage-template.md](coverage-template.md) once you've classified + picked an account.
3. **Probe each layer with a command, not an assumption:** code exists? (`ls` + registered in `library/index.ts`) · connection exists? (`scratchmd connections --workspace <wkb> list`) · workspace cloned? (`~/.scratchmd/workspaces.yaml`) · browser up + which service is it logged into? (`$B status`, snapshot).
4. **Select the test account — precedence order (do NOT create a new one if an earlier option matches):**
   - **(a) User-provided account / credentials** → use exactly that.
   - **(b) The gstack browser is already authenticated for this service** → **assume that logged-in account IS the test account** and use it. (Don't sign up again.)
   - **(c) The coverage doc names an account** → reuse it.
   - **(d) None of the above** → **provision a new account** ([Stage A0](#stage-a0--provision-the-test-account)).
5. Announce detected position + chosen account in one line, then continue from the earliest gap.

---

## Step 1 — Classify the connector (decides what you iterate over)

Read `listTables()`: hardcoded entity list ⇒ **static**; tables discovered from the service ⇒ **dynamic**. Many are **mixed**.

- **Static / opinionated** (CRMs, Stripe, YouTube, WordPress): fixed entities, one endpoint each → **test object-by-object**; record *where each entity is created in the service UI* (screen, form, required fields).
- **Dynamic / open** (Postgres, Supabase, Airtable, Notion): user-defined objects, one endpoint pattern → **test field-types**; build one table with every type and round-trip each.
- **Mixed** (HubSpot, Copper, Pipedrive, Attio): standard entities **plus** custom objects/fields → do both. Mark `Type: STATIC · custom fields supported (mixed)`.

---

## Stage A — Scaffold the connector code (only if missing)

If there is no `<connector>/` folder, create the boilerplate yourself, mirroring an existing connector (e.g. `copper/`) and following **[CONNECTOR_GUIDE.md](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)** for the method bodies:

- `<connector>-types.ts`, `<connector>-api-client.ts`, `<connector>-json-schema.ts`, `<connector>-connector.ts`, `__tests__/`.
- Add the service constant (`service-constants.ts`) and register the factory (`library/index.ts`).
- **Give the connector a logo** (`metadata.logo`) — and **actually upload the asset, then verify the URL returns 200.** New connectors render with **no icon** until you set it. Find an **SVG** of the service's mark on a **white or transparent background** (simpleicons.org, the brand press kit). If the brand has multiple variants, pick the **simplest** one — the **icon/symbol, not the full wordmark** — because it's shown as a **tiny icon** where detail and text are lost; a clean single-color symbol (set `fill` to the brand color) reads best. **The #1 mistake (causes a broken-image icon): setting `metadata.logo` to `https://static.scratch.md/connector-icons/<service>.svg` but never uploading the file** — so the URL 404s. Always: `gcloud storage cp <svg> gs://spv1eu-production-static/connector-icons/<service>.svg --content-type="image/svg+xml"`, then `curl -I https://static.scratch.md/connector-icons/<service>.svg` and confirm **200** before considering the logo done (see CONNECTOR_GUIDE.md → Connector Logo).
- Implement the abstract members (`testConnection`, `listTables`, `fetchJsonTableSpec`, `pullRecordFiles`, and the write methods), storing **raw API responses verbatim** and preferring **dynamic schema discovery**.
- **Build the folder-path hierarchy from the start** (see [Path structure](#path-structure-the-hierarchy-is-the-path) below) — `basePath` on the table spec, not a flat path. Retrofitting paths later churns every record's location.
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
| **Pull** | record in service → `linked pull` → appears locally, verbatim |
| **Create→Pull** | create in the **service UI** → `linked pull` → appears locally |
| **Edit→Push** | **manually edit** local JSON → `files accept` → `files upload` → `files publish` → **confirm in the service** |
| **New→Push** | **manually create** local JSON (temp name, no read-only fields) → accept → upload → publish → service creates it; **remote id flows back into the file** |
| **Delete→Push** | **delete** local JSON → accept → upload → publish → gone in service |
| **FK** | [Stage D](#stage-d--foreign-keys--associations) |

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
- **For entities the API can't create — "read-only" / system-generated ones — seed via the gstack browser by *triggering the event that produces them*.** "Read-only to the API" rarely means "uncreatable" — it means the records are a side-effect of a user action. Do that action in the UI: change a record's stage to populate a **stage/field-history** module, send/open an email to populate **email-analytics** modules, etc. Only when no user action can produce them (pure system tables) is an entity genuinely unseedable — say so explicitly with the reason.
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

## Three docs, three scopes

- **`server/src/remote-service/connectors/library/<connector>/STATE.md`** — *this* connector's resumable coverage matrix + its own edge cases. One per connector. (What's been covered.)
- **`server/src/remote-service/connectors/library/<connector>/LOG.md`** — *this* connector's human-readable **activity log**: one line per operation actually performed, so a human can review exactly what was done. One per connector. (What was done, step by step — see [The activity log](#the-activity-log--logmd).)
- **[`docs/connector-build.md`](/docs/connector-build.md)** — the **cross-connector playbook**: tricks and problems seen across *all* connectors, so each new run starts forewarned. Read at Step 0, appended in Stage E. One global file.

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
5. A **Milestones** table near the top — a 7-row "where are we" tracker so anyone can see the connector's progress at a glance, each row ✅/🔄/⬜: **(1) account ready** (registered/logged into the web app) → **(2) connected** (health OK) → **(3) first fetch** (≥1 record pulled) → **(4) all entities seeded & fetched** → **(5) full write CRUD** (create+edit+delete pushed) → **(6) foreign keys tested** (CLI move parent→parent) → **(7) edge cases & quirks tested**.
6. The coverage matrix (entities×ops for static, field-types×ops for dynamic, both for mixed), edge cases, gotchas.
7. A **Foreign keys / associations** table — one row per FK (`field → target table`) with **Read** and **Write via CLI (move parent→parent)** columns (see [Stage D](#stage-d--foreign-keys--associations)).
8. A **Bulk operation limits / pagination** table — max records (or fields) per request, with a **row per operation (read / create / update / delete)** since services often cap them differently, plus the pagination mechanism (page/offset/cursor) and any hard ceiling that forces a bulk API. If the service has **per-entity** limits (rare), note them here *and* in that entity's row. Keep org-wide rate/quota limits (daily credits, concurrency, token throttle) separate — they're not bulk-size caps.
9. An **Incremental polling** section next to it — whether the service supports it, the driver/last-modified field, how a `since` pull is expressed (header/param/cursor) and how the new watermark is derived, and how deletions are detected (or that they aren't).
10. A **UI quick-links** section at the bottom — direct URLs to common service screens (login, API-key/token settings, billing/cancel-trial, each entity's list + create form) so future browser passes jump straight there instead of clicking through the UI. **Record a link the moment you discover it** (e.g. you find the clients table at `x.com/ui/clients` → add it). Reusing these is a big time-saver across runs.

Keep `Last run` current; flip `⬜`→`✅` only with confirmation. Legend: ✅ verified in service · ⬜ not yet · ➖ N/A · ❌ broken.

## The activity log — `LOG.md`

One per connector at `server/src/remote-service/connectors/library/<connector>/LOG.md`; a **plain-language, append-only journal** of every operation you actually performed, so a human can review what was done **without** re-reading the transcript or opening the code. STATE.md says *what's covered*; LOG.md says *what was done, in order*.

**Append a line the moment you perform an operation** — don't batch it at the end. Every line is one operation: a **`[hh:mm:ss]` wall-clock time**, then exactly one of four type tags, then a human description and the **literal** call/command/edit. **Date lives in the section header (`## yyyy-mm-dd — …`), time on each row** — so a reader can reconstruct the timeline and how long things took:

- **`[Service UI]`** — something you did in the service's web UI via the gstack browser (sign up, create a record, flip a status, verify a result).
- **`[Service API]`** — a direct call to the service's own API (the actual `curl …` / request), used to seed or to verify a write landed.
- **`[Scratch CLI]`** — a `scratchmd …` command (the actual command line).
- **`[Manual Edits]`** — edits you made to local record files on disk, or local/DB state changes (which file, what changed).

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
