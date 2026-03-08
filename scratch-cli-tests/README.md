# Scratch CLI Integration Tests

Black-box integration tests for the `scratchmd` Go CLI binary. Tests are written in TypeScript with Jest and exercise the CLI by shelling out to the compiled binary, parsing its `--json` output.

## What It Validates

| Suite              | What it tests                                                                  |
| ------------------ | ------------------------------------------------------------------------------ |
| **Workspaces**     | Create, show, list, and delete workspaces via the CLI                          |
| **Connections**    | Add, list, show, and remove Supabase connections (requires `DATABASE_URL`)     |
| **Linked Folders** | Discover available tables, link/unlink folders, pull data from Postgres        |
| **Files**          | Download files to disk, upload local edits, and verify a full round-trip cycle |

Each suite tests the full CLI stack: argument parsing, flag handling, credential loading, `--json` serialization, and exit codes.

## Prerequisites

- Node.js >= 22 (via `nvm use`)
- Go (to build the `scratchmd` binary, unless `SCRATCH_CLI_BINARY` is set)
- A running Scratch server (localhost or remote)
- PostgreSQL database accessible from both the test runner and the Scratch server
- A user account on the target scratch server

## Test Data

The connection/linked/files suites use a `integration_blog_posts` Postgres table as test data:

- `test_table.sql` — schema definition for the `integration_blog_posts` table
- `test_data.csv` — 3 sample blog post records

The table is automatically created and populated before each suite and dropped after. The test database can be anywhere but it is should be on a Supabase database (until our Postgres connector gets upgraded)

## Environment Variables

| Variable             | Required | Description                                                                                                                                                          |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCRATCH_API_KEY`    | **yes**  | API key for user authentication. It is recommended you create a new account to use for testing                                                                       |
| `SCRATCH_API_KEY_2`  | **yes**  | API key for an alternate user to test that workspace permissions are managed                                                                                         |
| `SCRATCH_API_URL`    | no       | Server base URL (default: `http://localhost:3010`)                                                                                                                   |
| `DATABASE_URL`       | no       | Postgres/Supabase connection URL — required for connections, linked folders, and files suites. Use the Supabase Session pooler connection string when using Supabase |
| `SCRATCH_CLI_BINARY` | no       | Path to a prebuilt `scratchmd` binary (skips `go build`)                                                                                                             |
| `DEBUG`              | no       | Set to `1` for verbose CLI output                                                                                                                                    |

Copy `.env.integration.example` to `.env.integration` and fill in your values.

## Running Tests

```bash
cd scratch-cli-tests
yarn test
```

## How It Works

1. **Global setup** builds the `scratchmd` binary (or uses `SCRATCH_CLI_BINARY`), writes a temporary credentials file to an isolated `HOME` directory, and health-checks the target server.
2. **Each test suite** that needs a database connection creates the `integration_blog_posts` table, runs tests against it via the CLI, and drops the table in teardown.
3. **Each test** instantiates a `ScratchCli` wrapper that shells out to the binary with `--json` and `--scratch-url` flags, using the temp `HOME` for credential isolation.
4. **Global teardown** removes the temporary credentials directory.

### Test Isolation

- Every suite creates its own workspace and cleans it up in `afterAll` / `afterEach`.
- The `integration_blog_posts` table is dropped and recreated for each suite that uses it.
- All resources use a `cli-test-` prefix with unique timestamps for easy identification.
- Credentials live in a temp directory — your real `~/.scratchmd/` is never touched.

## CLI Behavioral Notes

Important quirks of the `scratchmd` CLI that affect how tests are written:

- **`workspaces init` creates a subdirectory.** The command does not init in-place — it creates a named subdirectory under `cwd` and returns `{ "directory": "<name>" }`. Tests must capture this and resolve the full workspace path.
- **`linked add`, `linked pull`, and `linked remove` must run from the workspace directory.** These commands auto-trigger a file download internally, which requires being inside an initialized workspace (`cwd` must contain `.scratchmd/`).
- **Delete/remove commands do not support `--json`.** Commands like `workspaces delete`, `connections remove`, and `linked remove` error if passed `--json`. Use `cli.run([...], { noJson: true })` for these.
- **`workspaces list` returns `{ "workbooks": [...] }`.** The JSON key is `workbooks`, not `workspaces` (matches the Go struct tag).
- **`linked available` returns a flat array.** The response is `Array<{ id, displayName }>`, not wrapped in an object.
- **`linked add` may output extra text after JSON.** The CLI prints download progress after the JSON result. The `ScratchCli.json()` method handles this by extracting the first complete JSON value using bracket-depth tracking.
- **Connection flags use full names.** The correct flags are `--connection-id` and `--table-id` (not `--connection` or `--table`).
