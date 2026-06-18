# Publish one record (DEV-10413)

**Linear:** [DEV-10413 — Publish one record is blocked](https://linear.app/whalesync/issue/DEV-10413/publish-one-record-is-blocked)
**Author:** Curtis Fonger
**Status:** In Review (implementation not started)
**Surface:** Scratch Desktop (`/scratch-desktop`) + `scratchmd` CLI (`/scratch-git-2`). **No server changes.**

> Reviewed via `/plan-eng-review` (2026-06-18): 4 architecture + 3 code-quality findings, test coverage diagram + 3 mandatory regression tests, 0 performance findings, independent outside-voice pass (2 cross-model tensions resolved). See `## GSTACK REVIEW REPORT` at the end.

---

## Problem

Clicking **Publish** on a single record in the desktop app pops a workspace-wide modal that refuses to proceed:

> **249 records contain unreviewed local edits.** Publishing is blocked until you decide what to do with these edits.

The user wanted to publish one already-reviewed record; instead they're asked to accept/discard 249 *other* records' edits. Expected behavior (from the ticket): **the single record publishes, leaving everything else untouched.**

### Root cause

The per-record Publish button's `onClick` calls `onPublishFile(currentRecordCliPath)` (`RecordDetailView.tsx:1091`), but the workspace handler `onPublishFile` (`WorkspacePage.tsx:727-732`) **takes no argument** — it ignores the path entirely and just opens the workspace-wide `PublishChangesModal`:

```ts
onPublishFile={() => {
  // Single-file publish was removed with the upload-patch rewrite —
  // the new flow always uploads everything the user has accepted.
  setPublishModalOpen(true); // ← no param; the record path never arrives here
}}
```

So the record path is dropped at the workspace boundary; threading it through (and deriving `connectionId` / `relPath` / `folderPath` / `filename`) is **net-new plumbing** in step E, not just "stop ignoring an arg that's already arriving."

That modal then runs `listUnreviewedChanges(localPath)` over the **entire workspace** (`PublishChangesModal.tsx:682`), the CLI's `files unreviewed` aggregates across every connection (`files.rs:run_unreviewed`), and because the count is > 0 the modal switches to the blocking `approval` mode. The button only appears for a record that is already reviewed + approved and is an **update** (`hasPublishableChanges && !hasUnreviewedChanges && !isDeleted && !isCreated`, `RecordDetailView.tsx:1072-1077`), so the guard is firing on *unrelated* records.

---

## How the architecture actually works (context for the fix)

| State         | Where it lives                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| **published** | `refs/heads/main` blob in the connection's bare repo (server + local mirror)         |
| **approved**  | Entry in `<workspace>/.scratch/connections/<conn>/accepted-patches.json` (RFC 7396)  |
| **local**     | The record file on disk                                                              |

- The server's per-connection **`dirty` branch** is the real publish staging area. Publish builds a plan by diffing `dirty` vs `main` and ships that diff to the SaaS app.
- Desktop `files upload` ships `accepted-patches.json` **verbatim** to `dirty` (it **accumulates** onto whatever is already there — verified at `apply-patches.service.ts:73-103`; it does not rebuild `dirty` from `main`).
- The publish plan builder already supports scoping the diff to one `filePath` (`publish-plan-build.service.ts:319-325`), and `hasDiffs` applies the identical filter (`:207-208`), so a scoped plan and its pre-check agree (no spurious `plan-no-diff`).

### Scratch Web already publishes one record from a busy `dirty` — by scoping the *plan*

Web has no local staging and no upload step: every save commits straight to `dirty` (`files.service.updateFileByPathGit` → `scratch-git.service.commitFile` → branch `'dirty'`). "Publish this one file" is purely a `filePath` filter on the plan (`ReviewFileViewer.handlePublish` → `publish.viaWorkbookRoute.planJob(..., filePath)`). After the run, `rebase_dirty` drops the published record from `dirty` and re-applies every *other* pending edit, so the web's busy `dirty` stays staged. The DEV-10316 dirty-gate (`refuseIfDirty` / `expectedBaseDirtyHead`) is desktop-upload-only and never enters the web publish path.

**Decision: the desktop mirrors the web.** Publishing one record from a busy `dirty` is the proven, supported model; there is no "clean dirty" precondition.

### Two distinct over-publish guards (don't conflate them — outside-voice #2)

The desktop model differs from the web in one important way: **in v1 the desktop scoped upload ships only the one record's patch to `dirty`.** The other 248 approved records live *only* in local `accepted-patches.json` and are **never uploaded**. That means two separate things protect against over-publishing, for two different scenarios:

1. **Scoped upload** keeps the desktop's *own* other approved records off `dirty` entirely — so they can't be in any plan, scoped or not.
2. **`filePath` plan scope** protects against changes that are *already* on `dirty` from another source (web sync, or a prior interrupted "Publish all" upload) — there, `dirty` is genuinely busy and the filter is load-bearing.

So the plan scope is **not** mere belt-and-suspenders; it's the real guard whenever `dirty` is busy from another source. And because the desktop only uploaded the one record, after publish `rebase_dirty` fast-forwards `dirty` clean — there is nothing else of *ours* staged to "leave behind" (the web's "leaves others staged" wording does not apply to the desktop one-record upload).

