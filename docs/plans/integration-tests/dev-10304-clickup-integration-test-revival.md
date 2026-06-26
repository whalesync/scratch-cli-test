# DEV-10304 — Revive the ClickUp live integration test (pilot connector)

The first connector to bring back online under DEV-10304. Chosen because it's the **only
skill-built connector we already hold an API key for** (`CLICKUP_API_TOKEN` +
`CLICKUP_TEST_LIST_ID` in `server/.env.integration`), it already has a spec to revive rather than
write from zero, and its quirks (UI-only custom fields, per-list statuses) make it a good template
for the seed-vs-fixture decisions every other connector will face.

Model spec: [`notion-connector.spec.ts`](/server/test/integration/notion-connector.spec.ts) +
[`notion-setup.md`](/server/test/integration/notion-setup.md). Connector facts:
[`clickup/STATE.md`](/server/src/remote-service/connectors/library/clickup/STATE.md).

## Current state

`server/test/integration/clickup-connector.spec.ts` exists and is decent: it covers
`testConnection` (valid only), `listTables`, the schema readonly/writable split, `pullRecordFiles`,
and a full create→update→delete round-trip whose writes are **verified by a direct ClickUp API read**
(`clickupGetTask`) — the strongest verification pattern. But it is **dormant and fixture-bound**:

1. **Skips unless `CLICKUP_TEST_LIST_ID` is set** (`describeIfKey = API_TOKEN && TEST_LIST_ID`). It
   depends on a hand-maintained empty list (`Project 2`, `901218672816`) existing forever.
2. **Not wired into CI** — no `INTEGRATION_TEST_CLICKUP_*` GitLab variable, so it self-skips
   post-deploy.
3. **Error handling is not actually tested** (despite the `IT` column claiming ✅). There's no
   invalid-token assertion and no unknown-list assertion. *(Correct the aggregate table after this
   lands.)*
4. **No custom-field coverage**, no schema snapshot, no setup doc.

## The seeding problem (the crux)

ClickUp is DYNAMIC: a **List is a table**, a **Task is a record**, and a list's columns are the
standard task fields **plus its dynamically-discovered custom fields** (`GET /list/{id}/field`).
Two hard facts from STATE.md decide the whole design:

- **Lists, tasks and standard fields ARE API-seedable.** `POST /space/{id}/list` creates a folderless
  list (with default statuses incl. `to do`); `DELETE /list/{id}` removes it; tasks + name /
  description / status / priority / due_date all go through the connector's own create path.
- **Custom-field *definitions* are UI-only.** The API can read field defs and set values, but
  **cannot create a custom field** (Custom Field Manager only). So a freshly API-created list has
  *no* custom fields, and custom-field pull/edit cannot be exercised on a self-seeded list.

Therefore the revived suite is **two tiers** — the same "state-agnostic where possible, one
documented fixture where not" split the broader DEV-10304 plan calls for:

### Tier 1 — Self-seeding core suite (state-agnostic, CI-ready, needs only the token)
At `beforeAll`, create a throwaway list via the ClickUp API and tear it down in `afterAll`:

- Discover workspace + space: `GET /team` → first team; `GET /team/{teamId}/space` → first space
  (or honor an optional `CLICKUP_TEST_SPACE_ID` to pin it).
- `POST /space/{spaceId}/list` → `Scratch IT <timestamp>` → gives `listId` + default statuses.
- Build the **canonical** table id the connector expects:
  `{ wsId: sanitizeForTableWsId(listId), remoteId: ['list', teamId, listId] }` (from `GET /team` +
  the created `listId`). NB: the current spec uses a *legacy single-segment* `[listId]` id — the
  revived spec should use the multi-segment form `listTables` actually emits. Then run:
  connection, `listTables` (asserts the new list shows up), schema (standard-field readonly split),
  `pullRecordFiles` (empty → then seed → non-empty), and the create→update→delete round-trip with
  direct-API read-back (port the existing assertions).
- `afterAll`: delete created tasks, then `DELETE /list/{listId}`. Best-effort, `Promise.allSettled`.

Result: **no `CLICKUP_TEST_LIST_ID` needed** — the core suite runs with just `CLICKUP_API_TOKEN`,
self-cleans, and survives any account state. This is what gets wired into CI.

### Tier 2 — Custom-fields suite (pre-seeded fixture, optional, skips in CI by default)
Gated on an optional `CLICKUP_CUSTOM_FIELDS_LIST_ID` pointing at a list that has one of each custom
field type, seeded once via the UI per a new `clickup-setup.md` (the ClickUp analog of
`notion-setup.md`). Covers: custom-field discovery in the schema, verbatim pull of
`custom_fields: [{id,name,type,value}]`, and a value edit via `POST /task/{id}/field/{field_id}`
read back through the direct API. `describe.skip` when the var is unset, so CI stays green without it.

