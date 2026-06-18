# Scratch CLI Integration Tests

Black-box integration tests for the `scratchmd` Rust CLI binary (`scratch-git-2/`). Tests are written in TypeScript with Jest and exercise the CLI by shelling out to the compiled binary, parsing its `--json` output.

## What It Validates

| Suite              | What it tests                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------- |
| **Workspaces**     | Create, show, list, and delete workspaces via the CLI                                    |
| **Connections**    | Add, list, show, and remove Postgres connections (requires `DATABASE_URL`)               |
| **Linked Folders** | Discover available tables, link/unlink folders, pull data from Postgres                  |
| **Files**          | Download files to disk, upload local edits, and verify a full round-trip cycle           |
| **Routines**       | Create, update, and remove routine YAML files: `routines push` from one clone, `routines pull` into a second clone verifies each change reached the server (requires `DATABASE_URL` so the config repo materializes) |
| **Publish**        | End-to-end accept → upload → publish → download cycle: verifies `accepted-patches.json` generation, `/upload-patch` round-trip, `/publish-v2/{plan,run}-job` completion, Postgres-side application, and post-publish reconciliation |
| **Driver Publish** | Driver-based end-to-end publish flows over related `authors`/`posts` tables: edit, create, delete, publish, and post-publish reconciliation |
| **Workspace Sync** | Detect added/removed connections on download, test `--on-delete=remove` and `keep` modes |

Each suite tests the full CLI stack: argument parsing, flag handling, credential loading, `--json` serialization, and exit codes.

## Prerequisites

