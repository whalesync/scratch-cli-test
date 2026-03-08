# scratch-v3

Standalone Scratch prototype: Rust engine + Python UI + E2E scenario tests.

Syncs data between external services (Airtable, WordPress) through a git-based
storage layer. Includes a CLI, a web UI, and validation/transform pipelines.

## Architecture

```
scratch CLI  →  scratch-ui (FastAPI :8000)  →  scratch-git-2 (Rust :3100)
                    ↕                              ↕
              connectors (Airtable, WP)      bare git repos on disk
```

| Component | Path | What it is |
|-----------|------|------------|
| scratch-engine | `scratch-engine/` | Rust workspace: CLI, sync, transform, validate, publish, PyO3 bindings |
| scratch-ui | `scratch-ui/` | FastAPI + HTMX + SQLite — web UI and JSON API |
| scratch-scenarios | `scratch-scenarios/` | E2E tests: Airtable → Scratch → WordPress |
| scratch-git-2 | `../../scratch-git-2/` | Git storage microservice (shared with main repo) |

## Quick Start

### Prerequisites

- Rust toolchain (`rustup`)
- Python 3.10+ with `venv`
- `jq` (for scenario tests)

### 1. Setup (one time)

```bash
./setup.sh
```

This builds everything: scratch-git-2, scratch CLI, Python engine (maturin),
and installs Python dependencies.

### 2. Start servers

```bash
./start.sh
```

Starts scratch-git-2 (:3100) and scratch-ui (:8000). Ctrl-C stops both.

### 3. Run scenario tests

```bash
# Get the .env file from a teammate (contains Airtable + WordPress credentials)
cp /path/to/shared/.env scratch-scenarios/.env

cd scratch-scenarios
./run.sh
```

Runs all phases: setup → first sync → idempotency check.

## What the scenario test does

| Phase | What happens |
|-------|-------------|
| 0 - Setup | Creates workspace, connections, tables, syncs via CLI |
| 1 - First sync | Resets WordPress → sync → pull → validate → diff → publish → assert |
| 2 - Idempotency | Re-runs the full pipeline, verifies no unintended changes |

Teardown resets WordPress and cleans up the temp workspace automatically.

## Key concepts

- **Workspace**: owns a set of connections, folders, and syncs
- **Connection**: credentials for an external service (Airtable, WordPress)
- **Folder**: a linked table from a connection, stored as JSON files in git
- **Sync**: maps fields from a source folder to a destination folder
- **Transformers**: `slugify`, `auto_convert`, `lookup_field`, etc.
- **Validators**: JSON Schema validation + `readonly_fields` (protects fields from sync changes)
- **Two-branch model**: `main` = published state, `dirty` = working state

## CLI commands

```bash
scratch workspace create --name "My Workspace"
scratch connection add --service AIRTABLE --param apiKey="$TOKEN"
scratch table add <conn-id> --table "Posts"
scratch sync create --name "Posts → WP" --config sync.json
scratch pull
scratch sync run --all
scratch validate
scratch diff
scratch publish
```
