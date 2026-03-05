# Rust CLI Rewrite Design

**Date:** 2026-03-05
**Status:** Approved
**Location:** `experimental/scratch-cli-2/`

## Motivation

Unify the CLI tooling with `scratch-git-2` under a single Rust toolchain. The Go CLI (`scratch-cli/`) works well but having two Rust projects means shared expertise, one build system, and potential for future code sharing.

## Scope

Exact 1:1 port of all 28 commands from the Go CLI. Same commands, same flags, same behavior. The Rust CLI is an independent project — it does not share crates with `scratch-git-2`.

## Technology Choices

| Concern             | Go (current)       | Rust (new)               |
| ------------------- | ------------------ | ------------------------ |
| CLI framework       | spf13/cobra        | clap 4.x (derive macros) |
| HTTP client         | net/http (stdlib)  | reqwest (blocking)       |
| Git operations      | go-git             | gitoxide (gix)           |
| Interactive prompts | AlecAivazis/survey | dialoguer                |
| Config format       | gopkg.in/yaml.v3   | serde + serde_yaml       |
| Error handling      | Go errors          | anyhow                   |
| Terminal colors     | manual isatty      | console crate            |
| Serialization       | encoding/json      | serde + serde_json       |

**No async runtime.** Using `reqwest::blocking` to keep the code simple and close to the synchronous Go original.

## Project Structure

```
experimental/scratch-cli-2/
├── Cargo.toml
├── CLAUDE.md
└── src/
    ├── main.rs              # Entry point, Cli::parse().run()
    ├── cli.rs               # Top-level Cli struct + Command enum
    ├── api/
    │   ├── mod.rs           # Client struct, constructor, shared HTTP helpers
    │   ├── auth.rs          # InitiateAuth, PollAuth
    │   ├── workbooks.rs     # CRUD workbooks
    │   ├── connections.rs   # CRUD connections
    │   ├── linked.rs        # Linked table ops + pull/publish
    │   ├── syncs.rs         # Sync CRUD + run
    │   └── jobs.rs          # Job progress polling
    ├── commands/
    │   ├── mod.rs           # Command enum + dispatch
    │   ├── auth.rs          # login, logout, status
    │   ├── workbooks.rs     # list, create, show, delete, init
    │   ├── files.rs         # download, upload
    │   ├── connections.rs   # list, add, show, remove
    │   ├── linked.rs        # available, list, add, remove, show, pull, publish
    │   └── syncs.rs         # list, show, create, update, delete, run
    ├── config.rs            # scratchmd.config.yaml loading/saving
    ├── credentials.rs       # ~/.scratchmd/credentials.yaml
    └── merge/
        ├── mod.rs           # Three-way merge orchestration
        └── text.rs          # Line-level text merge with conflict resolution
```

## API Client Design

A single `Client` struct with methods added via `impl Client` blocks in separate files:

```rust
// api/mod.rs
pub struct Client {
    http: reqwest::blocking::Client,
    base_url: String,
    api_token: Option<String>,
}

impl Client {
    pub fn new(base_url: &str, api_token: Option<&str>) -> Result<Self>;

    // Shared helpers — add auth header, parse errors, etc.
    fn get(&self, path: &str) -> Result<reqwest::blocking::Response>;
    fn post<T: Serialize>(&self, path: &str, body: &T) -> Result<reqwest::blocking::Response>;
    fn patch<T: Serialize>(&self, path: &str, body: &T) -> Result<reqwest::blocking::Response>;
    fn delete(&self, path: &str) -> Result<reqwest::blocking::Response>;
}
```

```rust
// api/workbooks.rs — each resource file adds methods to Client
impl Client {
    pub fn list_workbooks(&self, sort_by: Option<&str>, sort_order: Option<&str>) -> Result<Vec<Workbook>>;
    pub fn create_workbook(&self, name: &str) -> Result<Workbook>;
    pub fn get_workbook(&self, id: &str) -> Result<Workbook>;
    pub fn delete_workbook(&self, id: &str) -> Result<()>;
}
```

API response types are `#[derive(Deserialize)]` structs defined alongside the methods they serve. Error responses (non-2xx) are parsed into a structured error with status code and server message, surfaced via `anyhow::bail!`.

### API Endpoints (31 total, matching Go CLI)

- **Auth (2):** POST /auth/initiate, POST /auth/poll
- **Health (1):** GET /health
- **Workbooks (4):** GET/POST /workbooks, GET/DELETE /workbooks/{id}
- **Connections (4):** CRUD on /workbooks/{id}/connections
- **Linked Tables (9):** CRUD + pull/publish on /workbooks/{id}/linked
- **Syncs (7):** CRUD + run on /workbooks/{id}/syncs
- **Jobs (1):** GET /jobs/{id}/progress