### Load-bearing invariant (outside-voice #3/#4)

**A scoped single-record publish is expected to advance `main` for exactly one path.** The post-publish local reconcile (below) leans on this: the other 248 records' blobs are byte-identical in old-vs-new `main`, so they neither mis-anchor nor surface phantom "unreviewed" diffs. The publish pipeline's **backfill phase** can break this by writing FK fields onto *other* records — but backfill is FK resolution for newly-created referenced rows, and the single-record button is **update-only** (`!isCreated && !isDeleted`), so an update-only publish is very unlikely to trigger it. **Backfill-induced multi-path publish is a known, untested v1 limitation** (see Out of scope).

### Why the server needs no changes (verified)

- The **CLI** plan-job controller (`server/src/cli/cli-workbook.controller.ts:455-481`) already reads `body.filePath` / `body.folderPath` and threads them into `hasDiffs` + `enqueuePlanPipelineJob` → the same scoped `buildPipeline` the web uses.
- `/upload-patch/commit` already supports `refuseIfDirty: false` (the dirty gate at `upload-patch.controller.ts:157-210` is entirely behind `refuseIfDirty === true`; no other gate fires) and already accumulates onto `dirty`.

The only reason desktop can't do it today is that the client resource `publish-via-cli-route.ts#planJob` doesn't expose a `filePath` param to pass.

---

## Decided scope

1. **v1 = exactly one record** (update-only, per the button condition). The CLI takes a path, so "publish selected (N)" is a later filter, not a rewrite.
2. **Reuse `PublishChangesModal` with a `singleRecord` mode** (reuse the plan/run/poll/progress infra; branch the pre-flight and the post-publish reconcile). No separate component. The branched bits live in small **named helpers** in the file, not scattered inline `if (singleRecord)` guards.
3. **Validation gate scoped to that one record** — still refuse to publish a record with validation errors, using the existing per-record validation API.

---

## Design: three scoped steps, mirroring the web

For the clicked record we resolve **`connectionId`** + **connection-relative path** (`relPath`) from its workspace-relative CLI path (`<conn-dir>/Folder/rec.json` → first segment = connection dir → `connectionId` via `workspaceConfig`; remainder = `relPath`).

