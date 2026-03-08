# scratch-v3

## Getting Started

1. Run `./setup.sh` to build everything (Rust CLI, Python engine, dependencies)
2. Run `./start.sh` to start servers (scratch-git-2 on :3100, scratch-ui on :8000)
3. Run `cd scratch-scenarios && ./run.sh` to run E2E tests

## Structure

- `scratch-engine/` — Rust workspace (CLI, sync, transform, validate, publish, PyO3 bindings)
- `scratch-ui/` — FastAPI + HTMX + SQLite server and web UI
- `scratch-scenarios/` — E2E scenario tests (Airtable → WordPress)
- `../../scratch-git-2/` — Git storage microservice (lives in main repo root)

## Build Commands

```bash
# Rebuild CLI after Rust changes
cd scratch-engine && cargo build -p scratch-cli

# Rebuild Python engine after PyO3 changes
cd scratch-engine/crates/scratch-engine-py
VIRTUAL_ENV=../../scratch-ui/.venv ../../scratch-ui/.venv/bin/maturin develop --release

# Run scenario tests
cd scratch-scenarios && ./run.sh

# Run a single phase
cd scratch-scenarios && ./run.sh phase0
```

## Key Files

- `scratch-engine/crates/scratch-cli/src/main.rs` — CLI entry point
- `scratch-engine/crates/scratch-cli/src/commands/` — CLI command implementations
- `scratch-engine/crates/scratch-validate/src/impls/` — Validator implementations
- `scratch-engine/crates/scratch-transform/src/impls/` — Transformer implementations
- `scratch-ui/app/services.py` — Service layer (business logic)
- `scratch-ui/app/routes/api.py` — JSON API endpoints
- `scratch-ui/app/engine.py` — Pull/push engine
- `scratch-ui/app/publish_engine.py` — Publish pipeline
- `scratch-scenarios/setup.py` — Workspace setup via CLI
- `scratch-scenarios/run.sh` — Test runner
