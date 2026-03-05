# Rust CLI Rewrite — Implementation Plan

**Design doc:** [docs/plans/2026-03-05-rust-cli-design.md](docs/plans/2026-03-05-rust-cli-design.md)
**Source (Go):** `scratch-cli/`
**Target (Rust):** `experimental/scratch-cli-2/`

## Phases

Implementation is ordered so each phase produces a working, testable binary. Earlier phases establish the foundation; later phases port individual command groups from simplest to most complex.

---

### Phase 1: Project Scaffold & CLI Skeleton

> Establish the Rust project, Cargo.toml, and clap command tree with stub commands.

- [ ] Create `experimental/scratch-cli-2/` with `Cargo.toml`
  - Dependencies: clap, reqwest (blocking), gix, dialoguer, serde, serde_json, serde_yaml, anyhow, console
- [ ] Create `src/main.rs` — entry point calling `Cli::parse().run()`
- [ ] Create `src/cli.rs` — `Cli` struct with global flags (`--scratch-url`, `--config`, `--verbose`) and `Command` enum
- [ ] Create `src/commands/mod.rs` — dispatch `Command` variants to submodules
- [ ] Create stub command modules (`auth.rs`, `workbooks.rs`, `files.rs`, `connections.rs`, `linked.rs`, `syncs.rs`) — clap derive structs + `todo!()` run methods
- [ ] Verify: `cargo build` succeeds, `cargo run -- --help` shows all commands/subcommands
- [ ] Create `CLAUDE.md` for the new crate

**Go reference:** `scratch-cli/internal/cmd/root.go` (root command + global flags)

---

### Phase 2: Config & Credentials

> Port config loading/saving so commands can resolve server URL and auth token.

- [ ] Create `src/config.rs` — load/save `scratchmd.config.yaml`
  - `ProjectConfig` struct with serde derives
  - `load()` function: find config file in cwd or ancestors, parse YAML
  - Flag override logic (--scratch-url, --config)
- [ ] Create `src/credentials.rs` — load/save `~/.scratchmd/credentials.yaml`
  - `Credentials` struct with serde derives
  - `load()` / `save()` functions
  - `get_token(server_url)` / `set_token(server_url, token, email, expiry)` helpers
- [ ] Verify: unit tests for config resolution and credential lookup

**Go reference:** `scratch-cli/internal/config/` (3 files)

---

### Phase 3: API Client Core

> Create the `Client` struct with shared HTTP helpers.

- [ ] Create `src/api/mod.rs`
  - `Client::new(base_url, api_token)` constructor
  - Shared `get()`, `post()`, `patch()`, `delete()` helpers
  - Auth header injection (`Authorization: Bearer <token>`)
  - Error parsing: non-2xx → structured error with status + message via `anyhow::bail!`
  - Verbose mode: print request/response when enabled
- [ ] Verify: `cargo build` succeeds

**Go reference:** `scratch-cli/internal/api/client.go`

---

### Phase 4: Auth Commands (3 commands)

> First real end-to-end flow: login, logout, status.

- [ ] Create `src/api/auth.rs` — `Client::initiate_auth()`, `Client::poll_auth()`
- [ ] Implement `commands/auth.rs`:
  - `login` — OAuth device code flow: initiate → display code + URL → poll until approved → save credentials
  - `logout` — remove credentials for current server
  - `status` — load credentials, display email + token expiry
- [ ] Verify: `cargo run -- auth login` works against local server

**Go reference:** `scratch-cli/internal/cmd/auth.go`, `scratch-cli/internal/api/client_auth.go`

---

### Phase 5: Workbooks Commands (5 commands)

> CRUD commands + init (git clone).

- [ ] Create `src/api/workbooks.rs` — list, create, get, delete methods
- [ ] Implement `commands/workbooks.rs`:
  - `list` — table-formatted output, sort flags
  - `create` — create + print result
  - `show` — fetch + print details
  - `delete` — confirm prompt (dialoguer) + delete
  - `init` — create workbook + clone git repo via gitoxide
- [ ] Verify: all 5 subcommands work against local server

**Go reference:** `scratch-cli/internal/cmd/workbooks.go` (777 lines), `scratch-cli/internal/api/client_workbooks.go`

---

### Phase 6: Connections Commands (4 commands)

> CRUD + interactive credential input.

- [ ] Create `src/api/connections.rs` — list, get, create, delete methods
- [ ] Implement `commands/connections.rs`:
  - `list` — table-formatted output
  - `show` — fetch + print details
  - `add` — interactive prompts for connection type + credentials (dialoguer), or via flags
  - `remove` — confirm prompt + delete
- [ ] Verify: all 4 subcommands work against local server

**Go reference:** `scratch-cli/internal/cmd/connections.go` (469 lines), `scratch-cli/internal/api/client_connections.go`

---

### Phase 7: Syncs Commands (6 commands)

> Sync CRUD + run with job polling.

