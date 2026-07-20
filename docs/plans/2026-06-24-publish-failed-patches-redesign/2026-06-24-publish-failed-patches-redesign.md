# Publish redesign — `dirty` as intent, `failed-patches.json` for what didn't land

- **Status:** In Progress
- **Author:** Curtis Fonger
- **Created:** 2026-06-24
- Linear: https://linear.app/whalesync/issue/DEV-10048 — **all work lands under DEV-10048; no
  sub-tickets.** The "ticket breakdown" below is the internal build order, not separate tickets.

## Summary

Rework how a publish reconciles the `dirty` and `main` branches. Today, after publish,
the server **re-applies every user edit back onto `dirty`** (`rebaseDirty`) and the client
**re-anchors `accepted-patches.json` against the new `main`**. Both paths assume "anything
that differs from `main` is still pending," which strands edits the publish pipeline will
never act on (e.g. removed keys → `computeChangedFields === {}` → DEV-10048).

The new model inverts the default: **`dirty` is the desired end-state we want live; after
publish we rebuild it from `main` and only carry forward what actually _failed_.** A
publish either lands a record (→ `main` absorbs the remote's returned record, edit
discarded) or fails it (→ the record's edit goes to `failed-patches.json`, routed back to
whoever published). Nothing un-publishable can accumulate as a phantom, so DEV-10048
disappears as a special case.

## Why (current pain)

- **DEV-10048 / no-op phantom.** `computeChangedFields` (`server/src/publish-plan/diff-utils.ts`)
  ignores removed keys by design; `json_patch::diff` (`scratch-git-2/src/shared/json_patch.rs`)
  emits `remove`. An edit whose only net change is a key removal is emitted with
  `changedFields: {}`, **skipped** at run-time (`publish-plan-run.service.ts:1087-1090`), so
  `main` never advances. `rebaseDirty` re-applies it onto `dirty` → permanent divergence;
  the desktop badge (from `accepted-patches.json`) and the web view + DEV-10316 dirty-gate
  (from blob-level `getRepoStatus` `dirty` vs `main`) keep showing it as unpublished forever.
- **Partial-failure handling is thin.** Today a failed record is tracked as
  `status: 'failed-batch'` with a connector error (`publish-plan-run.service.ts:~901`,
  surfaced as `PublishFailedOperation`), but the edit stays tangled in `dirty` and the
  user gets a count + a sampled message, not an actionable, per-field, re-reviewable state.

## The model (refined from the whiteboard diagram)

```
main (published)         dirty (what we want live)        publish plan (per-record diffs vs main)
  Bob                       Bobby  (First Name)              Bobby record: { First Name: Bobby, Organization: null }
  org: asdlkj…              null   (Organization)
        │                        │                                   │
        │                        │                                   ▼
        │                        │                          run plan, per record (atomic)
        │                        │                          ┌──────────────────────────────┐
        │                        │                          │ success → remote echoes record│→ main := returned record
        │                        │                          │ failure → whole record fails  │→ failed-patches.json
        │                        │                          └──────────────────────────────┘
        ▼                        ▼
  after publish:            after publish:
  main = remote truth       dirty rebuilt from main for the published paths;
  (side effects +           untouched paths left as-is.
   others' edits)           failed edits routed to publisher (see Routing).
```

### Per-record, atomic (decision)

The unit of publish is the **record**, not the field. A connector update is one API call
per record; if any field is rejected the **whole record fails** — `main` does not advance
for it and the record's _entire_ edit is captured as failed. We keep field-level error
_attribution_ where the connector gives it to us (so the UI can point at the offending
field), but success/failure is per-record.

