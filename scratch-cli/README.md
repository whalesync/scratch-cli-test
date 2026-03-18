# scratch-cli

A command-line tool (`scratchmd`) that synchronizes local Markdown files with CMS platforms like Webflow and WordPress.

## Overview

`scratchmd` enables local editing of CMS content using AI tools like Claude Code, Cursor, or any text editor. Content is stored as Markdown files with YAML frontmatter, making it easy to manipulate with your preferred tools.

### Key Features

- **Pull** CMS content into local, text-based Markdown files
- **Edit** using your preferred local AI agent with full filesystem context
- **Push** changes back to CMS programmatically
- **Two-way sync** with intelligent conflict handling

## Installation

### Homebrew (macOS, Linux, WSL)

```bash
brew tap whalesync/scratch-cli
brew install scratchmd
```

### Scoop (Windows)

```powershell
scoop bucket add whalesync https://github.com/whalesync/scratch-cli-bucket
scoop install scratchmd
```

### Manual Installation

See [MANUAL_INSTALL.md](MANUAL_INSTALL.md) for direct download links (Windows, macOS, Linux).

### From Source

```bash
git clone https://github.com/whalesync/scratch-cli.git
cd scratch-cli
go build -o scratchmd ./cmd/scratchmd
```

See [build.md](build.md) for detailed build instructions including cross-platform builds.

## Usage

```bash
# Show help and available commands
scratchmd --help

# Show version information
scratchmd --version

# Get help for a specific command
scratchmd <command> --help
```

## Available Commands

### Authentication

```bash
scratchmd auth login               # Authenticate (opens browser for OAuth device code flow)
scratchmd auth login --no-browser   # Display URL to visit manually
scratchmd auth logout               # Remove stored credentials
scratchmd auth status               # Show current authentication status
```

### Workspaces

```bash
scratchmd workspaces list            # List all workspaces
scratchmd workspaces create --name "My Workspace"  # Create a new workspace
scratchmd workspaces show <id>       # Show workspace details
scratchmd workspaces delete <id>     # Delete a workspace
scratchmd workspaces init <id>       # Clone workspace files to local directory
```

### Files

```bash
scratchmd files download            # Download remote changes, three-way merge with local edits
scratchmd files upload              # Upload local changes to server
```

> **Note**: `.schema.json` files in linked table directories are read-only. They describe the table schema and are managed by the server. Local changes to these files are not uploaded.

### Connections

```bash
scratchmd connections list          # List all connections in the workspace
scratchmd connections add           # Authorize a new connection (interactive)
scratchmd connections show <id>     # Show connection details
scratchmd connections remove <id>   # Delete a connection
```

### Linked Tables

```bash
scratchmd linked available          # List available tables from connections
scratchmd linked list               # List linked tables in a workspace
scratchmd linked add                # Link a new table to a workspace
scratchmd linked remove [id]        # Unlink a table
scratchmd linked show [id]          # Show linked table details + pending changes
scratchmd linked pull [id]          # Pull CRM changes into the workspace
scratchmd linked publish [id]       # Publish workspace changes to the CRM
```

### Syncs

```bash
scratchmd syncs list                # List sync configurations
scratchmd syncs show <id>           # Show sync details
scratchmd syncs create --config <file-or-json>  # Create a new sync
scratchmd syncs update <id> --config <file-or-json>  # Update a sync
scratchmd syncs delete <id>         # Delete a sync
scratchmd syncs run <id>            # Execute a sync
```

### Global Flags

| Flag                  | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `-v, --verbose`       | Enable verbose output                                |
| `--config <path>`     | Config file path (default: `.scratchmd.config.yaml`) |
| `--scratch-url <url>` | Override scratch server URL                          |
| `--json`              | Output as JSON (available on most subcommands)       |
| `--yes`               | Skip confirmation prompts                            |
| `--version`           | Show version information                             |
| `-h, --help`          | Show help for any command                            |

## Enabling Command Completion

Cobra CLI automatically generates command completion scripts for a variety of terminals.

### Zsh Completion

Add the following to your `~/.zshrc`:

```zsh
# scratchmd completion caching
_scratchmd_cache=~/.zsh/cache/_scratchmd

# Generate cache once (from first available executable)
if [[ ! -f $_scratchmd_cache ]]; then
  mkdir -p ~/.zsh/cache
  for cmd in scratchmd scratchmd-test scratchmd-local; do
    if command -v $cmd &>/dev/null; then
      $cmd completion zsh > $_scratchmd_cache
      break
    fi
  done
fi

# Load cached completion
[[ -f $_scratchmd_cache ]] && source $_scratchmd_cache

# Map each executable to the completion function
if command -v scratchmd &>/dev/null; then
  compdef _scratchmd scratchmd
fi
if command -v scratchmd-test &>/dev/null; then
  compdef _scratchmd scratchmd-test
fi
if command -v scratchmd-local &>/dev/null; then
  compdef _scratchmd scratchmd-local
fi

unset _scratchmd_cache
```

## License

Private
