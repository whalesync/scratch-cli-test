# `sync-bruno-collection` — reference

Everything the skill needs to map a server route to its place in the Bruno collection and to write a well-formed `.bru` file. Load this before Step 2.

## 1. Folder → controller map

Each collection folder under `tools/bruno/` is fed by one or more controllers under `server/src/`. Use this to find the target folder for a changed endpoint.

| Bruno folder | Fed by controller(s) |
| --- | --- |
| `System` | `health/health.controller.ts`, `discover/discover.controller.ts`, `desktop-release/desktop-release.controller.ts` |
| `Users` | `users/users.controller.ts`, `bug-report/bug-report.controller.ts` |
| `Workbooks` | `workbook/workbook.controller.ts` |
| `Data Folders` | `workbook/data-folder.controller.ts` |
| `Files` | `workbook/files.controller.ts`, `workbook/files-public.controller.ts` |
| `Connections` | `remote-service/connector-account/connector-account.controller.ts` (+ generic-api probe/reprobe) |
| `Connectors` | `remote-service/connectors/connectors-metadata.controller.ts`, `remote-service/connectors/library/generic-api/generic-api.controller.ts` (public routes) |
| `Syncs` | `sync/sync.controller.ts` |
| `Transformers` | `sync/transformers/transformer.controller.ts` |
| `Sync Drafts` | `sync-draft/sync-draft.controller.ts` |
| `Publish` | `publish-plan/publish-plan.controller.ts` |
| `Schema Builder` | `schema-builder/schema-builder.controller.ts` |
| `Schedules` | `schedule/schedule.controller.ts` |
| `Routines` | `routine/routine.controller.ts` |
| `Jobs` | `job/job.controller.ts` |
| `Scratch Git` | `scratch-git/scratch-git.controller.ts` (JSON routes only; the git-HTTP proxy routes are excluded — see §2) |
| `OAuth` | `oauth/oauth.controller.ts`, `oauth-install/oauth-install.controller.ts` |
| `Payments` | `payment/payments-public.controller.ts`, `payment/payment.controller.ts` (non-webhook routes only) |
| `CLI` | `cli/cli-auth.controller.ts`, `cli/cli-connection.controller.ts`, `cli/cli-linked.controller.ts`, `cli/cli-sync.controller.ts`, `cli/cli-workbook.controller.ts`, `cli/upload-patch.controller.ts` |
| `Internal - Whalesync` | `internal/whalesync.controller.ts` |

If a **new controller** appears that maps to none of these folders, report it and propose a new folder (with a `folder.bru`) rather than forcing it into an unrelated one.

## 2. Excluded surfaces — skip these (with the reason to log)

| Surface | Where | Why excluded |
| --- | --- | --- |
| Stripe / Shopify webhooks | `payment/payment.webook.controller.ts`, `remote-service/connectors/library/shopify/controllers/shopify-webhooks.controller.ts` | HMAC-signed, not API-Token auth |
| MCP transport + OAuth | `mcp/mcp.controller.ts`, `mcp/mcp-auth/mcp-oauth.controller.ts` | JSON-RPC/SSE + OAuth, not plain REST |
| Git-HTTP proxies | routes like `.../git/*path`, `git-service/*` (inside `scratch-git.controller.ts` and elsewhere) | Raw git transport, not JSON |
| Internal/admin tools | `dev-tools/dev-tools.controller.ts`, `code-migrations/code-migrations.controller.ts`, `cron/cron.controller.ts`, `cron/cron-debug.controller.ts`, `worker/test/workers.controller.ts` | Internal/admin, out of the token-accessible surface |

A route in one of these is never added to the collection; note it as "skipped (excluded: <reason>)" in the report.

## 3. Route → URL rule

The server has **no global prefix and no API versioning** (`server/src/main.ts`). So:

