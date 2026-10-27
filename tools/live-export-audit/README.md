# live-export-audit

Headless harness for auditing a Live Export **source service** end-to-end against a real
destination, through the same server flow the dusky wizard uses (connections → data folders →
pull → plan-from-folder → sync-draft → save → routine → publish). Emits a machine-readable
`report.json` with the create-plan notes (every downgraded field + reason), sampled raw pulled
values, per-record publish failures, and an optional steady-state (second-run no-op) verdict.

Normally driven by the **/test-live-export** skill (which also seeds torture data, verifies the
destination side, and files Linear issues) — see `.claude/skills/test-live-export/SKILL.md`.
Direct use:

```bash
node tools/live-export-audit/audit.mjs --source AIRTABLE --dest NOTION --second-run-check
node tools/live-export-audit/audit.mjs --workbook wkb_xxx --rerun     # after source-side CRUD
node tools/live-export-audit/audit.mjs --source X --dest Y --no-run   # plan/schema audit only
```

Run `node tools/live-export-audit/audit.mjs` with no valid setup to get the preflight checklist.

## Credentials

Gitignored env files under `local/audit-creds/`:

- `_spinner.env` — `SPINNER_API_TOKEN=...` (and optional `SPINNER_API_URL`, default
  `http://localhost:3010`). Mint a token with `POST /users/current/api-token`.
- `<service>.env` — one per service, keys named exactly after the connector's
  `userProvidedParams` (e.g. `apiKey=...`, `connectionString=...`, `shopDomain=...`). The
  preflight prints the required field names when a file is missing. Destination extras:
  `DEST_PARENT_ID=<id>` (e.g. the Notion parent page for created databases). Connectors that
  refuse unknown credential keys (MYSQL) need `--dest-parent <id>` on the command line instead,
  since the whole file is sent as the connection's params. `--source-creds` / `--dest-creds`
  pick another file, e.g. `mysql-mariadb.env` for a second MySQL-family server.

Use **burner accounts** — audits create, edit, and delete real records.

OAuth-only services can't be connected headlessly: connect once via local dusky
(`localhost:3030/exports`), then pass `--workbook wkb_… --source-connection coa_…`. Because
connections are workbook-scoped and the harness wants one workbook per destination, use
`clone-oauth-connection.mjs` (below) rather than re-walking consent three times.

## Helper scripts

Cross-service, reusable outside the connector they were first written for:

| Script | What it does |
| --- | --- |
| `clone-oauth-connection.mjs` | Copies a human-connected OAuth connection's encrypted credential blob + `extras` into a fresh disposable workbook, mirroring `OAuthService.createOAuthAccount`. The one workaround that makes OAuth-only sources auditable across several destinations without touching the user's real workbook. |
| `verify-notion.mjs` | Reads a Notion database back through Notion's own API — property types, row counts, per-record values — for the "trust nothing you didn't confirm against the destination" step. |
| `verify-supabase.mjs` | The same for a Supabase/Postgres destination: column types, row counts, spot-check values. |
| `verify-mysql.mjs` | The same for a MySQL / MariaDB destination, through mysql2: exact `COLUMN_TYPE` and nullability, engine, the table comment Scratch writes on created tables, FK constraint names, row counts and spot-check rows. |

Per-source seeders live in `seeds/<service>/` and are the thing to re-run before a re-audit so the
torture set is identical. Each one is idempotent — re-running updates rather than duplicating:

- `seeds/wix_blog/` — `seed.mjs`, `crud-pass.mjs`, `provision-workbook.sh`, `wix-api.mjs`
- `seeds/quickbooks/` — `seed.mjs`, `crud-pass.mjs`, `qbo-client.mjs`, `refresh-connection-token.mjs`
  (mints a QBO token out-of-band and re-encrypts it into the connection, for dev servers whose
  `.env` lacks `QUICKBOOKS_CLIENT_ID`/`_SECRET` and so can't refresh)
- `seeds/pipedrive/`
- `seeds/salesforce/` — `create-oauth-connection.mjs` plants a SALESFORCE OAuth connection from a password-grant
  token (no consent screen, no connected-app secrets in `server/.env`); `--refresh coa_…` re-mints its token
- `seeds/airtable/` — `seed.mjs` (honours `AIRTABLE_SEED_BASE_ID` from the env or `airtable.env`), `crud-pass.mjs`
- `seeds/postgres/` — `seed.mjs`, `crud-pass.mjs` (plain SQL through the server's `pg`; table ids are `public/<table>`)
- `seeds/mysql/` — `seed.mjs` (`--wide` adds a 185-column table, `--reset-dest` empties the destination databases),
  `crud-pass.mjs` (SQL through the server's `mysql2`; table ids are `fable_qa_my_src/<table>`). Also creates one
  empty destination database per source (`fable_qa_dest_from_airtable`, `…_supabase`, `…_mysql`) for `--dest-parent`.

A `crud-pass.mjs` must make the create target a title the site does **not** already have — a
previous pass leaves its created record behind, and silently reusing it turns the create assertion
into a no-op that still reads as a pass.

## Design notes

- **Dusky-faithful requests**: FK targets keep `unresolvedLinkedTableId` (the server binds them at
  save — rewriting to `{ref}` silently skips relation resolution); mappings, record matching, and
  the delete policy mirror `buildPlaceholderTableMapping` in dusky.
- **Shape validation**: when `@spinner/shared-types` resolves from `server/node_modules`, request
  bodies are validated against the real zod schemas before sending, so a rejection is a product
  bug rather than a harness artifact. A validation failure aborts with "fix the harness".
- Publish "success" is judged from the routine run's publish step (`failedOperations`), never from
  job state — runs report `completed` even when every record was rejected.
