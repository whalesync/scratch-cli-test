# Scratch API — Bruno collection

A [Bruno](https://www.usebruno.com/) collection for exercising the Scratch REST
API by hand. Every endpoint reachable with an API token is here, grouped by
feature area, with example request bodies pre-filled so requests are runnable as
soon as you supply a token and the relevant IDs.

Bruno stores each request as a plain-text `.bru` file, so this whole collection
is diffable and lives in git alongside the rest of the repo.

## Getting started

1. **Install Bruno** — <https://www.usebruno.com/downloads> (or `brew install bruno`).
2. **Open this collection** — in Bruno: `Open Collection` → select
   `tools/bruno`.
3. **Pick an environment** (top-right selector): `Local`, `Test`, or `Production`.
4. **Set your API token** — open the environment (gear icon → the environment),
   and set the secret `apiToken` value. Secret values are stored locally by Bruno
   (OS keychain) and are **never** written to the committed `.bru` files.
5. **Fill in path variables** for whatever you're calling (`workbookId`,
   `connectorAccountId`, ...). These are plain environment variables you can edit
   in the same environment editor. See [Path variables](#path-variables) below.

### Sanity check

- `System / Health Check` (`GET /health`) → `200` even without a token (confirms
  the host/routing is right for the selected environment).
- `Users / Current User` (`GET /users/current`) → `200` with your user — confirms
  your `apiToken` and the header format are correct.

## Environments

| Environment | `baseUrl`                      |
| ----------- | ------------------------------ |
| Local       | `http://localhost:3010`        |
| Test        | `https://test-api.scratch.md`  |
| Production  | `https://api.scratch.md`       |

The server has **no global path prefix and no API versioning** — routes are
served at the root (e.g. `{{baseUrl}}/workbook`, `{{baseUrl}}/users/current`).

## Authentication

All requests inherit a single collection-level header (defined in
`collection.bru`):

```
Authorization: API-Token {{apiToken}}
```

- The prefix is exactly `API-Token ` (capital `A`, capital `T`, one trailing
  space). The token is a bare 32-character string — **no `Bearer`, no extra
  prefix**.
- This authenticates against `ScratchAuthGuard`, which covers the entire
  user-facing surface.

### How to get an API token

- **From a browser session (recommended):** the web app's *Settings → Developer*
  screen calls `POST /users/current/api-token` and shows you the token. (That
  endpoint is in the `Users` folder here, but it needs an existing Clerk browser
  session, so the UI is the easy path.)
- **Local dev shortcut:** an API token is just a row in the `APIToken` table. You
  can insert one directly against the local database
  (`postgresql://postgres:postgres@localhost:5432/scratchpad`) with a `token`
  string, your `userId`, and a future `expiresAt`.

### Two groups use a different auth pattern

- **`CLI` folder** — the `/cli/v1/*` endpoints additionally require a
  `User-Agent` that identifies a Scratch client. The folder adds
  `User-Agent: Scratch-cli/1.0` for you (via its `folder.bru`). The inherited
  `Authorization` token still applies. Without the User-Agent these routes return
  `401 Invalid User-Agent`.
- **`Internal - Whalesync` folder** — the `/internal/whalesync/*` endpoints are a
  server-to-server admin channel. They are **not** authenticated by the API
  token; they use a shared secret header `X-Scratch-Admin-Token: {{adminToken}}`
  (added by the folder's `folder.bru`). Set the secret `adminToken` variable to
  the server's `SCRATCH_ADMIN_API_KEY`. These endpoints act on the user named in
  the request body, not on a session.
- **`Scratch Git Service - Run Store` folder** — not the Scratch server at all: the
  Live Export run store endpoints on the **scratch-git service** (`:3100`,
  `{{scratchGitApiUrl}}`), which only the server calls in production. The folder
  overrides the collection header with `Authorization: Bearer {{scratchGitAuthToken}}`
  — set the secret `scratchGitAuthToken` to scratch-git's `SCRATCH_GIT_AUTH_TOKEN`
  (empty locally). For Test/Production, open the tunnel first
  (`terraform/tools/connect_to_git_service.sh <env>`, which forwards `127.0.0.1:3100`).
  Set `runStoreKey` to `le-<routineRunId>`. See `scratch-git-2/docs/RUN_STORE.md`.

## Path variables

Requests reference IDs as `{{...}}` variables so you set them once per run. The
common ones are seeded (empty) in each environment; add any others as you need
them:

| Variable               | Used by                                            |
| ---------------------- | -------------------------------------------------- |
| `workbookId`           | most workbook-scoped routes                        |
| `connectorAccountId`   | connections, syncs, publish, generic-api           |
| `dataFolderId`         | data folders, files, publish records               |
| `syncId`               | syncs                                              |
| `jobId`                | jobs, publish                                      |
| `scheduleId`           | schedules                                          |
| `draftId`              | sync drafts                                        |
| `pipelineId` / `planId`| publish pipeline                                   |
| `scratchGitApiUrl`     | scratch-git service base URL (run store folder)    |
| `runStoreKey`          | `le-<routineRunId>` run store key (run store folder) |

Other one-off IDs (`permissionId`, `inviteId`, `folderId`, `runId`, `service`,
`installId`, `tableId`, ...) appear as `{{...}}` in the specific requests that
need them — either add them to the environment or replace them inline in the URL.

## What's covered — and what isn't

**Covered:** every REST endpoint reachable with an API token — System/health,
Users, Workbooks, Data Folders, Files, Connections, Connectors, Syncs,
Transformers, Sync Drafts, Publish, Schema Builder, Schedules, Routines, Jobs,
Scratch Git, OAuth, Payments — plus the `CLI` (`/cli/v1/*`) operations, the
`Internal - Whalesync` admin channel, and the scratch-git service's Live Export run
store endpoints (`Scratch Git Service - Run Store`).

**Intentionally excluded** (not plain token-authenticated REST):

- **Webhooks** — `POST /payment/webhook` (Stripe), `POST /connectors/shopify/webhooks`
  (Shopify). HMAC/signature-verified; can't be exercised with a token.
- **MCP** — `/mcp` (JSON-RPC + SSE) and `/mcp-auth/*` / `/.well-known/*` (OAuth).
  Not a REST surface.
- **Git HTTP proxies** — `/scratch-git/:id/git-service/*` and the
  `/cli/v1/.../git/*` proxies. These speak the git smart-HTTP protocol, not JSON.
- **Other internal/admin controllers** — `dev-tools`, `code-migrations`, `cron`,
  `workers`. Admin-gated and/or mounted only on specific services.

## Notes

- Request bodies are filled from `server/src/assets/api-reference.md` and the zod
  DTOs in `@spinner/shared-types`. They are examples, not generated output, and
  can drift as DTOs change — treat this as a hand-maintained tool.
- Optional query parameters are included but **disabled** (shown with a `~`
  prefix in Bruno) so you can see what's available without sending them.

## Headless runs (optional)

```
cd tools/bruno
npx @usebruno/cli run System --env Local        # run one folder
npx @usebruno/cli run --env Local               # run everything (most mutating
                                                # requests need real IDs first)
```