## Work items

1. **Add error-handling coverage** (makes the `IT` ✅ honest):
   - `testConnection` with a bogus token rejects (mirror Notion's invalid-token test).
   - `fetchJsonTableSpec` for an unknown list id throws.
   - (Optional) a create with an invalid per-list status surfaces the ClickUp API error rather than
     succeeding silently (per STATE.md: unknown status → 400).
2. **Refactor to Tier 1 self-seeding** — replace the `CLICKUP_TEST_LIST_ID` dependency with
   API-created-list `beforeAll`/`afterAll`; keep the direct-API read-back helper. Preserve the
   `points`/`time_estimate` omission (Sprint-Points / Time-Estimates ClickApp gating → ITEM_227).
3. **Add a redacted schema snapshot** of the standard-field spec (strip `generatedAt`, the list id,
   and volatile field ids) → `__snapshots__/clickup-connector.spec.ts.snap`, mirroring Notion. Commit
   it as the regression baseline. (Only the deterministic standard-field schema — not the dynamic
   custom fields.)
4. **Incremental pull: skip — not supported.** The connector is full-scan only in v1 (no
   `supportsIncrementalPull`, no `since` handling). Don't add an incremental test; note "full pull
   only" in the spec header so nobody assumes otherwise.
5. **Write `server/test/integration/clickup-setup.md`** — workspace/token creation (Google SSO +
   masked-token Copy-button gotcha from STATE.md), the optional custom-fields fixture list, and where
   the key lives (1Password + GitLab var).
6. **Update `.env.integration.example`** — add `CLICKUP_API_TOKEN`, drop the *requirement* on
   `CLICKUP_TEST_LIST_ID` (now optional), add optional `CLICKUP_TEST_SPACE_ID`,
   `CLICKUP_CUSTOM_FIELDS_LIST_ID`.
7. **Wire CI** — add to `gitlab-ci/stages/06-environment-tests.yml` post-deploy job:
   `CLICKUP_API_TOKEN: "${INTEGRATION_TEST_CLICKUP_API_TOKEN}"`, and create that masked GitLab CI/CD
   variable. Leave the custom-fields fixture var unset so only Tier 1 runs in CI.
8. **Flip the docs**: `clickup/STATE.md` Integration-tests section → "Runs in CI pipeline: ✅"; the
   aggregate `connector-build/existing-connectors.md` ClickUp row → `IT ✅` ✅.

## Coverage: before → after

| Capability | Now | After |
|---|---|---|
| get schemas | ✅ (needs fixture list) | ✅ (self-seeded) + snapshot baseline |
| pull | ✅ | ✅ full (incremental N/A — connector is full-scan only in v1) |
| publish (CRUD) | ✅ | ✅ (unchanged, ported) |
| error handling | ❌ (claimed ✅) | ✅ invalid token + unknown list (+ bad status) |
| custom fields | ❌ | ✅ Tier 2 (optional fixture) |
| state-agnostic | ❌ (fixture list) | ✅ Tier 1 self-seeds + self-cleans |
| runs in CI | ❌ | ✅ Tier 1 (token only) |

## Risks / gotchas (from STATE.md — bake into the spec)

- **Custom fields are UI-only** → can't be fully state-agnostic; isolated to optional Tier 2.
- **Per-list statuses** — a self-created list has its own default status set; assert against what the
  created list actually returns (read `listTables`/schema), don't hardcode "to do" blindly.
- **`due_date` day-boundary normalization** (no `due_date_time:true`) → assert "is set", not exact ms
  (the current spec already does this — keep it).
- **Rate limit**: ClickUp Free = 100 req/min/token; connector self-limits to 90/60s and honors
  `Retry-After`. Keep the suite small; `jest.setTimeout(120_000)`; `maxWorkers:1` already enforced.
- **List-create permission**: confirm the token's plan/role can `POST /space/{id}/list` and
  `DELETE /list/{id}` (Free Forever should allow it). If not, fall back to a documented fixture list
  (`CLICKUP_TEST_LIST_ID`) — but verify first; self-seeding is the goal.

## How to run / verify

```bash
cd server
yarn test:integration -- clickup-connector          # Tier 1 (token only)
# Tier 2 also runs if CLICKUP_CUSTOM_FIELDS_LIST_ID is set (see clickup-setup.md)
```
First run writes the schema snapshot; commit it. Confirm `afterAll` left no `Scratch IT *` list or
`scratch-int-* ` task behind in the ClickUp UI.

## Next connectors (apply this template)
Pipedrive (already self-provisioning, just needs the key + CI wiring) → Brevo → Stripe (read-only).
Affinity is gated on **DEV-10130** (de-brittle its fixture assertions first).
