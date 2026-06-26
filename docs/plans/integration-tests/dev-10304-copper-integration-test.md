# DEV-10304 — Build the Copper live integration test (pilot connector)

Pilot connector for DEV-10304's "revive connector-by-connector" effort. Copper is the **cleanest
fully-state-agnostic pilot**: creds-based (CLI-connectable), and — uniquely among the skill-built
connectors — **its custom-field definitions are API-creatable** (`POST /custom_field_definitions`,
all types except `Connect`), so the test can self-seed *everything* (records **and** fields) with no
hand-maintained fixture. It has **no spec yet**, so this is a from-zero build on the Notion template.

Model: [`notion-connector.spec.ts`](/server/test/integration/notion-connector.spec.ts) +
[`notion-setup.md`](/server/test/integration/notion-setup.md). Connector truth (entities, quirks, FK
rules, custom-field shapes): [`copper/STATE.md`](/server/src/remote-service/connectors/library/copper/STATE.md)
— exceptionally detailed; read it before writing the spec.

## ⚠️ Blocker to resolve first: the test account is a trial expiring ~2026-06-18

The Copper test account (`612378`) is a **Business-plan trial, "cancel by ~2026-06-18"** (today is
2026-06-16 — ~2 days out). Copper has **no free-forever tier**, so a post-deploy CI test that must run
indefinitely needs a **durable account**. Decide before investing in CI wiring:
- convert the trial to a paid seat dedicated to integration testing (cost), **or**
- provision a separate long-lived Copper account, **or**
- treat Copper as a *local/manual* integration test only (run on demand, not in CI) until an account
  is sorted.

The spec build below is valid regardless; only the **CI-wiring** step depends on this.

## Getting the API key (prerequisite)

Auth is `user_provided_params`: **apiKey + email** (three headers: `X-PW-AccessToken`,
`X-PW-Application: developer_api`, `X-PW-UserEmail`). Two ways to obtain the pair:
1. **Decrypt the skill's connection** — `ConnectorAccount.encryptedCredentials` for `coa_v21ua3Q7ct`
   (AES-256-GCM, key `ENCRYPTION_MASTER_KEY` in `server/.env`, AAD `connector-account`) via
   `server/tools/decrypt-credentials.js`. Needs the local dev DB where the skill ran (workbook
   `wkb_lsWnc2smsb`).
2. **Regenerate** in Copper → Settings → Integrations → API Keys (login `ivan@whalesync.com`).

Store as `COPPER_API_KEY` + `COPPER_EMAIL` in `server/.env.integration` (add both to
`.env.integration.example`).

## Why seeding is easy here (vs ClickUp)

- **No hierarchy.** Record path is `/{Entity}/{record}.json`, `basePath = []`. The six entities
  (Companies, People, Opportunities, Leads, Tasks, Projects) are fixed and always present — nothing to
  create to get a "table." (Plus read-only refs Pipelines / Pipeline Stages.)
- **Records: fully API-seedable** via the connector's own `createRecords` (`POST /<entity>`), with the
  assigned `id` flowing back; `DELETE /<entity>/{id}` cleans up.
- **Custom fields: API-seedable** — `POST /custom_field_definitions` creates every type except
  `Connect`. So custom-field coverage needs **no UI fixture** (unlike ClickUp).

So the whole suite is **state-agnostic**: it seeds what it needs and cleans up, runnable against any
Copper account in any state.

## Spec structure (`server/test/integration/copper-connector.spec.ts`)

`const describeIfCreds = API_KEY && EMAIL ? describe : describe.skip`. `jest.setTimeout(120_000)`.
Independent, self-contained `it`s (the Pipedrive/ClickUp pattern), each seeding → asserting →
cleaning up; a `cleanups[]` array drained best-effort in `afterAll`.

1. **Connection / errors** — `testConnection()` resolves with valid creds; **rejects** with a bogus
   token (real error-handling coverage); `fetchJsonTableSpec` for an unknown entity throws.
2. **listTables** — asserts the 6 writable entities + the read-only Pipelines/Pipeline Stages appear,
   each with the expected `wsId`/`remoteId` shape and `basePath = []`.
3. **Schema** — `fetchJsonTableSpec('companies')`: system fields present, readonly split correct
   (`id`, `date_created/modified`, `People.company_id` → `x-scratch-readonly`), and a **redacted
   schema snapshot** (strip `generatedAt` + volatile custom-field ids) committed to
   `__snapshots__/copper-connector.spec.ts.snap` as the regression baseline.
4. **Pull** — `pullRecordFiles` over a freshly-seeded entity (seed 2–3 records → pull → find them);
   `pullRecordFilesByIds` returns the requested record and skips a fake id.