```
 click Publish on record X (update, already reviewed+approved)
        │
        ▼
 ┌──────────────────────── scoped upload (CLI: files upload --file-path) ───────────┐
 │ filter accepted-patches.json → just X's patch (in-memory, no temp file)          │
 │ refuse_if_dirty = false  (mirror web; keep refuse_if_stale)                       │
 │ → dirty now has X staged (accumulated onto whatever else is there)               │
 └──────────────────────────────────────────────────────────────────────────────────┘
        │  UploadResult (one connection)
        ▼
 ┌──────────────────────── scoped plan + run (planJob filePath = relPath) ──────────┐
 │ server buildPipeline diffs dirty↔main, filters to X → publishes only X            │
 │ expectedBaseDirtyHead = null  (mirror web; the filePath filter is the guard)      │
 │ server advances main for X, rebase_dirty                                          │
 └──────────────────────────────────────────────────────────────────────────────────┘
        │  run-job terminal
        ▼
 ┌──────────────────────── scoped reconcile (CLI: files reconcile-published) ───────┐
 │ fetch_origin; re-anchor ONLY X's patch vs new main → drop X from accepted-patches │
 │ SURGICAL single-file write of X only (NOT materialize_local_repo)                 │
 │ only if X's worktree still == approved (else preserve a mid-flight edit)          │
 │ reindex X's folder; leave the other 248 patches + 249 unreviewed files untouched  │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

The scoped reconcile replaces the global post-publish `files download`, which **refuses on unreviewed edits** and so can't run while the 249 unreviewed records exist.

---

## Implementation

### A. CLI (`scratch-git-2/src/cli/commands/files.rs`)

#### A0. Shared `resolve_connection_and_relpath(path)` helper (code-quality finding D7)

Both new CLI paths take a workspace-relative path, find the owning connection by matching the first segment against `ctx.conn_dir_name`, and compute the connection-relative remainder. **One helper**, used by both A1 and A2, with one error case ("no connection matches first segment"). Tests: valid nested path, trailing slash, no-match error.

#### A1. `files upload --file-path <workspace-relative-path>` (scoped upload)

- Add `file_path: Option<String>` to the `FilesCommands::Upload` variant (`files.rs:166`) and to `run_upload` (`files.rs:870`, dispatch at `:516`).
- When `Some(path)`:
  - `resolve_connection_and_relpath(path)` (A0) → the single owning connection + connection-relative remainder.
  - **Skip the two-pass dirty-gate probe** (`files.rs:906-932`) entirely — mirror the web (no `refuseIfDirty`).
  - Filter that connection's `accepted-patches.json` payload to the one remainder path (in-memory; **no temp file**). Error if the path has no accepted patch entry.
  - Thread `refuse_if_dirty: false` (keep `refuse_if_stale: true` — staleness is orthogonal) into `upload_single_repo_via_patches` (currently hardcodes `true` at `files.rs:4710`). Add a `scope: Option<ScopedUpload>` param carrying the filtered path + the relaxed dirty flag, so the full-upload signature/behavior is untouched.
  - Return the same `UploadResult` shape for that one connection so the modal's plan/run machinery is unchanged.
- When `None`: unchanged (full workspace upload, two-pass gate, `refuse_if_dirty: true`).

#### A2. `files reconcile-published --file-path <workspace-relative-path>` (scoped reconcile)

New subcommand. **Surgical single-file write — does NOT call `materialize_local_repo`** (cross-model tension 1; `materialize_local_repo` at `files.rs:5254-5266` deletes every worktree path absent from `target_map`, so a one-entry target map would wipe the other 248 files, and a full-connection target map would clobber the 249 unreviewed files). Instead:

- `resolve_connection_and_relpath(path)` (A0).
- `fetch_origin` (whole-repo fetch is unavoidable; cheap).
- **Re-anchor ONLY this record's patch** against the new `origin/main` (the shared path-filtered *re-anchor* helper from D6 — see A4). If X's value now equals new `main` (published) → drop **only** X's entry from `accepted-patches.json`. If — due to a partial/failed publish — X didn't actually publish, the patch survives re-anchored (correct; idempotent retry will finish it). Leave the other 248 entries untouched.
- **Mid-flight-edit guard (D4):** re-materialize X's worktree file to the post-publish value **only if the worktree still equals the approved value.** If the user edited X during the publish window (worktree ≠ approved), **leave the worktree alone** — the edit naturally re-appears as a fresh unreviewed change against the new published `main`. Never delete-by-absence; touch only X's file.
- Advance local `main` to `origin/main` (ref move only; does not rewrite working files). Safe per the load-bearing invariant (publish touched exactly X's path).
- Reindex only X's folder.
- Append any re-anchor conflict to `conflicts.log` (same as the existing reconcile).

> Naming alternative considered: `files download --file-path`. Rejected — `files download` carries the workspace-wide unreviewed refusal and whole-worktree replay machinery (the exact delete-by-absence / clobber-unreviewed trap above).

#### A4. Share the re-anchor core (code-quality finding D6)

`reconcile_accepted_after_publish` (`files.rs:4341`) carries subtle logic (PK-stripping on revived deletes, conflict-log append, re-anchor). Extract the **re-anchor** core into a path-filtered helper that both the full reconcile (passes "all paths") and the scoped reconcile (passes one path) call. **Do NOT share the materialize step** — the full reconcile materializes the whole worktree (delete-by-absence, gated on no-unreviewed); the scoped reconcile does a surgical single-file write (tension 1). Sharing the materialize is what creates the foot-gun.

#### A5. Tests (Rust — see coverage diagram)

Covered in the Test plan section below, including the **R1/R2 regression tests** (full upload + full reconcile unchanged).

### B. Desktop main + preload (`scratch-desktop/src/main`, `src/preload`)

- **`scratchmd.ts`**: add `filePath` arg to the upload wrapper (`uploadWorkspaceChanges` → pass `--file-path`), keeping the existing refusal-payload parsing. Add a `reconcilePublishedRecord(workspacePath, filePath)` wrapper for `files reconcile-published`.
- **`index.ts`**: extend the `scratch:upload-workspace-changes` handler to accept an optional `filePath`; add a `scratch:reconcile-published-record` handler (wrap in `withWorkspaceInternalMutation`).
- **`preload/index.ts` + `index.d.ts`**: expose the optional `filePath` on `uploadWorkspaceChanges` and the new `reconcilePublishedRecord`.

### C. Desktop client API (`packages/shared-types`)

- **`publish-via-cli-route.ts#planJob`**: add `filePath` via an **options object**, not a 4th positional after the nullable `expectedBaseDirtyHead?` (outside-voice #6 — a positional `filePath` there is a classic mis-wire site). e.g. `planJob(workbookId, connectorAccountId, { expectedBaseDirtyHead?, filePath? })`, updating the one existing caller (`PublishChangesModal.tsx:929`). The server CLI controller already consumes `body.filePath` — **no server change**. (`PublishPlanBuildDto` already carries `filePath`.)

