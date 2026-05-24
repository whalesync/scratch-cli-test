# scratch-git-2

A single Rust crate that ships two binaries:

1. **`service`** — a Git microservice (port 3100 REST API + port 3101 Git HTTP backend) used by the Scratch server to store workbook data in bare git repositories. The NestJS server calls it for all file operations; it is stateless from the app's perspective.

2. **`scratchmd`** — the end-user CLI. It runs business logic locally against JSON record files that are fetched from remote services (Airtable, Webflow, Notion, …). Key capabilities: three-way file upload/download, local sync execution with transformers (string_to_number, auto_convert, Rhai scripts), publish plan building (diff dirty vs master → phase files), and triggering server-side publish jobs.

# Code style

- Follow standard rust code conventions
- After generating code run `cargo fmt` to ensure code changes match standard formatting

## Workflow

```bash
# Build and install the CLI locally
cargo build --bin scratchmd
cp target/debug/scratchmd /usr/local/bin/scratchmd

# Run the service in dev
cargo run

# Run all tests
cargo test


# format code
cargo fmt
```

Always run commands from inside `scratch-git-2/` (or the repo root using Turborepo).

## Docs

- [README.md](docs/README.md) — service architecture, environment variables, Docker, deployment, DevOps playbook
- [PARITY.md](docs/PARITY.md) — Rust vs Go CLI feature gap tracking
- [MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) — plan to migrate business logic from NestJS/Postgres into Rust/git
- [TEST_LOOP.md](docs/TEST_LOOP.md) — end-to-end test guide ⚠️ partially outdated (uses old binary name `scratchmd2` and old workspace paths — treat as conceptual reference)
- [REPO_STRUCTURES.md](docs/REPO_STRUCTURES.md) — CLI and service directory layouts, repo identity, branch conventions, materialize-perform-commit-cleanup pattern
- [REVIEW_MODEL.md](docs/REVIEW_MODEL.md) — accept / reject / discard semantics, the published/approved/local state model, and the `accepted-patches.json` shape
- [PULL_AFTER_PUBLISH.md](docs/PULL_AFTER_PUBLISH.md) — how the local workspace re-syncs after a publish lands, including the post-publish `git fetch` retry policy
- [GIX_PATTERNS.md](docs/GIX_PATTERNS.md) — gix-vs-shell-out conventions, where the git helpers live, common pitfalls
- [GIX_UPGRADE.md](docs/GIX_UPGRADE.md) — version pinning rationale and push migration options
