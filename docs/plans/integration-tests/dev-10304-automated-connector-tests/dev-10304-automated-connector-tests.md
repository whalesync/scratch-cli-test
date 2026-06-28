# DEV-10304 — Automated connector tests (implementation plan)

Parent: DEV-10297 (Expand connector support). Related: DEV-10130 (Affinity live tests fail on sandbox drift).

## Goal

Regularly validate that **every** connector works — get schemas, pull data tables, publish
changes, handle errors — by running live-API integration tests automatically after each deploy to
the Test environment.

## Current state (verified in repo)

The live-test machinery already exists and is mature:

- **Harness:** per-connector `server/test/integration/<service>-connector.spec.ts`, run via
  `yarn test:integration` (`jest --config ./test/integration/jest-integration.json`, `maxWorkers: 1`,
  `forceExit: true`). Global setup `jest-setup.ts` loads `server/.env.integration` locally.
- **Self-skip pattern:** every suite uses `const describeIfKey = API_KEY ? describe : describe.skip`.
  A missing credential silently skips that connector — so wiring every key into CI is safe.
- **Coverage today (12 live + 1 fake):** live specs for airtable, attio, affinity, brevo, clickup,
  intercom, notion, pipedrive, stripe, webflow (+assets), zoho; **postgres** has only create-schema +
  incremental-pull (no core CRUD spec, and it runs against the CI's own postgres sidecar, not a third
  party); **hubspot** runs against an in-process fake (`test-api-fakes/hubspot`), so it validates our
  code but not the live HubSpot API. `generic-api` has **no** integration spec (covered by its own
  unit suite + the `/test-generic-connector` skill; treat as out of scope for live CI).
- **CI post-deploy job:** `environment tests for test env post-deploy` in
  `gitlab-ci/stages/06-environment-tests.yml`. Stage `post-deploy environment tests`, runs
  `yarn run migrate && yarn run test:integration ...`, emits `server/junit.xml`, rule
  `on_merge_to_master`, Slack alert on failure already wired
  (`notify slack on environment test failure test env post-deploy`).
- **CI wiring today:** the job exports only `NOTION_API_KEY: "${INTEGRATION_TEST_NOTION_API_KEY}"`
  (plus Whalesync admin vars). **Every other connector suite skips in CI** because its key is unset.

### The two real gaps

1. **Existing tests don't run in CI.** 12 of 13 connector suites self-skip post-deploy because their
   CI/CD variables were never wired. This is the highest-value, lowest-effort fix.
2. **12 connectors have no live test at all:** audienceful, copper, gohighlevel, linear, memberstack,
   moco, quickbooks, shopify, supabase, wix, wordpress, youtube.

### Key architectural nuance (drives several decisions below)

The `*-connector.spec.ts` tests **instantiate the connector class in-process and hit the external
service's API directly** — they do *not* drive the deployed Test site. So "post-deploy" placement
means "a periodic live-connector health check pinned to the just-merged master commit," not an
end-to-end test of the deployed artifact. That is consistent with the issue's intent, but it means:
these tests validate connector *code at HEAD* against *live third-party APIs*; their failures signal
either our regression **or** third-party/sandbox drift (see DEV-10130).

## Plan

### Workstream A — Wire existing suites into post-deploy CI (do first; biggest ROI)

For each connector that already has a spec, provision a stable throwaway account, store its key as a
**masked + protected** GitLab CI/CD variable (in GitLab project settings, *not* in the repo), and map
it in `gitlab-ci/stages/06-environment-tests.yml` under the post-deploy job `variables:`.

Variables to wire (env var ← suggested CI/CD variable name):