### D. Desktop renderer — `PublishChangesModal` `singleRecord` mode

Add a prop:

```ts
singleRecord?: {
  filePath: string;     // workspace-relative, for the CLI (upload + reconcile)
  relPath: string;      // connection-relative, for planJob filePath (normalized — see D-path)
  connectionId: string;
  folderPath: string;   // for the scoped validation check
  filename: string;
};
```

**D-path-format (architecture finding D2):** `relPath` must exactly match `getRepoStatus`'s format (connection-relative, no leading slash). Build it through **one normalization helper** ([[path-column-slash-convention]] is the landmine: a mismatch silently matches nothing → `plan-no-diff` → false "success"). In singleRecord mode, treat a `plan-no-diff` as a **surfaced** state, not silent success (see D-idempotent for the disambiguation).

**singleRecord state machine (architecture finding D5).** Reachable modes only; `dirty` / `checkFailed` / `blockedDirtyDrift` are **unreachable** (no dirty-gate, and we send `expectedBaseDirtyHead = null` — mirror web; this also resolves the review comment about `runConnectionPublish` re-blocking via the DEV-10316 drift gate):

```
 open ─▶ loadInitialState
          └─ scoped validation (getValidationResults for X)
               ├─ X has errors ──▶ approval (scoped: "this record has validation errors")
               └─ clean ─────────▶ startUpload (scoped upload --file-path)
                                      ├─ blocked_stale ──▶ stale   (refuse_if_stale kept)
                                      └─ uploaded ───────▶ triggerPublish
 triggerPublish ─▶ runConnectionPublish(filePath = relPath, expectedBaseDirtyHead = null)
          ├─ plan-no-diff ─▶ scoped reconcile (CONVERGE, D-idempotent)
          │                    ├─ dropped X's patch ─▶ complete ("already published — cleaned up")
          │                    └─ patch survived ────▶ warning ("nothing to publish for this record")
          ├─ plan ok ─▶ run ─┬─ success ─▶ scoped reconcile ─▶ complete
          │                  └─ fail ────▶ error
          └─ (dirty / checkFailed / blockedDirtyDrift: UNREACHABLE)
```

