---
name: qa-desktop-app
description: Drive the real Scratch Desktop Electron app like a human QA tester against the deployed test backend (test-api.scratch.md), and report what's broken, slow, or odd. Takes a plain-language description of what to test (e.g. "check that editing a Pipedrive deal title and publishing works", "smoke-test the download flow and see if the Affinity grid renders right", "just poke around and tell me what looks off") — with no argument it does a broad dogfood pass. Builds the app + CLI, launches it with a seeded real session via Playwright `_electron`, stubs ONLY the native folder picker, and exercises whatever the description calls for — auth, downloading a workspace, browsing the data grids, editing a field, reviewing, publishing — capturing screenshots, timings, console/HTTP errors, and a findings log. It can reuse or create a workspace and connect API-key connectors (Airtable/Pipedrive/Webflow) from server/.env.integration to stand up real data to pull/edit/publish (OAuth connectors need a browser and are out of scope). Downloads/edits touch local files and publishing hits the real test external services. Use when asked to QA / smoke-test / dogfood the desktop app, or to test a specific desktop behavior end-to-end against a live backend. NOT for the web client (`/client`) — that's `/qa`.
user-invocable: true
argument-hint: "[what to test, in plain words]"
---

# QA the Scratch Desktop app against the live test backend

Drive the **built** Electron app (`scratch-desktop/`) with Playwright's first-class
[`_electron`](https://playwright.dev/docs/api/class-electron) support, seeded with a **real** session
for the dedicated test account, and exercise it like a human tester. Everything except the native OS
folder dialog is real: real `scratchmd` CLI/napi, real `test-api.scratch.md`, real publish to the test
external services. The deliverable is a **findings report** (slow / odd / incorrect things) with
screenshots and timings — not code changes.

This skill bundles a hardened reference driver, [`qa-driver.mjs`](qa-driver.mjs), that already encodes
every gotcha below. Prefer extending it over writing a harness from scratch.

## Step 0 — read what to test

The argument is a **plain-language description of what to exercise**. Read it and shape the run around
it: which folders to open, which operations to drive, and how deep to go. Examples:

- *"check that editing a Pipedrive deal title and publishing it works"* → download → open
  `Pipedrive/Deals` → edit a title → accept → drive the **Publish modal** → verify the round-trip.
- *"smoke-test the download flow and see if the Affinity grid renders correctly"* → download → open
  the Affinity folders → read the grids → judge the rendered screenshots. No edits, no publish.
- *"the new publish button on the record detail view"* → get to that view, exercise just that control,
  watch the network + console while you do.
- **No argument** → a broad dogfood pass: open a spread of folders, light editing, no publish.

Use judgement about **how far to go**, because some actions have real side effects:

- **downloading / editing / accepting** mutate **local files** on disk (reversible via the app's
  discard/reject ladder).
- **publishing** ships to the **real test external services**.

If the description doesn't clearly call for publishing, **don't publish** — say so, or ask first.

## Always start with the live canary

Whatever the description, run this first:

```bash
cd scratch-desktop && yarn test:e2e:live
```

It's read-only (seam → real token → live auth → loads the workspace list → stops at the first-run
screen). If it's **green**, auth, the build, and the token are all healthy — so any later "it dropped to
the Login screen" is almost certainly a bug in **your harness**, not the app (see gotcha #1).

### ⚠️ A RED canary is usually a benign false-negative — confirm before you trust it

The canary frequently fails **without anything being wrong**. `live.spec.ts` asserts that an account
**with** remote workspaces lands on the first-run **"Download a workspace"** welcome screen
(`expect(getByText('Download a workspace')).toBeVisible()`), and that assertion assumes a **clean
first-run state with nothing downloaded locally**. But the `scratchmd` CLI workspace registry
(`~/.scratchmd/workspaces.yaml`) is **global and shared across the whole machine** and is **NOT**
isolated by the test's throwaway Electron profile (gotcha #4). So the moment **any** workspace is already
downloaded on this machine — typically one a **prior QA run left behind** (shows as "On my Mac · N" on
the home screen) — the app correctly renders the **HomePage "Your Workspaces" list** instead of the
welcome screen, and the test fails like this:

```
expect(locator).toBeVisible() failed
Locator: getByText('Download a workspace')   ← app showed the workspace LIST, not the first-run screen
```

This is **not** an auth/build/token failure — the test already proved the token valid (it asserts
`/workbook → 200` before launching and the "Log in" button is hidden). Confirm the false-negative in
~10 s, then **proceed with the QA run**:

- `curl -s -o /dev/null -w '%{http_code}' "$URL/users/current" -H "Authorization: API-Token $T"` → **200**.
- Open the failure's page snapshot at `scratch-desktop/test-results/live-*/error-context.md`. If it shows
  **"Your Workspaces"** with workspace cards → auth/build/token are healthy; the red is just the
  hermeticity gap above. Only a **Login** screen there is a real auth problem (then suspect gotcha #1's
  quote-wrapped token).

In short: **green = definitely healthy; red ≠ broken — check `/users/current` and the error-context
snapshot first.** A truly clean machine (nothing in `~/.scratchmd/workspaces.yaml`) would pass, but in
practice prior runs leave downloads behind, so expect red and verify rather than trust the exit code.

## Get real data to test (reuse or create a workspace + connect a connector)

Feel free to **reuse or create a workspace** — don't be limited to whatever's there. The dedicated test
account's default workspace is often **empty**, and other populated workspaces on the machine belong to
other accounts (permission-gated). So **stand up your own data**: create (or reuse) a workspace, connect
an **API-key (non-OAuth) connector**, and pull. OAuth needs a browser — out of scope; API-key connectors
are a one-liner.

API keys live in **`server/.env.integration`**. Cleanly connectable (key present **and** in the CLI's
`connections add --service` enum): **Airtable** (`AIRTABLE_API_KEY`), **Pipedrive** (`PIPEDRIVE_API_KEY`),
**Webflow** (`WEBFLOW_API_KEY`). Other keys exist (Affinity, Attio, Brevo, Intercom, Stripe) but may not
be in the CLI service enum — check `scratchmd connections add --service` before relying on them.

