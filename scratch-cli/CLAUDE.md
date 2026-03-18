# scratch-cli Project

## Overview

This is the `scratch-cli` Go project containing the `scratchmd` CLI tool — a command-line tool that synchronizes local Markdown files with CMS platforms (Webflow, WordPress, Airtable, Shopify, etc.) via the Scratch.md API.

## Project Structure

```
scratch-cli/
├── cmd/
│   └── scratchmd/
│       └── main.go                  # Entry point (builds to `scratchmd` binary)
├── internal/
│   ├── cmd/
│   │   ├── root.go                  # Root command and CLI setup
│   │   ├── auth.go                  # Auth commands (login, logout, status)
│   │   ├── workbooks.go             # Workbook commands (list, create, show, delete, init)
│   │   ├── files.go                 # File commands (download, upload)
│   │   ├── connections.go           # Connection commands (list, add, show, remove)
│   │   ├── linked.go               # Linked table commands (available, list, add, remove, show, pull, publish)
│   │   └── syncs.go                # Sync commands (list, show, create, update, delete, run)
│   ├── config/
│   │   ├── config.go                # Configuration management
│   │   ├── credentials.go           # Credentials storage
│   │   └── overrides.go             # Config overrides
│   ├── api/
│   │   ├── client.go                # Base API client (auth headers, request helpers)
│   │   ├── client_auth.go           # Auth API methods
│   │   ├── client_workbooks.go      # Workbook API methods
│   │   ├── client_linked.go         # Linked table API methods
│   │   ├── client_connections.go    # Connection API methods
│   │   ├── client_syncs.go          # Sync API methods
│   │   └── client_jobs.go           # Job polling API methods
│   └── merge/
│       ├── merge.go                 # Three-way merge orchestration
│       └── textmerge.go             # Line-level text merging
├── go.mod                           # Go module: github.com/whalesync/scratch-cli
├── go.sum                           # Dependency checksums
├── CLAUDE.md                        # This file (development context for AI)
├── AGENT.md                         # LLM agent quick reference for programmatic usage
└── README.md                        # User documentation
```

## Technology Stack

