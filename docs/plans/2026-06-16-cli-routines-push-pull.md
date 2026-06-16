# CLI push/pull for routine files

**Date**: 2026-06-16
**Status**: Planned
**Author**: Chris Hoefgen
**Linear**: [DEV-10445](https://linear.app/whalesync/issue/DEV-10445/cli-pushpull-for-routine-files)

## Problem

The `scratchmd` CLI materializes the **workbook config repo** (the `{workbookId}.git`
repo that, per the [routines design](../routines-design.md), holds `routines/*.yaml`)
into `<workspace>/.scratch/workspace/` **once, at `workspaces init`**. After that there
is no way to:

- **Pull** routine files that another user (or the server) committed to the config
  repo into an already-initialized workspace, or
- **Push** a routine file the user created, edited, or deleted locally back to the
  server so it persists, takes effect, and is shared with other users of the workspace.

We want the CLI to support both directions **for routine files**, with these concrete
scenarios working end-to-end:

1. A user **creates a new routine file locally** and pushes it to the server.
2. A user **deletes a routine file locally** and the deletion propagates.
3. A user **loads the latest routine files** from the server into a workspace that is
   **already materialized** locally (incremental pull).

This plan implements the incremental config-repo pull that the routines design's
[CLI Support](../routines-design.md#cli-support) section flagged as missing, and adds a
push path — both scoped to routine files.

## Scope

**In scope: routine files only** (`routines/*.yaml`). Routines are **git-authoritative**
(the file is the definition; the server reads it and derives schedule rows — see
grounding #2), so file push/pull maps cleanly onto the product model.

**Out of scope: syncs and transformers.** They share the config repo but do not share
the routines model: a `Sync` is a Postgres row that the server exports **one-way to
git** (nothing reads `syncs/*.json` back), so pushing a sync file would require new
git→DB ingestion; transformers are deferred. Pulling re-materializes the whole config
worktree, so `syncs/`/`transformers/` files already on disk refresh as a harmless side
effect, but the CLI will **not** push edits to them and the push endpoint will reject
non-`routines/` paths.

## Key grounding (verified against source)

1. **The config repo is materialized only at init, and only one-way.**
   `init_workbook_repo` clones the config repo bare and materializes `main` into
   `.scratch/workspace/` via a **sparse** worktree
   ([workspaces.rs:525](../../scratch-git-2/src/cli/commands/workspaces.rs#L525),
   [local.rs:280](../../scratch-git-2/src/cli/git_ops/local.rs#L280) — pattern
   `/* !.scratch`; routines live at the repo root so they are included). There is **no
   incremental fetch and no push** for the config repo. (`.scratch/workspace/` resolves
   via [layout.rs:87](../../scratch-git-2/src/shared/layout.rs#L87).)

2. **Routines are git-authoritative.** The routines design makes the YAML file the
   definition and has the server **read `routines/*.yaml` from git** and upsert/delete
   `Schedule` rows in a **"Reload Routines"** action (git → DB). So a routine only takes
   effect once its file is committed to the config repo's `main` **and** the server
   reloads.

3. **The CLI cannot reach the scratch-git service directly.** The scratch-git write API
   (`POST /api/repo/write/{id}/files` →
   [write.rs:33](../../scratch-git-2/src/service/routes/write.rs#L33);
   `DELETE …/files` → [:97](../../scratch-git-2/src/service/routes/write.rs#L97)) is
   server-internal. The CLI talks only to the NestJS `/cli/v1` API, plus a git
   smart-HTTP **proxy** the server already exposes for the config repo:
   `@All('/cli/v1/workbooks/:id/config/git/*path')`
   ([cli-workbook.controller.ts:675](../../server/src/cli/cli-workbook.controller.ts#L675)).
   The bare repo's `origin` is set to this proxy URL at clone time, so `git fetch origin`
   against the config repo already works through it.

4. **Reusable CLI building blocks exist.** Pull pattern:
   `download_single_repo` ([files.rs:4457](../../scratch-git-2/src/cli/commands/files.rs#L4457))
   — `fetch_origin` → detect head change → materialize → advance ref. Git helpers:
   `fetch_origin` ([remote.rs:30](../../scratch-git-2/src/cli/git_ops/remote.rs#L30)),
   `update_ref`, `worktree_reset_mixed`, `diff_name_status`, `setup_sparse_worktree`
   (all in `git_ops/`). **There is no `git push` helper** (gix has no high-level push).
   API client: `ApiClient` in [api/mod.rs](../../scratch-git-2/src/cli/api/mod.rs)
   (`Authorization: API-Token`, base `/cli/v1`). Commands register in the `Commands` enum
   ([main.rs:41](../../scratch-git-2/src/cli/main.rs#L41)).

5. **The server already commits to the config repo `main`.** `WorkbookRepoService` writes
   to the config repo through `scratchGitClient.commitFiles(repoId, 'main', …)`
   ([workbook-repo.service.ts:133](../../server/src/workbook/workbook-repo.service.ts#L133)),
   and `getBranchHead(repoId, 'main')`
   ([scratch-git.client.ts:194](../../server/src/scratch-git/scratch-git.client.ts#L194))
   reads the current head — both reusable for a routine push endpoint.

## Approach

**Push is server-mediated; pull is CLI-side git fetch.** Because the CLI cannot call
scratch-git directly (grounding #3), push goes through a **new `/cli/v1` endpoint** that
commits routine files and reloads routines atomically — mirroring the upload-patch model
(CLI computes a change payload; the server applies + commits + reacts). Pull reuses the
**existing config-git proxy** via `git fetch`, so it needs **no new server endpoint**.

### Pull (`scratchmd routines pull`) — pure CLI, reuses the proxy

1. `fetch_origin` on the config bare repo (origin already points at the `…/config/git`
   proxy).
2. Compare `refs/remotes/origin/main` to local `refs/heads/main`; if equal, report
   up-to-date.
3. **Dirty-check** the `.scratch/workspace/` worktree. If the user has uncommitted local
   routine edits that a fast-forward would clobber, **warn and refuse** (non-destructive
   default) unless `--discard-local` is passed.
4. Advance `refs/heads/main` (`update_ref`) and refresh the materialized worktree
   (`worktree_reset_mixed` / re-checkout). New/updated routine files appear; deleted ones
   are removed. (The whole config worktree refreshes; routines are the files of interest.)

No server call is needed — pull is read-only locally.

### Push (`scratchmd routines push`) — server-mediated

1. CLI computes the local change set by diffing the `.scratch/workspace/` worktree against
   local `main` (`diff_name_status`), **scoped to `routines/`**. Result: a list of
   `upserts: [{ path, content }]` and `deletes: [path]`.
2. CLI validates each routine YAML locally (the routines design's validation rules) and
   bails early on invalid files.
3. CLI `POST /cli/v1/workbooks/:id/routines/push` with `{ baseHead, upserts, deletes,
   message }`, where `baseHead` is the local `main` SHA (optimistic concurrency).
4. Server: if `baseHead` ≠ current config `main` head (`getBranchHead`), reject `409`
   ("pull first"). Otherwise `commitFiles` + `deleteFiles` to `main`, then run **Reload
   Routines** so schedule rows converge. Return the new `main` head.
5. CLI `fetch_origin` + advance local `main` + reset worktree → clean state matching the
   server.

### CLI command surface

A new `routines` command group:

```
scratchmd routines pull   [--discard-local]
scratchmd routines push   [--message <msg>] [--dry-run]
scratchmd routines status            # show local vs server routine-file drift
```

(`pull`/`push`/`status` cover the file lifecycle. Run/trigger/list-runs remain deferred
to the server and web UI per the routines design.)

### The three required scenarios, end-to-end

**1. Create a new routine locally and push**

```
$ vi .scratch/workspace/routines/weekly-report.yaml      # new file
$ scratchmd routines push
# CLI: diff worktree vs main → upserts:[routines/weekly-report.yaml]; validate YAML
# CLI: POST …/routines/push { baseHead, upserts, deletes:[], message:"… (userId)" }
# Server: commitFiles → main; Reload Routines upserts a Schedule row if scheduled
# CLI: fetch + advance main + reset worktree → clean
```

**2. Delete a routine locally and push**

```
$ rm .scratch/workspace/routines/old.yaml
$ scratchmd routines push
# CLI: diff → deletes:[routines/old.yaml]
# Server: deleteFiles on main; Reload Routines deletes the matching Schedule row
#         (routines design, Reload step 4)
# CLI: fetch + advance + reset
```

**3. Pull latest routines into an already-materialized workspace**

```
$ scratchmd routines pull
# CLI: fetch origin (via config/git proxy); origin/main ahead of local main
# CLI: worktree clean → advance main + refresh .scratch/workspace/
# Result: new routine files appear, deleted ones removed; no server call needed
```

## Server changes

- **New endpoint** `POST /cli/v1/workbooks/:id/routines/push` in `server/src/cli/`.
  Request DTO: `{ baseHead: string; upserts: { path: string; content: string }[];
  deletes: string[]; message?: string }` (zod schema in `@spinner/shared-types`, bridged
  per the NestJS DTO pattern).
  - Validate every `path` is within `routines/` and is a `.yaml`/`.yml` file; reject any
    other prefix, `.scratch/`, or traversal paths (fail fast at the boundary).
  - Optimistic concurrency: compare `baseHead` against `getBranchHead(repoId, 'main')`;
    return `409` on mismatch.
  - Commit via `scratchGitClient.commitFiles` / `deleteFiles` with message
    `Routine push (${actor.userId})` for attribution.
  - **Reload step**: invoke `RoutineService.reloadRoutines(workbookId)` (from the routines
    design) so pushed/deleted routines converge schedule rows in the same request. Return
    `{ head: string }` (new `main` SHA).
- **No change needed for pull** — the existing `…/config/git` proxy
  ([cli-workbook.controller.ts:675](../../server/src/cli/cli-workbook.controller.ts#L675))
  already serves `git fetch`.

> **Dependency:** the reload step requires `RoutineService.reloadRoutines`, which lands
> with the routines feature itself. This plan composes with that work; if the endpoint is
> built first, the reload is an additive call site (the commit still succeeds without it,
> but routines won't take effect until reload exists).

## CLI changes

- **New module** `src/cli/commands/routines.rs` with a `RoutinesCommands` enum (`Pull`,
  `Push`, `Status`); register in the `Commands` enum
  ([main.rs:41](../../scratch-git-2/src/cli/main.rs#L41)) and dispatch like the other groups.
- **Pull** (`pull_routines`): reuse `fetch_origin`, head comparison, `worktree_reset_mixed`
  / sparse re-checkout. Add a worktree dirty-check helper (`git status --porcelain` over
  `.scratch/workspace/`). Hold the workspace lock for the duration.
- **Push** (`push_routines`): diff the config worktree (`diff_name_status`) scoped to
  `routines/`, read changed file contents, validate YAML, build the payload, call the new
  API method, then fetch + advance + reset.
- **API client**: add `routines_push(workbook_id, baseHead, upserts, deletes, message)` to
  [api/mod.rs](../../scratch-git-2/src/cli/api/mod.rs). Pull needs no new API method (git fetch).
- **No new git push helper** required — push is server-mediated, so `remote.rs` only needs
  its existing `fetch_origin`.
- **Routine validation**: port the routines design's validation rules into a small Rust
  validator (or call a server `validate` path); `routines status` shows drift without
  mutating.

## Concurrency, safety, and fidelity

- **Optimistic concurrency** on push via `baseHead`/`getBranchHead`; refuse stale pushes
  with a clear "pull first" message (never blind-overwrite a newer `main`).
- **Non-destructive pull**: refuse to clobber a dirty config worktree unless
  `--discard-local`; warn and skip rather than destroy.
- **Atomic local state**: advance the local `main` ref only after the worktree refresh
  succeeds; reuse the crash-safe ordering from `download_single_repo`.
- **Validation at the boundary**: invalid routine YAML is rejected before commit (CLI-side
  and server-side) with a human-readable error — not a deep job failure.
- **Verbatim file fidelity**: push/pull moves files byte-for-byte; no reshaping.
- **Workspace lock** held across push/pull to serialize against other CLI ops.

## Phasing

- **Phase 1 — `routines pull` (incremental config fetch + materialize).** Pure CLI, reuses
  the existing proxy and git helpers. Delivers Scenario 3 and the read/share direction.
  Lowest risk; no server change.
- **Phase 2 — `routines push` + server endpoint.** Delivers Scenarios 1 and 2. The Reload
  Routines call composes with the routines feature.

## Out of scope

- **Syncs and transformers push/pull.** Syncs are DB-authoritative (a file push would need
  new git→DB ingestion, reconciled against the existing DB→git export); transformers are
  deferred. See [Scope](#scope).
- Advanced routine operations from the CLI (list/trigger/watch/cancel runs) — already
  deferred to the server/web UI in the routines design.
- Three-way merge / interactive conflict resolution for routine files (v1 is fast-forward
  + warn).
- Real-time propagation; other users get changes when they `routines pull`.
- Per-user git commit authorship (commits remain attributed to the Scratch system account;
  the userId is carried in the commit message only).

## Open questions / decisions to confirm

1. **Command surface**: a dedicated `routines` group (recommended) vs. extending
   `workspaces`/`files`.
2. **Reload timing**: should push block until Reload Routines finishes (synchronous,
   simpler mental model) or fire-and-forget?
3. **Pull conflict policy** when the worktree is dirty: warn-and-refuse (recommended) vs.
   auto-stash/backup.

## Risks

- **Coupling to the routines feature**: the push endpoint's value depends on
  `RoutineService.reloadRoutines`. Mitigation: the endpoint commits files regardless;
  reload is an additive call site.
- **Divergent config history**: the `…/config/git` proxy also permits raw `git push`. If a
  user bypasses the endpoint, heads can diverge and reload won't fire. Mitigation:
  `baseHead` checks + document the dedicated command as the supported path.
