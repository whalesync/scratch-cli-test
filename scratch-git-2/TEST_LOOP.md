# V2 Test Loop

End-to-end test loop for the Rust CLI (`scratchmd2`) and the workbook config git repo.

## First-time setup

Build the binary and symlink it into your PATH (re-run after code changes):

```bash
cd scratch-git-2
cargo build --release
sudo ln -sf "$(pwd)/target/release/scratchmd2" /usr/local/bin/scratchmd2
```

Start the scratch-git-2 service (keep running in a separate terminal):

```bash
cd scratch-git-2
cargo run --bin service
# or if using the built binary: ./target/release/service
```

---

## Test loop

### 1. Authenticate

```bash
scratchmd2 auth login
# Follow the prompts — opens browser for Clerk login
```

### 2. Find and initialize the workspace

```bash
scratchmd2 workspaces list
# Note the ID of the workspace you want to test with

scratchmd2 workspaces init <workbook-id>
# Clones all connector git repos to .scratch/connections/<ConnName>/{master,dirty}/
# Also sets up the SQLite index
cd <workbook-id>/                # directory named after the workbook
```

### 3. Download latest files from the CRM

```bash
scratchmd2 files download
# Fetches latest from server, three-way merges with local edits
```

### 4. Inspect the index (optional)

```bash
scratchmd2 build-index           # rebuild from master worktrees
scratchmd2 dump-index            # print all indexed records
scratchmd2 dump-index --connection "AIRTABLE - Airtable"   # scope to one connection
```

### 5. Configure syncs

In the web UI: open the workspace → Syncs tab → create or verify your syncs are configured.

Then push them to the workbook config git repo (admin-only button in Syncs sidebar):
**"Push syncs to git"**

Or via the server init + push APIs directly:
```bash
curl -X POST http://localhost:3010/cli/v1/workbooks/<workbook-id>/config/init \
     -H "Authorization: Bearer <token>"
curl -X POST http://localhost:3010/cli/v1/workbooks/<workbook-id>/config/push-syncs \
     -H "Authorization: Bearer <token>"
```

The workbook config repo is now at `org/<orgId>/<workbookId>/<workbookId>.git` on the server.
Clone it locally to inspect:
```bash
# From inside the workspace directory:
git clone http://localhost:3010/cli/v1/workbooks/<workbook-id>/config/git .scratch/workbook
ls .scratch/workbook/syncs/
# → *.json files, one per sync table pair
```

### 6. Validate syncs locally (coming soon)

```bash
scratchmd2 syncs validate-local
# Reads .scratch/workbook/syncs/*.json
# Checks field names against schema.json for each connection/folder
```

### 7. Run syncs locally (coming soon)

```bash
scratchmd2 syncs run-local
# Applies sync: maps fields from source records → dest dirty worktree
# Writes modified records into .scratch/connections/<DestConn>/dirty/
```

### 8. Upload dirty changes to the server

```bash
scratchmd2 files upload
# Commits local dirty changes and pushes to server
```

### 9. Publish (trigger from server or web UI)

From the web UI: publish via the Files → Publish button.

Or verify what changed:
```bash
scratchmd2 syncs list            # see sync metadata
scratchmd2 syncs run <sync-id>   # trigger server-side sync job (waits for completion)
```

---

## Quick reference

| Command | What it does |
|---|---|
| `scratchmd2 auth login` | Authenticate with the Scratch server |
| `scratchmd2 workspaces list` | List all workspaces |
| `scratchmd2 workspaces init <id>` | Clone workspace locally |
| `scratchmd2 files download` | Fetch + merge latest from server |
| `scratchmd2 files upload` | Push local dirty changes to server |
| `scratchmd2 build-index` | Rebuild SQLite index from master worktrees |
| `scratchmd2 dump-index` | Print index contents |
| `scratchmd2 syncs list` | List syncs for the workspace |
| `scratchmd2 syncs run <id>` | Trigger server-side sync job (waits) |
| `scratchmd2 syncs validate-local` | *(coming)* Validate local sync JSON |
| `scratchmd2 syncs run-local` | *(coming)* Apply sync locally to dirty worktree |
