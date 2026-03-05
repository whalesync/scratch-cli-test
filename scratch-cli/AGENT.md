# scratchmd CLI - LLM Agent Reference

Quick reference for AI agents using the scratchmd CLI programmatically.

## Key Principles

- **Always use `--json`** on commands that support it. JSON goes to **stdout**, errors/progress to **stderr**.
- **Always use `--yes`** on destructive commands (`delete`, `remove`) to skip interactive confirmation prompts.
- **Always use non-interactive flags** for `linked add` (`--connection-id`, `--table-id`, `--name`) — the interactive mode uses terminal prompts that will hang in non-interactive environments.
- **Context auto-detection**: Most commands auto-detect the workspace/data-folder from `.scratchmd` marker files in the current directory (walks upward). Run commands from within the workbook directory to skip passing IDs.
- **Exit codes**: `0` = success, `1` = error (check stderr for message).

---

## Quick Start Workflow

```bash
# 1. Authenticate (one-time, interactive — requires browser)
scratchmd auth login

# 2. List workspaces
scratchmd workspaces list --json

# 3. Initialize a workspace locally (clones files to disk)
scratchmd workspaces init <workspace-id> --json

# 4. Navigate into the workspace directory
cd <WorkspaceName>

# 5. Download latest changes from server
scratchmd files download --json

# 6. Edit files locally (markdown, JSON, etc.)

# 7. Upload local changes to server
scratchmd files upload --json

# 8. Add a connection (needed before linking tables)
scratchmd connections add --service WEBFLOW --param apiKey=<key> --json

# 9. Link a table from the connection
scratchmd linked add --connection-id <conn-id> --table-id <table-id> --name "My Table" --json

# 10. Pull CRM changes into workspace (async — polls until done, then downloads)
scratchmd linked pull --json

# 11. Publish workspace changes to CRM (async — polls until done, then downloads)
scratchmd linked publish --json
```

---

## All Commands

### Authentication

```bash
scratchmd auth login               # Authenticate (opens browser for OAuth device code flow)
scratchmd auth login --no-browser   # Display URL to visit manually instead of opening browser
scratchmd auth login --server <url> # Authenticate against a specific server
scratchmd auth logout               # Remove stored credentials
scratchmd auth status               # Show current authentication status
```

> **Note**: `auth login` is interactive and requires a browser. No `--json` flag available.

### Workspaces

```bash
scratchmd workspaces list --json                                # List all workspaces
scratchmd workspaces list --json --sort-by name --sort-order asc # Sort by name/createdAt/updatedAt, asc/desc
scratchmd workspaces create --name "My Workspace" --json         # Create a new workspace
scratchmd workspaces show <id> --json                           # Show workspace details
scratchmd workspaces delete <id> --yes                          # Delete a workspace (--yes skips confirmation)
scratchmd workspaces init <id> --json                           # Clone workspace files to local directory
scratchmd workspaces init <id> --json -o ./path                 # Clone to a specific output directory
scratchmd workspaces init <id> --json --force                   # Overwrite existing local copy
```

### Linked Tables

All `linked` subcommands accept `--workspace <id>` to specify the workspace. If omitted, the workspace is auto-detected from the current directory's `.scratchmd` marker.

Commands that take `[id]` auto-detect the data folder ID when run from within a data folder directory.

```bash
# Discovery
scratchmd linked available --json                        # List available tables from all connections
scratchmd linked available <connection-id> --json        # List tables from a specific connection
scratchmd linked available --json --refresh              # Force refresh from connector

# Management
scratchmd linked list --json                             # List linked tables in workspace
scratchmd linked show [id] --json                        # Show linked table details + pending changes
scratchmd linked add --json \                            # Link a table (non-interactive mode)
  --connection-id <conn-id> \
  --table-id <table-id> \
  --name "My Table"
scratchmd linked add --json \                            # Link multiple tables at once
  --connection-id <conn-id> \
  --table-id <id1> --table-id <id2> \
  --name "My Tables"
scratchmd linked remove [id] --json --yes                # Unlink a table (--yes skips confirmation)

# Sync
scratchmd linked pull [id] --json                        # Pull CRM changes into workspace (async)
scratchmd linked publish [id] --json                     # Publish workspace changes to CRM (async)
```

