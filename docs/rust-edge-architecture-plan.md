# Rust Edge Architecture Plan

> **Status:** Active — March 2026
> **Goal:** Move business logic out of the NestJS server and into a Rust binary (`scratchmd`) that runs in both CLI mode (user's machine) and backend mode (CGI server). The existing NestJS server survives and continues to own auth, jobs, web UI APIs, and orchestration. New backend code lives in `/experimental/scratch-v4-backend` — do not touch the current `/server/src` code.

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
9. [Milestone 1 — Concrete Implementation Plan](#milestone-1--concrete-implementation-plan)
10. [Open Questions](#open-questions)
11. [Experimental: Local Runner Mode](#experimental-local-runner-mode)

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
| `/server` (NestJS) | **Stays** | Auth, web UI APIs, workbook/connection CRUD, BullMQ job queue, connector orchestration |
| `scratch-git-2` | **Replaced** | New `scratchmd` binary handles git + business logic |
| `scratch-cli` (Go) | **Replaced** | New `scratchmd` binary in CLI mode |
| Postgres `FileIndex` / `FileReference` | **Migrated to SQLite** | Co-located with git repos (Phase 2) |
| `/experimental/scratch-v4-backend` | **New** | Clone of relevant server parts — connectors, jobs, poll job. Developed here first. **Do not share types with current `/server/src` code. Put potentially shared types in `/server/to-be-shared-types/`.** |

---

## The `scratchmd` Binary

One Rust binary, two personalities:

### CLI mode
```bash
scratchmd init-repo --path /path/to/repos/orgId/workbookId/connId
scratchmd upsert-files --repo /path/to/repo.git --folder tableId/records --message "pull 2026-03-16"
scratchmd pull --workbook-id <id> --server https://api.scratch.io
scratchmd serve --port 3100 --repos-dir /var/scratch-repos
```

Every operation is directly invokable from the terminal. No HTTP required for local use.

### Backend mode

`scratchmd serve` starts a built-in Axum HTTP server. For Milestone 1 this is the simplest approach — true CGI (fork-per-request via a separate `scratchmd-cgi` binary) can be added later. The interface design follows CGI principles (each operation is discrete and stateless) but we run as a long-lived process.

The server exposes two surfaces:
1. **Custom operations** (`/api/...`) — our business logic
2. **Raw git protocol** (`/git/...`) — proxied to the system `git http-backend` subprocess, enabling `git clone`, `git fetch`, `git push`

### HTTP API surface

```
# Custom operations
POST  /api/repos/init
      body: { path: string }

POST  /api/repos/upsert-files
      body: { repoPath: string, folder: string, message: string,
              files: Array<{ path: string, content: string }> }

# Raw git protocol (proxied to git http-backend)
GET   /git/{repoPath}/info/refs?service=git-upload-pack
POST  /git/{repoPath}/git-upload-pack
POST  /git/{repoPath}/git-receive-pack
```

### Rust crate structure

```
/scratchmd/                    ← new top-level Rust project (separate from scratch-git-2)
  Cargo.toml
  src/
    main.rs                    ← parse args, dispatch to command or serve
    commands/
      init_repo.rs             ← initialize a bare git repo at a path
      upsert_files.rs          ← upsert files into master branch
      pull.rs                  ← clone a workbook to local worktree structure
    server/
      mod.rs                   ← Axum HTTP server + routing
      git_backend.rs           ← proxy requests to system git http-backend subprocess
    git/
      mod.rs                   ← gix wrappers: commit, tree read/write, worktree setup
```

---

## Repository Object Model

Three types of JSON objects stored in git repos. All use the **same format as the current product** — no schema changes at the record level.

| Object | Location in repo | Notes |
|--------|-----------------|-------|
| **Records** | `{tableId}/records/{filename}.json` | One file per CMS record |
| **Schema** | `{tableId}/.scratch/schema.json` | Generated from CMS field definitions. Read-only for agents and CLI. |
| **Syncs** | `syncs/{syncId}.json` | In the workbook-level git repo (not connection repos). Single branch. Committed on every change. |

Schemas and records live in **connection repos** (one per CMS connection). Syncs live in the **workbook repo** (one per workbook, shared across connections). The workbook repo has a single branch — no dirty/master split.

---

## Directory Structures

### Remote (cloud storage)

```
{GIT_REPOS_DIR}/
  {orgId}/
    {workbookId}/
      {connectionId}/
        repo.git          ← bare git repo (master + dirty branches)
        index.db          ← SQLite file index (Phase 2 — not Milestone 1)
```

Flat and simple. One bare repo per connection. SQLite index sits alongside for co-location.

### Local (user's machine after `scratchmd pull`)

The user sees a clean directory tree with no visible git internals:

```
{workbookName}-{workbookId}/
  {connectionName}-{connectionId}/      ← materialized DIRTY branch (git worktree)
    {tableId}/
      records/
        record-abc.json
        record-def.json
      .scratch/
        schema.json                     ← read-only
  .scratch/                             ← all git plumbing hidden here
    workbook/
      .git/                             ← workbook-level git repo (single branch)
      syncs/
        my-sync.json
    connections/
      {connectionName}-{connectionId}/
        .git/                           ← connection git repo
        index.db                        ← SQLite index (Phase 2)
        master/                         ← materialized MASTER branch (git worktree)
          {tableId}/
            records/
              record-abc.json
          .scratch/
            schema.json
```

**What the user sees:** just `workbookName/connectionName/tableId/records/*.json`. Normal files.

**What agents see:** the same clean tree. An agent edits records in `{connId}/{tableId}/records/`. It reads published state from `.scratch/connections/{connId}/master/`. It edits sync configs in `.scratch/workbook/syncs/`.

---

## Local Git Worktree Model

Both the dirty branch and the master branch are served from the **same `.git` directory** using `git worktree`. One git repo per connection, two materialized views.

```
.scratch/connections/{connId}/.git      ← the repo (contains: master branch, dirty branch)

{connId}/                               ← git worktree → dirty branch
.scratch/connections/{connId}/master/   ← git worktree → master branch
```

Setup during `scratchmd pull`:

```bash
# 1. Clone the bare repo from scratchmd server
git clone --bare {scratchmd-url}/git/{encodedRepoPath} \
    .scratch/connections/{connId}/.git

# 2. Add dirty worktree at top-level connection directory
git -C .scratch/connections/{connId}/.git \
    worktree add {abs-workbook-path}/{connId}/ dirty

# 3. Add master worktree under .scratch
git -C .scratch/connections/{connId}/.git \
    worktree add {abs-workbook-path}/.scratch/connections/{connId}/master/ master
```

If `dirty` branch does not exist yet on a fresh repo, create it from master:
```bash
git -C .git worktree add -b dirty ../{connId}/ master
```

After setup, editing `{connId}/tableId/records/record.json` is a direct filesystem write on the dirty worktree. `git status` works normally inside the worktree.

### Locally, master === merge_base

In normal operation (no active pull or push), master and dirty share the same ancestor commit:

```
master ──→ commit A
dirty  ──→ commit A  (+ uncommitted or committed local edits on dirty branch)
```

Master advances only when a pull completes. Dirty diverges only when the user makes local edits. During an active pull: master advances to commit B, dirty gets rebased onto B. During an active push: dirty commits are applied to the CMS; on success dirty is merged into master.

This invariant simplifies diffs: `git diff master..dirty` always shows exactly "what the user has changed since last pull."

---

## Agent Sessions and the Materialized Dirty Branch

### The fundamental asymmetry

| Environment | File access | Why |
|-------------|-------------|-----|
| Cloud backend | Extract blobs on-demand from bare repo via gix | No working directory; stateless; minimal footprint |
| Local agent session | Read/write real filesystem files | AI agents operate on the filesystem — they cannot read git objects |

### Dirty branch is always materialized locally

After `scratchmd pull`, the dirty branch is a real worktree the agent can edit directly. The master branch is also materialized (read-only in practice) under `.scratch/`. Agents can read published state without any git commands.

### How agent edits become commits

**Default: filesystem watcher + auto-commit**

`scratchmd watch` (or built into `scratchmd serve` in local mode) uses the `notify` crate to watch dirty worktrees and auto-commits after a brief idle window:

```
agent saves {connId}/tableId/records/hello-world.json
  → watcher fires after ~2s idle
  → scratchmd: git add + git commit in dirty worktree
  → (Phase 2) SQLite index updated
```

Many small commits — squashed on `scratchmd push-remote`. Agents that cooperate can call `scratchmd commit` explicitly for cleaner history.

### Instructions for agents (auto-generated CLAUDE.md)

`scratchmd pull` writes a `CLAUDE.md` at the workbook root:

```markdown
# Scratch Workbook

Record files are in `{connId}/{tableId}/records/`. Edit them directly.
Changes are auto-committed to the dirty branch.

To read a published (master) record:
  cat .scratch/connections/{connId}/master/{tableId}/records/{id}.json

Sync configs are in `.scratch/workbook/syncs/`. Edit as JSON.
Schema files (`schema.json`) are read-only — do not edit.

To see unpublished changes:
  scratchmd diff

Do NOT edit anything inside `.scratch/connections/*/\.git/`.
```

### Custom transformer scripts

```
.scratch/workbook/
  transformers/
    slugify-title.rhai        ← Rhai (default embedded scripting)
    combine-fields.py         ← any language: subprocess stdin/stdout JSON protocol
```

Non-Rhai scripts run as subprocesses. The engine pipes a JSON record to stdin and reads the transformed record from stdout — same pattern as git clean/smudge filters. Any language works without changing the engine binary.

---

## Phase Migration Plan

| Phase | What | Key benefit |
|-------|------|-------------|
| **M1** | `scratchmd` (init + upsert-files + HTTP server + git backend proxy), experimental NestJS backend (connectors + poll job), `scratchmd pull` CLI command | End-to-end: Airtable pull → bare repo → local materialized worktree |
| **Phase 2** | SQLite index per connection (replaces Postgres FileIndex/FileReference) | Eliminates cross-system joins; enables publish plan in Rust |
| **Phase 3a** | Sync transform step in Rust (`POST /api/sync/run`) | 20-60x faster; Rayon parallel; no paged HTTP loop |
| **Phase 3b** | Publish plan builder in Rust | Single-process join against git + SQLite |
| **Phase 3c** | Dirty status via SQLite diff instead of tree walk | Sub-millisecond for 100k files |
| **Phase 3d** | Schema validation in Rust (shared crate, available in CLI offline) | No server round-trip for validation |
| **Phase 4** | Local runner mode (WebSocket relay, exclusive ownership sessions) | Air-gapped, offline, zero cloud storage |

---

## Milestone 1 — Concrete Implementation Plan

### What we are building

A fully runnable end-to-end slice that proves the architecture:

1. `scratchmd serve` — starts the HTTP server (git backend + custom operations)
2. Existing `yarn dev` — NestJS server (auth, web UI, unchanged)
3. `yarn experimental-setup` — creates workbook + connection in DB, calls scratchmd to init the repo
4. `yarn experimental-trigger-pull` — enqueues a BullMQ poll job that fetches Airtable records and streams them to scratchmd
5. `scratchmd pull` — clones the workbook to local disk with the correct worktree structure

**Verification:**
- Remote: `{GIT_REPOS_DIR}/{orgId}/{workbookId}/{connId}/repo.git` exists, has a `master` branch with Airtable records as JSON files
- Local: `{workbookName}-{workbookId}/{connName}-{connId}/{tableId}/records/*.json` are visible and readable as normal files, no git knowledge required

---

### A. Rust binary: `/scratchmd/`

New project at the monorepo root. **Do not modify `scratch-git-2`.**

#### `init-repo` operation

```
scratchmd init-repo --path /var/repos/orgId/workbookId/connId/repo.git
```

1. Create directory at path
2. Init a bare git repo (`git init --bare` equivalent via gix)
3. Create an empty initial commit on `master` (needed so worktrees can attach)
4. Create `dirty` branch pointing to the same commit
5. Print: `{ "ok": true, "path": "..." }`

#### `upsert-files` operation

```
scratchmd upsert-files \
  --repo /var/repos/.../repo.git \
  --folder tableId/records \
  --message "pull 2026-03-16T14:23:01Z: 150 records"
# stdin: newline-delimited JSON, one object per line:
# {"path":"recAbc123.json","content":"{\"id\":\"recAbc123\",...}"}
```

1. Read all `{path, content}` pairs from stdin (ndjson)
2. Read current `master` tree from the bare repo
3. For each file: insert or replace at `{folder}/{path}` in the tree
4. Write a new commit on `master` with the provided message
5. Per-repo write lock (same mechanism as scratch-git-2) to prevent concurrent commits
6. Print: `{ "commitOid": "abc123...", "filesWritten": 150 }`

**Note:** Files not in the batch are left untouched (upsert semantics, not full replace). This lets multiple tables be committed independently.

#### `serve` operation

```
scratchmd serve --port 3100 --repos-dir /var/scratch-repos
```

Axum HTTP server routing:

| Method | Path | Handler |
|--------|------|---------|
| POST | `/api/repos/init` | `body: {path}` → `init-repo` |
| POST | `/api/repos/upsert-files` | `body: {repoPath, folder, message, files[]}` → `upsert-files` |
| GET | `/git/*path` | proxy to `git http-backend` (see below) |
| POST | `/git/*path` | proxy to `git http-backend` |

**git http-backend proxying:**
- Set env: `GIT_PROJECT_ROOT={repos-dir}`, `GIT_HTTP_EXPORT_ALL=1`
- Set CGI env: `REQUEST_METHOD`, `QUERY_STRING`, `PATH_INFO`, `CONTENT_TYPE`, `CONTENT_LENGTH`
- Exec `git http-backend`, pipe stdin/stdout
- This enables `git clone http://localhost:3100/git/orgId/workbookId/connId/repo.git`

#### `pull` operation

```
scratchmd pull \
  --server http://localhost:3010 \
  --workbook-id exp-wb-1 \
  --output ~/scratch-test
```

1. `GET {server}/workbooks/{workbookId}` → get workbook name, list of connections (id, name, repoPath)
2. Create `{workbookName}-{workbookId}/` directory at `--output`
3. `git init` the workbook-level repo at `.scratch/workbook/.git/` (empty, single branch)
4. For each connection:
   - Create `.scratch/connections/{connName}-{connId}/` directory
   - `git clone --bare {scratchmd-url}/git/{repoPath} .scratch/connections/{connName}-{connId}/.git`
   - Add dirty worktree: links `{connName}-{connId}/` to the dirty branch
   - Add master worktree: links `.scratch/connections/{connName}-{connId}/master/` to master branch
5. Write `CLAUDE.md` at workbook root
6. Print directory tree

---

### B. Experimental NestJS backend: `/experimental/scratch-v4-backend/`

Standalone NestJS app. Shares the same Postgres DB as the existing server (same `DATABASE_URL`). Does **not** import from `/server/src`. Shared types candidate folder: `/server/to-be-shared-types/`.

#### Directory layout

```
/experimental/scratch-v4-backend/
  src/
    app.module.ts
    workbook/
      workbook.module.ts
      workbook.service.ts         ← create org, workbook, connection in DB
    airtable/
      airtable.module.ts
      airtable.connector.ts       ← fetchRecords(page): {records, offset, done}
      airtable.types.ts
    poll/
      poll.module.ts
      poll.job.ts                 ← BullMQ worker: fetch → upsert-files loop
      poll.queue.ts
    scratch-git/
      scratch-git.module.ts
      scratch-git.client.ts       ← HTTP client for initRepo + upsertFiles
    commands/
      setup.command.ts
      trigger-pull.command.ts
    bootstrap-command.ts          ← standalone app bootstrap for CLI commands
  .env.example
  package.json
  tsconfig.json
```

#### `ScratchGitClient`

```typescript
class ScratchGitClient {
  // POST /api/repos/init
  async initRepo(path: string): Promise<void>

  // POST /api/repos/upsert-files
  async upsertFiles(opts: {
    repoPath: string;
    folder: string;
    message: string;
    files: Array<{ path: string; content: string }>;
  }): Promise<{ commitOid: string; filesWritten: number }>
}
```

Configured via env: `SCRATCH_GIT_URL=http://localhost:3100`

#### `setup` command

```
cd experimental/scratch-v4-backend && yarn setup
```

Sequence:
1. Connect to Postgres (Prisma or raw SQL — keep it minimal)
2. Upsert Org: `{ id: 'exp-org-1', name: 'Experiment Org' }`
3. Upsert Workbook: `{ id: 'exp-wb-1', name: 'Experiment Workbook', orgId: 'exp-org-1' }`
4. Upsert ConnectorAccount: `{ id: 'exp-conn-1', workbookId: 'exp-wb-1', service: 'airtable' }`
5. Compute repo path: `{GIT_REPOS_DIR}/exp-org-1/exp-wb-1/exp-conn-1/repo.git`
6. `mkdir -p` the parent directory
7. Call `scratchGitClient.initRepo(repoPath)`
8. Print: `Setup complete. Repo at: {repoPath}`

**Constants needed (leave empty in `.env.example`):**
```
AIRTABLE_API_KEY=
AIRTABLE_BASE_ID=
AIRTABLE_TABLE_ID=
GIT_REPOS_DIR=/var/scratch-repos
SCRATCH_GIT_URL=http://localhost:3100
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/scratchpad
```

#### `trigger-pull` command

```
cd experimental/scratch-v4-backend && yarn trigger-pull
```

Enqueues a `PollJob` for `exp-conn-1`. Returns immediately. The BullMQ worker (running in `yarn dev`) picks it up.

#### `PollJob` worker

```typescript
// Simplified flow
async process(job: Job<{ connectorAccountId: string }>) {
  const { connectorAccountId } = job.data;

  // Load connection config from DB
  const conn = await db.connectorAccount.findUnique({ where: { id: connectorAccountId } });
  const repoPath = buildRepoPath(conn); // {GIT_REPOS_DIR}/{orgId}/{workbookId}/{connId}/repo.git

  const connector = new AirtableConnector({
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    tableId: process.env.AIRTABLE_TABLE_ID,
  });

  let page = 0;
  let offset: string | undefined;
  let totalRecords = 0;

  do {
    const { records, nextOffset, done } = await connector.fetchRecords(offset);

    const files = records.map(record => ({
      path: `${record.id}.json`,
      content: JSON.stringify(record, null, 2),
    }));

    await scratchGitClient.upsertFiles({
      repoPath,
      folder: `${process.env.AIRTABLE_TABLE_ID}/records`,
      message: `pull ${new Date().toISOString()} page ${page}: ${records.length} records`,
      files,
    });

    totalRecords += records.length;
    offset = nextOffset;
    page++;
  } while (!done);  // Airtable returns an offset until the last page

  logger.info(`Poll complete: ${totalRecords} records in ${page} pages`);
}
```

Note: one commit per page for Milestone 1. Acceptable — history can be squashed later.

---

### C. Running the full stack locally

```bash
# Terminal 1: scratchmd HTTP server
cd scratchmd
cargo run -- serve --port 3100 --repos-dir /tmp/scratch-repos

# Terminal 2: existing NestJS server (unchanged)
yarn dev

# Terminal 3: experimental backend (BullMQ worker)
cd experimental/scratch-v4-backend
cp .env.example .env
# fill in AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID
yarn dev

# Terminal 4: run setup
cd experimental/scratch-v4-backend
yarn setup
# → "Setup complete. Repo at: /tmp/scratch-repos/exp-org-1/exp-wb-1/exp-conn-1/repo.git"

# Trigger a pull (watch Terminal 3 for progress)
yarn trigger-pull

# Clone locally
cd scratchmd
cargo run -- pull \
  --server http://localhost:3010 \
  --workbook-id exp-wb-1 \
  --output ~/scratch-test

ls ~/scratch-test/
# → Experiment Workbook-exp-wb-1/
#     exp-conn-1/
#       {tableId}/records/*.json   ← real Airtable records as files
```

---

### D. Verification checklist

**After `yarn trigger-pull` completes:**
- [ ] `ls /tmp/scratch-repos/exp-org-1/exp-wb-1/exp-conn-1/repo.git` — looks like a bare git repo (HEAD, objects/, refs/)
- [ ] `git -C /tmp/scratch-repos/.../repo.git log master --oneline` — shows commits named "pull … page N"
- [ ] `git -C /tmp/scratch-repos/.../repo.git show master:{tableId}/records/recXxx.json` — valid JSON

**After `scratchmd pull` completes:**
- [ ] `~/scratch-test/Experiment Workbook-exp-wb-1/{connName}-exp-conn-1/{tableId}/records/` contains `.json` files
- [ ] Files are plain readable JSON — `cat ~/scratch-test/.../recXxx.json` works
- [ ] `git -C ~/scratch-test/.scratch/connections/.../\.git worktree list` shows two worktrees: dirty (top-level) + master (.scratch/…/master/)
- [ ] `~/scratch-test/.scratch/connections/.../master/{tableId}/records/` has the same files as dirty

---

## Open Questions

1. **`upsert-files` commit granularity.** Milestone 1 commits one Airtable page at a time (multiple commits per pull). Should we batch all pages into a single commit, or is multi-commit fine for now? Multi-commit is easier to implement and provides useful history granularity.

2. **Workbook repo for syncs.** The workbook-level `.git` at `.scratch/workbook/.git` starts empty in Milestone 1. When does it first get populated? Options: (a) `scratchmd pull` fetches existing syncs from the API server and commits them, (b) only populated when the user creates a sync locally for the first time.

3. **Record filename convention.** For Milestone 1, use `{airtableRecordId}.json` as the filename (e.g. `recAbc123.json`). The SQLite index (Phase 2) formalizes the remoteId→filename mapping and will allow richer filename strategies.

4. **Auth for `scratchmd pull`.** For Milestone 1: no auth. The CLI calls the scratchmd server directly (no token needed). Auth is added in Phase 2 alongside the runner token system.

5. **Lookup transformer and cross-connection reads.** The `lookup` transformer reads from another DataFolder, potentially in a different connection's repo. With per-connection repos, that means reading a second `index.db`. Safe to require that lookup targets always be on `master`?

---

## Experimental: Local Runner Mode

> **Highly experimental, optional.** Build after Phases 1-3 are stable.

### The core problem: you cannot just open a port

Most users are behind NAT. The API server cannot initiate a connection to `192.168.1.42:3100` — the router has no inbound routing rule for it. Corporate firewalls compound this. Dynamic IPs change. The connection must always be initiated **outbound** from the user's machine.

### Solution: WebSocket command channel

The user's machine opens a persistent outbound WebSocket to the API server. The API server sends job dispatch messages down this connection. Same model as GitLab self-hosted runners and Cloudflare Tunnel.

```
scratch serve
  → authenticate (same OAuth as CLI)
  → open WebSocket to wss://api.scratch.io/runner
  → register as runner for workbook W

API server (cron fires for W):
  → check runner registry: W has active runner
  → send over WebSocket: { type: "run-sync", jobId: "xyz", payload: {...} }

User's machine:
  → receive job
  → run sync against local materialized dirty worktree
  → respond: { type: "sync-result", jobId: "xyz", result: {...} }

API server:
  → store result in Postgres, mark job complete
```

Works through NAT and corporate firewalls because the WebSocket upgrade looks like a normal HTTPS request.

### Exclusive ownership sessions

A workbook's data cannot be authoritative in two places simultaneously:

```
Default: cloud-owned
  scratchmd (cloud) holds bare repos and indexes

User runs: scratchmd checkout-local --workbook <id>
  → API server marks workbook "local-active"
  → Cloud tarballs repos + index.db
  → CLI downloads and extracts to local worktree structure
  → User's machine is now authoritative

User runs: scratchmd push-remote --workbook <id>
  → CLI tarballs repos + index.db
  → Uploads to API server
  → Cloud engine extracts + re-validates
  → Workbook returns to "cloud-active"

While local-active:
  → API server queues/rejects all engine operations for this workbook
  → User optionally runs `scratchmd serve` for WebSocket relay
    (allows cloud-triggered cron syncs to run on the local machine)
```

### Security

- Runner token scoped to specific workbook IDs, signed by the API server
- Job payloads HMAC-signed; runner verifies before executing
- WebSocket is outbound — no inbound port needed, no NAT traversal problem
- CMS credentials stay in the API server for Phase 1 (runner does transform only)
- Full air-gap (encrypted credential handoff to runner) is a later opt-in

### Why not alternatives

| Approach | Problem |
|----------|---------|
| Open an HTTP port | NAT + firewalls block it for almost all real users |
| Polling for jobs | N-second latency on every cron-triggered sync |
| Reverse SSH tunnel | Scratch must build and operate relay SSH infrastructure |
| Cloudflare Tunnel | Hard third-party dependency, 30MB extra binary |
| WebRTC | Designed for media streaming; requires TURN server for ~15% of networks |
