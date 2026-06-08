---
name: connector-build
description: The autonomous, from-zero process for building AND finishing a Scratch connector — drive the external service in a gstack browser on one side, the scratchmd CLI on the other, confirming EVERY operation with the CLI and the service's own API. `/connector-build <name>` can start from nothing: scaffold the connector code, provision a test account on the service, connect, pull, and exercise every operation — pausing ONLY for human-required gates (service login, credit-card/billing for a trial, captcha/2FA, email verification). Resumable at any stage via a per-connector TESTING.md coverage doc. Per entity for static-schema services, per field-type for dynamic-schema services; hunts connector-specific edge cases and tracks covered/uncovered operations.
user-invocable: true
---

# connector-build

A **process** that takes a connector from **zero → finished**, self-driving as far as it can. Two sides:

- **Service side** — a **gstack browser** on the real service (sign up, log in, create records, watch results).
- **Scratch side** — the **`scratchmd` CLI** (scaffold, connect, pull, edit, push, confirm).

Connector *code patterns* are owned by **[CONNECTOR_GUIDE.md](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)**; this skill orchestrates the whole journey around them and proves the result live.

**Source of truth = the coverage doc** `server/src/remote-service/connectors/library/<connector>/TESTING.md`. Resumable: read it, continue from the first uncovered cell. A connector may be at 0%, 1%, or 95%. (In flight: **copper** ~most complete, **gohighlevel** partial, **zoho** no code yet.)

**Prime directive: trust nothing you didn't confirm with the CLI or the service API.** A green "completed" is not proof; a Scratch pull is not proof of a push.

**Lean on the CLI; reach for the browser only where it's the only option.** The CLI is local and far faster than clicking through a web UI — do reads, edits, creates, deletes, FK wiring, and verification with `scratchmd` whenever you can. The browser earns its cost in two spots: **(1) seeding data through the service UI** at the start (creating records to pull, when there's nothing to pull yet), and **(2) confirming a change actually landed in the UI** the way a user would see it. Default to CLI; use the browser deliberately.

---

## Entry points & the autonomy contract

- `/connector-build <name>` — start from **nothing**: create the connector folder + boilerplate, provision/select a test account, create the connection, pull, and run the test matrix.
- `/connector-build <name> [account: <id|creds|"use the open browser session">]` — same, but use a provided/known account instead of creating one.
- `/connector-build <name> resume` — read `TESTING.md` and continue.

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

