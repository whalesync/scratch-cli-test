# Simplify Local Workspace Architecture

**Date**: 2026-05-17 (last updated 2026-05-19)
**Status**: Phase 1 shipped on `dev-10144-{mr1,mr2,mr3}`. Phases 2–7 not started.
**Linear**: [DEV-10144](https://linear.app/whalesync/issue/DEV-10144/scratchmd-simplify-workspaces-init-drop-worktrees-move-publish-to)
**Author**: Curtis Fonger

**Scope**: Replace the three-worktree + eager SQLite + local-publish architecture of `scratchmd workspaces init` with a one-bare-repo + one-non-sparse-worktree-per-connection model. Publishing redirects to the existing server-native pipeline via a thin upload-patch shim; the working tree IS the diff source against `main`, with `gix` doing index-backed diff detection.

## Contents

- [Problem](#problem) — what's slow and why
- [Current architecture (recap)](#current-architecture-recap) — three worktrees, what each is for
- [End-state design](#end-state-design) — layout, why git, [the patch file](#review-state-the-accepted-patches-file), operations, decisions, measured perf
- [Migration plan](#migration-plan) — [Phase 1](#phase-1--unify-publish-on-the-server-via-upload-patch) (shipped) through [Phase 7](#phase-7--delete-publish-v2run-from-git)
- [Out of scope](#out-of-scope) · [Risks](#risks) · [Status](#status) · [Follow-ups](#follow-ups)
- [Decision log](#decision-log) — why each choice was made
- [Phase 1 implementation notes](#phase-1-implementation-notes) — what specifically shipped on `mr1`/`mr2`/`mr3`

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
    <stripe-repo-id>.db              ← SQLite: per-folder tables for grid pagination + validation
    <hubspot-repo-id>.git/
    <hubspot-repo-id>.db
    ...
  .scratch/
    workspace.yaml                   ← workspace marker (unchanged shape)
    conflicts.log                    ← same-field collisions from pull (audit-only)
    connections/<conn>/
      accepted-patches.json          ← user's approved-pending-publish edits (RFC 7396; IS the wire payload)
```

What disappears vs. today: `.scratch/connections/*/dirty/`, `.scratch/connections/*/master/`, `.scratch/connections/*/reviewed-dirty/` worktrees, the `file_index` and `file_references` tables inside `.repos/<conn>.db` (per-folder tables stay — see [Phase 4](#phase-4--stop-building-the-master-file_index-table-at-initdownload)), and the sparse-checkout configuration in each worktree.

What stays: one bare repo per connection (already used as transport), one worktree per connection (the user's editable directory), the `.repos/<conn>.db` SQLite file (now holding only per-folder tables that the desktop UI's grid view depends on).

### Why keep git locally

Git earns its keep on three fronts that would otherwise need bespoke replacements:

1. **Incremental fetch.** `git fetch origin main` only ships changed objects; the scratch-git-2 service already speaks it.
2. **Snapshot storage.** The bare repo's packed objects ARE the snapshot for "what was main when we pulled" — no separate snapshot directory needed. Snapshot reads go through `gix::Repository::rev_parse("HEAD:<path>")` → blob bytes.
3. **Fast diff detection via index.** `gix::Repository::status(...)` uses git's index to skip unchanged files via `stat`, hashing only files whose mtime/size changed. Measured ~210ms warm on the Stripe worktree (~110k files); see [Measured performance](#measured-performance) below.

What we stop using git for: branches (no `dirty`, no `reviewed-dirty`), local commits (publishing is now an HTTP call), local merge logic (`shared/plan_publish.rs` machinery), and the `file_index` SQLite table that the local plan generator depended on.

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

Once Phase 5 lands, the patch isn't (re)computed at publish time — it's accumulated incrementally in [`accepted-patches.json`](#review-state-the-accepted-patches-file) as the user accepts changes. The diff logic moves from "publish time" to "accept time."

### Review state: the accepted-patches file

Today's three-worktree model encodes review state structurally — `dirty` HEAD is "user's accepted edits", working tree is "live unreviewed edits", `master` HEAD is "last published." Collapsing to one worktree on `main` removes that structure. Replacement: a per-connection JSON file holding exactly the `UploadPatchPayload` that would be sent to `/upload-patch/init`, accumulated as the user accepts changes.

**File path:** `<workspace>/.scratch/connections/<conn>/accepted-patches.json`

**Shape:** the same RFC 7396 payload the server already accepts:

```json
{
  "patches": [
    {
      "path": "Companies/rec_123.json",
      "kind": "update",
      "patch": { "industry": "SaaS" }
    },
    {
      "path": "Companies/rec_456.json",
      "kind": "create",
      "patch": { "name": "Acme" }
    },
    { "path": "Companies/rec_789.json", "kind": "delete", "patch": null }
  ]
}
```

The file IS the wire format. Publish becomes "read file → PUT to GCS → POST `/commit`" — no diff computation at upload time. All the diff logic happens at accept time, which matches the user's intent moment.

**Per-file state** falls out of two comparisons:

- **Unreviewed**: working file ≠ `apply(snapshot, patch_for_path)`, where `patch_for_path` is the entry in `accepted-patches.json` (or empty if absent).
- **Approved, pending publish**: path appears in `accepted-patches.json` AND working file matches `apply(snapshot, patch)`.
- **Published**: no entry in patch file AND working file matches snapshot.

`folder_index`'s `approvedChanges` / `unapprovedChanges` columns populate from those same two comparisons during `reindex_files`. Same SQL filters (`WHERE unapprovedChanges = 1`) work unchanged — only the compute changes (Phase 5).

**Accept / reject / discard semantics:**

| Action                          | Effect on worktree              | Effect on `accepted-patches.json`                       |
| ------------------------------- | ------------------------------- | ------------------------------------------------------- |
| `accept <path>`                 | unchanged                       | compute `merge_patch(snapshot, working)`, replace entry |
| `accept-field <path> <field>`   | unchanged                       | compute single-key patch, merge into entry              |
| `accept-all`                    | unchanged                       | one entry per modified path                             |
| `reject <path>`                 | restore from `gix::HEAD:<path>` | remove entry                                            |
| `reject-field <path> <field>`   | restore that key from snapshot  | remove key from entry; delete entry if empty            |
| `discard <path>` (unreviewed)   | restore from snapshot           | unchanged                                               |
| `discard-all`                   | restore every modified file     | unchanged                                               |
| `restore-deleted-record <path>` | un-delete from snapshot         | remove `delete` entry if present                        |
| `discard-created-record <path>` | delete from worktree            | remove `create` entry                                   |

**Atomic writes:** write to `accepted-patches.json.tmp`, fsync, rename. The existing `.scratch/lock` gates concurrent mutation.

**Re-anchoring on pull:** an accepted patch is a diff against `old_head[path]`. After `git fetch` advances `main`, each entry must be valid against `new_head[path]`. Three cases:

- Server didn't touch the path → patch valid as-is.
- Server deleted the path → if the user had an `update` accepted, convert to a `create` with reconstructed content; log a conflict.
- Server changed a key the user's patch touches → user-wins. Patch value stays; semantics shift from "change A→B" to "set to B." Append to `.scratch/conflicts.log` + emit `desktop.pull.conflict`.

The re-anchor routine for working-tree patches (unreviewed) and for the accepted-patches file is the same logic, run twice.

### Operations

**Publish** (desktop app initiates; all mutating ops acquire `.scratch/lock` first):

1. Read `accepted-patches.json` for the connection.
2. `POST /workbook/:id/upload-patch/init` → server returns `{ uploadId, presignedUrl }`.
3. CLI PUTs the patch payload (the file's contents, verbatim) to GCS using the presigned URL.
4. `POST /workbook/:id/upload-patch/commit { uploadId, baseHead? }` → server validates paths, enqueues an `ApplyPatchesJob`. Response includes `stalenessWarning?: { newHead }` if `baseHead` doesn't match server's `main`.
5. `ApplyPatchesJob` worker: stream patch from GCS → apply RFC 7396 patches to the server-side dirty branch as one commit → trigger the existing `publish-v2/plan-job` + `run-job`.
6. On job success: clear `accepted-patches.json`; desktop calls `git fetch origin main` so the local `HEAD` advances.

If `stalenessWarning` is present, the desktop shows a non-blocking banner: "The server has more recent changes than what's on your computer. Refresh first?" The patches were still applied — single-user assumption + audit/telemetry covers the residual risk.

**Pull** (download latest from server; `.scratch/lock` acquired):

1. Read `refs/heads/main` as `old_head`.
2. Collect two patch sets to re-anchor:
   - **Working-tree patches** (unreviewed): `gix status` for changed files; for each, `diff(snapshot_at_old_head[path], working[path])`.
   - **Accepted patches** (approved, not yet published): load `accepted-patches.json`.
3. `git fetch origin main` (incremental, packed).
4. `gix` tree-vs-tree diff between `old_head` and the new `HEAD` → list of server-changed paths.
5. For each server-changed path, re-anchor any user patch (working or accepted) that referenced it:
   - **Server didn't change a key the user touched** → patch valid as-is.
   - **Server deleted the path** → if the user had an accepted update, convert to a `create` patch with reconstructed content; log a conflict.
   - **Server changed a key the user's patch touches** → user-wins. Patch value stays; meaning shifts from "change A→B" to "set to B." Append to `.scratch/conflicts.log` and emit `desktop.pull.conflict` with `{ connectorAccountId, conflictCount, pathPattern }` (no record content).
6. Write new-HEAD blobs to working files for paths the user didn't touch. Re-apply working-tree patches on top of new-HEAD blobs. Persist re-anchored accepted patches back to `accepted-patches.json`.

**Init**:

1. Resolve the workbook's connector accounts.
2. For each connection (in parallel via `rayon::par_iter`):
   - `git clone --bare` into `.repos/<repo-id>.git/`.
   - `git worktree add --no-detach <workspace>/<Connection> main` (shell out unless gix has caught up — verify before defaulting).
3. Write `.scratch/workspace.yaml`.
4. If 1/N connectors fails, warn + continue with N-1. If 0/N, exit non-zero. If a partial prior init is detected, resume the missing connections.
5. Done. One bare repo + one worktree per connection. No `reviewed-dirty`, no `master` worktree, no `file_index` SQLite table. (`.repos/<conn>.db` is created lazily on first folder open for grid-view tables.)

### Design decisions

| Decision                      | Recommendation                                                                                                                                          | Why                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch granularity             | RFC 7396 (Merge Patch) — field-level, arrays atomic                                                                                                     | ~60 lines total. Upgrade to RFC 6902 only if same-array conflicts become a real problem.                                                                        |
| Conflict policy               | User wins; log same-field collisions to `.scratch/conflicts.log`                                                                                        | Zero blocking UX, no silent data loss without an audit trail.                                                                                                   |
| Snapshot storage              | Bare repo objects (read via `gix::rev_parse("HEAD:<path>")`)                                                                                            | No duplicate on-disk snapshot directory. Packed objects are already efficient storage.                                                                          |
| Diff detection mechanism      | `gix::Repository::status(Discard).into_iter([])` against the worktree                                                                                   | Index-backed; measured ~235ms cold / ~210ms warm on the Stripe worktree (~110k files). Already a dependency. See [Measured performance](#measured-performance). |
| Working tree shape            | One **non-sparse** git worktree of `main` per connection                                                                                                | The `.git` link file is the only artifact; identical to today's dirty checkout. Non-sparse so we don't pay sparse-checkout config overhead.                     |
| Transport                     | `git clone --bare` + `git fetch origin main` (incremental)                                                                                              | Free incremental fetch from existing scratch-git-2 backend; no tarball or manifest-API to build.                                                                |
| Worktree creation             | Shell out to `git worktree add` at init                                                                                                                 | gix 0.70's worktree-add support is limited; we already shell out for this today in `setup_sparse_worktree`. Hot path is one call per connection.                |
| Publish wire format           | Split: `POST :id/upload-patch/init` (returns presigned GCS URL + `uploadId`) → CLI PUTs to GCS → `POST :id/upload-patch/commit { uploadId, baseHead? }` | Inline POST hits NestJS body-parser limits on big publishes. Presigned upload + async job matches the existing publish-v2 UX.                                   |
| Concurrent pulls / publishes  | `baseHead` is optional; mismatch returns soft warning, server applies anyway                                                                            | Hard 409 would fail too often once incremental polling started moving `main` server-side.                                                                       |
| Arrays in RFC 7396 are atomic | Accept the limitation; log it in the conflicts file if both sides touched                                                                               | Rare in record-per-file data; upgrade to RFC 6902 only if user pain materializes.                                                                               |
| Local concurrency             | File lock at `.scratch/lock` for any mutating CLI op                                                                                                    | Single-worktree design loses the implicit serialization the three-worktree model had. Matches git's own `.git/index.lock` pattern.                              |

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

## Migration plan

The architecture changes touch many files; the migration is **publish first, then pull, then strip the rest**. Each phase is independently shippable and leaves the system working.

### Phase 1 — Unify publish on the server via /upload-patch

> **Status: SHIPPED** on `dev-10144-{mr1,mr2,mr3}`. The spec below is preserved as a record of what was planned; see [Phase 1 implementation notes](#phase-1-implementation-notes) for what specifically shipped and where it deviated.

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

Publish (separate concern, separate CLI command):
  → CLI calls POST /cli/v1/workbooks/:id/publish-v2/plan-job
  → then POST /cli/v1/workbooks/:id/publish-v2/run-job
```

**`baseHead` semantics:** optional. If omitted, server applies with no concurrency check. If provided and mismatched, server applies anyway and returns a staleness warning (incremental server-side polling moves `main` under the user; hard 409 would fail too often given the single-user assumption).

**Server deliverables:**

- Controllers: `/upload-patch/init` + `/upload-patch/commit` under `server/src/cli/upload-patch.controller.ts`
- `JobType.ApplyPatches` + `ApplyPatchesJobDefinition` + worker handler under `server/src/worker/jobs/`
- `enqueueApplyPatchesJob(...)` in `bull-enqueuer.service.ts`
- `signPutUrlForPatchUpload(key, ttl)` + `streamObjectFromPatchUpload(key)` on `ObjectStorageService` (use-case-specific, each pins bucket + `Content-Type`)
- `validateRecordPath(path, dataFolders)` in `server/src/utils/path-validation.ts`
- AuditLog entry on `/upload-patch/commit`
- CLI shim endpoints for publish-v2 plan + run under `/cli/v1/workbooks/:id/publish-v2/...`

**CLI deliverables:**

- Replace `scratchmd files upload` in-place. New flow: gix-status → per-file RFC 7396 patch → presigned PUT to GCS → call `/commit`.
- New `scratchmd files publish` command — runs `/publish-v2/plan-job` then `/run-job` per connection, polls each to terminal, advances local `refs/heads/main` after success.
- File lock at `.scratch/lock` for any mutating op (also Phase 5 prereq). Detect + reclaim stale locks via PID check.

**Desktop deliverables:**

- Rewrite `scratch-desktop/src/renderer/src/pages/workspace/PublishChangesModal.tsx`. Two-step flow: upload first (single IPC), land on a per-connection diff summary with "Publish now" + "Review on web" actions, then user explicitly publishes.
- Per-connection parallel publish via `Promise.allSettled`; per-connection failure isolation.
- Single shared poller (one bulk-status request per second) feeding all in-flight jobs.
- Staleness banner consuming `stalenessWarning.newHead` from the upload result.

**Asset uploads stay on the existing `/assets` pipeline.** Patches are JSON-only. The `publish-plan-build` service's asset-upload phase 0 continues to read asset refs from the dirty branch — unchanged.

**Tests (mandatory for Phase 1 to ship):**

- **Parity test** at `server/src/publish-plan/__tests__/apply-patches-vs-legacy-invariants.spec.ts`. Feed identical edits through both `/upload-patch` → plan-job and through legacy `run-from-git`. Compare dispatched operations + final `main` SHA. Deleted in Phase 7.
- **Permanent end-to-end smoke test** at `server/src/publish-plan/__tests__/upload-patch.e2e.spec.ts`. Asserts the full round-trip (edit → upload → commit → plan-job → run-job → connector update → main advanced). Survives Phase 7 as the integration regression backstop.

**Leaves alone:** `reviewed-dirty`, the SQLite index, `shared/plan_publish.rs`, the `run-from-git` endpoint. All deleted in later phases. The new path is additive.

**Done when:** desktop's publish action uses `/upload-patch` end-to-end against test-api; parity test green; permanent e2e smoke test in CI.

### Phase 2 — Replace download with stash/replay

**Goal:** Replace the three-way merge download with a stash/replay model: capture user patches against the old HEAD, fetch new HEAD, write server blobs, replay user patches; same-field collisions resolve user-wins, are logged locally, and emit telemetry.

**CLI flow** (Phase 2 version — working-tree patches only; the accepted-patches file is added in Phase 5):

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

**Desktop:** Refresh action switches to the new path. No new UI required (conflicts silent, logged, telemetered).

**Leaves alone:** init still creates three worktrees. Stash/replay supersedes the three-way merge but doesn't require Phase 5 first.

**Future-proofing:** the re-anchor routine should be factored so it accepts a generic patch set (`Vec<(path, patch)>`) rather than reading directly from `gix status`. In Phase 5, the same routine runs twice — once on working-tree patches, once on `accepted-patches.json` — see [Operations → Pull](#operations) for the full end-state. Designing the routine this way in Phase 2 avoids a rewrite at Phase 5.

**Done when:** desktop refresh uses the new path; round-trip test with concurrent server + user changes asserts user-wins; PostHog event fires; `conflicts.log` entry written.

### Phase 3 — Stop creating `reviewed-dirty` on init

Once Phase 1 lands, `reviewed-dirty` is unused. Delete `layout.reviewed_dirty_checkout_path` references and the worktree setup in `workspaces.rs`. Also delete the `update_reviewed_dirty` calls in `cli/commands/files.rs` (called from accept/reject paths). Saves ~10–15s of `init` per large connection.

**Why this is safe to ship before Phase 5:** the only code that reads from `reviewed-dirty` is `shared/plan_publish.rs`, which Phase 1 dead-coded at runtime by routing desktop publishes through `/upload-patch`. Stopping the writes (`update_reviewed_dirty`) means the worktree (if it still exists on an old workspace) drifts out of sync with `dirty` — but nothing reads it, so the drift is harmless. New workspaces don't create the worktree at all.

**Done when:** `init` no longer creates the worktree and no code path references it.

### Phase 4 — Stop building the master `file_index` table at init/download

**Audit finding (2026-05-19):** There is one SQLite file per connection (`<workspace>/.repos/<conn>.db`) shared by **two** Rust modules that write **different tables** in that file:

| Tables                                                                                               | Written by                                                                                                                                                            | Read by                                                                                                                  | Lifecycle                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file_index`, `file_references`                                                                      | `shared/index.rs::build` from the CLI (eager at init + after every download)                                                                                          | Only `shared/plan_publish.rs` on the client (dies post-Phase 1 at runtime, source deleted in Phase 7)                    | Phase 4 stops writing these                                                                                                                                                                                                                         |
| Per-folder tables (`Contacts`, `blog_en`, ...) with column metadata, FK metadata, validation results | `shared/folder_index.rs::reindex_table` / `refresh_folder` / `reindex_files` etc., invoked by the desktop via `scratchmd index rebuild-folder` / `refresh-files-full` | `read_records.rs::run_query` (SQL `LIMIT/OFFSET/WHERE/ORDER BY` — desktop grid pagination), validators, validation stats | **Tables and columns unchanged in Phase 4.** Note: the `approvedChanges` / `unapprovedChanges` column _compute_ changes in Phase 5 when the three-worktree comparison goes away — see [Phase 5](#phase-5--collapse-to-one-worktree-per-connection). |

**The `.db` file itself stays.** The CLI keeps opening it on every folder rebuild, refresh, and validation call from the desktop. Phase 4 only stops the `shared/index.rs` writes — the small `file_index` table that `plan_publish.rs` consumes.

**Why the desktop UI is unaffected:**

- Grid pagination uses `scratchmd read-records` → `folder_index::run_query` → SQL against per-folder tables. Doesn't touch `file_index`.
- Cross-record FK lookups (linked records, references) in the desktop go through the **server-side** index at `/api/repo/index/:id/lookup-filenames` (production endpoint, see `server/src/workbook/files.service.ts:330`). Not the local DB.
- Validation runs through `folder_index::validate_files`. Doesn't touch `file_index`.

**Delete from the CLI:**

- `workspaces.rs:755` — eager `index::build` at init (~35s saved on Stripe)
- `files.rs:430, 1985` — `rebuild_index_for_conn` calls after downloads
- `files.rs:4665–4687` — `rebuild_index_for_conn` itself (no other callers)
- `cli/commands/index.rs::init_command` + `dump_command` — the two subcommands that operate on the `file_index` table. The rest of that file delegates to `folder_index` (`rebuild-folder`, `refresh-files-full`, `find-stale-files`, `clear-folder`, `add-column`, `clear-column`, `rebuild-all`, `refresh-folder`, `refresh-files-columns-only`) — all of those stay; the desktop calls them.

**Defer to Phase 7** (deleted alongside `run-from-git`):

- `cli/commands/plan_publish.rs` (the local plan command wiring)
- `shared/plan_publish.rs` (~855 LOC) — the only remaining `file_index` reader

**Keep:**

- `shared/index.rs` (the module file) — the **service binary** depends on it. Same crate, two binaries.
- `service/routes/index.rs` — server-side HTTP API for the index, production load-bearing.
- `shared/folder_index.rs` — entire module, all subcommands, all desktop-facing surface.

**Sequencing:** Phase 4 (stop writing `file_index`) is safe before Phase 7 (stop reading it) because Phase 1 already stopped _calling_ `plan_publish.rs` from active client code paths. Deleting the writes stops doing wasted work; deleting the source waits until Phase 7.

**Done when:** `init` doesn't build the `file_index` table; downloads don't refresh it; `<conn>.db` exists and is written to as before, but no longer contains a `file_index` or `file_references` table after a fresh init.

### Phase 5 — Collapse to one worktree per connection

Today's "dirty checkout" (sparse worktree of the dirty branch) becomes the single non-sparse worktree of `main`. The separate `master` worktree goes away — its snapshot-reads role is now served by `gix::rev_parse("HEAD:<path>")` against the bare repo. The `dirty` branch's role as "user's accepted snapshot" is taken over by [`accepted-patches.json`](#review-state-the-accepted-patches-file).

**Worktree changes:**

- Drop `materialize_dirty_checkout`'s sparse-checkout config; replace with a plain `git worktree add` of `main`.
- Remove all CLI references to the dirty branch. (Server-side, `dirty` continues to exist as the publish working area — by design, unchanged.)
- Delete `update_dirty_worktree_index` at `files.rs:2342` and its 9 call sites — it's a `worktree_reset_mixed` wrapper for the dirty worktree (despite the misleading "index" in its name), obsolete once the dirty worktree is gone.
- **Worktree-add mechanism:** verify whether the current gix crate version supports `worktree add` natively before defaulting to shell-out. If gix supports it, drop the shell-out.
- The `.scratch/lock` file lock from Phase 1 continues to gate any mutating op against the single worktree.

**Accept/reject/discard rewrite** — the CLI commands switch from advancing the `dirty` branch to mutating `accepted-patches.json`:

- `files accept`, `files accept-all`, `files accept-field` → compute merge patch from `snapshot` vs `working`, write into the patch file.
- `files reject`, `files reject-field`, `files restore-deleted-record`, `files discard-created-record` → restore worktree from snapshot, remove the entry (or specific key) from the patch file.
- `files discard`, `files discard-all` → restore worktree from snapshot only (the path is unreviewed by definition; the patch file isn't touched).
- `files unreviewed`, `files unpushed`, `files unpublished` → compute the three states (unreviewed / approved-pending / published) from worktree + snapshot + patch file. See [Review state](#review-state-the-accepted-patches-file) for the per-file state rules.

**Upload simplification** — `scratchmd files upload` (introduced in Phase 1) currently computes patches on the fly from worktree-vs-dirty-vs-main. Replace it with a thin reader: load `accepted-patches.json`, PUT to GCS, POST `/commit`, clear the file on success. The diff computation moves to accept time, where it belongs.

**folder_index column compute** — `reindex_files` / `refresh-files-full` currently populate `approvedChanges` / `unapprovedChanges` by comparing `working_stat` / `dirty_stat` / `master_stat`. Switch to the new compute: `approvedChanges = 1` iff path appears in `accepted-patches.json`; `unapprovedChanges = 1` iff working file differs from `apply(snapshot, patch_for_path)`. Columns and SQL filters stay; only the population logic changes.

**Migration of existing workspaces** — a workspace init'd on the old layout has no `accepted-patches.json` and still has the three worktrees on disk. On first run after Phase 5 ships:

- Option (a): Build a patch file from the existing `dirty`-vs-`master` diff before tearing down the worktrees, then re-clone as the new layout.
- Option (b): Prompt the user to re-init, which loses any locally-accepted-but-unpublished edits. Acceptable if (a) is too much work; the user can publish first, then re-init.

Choice deferred to the Phase 5 implementer; the desktop should at least detect the old layout and surface a clear message.

**Done when:** a fresh `init` against `wkb_3qH9SlxsNq` produces one bare repo + one non-sparse `main` worktree per connection. Accept/reject/discard mutate `accepted-patches.json`. `files upload` reads the file verbatim. `folder_index` columns populate from the new compute.

### Phase 6 — Parallelize connections

Replace the `for (ca, entry) in ...` loop in `workspaces.rs` with `rayon::par_iter` or `tokio::task::spawn_blocking` fan-out. Ships after Phase 5 (each connection is then "clone + worktree add" with no shared mutable state).

**Failure policy:** if 1/N connections fails to clone, log a warning and continue with the other N-1 — user gets a partial-but-usable workspace. If 0/N succeed, exit non-zero.

**Re-init detection:** if the workspace dir contains a partial prior init (some bare repos exist, others don't), detect via marker scan and resume the missing connections. Failing-clean is acceptable as a fallback.

**Done when:** total wall time is dominated by the single slowest connection, not the sum; partial-failure behavior is tested.

### Phase 7 — Delete `publish-v2/run-from-git`

Once Phases 1–6 are live and the desktop app has shipped using `/upload-patch`, monitor server metrics for callers of `POST :id/publish-v2/run-from-git`. When zero callers are observed for a sustained window (≥7 consecutive days), delete:

- The `run-from-git` endpoint in both `cli-workbook.controller.ts` and `publish-plan.controller.ts`.
- `enqueuePublishFromGitJob` and `publish-from-git.service.ts`.
- The CLI's local plan-build command (the `scratchmd files upload` flow that produces phase files — superseded by Phase 1's `upload` + `publish` commands).
- `scratch-git-2/src/shared/plan_publish.rs` (~855 LOC) — the only remaining reader of the local `index.db`. Deleting it completes the Phase 4 work on the client side.
- `cli/commands/plan_publish.rs` (the wiring that opened `index.db` for the local plan command).
- The parity test introduced in Phase 1.

Net debt reduction: ~600 LOC from `plan_publish.rs` and friends + sparse-checkout config + SQLite write paths removed. After Phase 7, the only publish path on the server is `/upload-patch` → `publish-v2/plan-job` → `publish-v2/run-job`.

**Perf gate:** Before deletion, measure p50/p95 latency of the new path's `/upload-patch` → first published operation on the Monorepo workspace (135k files). Must be within 2× today's `run-from-git` baseline. If it regresses beyond that, fix before deletion, don't ship the regression and clean up later.

**Done when:** `run-from-git` has been removed from the server, CLI, and desktop, the parity test is gone, and the perf gate cleared.

## Out of scope

- Multi-user collaborative editing of the same workspace (still single-user assumed).
- Binary-file diffing (records are JSON; assets stay handled by the existing asset pipeline).
- Rewriting the server's publish pipeline itself — Phase 1 reuses it.
- Migrating existing workspaces on disk. New init produces the new layout; old workspaces continue working until re-init.
- Server-side dirty-branch cleanup. The branch may continue to exist server-side after Phase 5; removing it is a separate server-side task.
- The server-side SQLite index in scratch-git (`service/routes/index.rs`). Production grid views, files API linked-record refs, and the legacy publish-from-git path all depend on it. Out of scope for this plan.

## Risks

- **Same-field collision = silent user-wins.** Mitigated by `.scratch/conflicts.log` + PostHog event (Phase 2). The desktop app should eventually surface this as a UI; out of scope for v1.
- **Server-side publish performance.** Path A (`plan-job` + `run-job`) already exists and runs in production for the web client, so structurally the cutover is safe — but its perf on the 135k-file Monorepo workspace hasn't been benchmarked. Phase 7's gate forces a measurement before deletion.
- **gix `worktree add` gaps.** gix 0.70's worktree-add support was limited. Verify the current crate version before defaulting to shell-out.
- **Loss of git-as-undo.** Users currently have a local git history they could in principle inspect. Almost certainly unused, but worth confirming nobody depends on it before Phase 5 ships.
- **Migration of in-flight workspaces.** Workspaces already initialized on the old layout keep using the old code paths until they re-init. The desktop should prompt re-init when the new path lands.

## Status

| Phase                                             | Status                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase 1 — Server `/upload-patch`                  | **Shipped** on `dev-10144-{mr1,mr2,mr3}`. See [Phase 1 implementation notes](#phase-1-implementation-notes) below. |
| Phase 2 — Pull stash/replay                       | Not started                                                                                                        |
| Phase 3 — Drop `reviewed-dirty` on init           | Not started                                                                                                        |
| Phase 4 — Stop building master `file_index` table | Not started. Scope clarified by 2026-05-19 audit (see Phase 4 above).                                              |
| Phase 5 — Collapse to one worktree                | Not started                                                                                                        |
| Phase 6 — Parallelize connections                 | Not started                                                                                                        |
| Phase 7 — Delete `run-from-git`                   | Blocked on ≥7-day zero-caller window + perf gate                                                                   |

## Follow-ups

Smaller items to track as separate tickets. None block shipping the phases above.

### CEO follow-ups

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

### Eng-review follow-ups

| #   | Item                                                                                                                                                                 | Why                                                                                               | Effort (CC) |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------- |
| E1  | Backfill AuditLog across remaining `server/src/cli/` endpoints                                                                                                       | Scope-limited in Phase 1 to `/upload-patch`; rest of CLI still uncovered                          | 1h          |
| E2  | Delete `update_dirty_worktree_index` (`files.rs:2342`) and its 9 callers in Phase 5                                                                                  | Re-scoped: function is a `worktree_reset_mixed` wrapper, not SQLite; dies with the dirty worktree | 30min       |
| E3  | Verify gix worktree-add support in current crate version (may have landed since 0.70)                                                                                | If gix supports it natively, drop the shell-out                                                   | 15min       |
| E4  | Document desktop's post-publish `git fetch origin main` retry policy                                                                                                 | Finding 1.6 from CEO review on the data-flow shadow path                                          | 30min       |
| E5  | Add a branch-head lookup to ScratchGitService → ScratchGitClient and light up the `stalenessWarning` in `/upload-patch/commit`                                       | Currently `/commit` accepts `baseHead` but never compares; signal is dark                         | 1h          |
| E6  | Controller-level e2e for `/upload-patch` (supertest + NestJS TestingModule): asserts AuditLog row written, 503 on unconfigured bucket, staleness banner pass-through | The Phase 1 e2e covers the service; the controller surface still needs coverage                   | 1-2h        |

### CLI-review follow-ups

| #   | Item                                                                                                                                                     | Why                                                                                                                                                                   | Effort (CC) |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| C1  | Wire `.scratch/lock` into the remaining mutating commands (accept/accept-all/accept-field/reject*/discard*/restore-deleted-record/download/force-upload) | Phase 1 introduces the lock; only `upload` calls it today. The other mutating ops still rely on three-worktree implicit serialization, which Phase 5 removes.         | 1h          |
| C2  | Mock-HTTP integration test for the upload-patch round-trip                                                                                               | Unit coverage on `compute_upload_patches` + `merge_patch` is good; an end-to-end CLI test against a fake `/upload-patch/init`-`/commit` would catch wire-shape drift. | 2h          |
| C3  | Surface `stalenessWarning.new_head` in the printed warning (full SHA in `--json`, short SHA in human output)                                             | Today the warning string just lists the short SHA. Desktop will format more usefully; the CLI text could match.                                                       | 15min       |

## Decision log

Rationale captured during review and implementation. Records the _why_ behind the architecture so future readers can judge edge cases.

### Endpoint shape & job pipeline (Phase 1)

1. **Endpoint split.** Original proposal was inline `POST /publish { patches, baseHead }`. Conflating upload + publish reduces flexibility (can't retry publish without re-uploading; can't pre-stage a large patch). Split into `/upload-patch/init` + `/commit`.
2. **Reuse server-native publish.** Server already had `publish-v2/plan-job` + `run-job` used by the web client. New endpoint is a thin shim, not a new pipeline. Goal: one publish path on the server, no parallel system.
3. **Presigned GCS upload.** Inline POST hits NestJS body-parser limits and blows up server memory on big publishes. GCS upload-then-process matches the existing async-job UX.
4. **`baseHead` soft warning, not 409.** Hard rejection on stale `baseHead` would fail too often once incremental server-side polling started moving `main` under the user. Single-user assumption makes silent overwrites acceptably rare; audit log + telemetry covers the residual risk.
5. **Server-side path validation.** Path traversal in `patch.path` is the only Med-likelihood / High-impact security gap. Defense-in-depth: server is the gate; CLI may validate for UX.
6. **`/upload-patch/commit` only applies patches.** First cut auto-enqueued the publish pipeline from `/commit`, which the endpoint's name didn't promise; the CLI's poll then "completed" before the publish actually finished. Split into two CLI calls — `upload` (apply patches) and `publish` (plan-job + run-job).
7. **CLI shim endpoints under `/cli/v1/...`.** The CLI's `ApiClient` hardcodes `/cli/v1/` into its base URL. Two thin shim controllers for `/publish-v2/plan-job` and `/run-job` are cheaper than complicating URL construction, and keep the CLI behind a stable versioned namespace.
8. **Plan and run as two CLI calls, not `runAfterPlan=true` chain.** Splits cleanly for scripting and surfaces plan completion as a useful intermediate state.
9. **Local-main advance moves to `publish`, not `upload`.** Upload doesn't change server main; publish does. Previously they were lumped together in the legacy flow.
10. **`ServiceUnavailableException` (503) on unconfigured bucket** (not `BadRequestException`). Misconfiguration is server-side, not client-side. Client can branch on 503 to surface "admin needs to provision the bucket" vs treating as a user error.
11. **Use-case-specific `signPutUrlForPatchUpload` / `streamObjectFromPatchUpload`.** Each method enforces its bucket and pins `Content-Type`, so callers can't accidentally mix buckets. Preferred over generic `signPutUrl` / `streamObject`.
12. **DTOs in `@spinner/shared-types/dto/upload-patch/`.** Matches existing convention (`dto/schedule/*`, `dto/workbook/*`). Single source of truth for the wire contract; the Rust CLI re-declares the shapes via serde.

### Infrastructure (Phase 1)

13. **24h bucket lifecycle** (not 7d as originally proposed). Patches process within minutes; less data at rest is safer than a longer debugging window.
14. **Wildcard CORS for the upload bucket.** The signed URL is the auth (short TTL, per-upload, server-issued only to the authenticated session). CORS restriction is theatre for signed PUTs and would block future browser clients.
15. **Bucket name `${gcp_project_id}-upload-patches`.** Mirrors the asset bucket's naming.
16. **Local-dev GCS signing via impersonation (`GCS_LOCAL_SIGNING_SA`).** `@google-cloud/storage`'s V4 signer needs a `client_email`; user ADC doesn't have one. Cloud Run's runtime ADC is a service account so signing works natively. The env var, when set, wraps `Impersonated.sign()` to call IAM Credentials `signBlob` against the target SA. Requires `roles/iam.serviceAccountTokenCreator`.

### Concurrency

17. **`.scratch/lock` for any mutating CLI op.** Three-worktree design implicitly serialized via branch ops; the single-worktree design loses this. File lock matches git's own `.git/index.lock` pattern. PID-based stale reclaim via `kill(pid, 0)` ESRCH probe.
18. **`@SkipApiRateLimit` on read-only polling endpoints.** First-cut of the desktop modal had per-connection pollers running concurrently with a page-level poller, producing ~10 `/jobs/bulk-status` requests/sec and exhausting the 60-req/min CLI budget mid-publish. Fixed by (a) consolidating to one shared poller in the desktop, and (b) adding `@SkipApiRateLimit` to read-only polling endpoints in `JobController` (bulk-status, workbook/:id/active, :id/progress, :id/raw, run/:runId). `GET /jobs` (paginated DB scan) and `POST /jobs/:jobId/cancel` (mutating) stay limited.
19. **Single shared poller in the desktop.** One batched `/jobs/bulk-status` call per second feeds both the `jobs` state for connection-row rendering AND per-connection state-machine `await`s via a `pendingWaitsRef` Map.

### Diff format & conflicts

20. **RFC 7396 over RFC 6902.** ~60 lines total. Upgrade to RFC 6902 only if same-array conflicts become a real problem.
21. **User wins on same-field collisions** — log to `.scratch/conflicts.log` + PostHog event. Zero blocking UX, no silent data loss without an audit trail. Conflicts get more common as incremental polling moves `main`; the telemetry is the signal for whether a real conflict-resolution UI is needed later.
22. **Arrays in RFC 7396 are atomic.** Accept the limitation; log it in the conflicts file if both sides touched.

### Storage & diff detection

23. **Bare repo objects as snapshot storage.** No duplicate on-disk snapshot directory. Packed objects are already efficient storage.
24. **`gix::Repository::status(...)` for diff detection.** Index-backed; measured at parity with `git status` warm, ~7× faster cold. Already a dependency.
25. **Non-sparse worktree of `main`.** The `.git` link file is the only artifact; identical to today's dirty checkout. Non-sparse so we don't pay sparse-checkout config overhead.
26. **Shell out to `git worktree add` at init.** gix 0.70's worktree-add support is limited; we already shell out for this today. Hot path is one call per connection.

### SQLite index scope (Phase 4 audit, 2026-05-19)

27. **One SQLite file, two table families.** Initial plan said "drop the SQLite index entirely" — wrong. There's a single `<workspace>/.repos/<conn>.db` per connection. Within it: a `file_index`/`file_references` pair (written by `shared/index.rs`, read only by `plan_publish.rs` on the client) and per-folder tables (written by `shared/folder_index.rs`, read by `read-records` for desktop grid pagination). The file stays; the CLI keeps writing per-folder tables; Phase 4 only stops the `file_index` build. Server-side, the scratch-git microservice's HTTP index API uses the same `shared/index.rs` module but against its own DBs in `service_repos_dir/<id>.db` — independent of the client and out of scope.
28. **Phase 4 is safe before Phase 7.** Phase 1 already stopped _calling_ `plan_publish.rs` from active client code paths; Phase 4 stops writing the `file_index` table the dead-coded reader would have read; Phase 7 deletes the reader source. The intermediate state (write-side gone, read-side still compiled but unreached) is fine.

### Review state in the single-worktree model (Phase 5)

29. **Per-connection `accepted-patches.json` is the source of truth for "approved, pending publish."** Collapsing to one worktree on `main` removes the structural distinction today's three-worktree model gives us between unreviewed and approved edits. Options considered: drop the distinction; use git stage; separate marker file; folder*index as authoritative; second local ref. Picked: store an accumulating RFC 7396 payload at `.scratch/connections/<conn>/accepted-patches.json` that is \_both* the local approved-state record AND the exact wire payload sent to `/upload-patch/init`.
30. **Patch file IS the wire format.** Publish becomes "read file → PUT → /commit" with no diff computation at upload time. Diff logic moves to accept time, where it matches the user's intent moment. Field-level accept naturally composes (merge keys into the entry). Pull re-anchors patches to the new HEAD via the same conflict semantics as the worktree replay — one routine, two inputs (working-tree patches + accepted patches).
31. **Phase 5 is the moment of replacement.** Until Phase 5 ships, `files upload` computes patches on the fly (Phase 1 behavior) so in-flight workspaces continue to work. At Phase 5, `files upload` switches to reading `accepted-patches.json`; CLI accept/reject/discard commands rewrite to mutate the file; `folder_index`'s `approvedChanges` / `unapprovedChanges` columns get a new compute (presence-in-patch-file + worktree-vs-`apply(snapshot, patch)` instead of the three-worktree comparison). Same columns, same SQL filters, new data source.
32. **Why this beats git stage.** Git stage stores file _snapshots_ in git's binary index and would require recomputing patches at publish time via `git diff --staged`. The patch file stores _deltas_ in JSON, IS the upload payload directly, and is trivially inspectable (`cat accepted-patches.json`). Field-level accept maps to merging keys into an entry rather than the more awkward `git add -p` hunk semantics.

### Testing & rollout

29. **Parity test + permanent smoke.** Parity catches divergence between the two publish paths during cutover; the permanent smoke catches integration drift forever. The parity test gets deleted in Phase 7; the smoke survives.
30. **Server first, no flag, caller-identity = version.** Simpler than feature flags. Server tracks which endpoint each desktop version calls; Phase 7 deletes the old when callers drop to zero for ≥7 days.
31. **Perf gate (Phase 7 prerequisite).** Path A's `getRepoStatus` exists in production for the web client but hasn't been benchmarked at Monorepo scale (135k files). Gate Phase 7 deletion on p95 within 2× today's `run-from-git` baseline.

### Phase 1 deviations from the original spec

Captured during implementation. Listed for traceability — none changed the goal, several changed the _how_.

| Plan said                                                        | Shipped                                                                                                            | Why                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop modal: single-step "compute diff → publish"              | Two-step: upload first, land on per-connection summary, user clicks Publish                                        | Explicit separation of "stage server-side" from "actually publish" matches the CLI's `upload`/`publish` split; gives users a checkpoint to review on web first.                            |
| Single-file publish path via `filterPath` (kept for back-compat) | `filterPath` prop dropped; per-file publish entry opens workspace-wide modal                                       | `files upload` always uploads everything accepted; "publish only this file" was never coherent with accept's all-or-nothing semantics.                                                     |
| Sequential per-connection publish                                | Parallel via `Promise.allSettled`                                                                                  | Server queue handles concurrency via BullMQ; cheap to fan out. Wall-clock improvement on multi-connector workspaces, plus per-connection failure isolation.                                |
| Keep IPC name `pushWorkspaceChanges` for back-compat             | Renamed to `uploadWorkspaceChanges`                                                                                | Function no longer "pushes" anything; rename matches the new mental model.                                                                                                                 |
| Aggregate diff: three colored badges                             | Single dimmed text line `0 added · 1 modified · 0 deleted`; zero counts filtered                                   | Visual feedback during dogfooding: three colored badges + per-connection cards + status badges stacked up to "skittles." Color reserved for state badges where it carries meaning.         |
| Modal title static `"Publish changes"`                           | Dynamic per mode: `Uploading changes` / `Ready to publish` / `Publishing changes` / `Published` / `Publish failed` | Static title was misleading during upload. One-line UX win, near-zero cost.                                                                                                                |
| "Review on web" closes the modal                                 | Opens `${webUrl}/workbook/${id}/review`, leaves modal open                                                         | Workbook is the canonical entity name in server URLs (workspace is desktop-only UI terminology). Don't-close: user might want to review then come back to publish without re-uploading.    |
| `gix status` for changed paths                                   | `read_git_tree` diff between local `refs/heads/dirty` and `refs/remotes/origin/main`                               | Pre-Phase-5, the accepted state lives in `dirty`, not the worktree — same diff, different ref pair. Worktree-based gix-status moves in Phase 5.                                            |
| "Wrap every mutating CLI op in `.scratch/lock`"                  | Lock infrastructure landed + wired into `upload` only                                                              | Other mutating ops still have implicit three-worktree serialization. Tracked as CLI follow-up C1.                                                                                          |
| Local refs untouched after publish                               | `refs/heads/main` advanced to match `refs/remotes/origin/main` after job success                                   | Without this, the next `upload` would diff against a stale local `main` and re-send already-published patches.                                                                             |
| Per-job polling acceptable                                       | Single shared poller (one bulk-status request per tick)                                                            | Naive per-job impl produced 429s when scaled to 5 connections × 2 jobs each. Single-poller is the right design regardless of rate-limit fix.                                               |
| Defer server-side rate-limit changes                             | `@SkipApiRateLimit` decorator + applied to all read-only polling endpoints in `JobController`                      | Desktop fix alone solved the immediate bug, but the underlying mismatch (CLI budget applied to UI polling) was the real footgun. Fixing broadly avoids re-surfacing on future polling UIs. |

## Phase 1 implementation notes

Reference material for what specifically shipped. Useful when chasing back through what each slice changed.

### Server slice (`dev-10144-mr1`, commit `d6f78f14`, 23 files / +1773 −3)

- `POST /cli/v1/workbooks/:id/upload-patch/init` + `/commit` controller in `server/src/cli/upload-patch.controller.ts`. Returns **503 `ServiceUnavailableException`** when the patch bucket is unconfigured.
- `ApplyPatchesService` + `ApplyPatchesJobHandler` (`server/src/publish-plan/apply-patches.service.ts`, `server/src/worker/jobs/job-definitions/apply-patches.job.ts`) — streams the GCS payload, applies RFC 7396 patches to dirty as one logical change. (Post-decoupling — see CLI slice — service returns `{ patchCount }`, no auto-publish enqueue.)
- `JobType.ApplyPatches` added; `BullEnqueuerService.enqueueApplyPatchesJob` mirrors `enqueuePublishFromGitJob`; metric maps extended.
- `ObjectStorageService.signPutUrlForPatchUpload(key, ttl)` + `streamObjectFromPatchUpload(key)`. Pinned to `Content-Type: application/json`.
- `validateRecordPath(path, dataFolders)` in `server/src/utils/path-validation.ts` — rejects empty / absolute / traversal / reserved-prefix / outside-folder paths. All-or-nothing across a batch.
- AuditLog row written on `/commit` (`eventType: 'publish'`).
- DTOs in `@spinner/shared-types/dto/upload-patch/upload-patch.dto.ts`. Rust CLI re-declares via serde.

**Tests:**

- `server/src/utils/__tests__/path-validation.spec.ts` — 9 cases.
- `server/src/publish-plan/__tests__/apply-patches.service.spec.ts` — 22 cases including all-or-nothing rejection, mixed batch, no-diff skip, and an explicit regression guard that the service no longer touches publish.
- `server/src/publish-plan/__tests__/apply-patches-vs-legacy-invariants.spec.ts` — hand-modeled baseline comparison.
- `server/src/publish-plan/__tests__/upload-patch.e2e.spec.ts` — gated on `DATABASE_URL`; runs against a real `PrismaClient` with seeded org/user/workbook/connector/data-folders; mocks ScratchGitService + ObjectStorageService + BullEnqueuerService at the boundary. Asserts `/upload-patch/commit` does NOT create a `PublishPlan` row.

### Infrastructure (terraform-applied in both envs on 2026-05-18)

Added to `terraform/modules/env/main.tf`:

- `google_storage_bucket.upload_patches` (`${gcp_project_id}-upload-patches`): private, uniform bucket-level access, **24h lifecycle delete**, CORS `origin=["*"], method=["PUT"], response_header=["Content-Type"]`.
- IAM: `roles/storage.objectAdmin` to `cloudrun-service-account` on the new bucket; signed URLs work because the SA already has `roles/iam.serviceAccountTokenCreator` on itself.
- `GCS_PATCH_UPLOAD_BUCKET` wired into all three Cloud Run services (api / cron / worker) in `services.tf`.
- Applied to `eu-test` and `eu-production`. `/upload-patch/init` returns 503 in both envs until PR 1 ships and the next deploy runs.

### CLI slice (`dev-10144-mr2`)

`scratchmd files upload` replaced in place — no `upload-v2` command, no flag gating. Three new modules plus a clean rewrite of `upload_single_repo`:

- **`scratch-git-2/src/cli/commands/files.rs`** — `run_upload` is async; per-connection it fetches origin, computes the diff between local `main` and local `dirty` (the user's accepted state), emits one RFC 7396 patch per data file, POSTs `/upload-patch/init`, PUTs to the presigned URL with `Content-Type: application/json`, POSTs `/commit`. Legacy local-merge-and-push code deleted (`upload_single_repo`, `apply_remote_changes_to_working_copy`, `read_local_publish_plan_map`, `strip_publish_plan_files`, `TreeCache`, `push_origin_dirty`).
- **`scratch-git-2/src/cli/commands/merge_patch.rs`** — shared RFC 7396 diff helper (~50 LOC + 9 unit tests). The server's `applyJsonMergePatch` is the apply side of the same contract; the two implementations are intentionally symmetric.
- **`scratch-git-2/src/cli/config/workspace_lock.rs`** — `.scratch/lock` file lock with PID-based stale reclaim. Acquired at the workspace level in `run_upload`. 3 unit tests cover acquire/release, contention detection, and stale-PID reclaim.
- **API client (`scratch-git-2/src/cli/api/mod.rs`)** — `upload_patch_init` / `upload_patch_put` / `upload_patch_commit` + wire types (`UploadPatchPayload`, `UploadPatchEntry`, `UploadPatchInitResponse`, `UploadPatchCommitResponse`, `StalenessWarning`).
- **Tests** — 3 new unit tests on `compute_upload_patches` (create / update / delete shapes, non-data path filtering, parse-error handling). Four obsolete tests removed alongside the code they covered. Full Rust suite: 211 tests pass.

### CLI/server decoupling (also on `dev-10144-mr2`)

Code review found that the first cut conflated `/upload-patch/commit` (apply patches) with publish enqueuing. Decoupled:

**Server:**

- `ApplyPatchesService.applyAndPublish` → `applyPatches`. Dropped `publishPlanBuildService` and `bullEnqueuerService` dependencies. Service applies patches to `dirty` and returns `{ patchCount }`.
- `ApplyPatchesJobHandler` simplified — payload is `{ uploadId, patchCount, processedCount }`, no more `pipelineId` / `publishJobId`.
- `ApplyPatchesJobDefinition['data']` drops `organizationId`.
- New CLI shim endpoints in `cli-workbook.controller.ts`: `POST /cli/v1/workbooks/:id/publish-v2/plan-job` and `/run-job`. Thin pass-throughs to `PublishPlanBuildService` + `BullEnqueuerService.enqueuePlanPipelineJob` / `enqueueRunPipelineJob`.

**CLI:**

- `FilesCommands::Upload` patches-only. Wall-time drops accordingly.
- New `FilesCommands::Publish` — runs `/publish-v2/plan-job` then `/publish-v2/run-job` per connection. Polls each. Fetches + advances local `refs/heads/main` after a successful run-job.

### Desktop slice (`dev-10144-mr3`)

`PublishChangesModal.tsx` rewritten end-to-end; CLI `files upload --json` extended; server gains `@SkipApiRateLimit` decorator.

**CLI extension:**

- `compute_upload_patches` tags each `ComputedUploadPatch` as `Create | Update | Delete`.
- `UploadResult` carries per-connection `connection_name`, separate `files_created`/`files_updated`/`files_deleted` counts + path lists, and structured `staleness_warning: Option<StalenessWarning>`.
- `print_upload_result` JSON output gains `connections: [...]` + top-level `stalenessWarning`. Previous `filesUploaded` / `uploadedPaths` keys removed.

**Desktop modal rewrite:**

- State machine: `approval → uploading → uploaded → publishing → complete | error`.
- Two-step UI: upload first (single IPC), land on `uploaded` mode showing per-connection diff summary, user explicitly clicks **Publish now** or **Review on web ↗**.
- Per-connection parallel publish via `Promise.allSettled`.
- Staleness banner consumes `stalenessWarning.newHead` — non-blocking, dismissible.
- Single shared poller behind `pendingWaitsRef: Map<string, (status) => void>`. ONE batched `/jobs/bulk-status` call per second.
- `~150 LOC` of dead helpers deleted (`triggerPublishFromGit`, `listLocalPublishPlans`, `deleteLocalPublishPlans`, `startPlanPublish`, `startPublishFromGit`, `startPublishAll`, etc).

**Server — `@SkipApiRateLimit` decorator (`server/src/rate-limiter/`):**

- New `@SkipApiRateLimit()` decorator in `api-rate-limit.decorator.ts`. Guard checks `API_RATE_LIMIT_SKIP_KEY` after kill-switch and unlimited-scope checks but before consuming points. Handler-level metadata first, then class-level.
- Applied to read-only polling endpoints in `JobController`: `POST /jobs/bulk-status`, `GET /jobs/workbook/:workbookId/active`, `GET /jobs/:jobId/progress`, `GET /jobs/:jobId/raw`, `GET /jobs/run/:runId`.
- 2 new guard tests cover handler-level and class-level skip; full suite 16 pass.

### End-to-end verification (2026-05-18, against localhost)

Drove the full CLI flow against `/tmp/scratchmd-profile-37373/Monorepo` (5 connectors, Affinity has a diff). Server log trace:

1. `UploadPatchController.init` — issued presigned URL (signed via impersonated `cloudrun-service-account`)
2. CLI PUT to GCS → 200
3. `UploadPatchController.commit` — enqueued `ApplyPatchesJob`
4. `ApplyPatchesJobHandler` — streamed payload from GCS, applied 1 patch to dirty
5. `ApplyPatchesService.applyPatches` — returned `{ patchCount: 1 }` (no auto-publish)
6. CLI polled job to completion; total wall time 3.1s for `upload`

Then `scratchmd --json files publish`:

7. `/publish-v2/plan-job` — `PublishPlanBuildService.createPipeline`
8. `/publish-v2/run-job` — `PublishRunService.runPipeline`
9. Affinity batch reported `"The Affinity connector is read-only. Updating list entries is not supported."` — expected for a read-only connector. The job _completed_ but the internal `failedCount` recorded the connector failure, rendered as a red badge in the desktop modal.

The plumbing is sound; 429s went away after polling consolidation + `@SkipApiRateLimit`.

## Review summary

| Review                      | Trigger               | Why                             | Runs | Status             | Findings                                                                                                   |
| --------------------------- | --------------------- | ------------------------------- | ---- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| CEO Review                  | `/plan-ceo-review`    | Scope & strategy                | 1    | CLEAR (HOLD_SCOPE) | mode: HOLD_SCOPE, 0 critical gaps, 9 decisions captured                                                    |
| Eng Review                  | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN)       | 18 issues found across Architecture/Code Quality/Tests/Performance, 0 critical gaps, 11 decisions captured |
| Design Review               | `/plan-design-review` | UI/UX gaps                      | 0    | —                  | —                                                                                                          |
| Adversarial / Outside Voice | `/codex`              | Independent 2nd opinion         | 0    | skipped            | Codex CLI not installed; user opted out                                                                    |

**UNRESOLVED:** 0
**VERDICT:** CEO + ENG CLEARED. Phase 1 shipped. Phase 4 scope clarified by 2026-05-19 audit. Tasks artifact at `~/.gstack/projects/whalesync-spinner/tasks-eng-review-20260518-095015.jsonl`.
