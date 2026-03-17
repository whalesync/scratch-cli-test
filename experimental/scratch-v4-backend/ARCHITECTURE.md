# Scratch v4 Backend — Architecture & Experiment Log

> **Status:** Active — March 2026
> **Goal:** Move business logic out of the NestJS server and into a Rust binary (`scratchmd`) that runs in both CLI mode (user's machine) and backend mode (CGI server). The existing NestJS server survives and continues to own auth, jobs, web UI APIs, and orchestration. New backend code lives in `/experimental/scratch-v4-backend` — do not touch the current `/server/src` code.
>
> **This file lives in `/experimental/scratch-v4-backend/ARCHITECTURE.md`** — it is the working log for the experiment. The original design doc is at `/docs/rust-edge-architecture-plan.md`.

---

## Table of Contents

1. [Motivation](#motivation)
2. [What Stays vs. What Changes](#what-stays-vs-what-changes)
3. [The `scratchmd` Binary](#the-scratchmd-binary)
4. [Repository Object Model](#repository-object-model)
5. [Directory Structures](#directory-structures)
6. [Local Git Worktree Model](#local-git-worktree-model)
7. [Agent Sessions and the Materialized Dirty Branch](#agent-sessions-and-the-materialized-dirty-branch)
8. [Phase Migration Plan](#phase-migration-plan)
9. [Milestone 1 — Complete](#milestone-1--complete)
10. [Milestone 2 — Sync, Push, Publish](#milestone-2--sync-push-publish)
11. [Lessons Learned](#lessons-learned)
12. [Open Questions](#open-questions)
13. [Experimental: Local Runner Mode](#experimental-local-runner-mode)

---

## Motivation

Every meaningful operation in Scratch today flows through a chain:

```
user action
  → NestJS API server (TypeScript, BullMQ job)
    → scratch-git-2 (Rust, port 3100) — file reads/writes
    → Postgres — FileIndex / FileReference lookups
    → external CMS API
```

Costs:
1. **Extra network hops.** sync/publish touches three processes before doing real work.
2. **Index lag.** FileIndex and FileReference live in Postgres, separated from the git data they describe.
3. **Language boundary tax.** Business logic runs in single-threaded Node.js. Rust does the same work 10-100x faster, in parallel.
4. **CLI is a thin HTTP wrapper.** scratch-cli (Go) bounces every operation to the API server. Offline work is impossible.

The fix: a single Rust binary (`scratchmd`) that contains all the business logic and can be invoked as a CLI command, a CGI program, or a long-running HTTP server.

---

## What Stays vs. What Changes

| Component | Fate | Notes |
|-----------|------|-------|
| `/server` (NestJS) | **Stays** | Auth, web UI APIs, workbook/connection CRUD, job queue, connector orchestration |
| `scratch-git-2` | **Replaced** | New `scratchmd` binary handles git + business logic |
| `scratch-cli` (Go) | **Replaced** | New `scratchmd` binary in CLI mode |
| Postgres `FileIndex` / `FileReference` | **Migrated to SQLite** | Co-located with git repos (Phase 2) |
| `/experimental/scratch-v4-backend` | **New** | Clone of relevant server parts — connectors, jobs, poll job. Developed here first. **Do not share types with current `/server/src` code.** |

---

## The `scratchmd` Binary

One Rust binary, two personalities:

### CLI mode
```bash
scratchmd init-repo --path /path/to/repos/orgId/workbookId/connId
scratchmd upsert-files --repo /path/to/repo.git --folder tableId/records --message "pull 2026-03-16"
scratchmd pull --workbook-id <id> --server https://api.scratch.io
scratchmd run-sync [--workspace .] [--sync <name>]
scratchmd push [--workspace .]
scratchmd serve --port 3100 --repos-dir /var/scratch-repos
```

Every operation is directly invokable from the terminal. No HTTP required for local use.

### Backend mode

`scratchmd serve` starts a built-in Axum HTTP server. For Milestone 1 this is the simplest approach — true CGI (fork-per-request via a separate `scratchmd-cgi` binary) can be added later.

### HTTP API surface

```
# Custom operations
POST  /api/repos/init
      body: { path: string }

POST  /api/repos/upsert-files
      body: { repoPath: string, folder: string, message: string,
              files: Array<{ path: string, content: string }> }

POST  /api/repos/rebase-dirty
      body: { repoPath: string }
      response: { commitOid: string, advanced: boolean }

POST  /api/repos/diff
      body: { repoPath: string, baseBranch: string, headBranch: string }
      response: { files: Array<{ path: string, status: "added"|"modified"|"deleted" }> }

POST  /api/repos/read-file
      body: { repoPath: string, branch: string, path: string }
      response: { content: string }

# Raw git protocol (proxied to git http-backend)
GET   /git/{repoPath}/info/refs?service=git-upload-pack
POST  /git/{repoPath}/git-upload-pack
POST  /git/{repoPath}/git-receive-pack
```

### Rust command/module structure

```
scratch-git/src/
  main.rs
  commands/
    init_repo.rs
    upsert_files.rs
    rebase_dirty.rs
    pull.rs              <- clone workbook to local worktree structure
    run_sync.rs          <- apply sync.json to local materialized files
    push.rs              <- commit dirty worktrees + push to remote
  server/
    mod.rs               <- Axum HTTP server + routing
    routes.rs            <- handlers: init, upsert-files, rebase-dirty, diff, read-file
    git_backend.rs       <- proxy requests to system git http-backend subprocess
  git/
    mod.rs               <- gix wrappers: commit, tree read/write, diff
```

---

## Repository Object Model

Three types of JSON objects stored in git repos.

| Object | Location in repo | Notes |
|--------|-----------------|-------|
| **Records** | `{basePath}/{tableName}/{filename}.json` | One file per CMS record. `basePath` e.g. `MyBase`, `tableName` e.g. `Posts`. |
| **Schema** | `.scratch/{basePath}/{tableName}/schema.json` | Generated from CMS field definitions. Read-only. |
| **Syncs** | `syncs/{syncName}.json` | In the workbook-level git repo (not connection repos). Single branch. |

Schemas and records live in **connection repos** (one per CMS connection). Syncs live in the **workbook repo** (one per workbook, shared across connections).

---

## Directory Structures

### Remote (server-side bare repos)

```
{GIT_REPOS_DIR}/
  {orgId}/
    {workbookId}/
      workbook.git          <- workbook-level bare repo (single branch: master)
        syncs/
          my-sync.json
      {connectionId}/
        repo.git            <- connection bare repo (branches: master + dirty)
```

### Local (user's machine after `scratchmd pull`)

```
{workbookName}/
  {connectionName}/          <- materialized DIRTY branch (git worktree)
    {basePath}/
      {tableName}/
        {recordId}.json
      .scratch/
        schema.json          <- read-only
  .scratch/
    workbook/
      .git/                  <- workbook-level repo (cloned bare from server)
      syncs/
        my-sync.json         <- agent edits these
    connections/
      {connectionName}/
        .git/                <- connection bare repo (cloned from server)
        id                   <- connection ID file
        master/              <- materialized MASTER branch (git worktree)
          {basePath}/
            {tableName}/
              {recordId}.json
  CLAUDE.md                  <- auto-generated instructions for agents
```

---

## Local Git Worktree Model

Both dirty and master branches are served from the **same `.git` directory** using `git worktree`.

```
.scratch/connections/{conn}/.git      <- the bare repo (master + dirty branches)
{conn}/                               <- git worktree on dirty branch (user-editable)
.scratch/connections/{conn}/master/   <- git worktree on master branch (read-only)
```

Setup during `scratchmd pull`:
```bash
git clone --bare {scratchmd-url}/git/{repoPath} .scratch/connections/{conn}/.git
git -C .scratch/connections/{conn}/.git worktree add {connDir}/ dirty
git -C .scratch/connections/{conn}/.git worktree add .scratch/connections/{conn}/master/ master
```

---

## Agent Sessions and the Materialized Dirty Branch

| Environment | File access | Why |
|-------------|-------------|-----|
| Cloud backend | Extract blobs on-demand from bare repo via gix | No working directory; stateless; minimal footprint |
| Local agent session | Read/write real filesystem files | AI agents operate on the filesystem |

After `scratchmd pull`, the dirty branch is a real worktree the agent can edit directly. The master branch is also materialized (read-only in practice) under `.scratch/`.

### Agent workflow with syncs

```
1. scratchmd pull              -> local worktrees created
2. Agent edits .scratch/workbook/syncs/posts-sync.json
3. scratchmd run-sync          -> reads source master worktree
                                  applies field mappings
                                  writes to dest dirty worktree
4. scratchmd push              -> commits dirty worktrees
                                  pushes dirty to remote bare repos
5. yarn publish (NestJS)       -> diffs dirty vs master in remote bare repo (by tree hash)
                                  calls Webflow create/update for changed files
```

---

## Phase Migration Plan

| Phase | What | Key benefit |
|-------|------|-------------|
| **M1** (done) | `scratchmd` serve + init + upsert-files + rebase-dirty + git backend proxy + pull. NestJS poll job (Airtable + Webflow). `scratchmd pull` CLI. | End-to-end: poll -> bare repo -> local materialized worktree |
| **M2** (current) | `scratchmd run-sync` + `scratchmd push` + NestJS `yarn publish`. Sync.json format. diff + read-file HTTP endpoints. | End-to-end: edit sync -> transform data -> publish to Webflow |
| **Phase 2** | SQLite index per connection (replaces Postgres FileIndex/FileReference) | Eliminates cross-system joins; enables publish plan in Rust |
| **Phase 3a** | Sync transform step fully in Rust | 20-60x faster; Rayon parallel |
| **Phase 3b** | Publish plan builder in Rust (single-process join against git + SQLite) | No NestJS round-trip |
| **Phase 3c** | Dirty status via SQLite diff instead of tree walk | Sub-millisecond for 100k files |
| **Phase 4** | Local runner mode (WebSocket relay, exclusive ownership sessions) | Air-gapped, offline, zero cloud storage |

---

## Milestone 1 — Complete

### What was built

1. `scratchmd serve` — Axum HTTP server with git backend proxy + custom operations
2. `scratchmd init-repo` — creates bare repo with master + dirty branches
3. `scratchmd upsert-files` — writes files to master branch of a bare repo
4. `scratchmd rebase-dirty` — fast-forwards dirty branch to master (via gix ref transaction)
5. `scratchmd pull` — clones workbook to local disk with dirty + master worktrees
6. NestJS experimental backend — poll job for Airtable + Webflow multi-table
7. Bootstrap commands: `yarn setup`, `yarn poll`, `yarn trigger-pull`, `yarn cleanup`, `yarn clone-repo`

### Commands reference

```bash
# Server side
yarn setup         # wipe + recreate workbook/connections in DB + init git repos
yarn poll          # inline poll (no BullMQ) — Airtable + Webflow
yarn trigger-pull  # enqueue BullMQ poll jobs

# Local CLI
./pull.sh          # scratchmd pull -> creates local workspace in local/cli-v4/

# Repo management
yarn clone-repo    # clone bare repos to local/repos-cloned-v4/
yarn cleanup       # delete all local repos in all 3 local/ subfolders
```

### Environment variables

```
EXP_ORG_ID=exp-org-1
EXP_WORKBOOK_ID=exp-wb-1
EXP_CONN_ID=exp-conn-airtable-1
EXP_WEBFLOW_CONN_ID=exp-conn-webflow-1

AIRTABLE_API_KEY=...
AIRTABLE_BASE_ID=...
AIRTABLE_TABLE_IDS=tblXXX,tblYYY          # comma-separated; filters which tables to poll

WEBFLOW_API_KEY=...
WEBFLOW_COLLECTION_IDS=abc123,def456       # comma-separated; filters which collections to poll

GIT_REPOS_DIR=/Users/.../local/repos-v4
SCRATCHMD_URL=http://localhost:3100
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/scratch4?schema=public
REDIS_URL=redis://localhost:6379
```

---

## Milestone 2 — Sync, Push, Publish

### A. Sync config format (`syncs/*.json` in workbook repo)

Lives in `.scratch/workbook/syncs/` in the local workspace. The agent creates and edits these files. `scratchmd push` commits and pushes them to the workbook bare repo on the server.

```json
{
  "version": 1,
  "displayName": "Posts: Airtable -> Webflow",
  "source": {
    "connection": "Airtable",
    "folder": "MyBase/Posts"
  },
  "destination": {
    "connection": "Webflow",
    "folder": "TestSite/Posts"
  },
  "fieldMappings": [
    { "sourceField": "Name", "destField": "name" },
    { "sourceField": "Post Body", "destField": "post-body" }
  ],
  "recordMatching": {
    "sourceField": "Name",
    "destField": "name"
  }
}
```

**Source files** stored by poll (Airtable): flat JSON object with Airtable field names as keys.
```json
{ "Name": "Hello World", "Post Body": "<p>...</p>" }
```

**Destination files** written by run-sync (Webflow native format expected by `createRecords` / `updateRecords`):
```json
{ "id": "<webflow-item-id-or-empty>", "fieldData": { "name": "Hello World", "post-body": "<p>...</p>" } }
```

### B. `scratchmd run-sync` (Rust CLI)

```bash
scratchmd run-sync [--workspace .] [--sync <syncName>]
```

**Algorithm:**
1. Find workspace root (directory containing `.scratch/workbook/syncs/`)
2. Read sync configs from `.scratch/workbook/syncs/*.json` (or the named one)
3. For each sync:
   - Source path: `{workspace}/.scratch/connections/{source.connection}/master/{source.folder}/`
   - List all `.json` files in source path, parse each one
   - Dest dirty path: `{workspace}/{dest.connection}/{dest.folder}/`
   - List existing dest files, parse them (`{ id, fieldData }`)
   - For each source file: build `fieldData` from `fieldMappings`, find matching dest file via `recordMatching`, write merged file to dest dirty path

**Output file naming:** for new records, use the source filename (e.g. `recXXX.json`). For matched records, keep the existing dest filename.

### C. `scratchmd push` (Rust CLI)

```bash
scratchmd push [--workspace .]
```

**Algorithm:**
1. Find workspace root
2. For each connection in `.scratch/connections/*/`:
   - Read `id` file to identify the connection
   - Dirty worktree is at `{workspace}/{connectionDirName}/`
   - In dirty worktree: `git add -A && git commit -m "scratchmd push {timestamp}"` (skip if nothing to commit)
   - Push: `git -C {workspace}/.scratch/connections/{conn}/.git push origin dirty`
3. For workbook repo (`.scratch/workbook/`):
   - `git commit -am "scratchmd push {timestamp}"` (skip if nothing to commit)
   - `git push origin master`

The `.git` dir was `git clone --bare`'d from the scratchmd HTTP server, so `origin` points there. `git push` goes through `/git/...` which proxies to `git http-backend`.

### D. scratchmd HTTP API additions (for NestJS publish)

```
POST /api/repos/diff
  body:     { repoPath: string, baseBranch: string, headBranch: string }
  response: { files: [{ path: string, status: "added"|"modified"|"deleted" }] }

POST /api/repos/read-file
  body:     { repoPath: string, branch: string, path: string }
  response: { content: string }
```

Both use gix to read directly from the bare repo — no checkout required. `diff` walks both branch trees and compares blob OIDs for each path. `read-file` resolves the path through the branch's tree and reads the blob.

### E. NestJS `yarn publish` command

```bash
cd experimental/scratch-v4-backend && yarn publish-records
```

**Algorithm:**
1. Load workbook + all connector accounts from DB
2. For each connector account:
   a. `scratchGitClient.diff({ repoPath, baseBranch: 'master', headBranch: 'dirty' })`
   b. For each changed file: `scratchGitClient.readFile({ repoPath, branch: 'dirty', path })`
   c. Parse the file as `{ id?, fieldData }` and get the `tableSpec` from `fetchJsonTableSpec`
   d. If file has `id` -> `connector.updateRecords(tableSpec, [file])`, else -> `connector.createRecords(tableSpec, [file])`
   e. For creates: write the returned `id` back into dirty via `upsertFiles`
3. `rebaseDirty` on the connector repo so master catches up to dirty

**Filter:** publish only files that differ between dirty and master (blob OID comparison — no content diffing). Same OID = unchanged = skip.

---

## Lessons Learned

### 1. `esModuleInterop: true` required for lodash default imports

The experimental tsconfig was missing `esModuleInterop: true` (the main server has it). Without it, `import _ from 'lodash'` compiles to `lodash_1.default` which is `undefined` for CommonJS modules. `allowSyntheticDefaultImports: true` only affects type checking, not runtime behavior.

**Fix:** Add `"esModuleInterop": true` to `tsconfig.json`.

### 2. git HTTP backend: GIT_PROJECT_ROOT + PATH_INFO only — never set GIT_DIR

Setting both `GIT_DIR` and `GIT_PROJECT_ROOT` in the git http-backend CGI env causes 404s. The correct setup:
- `GIT_PROJECT_ROOT = {repos-dir}` (absolute path to repos root)
- `PATH_INFO = /{relative/repo/path}` (path to the `.git` dir, relative to repos root)
- `GIT_HTTP_EXPORT_ALL = 1`
- Do NOT set `GIT_DIR`

### 3. BullMQ `job.updateProgress()` crashes

`job.updateProgress()` throws `"Cannot read properties of undefined (reading 'get')"` in certain BullMQ versions when called inside a worker. Fix: remove `job.updateProgress()` entirely. Use direct Prisma updates for progress tracking instead. Also wrap the entire checkpoint callback body in try/catch so progress failures never kill the job.

### 4. Airtable record shape from `listRecords`

Raw Airtable records have `{ id: "recXXX", fields: { "Name": "...", ... } }`. The poll job stores only the `fields` object: `JSON.stringify(f.fields ?? f, null, 2)`. So files in git are flat: `{ "Name": "...", ... }`. Use `f.id` for the filename (not `f.filename`).

### 5. Webflow ECOMMERCE collections filtered from `listTables`

Collections with slugs in `WEBFLOW_ECOMMERCE_COLLECTION_SLUGS` (`['products', 'categories', 'skus']`) are silently skipped in `listTables`. Intentional — ecommerce collections use a different Webflow API.

### 6. Use env vars to filter collections/tables, not code

- `AIRTABLE_TABLE_IDS=tblXXX,tblYYY` — comma-separated filter applied on top of `listTables`
- `WEBFLOW_COLLECTION_IDS=abc,def` — same pattern

Filter: `remoteId.some((id) => filter.includes(id))` — works for both single and compound remote IDs.

### 7. No BullMQ jobs for experiment commands — everything is a `yarn` command

BullMQ jobs are harder to develop and debug. For the experiment, all operations are implemented as inline NestJS bootstrap commands in `bootstrap-command.ts`. Jobs can be added later when the patterns stabilize.

### 8. Folder paths include the base name

Airtable's `tableSpec.basePath` is an array of path segments above the table (e.g. `['MyBase']`). Full folder path: `/{basePath...}/{tableName}/`. Schema files: `.scratch/{basePath...}/{tableName}/schema.json`.

---

## Open Questions

1. **Publish idempotency.** If `yarn publish-records` runs twice, creates become updates only if the Webflow ID was written back to the dirty file after first publish. Need to confirm this write-back step works before the second run.

2. **Sync record filename for new records.** Currently uses source filename (e.g. Airtable `recXXX.json`). After publish, Webflow returns a new `id`. Rename the file to Webflow ID, or keep Airtable ID and store Webflow ID inside?

3. **`scratchmd push` with nothing to commit.** `git commit` fails if the worktree is clean. Need to check `git status --porcelain` first and skip the commit step.

4. **Workbook repo single branch.** The workbook repo has only `master` (no dirty). Sync configs committed directly. Should we add a dirty branch here too for agent-proposed sync changes?

5. **Lookup transformer and cross-connection reads.** The `lookup` transformer reads from another connection's repo. Safe to require that lookup targets always be on `master`?

---

## Experimental: Local Runner Mode

> **Highly experimental, optional.** Build after Phases 1-3 are stable.

Most users are behind NAT. The API server cannot initiate a connection to `192.168.1.42:3100`. Solution: the user's machine opens a persistent outbound WebSocket to the API server. The API server sends job dispatch messages down this connection. Same model as GitLab self-hosted runners and Cloudflare Tunnel.

```
scratch serve
  -> authenticate (same OAuth as CLI)
  -> open WebSocket to wss://api.scratch.io/runner
  -> register as runner for workbook W

API server (cron fires for W):
  -> check runner registry: W has active runner
  -> send over WebSocket: { type: "run-sync", jobId: "xyz", payload: {...} }

User's machine:
  -> receive job
  -> run sync against local materialized dirty worktree
  -> respond: { type: "sync-result", jobId: "xyz", result: {...} }
```
