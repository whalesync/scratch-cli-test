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
  `DEST_PARENT_ID=<id>` (e.g. the Notion parent page for created databases).

Use **burner accounts** — audits create, edit, and delete real records.

OAuth-only services can't be connected headlessly: connect once via local dusky
(`localhost:3030/exports`), then pass `--workbook wkb_… --source-connection coa_…`.

## Design notes

- **Dusky-faithful requests**: FK targets keep `unresolvedLinkedTableId` (the server binds them at
  save — rewriting to `{ref}` silently skips relation resolution); mappings, record matching, and
  the delete policy mirror `buildPlaceholderTableMapping` in dusky.
- **Shape validation**: when `@spinner/shared-types` resolves from `server/node_modules`, request
  bodies are validated against the real zod schemas before sending, so a rejection is a product
  bug rather than a harness artifact. A validation failure aborts with "fix the harness".
- Publish "success" is judged from the routine run's publish step (`failedOperations`), never from
  job state — runs report `completed` even when every record was rejected.
