# scratch-cli-2 (Rust CLI)

Rust rewrite of `scratch-cli` (Go). See [design doc](../../docs/plans/2026-03-05-rust-cli-design.md) and [implementation plan](../../implementation-plan.md).

## Building

```bash
cargo build
cargo run -- --help
```

## Structure

- `src/main.rs` — entry point
- `src/cli.rs` — clap `Cli` struct + `Command` enum + dispatch
- `src/commands/` — one file per command group, each with clap derive structs + `run()` method
- `src/api/` — `Client` struct + methods split by resource
- `src/config.rs` — project config (`scratchmd.config.yaml`)
- `src/credentials.rs` — user credentials (`~/.scratchmd/credentials.yaml`)
- `src/merge/` — three-way merge logic

## Key Dependencies

| Crate | Purpose |
|-------|---------|
| clap (derive) | CLI framework |
| reqwest (blocking) | HTTP client |
| system git | Git operations (via `std::process::Command`) |
| dialoguer | Interactive prompts |
| serde + serde_json + serde_yaml | Serialization |
| anyhow | Error handling |
| console | Terminal colors + isatty |

## Conventions

- No async — uses `reqwest::blocking`
- All commands take `&self` and `&Cli` (for global flags)
- API methods are `impl Client` blocks in separate files
- Error handling via `anyhow::Result`
