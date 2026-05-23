# CLI Smoke Test

This folder contains local developer smoke tests for the Rust `scratchmd` CLI.

The main script is:

- `scripts/smoke-publish.js`
- `scripts/smoke-cleanup.js`

It is intentionally a manual tool and is not wired into GitLab CI. The goal is to let a developer, or a future AI session, quickly exercise the real end-to-end CLI flow against a chosen server.

## What It Does

`smoke:publish` performs this flow:

1. Verifies the target Scratch server is healthy.
2. Creates a fresh workbook through the CLI/API.
3. Creates a fresh Postgres database.
4. Creates and seeds one table: `smoke_records`.
5. Adds a `POSTGRES` connection to the workbook using the provided connection string.
6. Initializes the workbook locally with `workspaces init`.
7. Links the `smoke_records` table.
8. Pulls and downloads the records locally.
9. Edits every local record file.
10. Runs `files accept-all`.
11. Runs `files upload`.
12. Runs `files publish`.
13. Polls the queued publish job until completion.
14. Verifies the target Postgres rows were updated.

## Important Behavior

- The script uses the current CLI login from `~/.scratchmd/credentials.yaml`.
- It creates a new workbook every run.
- It creates a new Postgres database every run.
- By default it cleans up:
  - local workspace
  - remote workbook
  - test database
- With `--no-cleanup`, it leaves everything in place for inspection.

## Prerequisites

- The target Scratch server must be running and reachable.
- The current CLI user must be logged in for that server.
- The target Postgres server must be reachable from the Scratch server, not just from your laptop.
- The local CLI binary should be built already:
  - `cargo build --manifest-path /Users/ijd/repos/spinner/scratch-git-2/Cargo.toml --bin scratchmd`

## Configuration

Defaults live in:

- `/Users/ijd/repos/spinner/scratch-git-2/tests/cli/smoke.env`

Key values:

- `SCRATCH_API_URL`
- `SCRATCH_CLI_BINARY`
- `DATABASE_URL`
- `DB_SCHEMA`
- `SMOKE_RECORD_COUNT`

`DATABASE_URL` should point at the Postgres server root, for example:

- `postgresql://postgres:postgres@localhost:5432/`

The script will create a fresh database name like:

- `TEST-2026-04-03-16-28-27`

and then use:

- `postgresql://postgres:postgres@localhost:5432/TEST-2026-04-03-16-28-27?schema=public`

## Typical Commands

Local run:

```bash
cd /Users/ijd/repos/spinner/scratch-git-2/tests/cli
yarn smoke:publish
```

Keep artifacts for inspection:

```bash
yarn smoke:publish -- --no-cleanup
```

Pause after each major step:

```bash
yarn smoke:publish -- --pause --no-cleanup
```

Scale the data volume:

```bash
yarn smoke:publish -- --count 1000 --no-cleanup
yarn smoke:publish -- --count 10000 --no-cleanup
```

List what would be cleaned up:

```bash
yarn smoke:cleanup -- --dry-run
```

Delete all matching `TEST-...` runs:

```bash
yarn smoke:cleanup -- --yes
```

Point at another environment:

```bash
yarn smoke:publish -- \
  --server-url https://test-api.scratch.md \
  --database-url postgresql://.../ \
  --count 1000 \
  --no-cleanup
```

## Notes For Future AI Sessions

- This tool is meant for repeated manual smoke testing, not CI.
- If a run fails, prefer rerunning with `--no-cleanup` so the workbook, workspace, and database can be inspected.
- The script intentionally goes through real CLI commands instead of calling internal server APIs directly.
- If `linked available` returns a Postgres table id like `public,smoke_records`, the smoke script already normalizes it for `linked add`.
- If job polling fails, inspect:
  - `/Users/ijd/repos/spinner/scratch-git-2/src/cli/api/mod.rs`
  - `/Users/ijd/repos/spinner/server/src/job/job.controller.ts`
  - `/Users/ijd/repos/spinner/server/src/job/job.service.ts`
- If publish jobs appear generic in the web Runs tab, inspect:
  - `server/src/worker/jobs/job-definitions/publish.job.ts`
  - `server/src/publish-plan/publish-plan.service.ts`
  - `client/src/utils/job-helpers.ts`
  - `client/src/app/workbook/[id]/components/MainPane/RunsView.tsx`
- `smoke-cleanup` fetches remote workspaces first, then deletes matching:
  - remote workspaces
  - matching Postgres databases
  - matching local workspace folders
- The default cleanup regex is:
  - `^TEST-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}$`