## Command Dispatch

Clap derive macros define the command tree. Each command group is a struct with a subcommand enum:

```rust
// cli.rs
#[derive(Parser)]
#[command(name = "scratchmd", version, about)]
pub struct Cli {
    #[arg(long)]
    pub scratch_url: Option<String>,
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub verbose: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    Auth(commands::auth::AuthCommand),
    Workbooks(commands::workbooks::WorkbooksCommand),
    Files(commands::files::FilesCommand),
    Connections(commands::connections::ConnectionsCommand),
    Linked(commands::linked::LinkedCommand),
    Syncs(commands::syncs::SyncsCommand),
}
```

```rust
// commands/workbooks.rs
#[derive(Args)]
pub struct WorkbooksCommand {
    #[command(subcommand)]
    pub action: WorkbooksAction,
}

#[derive(Subcommand)]
pub enum WorkbooksAction {
    List {
        #[arg(long)]
        sort_by: Option<String>,
        #[arg(long)]
        sort_order: Option<String>,
    },
    Create { #[arg(long)] name: String },
    Show { id: String },
    Delete { id: String },
    Init { id: String },
}
```

Each command module has a `run` method that: loads config/credentials, builds a `Client`, executes the action, and prints results. Interactive prompts (dialoguer) live in the command layer, not the API layer.

## Commands (28 total)

| Group       | Commands                                          | Notes                           |
| ----------- | ------------------------------------------------- | ------------------------------- |
| auth        | login, logout, status                             | OAuth device code flow          |
| workbooks   | list, create, show, delete, init                  | init clones via gitoxide        |
| files       | download, upload                                  | Three-way merge on download     |
| connections | list, add, show, remove                           | Interactive credential input    |
| linked      | available, list, add, remove, show, pull, publish | Job polling for pull/publish    |
| syncs       | list, show, create, update, delete, run           | --config flag for create/update |

## Configuration System

Two-layer config, identical to Go:

1. **Project config** — `scratchmd.config.yaml` in working directory

   - Version identifier
   - Server URL override

2. **User credentials** — `~/.scratchmd/credentials.yaml`
   - API tokens keyed by server URL
   - User email, token expiry

CLI flags (`--scratch-url`, `--config`, `--verbose`) override file values.

```rust
// config.rs
#[derive(Serialize, Deserialize)]
pub struct ProjectConfig {
    pub version: Option<String>,
    pub scratch_url: Option<String>,
}

// credentials.rs
#[derive(Serialize, Deserialize)]
pub struct Credentials {
    pub servers: HashMap<String, ServerCredential>,
}

#[derive(Serialize, Deserialize)]
pub struct ServerCredential {
    pub token: String,
    pub email: Option<String>,
    pub expires_at: Option<String>,
}
```

## Three-Way Merge

Direct port of the Go merge logic:

- **Base state:** Original from server (stored locally after last download)
- **Local state:** Current working directory files
- **Remote state:** Latest from server

**Decision rules (local-wins):**

- Only remote changed → write remote version
- Only local changed → keep local version
- Both changed differently → line-level text merge, local wins conflicts
- Remote deleted, local unchanged → delete
- Local deleted → keep deleted

**Special cases:**

- `.schema.json` files are read-only, excluded from uploads
- CRLF normalization for cross-platform compatibility
- Config files (`.scratchmd*`) auto-detected and excluded

```rust
// merge/mod.rs
pub enum MergeAction {
    KeepLocal,
    WriteRemote { content: Vec<u8> },
    Delete,
    Merge { content: Vec<u8> },
}

pub fn three_way_merge(base: Option<&[u8]>, local: Option<&[u8]>, remote: Option<&[u8]>) -> MergeAction;
```

```rust
// merge/text.rs
pub fn merge_text(base: &str, local: &str, remote: &str) -> (String, bool);
// Returns merged text and whether conflicts occurred
```

## Git Operations

Using gitoxide (`gix`) for:

- **Clone** — `workbooks init` clones the workbook repo
- **Fetch** — `files download` fetches latest from remote
- **Push** — `files upload` pushes local commits
- **Auth** — Custom credential helper that provides the API token

This mirrors Go's use of go-git with a custom `AuthMethod`. Gitoxide supports custom credential callbacks for the same pattern.

## Terminal Output

- `console` crate for colored output and isatty detection
- Table formatting for list commands (workbooks list, connections list, etc.)
- Progress indicators for long-running operations (job polling)
- Verbose mode (`--verbose`) prints request/response details

## Version Injection

Build-time version via `clap`'s built-in `#[command(version)]` plus Cargo's `CARGO_PKG_VERSION`. For git SHA, use a build script or `vergen` crate to embed commit info at compile time.