Branch the flow (each branch is a **named helper**, not an inline guard — code-quality finding D8):

- **`loadInitialState`**: skip `listUnreviewedChanges(localPath)` (the record is already reviewed). Run the **scoped** validation via `getValidationResults(workspacePath, folderPath, filename)` (`RecordDetailView.tsx:405`); errors → scoped approval block; clean → `startUpload`.
- **`startUpload`**: scoped upload (`uploadWorkspaceChanges(localPath, { filePath })`). Keep `blocked_stale` handling; `blocked_dirty` / `check_failed` are unreachable.
- **`runConnectionPublish`**: pass `{ filePath: relPath, expectedBaseDirtyHead: null }`. Single connection participates.
- **D-idempotent (architecture finding D3):** on `plan-no-diff` in singleRecord mode, run the scoped reconcile to **converge** local state; if it drops X's patch (server `main` already has X) report "already published — cleaned up"; only if the patch genuinely survives show the D2 "nothing to publish for this record" warning. Makes a mid-flight-crash retry safe and disambiguates the two `plan-no-diff` meanings. The reconcile is retryable.
- **Post-publish** (`PublishChangesModal.tsx:1189-1200`): in singleRecord mode call `reconcilePublishedRecord(localPath, filePath)` instead of the global `pullWorkspaceChanges`. Then `invalidateWorkspaceLevelData()`.
- **Copy**: "Publish 1 record" framing; reuse the existing `uploaded` / `publishing` / `complete` states.

### E. Wire the entry point — `WorkspacePage.tsx`

- Replace the no-op `onPublishFile` (`:727-732`) with handling that **resolves** `connectionId` + `relPath` (normalized, D-path-format) + `folderPath` + `filename` from the clicked record's CLI path (split first segment via A0's mirror, map via `workspaceConfig`), stores it in a `singleRecordPublish` state, and opens the **same** `PublishChangesModal` instance in `singleRecord` mode. `onPublishAll` stays workspace-wide (**regression R3**). Clear `singleRecordPublish` on close.
- `RecordDetailView.tsx:1091` already passes `currentRecordCliPath`; the prop threads through `WorkspaceContent` / `FolderDataGrid` (the `onPublishFile` signature changes from `() => void` to `(cliPath: string) => void`).

### F. Analytics

Add a `track*` for single-record publish (per `scratch-desktop/CLAUDE.md` PostHog rules), e.g. `trackPublishSingleRecord(workspaceId, connectionId)`.

---

## What already exists (reuse, not rebuild)

| Sub-problem | Existing code reused |
| ----------- | -------------------- |
| Scope a publish plan to one record | `buildPipeline` + `hasDiffs` filePath filter (`publish-plan-build.service.ts:207-208,319-325`) — already wired on the CLI route (`cli-workbook.controller.ts:455-481`) |
| Stage one record without a clean-dirty gate | `/upload-patch/commit` accumulate + `refuseIfDirty:false` (`apply-patches.service.ts:73-103`, `upload-patch.controller.ts:157-210`) |
| Per-record validation | `getValidationResults(workspacePath, folderPath, filename)` (`RecordDetailView.tsx:405`) |
| Plan/run/poll/progress UI | `PublishChangesModal` `runConnectionPublish` + the consolidated poller |
| Re-anchor accepted patches after publish | `reconcile_accepted_after_publish` re-anchor core (`files.rs:4341`) — factored + path-filtered (D6), materialize NOT shared |
| Post-publish staging of other changes | server `rebase_dirty` (`rebase.rs`) |

---

## Edge cases & failure modes

