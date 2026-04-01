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
# Clones all connector git repos into .repos/ and materializes files under the workspace root
# Also sets up the SQLite index
cd <workbook-name>/              # directory named after the workbook
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
**"Push syncs to git" (deprecated legacy/manual path)**

Normal sync create/update/delete flows now keep the workbook config repo up to date automatically.
These server init + push APIs are deprecated and kept only for legacy/manual use:
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
git clone http://localhost:3010/cli/v1/workbooks/<workbook-id>/config/git .scratch/workspace
ls .scratch/workspace/syncs/
# → *.json files, one per sync table pair
```

### 6. Validate syncs locally (coming soon)

```bash
scratchmd2 syncs validate-local
# Reads .scratch/workspace/syncs/*.json
# Checks field names against schema.json for each connection/folder
```

### 7. Run syncs locally (coming soon)

```bash
scratchmd2 syncs run-local
# Applies sync: maps fields from source records → dest dirty worktree
# Writes modified records into the destination connection folder at the workspace root
```

### 8. Build a publish plan

```bash
scratchmd2 plan-publish
# Diffs dirty vs master for each connection
# Strips FK refs to deleted records, pseudo-refs, and asset refs
# Writes plan to {conn}/.scratch/publish-plans/{timestamp}/
# Only one plan is kept per connection — old plan is deleted automatically
```

### 9. Push changes (including the publish plan)

```bash
scratchmd2 files upload
# Commits local dirty changes (including .scratch/publish-plans/) and pushes to server
```

### 10. Trigger publish from the plan

```bash
scratchmd2 publish-from-git
# For each connection with a publish plan, calls the server to execute it
# Server reads the plan from git (dirty branch) and applies it to the remote CMS
# Prints the queued job ID for each connection
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
| `scratchmd2 syncs validate-local` | Validate local sync JSON configs |
| `scratchmd2 syncs run-local` | Apply sync locally to dirty worktree |
| `scratchmd2 plan-publish` | Build publish plan (diff dirty vs master) |
| `scratchmd2 publish-from-git` | Trigger server publish from local plan |