- **Node.js >= 22** (via `nvm use` from the repo root)
- **Rust toolchain** (to build the `scratchmd` binary, unless `SCRATCH_CLI_BINARY` is set)
- **A running Scratch server** (default: `http://localhost:3010`) with the `scratch-git-2` service running
- **PostgreSQL database** accessible from both the test runner and the Scratch server
- **A test user account** with an API token (see [Setting Up a Test User](#setting-up-a-test-user))

## Setting Up a Test User

The tests authenticate using API tokens, not browser-based login. You need at least one user account on the target Scratch server with an API token.

### 1. Create a user account

Sign up on the Scratch web app (default: `http://localhost:3000`) using any email. If running locally with Clerk dev mode, you can create accounts directly.

### 2. Generate an API token

- **Via the web app:** Go to **Settings > User** and click **Generate API Token**. Copy the token.
- **Via the CLI:** Run `scratchmd auth login`, complete the browser flow, then check `~/.scratchmd/credentials.yaml` for the `apiToken` value.

### 3. (Optional) Create a second user

Some permission tests use a second user. Repeat the steps above with a different email and save the token as `SCRATCH_API_KEY_2`.

## Environment Variables

Create `.env.integration` by copying the example:

```bash
cp .env.integration.example .env.integration
```

| Variable                 | Required | Description                                                                                 |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------- |
| `SCRATCH_API_KEY`        | **yes**  | API token for the primary test user                                                         |
| `SCRATCH_API_KEY_2`      | no       | API token for a second user (permission tests)                                              |
| `SCRATCH_API_URL`        | no       | Server base URL (default: `http://localhost:3010`)                                          |
| `DATABASE_URL`           | no       | Postgres connection URL — required for connection, linked, files, and workspace-sync suites |
| `TEST_CONNECTOR_SERVICE` | no       | Connector type to use (default: `POSTGRES`). Set to `SUPABASE` if using a Supabase database |
| `SCRATCH_CLI_BINARY`     | no       | Path to a prebuilt `scratchmd` binary (skips `cargo build`)                                 |
| `DEBUG`                  | no       | Set to `1` for verbose CLI command logging                                                  |

### Local development example

```ini
SCRATCH_API_KEY=your-api-token-here
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/your_db?schema=public
TEST_CONNECTOR_SERVICE=POSTGRES
SCRATCH_API_URL=http://localhost:3010
DEBUG=1
```

## Test Data

The connection/linked/files suites use two Postgres tables as test data:

- `integration_blog_posts` — 3 sample blog post records (`test_table.sql` + `test_data.csv`)
- `integration_products` — 3 sample product records (`test_table_products.sql`, used by workspace-sync suite)

Tables are automatically created and populated in `beforeAll` and dropped in `afterAll`. The database must be accessible from the Scratch server (which runs the Postgres connector).

The driver-based suite ([`tests/driver-publish.spec.ts`](tests/driver-publish.spec.ts)) uses its own per-run database with `authors(id, name, lastUpdated)` and `posts(id, name, ts, authorId, lastUpdated)`. It shells out to `scripts/driver-run.js` to run pull → local edit/create/delete → accept → upload → publish → re-download, can inject a concurrent dirty-branch edit, and verifies that the server-managed `lastUpdated` refresh is accepted back into remote and local state. See [`scripts/README.md`](scripts/README.md) for the driver schema and scenario details.

## Running Tests

```bash
# From the repo root (recommended)
nvm use
cd scratch-cli-tests
yarn test:integration

# Run a single suite
npx jest --runInBand --forceExit workspaces
npx jest --runInBand --forceExit connections
npx jest --runInBand --forceExit linked-folders
npx jest --runInBand --forceExit files
npx jest --runInBand --forceExit routines
npx jest --runInBand --forceExit driver-publish
npx jest --runInBand --forceExit publish
npx jest --runInBand --forceExit workspace-sync
```

The first run builds the `scratchmd` release binary from `scratch-git-2/` (takes ~15s). Subsequent runs reuse the cached binary unless Rust source files change.

## How It Works

1. **Global setup** (`src/global-setup.ts`) builds the `scratchmd` binary via `cargo build --release`, writes a temporary credentials file to an isolated `HOME` directory, and health-checks the target server.
2. **Each test suite** that needs a database connection creates test tables, runs tests against them via the CLI, and drops the tables in teardown.
3. **Each test** uses the `ScratchCli` wrapper (`src/cli.ts`) that shells out to the binary with `--json` and `--scratch-url` flags, using the temp `HOME` for credential isolation.
4. **Global teardown** (`src/global-teardown.ts`) removes the temporary credentials directory.

### Test Isolation

- Every suite creates its own workspace and cleans it up in `afterAll` / `afterEach`.
- Test tables are dropped and recreated for each suite that uses them.
- All resources use unique prefixes with timestamps for easy identification.
- Credentials live in a temp directory — your real `~/.scratchmd/` is never touched.

## CLI Argument Syntax

Important details about the Rust CLI's argument syntax that affect how tests are written:

- **`workspaces create` takes a positional name.** Use `workspaces create "My Workspace"`, not `--name "My Workspace"`.
- **`workspaces delete` has no `--yes` flag.** It deletes without confirmation.
- **`--workspace` is a parent-level flag.** For `connections` and `linked` commands, `--workspace` must come before the subcommand:
  ```
  connections --workspace wkb_abc123 add --service POSTGRES ...
  linked --workspace wkb_abc123 available coa_xyz789
  ```
  Not `connections add --workspace wkb_abc123 ...`.
- **Table IDs from `available` must be split for `add`.** The `linked available` endpoint returns comma-joined IDs (e.g. `"public,my_table"`). When passing to `linked add`, split into separate `--table-id` args:
  ```
  linked --workspace wkb_abc add --table-id public --table-id my_table
  ```
- **`workspaces init` creates a subdirectory.** Returns `{ "directory": "<name>" }`. Tests must capture this and resolve the full workspace path.
- **`linked add/pull/remove` must run from the workspace directory.** These commands auto-trigger operations that require being inside an initialized workspace.
- **Delete/remove commands do not support `--json`.** Use `cli.run([...], { noJson: true })` for `workspaces delete`, `connections remove`, and `linked remove`.
- **`workspaces list` returns `{ "workbooks": [...] }`.** The JSON key is `workbooks`, not `workspaces`.
- **`linked available` returns a flat array.** The response is `Array<{ id, displayName }>`, not wrapped in an object.
- **`linked add` may output extra text after JSON.** The `ScratchCli.json()` method handles this by extracting the first complete JSON value.