| Scenario | Behavior | Test / handling |
| -------- | -------- | --------------- |
| `dirty` busy from web sync / prior full upload | scoped upload accumulates X; scoped plan publishes only X; `rebase_dirty` keeps the rest. No block. | unit (busy dirty) |
| `dirty` independently changed *this same* record (web sync touched X) | accumulate applies the desktop's approved patch on top of `dirty`'s X. Accepted for v1 (mirror web). Per-record drift check out of scope. | documented |
| Record edited **mid-publish** (worktree ≠ approved by reconcile time) | reconcile preserves the edit (D4) — re-materializes X only if worktree still == approved; otherwise leaves it, edit re-appears unreviewed. **Silent data loss if unhandled.** | unit "edit during publish" |
| Crash **between** run-success and reconcile | X is live but UI shows "unpublished"; retry converges via D-idempotent `plan-no-diff` → reconcile drops X. | unit "already published → cleaned up" |
| Publish fails mid-run | `accepted-patches.json` untouched (no reconcile on failure); X stays approved + re-publishable. No temp-file state. | covered by run-fail path |
| Path-format mismatch (`relPath` ≠ repo-status) | would silently `plan-no-diff`; D2 surfaces it as a warning instead of false success. | path round-trip unit |
| Stale local `main` (`blocked_stale`) | existing stale path; user refreshes + retries. | existing |
| Backfill advances `main` for other records | **untested v1 limitation** — could surface phantom "unreviewed" diffs on unrelated records. Mitigated by update-only button. | documented (Out of scope) |

**Critical-gap check:** the only failure mode that would be both silent *and* destructive — the mid-flight edit clobber — is closed by D4 + its test. No remaining silent-destructive gap.

---

## Out of scope (v1)

- **Multi-record / "publish selected (N)"** — the CLI takes a path; N is a later filter, not a rewrite.
- **Per-record dirty-drift gate** for the single-record path — we mirror the web (no drift gate).
- **Backfill-induced multi-path publish** — if a single-record publish advances `main` for more than that record (FK backfill), unrelated records may show phantom unreviewed diffs. Update-only button makes this unlikely; explicitly untested.
- **Automated desktop E2E** (Electron→CLI→server→connector) — covered by layered Rust integration + renderer unit + a documented manual QA repro for v1.
- **Any change to the workspace-wide "Publish all" flow** — guarded by regressions R1/R2/R3.
- **Server changes** — none needed.

---

## Test plan

Frameworks: Rust `cargo test` (`scratch-git-2`); renderer `vitest`.

```
CLI (Rust — files.rs)                                            TYPE
[+] resolve_connection_and_relpath() (A0)
  └── valid nested path; trailing slash; no-match error          unit
[+] files upload --file-path (scoped upload, A1)
  ├── happy: ships only X's patch; others remain                 unit
  ├── dirty already dirty → NOT blocked (refuse_if_dirty=false)   unit
  ├── path has no accepted patch → clear error                   unit
  ├── stale local main → blocked_stale (refuse_if_stale kept)    unit
  └── [REGRESSION R1] full upload (no --file-path) UNCHANGED:     unit  ★ IRON RULE
        two-pass gate + full payload + refuse_if_dirty=true
[+] files reconcile-published --file-path (scoped reconcile, A2)
  ├── happy: drops X's patch; X worktree=published; SIBLING       unit  (fixture MUST have
  │      files on disk + 249 unreviewed files ALL untouched              sibling + unreviewed
  │      (guards the materialize_local_repo delete-by-absence trap)      files on disk)
  ├── mid-flight edit: worktree≠approved → PRESERVE edit (D4)     unit
  ├── already-published: server main has X → patch drops         unit
  └── re-anchor conflict → appended to conflicts.log             unit
[+] shared re-anchor helper (A4/D6)
  └── [REGRESSION R2] full reconcile_accepted_after_publish       unit  ★ IRON RULE
        UNCHANGED after extraction (drops all, materializes, logs)

DESKTOP (renderer — vitest)
[+] planJob({ filePath }) resource (C)
  └── body includes filePath when passed                          unit
[+] PublishChangesModal singleRecord mode (D)
  ├── scoped validation passes → upload→plan→run→reconcile→complete unit
  ├── record has validation error → scoped block (not workspace)   unit
  ├── plan-no-diff → reconcile → "already published — cleaned up"(D3) unit
  ├── plan-no-diff, patch survives → "nothing to publish" warn (D2)   unit
  └── stale → stale mode reachable; dirty/checkFailed UNREACHABLE     unit
[+] relPath ↔ getRepoStatus path-format round-trip (D2)            unit
[+] WorkspacePage.onPublishFile resolves connectionId+relPath+folder+name  unit
  └── [REGRESSION R3] onPublishAll still opens workspace-wide modal unit  ★ IRON RULE

MANUAL QA (documented; full E2E deferred)
  └── Repro: 249 unreviewed + 1 approved update → publish the 1 →
        others untouched locally AND on dirty (renderer→CLI→server→connector)

Gate: yarn lint / yarn build (root); cargo fmt / cargo test (scratch-git-2);
      yarn lint-strict in server/ if any server file is touched (it isn't expected to be).
```