- [ ] Create `src/api/syncs.rs` — list, get, create, update, delete, run methods
- [ ] Create `src/api/jobs.rs` — `Client::get_job_progress(job_id)` method
- [ ] Implement `commands/syncs.rs`:
  - `list`, `show` — table/detail output
  - `create`, `update` — read --config YAML file, send to API
  - `delete` — confirm + delete
  - `run` — trigger sync, poll job progress until complete
- [ ] Verify: all 6 subcommands work

**Go reference:** `scratch-cli/internal/cmd/syncs.go` (543 lines), `scratch-cli/internal/api/client_syncs.go`, `scratch-cli/internal/api/client_jobs.go`

---

### Phase 8: Linked Table Commands (7 commands)

> Linked table management + pull/publish with job polling.

- [ ] Create `src/api/linked.rs` — list available, list linked, create, get, delete, pull, pull-files, publish methods
- [ ] Implement `commands/linked.rs`:
  - `available` — list tables from connections
  - `list` — table-formatted linked tables
  - `add` — interactive table selection (dialoguer) or via flags
  - `remove` — confirm + delete
  - `show` — fetch + print details + pending changes
  - `pull` — trigger pull, poll job progress
  - `publish` — trigger publish, poll job progress
- [ ] Verify: all 7 subcommands work

**Go reference:** `scratch-cli/internal/cmd/linked.go` (876 lines), `scratch-cli/internal/api/client_linked.go`

---

### Phase 9: Three-Way Merge

> Port the merge algorithm before implementing files commands.

- [ ] Create `src/merge/mod.rs` — `MergeAction` enum + `three_way_merge()` orchestration
  - Decision logic: remote-only, local-only, both-changed, deleted cases
  - CRLF normalization
  - `.schema.json` / `.scratchmd*` exclusion
- [ ] Create `src/merge/text.rs` — `merge_text()` line-level merge
  - Diff-based merge using `similar` crate (or `diffy`) — Rust equivalent of `sergi/go-diff`
  - Conflict resolution: local wins
- [ ] Add `similar` (or `diffy`) to Cargo.toml
- [ ] Verify: unit tests covering all merge scenarios (remote-only change, local-only, both changed, deletions, conflicts)

**Go reference:** `scratch-cli/internal/merge/merge.go` (176 lines), `scratch-cli/internal/merge/textmerge.go` (182 lines)

---

### Phase 10: Files Commands (2 commands)

> The most complex commands — download (fetch + three-way merge) and upload (commit + push).

- [ ] Implement `commands/files.rs`:
  - `download`:
    1. Load config, resolve workbook from `.scratchmd.config.yaml`
    2. Git fetch via gitoxide
    3. Compare local vs base vs remote for each file
    4. Apply three-way merge decisions
    5. Write merged files to disk
    6. Update base state
  - `upload`:
    1. Detect local changes vs base
    2. Exclude `.schema.json` and config files
    3. Git add + commit + push via gitoxide
    4. Custom credential helper for auth
- [ ] Verify: download + upload round-trip works against local server

**Go reference:** `scratch-cli/internal/cmd/files.go` (1,169 lines — largest file)

---

### Phase 11: Polish & Parity Check

> Ensure full feature parity with the Go CLI.

- [ ] Audit every command against Go CLI for missing flags, edge cases, or output differences
- [ ] Version injection: add build script or `vergen` for git commit SHA in `--version`
- [ ] Table formatting consistency across all list commands
- [ ] Error messages match Go CLI tone and content
- [ ] Verbose mode (`--verbose`) prints request/response details for all API calls
- [ ] Add `experimental/scratch-cli-2/` to root `.gitignore` Cargo artifact entries if needed
- [ ] Update root `CLAUDE.md` to mention the experimental Rust CLI

---

## Progress

| Phase                     | Status   | Notes                                                                               |
| ------------------------- | -------- | ----------------------------------------------------------------------------------- |
| 1. Project Scaffold       | **Done** | All 28 commands stubbed with correct flags                                          |
| 2. Config & Credentials   | **Done** | config.rs + credentials.rs with multi-env support                                   |
| 3. API Client Core        | **Done** | Client struct with get/post/patch/delete + verbose mode                             |
| 4. Auth Commands          | **Done** | login (device code flow), logout, status                                            |
| 5. Workbooks Commands     | **Done** | list, create, show, delete, init (V1 + V2)                                          |
| 6. Connections Commands   | **Done** | list, add (interactive + flags), show, remove                                       |
| 7. Syncs Commands         | **Done** | list, show, create, update, delete, run                                             |
| 8. Linked Table Commands  | **Done** | available, list, add, remove, show, pull (+ --file), publish                        |
| 9. Three-Way Merge        | **Done** | merge/mod.rs + merge/text.rs with 6 unit tests passing                              |
| 10. Files Commands        | **Done** | download (fetch + 3-way merge) + upload (commit + push with retry) using system git |
| 11. Polish & Parity Check | **Done** | Added missing --json flags, --file flag wired up, gix → system git                  |
