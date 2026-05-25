# Notion integration-test workspace setup

One-time setup to make [`notion-connector.spec.ts`](notion-connector.spec.ts) runnable. Takes ~10 minutes.

This guide is the source of truth for the test fixture: the spec discovers the database by exact title (`Scratch Integration Test`) and asserts on a specific set of property names. **If you rename a column or skip a property type, the test will tell you which one is missing — come back here to fix it.**

---

## 1. Create a Notion workspace

A free personal workspace is fine. If you already have one you can use it — the integration only sees databases you explicitly share with it.

Recommended: create a fresh workspace dedicated to testing so test pages don't clutter your main one. Notion → top-left workspace switcher → **Create or join workspace** → **For myself**.

---

## 2. Create an internal integration

This produces the API key the test consumes via `NOTION_API_KEY`. Notion currently issues tokens with an `ntn_` prefix (older integrations used `secret_`; both formats are accepted by the API).

1. Open [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations) (signed into the same Notion account that owns your test workspace).
2. **+ New integration**.
3. Settings:
   - **Name**: `Scratch Integration Tests`
   - **Associated workspace**: pick your test workspace
   - **Type**: **Internal** (not Public)
4. **Save**.
5. On the integration's **Configuration** tab:
   - **Capabilities** → enable **Read content**, **Update content**, **Insert content**. Leave **Read user information** off; the test doesn't need it.
6. On the **Secrets** tab → copy the **Internal Integration Secret** (`secret_...`).

Stash it:

```bash
# server/.env.integration
NOTION_API_KEY=ntn_abc123…
```

(`server/.env.integration` is gitignored. Copy from `.env.integration.example` if you don't already have one.)

---

## 3. Create the primary test database

In your test workspace, create a new full-page database titled **exactly** `Scratch Integration Test` (case-sensitive). The spec discovers it by title, so any drift here will throw on the first `beforeAll`.

Add these properties in this order. **Property names must match exactly** (the spec asserts on them):

| Property name    | Type           | Configuration notes                                                                                          |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `Name`           | Title          | The default title column — rename `Name` if Notion calls it something else.                                  |
| `Description`    | Text           | (rich_text)                                                                                                  |
| `Status`         | Status         | Default options are fine                                                                                     |
| `Priority`       | Select         | Add options: `Low`, `Medium`, `High`                                                                         |
| `Tags`           | Multi-select   | Add options: `backend`, `frontend`, `infra`                                                                  |
| `Estimate`       | Number         | Format: Number                                                                                               |
| `Due Date`       | Date           | Time + timezone off is fine                                                                                  |
| `Done`           | Checkbox       |                                                                                                              |
| `Owner Email`    | Email          |                                                                                                              |
| `Link`           | URL            |                                                                                                              |
| `Attachments`    | Files & media  |                                                                                                              |
| `Linked Items`   | Relation       | **Related to**: `Scratch Integration Test Linked` (created in step 4). Two-way is fine but not required.     |
| `Linked Count`   | Rollup         | **Relation**: `Linked Items` → **Property**: `Name` → **Calculate**: `Count all`. Yields a read-only number. |
| `Score`          | Formula        | Expression: `length(prop("Name"))`. Yields a read-only number.                                               |

> The `Linked Count` rollup and `Score` formula are intentionally read-only types. The test asserts that `updateRecords` silently strips writes against them — that branch is one of the bug-magnets we want covered before the SDK upgrade.

---

## 4. Create the relation-target database

Create a second database — **exactly** titled `Scratch Integration Test Linked` — anywhere in your test workspace.

Properties:

| Property name | Type  |
| ------------- | ----- |
| `Name`        | Title |

Add 2–3 rows with any titles (e.g. `Linked A`, `Linked B`). These exist so the `Linked Items` relation in the primary database has something to point at.

---

## 5. Seed the primary database

Add at least **three** rows to `Scratch Integration Test`. Give each a non-empty `Name` (the filename-suggestion test asserts at least one row produces a non-empty filename). Other fields are optional but ideally populate at least one of each type — that gives the snapshot baseline broader coverage.

Suggested seed rows:

| Name              | Description     | Status      | Priority | Tags                  | Estimate | Due Date     | Done | Owner Email      | Link                  | Linked Items |
| ----------------- | --------------- | ----------- | -------- | --------------------- | -------- | ------------ | ---- | ---------------- | --------------------- | ------------ |
| `Seed Page A`     | Short rich text | In progress | High     | `backend`             | 3        | (today + 7d) | ✓    | a@example.com    | https://example.com   | Linked A     |
| `Seed Page B`     |                 | Not started | Medium   | `frontend`, `backend` | 5        |              |      | b@example.com    | https://example.com/b | Linked B     |
| `Seed Page C`     | Plain note      | Done        | Low      |                       | 1        |              | ✓    |                  |                       |              |

The exact contents don't matter for assertions — only that there are ≥1 rows with a populated title.

---

## 6. Share both databases with the integration

The integration can't see anything you haven't explicitly granted access to.

For **each** of the two databases:

1. Open the database as a full page.
2. Click **•••** (top right) → **Connections** → **Add connections**.
3. Pick **Scratch Integration Tests** from the list → confirm.

If you've already shared a parent page that contains both databases, that works too — connections inherit.

---

## 7. Run the tests

```bash
cd server
yarn test:integration -- notion-connector
```

Expected first run: the snapshot test creates `__snapshots__/notion-connector.spec.ts.snap` and passes. Commit the snapshot — it becomes the v3 contract that Phase 3 / Phase 4 of the upgrade plan diff against.

Subsequent runs: every test passes, including the snapshot.

If a property-coverage assertion fails, the error names the missing property. Revisit step 3 and add it.

---

## Costs

- Notion free tier is sufficient (no API rate-limit tier, no storage cost).
- The CRUD round-trip creates and archives 2–3 pages per run. They're cleaned up in `afterAll`; leftovers from a failed run are findable in Notion by the `Spinner Roundtrip` title prefix.

---

## Handoff

After setup, share the credentials so other engineers can run the tests:

1. Add `NOTION_API_KEY` to 1Password under the team's "Integration test credentials" vault.
2. If you want CI to run this suite, add the secret to the GitLab CI variable store as `NOTION_API_KEY` (masked). Until then, the suite auto-skips when the env var is missing.
3. Add yourself as the owner-of-record for this workspace so re-provisioning has a clear point of contact (see Open Question #6 in [docs/plans/2026-05-25-notion-client-v5-upgrade.md](../../../docs/plans/2026-05-25-notion-client-v5-upgrade.md)).