| Connector | Required env var(s) | Auxiliary env var(s) |
|---|---|---|
| Airtable | `AIRTABLE_API_KEY` | `AIRTABLE_TEST_BASE_ID` |
| Webflow | `WEBFLOW_API_KEY` | `WEBFLOW_IMAGE_COLLECTION_ID`, `WEBFLOW_IMAGE_FIELD_SLUG` |
| Pipedrive | `PIPEDRIVE_API_KEY` | — |
| Brevo | `BREVO_API_KEY` | — |
| Stripe | `STRIPE_CONNECTOR_API_KEY` | — |
| Intercom | `INTERCOM_ACCESS_TOKEN` | `INTERCOM_TEST_AUTHOR_ID` |
| Affinity | `AFFINITY_API_KEY` | — (see Workstream C / DEV-10130 first) |
| Attio | `ATTIO_API_KEY` | (bootstrap script must have been run on the account) |
| ClickUp | `CLICKUP_API_TOKEN` | `CLICKUP_TEST_LIST_ID` |
| Zoho | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` | `ZOHO_DATA_CENTER`, `ZOHO_ALLOW_CREATE` |

Follow the existing convention `NOTION_API_KEY: "${INTEGRATION_TEST_NOTION_API_KEY}"` — i.e. CI/CD
variable named `INTEGRATION_TEST_<SVC>_*`, mapped to the env var the spec reads.

Steps:
1. Inventory which throwaway accounts already exist (Notion, Affinity sandbox, Attio, Webflow per
   1Password references in `.env.integration.example`). Create the missing ones.
2. Add masked/protected CI/CD variables in GitLab project settings (manual; document the list in the
   MR description and in `.env.integration.example`).
3. Edit `06-environment-tests.yml` to export each env var from its CI/CD variable.
4. **Sync `server/.env.integration.example`** — it is currently missing
   `AFFINITY_API_KEY`, `ATTIO_API_KEY`, `CLICKUP_API_TOKEN`, `CLICKUP_TEST_LIST_ID`, and all `ZOHO_*`.
   Add them with the same inline guidance the others have.
5. Roll out incrementally: wire 2–3 connectors per MR, watch a post-deploy run go green, then add
   more. Avoids a single 10-connector MR that turns the pipeline red and is impossible to triage.
   **Caveat:** the pipeline change itself cannot be dry-run in an MR — `on_merge_to_master` excludes
   `merge_request_event`, and the pre-deploy job is `when: never`. The first real CI signal is
   post-merge. So before each merge, run the exact CI invocation locally
   (`cd server && yarn run migrate && yarn run test:integration`) with the same env vars set.

### Workstream B — Close coverage gaps (new live specs)

Write a `*-connector.spec.ts` for the 12 uncovered connectors, using the established template
(see any of pipedrive/brevo/clickup as the model). Each spec must cover the four capabilities:

- **Schemas:** `testConnection()` (valid **and** invalid key), `listTables()`, `fetchJsonTableSpec()`.
- **Pull:** `pullRecordFiles()` full pull (+ incremental where the connector supports it).
- **Publish:** `createRecords()` → `updateRecords()` → `deleteRecords()` round-trip with best-effort
  cleanup in `afterAll`; **self-provision** the data the test needs (don't depend on pre-seeded
  fixtures). Read-only connectors assert that writes throw instead.
- **Errors:** assert `extractConnectorErrorDetails()` produces a sensible user-facing message on a
  bad-credential failure.

Prioritisation (highest first):
1. Customer-facing connectors recently built/revived and most likely to regress: **Copper,
   GoHighLevel, Shopify, Linear, YouTube** (per active connector work under DEV-10297).
2. DB-style connectors: **Supabase** (can reuse the Postgres harness pattern).
3. Connectors that today only have a **fake** (audienceful, memberstack, moco, quickbooks, wordpress):
   decide per connector whether a *live* account is obtainable and worth it. Where a stable live
   account isn't feasible, **explicitly document** that it stays fake-only and why — do not silently
   leave it uncovered (Product principle: surface gaps, don't hide them).
4. **Wix** last (blog-only, lower priority).

Each new spec is added to CI in the same incremental way as Workstream A.

### Workstream C — Robustness, cadence & stability (informed by DEV-10130 + adversarial review)

**Cadence is a design decision, not a dial.** The post-deploy job runs on `on_merge_to_master`
(`gitlab-ci/common.yml`), which fires on *every* merge to master (often several/day) and explicitly
**excludes** scheduled pipelines (`$CI_PIPELINE_SOURCE != "schedule"`). It also runs serially
(`maxWorkers: 1`) on the `resource_group: test` deploy path and currently runs the *whole*
`test:integration` set (including heavy `sync-*-e2e` / `fetch-edit-publish` DB specs). Adding ~20 live
third-party CRUD suites to that path will make a slow, serial, flaky, deploy-blocking job. Therefore,
**up front** (not "if quota proves it necessary"):

- **Tag the live connector specs** as a separable group (jest project or a filename/path convention)
  so the heavy live set can be run on its own command, independently of the existing DB/e2e specs.
- **Decide the cadence explicitly.** Default per the issue is post-deploy on merge. If the serial
  wall-clock or third-party flakiness is unacceptable, scope the alternative as *real work*: a new
  `.rules.on_schedule` entry in `gitlab-ci/common.yml`, a new scheduled job, and a GitLab pipeline
  schedule. There is no existing scheduled-pipeline path to reuse.
- **Carve non-cleanable / capped suites out of the per-merge path from day one:**
  - `airtable-create-schema.spec.ts` and `notion-create-schema.spec.ts` create tables/DBs;
    **Airtable has no delete-table API**, so every run permanently litters the scratch base. Gate or
    schedule these, don't run them on every merge.
  - Zoho create suite stays behind `ZOHO_ALLOW_CREATE` (shared-org record cap).

**OAuth token rot & a coverage blind spot:**

- Most "OAuth" connectors are tested with a **static PAT/admin token** in the spec (Airtable, Linear,
  Shopify, HubSpot, GoHighLevel), so they won't rot — but that also means the production OAuth path
  (`ctx.getOAuthAccessToken`) is **never exercised** by these specs. State this as a known blind spot;
  it is out of scope here.
- **QuickBooks is OAuth-refresh-only** (access token 1h, refresh token 100 days, rotates on use) — a
  live CI test is unmaintainable. Mark it (and any refresh-only service) **fake-only / excluded** with
  the rot reason, not "decide per connector."

**Other robustness items:**

DEV-10130 is the cautionary tale: Affinity's live suite has 7 failing assertions purely because the
shared sandbox drifted from the fixtures the test expects. If we wire brittle, fixture-dependent
suites into `on_merge_to_master` post-deploy, the pipeline goes permanently red and the signal is
ignored. So stability is a first-class deliverable, not an afterthought:

1. **Self-provisioning over fixtures.** Prefer tests that create their own records and clean up
   (pipedrive/clickup/brevo already do). Audit read-only/fixture-dependent suites (Affinity, Stripe,
   Notion read paths) for assertions pinned to specific sandbox content; loosen them to shape/contract
   assertions rather than exact values.
2. **Resolve DEV-10130 before wiring Affinity.** The brittleness is surgical, not a rewrite: the
   create→update→delete round-trip (`affinity-connector.spec.ts` ~L446–500) is already
   self-provisioning and fine; only the `listTables`/schema assertions pinned to exact sandbox content
   (hardcoded `TENANT_TABLE_IDS` ~L29, `toEqual` ~L74, `spec.name` toBe checks ~L153–179) drift.
   Loosen those to shape/contract assertions. The same pre-seeded-fixture risk applies to the suites
   queued right after Affinity — `AIRTABLE_TEST_BASE_ID`, `INTERCOM_TEST_AUTHOR_ID`,
   `CLICKUP_TEST_LIST_ID`, `WEBFLOW_IMAGE_*`, Attio bootstrap — so audit those for exact-value
   assertions *before* wiring, not just Affinity. Until fixed, leave `AFFINITY_API_KEY` unwired.
3. **Failure policy.** The job is post-deploy and does not gate the deploy — it alerts via Slack. Keep
   it that way; a connector/third-party hiccup must not roll back a deploy. Confirm a single suite
   failure doesn't abort the others (jest continues; `maxWorkers: 1` runs them serially — fine).
4. **Cost / rate limits / data hygiene.** Running full CRUD against ~20 live services on *every* merge
   to master creates real records and consumes quota. Mitigations: dedicated throwaway accounts only;
   deterministic `scratch-test-<timestamp>` naming + `afterAll` cleanup; for accounts with hard record
   caps (Zoho), keep the create-gate (`ZOHO_ALLOW_CREATE`) opt-in. Evaluate whether per-merge cadence
   is right or whether a **scheduled (e.g. nightly) pipeline** is a better home for the heavy CRUD
   suites — note the issue text specifically asks for post-deploy, so default to post-deploy and only
   split out if quota/cost proves it necessary.
5. **Triage ergonomics.** junit + Slack already exist. Add a short `connector test ownership` note (in
   the integration README) mapping each suite to its account location in 1Password so a red run is
   actionable.

## Deliverables

- Edits to `gitlab-ci/stages/06-environment-tests.yml` (env var exports).
- New CI/CD variables in GitLab (manual; documented).
- Updated `server/.env.integration.example` (all connector keys, with guidance).
- New `*-connector.spec.ts` files for the 12 uncovered connectors (prioritised).
- A short README/section documenting account locations + per-connector test status + which are
  fake-only and why.
- DEV-10130 fixed (or Affinity explicitly gated out) as a precondition for wiring Affinity.

## Out of scope / explicit non-goals

- End-to-end tests that drive the *deployed* Test site's connector code (these stay in-process).
- Migrating connectors off their fakes for unit/smoke tests.
- Rewriting the connector abstraction.

## Suggested sequencing

1. Workstream A for the 4–5 already-stable, self-provisioning connectors (Pipedrive, Brevo, ClickUp,
   Stripe, Webflow) — fast green win.
2. Workstream C item 2 (DEV-10130) → then wire Affinity, Attio, Airtable, Intercom, Zoho.
3. Workstream B by priority, each new spec wired into CI as it lands.
