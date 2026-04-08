# CLI Parity: Rust vs Go

Status as of 2026-03-20. Lists every behavioural difference between the Rust CLI
(`scratchmd` in `scratch-git-2/`) and the Go CLI (`scratchmd` in `scratch-cli/`).

---

## Known gaps (Go feature not yet in Rust)

### `files download/upload` — optional workspace-id argument

**Go:** `scratchmd files download <workspace-id>` works from any directory.
**Rust:** command must be run from inside the workspace directory (or a connector
subdirectory). The positional argument is not supported.

**Workaround:** `cd` into the workspace before running.
**Impact:** Scripts that pass a workspace ID explicitly will break.

---

## Gaps that were fixed before the Rust CLI shipped as `scratchmd`

| Feature                                                 | Status                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `auth login/logout/status --server <url>`               | Fixed — `--server` alias added to `auth` subcommand                |
| `workspaces list --sort-by / --sort-order`              | Fixed — flags added, passed as query params                        |
| `linked available --refresh`                            | Fixed — flag accepted (no-op, same as Go CLI internals)            |
| `--config <path>` global flag + `scratchmd.config.yaml` | Fixed — config file loaded with same format and priority as Go CLI |
| `-v / --verbose` global flag                            | Fixed — flag accepted (Go CLI also declares it but never uses it)  |

---

## New capabilities in Rust that don't exist in Go

These are additions, not regressions.

| Command                | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `files force-upload`   | Force-push dirty branch without three-way merge     |
| `syncs run-local`      | Run a sync entirely against local files (no server) |
| `syncs validate-local` | Validate local sync config files                    |
| `plan-publish`         | Build a publish plan by diffing dirty vs master     |
| `publish-from-git`     | Trigger server-side publish from local plan         |
| `build-index`          | Rebuild SQLite file index for the workspace         |
| `dump-index`           | Print index contents (debugging)                    |
| `files download --on-delete` | Workspace sync on download: detects added/removed connections and reconciles local state |

V2 `workspaces init` is also richer in Rust — it auto-creates master worktrees
and rebuilds the file index after cloning, which the Go CLI does not do.

---

## JSON output compatibility

All commands that existed in the Go CLI produce **identical JSON field names** in
the Rust CLI, with one additive difference: Rust includes `elapsedMs` in the
output of `workspaces init`, `files download`, and `files upload`. This field is
safe to ignore.