- **Language**: Go 1.21+
- **CLI Framework**: [Cobra](https://github.com/spf13/cobra) - industry standard for Go CLIs
- **YAML**: [gopkg.in/yaml.v3](https://pkg.go.dev/gopkg.in/yaml.v3) - for configuration files

## Naming Convention

- **Project name**: `scratch-cli` (repo, module, folder)
- **CLI command**: `scratchmd` (the binary users run)
- **Config files**: `.scratchmd.*` (user-facing files use the command name)

## Key Design Decisions

1. **Cobra for CLI**: Using spf13/cobra for command structure, flag parsing, and help generation
2. **Internal package**: Business logic lives in `internal/` to prevent external imports
3. **Version injection**: Version info is injected at build time via ldflags
4. **Device code auth**: Uses OAuth device code flow for authentication

---

## Available Commands

### Authentication

```bash
scratchmd auth login              # Authenticate with Scratch.md (opens browser)
scratchmd auth logout             # Remove stored credentials
scratchmd auth status             # Show current authentication status
```

### Workspaces

```bash
scratchmd workspaces list          # List all workspaces
scratchmd workspaces create        # Create a new workspace
scratchmd workspaces show <id>     # Show workspace details
scratchmd workspaces delete <id>   # Delete a workspace
scratchmd workspaces init <id>     # Clone workspace files to local directory
```

### Files

```bash
scratchmd files download          # Download remote changes, three-way merge with local edits
scratchmd files upload            # Upload local changes to server
```

### Connections

```bash
scratchmd connections list        # List all connections in the workspace
scratchmd connections add         # Authorize a new connection (interactive or via flags)
scratchmd connections show <id>   # Show connection details
scratchmd connections remove <id> # Delete a connection
```

### Linked Tables

```bash
scratchmd linked available        # List available tables from connections
scratchmd linked list             # List linked tables in a workspace
scratchmd linked add              # Link a new table to a workspace
scratchmd linked remove [id]      # Unlink a table
scratchmd linked show [id]        # Show linked table details + pending changes
scratchmd linked pull [id]        # Pull CRM changes into the workspace
scratchmd linked publish [id]     # Publish workspace changes to the CRM
```

### Syncs

```bash
scratchmd syncs list              # List sync configurations
scratchmd syncs show <id>         # Show sync details
scratchmd syncs create            # Create a new sync (requires --config)
scratchmd syncs update <id>       # Update a sync (requires --config)
scratchmd syncs delete <id>       # Delete a sync
scratchmd syncs run <id>          # Execute a sync and wait for completion
```

### Common Flags

| Flag                  | Scope                       | Description                                          |
| --------------------- | --------------------------- | ---------------------------------------------------- |
| `--json`              | most subcommands            | Output as JSON (stdout)                              |
| `--yes`               | destructive commands        | Skip confirmation prompts                            |
| `--workspace <id>`    | linked, syncs, connections  | Override workspace auto-detection                    |
| `--scratch-url <url>` | global                      | Override scratch server URL                          |
| `--config <path>`     | global                      | Config file path (default: `.scratchmd.config.yaml`) |
| `-v, --verbose`       | global                      | Enable verbose output                                |
| `--no-browser`        | auth login                  | Don't open browser automatically                     |
| `--server <url>`      | auth commands               | Override the auth server URL                         |
| `-o, --output <dir>`  | workspaces init             | Output directory for clone                           |
| `--force`             | workspaces init             | Overwrite existing local copy                        |
| `--sort-by`           | workspaces list             | Sort field (name, createdAt, updatedAt)              |
| `--sort-order`        | workspaces list             | Sort direction (asc, desc)                           |
| `--connection-id`     | linked add                  | Connection ID (non-interactive mode)                 |
| `--table-id`          | linked add                  | Table ID (non-interactive, repeatable)               |
| `--name`              | linked add, connections add | Display name                                         |
| `--refresh`           | linked available            | Force refresh from connector                         |
| `--service`           | connections add             | Service type (non-interactive mode)                  |
| `--param`             | connections add             | Credential key=value (repeatable)                    |
| `--config`            | syncs create/update         | JSON config (file path or inline)                    |
| `--no-wait`           | syncs run                   | Return job ID without waiting                        |

---

## Building

```bash
# Quick build
go build -o scratchmd ./cmd/scratchmd

# With version info
go build -ldflags "-X 'github.com/whalesync/scratch-cli/internal/cmd.version=0.1.0'" -o scratchmd ./cmd/scratchmd
```

## Code formatting

Use the standard `gofmt` after generating code

```bash
gofmt -w .
```

## Package Details

### `internal/cmd/`

Cobra command definitions. Each command gets its own file.

### `internal/config/`

Configuration management:

- `config.go` - Loads/saves `scratchmd.config.yaml`
- `credentials.go` - Manages API credentials stored in `~/.scratchmd/credentials.yaml`
- `overrides.go` - CLI flag overrides for config values

### `internal/api/`

API client for communicating with the Scratch.md server. Split into per-domain files (`client_auth.go`, `client_workbooks.go`, `client_linked.go`, `client_connections.go`, `client_syncs.go`, `client_jobs.go`).

### `internal/merge/`

Three-way merge logic used by `files download` and `files upload`. Handles line-level text merge with local-wins conflict resolution and CRLF normalization.

## Configuration Files

The tool uses these config files:

- `~/.scratchmd/credentials.yaml` - API tokens per server (created by `auth login`)
- `scratchmd.config.yaml` - Project settings (optional)

## Read-Only Files

- **`.schema.json`**: Each linked table directory contains a `.schema.json` file describing the table schema. This file is **read-only** on the CLI side — it is managed by the server and excluded from `files upload`. The filter is in `diskToFileMap()` in `internal/cmd/files.go`.

## Development Guidelines

1. **Commands go in internal/cmd/**: Each command gets its own file
2. **Use Cobra conventions**: Subcommands, flags, persistent flags
3. **Error handling**: Return errors up the call stack
4. **Run gofmt -w .** after changes
5. **Test with go build ./...** to verify compilation