> The whiteboard diagram showed one record with `First Name` succeeding while `Organization`
> failed. Under per-record atomicity that can't happen on a single call: the whole Bobby
> update fails, `main` stays `Bob`, and both fields come back in `failed-patches.json`. The
> "remote side-effect" half of the diagram (auto-capitalize, slug formula, `Last edited`,
> someone else's org change) is what happens to a record that **succeeds** — `main` absorbs
> the full record the connector returns.

### `main` absorbs the remote's returned record on success

Already half-built: `UPDATE_RECORDS_RETURNS_REMOTE_DATA` / `useRemoteReturnedRows`
(`publish-plan-run.service.ts:~1106`) commits the connector-returned row to `main` when the
connector echoes it back. This is the fidelity path (auto-caps, formulas, others' edits).
For connectors that don't return rows, `main` gets the sent payload (status quo). _Open
decision below: re-pull vs returned-rows as the canonical post-success state._

### Routing of failed edits (decision)

Failed edits go to whoever initiated the publish:

| Publish origin | Failed edits land… | Server `dirty` for failed paths |
| -------------- | ------------------ | ------------------------------- |
| **Web**        | re-applied onto the **web's `dirty` branch** (the web has no working tree; `dirty` _is_ its pending state) | kept (the re-applied failed edit) |
| **Desktop**    | streamed back in the job result, written to the desktop **working tree** as needs-approval edits; **not** kept on server `dirty` | reset to `main` |

So the run-job needs to know its **origin/client**, and `failed-patches` delivery is either
"applied to `dirty`" (web) or "returned for desktop download" (desktop).

### Scoped reconcile, never a blanket branch reset

"Rebuild `dirty` from `main`" is **per published path**, not per branch. `dirty` routinely
holds more than the current publish — a single-record publish (DEV-10413), a partial
approval, or a concurrent edit that landed between plan-build and plan-finish. The reconcile
must: for each record the plan acted on, drop it from `dirty` on success / re-apply (web) or
strip (desktop) on failure, and **leave every untouched record on `dirty` alone**. This is
the scoping `rebaseDirty` approximates today and must be made explicit.

### Keep DEV-10523 unreviewed-edit preservation

When the desktop rewrites its working tree to "new `main` + re-applied failed patches," it
must still carry forward the user's **unreviewed** edits (working-tree edits not yet
accepted, `local ≠ approved`) that weren't part of the publish — re-applying them user-wins
across the `main` advance, exactly as `files download` does today (DEV-10523), stashing only
the rare unappliable ones. The model changes the fate of _published_ and _failed_ edits;
this is orthogonal and stays.

## Data structures

### `failed-patches.json` (new) — per connection, sibling to `accepted-patches.json`

Same envelope shape as `accepted-patches.json`, plus error attribution **at the entry
level** (not on the RFC 6902 ops — bolting members onto `{op,path,value}` breaks
conformance):

```jsonc
{
  "version": 1,
  "patches": [
    {
      "path": "Contacts/bobby.json",
      "kind": "update",
      "patch": [ { "op": "add", "path": "/Organization", "value": null } ],
      "error": "Organization cannot be null",          // record-level connector message
      "fieldErrors": { "/Organization": "Organization cannot be null" }  // JSON Pointer → msg
    }
  ]
}
```

`fieldErrors` drives the per-field UI warning; `error` is the record-level fallback. The
connector already produces `ConnectorErrorDetails` (`extractConnectorErrorDetails`) — we
extend that to expose per-field messages where the service gives them (many do for
validation errors), else only the record-level `error` is populated.

## State transition for a failed edit

A failed edit demotes **approved → local (needs approval)**: it lands back in the working
tree (desktop) or `dirty` (web) and is shown as **needs-approval** with a per-field error
badge, so the user must look at it again before re-publishing — never silently re-queued.

## Implementation architecture (refined — falls out of the plumbing map)

Two simplifications over the first sketch:

1. **The client already holds the patches it uploaded**, so the server does **not** ship
   full patch bodies back. The job result keeps its existing `failedOperations` list
   (`{ filePath, phase, error }`), extended with `fieldErrors`. On reconcile the desktop
   **moves** each failed path's entry from `accepted-patches.json` → `failed-patches.json`
   (attaching the error) and **clears** the succeeded paths — no new patch payload on the wire.

2. **The scoped `dirty` reconcile is `rebaseDirty` with an exclude-set.** `rebaseDirty`
   already force-resets `dirty → main` and re-applies the user's edits (`compare(merge_base,
   dirty)`). Give it a set of **paths that should converge to `main`** and skip re-applying
   those. Then:
   - **success paths** → excluded → `dirty` lands on (advanced) `main`. ✅ converged
   - **desktop-origin failure paths** → excluded → `dirty` lands on `main` (failed edit
     stripped server-side; it travels to the desktop working tree via `failedOperations`). ✅
   - **web-origin failure paths** → *not* excluded → re-applied → stay on `dirty`. ✅ kept
   - **paths not in this plan** (concurrent / partial-scope edits) → *not* excluded →
     re-applied → preserved. ✅ (this is the Q3 scoping, for free)

   So `excludePaths = successPaths ∪ (origin === 'desktop' ? failedPaths : ∅)`. Existing
   `rebaseDirty` callers pass an empty set (behavior unchanged).

## Component changes

### Server (`server/src/publish-plan/`)
- **Run** (`publish-plan-run.service.ts`): per-record success → `main := returned/sent
  record`; per-record failure → emit a `failed-patches` entry with `error`/`fieldErrors`.
  Replace the `rebaseDirty`-re-applies-everything step with a **scoped reconcile** over the
  published path set (drop-on-success; route-on-failure by origin). The no-op skip at
  `:1087-1090` is no longer load-bearing for correctness once `dirty` is rebuilt from `main`.
- **Origin plumbing**: thread a `publishOrigin: 'web' | 'desktop'` through
  controller → enqueue → job → run.
- **Connector errors**: extend `extractConnectorErrorDetails` to surface per-field messages.

### scratch-git (`rebase.rs`, write routes)
- `rebaseDirty` either gains a scoped "reconcile these paths to main / re-apply these failed
  patches" contract, or is replaced by an explicit per-path reconcile driven by the run
  service. Generic git plumbing must not learn `computeChangedFields` semantics — the run
  service decides which paths reconcile and passes them in.

### Rust CLI / desktop bridge (`scratch-git-2/src/cli/commands/files.rs`, `shared/`)
- Replace the post-publish `reconcile_accepted_after_publish` re-anchor-everything with:
  advance `main`, **clear** `accepted-patches.json` for published paths, write
  `failed-patches.json` from the job result, and materialize the working tree =
  new `main` + failed patches (needs-approval) + preserved unreviewed edits (DEV-10523).
- `failed-patches.json` load/save (mirror `accepted_patches.rs`), and napi exposure of the
  failed/error state for the grid.

### Desktop (`scratch-desktop/`)
- `PublishChangesModal` carries `publishOrigin: 'desktop'`; post-publish download writes
  `failed-patches.json`; the grid renders a **needs-approval + per-field error** annotation
  for fields present in `failed-patches.json` with a `fieldErrors` entry.

### Web (`client/`)
- Publish carries `publishOrigin: 'web'`; failed edits re-applied to `dirty` server-side are
  shown as needs-approval with the same per-field error annotation (data comes from the
  server declaratively — no connector knowledge in the frontend).

## Open decisions (recommendations — for review, not blocking the doc)

1. **Canonical post-success `main`: returned-rows vs re-pull.** Recommend returned-rows
   (`useRemoteReturnedRows`) where available — cheapest, already built — and fall back to
   sent payload; a full re-pull is heavier and racier. (Side effects from _other_ records /
   computed fields not echoed on the row would still drift until the next pull — acceptable.)
2. **Create / Delete failures.** The diagram only shows updates. `failed-patches` must also
   carry failed creates (kind `create`, full content + error) and failed deletes (kind
   `delete` + error). Recommend: same envelope, same routing.
3. **Multi-user visibility.** A desktop publish resets web `dirty` for the published paths
   and ships failures to the desktop — so a web user watching the same workbook sees those
   pending edits disappear (they "moved" to the desktop publisher). Recommend accepting this:
   the publisher owns the attempt; document it.
4. **`failed-patches.json` lifecycle.** When are entries cleared? **Resolved (DEV-10751):**
   the record-level review actions — `accept` / `reject` / `discard` and their `-all`
   variants — clear the record's entry (accept folds it back into `accepted-patches.json`;
   reject/discard drop it). The original "a stale entry is harmless (it's just an annotation
   source)" assumption was **wrong**: the post-publish reconcile re-applies every entry to
   the working tree, so an un-cleared entry resurrects the reverted edit on the next publish.
   Follow-up: the field-in-folder variants (`reject-field` / `discard-field` / `accept-field`)
   don't clear entries yet; doing so needs a field-granular `failed_patches::remove_field`.
5. **DEV-10316 dirty-gate.** With `dirty` rebuilt from `main`, the phantom that inflates the
   gate disappears; confirm the gate's count logic still behaves with the scoped reconcile.

## Progress log

- **2026-06-24 — Backbone slice (server + scratch-git) done & verified.**
  - shared-types: `PublishOrigin` type + `publishOrigin?` on `PublishPlanRunDto`;
    `fieldErrors?` added to `PublishFailedOperation` (type plumbed; population deferred).
  - server: `publishOrigin` threaded controller → `enqueueRunPipelineJob` → `PublishJobDefinition`
    → `runPipeline`. `runPipeline` replaces the unconditional `rebaseDirty` with a **scoped
    reconcile**: computes `pathsToConvergeToMain = allPlanPaths − (web ? failedPaths : ∅)` and
    calls `rebaseDirty(repoId, excludePaths)`. (Web uses `runAfterPlan`, so it takes the `'web'`
    default — no migration; desktop/CLI send `'desktop'` on the run-job.)
  - scratch-git: `rebase_dirty_excluding(strategy, exclude_paths)` (1-arg `rebase_dirty` delegates
    with `&[]`); route `RebaseBody.excludePaths`; service/client pass-through. Excluded paths are
    skipped in the re-apply loop so they converge to the force-reset `main`.
  - Tests: 2 new Rust unit tests (`rebase_excluding_converges_excluded_path_to_main` — the
    DEV-10048 no-op/removed-key regression; `rebase_excluding_keeps_non_excluded_edit`). All 8
    rebase tests + 34 server publish-run tests pass; shared-types/server/Rust all build.
  - **Effect:** fixes the DEV-10048 phantom on the server `dirty` branch → web pending view +
    DEV-10316 dirty-gate. The **desktop** surface still needs the CLI client reconcile (below),
    because its badge comes from the local `accepted-patches.json`, not server `dirty`.
  - **Deferred:** `fieldErrors` population (per-connector error attribution) — type is plumbed;
    folded into the UI tasks where it's consumed.

- **2026-06-24 — Rust CLI / client reconcile (#3) done & verified.**
  - New `scratch-git-2/src/shared/failed_patches.rs`: the `failed-patches.json` model
    (`FailedPatch` = `AnchoredPatch` + `error` + `fieldErrors` JSON-Pointer→msg) with
    load/save/get/upsert/remove + `from_anchored`/`to_anchored`. Empty save removes the file.
  - `re_anchor::is_publish_no_op_against_main` — Rust mirror of the server's
    `computeChangedFields` (ignores removed keys), to drop stranded no-op survivors.
  - Shared partition helpers `failed_ops_by_path` + `partition_reanchored_after_publish`
    (rejected → failed-patches, no-op survivor → dropped, else → kept accepted), used by
    BOTH `reconcile_accepted_after_publish` (CLI `files publish`) and `download_single_repo`.
  - `download_single_repo` gains a `post_publish_failed_ops: Option<&[JobFailedOperation]>`
    param: `None` = plain pull (unchanged, DEV-10523 preserved); `Some` = post-publish
    reconcile (failed→failed-patches, no-op drop, failed edits re-surface as needs-approval,
    unreviewed edits still preserved).
  - New CLI `scratchmd files reconcile-after-publish --connection <id> --failed-ops-json <json>`
    for the desktop; CLI `publish_plan_run` now sends `publishOrigin: "desktop"`;
    `JobFailedOperation` gains `fieldErrors`.
  - Tests: failed_patches round-trip/empty-removes/upsert; 7 `is_publish_no_op_against_main`
    cases; `reconcile_moves_failed_op_to_failed_patches`; `reconcile_drops_removed_key_no_op_survivor`.
    All Rust suites green (336 + 417 + 535 + integration); `cargo fmt` clean.
  - **Effect:** closes DEV-10048 on the desktop/CLI once the renderer calls the new command
    (#4). Deferred: `data_folders` empty-dir pruning in the new command (cosmetic);
    re-anchoring a stale `failed-patches.json` on a *plain* pull (annotation artifact).

- **2026-06-24 — Desktop UI (#4) done & verified (typecheck + tests + lint).**
  - shared-types: `viaCliRoute.runJob` now sends `publishOrigin: 'desktop'`.
  - Desktop main: new `reconcileAfterPublish` shell-out (`files reconcile-after-publish`),
    `scratch:reconcile-after-publish` IPC, preload bridge (+`.d.ts`).
  - Publish modal: captures each connection's `failedOperations`; the post-publish refresh now
    loops every connection that ran a run-job calling `reconcileAfterPublish(connectionId,
    JSON.stringify(failedOps))`, then a final `pullWorkspaceChanges` to catch connections that
    advanced server-side.
  - Grid annotation: `local-files.ts` reads `failed-patches.json` → `__failedFields`
    (per-field, dot-path keys) + `__failedError` (record-level) on each row; `FolderDataGrid`
    tints failed cells red (text + left-edge bar) on top of the unreviewed styling.
  - Updated `publish-api.spec.ts` to expect `publishOrigin: 'desktop'`. 268 desktop tests pass;
    `yarn typecheck` + `yarn lint` clean.
  - **Deferred (needs live QA / server `fieldErrors`):** a hover tooltip showing the exact
    `failedError` message per cell (today: red flag + the edit re-surfaces as needs-approval);
    single-record "Download and publish" failure → `failed-patches` (still surfaces as a pending
    edit, just not annotated). `__failedFields` stays empty until the server populates `fieldErrors`;
    `__failedError` (record-level) is populated now.

- **2026-06-24 — Web (#5).** The web is functionally correct with no behavioral code change:
  it publishes via `viaWorkbookRoute` (server default `publishOrigin: 'web'`), so the server
  reconcile keeps connector-rejected paths on `dirty` (re-surfaced as needs-approval) and
  converges no-op paths — i.e. the DEV-10048 phantom is gone on the web too (the server backbone
  + scratch-git scoped reconcile already cover it, with server tests). Made the web's origin
  **explicit** (`viaWorkbookRoute.runJob` now sends `publishOrigin: 'web'`) for robustness against
  a future default change. The web's existing publish-result UI surfaces failure status
  (`CompletedWithErrors` / `failedCount`).
  - **Deferred:** a persistent per-field error annotation in the web review UI. The web's review
    model is file-diff-based (not a per-cell grid like desktop), so the desktop annotation doesn't
    map 1:1; a richer web annotation also depends on the deferred server `fieldErrors` population.

- **2026-06-24 — Tests + docs (#6).**
  - Server: 2 reconcile tests (`web` keeps failed on dirty / `desktop` converges all) — 36
    publish-run tests pass; server build + `lint-strict` clean.
  - Rust: failed_patches round-trip, `is_publish_no_op_against_main` (7 cases), reconcile
    move-to-failed + no-op-drop, scoped `rebase_dirty_excluding` — full Rust suite green.
  - Desktop: `publish-api.spec` updated; 268 tests + typecheck + lint clean.
  - Docs updated: `REVIEW_MODEL.md` (`failed-patches.json`), `PULL_AFTER_PUBLISH.md` (redesign
    section), `BRANCHING_MODEL.md` (publish reconcile + `publishOrigin`).

- **2026-06-24 — Fix (review catch): single-phase reconcile regression.** The scoped reconcile
  selected *every* plan op, so a single-phase run (web "Execute 1 Phase") wrongly converged paths
  whose later-phase ops were still `pending` — dropping a not-yet-published create/delete/backfill
  edit from `dirty`. Fixed by excluding any path with a `pending` op (`terminalPlanPaths`); also
  covers a record split across an executed phase and a pending one (landed `edit` + pending
  `backfill`). Full-pipeline behavior unchanged (nothing pending after a full run). New test
  `single-phase run leaves still-pending paths on dirty`; 37 publish-run tests pass.

- **2026-06-24 — Desktop unit tests for the failed-patches annotation.** Added hermetic vitest
  coverage of the new desktop logic: `local-files-failed-patches.spec.ts` (7 tests —
  `readFailedRecordDetailsByFile` folder scoping, per-field + record-level errors,
  JSON-Pointer→dot-key, missing/malformed file; `jsonPointerToFieldKey`) and
  `failed-fields.spec.ts` (5 tests — `resolveCellFailedError` precedence: per-field path → root
  field → record-level-only-on-a-diffed-cell). Extracted `resolveCellFailedError` from
  `FolderDataGrid`'s `getCellDiffState` into a sibling `failed-fields.ts` (testable without
  tripping `react-refresh/only-export-components`). 280 desktop tests pass; typecheck + lint clean.
  A full **Playwright E2E** of the publish→failed→grid flow remains deferred — the grid/reconcile
  live behind the CLI/napi local-file layer (not network-mockable) and a workspace-with-data needs
  the native folder picker stubbed (the e2e README already defers the download→grid E2E for this).

## Deferred follow-ups (tracked, out of this pass)

- **Server `fieldErrors` population** — per-connector error attribution to specific fields
  (extend `extractConnectorErrorDetails`). Until then `failed-patches.json` carries the
  record-level `error` only; the desktop shows a red flag + record-level message, not per-field.
- **Single-record "Download and publish" failure → `failed-patches`** — currently a failed
  single-record publish surfaces as a still-pending edit (not annotated). `reconcile-published`
  would need the same failed-routing as `reconcile-after-publish`.
- **Desktop hover tooltip** showing the exact `failedError` per cell (data is wired).
- **Web per-field annotation** in the file-diff review UI (functional behavior already correct).
- **Plain-pull re-anchor of a stale `failed-patches.json`** (annotation artifact; low risk).

## Ticket breakdown (proposed)

1. **Server: per-record success/failure + `failed-patches` emission + origin plumbing.**
   (Run-service split of success→main / failure→failed-patches; `publishOrigin`;
   connector per-field error extraction.) — _the spine._
2. **scratch-git: scoped dirty reconcile** (replace/contract-change `rebaseDirty`).
3. **Rust CLI/desktop bridge: `failed-patches.json` write + working-tree materialize**
   (clear published from `accepted-patches`, apply failed as needs-approval, preserve
   unreviewed per DEV-10523). napi exposure.
4. **Desktop UI: needs-approval + per-field error annotation.**
5. **Web: origin = web, failed→dirty, same annotation.**
6. **Cleanup / migration: retire the no-op skip's load-bearing role; tests; docs**
   (`REVIEW_MODEL.md`, `PULL_AFTER_PUBLISH.md`, `BRANCHING_MODEL.md`).

DEV-10048 is closed by tickets 1–4 (the reconcile no longer strands no-op edits).

## Test plan (high-level)

- Per-record atomic failure: a record with one bad field fails wholesale; `main` unchanged;
  whole record in `failed-patches.json` with `error`/`fieldErrors`.
- No-op / removed-key edit: after publish, `dirty` == `main` for that path; no phantom on
  web view or dirty-gate; desktop badge clears. (DEV-10048 regression.)
- Scoped reconcile: single-record publish does not wipe other approved edits on `dirty`.
- Routing: desktop publish → failed edits in working tree, not web `dirty`; web publish →
  failed edits on web `dirty`.
- Unreviewed preservation: an unrelated in-progress working-tree edit survives a publish.
- Success fidelity: connector side effects (auto-cap, formula, others' edits) land on `main`.