### Files

```bash
scratchmd files download --json              # Download remote changes, three-way merge with local edits
scratchmd files download <workspace-id> --json # Download for a specific workspace (when not in workspace dir)
scratchmd files upload --json                # Upload local changes to server
scratchmd files upload <workspace-id> --json  # Upload for a specific workspace
```

### Connections

All `connections` subcommands accept `--workspace <id>` to specify the workspace. If omitted, the workspace is auto-detected from the current directory's `.scratchmd` marker.

```bash
# List connections
scratchmd connections list --json

# Add a connection (interactive — prompts for service and credentials)
scratchmd connections add

# Add a connection (non-interactive)
scratchmd connections add --json --service AIRTABLE --param apiKey=<token>
scratchmd connections add --json --service WEBFLOW --param apiKey=<key>
scratchmd connections add --json --service SHOPIFY --param shopDomain=my-store --param apiKey=<key>
scratchmd connections add --json --service WORDPRESS --param endpoint=https://example.com --param username=admin --param password=<app-password>
scratchmd connections add --json --service MOCO --param domain=yourcompany --param apiKey=<key>
scratchmd connections add --json --service POSTGRES --param connectionString=postgresql://user:pass@host:5432/db
scratchmd connections add --json --service AIRTABLE --param apiKey=<token> --name "My Airtable"

# Show / remove
scratchmd connections show <id> --json
scratchmd connections remove <id> --json --yes
```

> **Supported services**: `AIRTABLE`, `WEBFLOW`, `SHOPIFY`, `MOCO`, `AUDIENCEFUL`, `WORDPRESS`, `POSTGRES`

### Syncs

All `syncs` subcommands accept `--workspace <id>`. If omitted, auto-detected from the current directory.

```bash
scratchmd syncs list --json                                          # List sync configurations
scratchmd syncs show <sync-id> --json                                # Show sync details
scratchmd syncs create --config sync-config.json --json              # Create from JSON file
scratchmd syncs create --config '{"name":"My Sync",...}' --json      # Create from inline JSON
scratchmd syncs update <sync-id> --config sync-config.json --json    # Update a sync
scratchmd syncs delete <sync-id> --yes                               # Delete (--yes skips confirmation)
scratchmd syncs run <sync-id> --json                                 # Run and wait for completion
scratchmd syncs run <sync-id> --json --no-wait                       # Run and return job ID immediately
```

### Global Flags

| Flag | Description |
|------|-------------|
| `-v, --verbose` | Enable verbose output |
| `--config <path>` | Config file path (default: `.scratchmd.config.yaml`) |
| `--scratch-url <url>` | Override scratch server URL |
| `--version` | Show version information |
| `-h, --help` | Show help for any command |

---

## JSON Output Shapes

### workspaces list

```json
{
  "workbooks": [
    { "id": "...", "name": "...", "tableCount": 0, "createdAt": "...", "updatedAt": "..." }
  ],
  "total": 1
}
```

### workspaces create / workspaces show

```json
{ "id": "...", "name": "...", "tableCount": 0, "createdAt": "...", "updatedAt": "...", "gitUrl": "..." }
```

### workspaces init

```json
{ "workbookId": "...", "workbookName": "...", "directory": "./MyWorkspace", "fileCount": 12 }
```

### files download

```json
{
  "status": "downloaded",
  "filesUpdated": 2,
  "filesCreated": 1,
  "filesDeleted": 0,
  "filesMerged": 1,
  "conflictsAutoResolved": 1,
  "messages": []
}
```

`status` is `"downloaded"` or `"up_to_date"`.

### files upload

```json
{
  "status": "uploaded",
  "filesUploaded": 3,
  "filesMerged": 0,
  "filesDeleted": 0,
  "conflictsAutoResolved": 0,
  "retries": 0,
  "messages": []
}
```

`status` is `"uploaded"`, `"no_changes"`, or `"up_to_date"`. `retries` indicates how many optimistic concurrency retries occurred (max 5).

### linked pull / linked publish

```json
{ "jobID": "..." }
```

> **Note**: With `--json`, pull/publish return the job ID immediately and do **not** poll or download. Without `--json`, they poll until completion and then auto-download.