5. **CRUD round-trip per writable entity** (at minimum Companies + People + one of
   Opportunities/Leads/Tasks/Projects): create → read back **via a direct Copper API call** (not the
   connector — independent verification, the STATE.md discipline) → sparse update → read back →
   delete → confirm 404. Register each created id in `cleanups`.
6. **Custom fields (self-seeded)** — idempotently ensure a `scratch_it_<type>` custom field of each
   writable type exists (`GET /custom_field_definitions` → create the missing ones via
   `POST /custom_field_definitions`; reuse across runs so defs don't litter — see cleanup note). Then
   create a Company with one value per type, pull it, and assert the connector's
   `custom_fields[] ↔ { cf_<id>: value }` reshape round-trips; do a single-field sparse edit and
   confirm Copper's per-id merge keeps the others.
7. **Foreign key** — `Companies.primary_contact_id` → People: seed a **fresh (free) Person** (Copper's
   eligibility rule: the target must be related/free or it 422s the whole write — see Gotchas), set
   the FK on a seeded Company, confirm via the Copper API that it re-parented.

## Quirks to bake into the spec (all from STATE.md — don't relearn them live)

- **Date custom field wants a UNIX timestamp (epoch seconds), not ISO** — `"2026-06-15"` → 422; send
  a number.
- **One bad custom-field value 422s the whole record** (no field name) — keep seed values valid;
  if asserting an error, expect the whole-record failure.
- **`primary_contact_id` eligibility rule** — only a related/free person is accepted; seed a fresh
  person for the FK test, not one already tied to another company.
- **`Opportunities.company_id` is set-on-create-only** — Copper silently ignores updates; don't test
  it as a re-parent (it's a no-op, not a bug).
- **Filename = name-slug, id is inside the file**, assigned after create.
- **`getBatchSize() === 1`** (one request per record); **incremental pull NOT supported** (full-scan
  only) — no incremental test.
- **Emoji/unicode survive** (utf8mb4) — fine to include an emoji in a value to prove fidelity.
- **Rate limit ≈3 req/s** (`points:3, duration:1`, honors `Retry-After`) — keep the suite lean;
  serial `maxWorkers:1` already enforced.

## Cleanup / litter

- **Records:** delete every created record in `afterAll` (`DELETE /<entity>/{id}`); deterministic
  `scratch-it-<ts>` naming makes leftovers findable.
- **Custom-field definitions:** seed them **idempotently** (look up `scratch_it_*` by name; create only
  if missing) so a stable set is reused, not recreated per run. **Verify whether Copper supports
  `DELETE /custom_field_definitions/{id}`** — if yes, optionally tear them down; if not, the
  idempotent-reuse pattern avoids per-run litter (this is the Copper analog of Airtable's
  no-delete-table constraint, but bounded to one field set).

## CI wiring (gated on the account-durability decision)

Add to the post-deploy job in `gitlab-ci/stages/06-environment-tests.yml`:
```yaml
    COPPER_API_KEY: "${INTEGRATION_TEST_COPPER_API_KEY}"
    COPPER_EMAIL: "${INTEGRATION_TEST_COPPER_EMAIL}"
```
and create those masked GitLab CI/CD variables. Then flip `copper/STATE.md` Integration-tests →
"Runs in CI ✅" and the `connector-build/existing-connectors.md` Copper row → `IT 📄 ✅` / `IT ✅ ✅`.

## Setup doc — `server/test/integration/copper-setup.md`

Short, Notion-style: account + API-key location (Settings → Integrations → API Keys), the apiKey+email
pair, the ⚠️ trial cancel-by note, and that the suite **self-seeds custom fields** (no manual field
setup required). Where the key lives (1Password + GitLab var).

## Coverage target

| Capability | Result |
|---|---|
| get schemas | ✅ system + dynamic custom fields, + snapshot baseline |
| pull | ✅ full (+ pullRecordFilesByIds); incremental N/A (full-scan only) |
| publish (CRUD) | ✅ per writable entity, verified by direct Copper API read-back |
| error handling | ✅ invalid creds + unknown entity (+ optional bad-value 422) |
| custom fields | ✅ self-seeded, reshape round-trip + per-field merge |
| foreign keys | ✅ `Companies.primary_contact_id` → People (eligibility-aware) |
| state-agnostic | ✅ seeds records + fields, self-cleans |
| runs in CI | ⛔ pending durable-account decision (trial expires ~2026-06-18) |

## How to run

```bash
cd server
yarn test:integration -- copper-connector
```
First run writes the schema snapshot — commit it. Confirm `afterAll` left no `scratch-it-*` records in
Copper (custom-field defs intentionally persist for reuse).
