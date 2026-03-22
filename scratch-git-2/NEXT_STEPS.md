# Next Steps: Eliminating Database State

The goal across all three areas is the same: **git is the source of truth**. The web UI should reach the same git state as the CLI without requiring the CLI. Database tables become caches that can be dropped.

---

## 1. Publish Plans

### Current state
- The CLI builds a `plan.json` + phase directories into the dirty git branch (`plan_publish.rs`)
- The server already reads from git to execute the plan (`PublishFromGitService.runFromGit()`)
- But the server still creates a `PublishPlan` + `PublishPlanOperation` DB record to track status and hand a `pipelineId` back to the client

### What needs to change
- **Plan building must happen server-side (via Rust git service)**. Today only the CLI can build the plan. The Rust service needs a new endpoint (e.g. `POST /repo/:id/publish-plan`) that runs the same logic as `plan_publish.rs`: scans dirty vs master, builds plan.json + phase dirs, strips FK refs using the SQLite index, writes everything back to dirty. The web client calls this instead of the CLI.
- **Status tracking without DB**. Once the BullMQ job runs, it can write a `plan-status.json` into the dirty branch (or a sidecar path) rather than updating a `PublishPlan` row. The client polls an endpoint that reads from git instead.
- **UI trigger**. The publish button today assumes a plan already exists (CLI built it). We need a two-step UI: "Build Plan" → review summary → "Run". Both steps talk to the server, not the CLI.
- **`PublishPlan` + `PublishPlanOperation` tables can be dropped** once the above is in place.

### Key files
- `scratch-git-2/src/cli/commands/plan_publish.rs` — port this logic into the Rust service
- `server/src/publish-plan/publish-from-git.service.ts` — execution already reads from git; status writing needs to move to git
- `server/src/publish-plan/publish-plan-crud.service.ts` — can be deleted

---

## 2. Database Indices → SQLite Only

### Current state
- **`FileIndex`** (PostgreSQL): maps `(folderPath, filename) → remoteId`. Used during publish for reverse lookups (e.g. "what remote ID does this file represent?") and to detect deleted upstream records.
- **`FileReference`** (PostgreSQL): maps `(sourceFile → targetRemoteId)` for FK dependency tracking. Used during delete to find which other files reference the deleted record and need backfill/clearing.
- The Rust git service already maintains an equivalent SQLite index per connection (`index.db` with `file_index` + `file_references` tables), built from the master git tree.

### What needs to change
- **Server publish operations must read from SQLite instead of PostgreSQL `FileIndex`/`FileReference`**. `PublishFromGitService` currently calls `FileIndexService` for lookups. These calls need to go to the Rust git service instead (via its internal index).
- **Index must be kept current on the server side**. The Rust service already has `upsert_single_file()` and `build_from_entries()`. After every pull/publish that changes the master branch, the index must be rebuilt. This may already happen via the git service — confirm the `PostCommitIndex` or equivalent hook fires.
- **FK translation in the UI**. The client currently does remote-ID → filename lookups (e.g. to display linked record names in the publish diff view). These hit server endpoints backed by `FileIndex`. Those endpoints need to be re-backed by SQLite queries proxied through the Rust service.
  - Identify all `GET /workbook/:id/file-index/...` endpoints and replace their backing with Rust service calls.
- **`FileIndex` + `FileReference` tables can be dropped** once all consumers read from SQLite.
- **Sync index tables** (`SyncMatchKeys`, `SyncRemoteIdMapping`, `SyncForeignKeyRecord`) are a separate concern — see Area 3.

### Key files
- `server/src/publish-plan/file-index.service.ts` — replace with calls to Rust service
- `scratch-git-2/src/shared/index.rs` — source of truth; expose via new HTTP endpoints on the Rust service
- `server/prisma/schema.prisma` lines 447–471 — `FileIndex` + `FileReference` tables to remove

---

## 3. Syncs: Database → Git

### Current state
- Sync configs live in the PostgreSQL `Sync` + `SyncTablePair` tables
- The CLI can `syncs download` to export them as JSON files and `syncs run-local` to execute them against the local filesystem
- Server-side execution is more capable: full transformer support (type coercion, FK mapping, `lookup_field`, Notion→HTML), two-phase DATA + FOREIGN_KEY_MAPPING, proper record matching via `SyncMatchKeys` cache

### What needs to change
- **Move sync configs to git**. Store each sync as a YAML/JSON file in a `syncs/` directory in the workbook's git repo (matching the format `syncs download` already produces). The `Sync` + `SyncTablePair` tables become derived from git, not authoritative.
- **Server reads sync configs from git**. `SyncService` currently reads `Sync` rows from PostgreSQL. It should instead read from the git repo (via the Rust service) and parse the config files. The execution engine (two-phase algorithm, transformers, `SyncMatchKeys` cache) stays on the server — only the config storage moves.
- **Sync cache tables stay (for now)**. `SyncMatchKeys`, `SyncRemoteIdMapping`, `SyncForeignKeyRecord` are execution-time caches, not config. They can remain as ephemeral DB tables for now and be considered for SQLite migration later.
- **Schedule association**. Schedules are currently linked to `Sync` rows. With git-backed syncs, the schedule's cron expression moves into the sync config file itself (already exported in `_metadata`). The `Schedule` table row becomes a derived artifact.
- **UI for managing syncs**. Today the UI reads/writes `Sync` rows directly. With git-backed syncs, it needs to commit sync config files to git (via the Rust service) and read them back. The sync list, create, edit, and delete flows all need updating.
- **`Sync` + `SyncTablePair` tables can be dropped** once all reads/writes go through git.

### Key files
- `server/src/sync/sync.service.ts` — replace DB reads with git-backed config loading; keep execution engine
- `server/src/sync/sync.controller.ts` — endpoints stay, backing changes
- `scratch-git-2/src/cli/commands/syncs.rs` — format is already the right target
- `server/prisma/schema.prisma` lines 529–572 — `Sync` + `SyncTablePair` to remove

---

## Shared Principle: Remote git = Local git

The Rust git service must be able to perform every operation the CLI performs, so the web UI reaches identical git state without the CLI:

| Operation | CLI today | Rust service target |
|---|---|---|
| Build publish plan | `plan_publish.rs` | New endpoint, same logic |
| Build/update SQLite index | `index.rs` | Already exists (`build_from_entries`) |
| Run sync locally | `syncs run-local` | New endpoint, equivalent logic |
| Write sync config | `syncs download` + edit | Commit via git service write endpoint |

Once these are in place, the CLI becomes a convenience wrapper around the same git state — not a prerequisite for any operation.