### linked remove

```json
{ "success": true, "id": "...", "name": "..." }
```

### linked show

```json
{
  "id": "...", "name": "...",
  "connectorService": "webflow",
  "connectorDisplayName": "My Webflow",
  "lastSyncTime": "2024-01-15T10:30:00Z",
  "lock": null,
  "hasChanges": true,
  "creates": 2, "updates": 1, "deletes": 0
}
```

### connections list

```json
[
  {
    "id": "...",
    "service": "WEBFLOW",
    "displayName": "My Webflow",
    "authType": "USER_PROVIDED_PARAMS",
    "healthStatus": "HEALTHY",
    "healthStatusMessage": null,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
]
```

### connections add / connections show

```json
{
  "id": "...",
  "service": "WEBFLOW",
  "displayName": "My Webflow",
  "authType": "USER_PROVIDED_PARAMS",
  "healthStatus": "HEALTHY",
  "healthStatusMessage": null,
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

### connections remove

```json
{ "success": true, "id": "...", "name": "..." }
```

### syncs list

```json
[
  {
    "id": "...",
    "displayName": "My Sync",
    "displayOrder": 0,
    "syncState": "IDLE",
    "syncStateLastChanged": "2024-01-15T10:30:00Z",
    "lastSyncTime": "2024-01-15T10:30:00Z",
    "createdAt": "...",
    "updatedAt": "...",
    "syncTablePairs": [
      { "id": "...", "syncId": "...", "sourceDataFolderId": "...", "destinationDataFolderId": "..." }
    ]
  }
]
```

### syncs create / syncs show / syncs update

Same shape as a single element from `syncs list`.

### syncs delete

```json
{ "success": true, "id": "...", "name": "..." }
```

### syncs run

```json
{ "success": true, "jobId": "...", "message": "Sync completed successfully" }
```

With `--no-wait`, returns immediately:

```json
{ "success": true, "jobId": "...", "message": "..." }
```

---

## Context Detection

The CLI uses `.scratchmd` YAML marker files to auto-detect context:

**Workspace root** (created by `workspaces init`):
```yaml
version: "1"
workbook:
  id: "wb_abc123"
  name: "My Workspace"
  serverUrl: "https://api.scratch.md"
  initializedAt: "2024-01-15T10:30:00Z"
```

**Data folder** (created inside each linked table subdirectory):
```yaml
version: "1"
dataFolder:
  id: "df_abc123"
  name: "Blog Posts"
```

The CLI walks upward from the current directory to find these markers. This means:
- From `MyWorkspace/` — workspace context is detected for `files`, `linked list`, etc.
- From `MyWorkspace/BlogPosts/` — both workspace and data folder context are detected for `linked show`, `linked pull`, etc.

---

## Async Operations (Pull & Publish)

`linked pull` and `linked publish` are async server operations:

- **Without `--json`**: The CLI starts the job, polls every 2s (prints dots to stderr), and auto-runs `files download` on completion. Timeout is 30 minutes.
- **With `--json`**: Returns `{"jobID": "..."}` immediately. The agent must handle polling separately if needed.

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| `"not logged in"` | Run `scratchmd auth login` |
| `"Token expired"` | Run `scratchmd auth login` to get a new token |
| `"not inside a workspace directory"` | Run from a directory with `.scratchmd` marker, or pass the workspace ID explicitly |
| `"upload failed after 5 attempts"` | Concurrent server changes caused all retries to fail; try again |
| Browser doesn't open | Use `--no-browser` flag and visit the URL manually |
| Command hangs | Likely hit an interactive prompt; use `--yes` or non-interactive flags |

## Read-Only Files

- **`.schema.json`**: Each linked table directory contains a `.schema.json` file that describes the table schema (column names, types, etc.). This file is **read-only** — it is managed by the server and will not be uploaded during `files upload`. Local modifications to `.schema.json` are ignored.

## Merge Behavior

- **Three-way merge**: Download and upload both use base/local/remote three-way merge.
- **Local wins**: On conflict, local changes take priority.
- **Text files**: Line-level merge preserving formatting.
- **Binary files**: Atomic replacement (local wins).
- **CRLF normalization**: All text normalized to LF internally for cross-platform consistency.