### End every run out loud (`/read`)
**Always finish a run by invoking the `/read` skill (if it exists)** — whether you finished cleanly, paused at a gate, or hit a wall. Post a short summary first (what got covered, what's blocked/next), then call `/read` so it's read aloud. The developer may be running several connectors in parallel and away from the screen; the voice cue tells them this one wants attention.

## Prerequisite — browser preflight (HARD GATE, before any testing)

Do this **before** pulling/pushing anything. The browser is not optional: create-in-service and UI-link discovery require it, so a CLI-only run does **not** finish a connector.
1. Launch/verify the gstack browser: `$B connect` then `$B status` → must show `Mode: headed`.
2. `$B goto` the service and `snapshot` — confirm you are **logged in** (authenticated UI, not a login wall).

**If the browser won't start, the service won't load, or you're not logged in and can't get logged in** (and the user isn't available to log in), **STOP and exit early**: post a one-line warning naming exactly what failed (e.g. "Browser preflight failed: gstack headed mode won't start" / "Not logged into Acme — need a login"), `/read` it, and do not proceed with a partial CLI-only pass. Resume once the gate clears.

---

## Step 0 — Resume & account detection (ALWAYS run first)

**First, load the cross-connector playbook:** read [`docs/connector-build.md`](/docs/connector-build.md) — the accumulated catalog of tricks and problems seen on prior connectors — so you start already knowing what to watch for. You'll append to it in Stage E.

1. **Pick the connector** + folder `server/src/remote-service/connectors/library/<connector>/`; service constant in `service-constants.ts`.
2. **Read `TESTING.md`.** Exists → it is the state (resume at first `⬜`); also re-read the **Test account** section so you reuse the same account. Missing → create it from [coverage-template.md](coverage-template.md) once you've classified + picked an account.
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
- Implement the abstract members (`testConnection`, `listTables`, `fetchJsonTableSpec`, `pullRecordFiles`, and the write methods), storing **raw API responses verbatim** and preferring **dynamic schema discovery**.
- Get `yarn build` + smoke tests green before live-testing.

Do this autonomously; only stop if a real API decision needs the user.

## Stage A0 — Provision the test account

Reached only when Step 0 found no usable account.

1. In the gstack browser, go to the service's **sign-up** page and fill the signup form autonomously (name, work email, company). Prefer the user's email/org if known.
2. **PAUSE** at the first human gate — email/phone verification, captcha, credit-card for a trial, or SSO login — with a one-line ask. Resume after.
3. Once in, capture: account/org id, login email, plan + **trial end date**, and where API credentials are generated.
4. **Record it in the coverage doc immediately** — the **Test account** section (no API key, just where to find it) and, if it's a paid trial, the **TRIAL — CANCEL BY <date>** banner at the very top. This is how nobody gets surprise-charged.

---

## Stage B — Stand up the harness (CLI)

1. **Build + auth the CLI.** `cd scratch-git-2 && cargo build --release --bin scratchmd`; `scratchmd auth status`.
2. **Create the connection — from the CLI** (works for `user_provided_params` services):
   ```bash
   scratchmd connections --workspace <wkb_id> add --service <SERVICE> --param <k>=<v> [--param ...] --name "<n>"
   # Copper: --service COPPER --param apiKey=<k> --param email=<e>
   ```
   Confirm `Health: OK`. **OAuth services can't be connected from the CLI** — use the web app's browser OAuth flow. (Get the API key from the service's settings while you're logged in.)
3. **Clone the workspace.** `scratchmd workspaces init <wkb_id> -o <dir>`.
4. **First fetch.** `scratchmd linked list`, then `scratchmd linked pull <dfd_id> --mode full` per table. Confirm records land verbatim.
5. **Enable CLI publishing** (one-time, gated by `User.settings.cliCanPublish`): Settings → Integrations, or local dev `UPDATE "User" SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb),'{cliCanPublish}','true') WHERE email='<you>';`. Without it, publish 403s.

---

## Stage C — Run the operations matrix (confirm each with the CLI + service)

**Detailed coverage is the whole point — and it comes in two passes.** Do not call a connector covered after Pass 1.
- **Pass 1 — breadth:** get every entity (static) / field-type (dynamic) through the basic operations (pull, edit→push, new→push). Goal: the matrix mostly green, fast. This proves the happy path.
- **Pass 2 — depth:** go back per entity/field and dig — unusual field types, boundary/empty/null values, very long strings, special characters, multi-value arrays, nested objects, status/state transitions, archival, pagination (records added mid-pull), incremental vs full pull. Most real bugs and every [edge case](#stage-e--hunt-connector-specific-edge-cases-highest-value) live here. Pass 2 is where the connector is actually finished.

For **each entity** (static) or **field-type** (dynamic), cover and mark the cell:

| Operation | How / how you CONFIRM |
|-----------|-----------------------|
| **Pull** | record in service → `linked pull` → appears locally, verbatim |
| **Create→Pull** | create in the **service UI** → `linked pull` → appears locally |
| **Edit→Push** | edit local JSON → `files accept` → `files upload` → `files publish` → **confirm in the service API** |
| **New→Push** | new local JSON (temp name, no read-only fields) → accept → upload → publish → service creates it; **remote id flows back into the file** |
| **Delete→Push** | delete local JSON → accept → upload → publish → gone in service |
| **FK** | [Stage D](#stage-d--foreign-keys--associations) |

### The publish flow is THREE steps, in order
```
scratchmd files accept <path>     # approve (writes accepted-patches.json)
scratchmd files upload            # POST accepted patches to server dirty (creates UploadPatchMeta)
scratchmd files publish           # publish-v2 plan + run → dispatch to the connector → service
```
- ⚠️ **`linked publish` alone is a footgun** — it publishes server dirty-vs-main without uploading your accepted patches; skip `files upload` and it **no-ops yet prints "completed."** Always upload first.
- ⚠️ **Confirm pushes in the SERVICE, not via a Scratch pull** — a pull replays pending accepted patches over `main` and masks failed pushes. ([API verify recipe](#verify-against-the-service-api).)

**Static discipline:** one entity at a time; record its service-UI create path in `TESTING.md`. **Dynamic discipline:** one table, every field type; watch for types that don't survive (select→raw string, date tz shift, dropped relation).

---

## Stage D — Foreign keys / associations

Declarative: `x-scratch-foreign-key: { linkedTableId: "<table>" }`. Test both directions:
1. **Write:** set the FK field on A to B's remote id → accept/upload/publish → confirm A→B in the service.
2. **Read:** link in the service UI → pull → FK field holds B's id.
3. **Association endpoints (rare):** some services store relations on a separate endpoint (e.g. HubSpot associations); note it and confirm the connector hits that endpoint.

---

## Stage E — Hunt connector-specific edge cases (highest value)

This is Pass 2's job. Document every quirk in **two** places:
1. **`TESTING.md → Edge cases`** — specific to *this* connector.
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
Re-confirm with a pull + a service-API check before resuming. Log a reproducible wedge in `TESTING.md → Gotchas`.

---

## Two docs, two scopes

- **`server/src/remote-service/connectors/library/<connector>/TESTING.md`** — *this* connector's resumable coverage + its own edge cases. One per connector.
- **[`docs/connector-build.md`](/docs/connector-build.md)** — the **cross-connector playbook**: tricks and problems seen across *all* connectors, so each new run starts forewarned. Read at Step 0, appended in Stage E. One global file.

## The coverage doc — `TESTING.md`

One per connector at `server/src/remote-service/connectors/library/<connector>/TESTING.md`; the resumable state. Template: [coverage-template.md](coverage-template.md). It must include, in order:
1. A **do-not-delete** notice — it's generated/maintained by this skill and the connector work may need it.
2. A **TRIAL — CANCEL BY `<date>`** banner at the very top **if** the test account is on a paid trial (so nobody gets charged). Clear it when there's no trial.
3. A **Test account** section: which account/org + login was used, plan/trial, Scratch wkb/coa, and **where the API key lives** (decrypt recipe / service settings) — **never the key itself**.
4. The coverage matrix (entities×ops for static, field-types×ops for dynamic, both for mixed), edge cases, gotchas.
5. A **UI quick-links** section at the bottom — direct URLs to common service screens (login, API-key/token settings, billing/cancel-trial, each entity's list + create form) so future browser passes jump straight there instead of clicking through the UI. **Record a link the moment you discover it** (e.g. you find the clients table at `x.com/ui/clients` → add it). Reusing these is a big time-saver across runs.

Keep `Last run` current; flip `⬜`→`✅` only with confirmation. Legend: ✅ verified in service · ⬜ not yet · ➖ N/A · ❌ broken.

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