**Mandatory regressions (IRON RULE — no decision):** R1 (full upload unchanged), R2 (full reconcile unchanged), R3 (`onPublishAll` still workspace-wide). The A2 happy-path fixture **must** include sibling record files and unreviewed files on disk, or it won't catch the delete-by-absence / clobber-unreviewed trap.

---

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
| ---- | --------------- | ---------- |
| CLI (A0–A5) | `scratch-git-2/src/cli` | — |
| Client API (C) | `packages/shared-types` | — |
| Desktop main/preload (B) | `scratch-desktop/src/main`, `src/preload` | A (CLI flags exist) |
| Renderer modal + wiring (D, E, F) | `scratch-desktop/src/renderer` | B, C |

- **Lane A:** CLI (A0–A5) — independent, the critical path. Heaviest + riskiest (the reconcile foot-gun); do first.
- **Lane B:** Client API (C) — independent, tiny; can run in parallel with Lane A.
- **Lane C (sequential after A+B):** desktop main/preload (B) → renderer (D/E/F).

Launch Lane A and Lane B in parallel worktrees. Merge both, then do Lane C. No two parallel lanes share a module directory → no conflict flags.

---

## Implementation Tasks
Synthesized from this review. Each derives from a specific finding. P1 blocks ship; P2 lands same branch; P3 is follow-up.

- [ ] **T1 (P1, human: ~3h / CC: ~25min)** — CLI — `resolve_connection_and_relpath` helper + `files upload --file-path` (scoped, `refuse_if_dirty:false`, in-memory filtered payload)
  - Surfaced by: scope, D7, D2 (path), A1
  - Files: `scratch-git-2/src/cli/commands/files.rs`
  - Verify: `cargo test` scoped-upload cases + **R1** full-upload-unchanged
- [ ] **T2 (P1, human: ~4h / CC: ~35min)** — CLI — `files reconcile-published` as a **surgical single-file write** (never `materialize_local_repo`); D4 mid-flight-edit guard; D6 shared re-anchor core (materialize NOT shared)
  - Surfaced by: tension 1, D4, D6, A2, A4
  - Files: `scratch-git-2/src/cli/commands/files.rs`
  - Verify: `cargo test` reconcile cases (fixture WITH siblings + unreviewed files) + **R2** full-reconcile-unchanged
- [ ] **T3 (P2, human: ~30min / CC: ~5min)** — Client API — `planJob` filePath via options object (not positional)
  - Surfaced by: outside-voice #6, C
  - Files: `packages/shared-types/src/api-client/resources/publish-via-cli-route.ts`
  - Verify: vitest body-includes-filePath
- [ ] **T4 (P1, human: ~2h / CC: ~20min)** — Desktop main/preload — scoped upload `filePath` arg + `reconcilePublishedRecord` IPC + wrappers
  - Surfaced by: B
  - Files: `scratch-desktop/src/main/scratchmd.ts`, `src/main/index.ts`, `src/preload/index.ts`, `index.d.ts`
  - Verify: IPC smoke + build
- [ ] **T5 (P1, human: ~5h / CC: ~45min)** — Renderer — `singleRecord` mode (named helpers): scoped validation, scoped upload, `expectedBaseDirtyHead:null`, D3 idempotent `plan-no-diff` convergence, D2 surfaced warning, scoped reconcile post-publish, state machine
  - Surfaced by: D2, D3, D5, D8, comment 2
  - Files: `scratch-desktop/.../PublishChangesModal.tsx`
  - Verify: vitest singleRecord cases
