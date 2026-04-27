# Desktop IPC API

The desktop app treats the CLI (`scratchmd`) as a backend API, invoked via Electron IPC. This document lists all endpoints and notes efficiency concerns.

## CLI-backed endpoints

Each call spawns a new `scratchmd` subprocess.

| IPC                                | CLI command                                                     | Notes                                                               |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `scratch:create-workspace`         | `workspaces create <name>`                                      | One-shot                                                            |
| `scratch:init-workspace`           | `workspaces init <id>` (`opts.force` → `--force`)               | One-shot; `--force` deletes and reclones the local workspace dir    |
| `scratch:remove-workspace`         | `workspaces unsync <id> --yes`                                  | One-shot                                                            |
| `scratch:accept-all-changes`       | `files accept-all`                                              | One-shot                                                            |
| `files:restore-deleted-record`     | `files restore-deleted-record <path>`                           | Legacy `files:*` IPC name, but now CLI-backed                       |
| `files:discard-created-record`     | `files discard-created-record <path>`                           | Legacy `files:*` IPC name, CLI-backed; also discards remote dirty   |
| `scratch:list-unreviewed-changes`  | `files unreviewed --json`                                       | Called per-render of status filter                                  |
| `scratch:list-unpushed-changes`    | `files unpushed --json`                                         | Same                                                                |
| `scratch:push-workspace-changes`   | `files upload`                                                  | One-shot                                                            |
| `scratch:pull-workspace-changes`   | `files download`                                                | Syncs local connection layout with the server, then pulls each repo |
| `scratch:validate-local-sync`      | `syncs validate-local`                                          | One-shot                                                            |
| `scratch:start-run-local-sync`     | `syncs run-local` (streaming)                                   | Long-running stream                                                 |
| `scratch:start-plan-publish`       | `plan-publish` (streaming)                                      | Long-running stream                                                 |
| `scratch:start-publish-from-git`   | `publish-from-git` (streaming)                                  | Long-running stream                                                 |
| `scratch:trigger-publish-from-git` | `publish-from-git`                                              | Fire-and-get-job-IDs                                                |
| `scratch:start-publish-all`        | `plan-publish` → `files upload` → `publish-from-git` (sequence) | 3-step stream                                                       |
| `scratch:pull-all-linked-tables`   | `linked pull-all --json`                                        | Returns job IDs                                                     |

## Local filesystem endpoints

No subprocess — reads directly from disk in the Electron main process.

| IPC                                | What it does                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `files:workspace-config`           | Reads `.scratch/.scratchmd`                                                   |
| `files:list-folders`               | Walks tree, finds leaf dirs, counts files                                     |
| `files:folder-metadata`            | Stats one folder + reads schema                                               |
| `files:list-files`                 | readdir → filter/sort/paginate, stat only the page                            |
| `files:read-file`                  | Read + parse single file                                                      |
| `files:read-batch`                 | Read up to 10 files in parallel                                               |
| `files:read-schema`                | Reads `.scratch/schemas/<name>.json`                                          |
| `files:read-grid-data`             | Reads **all** files in a folder, flattens JSON, filters/sorts/paginates in JS |
| `files:read-folder-statuses`       | Spawns `files unreviewed` + `files unpublished` CLI for filenames             |
| `files:read-diff-grid-data`        | Reads both working tree and dirty branch into memory, diffs in JS             |
| `scratch:list-local-publish-plans` | Walks `.scratch/connections/scratch/*/publish-plans/`                         |
| `scratch:get-workspaces-registry`  | Reads `~/.scratchmd/workspaces.yaml`                                          |
| `scratch:list-local-syncs`         | Reads `.scratch/workspace/syncs/`                                             |

## Efficiency problems

### `files:read-grid-data` — full table scan on every render

Reads and parses all JSON files in a folder per request, then filters/sorts/paginates in JS. With 2000 records this means 2000 file reads and JSON parses on every grid render, sort change, and filter change. The 1000-row pagination cap doesn't reduce the read cost — it only limits what's returned.

### `files:read-diff-grid-data` — two full directory reads

Loads the entire working tree folder and the entire dirty branch folder into memory on every diff view open or refresh.

### `files:read-folder-statuses` — two CLI subprocesses per folder

`files unreviewed` and `files unpublished` each fork a new `scratchmd` process, which has startup cost plus git object traversal. This runs for every folder shown in the sidebar.

### No persistent index

Every query re-reads from disk. The `dirCache` caches only filenames (not contents). Parsed JSON is discarded after each grid render.

### `files:list-folders` stats every file on open

`computeFolderStats` stats every file in every folder just to get counts and sizes. Called on workspace open and on every sidebar refresh.

### CLI subprocess cold-start cost

Rust binary startup is fast but not free. Spawning one subprocess per filter-status lookup (which happens on every grid view) accumulates latency at scale.

### Root cause

The CLI was designed as a terminal tool, not a query engine. Everything that should be an indexed read is currently a filesystem walk with in-process computation.