1. Full path = class-level `@Controller('<prefix>')` + method-level `@Verb('<subpath>')`, joined with a single `/` (either part may be empty).
2. Replace each `:param` segment with `{{param}}` (Bruno variable interpolation), e.g. `:id` → `{{workbookId}}` where the collection's convention names it (see the existing `.bru` files / `README.md` for the canonical var name — `workbook` routes use `{{workbookId}}`, syncs use `{{syncId}}`, etc.).
3. Prefix with `{{baseUrl}}`.

Examples:
- `@Controller('workbook')` + `@Get()` → `{{baseUrl}}/workbook`
- `@Controller('workbook')` + `@Patch(':id')` → `{{baseUrl}}/workbook/{{workbookId}}`
- `@Controller('workbooks/:workbookId/syncs')` + `@Post(':syncId/run')` → `{{baseUrl}}/workbooks/{{workbookId}}/syncs/{{syncId}}/run`

## 4. `.bru` file templates

The `.bru` format is a line-oriented block DSL (not JSON/YAML). Block order in a request file: `meta` → verb block → `headers` (only if needed) → `body:json` / `params:query` (as needed) → `docs`. Two-space indentation. Files end with a newline.

### 4a. GET (with optional, disabled query params)

```
meta {
  name: List Workbooks
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/workbook
  body: none
  auth: inherit
}

params:query {
  ~connectorAccountId: {{connectorAccountId}}
  ~sortBy: updatedAt
  ~sortOrder: desc
  ~managedBy:
}

docs {
  Returns all workbooks for the authenticated user. Optional filters described here.
}
```

- `auth: inherit` is a single line **inside** the verb block — it pulls in the collection-level `Authorization` header. Never add a separate `auth { }` block or re-declare `Authorization`.
- Optional query params are prefixed `~` (disabled — discoverable but not sent). A value-less param is just `~name:`.
- Omit the `params:query` block entirely if the route takes no query params.

### 4b. POST / PATCH (with a JSON body)

```
meta {
  name: Create Workbook
  type: http
  seq: 2
}

post {
  url: {{baseUrl}}/workbook
  body: json
  auth: inherit
}

headers {
  Content-Type: application/json
}

body:json {
  {
    "name": "My Workbook",
    "tables": [
      {
        "connectorAccountId": "{{connectorAccountId}}",
        "tableId": "tbl_abc"
      }
    ]
  }
}

docs {
  Creates a new workbook. Body shape derived from the request DTO / api-reference.md.
}
```

- `body: json` in the verb block **and** a `body:json { … }` block holding raw JSON (with `{{var}}` interpolation allowed inside).
- Add the `headers { Content-Type: application/json }` block **only** for JSON bodies.
- Use `patch` in place of `post` for PATCH routes; everything else is identical.

### 4c. DELETE (no body)

```
meta {
  name: Delete Workbook
  type: http
  seq: 6
}

delete {
  url: {{baseUrl}}/workbook/{{workbookId}}
  body: none
  auth: inherit
}

params:query {
  ~force: false
}

docs {
  Deletes a workbook. Returns 204.
}
```

### 4d. `folder.bru` (only when adding a brand-new folder)

Plain folder — just orders it in the sidebar (`seq` = next free folder number; the two auth-special folders stay last at 19/20):

```
meta {
  name: My New Group
  seq: 21
}
```

A folder that must inject an extra header for **every** request inside it (like `CLI` / `Internal - Whalesync`) adds a `headers` block — but this is rare; only do it when a whole controller group shares a non-default auth/UA requirement:

```
meta {
  name: CLI
  seq: 19
}

headers {
  User-Agent: Scratch-cli/1.0
}

docs {
  Folder-level header applied to every request inside.
}
```

## 5. Shared path variables

URLs interpolate these (declared as empty `vars` in each `environments/*.bru`; the developer fills them per-run — the collection does no chaining): `workbookId`, `connectorAccountId`, `dataFolderId`, `syncId`, `jobId`, `scheduleId`, `draftId`, `pipelineId`, `planId`, plus per-route ids like `permissionId`, `inviteId`, `syncId`, `routineId`. Reuse an existing var name when one fits; if a new high-frequency id appears, note it (the README lists the full set) rather than inventing inconsistent names.
