# Simplify Local Workspace Architecture

**Date**: 2026-05-17
**Status**: Draft — planning
**Linear**: [DEV-10144](https://linear.app/whalesync/issue/DEV-10144/scratchmd-simplify-workspaces-init-drop-worktrees-move-publish-to)
**Author**: Curtis Fonger
**Scope**: Replace the three-worktree + eager SQLite + local-publish architecture of `scratchmd workspaces init` with a one-bare-repo + one-non-sparse-worktree-per-connection model. Publishing moves to the server; the working tree IS the diff source against `main`, with `gix` doing index-backed diff detection.

## Problem

`scratchmd workspaces init wkb_3qH9SlxsNq` takes **~110s** for the Monorepo workspace (135k files, 5 connections), of which only **~6.7s is network**. The remaining **~94%** is local post-clone work that exists to support publish-time three-way reasoning. Profile breakdown (gated on `SCRATCHMD_PROFILE=1`, from `scratch-git-2/src/cli/commands/workspaces.rs`):

| Phase                                        | Stripe    | HubSpot   | Notes                                |
| -------------------------------------------- | --------- | --------- | ------------------------------------ |
| `git_clone_bare`                             | 5.6s      | 0.7s      | The only network step                |
| `materialize_dirty_checkout` (sparse: dirty) | 15.7s     | 3.9s      | Worktree #1                          |
| `setup_sparse_worktree` (reviewed-dirty)     | 11.8s     | 4.3s      | Worktree #2 — same ref as #1         |
| `git_checkout_branch_from_bare` (main)       | 12.8s     | 4.1s      | Worktree #3                          |
| `index::build` (SQLite)                      | **35.0s** | 13.8s     | Eagerly built for publish-plan diffs |
| **Total per connection**                     | **81.5s** | **26.9s** | Connections run **sequentially**     |

Three structural problems:

1. **Three git worktrees per connection.** `dirty`, `reviewed-dirty`, and `main` exist to support local publish-plan generation. `dirty` is materialized twice (the second copy is `reviewed-dirty`, an identical sparse checkout of the same ref).
2. **Eager SQLite indexing.** Built up-front so `shared/plan_publish.rs` can diff `reviewed-dirty` against `master` at publish time. Not needed for "init then start editing."
3. **Sequential connection setup.** `init_v2` loops over `connector_accounts` one at a time, so Stripe's 81s blocks all other connections.

## Current architecture (recap)

The three checkouts are three **states** of the user's data, not a three-way diff:

| Checkout         | Branch  | Meaning                                                       |
| ---------------- | ------- | ------------------------------------------------------------- |
| `master`         | `main`  | The last known server state                                   |
| `reviewed-dirty` | `dirty` | The snapshot of changes the user has **approved** for publish |
| `dirty`          | `dirty` | The user's live editing area (may contain unreviewed edits)   |

- **Publish** = two-way diff of `reviewed-dirty` vs `master` (`shared/plan_publish.rs:96`).
- **Download** = three-way merge of `master` (base), new `master` (theirs), `dirty` (ours).
- The SQLite index speeds up the publish-plan diff by avoiding a full filesystem scan.

## End-state design

> Per connection: **one bare repo + one non-sparse git worktree of `main`**. The user's editable files live in that worktree. Snapshot reads, diff detection, and incremental pulls all go through `gix` against the bare repo. Publishing is server-side, with JSON Merge Patches sent over REST.

The user's working files at the top of the worktree are plain JSON record files, just as today. The only git artifact in user-facing space is the `.git` link file (a single file, not a directory) — identical to what today's `dirty` checkout already has.

### Local layout (target)

```
<workspace>/
  HubSpot/                           ← non-sparse git worktree of `main`
    .git                             ← gitlink → ../.repos/<id>.git
    Companies/<record-id>.json       ← user-editable files
    ...
  Stripe/                            ← non-sparse git worktree of `main` (separate repo)
    .git
    ...
  .repos/
    <stripe-repo-id>.git/            ← bare repo: transport + snapshot blobs
    <hubspot-repo-id>.git/
    ...
  .scratch/
    workspace.yaml                   ← workspace marker (unchanged shape)
    conflicts.log                    ← same-field collisions from pull (audit-only)
```

What disappears vs. today: `.scratch/connections/dirty/`, `.scratch/connections/master/`, `.scratch/connections/reviewed-dirty/`, every `index.db`, and the sparse-checkout configuration in each worktree.

What stays: one bare repo per connection (already used as transport), one worktree per connection (the user's editable directory).

### Why keep git locally

Git earns its keep on three fronts that would otherwise need bespoke replacements:

1. **Incremental fetch.** `git fetch origin main` only ships changed objects; the scratch-git-2 service already speaks it.
2. **Snapshot storage.** The bare repo's packed objects ARE the snapshot for "what was main when we pulled" — no separate snapshot directory needed. Snapshot reads go through `gix::Repository::rev_parse("HEAD:<path>")` → blob bytes.
3. **Fast diff detection via index.** `gix::Repository::status(...)` uses git's index to skip unchanged files via `stat`, hashing only files whose mtime/size changed. Measured ~210ms warm on the Stripe worktree (~110k files); see [Measured performance](#measured-performance) below.

What we stop using git for: branches (no `dirty`, no `reviewed-dirty`), local commits (publishing is now an HTTP call), local merge logic (`shared/plan_publish.rs` machinery), and the SQLite index built on top of it.

### Diff format on the wire: JSON Merge Patch (RFC 7396)

Per-file, computed on demand:

- `diff(snapshot_file, current_file) → patch` — produces a merge patch describing what the user changed.
- `apply(target, patch) → new` — replays the patch on top of a new base.

Spec is ~30 lines:

```
apply(target, patch):
    for each key k in patch:
        if patch[k] is null:        delete target[k]
        elif both are objects:      recurse
        else:                       target[k] = patch[k]
```

A whole-file delete is represented by `patch = null` (the snapshot has content, the current file is missing). A whole-file create is `patch = full_content` (the snapshot is missing, the current file has content).

This is the format used for publish-upload and for the pull stash/replay. It is independent of git's own diff format — we use gix to _find_ changed files and to _read_ snapshot content, but the patch itself is computed in JSON space because that's the shape the server speaks.

### Operations

**Publish** (desktop app initiates):

1. `gix::Repository::status(...)` enumerates files modified vs `HEAD`.
2. For each changed path: read the snapshot blob via gix (`HEAD:<path>`), read the working file from disk, compute the JSON merge patch.
3. POST `{ workbookId, patches: [{ path, patch }], baseHead }` to the server.
4. Server applies patches to its authoritative state and runs the existing publish pipeline.
5. On success, the desktop app calls `git fetch origin main` so the local `HEAD` advances and subsequent diff detection reports "no changes" again.

**Pull** (download latest from server):

1. Save the current commit ID as `old_head` (e.g., `.scratch/last-pulled-head`, or just read `refs/heads/main` before fetching).
2. Compute the user's local patches: `gix status` for changed files; for each, `diff(snapshot_at_old_head[path], current[path])`.
3. `git fetch origin main` (incremental, packed).
4. Determine what the server changed: `gix` tree-vs-tree diff between `old_head` and the new `HEAD`, gives a path list.
5. For each path in (server-changed ∪ user-changed):
   - Write the new-HEAD blob to the working file.
   - If the user had a patch for this path, re-apply it.
   - For each key the user's patch touches: if `snapshot_at_old_head[key] != snapshot_at_new_head[key]`, append to `.scratch/conflicts.log` (user-wins, but logged).

**Init**:

1. Resolve the workbook's connector accounts.
2. For each connection (in parallel):
   - `git clone --bare` (or gix equivalent) into `.repos/<repo-id>.git/`.
   - `git worktree add --no-detach <workspace>/<Connection> main` (shell out — gix worktree-add support is limited at 0.70).
3. Write `.scratch/workspace.yaml`.
4. Done. One bare repo + one worktree per connection. No `reviewed-dirty`, no `master` worktree, no SQLite index.

### Decisions / open questions

| Decision                      | Recommendation                                                                         | Why                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch granularity             | RFC 7396 (Merge Patch) — field-level, arrays atomic                                    | ~60 lines total. Upgrade to RFC 6902 only if same-array conflicts become a real problem.                                                                        |
| Conflict policy               | User wins; log same-field collisions to `.scratch/conflicts.log`                       | Zero blocking UX, no silent data loss without an audit trail.                                                                                                   |
| Snapshot storage              | Bare repo objects (read via `gix::rev_parse("HEAD:<path>")`)                           | No duplicate on-disk snapshot directory. Packed objects are already efficient storage.                                                                          |
| Diff detection mechanism      | `gix::Repository::status(Discard).into_iter([])` against the worktree                  | Index-backed; measured ~235ms cold / ~210ms warm on the Stripe worktree (~110k files). Already a dependency. See [Measured performance](#measured-performance). |
| Working tree shape            | One **non-sparse** git worktree of `main` per connection                               | The `.git` link file is the only artifact; identical to today's dirty checkout. Non-sparse so we don't pay sparse-checkout config overhead.                     |
| Transport                     | `git clone --bare` + `git fetch origin main` (incremental)                             | Free incremental fetch from existing scratch-git-2 backend; no tarball or manifest-API to build.                                                                |
| Worktree creation             | Shell out to `git worktree add` at init                                                | gix 0.70's worktree-add support is limited; we already shell out for this today in `setup_sparse_worktree`. Hot path is one call per connection.                |
| Publish wire format           | `POST /cli/v1/workbooks/:id/publish` taking `{ patches: [{ path, patch }], baseHead }` | Single source of truth; CLI and desktop both call it.                                                                                                           |
| Concurrent pulls / publishes  | Optimistic concurrency: client sends `baseHead` commit id with publish                 | If `baseHead` is stale, server rejects → desktop runs pull first.                                                                                               |
| Arrays in RFC 7396 are atomic | Accept the limitation; log it in the conflicts file if both sides touched              | Rare in record-per-file data; upgrade to RFC 6902 only if user pain materializes.                                                                               |

### Measured performance

Spike: `scratch-git-2/examples/gix_status_spike.rs` against the existing Stripe worktree at `/tmp/scratchmd-profile-37373/Monorepo/Stripe` (~110k files):

| Scenario                     | gix `Repository::status(...)` | `git status --porcelain` |
| ---------------------------- | ----------------------------- | ------------------------ |
| `gix::open()`                | ~0.5–2.5ms                    | n/a                      |
| Cold scan, 0 modified        | **235ms**                     | 1,612ms                  |
| Warm scan, 0 modified        | **210ms**                     | 210ms                    |
| Cold scan, 50 files modified | **226ms**                     | (similar)                |
| Warm scan, 50 files modified | **207–218ms** (50 detected)   | 203–213ms (50 detected)  |

gix is at parity with `git status` on warm scans and ~7× faster cold (parallel scan by default). 50 modifications correctly detected by both. The desktop app's "what's changed" view can comfortably refresh on demand or poll every second on the worst-case connector; the small connectors (Affinity, Airtable, Shopify) will be in the tens of ms.

The spike file is preserved in `examples/` for future perf checks; `cargo` does not link it into the `scratchmd` or `scratch-git-2` binaries.

## Migration path

The architecture changes touch many files; the migration is **publish first, then pull, then strip the rest**. Each phase is independently shippable and leaves the system working.

### Phase 1 — Move publish to the server

- Add `POST /cli/v1/workbooks/:id/publish` accepting `{ patches: [{ path, patch }], baseHead }`.
- Server-side: load current authoritative state per path, apply patch, run existing publish pipeline against the resulting file set. Reject with 409 if `baseHead` is stale.
- Add `scratchmd publish-v2` (or a flag on existing `publish`) that computes per-file merge patches from `current` vs `master_dir` (using gix to read snapshot blobs) and uploads them.
- Desktop app: switch its publish action to the new endpoint.
- **Leaves alone**: `reviewed-dirty`, the SQLite index, the local `plan_publish.rs` machinery. The new path is additive.

Done when: desktop app's publish button uses the new endpoint and end-to-end publishes succeed against test-api.

### Phase 2 — Replace download with stash/replay

- Add a `download-v2` path: save current `HEAD`, compute user patches via gix, `git fetch origin main`, walk the tree-vs-tree diff, overwrite working files with new blobs, replay user patches, log same-field collisions to `.scratch/conflicts.log`.
- Switch desktop app's refresh action to the new path.
- **Leaves alone**: init still creates three worktrees. We just stop using the three-way merge.

Done when: desktop app's refresh uses the new path and round-trips correctly with conflicts logged.

### Phase 3 — Stop creating `reviewed-dirty` on init

- Once Phase 1 lands, `reviewed-dirty` is unused. Delete `layout.reviewed_dirty_checkout_path` references and the worktree setup at `workspaces.rs:702`.
- Also delete the `update_reviewed_dirty` calls in `cli/commands/files.rs`.
- Saves ~10–15s of `init` per large connection.

Done when: `init` no longer creates the worktree and no code path references it.

### Phase 4 — Lazy / drop the SQLite index

- Once Phase 1 lands, `plan_publish` no longer runs locally → the eager `index::build` at `workspaces.rs:736` is dead weight for init.
- Decide: drop it entirely (if no remaining caller needs it), or build it lazily on first query.
- Saves ~35s of `init` for Stripe.

Done when: `init` doesn't build the index, and any code that still needs it either rebuilds on demand or has been removed.

### Phase 5 — Collapse to one worktree per connection

- Today's "dirty checkout" (sparse worktree of the dirty branch) becomes the single non-sparse worktree of `main`. The separate `master` worktree goes away — its only role (snapshot reads) is now served by `gix::rev_parse("HEAD:<path>")` against the bare repo.
- Drop `materialize_dirty_checkout`'s sparse-checkout config; replace with a plain `git worktree add` of `main`.
- Remove all references to the dirty branch from the CLI (the branch may continue to exist server-side for now; that's a server cleanup item).

Done when: a fresh `init` against `wkb_3qH9SlxsNq` produces one bare repo + one non-sparse `main` worktree per connection, with no `.scratch/connections/*/` directories.

### Phase 6 — Parallelize connections

- Replace the `for (ca, entry) in ...` loop at `workspaces.rs:411` with `rayon::par_iter` or `tokio::task::spawn_blocking` fan-out.
- Independent of the other phases; ship as soon as it's safe (probably after Phase 5, when each connection is "clone + worktree add" with no shared mutable state).

Done when: total wall time is dominated by the single slowest connection, not the sum.

### Phase 7 — Delete `publish-v2/run-from-git`

Once Phases 1–6 are live and the desktop app has shipped using `/upload-patch`, monitor server metrics for callers of `POST :id/publish-v2/run-from-git`. When zero callers are observed for a sustained window (≥7 consecutive days), delete:

- The `run-from-git` endpoint in both `cli-workbook.controller.ts` and `publish-plan.controller.ts`.
- `enqueuePublishFromGitJob` and `publish-from-git.service.ts`.
- The CLI's local plan-build command (the `scratchmd files upload` flow that produces phase files).
- `scratch-git-2/src/shared/plan_publish.rs` (~600 LOC) and any remaining callers.
- The parity test introduced in Phase 1 (see Captured decisions §6).

Net debt reduction: ~600 LOC + sparse-checkout config + SQLite index code removed. After Phase 7, the only publish path on the server is `/upload-patch` → `publish-v2/plan-job` → `publish-v2/run-job`.

Done when: `run-from-git` has been removed from the server, CLI, and desktop, and the parity test is gone.

## Out of scope

- Multi-user collaborative editing of the same workspace (still single-user assumed).
- Binary-file diffing (records are JSON; assets stay handled by the existing asset pipeline).
- Rewriting the server's publish pipeline itself — Phase 1 reuses it.
- Migrating existing workspaces on disk. New init produces the new layout; old workspaces continue working until re-init.
- Server-side dirty-branch cleanup. The branch may continue to exist server-side after Phase 5; removing it is a separate server-side task.

## Risks

- **Same-field collision = silent user-wins.** Mitigated by `.scratch/conflicts.log`, but the desktop app should eventually surface this. Out of scope for v1.
- **Server-side publish performance.** The local publish-plan diff was fast because the index was prebuilt. The server will compute the equivalent on demand; needs to scale to large workspaces. Worth benchmarking in Phase 1.
- **gix `worktree add` gaps.** gix 0.70's worktree-add support is limited, so we shell out — same as today. If gix improves, we can swap, but the shell-out is acceptable on a one-call-per-connection path.
- **Loss of git-as-undo.** Users currently have a local git history they could in principle inspect. Almost certainly unused, but worth confirming nobody depends on it.
- **Migration of in-flight workspaces.** Anyone with a workspace already initialized on the old layout keeps using the old code paths until they re-init. We should add a one-liner to the desktop app prompting re-init when the new path lands.

## Captured decisions from CEO review (2026-05-18)

Reviewed by Curtis Fonger via `/plan-ceo-review` (HOLD SCOPE mode). The decisions below were locked during the review and should be reflected in the migration phases above when each phase is implemented.

### 1. Phase 1 endpoint shape: upload then publish (split)

The single `POST /publish { patches, baseHead }` originally proposed conflates two operations. Replace with:

- `POST /workbook/:workbookId/upload-patch/init` → returns a presigned GCS URL + `uploadId`.
- CLI `PUT`s the patch payload directly to GCS (NDJSON or single JSON).
- `POST /workbook/:workbookId/upload-patch/commit { uploadId, baseHead? }` → enqueues a BullMQ job that streams the patch from GCS, applies it to the **server-side dirty branch** as a single commit, then triggers the existing `publish-v2/plan-job` + `run-job`.

The upload is one atomic action; publishing is independent and can be re-triggered without re-uploading.

### 2. Reuse the existing server publish pipeline

The server already has `POST /workbook/:workbookId/publish-v2/plan-job` + `run-job` used by the web client. Phase 1 is **not** a new publish pipeline — it is a thin upload shim that puts patches onto the dirty branch in the shape the existing pipeline expects. Plan documentation and code comments should make this explicit so future readers don't think two parallel publish systems exist.

### 3. `baseHead` semantics: optional, soft warning, never blocks

`baseHead` on `/upload-patch/commit` is optional:

- Omitted → server applies patches with no concurrency check.
- Provided and matches server's `origin/main` → no warning, no extra response.
- Provided and mismatches → server applies patches **anyway**, response includes `{ stalenessWarning: { newHead } }`. Desktop shows a non-blocking banner: "The server has more recent changes than what's on your computer. Refresh first?"

Rationale: incremental polling (recently shipped on the server) regularly advances `main` server-side. Hard 409 rejection would fail too often in normal operation. Single-user assumption makes silent overwrites acceptably rare; the audit log (follow-up F3) and PostHog conflict event (§8) cover the rest.

### 4. Server-side path validation

`/upload-patch/commit` MUST validate every `patch.path` server-side and reject the entire request with 400 if any path:

- Contains `..` segments
- Has a leading `/`
- Begins with `.git/` or `.scratch/`
- Is not within a known DataFolder of the connector account

CLI-side validation may also be added for better UX, but server-side is the gate.

### 5. Worktree concurrency: file lock at `.scratch/lock`

The new single-worktree design loses the implicit serialization the three-worktree model had. All mutating CLI operations (publish, pull, init, files commands) must acquire a file lock at `.scratch/lock` before proceeding. Second concurrent process exits with "workspace busy."

Use the same locking primitive git itself uses (`gix::lock` or equivalent). Stale-lock detection: if the lock's PID is no longer alive, reclaim it.

### 6. Test strategy: phase-aligned + cutover parity test

Each phase ships with its own unit + integration tests. Phase 1 additionally ships a **parity test** that:

- Takes a representative set of edits
- Runs them through the new `/upload-patch` → `plan-job` → `run-job` path
- Runs them through the legacy `run-from-git` path
- Asserts identical publish results (same operations, same final state in `main`)

The parity test is deleted in Phase 7 alongside `run-from-git`.

### 7. Large publishes via presigned GCS upload

Patches are uploaded to GCS, not POSTed inline. This avoids NestJS body-parser limits, keeps server memory bounded, and supports resumable uploads. A BullMQ job streams from GCS and applies the patch — fits the existing publish-v2 async-job UX. GCS bucket gets a ≤24h lifecycle rule on uploaded patches.

### 8. Conflict telemetry: PostHog event from desktop

On every same-field conflict during pull, the desktop fires a PostHog event with:

- Connector account ID
- Conflict count
- Path pattern (folder, not file content)
- (No record content — privacy)

This gives visibility into whether user-wins is acceptable in practice, or whether real conflict-resolution UX is needed later.

### 9. Rollout: server first, no feature flag

- Server ships `/upload-patch` endpoints first; legacy `run-from-git` remains alive.
- CLI/desktop ship a follow-up release that adopts `/upload-patch`.
- Server identifies clients by which endpoint they call — no version sniffing needed. If a request hits `/upload-patch`, it's a newer client; if it hits `run-from-git`, it's older.
- Phase 7 (delete `run-from-git`) gates on server metric: zero `run-from-git` callers for ≥7 consecutive days.

## Follow-ups (from CEO review)

Smaller items to track as separate tickets. None block shipping the phases above.

| #   | Item                                                                      | Why                                                                            | Effort (CC) |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- |
| F1  | Parallelize per-file patch loop in CLI publish (rayon)                    | 1000+ files sequential is slow on Monorepo                                     | 15min       |
| F2  | gix-patterns docs page in `scratch-git-2/docs/`                           | Bus factor — only the spike file uses gix today                                | 30min       |
| F3  | AuditLogService entries for `/upload-patch` + publish trigger             | `server/CLAUDE.md` requires audit logging on CLI interactions                  | 30min       |
| F4  | Body size + nesting depth caps on `/upload-patch/commit`                  | DoS guard on the trigger endpoint (presigned upload itself is GCS)             | 15min       |
| F5  | Init: 1/N connector failure policy (continue vs rollback)                 | Plan doesn't specify; needs choice + UX                                        | 30min       |
| F6  | Init: re-run on partial state — resume or fail-clean                      | Detect partial prior init and decide                                           | 1h          |
| F7  | iCloud/Dropbox workspace detection + warning                              | Git on cloud-synced FS corrupts state                                          | 1h          |
| F8  | Multi-connection publish atomicity model                                  | Partial-success UX when 3/5 connectors succeed                                 | 1h          |
| F9  | Publish-then-fetch failure → server-driven HEAD-advance signal            | Avoid silent local divergence when `git fetch` fails post-publish              | 1h          |
| F10 | conflicts.log rotation                                                    | Prevent unbounded growth                                                       | 15min       |
| F11 | Worktree lock metrics (acquire timeout, stale recovery)                   | Observability gap                                                              | 30min       |
| F12 | Promote init-phase timings (`SCRATCHMD_PROFILE`) to PostHog event         | See init perf in production                                                    | 15min       |
| F13 | End-to-end publish smoke test per deploy                                  | Catch regressions immediately post-deploy                                      | 1h          |
