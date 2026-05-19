# apiget-driver

Standalone CLI that runs apiget against a real API without going through
the NestJS / GENERIC_API connector. Used to iterate on real services and
spot apiget bugs or missed pagination shapes.

## Usage

```bash
# Run a built-in fixture. API key comes from the env.
API_KEY=<key> yarn apiget:driver todoist

# Or a service-specific env var (uppercased fixture name + _API_KEY)
TODOIST_API_KEY=<key> yarn apiget:driver todoist

# Arbitrary config file (same shape as a fixture)
API_KEY=<key> yarn apiget:driver --config /tmp/my-config.json

# Only run one endpoint
API_KEY=<key> yarn apiget:driver todoist --endpoint Tasks

# Walk more pages (default 5)
API_KEY=<key> yarn apiget:driver todoist --max-pages 20
```

Each run writes to `server/apiget-output/<service>-<timestamp>/`:

- `resolved-extras.json` — the canonical config that ran (post-normalization)
- `driver-report.json` — top-level report across all endpoints
- `<endpoint-name>/page-001.json`, `page-002.json`, … — one file per page,
  containing the raw records apiget yielded
- `<endpoint-name>/summary.json` — per-endpoint summary: detected
  pagination strategy, idField, record count, first record keys, error
  (if any)

The output dir is gitignored.

## Fixture format

Same shape as `GenericApiConnectorExtras` (the canonical post-validator
form). Example (`todoist.json`):

```json
{
  "apiType": "rest",
  "authHeader": { "style": "bearer" },
  "endpoints": [
    {
      "id": "ep_todoist_projects",
      "name": "Projects",
      "method": "GET",
      "url": "https://api.todoist.com/api/v1/projects"
    }
  ]
}
```

The driver also accepts the AI wire-shape (`"authHeader": "Bearer"` as a
plain string) and runs it through the same paste-validator the modal
uses. That means you can take what the AI agent returns to a user,
add `"apiType": "rest"` at the top, save it as `<service>.json`, and
run it.

## Iteration loop

1. User gives a service ("how would this work with Clover?")
2. I (or the user) author `<service>.json` based on the API docs
3. Run the driver with a real key
4. Inspect `driver-report.json` and a few page files
5. If apiget mis-detected pagination, returned 0 records, or threw
   unexpectedly → fix apiget (or the fixture's `advanced` overrides)
   and re-run
6. When happy, the fixture stays in `apiget-fixtures/` as a real-world
   reference test

## What to look for in the output

- `detectedPagination.type` — `cursor`, `offset`, `graphql`, `link-header`,
  or `null` (single-page). If you expected pagination but got null, the
  detection missed something.
- `firstRecordKeys` — confirms the records are what you expected. If you
  see something like `[error, error_code]`, the API returned an error
  body that apiget treated as a record (now fixed: HttpStatusError
  throws on non-2xx).
- `totalRecords` vs `pagesWalked` — sanity check the page size and that
  pagination is actually advancing.
- `error.name` / `error.message` — when present, this is the same error
  the connector would surface to the user.
