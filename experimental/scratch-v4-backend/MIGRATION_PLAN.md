# Incremental Migration Plan

Two milestones toward the long-term goal of Rust-driven business logic with SQLite-backed indexes.

---

## Ground rules (constraints that cannot be violated)

1. **Both CLIs must work on the same workspace at any time.** A user can switch from the old Go CLI to the new Rust CLI mid-session — files, git history, and credential storage must be identical.
2. **The NestJS server is unchanged in both milestones.** The Rust CLI calls the same API endpoints as the Go CLI. No server migration yet.
3. **scratch-git-2 continues to work as an HTTP server** throughout. The CLI is additive, not a replacement.
4. **V2 workspace only.** The Rust CLI does not need to support V1 (single git repo) workspaces. If someone hits a V1 workspace, fail fast with a clear error.

---

## Pre-work: read before touching any code

Before writing a single line, read these files fully:

- `scratch-git-2/src/git/repo.rs` — the GitRepo struct, what operations it supports
- `scratch-git-2/src/git/merge.rs` — **this is already solved**: `merge_file_contents(base, ours, theirs)` with `Conflict::ResolveWithOurs`
- `scratch-git-2/src/types.rs` — shared types
- `scratch-cli/internal/cmd/workspaces.go` — V2 init flow in detail (directory naming, marker file format)
- `scratch-cli/internal/cmd/files.go` — exact download/upload flow
- `scratch-cli/internal/cmd/linked.go` — job polling behavior
- `scratch-cli/internal/config/credentials.go` — credentials YAML format (must be replicated exactly)