Bootstrap with the bundled helper — idempotent (reuses the workspace by name + connection by service;
re-running won't duplicate folders):

```bash
.claude/skills/qa-desktop-app/setup-connection.sh AIRTABLE  AIRTABLE_API_KEY
.claude/skills/qa-desktop-app/setup-connection.sh PIPEDRIVE PIPEDRIVE_API_KEY "QA Pipedrive"
.claude/skills/qa-desktop-app/setup-connection.sh WEBFLOW   WEBFLOW_API_KEY   "QA Webflow"
# It prints the workbook id; then drive the app against it (QA_AUTH_CLI=1 — see gotcha #13):
QA_AUTH_CLI=1 QA_WORKBOOK_ID=<wkb> node .claude/skills/qa-desktop-app/qa-driver.mjs
```

It creates the workspace + connection **server-side** on the test account and pulls real records; the
desktop app then downloads it. **Verified end-to-end**: a 12-record Airtable "Tasks" workspace downloads,
edits, and **publishes back to live Airtable** through the real Publish modal.

Under the hood (all `scratchmd` against test-api, in an isolated CLI HOME so it never touches your
`~/.scratchmd`): `auth set-credentials` → reuse-or-`workspaces create` →
`connections add --service <SVC> --param apiKey=<key>` → `linked available` →
`linked add --table-id …` (composite ids split per gotcha #15) → `linked pull-all`.

## ⚠️ Gotchas — read before you start (this is the whole point of this skill)

| # | Gotcha | What happens if you miss it | Do this |
| - | ------ | --------------------------- | ------- |
| 1 | **`scratch-desktop/.env.e2e` values are single-quoted** (`TESTING_ACCOUNT_API_KEY='-VOK…'`). | A naive `KEY=value` parser keeps the quotes → you seed `Authorization: API-Token '…'` → server **401** → the global 401 handler clears creds → **app bounces to the Login screen**. You'll waste an hour "debugging a forced-logout bug" that is yours, not the app's. | **Strip surrounding quotes** when parsing (or use a real dotenv lib / shell `set -a; . ./.env.e2e`). `playwright.config.ts` auto-loads `.env.e2e` correctly for `live.spec`, so the canary is unaffected. |
| 2 | **A single 401 from ANY authenticated request logs the user out** (`AuthProvider` → `scratch-api-client` `onUnauthorized` clears creds and bounces to Login). | You see the Login screen and assume the seam failed, when really one request was rejected. | When you unexpectedly see Login, **suspect the token first** (gotcha #1). Confirm with `curl -s -o /dev/null -w '%{http_code}' $URL/users/current -H "Authorization: API-Token $T"` → must be `200`. |
| 3 | **Only stub the native folder picker — do NOT mock the CLI or the API.** | Mocking the CLI/API defeats the purpose of a live test (you'd be testing mocks). | In the main process: `await app.evaluate(({dialog}, f) => { dialog.showOpenDialog = async () => ({canceled:false, filePaths:[f]}) }, parentFolder)`. Leave everything else real. |
| 4 | **The `scratchmd` CLI workspace registry is GLOBAL/shared** across app instances and accounts on the machine — it is **not** isolated by `SCRATCH_DESKTOP_USER_DATA_DIR`. `getWorkspacesRegistry()` will list other accounts' on-disk workspaces (e.g. your real `~/Scratch/Monorepo`). | You grab `reg[0]` and silently QA a **different account's** workspace. | Select the registry entry by the **target workbook id** (from `GET /workbook`), never `reg[0]`. |
| 5 | **The test account's own workspace may be empty**, and populated workspaces on the machine belong to **other** accounts (server-permission-gated: `User does not have permission to access workbook …`). | You land on the first-run "Download a workspace" screen with nothing to render, or the driver falls back to another account's on-disk workspace. | **Stand up your own data** — create a workspace + connect an API-key connector: see [Get real data to test](#get-real-data-to-test-reuse-or-create-a-workspace--connect-a-connector). |
| 6 | **The renderer's API base URL is a build-time Vite constant.** A default `yarn build` bakes in `localhost:3010`. | The renderer can't reach the backend (or hits the wrong one). | Build with the test API baked in: `VITE_SCRATCH_API_URL=https://test-api.scratch.md VITE_SCRATCH_WEB_URL=https://test.scratch.md yarn build`. (`yarn test:e2e:live` does this for you.) |
| 7 | **The native addon must be built AND staged into `out/`.** `yarn build` did not copy `scratchmd-native.*.node` into `out/scratch-git-2/napi/` in testing. | Any napi-backed op (e.g. editing a cell, `files:accept-cell-input-text`) throws `scratchmd-native addon not found`. | `cd scratch-desktop && node scripts/build-native.cjs && mkdir -p out/scratch-git-2/napi && cp ../scratch-git-2/napi/scratchmd-native.*.node out/scratch-git-2/napi/`. (Flag this in your report — it may be a real build-wiring gap.) |
| 8 | **The data grid is a `<canvas>`** (`glide-data-grid`). | DOM text assertions on cells always fail — there are no cell nodes. | Read grid data via `page.evaluate` → `window.scratchFiles.readDiffGridData(folderPath, workspacePath, {offset,limit})` (rows carry `__rowStatus`, `__changedFields`, `__unpublishedFields`, `__filename`). |
| 9 | **Never use fixed `sleep()`-then-screenshot, and never `locator.textContent()` on a maybe-absent selector** — the latter blocks for the **default 30 s timeout** and will make "boot" look like it took 32 s. | Mistimed screenshots (loading spinners) and bogus "slowness" findings. | Poll for a settled state (login / home / workspace via `location.hash`) with short timeouts before screenshotting. |
| 10 | **A grid cell edit auto-approves.** `acceptFieldEditFromInputText` (`files:accept-cell-input-text`, what the cell editor calls) writes straight to the **approved/"unpublished"** bucket — it does **not** appear in `__changedFields` (the unreviewed bucket). | You "find a bug" that an edit didn't show as unreviewed. It's by design. | Assert against `__unpublishedFields` / `__rowStatus`, not `__changedFields`, for a cell edit. |
| 11 | **Publish is asynchronous.** `uploadWorkspaceChanges` returns quickly, but the actual publish to the external service is a **server plan/run job**; the local `__unpublishedFields` flag clears only after **reconcile / re-pull**. | You "find a bug" that the field is still unpublished right after publishing. | Don't assert instant completion. Drive the real **Publish modal** (it polls the job + reconciles), or wait for the job and call the reconcile IPC, before re-reading. |
| 12 | **`getWorkspacesRegistry().fileCount` can read 0 even for populated workspaces** (it's derived/lazy). | You skip a workspace that actually has data, or your download poll never "completes." | Resolve/judge by workbook **id** + `window.scratchFiles.listFolders(workspacePath)` (per-folder count from disk), not the registry `fileCount`. |
| 13 | **The test seam authenticates the renderer but NOT the scratchmd CLI**, and the app reads CLI creds from the real `~/.scratchmd` (macOS Electron ignores `$HOME`, so you can't isolate it). | Cloning a **new** workspace (download) and **publish/upload** fail `Not authenticated. Run scratchmd auth login`, and the run silently falls back to whatever's already on disk (often another account's). | Run the driver with **`QA_AUTH_CLI=1`** — it logs `~/.scratchmd` into the test account so CLI server-ops work. ⚠️ this **replaces your CLI login token**; restore it afterward with `scratchmd auth login`. Browse/edit (local IPCs) work without it; download-new + publish need it. |
| 14 | **CLI flag values that start with `-`** — the e2e token does (`-VOK…`). | clap parses the value as a flag (`-V`) → `unexpected argument '-V' found`. | Use the **`--flag=value`** form: `--apiToken="$TOKEN"`. (`--param apiKey=$KEY` is already safe because the `=` is inside the value.) |
| 15 | **`linked available` returns composite table ids** — Airtable `baseId,tableId`, Webflow `siteId,collectionId`. | Passing the comma-joined id to a single `--table-id` fails. | Split on comma into **repeated `--table-id`** args. (`setup-connection.sh` does this.) |

## The test-credential seam (how login is bypassed)

The desktop normally logs in via interactive device-code OAuth (system browser), which a headless test
can't drive. Set these env vars on `electron.launch` — **honored only in unpackaged/dev builds** (i.e.
launching `out/main/index.js` directly, which is exactly what `_electron` does):

| Env var | Purpose |
| ------- | ------- |
| `SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON` | `{apiToken, email, tokenExpiresAt:'2099-01-01T00:00:00Z', serverUrl:'https://test-api.scratch.md'}` — seeds the auth store so the renderer skips `LoginPage`, and syncs the CLI's creds. **`serverUrl` must match the build's `VITE_SCRATCH_API_URL` host** (https, not http — test-api 301-redirects and creds are keyed by host). |
| `SCRATCH_DESKTOP_USER_DATA_DIR` | A throwaway Electron profile (isolates the run). Note: does **not** isolate the CLI registry — see gotcha #4. |
| `SCRATCH_DESKTOP_SCRATCHMD_BINARY` | Absolute path to the repo's built `scratchmd` (`scratch-git-2/target/debug/scratchmd`). Unpackaged-only. |
| `SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE=1` | Don't pull updates during QA. |

See [`scratch-desktop/e2e/README.md`](../../../scratch-desktop/e2e/README.md) for the canonical seam docs.

## One-time setup (before you drive the app yourself)

```bash
# 1. Build the CLI the app shells out to (debug is fine)
cd scratch-git-2 && cargo build --bin scratchmd && cd ..

# 2. Build the desktop renderer with the TEST API baked in (gotcha #6)
cd scratch-desktop
VITE_SCRATCH_API_URL=https://test-api.scratch.md VITE_SCRATCH_WEB_URL=https://test.scratch.md yarn build

# 3. Build + STAGE the native addon (gotcha #7)
node scripts/build-native.cjs
mkdir -p out/scratch-git-2/napi && cp ../scratch-git-2/napi/scratchmd-native.*.node out/scratch-git-2/napi/
cd ..
```

## Running the driver

After the canary, drive the app with the bundled scaffold and **adapt it to the description** (which
folders, which operations, whether to publish):

```bash
# Reads scratch-desktop/.env.e2e (quote-stripped), targets the account's first workbook by id,
# resets to a clean state, drives download -> browse -> edit -> publish, writes artifacts to .context/qa/.
node .claude/skills/qa-desktop-app/qa-driver.mjs

# Env knobs to match the description:
QA_WORKBOOK_ID=wkb_xxx node .claude/skills/qa-desktop-app/qa-driver.mjs # target a specific workbook (e.g. one you bootstrapped)
QA_AUTH_CLI=1   node .claude/skills/qa-desktop-app/qa-driver.mjs        # needed to download-NEW + publish (gotcha #13; touches ~/.scratchmd)
QA_NO_PUBLISH=1 node .claude/skills/qa-desktop-app/qa-driver.mjs        # browse/edit only — no publish
QA_NO_RESET=1   node .claude/skills/qa-desktop-app/qa-driver.mjs        # keep prior download/profile
```

For a full edit→publish round-trip on a workspace you bootstrapped (see [Get real data](#get-real-data-to-test-reuse-or-create-a-workspace--connect-a-connector)):
`QA_AUTH_CLI=1 QA_WORKBOOK_ID=<wkb> node .claude/skills/qa-desktop-app/qa-driver.mjs`.

Then **read the screenshots** (`.context/qa/shots/`) with the Read tool to judge visuals like a human,
and the session log (`.context/qa/session.log.json`) for findings + timings.

The driver is a **scaffold, not a fixed script** — edit it to exercise what the user asked for: drive
the real Publish modal, open a record detail view, exercise sort/filter/pagination, reproduce a specific
bug, focus on one connector's folders, etc. Keep stubbing **only** the folder dialog; keep everything
else real.

## What to report

Group findings by severity and include evidence:

- **Blocking / correctness** — crashes, wrong data, failed operations, console `error`s, any `>=400`
  HTTP response that isn't expected. (The driver logs all of these.)
- **Performance** — anything user-perceptible. Real baselines observed: boot/auth ~2 s, `readDiffGridData`
  48–335 ms even for 300-column folders, cell edit ~175 ms. Note dev is noisier than a packaged build.
- **UX / odd** — confusing states, dead-end error screens (no nav/back), very wide grids, odd records.
- **Data quality** — e.g. a connector folder with a 100% `enforce_schema` error rate (likely schema
  noise — cross-reference the `audit-validation-noise` skill).

For each finding give: what you did, what you expected, what happened, a screenshot or the exact
log/response line, and a severity. **Verify before filing** — most "bugs" in early runs here turned out
to be harness gotchas above (the #1 quote-wrapped token, #10 auto-approve, #11 async publish). When in
doubt, re-check against the canary (`yarn test:e2e:live`).

## Housekeeping

- Downloads/edits mutate local files and publishing ships to real test services. If the driver falls back to another account's
  on-disk workspace (gotcha #4/#5), **tell the user exactly what you changed** (file path + field) and
  offer to revert — edits are reversible via the app's discard/reject ladder.
- Artifacts land in the gitignored `.context/qa/`. The driver leaves the repo tree clean. Don't commit
  QA scratch files into `scratch-desktop/`.
