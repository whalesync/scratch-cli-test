# Plan: CLI V2 Workbook Support

## Context

V2 workbooks use per-connector git repos (`repos-v2/{orgId}/{workbookId}/{connectorAccountId}.git`) instead of V1's single repo per workbook (`repos/{workbookId}.git`). The CLI's `workbook init`, `files download`, and `files upload` commands all fail for V2 workbooks because:

1. The server's CLI git proxy (`cli-workbook.controller.ts:153`) hardcodes V1 paths: `${gitBackendUrl}/${workbookId}.git`
2. The CLI has zero awareness of V2 repos or connector accounts
3. The Rust backend (`scratch-git-2/state.rs`) has V2 routing prepared but commented out

Recent commits (`79995f7b`, `1b9b01af`, `1eb5e45f`, `f1382411`) fixed `repoId` references throughout server services but did **not** touch the CLI endpoints or the CLI tool itself.

## Design Decision: One Local Directory Per Connector

For V2 workbooks, each connector account gets its own subdirectory with its own `.git`. This is necessary because each connector is a separate git repo on the server.

**V1 layout (unchanged):**
```
MyWorkbook/
  .git/
  .scratchmd          # version: "1"
  Products/
    .scratchmd        # dataFolder marker
    record1.md
```

**V2 layout (new):**
```
MyWorkbook/
  .scratchmd          # version: "2", no .git here
  Airtable - Marketing/
    .git/             # clone of connector's V2 repo
    .scratchmd        # connector marker (connector.id, connector.displayName)
    Products/
      .scratchmd      # dataFolder marker
      record1.md
  Webflow - Blog/
    .git/
    .scratchmd
    Blog Posts/
      .scratchmd
      post1.md
```

---

## Step 1: Server — Expand `GET /cli/v1/workbooks/:id` Response

**Files:**
- `server/src/cli/cli-workbook.controller.ts`
- `server/src/cli/dtos/cli-workbook.dto.ts`

**Changes:**
- Add `CliConnectorAccountDto` with fields: `id`, `displayName`, `service`, `gitUrl`, `dataFolders`
- Add `version` and `connectorAccounts` fields to `CliWorkbookResponseDto`
- Inject `DbService` into `CliWorkbookController`
- In `getWorkbook()`, load connector accounts for V2 workbooks from DB
- In `toCliResponse()`, populate `connectorAccounts` with per-connector `gitUrl` values formatted as: `{baseUrl}/cli/v1/workbooks/{wbId}/connectors/{caId}/git`
- For V2: set top-level `gitUrl` to empty/omitted, nest `dataFolders` under their connector accounts

## Step 2: Server — Add V2 Git Proxy Route

**File:** `server/src/cli/cli-workbook.controller.ts`

**Changes:**
- Inject `ScratchGitService` into `CliWorkbookController`
- Add new route: `@All(':id/connectors/:connectorAccountId/git/*path')`
  - Verifies workbook access
  - Calls `scratchGitService.resolveRepoId(workbookId, connectorAccountId)` to get composite repoId
  - Proxies to `${gitBackendUrl}/${repoId}.git${gitPath}`
  - Reuses existing proxy streaming logic (extract into shared helper)
- Update existing `gitProxy` to return 400 for V2 workbooks with a message directing to the per-connector URL

## Step 3: Rust Backend — Activate V2 Repo Routing

**Files:**
- `scratch-git-2/src/state.rs`
- `scratch-git-2/src/routes/smart_http.rs`
- `scratch-git-2/src/routes/manage.rs`
- `scratch-git-2/src/git/repo.rs`

**Changes:**
- Uncomment `V2_ID_SEPARATOR` and `repo_path_v2()` in `state.rs`
- Add `resolve_repo_path(repo_id)` that detects `--` separator and routes to V1 or V2 path
- Update `smart_http.rs` `git_backend` handler to use `resolve_repo_path` and adjust `GIT_PROJECT_ROOT`/`PATH_INFO` for nested V2 paths
- Update `manage.rs` handlers (`init_repo`, `delete_repo`, `exists`, `count_objects`, `gc`) to use `resolve_repo_path`
- Ensure `repos-v2/` directory is created at startup

## Step 4: CLI — Update API Types

**File:** `scratch-cli/internal/api/client_workbooks.go`

**Changes:**
- Add `Version int` field to `Workbook` struct
- Add `ConnectorAccount` struct with `ID`, `DisplayName`, `Service`, `GitUrl`, `DataFolders`
- Add `ConnectorAccounts []ConnectorAccount` field to `Workbook` struct

## Step 5: CLI — Update Marker Types and `workbook init`

**File:** `scratch-cli/internal/cmd/workbooks.go`

**Changes:**
- Add `ConnectorMarker` struct with `Workbook` (ID/Name) and `Connector` (ID/DisplayName/Service) sections
- In `runWorkbooksInit()`, branch on `workbook.Version >= 2`:
  - Create workbook root directory with version "2" `.scratchmd` marker (no `.git`)
  - For each `ConnectorAccount`:
    - Create subdirectory named after `DisplayName` (sanitized for filesystem)
    - Clone connector's `GitUrl` into that subdirectory targeting `refs/heads/dirty`
    - Write connector-level `.scratchmd` marker
    - Create data folder markers inside the connector subdirectory
  - Handle zero connectors gracefully (create root + print "add a connection first")

## Step 6: CLI — Update `files download` and `files upload`

**File:** `scratch-cli/internal/cmd/files.go`

**Changes:**
- Extract core download logic (lines 194-399) into `downloadForDirectory(dir, creds)` helper
- Extract core upload logic (lines 474-757) into `uploadForDirectory(dir, creds)` helper
- Add `loadConnectorMarker(dir)` function to detect connector-level markers
- Add `findConnectorDirectories(workbookDir)` to scan for connector subdirectories
- Update `runFilesDownload`:
  - If workbook marker is version "2" and we're at root, iterate all connector subdirectories and call `downloadForDirectory` for each
  - If we're inside a connector subdirectory, call `downloadForDirectory` for just that directory
- Same pattern for `runFilesUpload`

## Step 7: CLI — Edge Cases

**File:** `scratch-cli/internal/cmd/files.go` and `workbooks.go`

- **New connector after init:** On download from workbook root, fetch current workbook metadata, detect missing connector subdirectories, clone them
- **Removed connector:** Warn about orphaned subdirectories but don't auto-delete
- **Name collisions:** Sanitize connector display names and append suffix for duplicates

---

## Verification

1. **Server endpoints:** `curl` the expanded `GET /cli/v1/workbooks/:id` for a V2 workbook and verify `version`, `connectorAccounts`, and per-connector `gitUrl` fields
2. **Rust backend:** Create a V2 repo via the manage API using a composite ID, verify it's created at the correct nested path
3. **CLI init V1:** `scratchmd workbooks init <v1-id>` still works as before
4. **CLI init V2:** `scratchmd workbooks init <v2-id>` creates the nested connector directory structure with correct markers
5. **CLI download/upload V2:** `scratchmd files download` from within a V2 workbook root syncs all connectors; from within a connector subdirectory syncs just that one
6. Run `yarn build`, `yarn lint`, `yarn format` from repo root