Assumptions to verify before coding:
- [ ] What exact YAML format does `~/.scratchmd/credentials.yaml` use? (key names, nesting, token field name)
- [ ] What exact fields are in each `.scratchmd` marker file? (workspace, connector, data-folder levels)
- [ ] What does the V2 directory name look like? (is it `ConnectorDisplayName` or `ConnectorDisplayName-ConnectorId`?)
- [ ] What does `files download` use as the "base" for three-way merge? (the last common commit? the server's main branch?)
- [ ] Which NestJS endpoints does the Go CLI call for each command? (build a map before coding)
- [ ] Does any existing scratch-git-2 git module code apply to CLI worktree operations, or is it all bare-repo specific? (Assumption: it's all bare-repo; CLI uses subprocess git)

---

## Milestone 1: Rust CLI in scratch-git-2

### Architecture decision: two binaries, one crate

`scratch-git-2/src/main.rs` is **not touched**. The server binary stays exactly as it is.
A second binary target is added to `Cargo.toml`:

```toml
[[bin]]
name = "scratch-git-2"   # existing server — zero changes to src/main.rs
path = "src/main.rs"

[[bin]]
name = "scratchmd2"       # new CLI — separate entry point
path = "src/main_cli.rs"
```

`src/main_cli.rs` is a new file with a clap entry point. It can import any module from the crate.
The server binary is never touched. Both compile from the same crate and share the same modules.

**Why not a separate crate/workspace?** A Rust workspace split is the right long-term architecture, but it adds friction to Milestone 1. Do the workspace split after both milestones are stable, not before.

### New binary name

During the transition period, ship as `scratchmd2` (not `scratchmd`). This lets both binaries coexist on the same machine during testing. Rename to `scratchmd` when the Go CLI is retired.

### What the CLI actually shares with the server in Milestone 1

Honest answer: almost nothing, and that's fine.

The server operates on **bare repos** — its `git/` module (`repo.rs`, `tree_builder.rs`, `rebase.rs`, `compare.rs`) is built entirely around reading and writing git object trees in bare `.git` directories. None of that is useful for a CLI operating on a local worktree.

The one genuinely shared piece is `git/merge.rs: merge_file_contents(base, ours, theirs)` — but that's a pure string function that doesn't touch git at all. It could live anywhere.

So for Milestone 1, being in the same crate means:
- Same repo (atomic commits across CLI and server changes)
- Same `Cargo.toml` / dependency versions
- One reused function (`merge_file_contents`)
- Foundation set up for Milestone 2+ where real sharing happens

**The real code sharing comes in Milestone 2+**, when business logic (`plan_publish`, `build_index`, `run_sync`) moves to Rust. That logic is pure — it operates on files and SQLite, not on git internals — and it shares cleanly between server and CLI regardless of bare vs. worktree.

All git operations in the CLI (clone, fetch, commit, push, merge) use **subprocess `git` calls**. Reasons:
- The server's `gix` features (`["merge", "blob-diff"]`) don't include async network access needed for clone/fetch/push
- Adding those features just for the CLI would inflate the server binary for no benefit
- subprocess git is reliable, battle-tested, handles all edge cases
- Can be replaced with native gix calls later if needed

**Requirement**: `git` must be on the user's PATH. This is true for all developers.

### Source layout: three top-level folders

The crate is reorganised into three clearly separated top-level modules.
Nothing moves inside `service/` — it is the existing code, renamed in place.

```
scratch-git-2/src/
│
├── main.rs              HTTP server entry point — untouched
├── main_cli.rs          NEW: CLI entry point (clap)
│
├── service/             Everything that exists today, moved here unchanged
│   ├── mod.rs
│   ├── config.rs
│   ├── envelope.rs
│   ├── error.rs
│   ├── state.rs
│   ├── types.rs
│   ├── git/             bare-repo git operations (repo.rs, merge.rs, rebase.rs, …)
│   └── routes/          axum HTTP handlers
│
├── cli/                 NEW: CLI command implementations
│   ├── mod.rs
│   ├── auth.rs          scratchmd2 auth {login,logout,status}
│   ├── workspaces.rs    scratchmd2 workspaces {list,create,show,delete,init}
│   ├── files.rs         scratchmd2 files {download,upload}
│   ├── connections.rs   scratchmd2 connections {list,add,show,remove}
│   ├── linked.rs        scratchmd2 linked {available,list,add,remove,show,pull,publish}
│   ├── syncs.rs         scratchmd2 syncs {list,show,create,update,delete,run,download}
│   ├── api/             HTTP client for NestJS calls
│   │   ├── mod.rs       base client (auth headers, base URL, error handling)
│   │   ├── auth.rs      device code flow
│   │   ├── workbooks.rs
│   │   ├── connections.rs
│   │   ├── linked.rs
│   │   ├── syncs.rs
│   │   └── jobs.rs      job polling
│   └── config/          local CLI state
│       ├── mod.rs
│       ├── credentials.rs   ~/.scratchmd/credentials.yaml
│       └── markers.rs       .scratchmd marker files
│
└── shared/              NEW: pure business logic shared by both binaries
    └── mod.rs           (empty in Milestone 1 — populated in Milestone 2+)
```

**Why this separation matters:**
- `service/` is the HTTP server — it only knows about bare repos and axum handlers. Never imports from `cli/`.
- `cli/` is the user-facing binary — it only knows about local worktrees and the NestJS API. Never imports from `service/`.
- `shared/` is where real sharing happens: `merge_file_contents` moves here in Milestone 1, followed by `plan_publish`, `build_index`, `run_sync` in Milestone 2+. Both `service/` and `cli/` import from `shared/`.

In Milestone 1, `shared/` contains only `merge_file_contents`. It grows in Milestone 2.
The three-way separation makes the eventual Rust workspace split (separate crates) a straightforward refactor.

### New dependencies to add to Cargo.toml

```toml
# CLI
clap = { version = "4", features = ["derive", "env"] }

# HTTP client for NestJS API calls
reqwest = { version = "0.12", features = ["json"] }

# YAML for .scratchmd markers and credentials
serde_yaml = "0.9"

# Open browser for device code auth
open = "5"
```

### Testing: can we verify both CLIs match?

The Go CLI has one test file: `scratch-cli/internal/cmd/v2_test.go`.
It tests internal Go functions — marker loading, connector directory detection,
result aggregation, filename sanitization. It cannot be run against the Rust CLI.

There is **no existing cross-CLI test suite**. We need to build one.

#### What to build: a compatibility test suite

A shell script (or small Rust integration test binary) that runs the same sequence
of commands against both CLIs and asserts the outputs and filesystem state match.
Candidate: `scratch-cli/compat-tests/` as a standalone script that takes two
binary paths as arguments: `./run.sh $(which scratchmd) $(which scratchmd2)`.

**What it can test without a live server (pure local / unit-level):**

| Test | How |
|---|---|
| Credential round-trip | Write creds with CLI A, read with CLI B (check same token and server URL) |
| `.scratchmd` marker format | Write workspace marker with CLI A, parse with CLI B's config module |
| Connector directory detection | Same fixture dir, both CLIs detect the same connectors |
| Filename sanitization | Same inputs, same outputs |
| `--json` output shape | Same workspace, both CLIs produce same JSON keys |

The Go unit tests in `v2_test.go` serve as the **specification** for the Rust implementation.
The exact YAML content in those tests (`version: "2"`, field names, nesting) is what the Rust
`shared/markers.rs` must produce byte-for-byte. Treat those tests as a contract document.

**What requires a live server (integration-level):**

| Test | Trigger |
|---|---|
| `workspaces init` produces identical directory structure | Run both on same workspace ID, diff the result trees |
| `files download` results in same local state | Pull with CLI A, pull with CLI B, diff working trees |
| `files upload` pushes identical commits | Upload with CLI A, pull with CLI B (and vice versa) |
| `linked pull` / `linked publish` complete without error | Manual for now |

**Recommendation:** Start the compatibility suite in Step 1.2 (marker + credential format),
expand it with each subsequent step. The suite is the primary acceptance gate before
retiring the Go CLI.

---

### Implementation steps

#### Step 1.1 [COMPLETED] — Add clap and dual-mode entry point

Modify `main.rs` to be clap-driven. The `Serve` subcommand runs the existing HTTP server. All other subcommands are stubs that print "not yet implemented".

**What to check:**
- `cargo build` succeeds with no warnings
- `scratch-git-2 serve` (or `scratchmd2 serve`) still starts the HTTP server exactly as before
- `scratchmd2 --help` shows all command groups
- `scratchmd2 auth --help` shows expected subcommands
- Deploy to staging: server still starts correctly

---

#### Step 1.2 [COMPLETED] — Config module: credentials and workspace markers

Implement `config/credentials.rs`:
- Reads and writes `~/.scratchmd/credentials.yaml`
- **Must be byte-for-byte compatible** with the Go CLI's format
- Test: write with Rust CLI, read back with Go CLI, no corruption

Implement `config/markers.rs`:
- Reads `.scratchmd` files from workspace, connector, and data folder levels
- Writes `.scratchmd` files in V2 format
- Context detection: walk up from current directory to find nearest `.scratchmd`
- Distinguish workspace vs connector vs data-folder markers

**Tricky case: YAML compatibility.** Go's `gopkg.in/yaml.v3` and Rust's `serde_yaml` may produce slightly different output (quote styles, field ordering, trailing newlines). Verify both can round-trip each other's output. If not, write a compatibility test that catches divergence early.

**What to check:**
- Write a `.scratchmd` with Rust CLI, open it with a text editor — matches Go CLI output exactly
- Write credentials YAML with Rust CLI, run `scratchmd auth status` with OLD Go CLI — shows authenticated
- Run `scratchmd auth status` with OLD Go CLI after login with NEW Rust CLI — works
- Run `scratchmd2 auth status` after login with OLD Go CLI — works

---

#### Step 1.3 [COMPLETED] — API module and auth commands

Implement `api/mod.rs`: base reqwest client with:
- Bearer token from credentials
- Configurable base URL (defaults to `https://api.scratch.md`, override via `--scratch-url` flag or `~/.scratchmd/credentials.yaml` server URL)
- Common error handling: 401 → "not authenticated, run auth login"; 404 → clear message; 5xx → retry once

Implement `api/auth.rs` + `cli/auth.rs`:
- `auth login`: device code flow — POST to get code, open browser, poll for token, store in credentials
- `auth logout`: delete token from credentials YAML
- `auth status`: read credentials, show server + masked token

**What to check:**
- `scratchmd2 auth login` — opens browser, completes flow, token stored
- `cat ~/.scratchmd/credentials.yaml` — same structure as after Go CLI login
- `scratchmd auth status` (OLD CLI) — shows authenticated after Rust login
- `scratchmd2 auth status` — shows authenticated after Go CLI login
- `scratchmd2 auth logout` — clears token; `scratchmd auth status` (OLD CLI) shows not authenticated

---

#### Step 1.4 [COMPLETED] — Workspaces commands (except init)

Implement `api/workbooks.rs` + `cli/workspaces.rs` for list, create, show, delete.

These are pure API calls — no local git operations. Straightforward.

**What to check:**
- `scratchmd2 workspaces list` output matches `scratchmd workspaces list` output (same workbooks)
- `scratchmd2 workspaces list --json` produces valid JSON with same fields
- `scratchmd2 workspaces create "Test WS"` then `scratchmd workspaces list` shows it

---

#### Step 1.5 [COMPLETED] — `workspaces init`

This is the most structurally important command. It establishes the workspace that both CLIs will share.

V2 init flow:
1. `GET /api/workbooks/{id}` → workbook name, version, connectors
2. Assert version == 2 (fail clearly for V1)
3. For each connector: get git clone URL (`GET /api/workbooks/{id}/git-url?connectorId={cid}` or equivalent endpoint)
4. Create workspace directory: `{workbookName}/`
5. Write workspace `.scratchmd` marker
6. For each connector:
   a. `git clone <url> <workspaceDir>/<connectorDisplayName>/ -b dirty` (subprocess)
   b. Write connector-level `.scratchmd` marker inside the cloned dir
   c. For each data folder in the connector: write folder-level `.scratchmd` markers

**Critical: directory naming.** The Go CLI names the connector subdirectory using the connector's display name. Verify this exactly — if it appends the ID, the Rust CLI must do the same. One byte difference here breaks workspace sharing.

**Critical: initial file state.** After `git clone`, the files are in the dirty branch state. The Go CLI may or may not do an initial `files download` as part of init. Check the exact behavior.

**What to check:**
- Run `scratchmd workspaces init <id>` (OLD CLI) and `scratchmd2 workspaces init <id>` (NEW CLI) on separate fresh dirs — directory structures are identical
- `ls -la` both workspace roots: same files, same `.scratchmd` content
- Open OLD workspace with NEW CLI: `scratchmd2 files download` works without error
- Open NEW workspace with OLD CLI: `scratchmd files download` works without error
- Connector `.git/` remote URL is identical in both

---

#### Step 1.6 [COMPLETED] — `files download` (three-way merge)

This is the most algorithmically complex command. The logic:

1. Detect current workspace (walk up from CWD for `.scratchmd`)
2. If connector-level: operate on that connector's dir. If workspace-level: operate on all connectors.
3. For each connector directory:
   a. `git fetch origin` (subprocess)
   b. Get the merge base: `git merge-base HEAD origin/dirty` (subprocess → commit OID)
   c. For each file that differs between local and `origin/dirty`:
      - `git show <merge-base>:<path>` → base content (subprocess)
      - Read current local file → ours
      - `git show origin/dirty:<path>` → theirs (subprocess)
      - Call `merge_file_contents(base, ours, theirs)` from scratch-git-2's `git/merge.rs` ← reuse this!
      - Write merged content to disk
   d. Handle new files from remote (no local version): just write them
   e. Handle files deleted on remote: delete locally (unless local also modified → local wins = keep)
   f. `git add -A && git commit -m "files download" --allow-empty`

**Note:** We reuse `merge_file_contents` directly from scratch-git-2's existing code. This is one of the main points of sharing code between the server and CLI.

**Alternative if the above is too complex for Milestone 1:** Use `git merge origin/dirty -X ours` (subprocess) — git does the merge natively with "ours" strategy for conflicts. This is simpler but less transparent. Acceptable for initial implementation.

**What to check:**
- After `linked pull` job completes on server, run `scratchmd2 files download` — local files match server
- Make local edit to file A, then `linked pull` changes file B on server, run `scratchmd2 files download` — file A local edit preserved, file B updated
- Make local edit to file A, then `linked pull` also changes file A on server — local version wins
- Run OLD CLI `files download` on a workspace where NEW CLI did `files download` — no double-merge
- Run NEW CLI `files download` then OLD CLI `files download` — idempotent, no changes

---

#### Step 1.7 [COMPLETED] — `files upload`

1. For each connector in scope:
   a. `git add -A` (subprocess)
   b. Check if there are changes: `git diff --cached --quiet` (subprocess)
   c. If changes: `git commit -m "scratchmd upload"` (subprocess)
   d. `git push origin dirty` (subprocess)
2. Report: N files committed, N connectors pushed

**What to check:**
- Make local edit, run `scratchmd2 files upload`, then `scratchmd files download` on another machine → sees the change
- Run with no changes → no commit, no push (clean output)
- Run OLD CLI `files upload`, then NEW CLI `files upload` — idempotent

---

#### Step 1.8 [PARTIALLY COMPLETE] — Connections, linked, syncs commands

These are mostly API calls with job polling. Implement:

`api/connections.rs`, `api/linked.rs`, `api/syncs.rs`, `api/jobs.rs`:
- Jobs polling: `GET /api/jobs/{id}` every 2 seconds, timeout at 30 minutes, output dots to stderr while waiting (matching Go CLI UX)

`cli/connections.rs`: list, add (no interactive — all via flags), show, remove

`cli/linked.rs`:
- `available`, `list`, `show`, `add`, `remove`: pure API calls
- `pull`: POST to start pull job + poll via jobs.rs + `files download` after success
- `publish`: POST to start publish job + poll via jobs.rs

`cli/syncs.rs`: list, show, create, update, delete, run (triggers job + polls), download

**What to check for each command:**
- Output matches Go CLI output for same workspace (modulo interactive prompts)
- `--json` flag produces valid JSON
- `linked pull <id>` completes and local files are updated (run `files download` after)
- `linked publish <id>` completes and remote service reflects changes
- `syncs run <id>` completes, result visible in linked show
- Old and new CLIs interleaved: linked pull with old, publish with new → works

**Status:** `connections list/show/remove/add` complete and equivalence-tested. `linked` and `syncs` are stubs — all subcommands return "not yet implemented".

---

#### Step 1.8b — Complete `linked` and `syncs` + equivalence tests

Finish the remaining stubs from Step 1.8 and expand `scratch-git-2/tests/equivalence/run.sh` to cover them.

**`linked` commands to implement** (all currently stubbed):

- `linked available [<connection-id>]` — `GET /workbooks/{id}/connections/{cid}/tables`
- `linked list` — `GET /workbooks/{id}/linked`
- `linked show <id>` — `GET /workbooks/{id}/linked/{id}`
- `linked add --connection-id <id> --table-id <id>` — `POST /workbooks/{id}/linked`
- `linked remove <id>` — `DELETE /workbooks/{id}/linked/{id}`
- `linked pull <id>` — `POST /workbooks/{id}/linked/{id}/pull` + job poll + `files download`
- `linked publish <id>` — `POST /workbooks/{id}/linked/{id}/publish` + job poll

**`syncs` commands to implement** (all currently stubbed):

- `syncs list` — `GET /workbooks/{id}/syncs`
- `syncs show <id>` — `GET /workbooks/{id}/syncs/{id}`
- `syncs create --config <path|json>` — `POST /workbooks/{id}/syncs`
- `syncs update <id> --config <path|json>` — `PATCH /workbooks/{id}/syncs/{id}`
- `syncs delete <id>` — `DELETE /workbooks/{id}/syncs/{id}`
- `syncs run <id>` — `POST /workbooks/{id}/syncs/{id}/run` + job poll
- `syncs download [--id <id>] [-o <dir>]` — `GET /workbooks/{id}/syncs/export`

**Equivalence tests to add to `scratch-git-2/tests/equivalence/run.sh`:**

The test script already has `LINKED_TABLE_ID` and `SYNC_ID` as optional env vars. Activate the skipped tests by implementing:

| Test | Command pair | Notes |
|---|---|---|
| `linked list` | `scratchmd linked list` vs `scratchmd2 linked --workspace $WB list` | Compare JSON sorted by id |
| `linked available (conn1)` | `scratchmd linked available $CONN1` vs `scratchmd2 linked --workspace $WB available $CONN1` | |
| `linked available (conn2)` | same for conn2 | |
| `linked show` | `scratchmd linked show $LT` vs `scratchmd2 linked --workspace $WB show $LT` | Requires `LINKED_TABLE_ID` env var |
| `syncs list` | `scratchmd syncs list` vs `scratchmd2 syncs --workspace $WB list` | |
| `syncs show` | `scratchmd syncs show $SYNC` vs `scratchmd2 syncs --workspace $WB show $SYNC` | Requires `SYNC_ID` env var |

`linked pull` and `linked publish` are not added to the equivalence script (they trigger server jobs and mutate state). Test them manually per the Step 1.8 checklist.

**What to check:**
- All equivalence tests pass: `0 failed` with `linked` and `syncs` sections active
- `linked pull <id>` with NEW CLI → `files download` shows updated files in BOTH Go and Rust clones
- `linked publish <id>` with OLD CLI → result visible when `linked show` run with NEW CLI (and vice versa)
- `syncs run <id>` with NEW CLI → job completes, `syncs show` output identical across CLIs

---

#### Step 1.9 — Release: Milestone 1 complete

At this point both CLIs work on the same workspace. Checklist:

- [ ] All commands implemented and tested
- [ ] Credentials compatible (cross-CLI auth)
- [ ] Workspace structure compatible (cross-CLI workspace)
- [ ] `scratchmd` (Go, old) and `scratchmd2` (Rust, new) can be swapped freely
- [ ] New binary released via cargo-dist + Homebrew tap `whalesync/homebrew-scratch-cli-v2-test`
- [ ] Internal testing: 1 week of dogfooding both CLIs
- [ ] No data corruption reported

---

## Milestone 2: SQLite file index

### Why

The Postgres `FileIndex` and `FileReference` tables are the most expensive to maintain server-side. They represent a local cache of what's in git — data that logically belongs near the files. Moving this to SQLite:
- Makes CLI-driven operations (plan-publish, local sync) possible without server roundtrips
- Reduces Postgres write pressure
- Sets up the foundation for fully local publish planning (which the experimental CLI already proves out)

### What the SQLite replaces (in the CLI)

| Postgres table | Purpose | CLI equivalent |
|---|---|---|
| `FileIndex` | `(folder, filename) → remoteId` | `file_index` SQLite table |
| `FileReference` | FK dependencies between files | `file_references` SQLite table |

**Important**: Milestone 2 does NOT remove Postgres FileIndex/FileReference. The server continues using them for server-driven operations (scheduled jobs, etc.). The SQLite is a client-side cache used by CLI-driven operations. They'll diverge temporarily and that's OK.

### SQLite schema (copied almost exactly from experimental CLI)

```sql
CREATE TABLE file_index (
    folder   TEXT NOT NULL,
    filename TEXT NOT NULL,
    remote_id TEXT,                  -- NULL for pending (not yet published)
    PRIMARY KEY (folder, filename)
);

CREATE TABLE file_references (
    source_folder     TEXT NOT NULL,
    source_filename   TEXT NOT NULL,
    target_table_id   TEXT NOT NULL,
    target_remote_id  TEXT NOT NULL
    -- No PK: rebuilt from scratch on each full rebuild
);
```

### Where the SQLite lives

The `.scratchmd` file at workspace and connector level is **never modified** — it stays a YAML file as today. A new sibling `.scratch/` directory holds all local-only metadata.

```
WorkspaceName/
├── .scratchmd                                  ← workspace marker file (unchanged)
├── .scratch/                                   ← NEW: local-only metadata (gitignored at workspace level)
│   └── connections/
│       └── AIRTABLE - My Conn/                 ← mirrors connector dir name exactly
│           ├── index.db                        ← SQLite file index for this connector
│           └── master/                         ← master worktree (git worktree of main branch)
│               └── TableName/*.json            ← published state of files
├── AIRTABLE - My Conn/                         ← connector dir (dirty branch clone, unchanged)
│   ├── .scratchmd
│   ├── .git/
│   └── TableName/*.json
```

The `.scratch/` directory is local-only and should be added to the workspace-level `.gitignore`. The `index.db` and `master/` worktree are never committed.

### Master worktree

The server-side bare repo has both `main` and `dirty` branches. The CLI currently only clones `dirty` (single-branch). To correctly build the file index (which represents **published/main state**, matching the server's Postgres `FileIndex`) and to support publish planning (diffing main vs dirty), a `master` worktree is needed locally.

**During `workspaces init`**, after cloning the dirty branch, add a git worktree for `main`:

```bash
# Inside the connector dir (which has .git/ from the dirty clone):
git fetch origin main
git worktree add ../.scratch/connections/{connDirName}/master main
```

This creates a checked-out working tree of `main` at `.scratch/connections/{connDirName}/master/` without touching the dirty working tree.

**During `files download`**, after merging remote dirty changes, also update the master worktree:

```bash
git -C .scratch/connections/{connDirName}/master pull origin main
```

The master worktree is what `build-index` reads from — matching the semantics of the server's `FileIndex` (which is populated from pulled/published main-branch content).

### Where schemas come from

Schemas (`schema.json`) are already present in the connector repos — they live inside each data folder directory in the git repo (both dirty and main branches). No new NestJS endpoint is needed.

`build-index` reads schemas from `master/{folderName}/schema.json` to extract `x-scratch-foreign-key` annotations for building `file_references`.

### When to rebuild the index (full rebuild)

Rebuild after every operation that changes the authoritative state:

| Operation | Why rebuild |
|---|---|
| `workspaces init` | Initial population |
| `files download` (after server pull) | Server pulled new records from CRM; remote IDs and files changed |
| `linked publish` (job completes) | Remote IDs assigned to pending records; `file_index` remote_id column updates |
| `syncs run` (job completes) | New records may have been created in destination folders |
| `build-index` command (explicit) | Manual / debug |

**NOT needed after:**
- `files upload` alone (files pushed but no remote ID changes; server publish job hasn't run)
- `auth`, `workspaces list`, `connections list` etc. (no file changes)

**Implementation:** After the relevant command succeeds, automatically call `build_index()` on the affected connector(s). Keep it synchronous for now — for large workspaces it adds a few seconds but that's acceptable. Log it: "Rebuilding file index for [ConnectorName]...".

**Hook point for incremental rebuild (deferred to later):**
After `files upload`, compare the new commit's diff to the previous commit. For each changed file: update `file_index` for that file, update `file_references` for that file's FK values. This can be added without changing the full-rebuild logic — just an alternative path that gets called when the full rebuild would be wasteful.

### Implementation steps

#### Step 2.1 — Add rusqlite, master worktree, and build-index

Add to Cargo.toml:
```toml
rusqlite = { version = "0.31", features = ["bundled"] }
```

**Update `workspaces init` (Step 1.5)** to also set up the master worktree for each connector:
```bash
git fetch origin main
git worktree add .scratch/connections/{connDirName}/master main
```
Add `.scratch/` to the workspace-level `.gitignore`.

**Update `files download` (Step 1.6)** to also pull the master worktree after merging dirty:
```bash
git -C .scratch/connections/{connDirName}/master pull origin main
```

Port `build_index.rs` from the experimental CLI into `scratch-git-2/src/shared/index.rs`.
Adapt it to read from `.scratch/connections/{connDirName}/master/` (not the dirty worktree).
Schemas are read from `master/{folderName}/schema.json` — no download step needed.

Add `build-index` and `dump-index` as explicit CLI commands:
- `scratchmd2 build-index` — rebuild index for all connectors in current workspace
- `scratchmd2 dump-index [--connection name]` — print index contents (for debugging)

**What to check:**
- After `workspaces init`, `.scratch/connections/{connDirName}/master/` exists with main-branch files
- `scratchmd2 build-index` creates `.scratch/connections/{connDirName}/index.db`
- `scratchmd2 dump-index` shows records with correct remote IDs
- `sqlite3 .scratch/connections/{connDirName}/index.db "SELECT * FROM file_index LIMIT 5"` — looks right
- Index matches Postgres FileIndex for the same connector (spot check 10 records)
- Master worktree updates after `files download` (re-run build-index, counts match)

---

#### Step 2.2 — Wire index rebuild into CLI operations (replaces old schema endpoint step)

Schemas are already present in the connector repos at `{folderName}/schema.json` in the `main` branch — no NestJS changes needed. The master worktree added in Step 2.1 provides them automatically.

Wire `build_index()` into the CLI after each relevant operation (see Step 2.3 below). No separate schema download step is required.

**What to check:**
- After `workspaces init`, `master/{folderName}/schema.json` exists and is valid JSON
- `build-index` produces `file_references` entries (confirms schemas are being read)
- After `files download`, master worktree is updated and re-index reflects new main state
- After full build-index: `SELECT * FROM file_references LIMIT 10` shows FK relationships

---

#### Step 2.3 — Wire index rebuild into CLI operations

After each relevant command completes:
```rust
// In cli/linked.rs, after pull job completes:
index::rebuild_connector_index(&connector_dir)?;

// In cli/linked.rs, after publish job completes:
index::rebuild_connector_index(&connector_dir)?;

// In cli/syncs.rs, after sync job completes:
index::rebuild_affected_connectors(&workspace_dir, &sync)?;
```

Add progress output: "Rebuilding file index for [ConnectorName] (N files)..."

**What to check:**
- `linked pull` auto-rebuilds index on success, not on failure
- `linked publish` auto-rebuilds index on success
- After rebuild: `dump-index` shows correct data including newly created records
- Index rebuild doesn't break if `.scratch/` dir doesn't exist yet (first run)
- Index rebuild is skipped if there's nothing to index (empty connector)

---

#### Step 2.4 — Use index in CLI operations (first consumer)

The first place to consume the index is `plan-publish` (ported from experimental CLI). The experimental plan-publish reads from the SQLite index to:
1. Get remote IDs for deleted files (`deleteIndex`)
2. Find ref-clearing candidates (FK dependencies on deleted records)

Port `plan-publish` from `experimental/scratch-v4-backend/scratch-git/src/commands/plan_publish.rs` to `scratch-git-2`. This is where the real business-logic sharing pays off: the plan-publish logic is pure, tested, and doesn't depend on the experimental workspace structure — it only needs:
- Access to the git diff (dirty vs master)
- Access to the SQLite index for remote IDs and FK paths

At this point: `scratchmd2 plan-publish` works on a V2 workspace. The plan is stored locally and can be pushed to the server for execution.

**What to check:**
- `scratchmd2 plan-publish` produces a plan at `ConnectorDir/.scratch/publish-plans/{timestamp}/`
- `cat plan.json` shows correct deleteIndex entries (remote IDs match Postgres FileIndex)
- Edit + delete some records, plan-publish reflects correct phases
- FK stripping works: records with references to deleted records get their refs cleared

---

#### Step 2.5 — Milestone 2 complete

Checklist:
- [ ] `build-index` and `dump-index` work
- [ ] Schemas stored locally in `.scratch/{folder}/schema.json`
- [ ] Index auto-rebuilds after pull, publish, sync
- [ ] `plan-publish` uses local index (not Postgres)
- [ ] Postgres FileIndex is still populated by server (no regression)
- [ ] Old Go CLI unaffected (doesn't know about `.scratch/index.db`)
- [ ] Index data accuracy: spot-check 20+ records against Postgres

---

## What's NOT in these two milestones

Explicitly deferred:

- **Moving user config to git** (ConnectorAccount, User, Schedule) — needs careful migration plan
- **Replacing server-side Postgres FileIndex** — server continues using Postgres; SQLite is additive
- **Local publish execution** (execute-publish) — the plan-publish exists after Step 2.4 but execution is still server-driven
- **Incremental index rebuild** — full rebuild for now; hook point noted in Step 2.3
- **V1 workspace support** — deliberately dropped
- **Interactive commands** — deliberately dropped
- **Rust workspace (multi-crate split)** — do this after both milestones are stable

---

## Key risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| YAML format mismatch between Go and Rust | High | Write a round-trip compatibility test immediately in Step 1.2, before any other work |
| Directory naming differences in `workspaces init` | High | Read Go CLI source carefully; add integration test comparing both CLIs' init output |
| `git` subprocess not available on PATH | Low | Almost all developers have git; document the requirement; not a concern for CLI users |
| Schema endpoint doesn't exist on NestJS | Medium | Check first; if missing, build-index degrades gracefully (index without FK references) |
| Index gets out of sync (partial failure) | Medium | Always rebuild from scratch (full rebuild); mark index with a "dirty" flag if interrupted |
| `files download` three-way merge edge cases | Medium | Use `git merge -X ours` for Milestone 1 (simple, correct); custom gix merge later |
| Large workspaces (100k+ records) make full rebuild slow | Low for now | Full rebuild is good enough for Milestone 2; document rebuild time; defer incremental |

---

## Challenged assumptions

**"The CLI should share code with scratch-git-2"** — This is true for business logic (merge, plan-publish, build-index) but less true for transport. The CLI needs async HTTP client (reqwest) and subprocess git calls, neither of which scratch-git-2 currently uses. The "sharing" is mostly: same repo, same gix version, and reusing `merge_file_contents` directly. That's still worthwhile, but don't over-rotate on sharing everything.

**"Keep CLI API close to current"** — The Go CLI has interactive prompts for `connections add` and `linked add`. Dropping these is a breaking change. Acceptable because: (a) automation/scripting use cases are better served without interactivity, (b) the new CLI targets developers comfortable with explicit flags. Document the migration: `scratchmd linked add` (interactive) → `scratchmd2 linked add --connection-id X --table-id Y` (explicit).

**"Full rebuild is fine for Milestone 2"** — For 10k records it takes <1 second. For 100k records it may take 10+ seconds. This is acceptable for Milestone 2, but be sure the rebuild runs AFTER the user sees success feedback, not before. Don't block the main operation on the index build.

**"Schemas not stored locally"** — Assumed we need to add a NestJS endpoint. But check: does `linked show` or any existing endpoint return the full schema? If yes, no new endpoint needed — just aggregate what's already available.
