# Simplify Local Workspace Architecture

**Date**: 2026-05-17 (revised 2026-05-18 after `/plan-ceo-review` + `/plan-eng-review`)
**Status**: Draft — ready to implement
**Linear**: [DEV-10144](https://linear.app/whalesync/issue/DEV-10144/scratchmd-simplify-workspaces-init-drop-worktrees-move-publish-to)
**Author**: Curtis Fonger
**Scope**: Replace the three-worktree + eager SQLite + local-publish architecture of `scratchmd workspaces init` with a one-bare-repo + one-non-sparse-worktree-per-connection model. Publishing redirects to the existing server-native pipeline via a thin upload-patch shim; the working tree IS the diff source against `main`, with `gix` doing index-backed diff detection.

> **Revision history.** The original 2026-05-17 draft proposed inline HTTP patches and a brand-new server publish pipeline. After CEO + eng review on 2026-05-18, the design was revised to use a presigned GCS upload shim that feeds the existing `publish-v2/plan-job` + `run-job` server pipeline (one publish path on the server, no parallel system). The Decision log appendices below capture the rationale.

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

**Publish** (desktop app initiates; all mutating ops acquire `.scratch/lock` first):

1. `gix::Repository::status(...)` enumerates files modified vs `HEAD`.
2. For each changed path: read the snapshot blob via gix (`HEAD:<path>`), read the working file from disk, compute the JSON merge patch.
3. `POST /workbook/:id/upload-patch/init` → server returns `{ uploadId, presignedUrl }`.
4. CLI PUTs the patch payload directly to GCS using the presigned URL.
5. `POST /workbook/:id/upload-patch/commit { uploadId, baseHead? }` → server validates paths, enqueues an `ApplyPatchesJob`. Response includes `stalenessWarning?: { newHead }` if `baseHead` doesn't match server's `main`.
6. `ApplyPatchesJob` worker: stream patch from GCS → apply RFC 7396 patches to the server-side dirty branch as one commit → trigger the existing `publish-v2/plan-job` + `run-job`.
7. On job success, the desktop app calls `git fetch origin main` so the local `HEAD` advances and subsequent diff detection reports "no changes" again.

If `stalenessWarning` is present, the desktop shows a non-blocking banner: "The server has more recent changes than what's on your computer. Refresh first?" The patches were still applied — single-user assumption + audit/telemetry covers the residual risk.

**Pull** (download latest from server; `.scratch/lock` acquired):

1. Read `refs/heads/main` as `old_head`.
2. Compute the user's local patches: `gix status` for changed files; for each, `diff(snapshot_at_old_head[path], current[path])`.
3. `git fetch origin main` (incremental, packed).
4. `gix` tree-vs-tree diff between `old_head` and the new `HEAD` → list of server-changed paths.
5. For each path in (server-changed ∪ user-changed):
   - Write the new-HEAD blob to the working file.
   - If the user had a patch for this path, re-apply it.
   - For each key the user's patch touches: if `snapshot_at_old_head[key] != snapshot_at_new_head[key]`, append to `.scratch/conflicts.log` AND emit a PostHog event (`desktop.pull.conflict` with `{ connectorAccountId, conflictCount, pathPattern }`, no record content).

**Init**:

1. Resolve the workbook's connector accounts.
2. For each connection (in parallel via `rayon::par_iter`):
   - `git clone --bare` into `.repos/<repo-id>.git/`.
   - `git worktree add --no-detach <workspace>/<Connection> main` (shell out unless gix has caught up — verify before defaulting).
3. Write `.scratch/workspace.yaml`.
4. If 1/N connectors fails, warn + continue with N-1. If 0/N, exit non-zero. If a partial prior init is detected, resume the missing connections.
5. Done. One bare repo + one worktree per connection. No `reviewed-dirty`, no `master` worktree, no SQLite index.

### Decisions / open questions

| Decision                      | Recommendation                                                                                                                                          | Why                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch granularity             | RFC 7396 (Merge Patch) — field-level, arrays atomic                                                                                                     | ~60 lines total. Upgrade to RFC 6902 only if same-array conflicts become a real problem.                                                                        |
| Conflict policy               | User wins; log same-field collisions to `.scratch/conflicts.log`                                                                                        | Zero blocking UX, no silent data loss without an audit trail.                                                                                                   |
| Snapshot storage              | Bare repo objects (read via `gix::rev_parse("HEAD:<path>")`)                                                                                            | No duplicate on-disk snapshot directory. Packed objects are already efficient storage.                                                                          |
| Diff detection mechanism      | `gix::Repository::status(Discard).into_iter([])` against the worktree                                                                                   | Index-backed; measured ~235ms cold / ~210ms warm on the Stripe worktree (~110k files). Already a dependency. See [Measured performance](#measured-performance). |
| Working tree shape            | One **non-sparse** git worktree of `main` per connection                                                                                                | The `.git` link file is the only artifact; identical to today's dirty checkout. Non-sparse so we don't pay sparse-checkout config overhead.                     |
| Transport                     | `git clone --bare` + `git fetch origin main` (incremental)                                                                                              | Free incremental fetch from existing scratch-git-2 backend; no tarball or manifest-API to build.                                                                |
| Worktree creation             | Shell out to `git worktree add` at init                                                                                                                 | gix 0.70's worktree-add support is limited; we already shell out for this today in `setup_sparse_worktree`. Hot path is one call per connection.                |
| Publish wire format           | Split: `POST :id/upload-patch/init` (returns presigned GCS URL + `uploadId`) → CLI PUTs to GCS → `POST :id/upload-patch/commit { uploadId, baseHead? }` | Inline POST hits NestJS body-parser limits on big publishes. Presigned upload + async job matches the existing publish-v2 UX. See Decision log — CEO §1, §7.    |
| Concurrent pulls / publishes  | `baseHead` is optional; mismatch returns soft warning, server applies anyway                                                                            | Hard 409 would fail too often once incremental polling started moving `main` server-side. See Decision log — CEO §3.                                            |
| Arrays in RFC 7396 are atomic | Accept the limitation; log it in the conflicts file if both sides touched                                                                               | Rare in record-per-file data; upgrade to RFC 6902 only if user pain materializes.                                                                               |
| Local concurrency             | File lock at `.scratch/lock` for any mutating CLI op                                                                                                    | Single-worktree design loses the implicit serialization the three-worktree model had. Matches git's own `.git/index.lock` pattern. See Decision log — CEO §5.   |

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

### Phase 1 — Unify publish on the server via /upload-patch

**Goal:** Replace local publish-plan building with a server-native flow that feeds the existing `publish-v2/plan-job` + `run-job` pipeline. Eliminate the dual publish paths (server-native used by web client + run-from-git used by desktop) → one server publish path.

**Endpoint shape** (thin upload shim, not a new pipeline):

```
POST /workbook/:id/upload-patch/init
  → { uploadId, presignedUrl }      // presigned GCS PUT URL, ≤24h TTL

CLI PUTs the patch payload to GCS using the presigned URL.

POST /workbook/:id/upload-patch/commit { uploadId, baseHead? }
  → enqueues ApplyPatchesJob (BullMQ)
  → response: { jobId, stalenessWarning?: { newHead } }

ApplyPatchesJob worker:
  → streamObject(uploadId) from GCS
  → validate every patch.path via validateRecordPath()
  → apply RFC 7396 patches to dirty branch as ONE commit
  → enqueueRunPipelineJob() (existing publish-v2 plan-job + run-job)
```

**`baseHead` semantics:** optional. If omitted, server applies with no concurrency check. If provided and mismatched, server applies anyway and returns a staleness warning (incremental server-side polling moves `main` under the user; hard 409 would fail too often given the single-user assumption). See Decision log — CEO §3.

**Server deliverables:**

- Controllers: `/upload-patch/init` + `/upload-patch/commit` (likely as new `upload-patch.controller.ts` under `server/src/cli/` or extending `cli-workbook.controller.ts`)
- `JobType.ApplyPatches` + `ApplyPatchesJobDefinition { workbookId, userId, connectorAccountId, uploadId, baseHead? }` + worker handler under `server/src/worker/jobs/`
- `enqueueApplyPatchesJob(...)` in `bull-enqueuer.service.ts` (mirror `enqueuePublishFromGitJob`)
- Extend `server/src/asset/object-storage.service.ts` with `signPutUrl(key, expiresIn): Promise<string>` and `streamObject(key): Promise<Readable>` (reuse existing `Storage` client + IAM)
- Path validation utility at `server/src/utils/path-validation.ts` exporting `validateRecordPath(path, dataFolders): Result<string, ValidationError>` (rejects `..`, leading `/`, `.git/` / `.scratch/` prefixes, and paths outside known DataFolders)
- AuditLog entry on `/upload-patch/commit`: `{ event: 'upload_patch.commit', workbookId, connectorAccountId, patchCount, baseHeadMatched, byteSize }`

**CLI deliverables:**

- Replace `scratchmd files upload` implementation in-place (no `upload-v2`, no flag-gating). New flow: gix-status → per-file RFC 7396 patch → presigned PUT to GCS → call `/commit`.
- File lock at `.scratch/lock` (also Phase 5 prereq) — acquire on any mutating op, release on completion/panic. Detect + reclaim stale locks via PID check.

**Desktop deliverables:**

- Rewrite `scratch-desktop/src/renderer/src/pages/workspace/PublishChangesModal.tsx`. The 6-mode state machine (`approval / planning / ready / publishing / complete / error`) becomes the new flow's modes (`computing-diff / uploading / queued / publishing / complete / error`).
- Staleness banner consuming `stalenessWarning` from the `/commit` response. Non-blocking, dismissible: "The server has more recent changes than what's on your computer. Refresh first?"

**Asset uploads stay on the existing `/assets` pipeline.** Patches are JSON-only. The `publish-plan-build` service's asset-upload phase 0 continues to read asset refs from the dirty branch — unchanged. See Decision log — Eng §7.

**Tests (mandatory for Phase 1 to ship):**

- **Parity test** at `server/src/publish-plan/__tests__/upload-patch-parity.spec.ts`. Feed identical edits through both `/upload-patch` → plan-job and through legacy `run-from-git`. Assert same dispatched operations (`phase`, `path`, `content`, `changedFields`) AND same final `main` commit SHA. Deleted in Phase 7.
- **Permanent end-to-end smoke test** at `server/src/publish-plan/__tests__/upload-patch.e2e.spec.ts`. Asserts the full round-trip (edit → upload → commit → plan-job → run-job → connector update → main advanced). Survives Phase 7 as the integration regression backstop.

**Leaves alone:** `reviewed-dirty`, the SQLite index, `shared/plan_publish.rs`, the `run-from-git` endpoint. All deleted in later phases. The new path is additive.

Done when: desktop's publish action uses `/upload-patch` end-to-end against test-api; parity test green; permanent e2e smoke test in CI.

### Phase 2 — Replace download with stash/replay

**Goal:** Replace the three-way merge download with a stash/replay model: capture user patches against the old HEAD, fetch new HEAD, write server blobs, replay user patches; same-field collisions resolve user-wins, are logged locally, and emit telemetry.

**CLI flow:**

1. Acquire `.scratch/lock` (Phase 1 prereq).
2. Read `refs/heads/main` as `old_head`.
3. `gix status` → compute per-file user patches against `old_head` snapshots.
4. `git fetch origin main`.
5. Tree-vs-tree diff between `old_head` and new `HEAD` → list of server-changed paths.
6. For each path in (server-changed ∪ user-changed):
   - Write new-HEAD blob to working file.
   - If user has a patch for this path: replay it.
   - For each key the user's patch touches: if `snapshot_at_old_head[key] != snapshot_at_new_head[key]`, append to `.scratch/conflicts.log` AND fire a PostHog event.

**`conflicts.log` entry shape** (one JSON object per line, no record content):

```
{ "ts": "2026-05-18T13:24:51Z", "connectorAccountId": "ca_...", "path": "Companies/rec123.json", "conflictingKeys": ["website", "industry"] }
```

**PostHog event:** `desktop.pull.conflict` with `{ connectorAccountId, conflictCount, pathPattern }` (path pattern = folder, not record content).

**Desktop:** Refresh action switches to the new path. No new UI required (conflicts silent, logged, telemetered). See Decision log — CEO §8.

**Leaves alone:** init still creates three worktrees. Stash/replay supersedes the three-way merge but doesn't require Phase 5 first.

Done when: desktop refresh uses the new path; round-trip test with concurrent server + user changes asserts user-wins; PostHog event fires; `conflicts.log` entry written.

### Phase 3 — Stop creating `reviewed-dirty` on init

- Once Phase 1 lands, `reviewed-dirty` is unused. Delete `layout.reviewed_dirty_checkout_path` references and the worktree setup at `workspaces.rs:702`.
- Also delete the `update_reviewed_dirty` calls in `cli/commands/files.rs`.
- Saves ~10–15s of `init` per large connection.

Done when: `init` no longer creates the worktree and no code path references it.

### Phase 4 — Drop the SQLite index

Once Phase 1 lands, local `plan_publish` no longer runs → the eager `index::build` at `workspaces.rs:736` is dead weight.

- Drop the index entirely (preferred). No caller should need it once Phases 1 + 2 are live.
- Also delete `update_dirty_worktree_index` at `scratch-git-2/src/cli/commands/files.rs:2210` and all its callers — dead code after the index goes (eng follow-up E2).

Saves ~35s of init for the Stripe connector on the Monorepo workspace.

Done when: init doesn't build the index; `shared/index.rs` is either deleted or has no callers from CLI publish/pull paths.

### Phase 5 — Collapse to one worktree per connection

Today's "dirty checkout" (sparse worktree of the dirty branch) becomes the single non-sparse worktree of `main`. The separate `master` worktree goes away — its snapshot-reads role is now served by `gix::rev_parse("HEAD:<path>")` against the bare repo.

- Drop `materialize_dirty_checkout`'s sparse-checkout config; replace with a plain `git worktree add` of `main`.
- Remove all CLI references to the dirty branch. (Server-side, `dirty` continues to exist as the publish working area — by design, unchanged.)
- **Worktree-add mechanism:** verify whether the current gix crate version supports `worktree add` natively before defaulting to shell-out (eng follow-up E3). If gix supports it, drop the shell-out.
- The `.scratch/lock` file lock from Phase 1 continues to gate any mutating op against the single worktree.

Done when: a fresh `init` against `wkb_3qH9SlxsNq` produces one bare repo + one non-sparse `main` worktree per connection, with no `.scratch/connections/*/` directories.

### Phase 6 — Parallelize connections

Replace the `for (ca, entry) in ...` loop at `workspaces.rs:411` with `rayon::par_iter` or `tokio::task::spawn_blocking` fan-out. Ships after Phase 5 (each connection is then "clone + worktree add" with no shared mutable state).

**Failure policy** (CEO follow-up F5): if 1/N connections fails to clone, log a warning and continue with the other N-1 — user gets a partial-but-usable workspace. If 0/N succeed, exit non-zero.

**Re-init detection** (CEO follow-up F6): if the workspace dir contains a partial prior init (some bare repos exist, others don't), detect via marker scan and resume the missing connections. Failing-clean is acceptable as a fallback.

Done when: total wall time is dominated by the single slowest connection, not the sum; partial-failure behavior is tested.

### Phase 7 — Delete `publish-v2/run-from-git`

Once Phases 1–6 are live and the desktop app has shipped using `/upload-patch`, monitor server metrics for callers of `POST :id/publish-v2/run-from-git`. When zero callers are observed for a sustained window (≥7 consecutive days), delete:

- The `run-from-git` endpoint in both `cli-workbook.controller.ts` and `publish-plan.controller.ts`.
- `enqueuePublishFromGitJob` and `publish-from-git.service.ts`.
- The CLI's local plan-build command (the `scratchmd files upload` flow that produces phase files).
- `scratch-git-2/src/shared/plan_publish.rs` (~600 LOC) and any remaining callers.
- The parity test introduced in Phase 1 (see Captured decisions §6).

Net debt reduction: ~600 LOC + sparse-checkout config + SQLite index code removed. After Phase 7, the only publish path on the server is `/upload-patch` → `publish-v2/plan-job` → `publish-v2/run-job`.

**Perf gate (from eng review D11):** Before deletion, measure p50/p95 latency of the new path's `/upload-patch` → first published operation on the Monorepo workspace (135k files). Must be within 2× today's `run-from-git` baseline. If it regresses beyond that, fix before deletion, don't ship the regression and clean up later.

Done when: `run-from-git` has been removed from the server, CLI, and desktop, the parity test is gone, and the perf gate cleared (the permanent end-to-end smoke test from eng review §10 continues to assert publish round-trip).

## Out of scope

- Multi-user collaborative editing of the same workspace (still single-user assumed).
- Binary-file diffing (records are JSON; assets stay handled by the existing asset pipeline).
- Rewriting the server's publish pipeline itself — Phase 1 reuses it.
- Migrating existing workspaces on disk. New init produces the new layout; old workspaces continue working until re-init.
- Server-side dirty-branch cleanup. The branch may continue to exist server-side after Phase 5; removing it is a separate server-side task.

## Risks

- **Same-field collision = silent user-wins.** Mitigated by `.scratch/conflicts.log` + PostHog event (Phase 2). The desktop app should eventually surface this as a UI; out of scope for v1.
- **Server-side publish performance.** Path A (`plan-job` + `run-job`) already exists and runs in production for the web client, so structurally the cutover is safe — but its perf on the 135k-file Monorepo workspace hasn't been benchmarked. Phase 7's gate forces a measurement before deletion (T11).
- **gix `worktree add` gaps.** gix 0.70's worktree-add support was limited. Eng follow-up E3 verifies the current crate version before defaulting to shell-out.
- **Loss of git-as-undo.** Users currently have a local git history they could in principle inspect. Almost certainly unused, but worth confirming nobody depends on it before Phase 5 ships.
- **Migration of in-flight workspaces.** Workspaces already initialized on the old layout keep using the old code paths until they re-init. The desktop should prompt re-init when the new path lands.

## CEO follow-ups

Smaller items to track as separate tickets. None block shipping the phases above.

| #   | Item                                                              | Why                                                                | Effort (CC) |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| F1  | Parallelize per-file patch loop in CLI publish (rayon)            | 1000+ files sequential is slow on Monorepo                         | 15min       |
| F2  | gix-patterns docs page in `scratch-git-2/docs/`                   | Bus factor — only the spike file uses gix today                    | 30min       |
| F3  | AuditLogService entries for `/upload-patch` + publish trigger     | `server/CLAUDE.md` requires audit logging on CLI interactions      | 30min       |
| F4  | Body size + nesting depth caps on `/upload-patch/commit`          | DoS guard on the trigger endpoint (presigned upload itself is GCS) | 15min       |
| F5  | Init: 1/N connector failure policy (continue vs rollback)         | Plan doesn't specify; needs choice + UX                            | 30min       |
| F6  | Init: re-run on partial state — resume or fail-clean              | Detect partial prior init and decide                               | 1h          |
| F7  | iCloud/Dropbox workspace detection + warning                      | Git on cloud-synced FS corrupts state                              | 1h          |
| F8  | Multi-connection publish atomicity model                          | Partial-success UX when 3/5 connectors succeed                     | 1h          |
| F9  | Publish-then-fetch failure → server-driven HEAD-advance signal    | Avoid silent local divergence when `git fetch` fails post-publish  | 1h          |
| F10 | conflicts.log rotation                                            | Prevent unbounded growth                                           | 15min       |
| F11 | Worktree lock metrics (acquire timeout, stale recovery)           | Observability gap                                                  | 30min       |
| F12 | Promote init-phase timings (`SCRATCHMD_PROFILE`) to PostHog event | See init perf in production                                        | 15min       |
| F13 | End-to-end publish smoke test per deploy                          | Catch regressions immediately post-deploy                          | 1h          |

## Eng-review follow-ups

Smaller items surfaced during eng review that don't block phase work.

| #   | Item                                                                                                                                  | Why                                                                      | Effort (CC) |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- |
| E1  | Backfill AuditLog across remaining `server/src/cli/` endpoints                                                                        | Scope-limited in Phase 1 to `/upload-patch`; rest of CLI still uncovered | 1h          |
| E2  | Delete `update_dirty_worktree_index` (`scratch-git-2/src/cli/commands/files.rs:2210`) and callers when Phase 4 drops the SQLite index | Dead code after index removal                                            | 30min       |
| E3  | Verify gix worktree-add support in current crate version (may have landed since 0.70)                                                 | If gix supports it natively, drop the shell-out                          | 15min       |
| E4  | Document desktop's post-publish `git fetch origin main` retry policy                                                                  | Finding 1.6 from CEO review on the data-flow shadow path                 | 30min       |

## Decision log — CEO review (HOLD SCOPE, 2026-05-18)

Rationale behind the architecture decisions captured by `/plan-ceo-review`. The phases above implement the "what"; this appendix preserves the "why" so future readers can judge edge cases.

1. **Endpoint split (Phase 1).** Original proposal was inline `POST /publish { patches, baseHead }`. Conflating upload + publish reduces flexibility (can't retry publish without re-uploading; can't pre-stage a large patch). Split into `/upload-patch/init` + `/commit`.

2. **Reuse server-native publish (Phase 1).** Server already had `publish-v2/plan-job` + `run-job` used by the web client. New endpoint is a thin shim, not a new pipeline. Goal: one publish path on the server, no parallel system.

3. **`baseHead` soft warning, not 409 (Phase 1).** Hard rejection on stale `baseHead` would fail too often once incremental server-side polling started moving `main` under the user. Single-user assumption makes silent overwrites acceptably rare; audit log + telemetry covers the residual risk.

4. **Server-side path validation (Phase 1).** Path traversal in `patch.path` is the only Med-likelihood / High-impact security gap. Defense-in-depth: server is the gate; CLI may validate for UX.

5. **`.scratch/lock` (Phase 1 + Phase 5).** Three-worktree design implicitly serialized via branch ops; the single-worktree design loses this. File lock matches git's own `.git/index.lock` pattern.

6. **Parity test + permanent smoke (Phase 1 + survives Phase 7).** Parity catches divergence between the two publish paths during cutover; the permanent smoke catches integration drift forever.

7. **Presigned GCS upload (Phase 1).** Inline POST hits NestJS body-parser limits and blows up server memory on big publishes. GCS upload-then-process matches the existing async-job UX.

8. **PostHog conflict telemetry (Phase 2).** Conflicts get more common as incremental polling moves `main`. Lightweight signal to know if user-wins is acceptable in practice or if a real conflict-resolution UI is needed later.

9. **Rollout: server first, no flag, caller-identity = version (Phase 1 → Phase 7).** Simpler than feature flags. Server tracks which endpoint each desktop version calls; Phase 7 deletes the old when callers drop to zero for ≥7 days.

## Decision log — Eng review (HOLD SCOPE, 2026-05-18)

Code-level decisions captured by `/plan-eng-review`. Each maps to a task in `~/.gstack/projects/whalesync-spinner/tasks-eng-review-20260518-095015.jsonl`.

1. **Phase 1 explicit deliverables (T1, T2, T6, T10).** Original Phase 1 hid significant UI rework and BullMQ job scaffolding. Spelling them out prevents discovered scope during implementation.

2. **BullMQ `JobType.ApplyPatches` scaffolding (T2).** Mirror the existing `publish-from-git` pattern (enum + JobDefinition + worker + enqueuer + queue routing). Consistency reduces cognitive load.

3. **Extend `object-storage.service.ts` (T3).** Existing service already does GCS ops for assets. Adding `signPutUrl` + `streamObject` reuses the existing `Storage` client, bucket config, and IAM. DRY.

4. **Scope AuditLog to `/upload-patch` only (T4).** Backfilling AuditLog across `server/src/cli/` is real work but separable. Phase 1 closes the new gap; full backfill tracked as E1.

5. **`server/src/utils/path-validation.ts` (T5).** Path validation rules from CEO §4 have no existing helper. Living as a shared util enables reuse from future endpoints (asset, sync, anywhere paths flow from the wire).

6. **Parity test compares dispatched ops + final SHA (T6).** Path A reads `getRepoStatus`; Path B reads phase files. Comparing internal data structures would couple to implementation; comparing dispatched operations + final `main` SHA tests the OBSERVABLE contract.

7. **Asset uploads unchanged (T7).** Bundling binaries into `/upload-patch` would couple two pipelines that have separate lifecycles. Keep them apart; document the existing flow so future readers don't think assets are missing.

8. **Replace `scratchmd files upload` in-place (T8).** No `upload-v2`, no flag-gating. Reduces dual-surface area during migration; the command name persists, only the implementation changes.

9. **`discardRemoteDirtyChanges` unchanged (T9).** The endpoint already operates on the server-side dirty branch. With dirty living only server-side now, its semantics become MORE coherent without contract change.

10. **Permanent end-to-end smoke test (T10).** Parity test gets deleted in Phase 7 alongside `run-from-git`. The smoke test is the regression backstop that survives — full edit → publish → main-advanced round-trip in CI on every change.

11. **Phase 7 perf gate (T11).** Path A's `getRepoStatus` exists in production for the web client but hasn't been benchmarked at Monorepo scale (135k files). Gate Phase 7 deletion on p95 within 2× today's `run-from-git` baseline.

## GSTACK REVIEW REPORT

| Review                      | Trigger               | Why                             | Runs | Status             | Findings                                                                                                   |
| --------------------------- | --------------------- | ------------------------------- | ---- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| CEO Review                  | `/plan-ceo-review`    | Scope & strategy                | 1    | CLEAR (HOLD_SCOPE) | mode: HOLD_SCOPE, 0 critical gaps, 9 decisions captured                                                    |
| Eng Review                  | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN)       | 18 issues found across Architecture/Code Quality/Tests/Performance, 0 critical gaps, 11 decisions captured |
| Design Review               | `/plan-design-review` | UI/UX gaps                      | 0    | —                  | —                                                                                                          |
| Adversarial / Outside Voice | `/codex`              | Independent 2nd opinion         | 0    | skipped            | Codex CLI not installed; user opted out                                                                    |

**UNRESOLVED:** 0
**VERDICT:** CEO + ENG CLEARED — ready to implement. Phase 1 has explicit deliverables (T1-T6, T10), perf gate locked for Phase 7 (T11). Tasks artifact at `~/.gstack/projects/whalesync-spinner/tasks-eng-review-20260518-095015.jsonl`.