- [ ] **T6 (P1, human: ~2h / CC: ~20min)** — Renderer — wire `onPublishFile(cliPath)` → resolve+normalize → open modal in singleRecord mode; analytics
  - Surfaced by: D2 (path), E, F, outside-voice #5
  - Files: `scratch-desktop/.../WorkspacePage.tsx`, `WorkspaceContent`/`FolderDataGrid` prop, `posthog.ts`
  - Verify: vitest resolve + **R3** onPublishAll-unchanged
- [ ] **T7 (P3, human: ~30min / CC: ~10min)** — Docs — `BRANCHING_MODEL.md` / `REVIEW_MODEL.md`: scoped upload + `reconcile-published` + the two over-publish guards
  - Surfaced by: outside-voice #2, scope
  - Files: `scratch-git-2/docs/BRANCHING_MODEL.md`, `REVIEW_MODEL.md`

---

## File-by-file change list

| File | Change |
| ---- | ------ |
| `scratch-git-2/src/cli/commands/files.rs` | `resolve_connection_and_relpath` helper; `--file-path` on `Upload`; scoped `run_upload` (skip gate, filter payload, `refuse_if_dirty:false`); new `reconcile-published` (surgical single-file write, D4 guard); extract shared re-anchor core (materialize NOT shared) |
| `scratch-git-2/src/cli/commands/files.rs` (tests) | scoped upload + scoped reconcile (siblings+unreviewed fixture) + R1 + R2 |
| `scratch-desktop/src/main/scratchmd.ts` | `filePath` on upload wrapper; `reconcilePublishedRecord` wrapper |
| `scratch-desktop/src/main/index.ts` | optional `filePath` on upload handler; new reconcile handler |
| `scratch-desktop/src/preload/index.ts`, `index.d.ts` | expose optional `filePath` + reconcile |
| `packages/shared-types/src/api-client/resources/publish-via-cli-route.ts` | `planJob` filePath via options object |
| `scratch-desktop/.../PublishChangesModal.tsx` | `singleRecord` prop + named-helper branches (validation/upload/plan/reconcile/idempotent/state machine) |
| `scratch-desktop/src/renderer/src/pages/WorkspacePage.tsx` | resolve+normalize record → `singleRecord`, open modal scoped; `onPublishFile` signature |
| `scratch-desktop/.../WorkspaceContent.tsx`, `FolderDataGrid.tsx` | thread the `(cliPath)` arg through `onPublishFile` |
| `scratch-desktop/src/renderer/src/lib/posthog.ts` | `trackPublishSingleRecord` |
| `scratch-git-2/docs/BRANCHING_MODEL.md` / `REVIEW_MODEL.md` | document scoped upload + `reconcile-published` + two over-publish guards |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (bug fix, scope is clear) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | Codex 401 → Claude subagent fallback; 6 findings, 2 tensions resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | **CLEAR** | 9 issues, 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (reuses existing modal; copy-only UI delta) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **OUTSIDE VOICE:** Codex was 401 Unauthorized (`codex login` needed) → independent Claude subagent. It **verified all four load-bearing claims** (server filePath scoping, upload accumulate, `refuse_if_dirty:false` ungated, single-connection upload-result shape) and surfaced 6 findings. The two substantive ones became cross-model tensions, both resolved into the plan.
- **CROSS-MODEL:** Tension 1 (reconcile worktree write) — review said "share a path-filtered reconcile helper", outside voice said "one-record `target_map` mass-deletes siblings"; resolved to a **surgical single-file write** (share re-anchor only, never `materialize_local_repo`), which also avoids clobbering the 249 unreviewed files. Tension 2 (backfill multi-path) — documented the "publish touches exactly one path" invariant, leaned on the update-only button, declared backfill out-of-scope/untested for v1.
- **FINDINGS FOLDED IN (no separate decision):** root-cause framing corrected (`onPublishFile` takes no arg today), `planJob` filePath via options object (not positional), over-publish-guard prose corrected (two distinct guards).
- **UNRESOLVED:** 0 — every AskUserQuestion answered.
- **VERDICT:** ENG CLEARED — ready to implement. CEO/Design review not required for this change. Run `/ship` when implementation is done.
