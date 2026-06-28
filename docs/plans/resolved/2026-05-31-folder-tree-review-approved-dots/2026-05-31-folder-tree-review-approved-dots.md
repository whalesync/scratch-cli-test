# Folder Tree — "Needs Review" and "Approved" Dots

## Goal

Show small status dots next to each folder in the desktop sidebar so a user can see at a glance which folders contain files that need review or have approved-but-unpublished changes — without clicking through every folder.

Concretely:

- **Blue dot** next to a folder name if any file in that folder has unreviewed changes (`unapprovedChanges = 1`). Colour: `var(--modified-needs-review-stroke)`, matching the "Needs review" filter pill at the top of the folder view (`FolderDataGrid.tsx:2825`).
- **Gray dot** if any file has approved-but-unpublished changes (`approvedChanges = 1`). Colour: `var(--modified-approved-stroke)`, matching the "Approved" pill (`FolderDataGrid.tsx:2833`).
- **Coexists with validation dots**: when a folder has both validation issues and review/approved changes, the dots sit next to each other in the same slot, to the left of the folder icon (the slot currently used by the single absolute-positioned validation dot at `FolderTree.tsx:300-348`).

The driving use case: a user makes a batch of edits to record files outside Scratch (e.g. with Claude). When they alt-tab back to Scratch — or relaunch Scratch from a cold start — they expect to see the dots immediately on the folders that changed, **without having to open each folder first**.

## Inputs already verified

- **Validation dots pattern** (`FolderTree.tsx:300-348` + `WorkspaceSidebar.tsx:79-87`): the existing single-dot UI lives in an absolute-positioned `<Box>` to the left of the folder icon. The map of per-folder counts is built in the sidebar from a workspace-wide `validationStats` query and piped down to the tree.
- **Validation stats CLI** (`validation.rs:169-249`): pure read-only SQL aggregate. For each connection, opens the `.db`, lists folder tables, runs a few COUNT queries. No mtime walk, no JSON parse, no git. Returns `[{ connection, folder_path, errors, warnings, records }]`. This is the template for the new review stats function.
- **Review bits are columns on the folder index** (`folder_index.rs:117-119`, `folder_index.rs:1470-1479`): `approvedChanges` and `unapprovedChanges` are persisted bits with partial indexes. Aggregating "any row with the bit set?" is two trivial COUNTs against a partial index — milliseconds per folder.
- **The bits get written by `reindex_files`** (`folder_index.rs:2616-2716`), which is called from `run_query` when the user opens a folder (`folder_index.rs:3119`), from `refresh_folder` (`folder_index.rs:2898`), and post-mutation by pull/publish/accept/reject/discard (`files.rs:1208-1228`, `files.rs:1925-1933`, etc).
- **`find_stale`** (`folder_index.rs:2543-2560`): mtime-walks the working tree and compares against stored mtimes. No JSON parse. `reindex_files` then runs only on the stale set. So `refresh_folder` on a clean folder is ~free; on a folder with N modified files it's ~N JSON reads.
- **The file watcher already exists** (`scratch-desktop/src/main/workspace-file-watch.ts`): one non-recursive `fs.watch` per data folder, 500 ms debounce, fires `WORKSPACE_FILE_WATCH_EVENT_CHANNEL` with `{ workspacePath, source: 'external' | 'internal', changedFolderPaths, singleFile? }`.
- **Today's watcher handling is selective-folder-only** (`WorkspacePage.tsx:492-501`): external events trigger `handleDataRefresh()` **only when the change is in the currently selected folder**. Folders the user isn't viewing get no refresh — so even the alt-tab-while-Scratch-is-running case currently doesn't populate dots for unrelated folders. The plan closes both gaps (cold start + in-session non-selected folders).
- **napi binding already exists.** `scratch-git-2/napi/` (the `scratchmd-native` crate) is set up exactly for this pattern: a path-dep on the workspace `scratch-git-2` lib, currently exposing review *ops* (`acceptField`, `rejectField`, `discardField`, etc.) into the desktop main process. Loader at `scratch-desktop/src/main/native/scratchmd-native.ts` resolves dev (`<repoRoot>/scratch-git-2/napi/`) vs packaged (`Resources/bin/`) paths and surfaces typed errors. `.node` artefacts checked in per arch (`scratchmd-native.darwin-arm64.node` today; Windows MSVC story landed via the [2026-05-24 NAPI plan](../../2026-05-24-windows-napi-msvc-cross-compile/2026-05-24-windows-napi-msvc-cross-compile.md)). Build script at `scratch-desktop/scripts/build-native.sh`.

## Architecture

Three layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Renderer (FolderTree)                                               │
│   reviewByFolder: Map<"connection/path", {unreviewed, approved}>    │
│   validationByFolder: Map<"connection/path", {errors, warnings}>    │
│   ↑ rerender on every update — dots show as data arrives            │
└─────────────────────────────────────────────────────────────────────┘
                          ▲
                          │  useReviewStats hook (debounced refetch)
                          │  useValidation stats half (existing)
                          │
┌─────────────────────────────────────────────────────────────────────┐
│ Main process                                                        │
│                                                                     │
│   IPC: files:get-review-stats     → nativeBinding.getReviewStats    │
│   IPC: files:get-validation-stats → nativeBinding.getValidationStats│
│                                     (migrated from shell-out)       │
│   Refresh queue (sequential): nativeBinding.refreshFolder(...) per  │
│     folder, then emits 'review-stats-may-have-changed' IPC          │
│   Watcher hook: on external file-change, enqueue affected folders   │
└─────────────────────────────────────────────────────────────────────┘
                          ▲
                          │  in-process napi call (no process spawn)
                          │
┌─────────────────────────────────────────────────────────────────────┐
│ scratchmd-native (Rust napi crate)                                  │
│   getReviewStats(workspaceDir)        → JSON-serialisable array     │
│   refreshFolder(workspaceDir, folder) → RefreshResult               │
│   getValidationStats(workspaceDir)    → JSON-serialisable array     │
└─────────────────────────────────────────────────────────────────────┘
                          ▲
                          │  path-dep
                          │
┌─────────────────────────────────────────────────────────────────────┐
│ scratch-git-2 workspace lib                                         │
│   shared::review_stats::get_review_stats(...)                       │
│   shared::review_stats::refresh_folder(...)  ← thin wrapper around  │
│     folder_index::refresh_folder                                    │
│   (shared::validators::get_stats: existing, gets exposed via napi)  │
│                                                                     │
│   Consumed by:                                                      │
│     - scratchmd CLI command handlers                                │
│     - scratchmd-native napi binding                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Why napi instead of shelling out to `scratchmd`

A per-folder `scratchmd index refresh-folder` shell-out has ~10–20 ms of pure spawn overhead (Rust binary startup + workspace marker read). On a 100-folder cold start that's 1–2 s of *pure overhead*, even when nothing changed. napi runs in-process — overhead drops to zero. We also get:

- One workspace marker load per refresh pass instead of N.
- One SQLite connection per connection-DB, reused across all folder refreshes in that DB.
- Typed errors instead of stdout JSON parsing (napi error-code convention already established at `napi/index.d.ts:11-30`).
- Symmetry with the existing review *ops* (`acceptField` etc.) — review stats and per-folder refresh logically belong on the same surface.

### Scope of the napi migration

This plan migrates **only the call sites that feed the sidebar's dot rendering**:

- `getReviewStats` (new — added in this plan).
- `refreshFolder` (new — added in this plan, called by the refresh queue).
- `getValidationStats` (existing — `scratchmd.ts:778` currently shells out to `validation get-stats`; migrated here for consistency, since review dots and validation dots sit in the same sidebar map and should share latency).

**Out of scope for this plan**: every other `runScratchmd*` call site (workspace init, pull, publish, file upload, paginate-records, validation results-by-folder, etc.). Those keep shelling out as today. The napi surface gets extended deliberately and only where the dot subsystem benefits.

### Freshness model — two complementary passes

**Pass A: on workspace load (catches edits made while Scratch was closed)**

1. Renderer hook calls `getReviewStats` immediately → dots from whatever's currently in the index. May be stale for folders that haven't been touched since the last index update.
2. In parallel, main process queues a **sequential** walk through every folder in `workspace.dataFolders` and calls `nativeBinding.refreshFolder(workspacePath, folder)` for each. For folders with no external changes, this is a cheap mtime walk that finishes in ms. For folders with edits, it reindexes only the changed files.
3. After each folder finishes its refresh, the main process emits a `'review-stats-may-have-changed'` IPC event. The renderer hook re-runs `getReviewStats` (debounced ~250 ms so a fast queue doesn't thrash) and the dots update progressively.
4. The user clicks straight through unaffected folders during this — dots just keep filling in.

Sequential, in `dataFolder`-list order, per the explicit decision earlier in design: predictable load, and the folders the user is most likely to look at first get their dots first.

**Pass B: live watcher events (catches edits while Scratch is open)**

1. The existing file watcher fires `workspace-files-changed` with `source: 'external'` for the affected folder(s).
2. Today the renderer ignores this event unless it's for the open folder. **Change**: in the main process, when an external file-change event fires, also enqueue an `nativeBinding.refreshFolder` for each affected folder (deduped) and trigger a debounced review-stats refresh on completion.
3. The renderer keeps its existing "if currentFolder matches, call `handleDataRefresh`" behaviour — that path stays untouched.

### Cost (honest)

- **`getReviewStats` / `getValidationStats`**: pure SQL via napi — sub-ms typical.
- **`refreshFolder` on an unmodified folder**: mtime stat per record file in-process. For 1000 files, low-double-digit ms warm cache.
- **`refreshFolder` on a folder with N modified files**: ~N JSON reads + master-tree blob lookups. Bulk Claude-edit case (50 files) is sub-second.
- **Pass A across the whole workspace at startup**: sum of the above with **no per-folder spawn overhead**. 100 clean folders in well under a second; widespread changes scale with what actually changed.

No full git walks. No process spawns on the hot path. The expensive thing (`run_query` with full reindex) is never on this path.

### UI — dot rendering

The current slot (`FolderTree.tsx:301-348`) renders **one** absolute-positioned dot. Replace with a small horizontal row containing 0–4 dots, rendered in this fixed order so reading the badge is consistent:

1. Red — validation errors (existing)
2. Orange — validation warnings (existing)
3. Blue — needs review (new) — `var(--modified-needs-review-stroke)`
4. Gray — approved (new) — `var(--modified-approved-stroke)`

Each dot is only rendered when its count > 0. Dot size, spacing, and absolute-positioning stay the same as today so the visual rhythm doesn't shift for folders that only have validation issues. Tooltip combines all visible dots.

The review dots are always on (unlike validation dots, which are gated on `validateEnabled`). The whole point of this feature is the unconditional at-a-glance signal.

## Slices

### Slice 1 — Rust: shared lib + CLI command for review stats

- New module `scratch-git-2/src/shared/review_stats.rs`:
  - `pub fn get_review_stats(workspace_dir: &Path) -> anyhow::Result<Vec<ReviewStat>>`. Loops connections from the workspace marker, opens each `.repos/<connection>.db`, lists folder tables (reuse helpers used by `validation get-stats`), and for each table:
    - `SELECT COUNT(*) FROM "<table>" WHERE unapprovedChanges = 1` → `unreviewed`
    - `SELECT COUNT(*) FROM "<table>" WHERE approvedChanges = 1` → `approved`
    - Skip rows where both are 0.
  - `pub fn refresh_folder(workspace_dir: &Path, folder: &str) -> anyhow::Result<RefreshFolderResult>`: thin wrapper around the existing `folder_index::refresh_folder` so the napi binding has a stable, documented surface to call.
  - `pub struct ReviewStat { connection: String, folder_path: String, unreviewed: i64, approved: i64 }` with serde derive.
- New CLI subcommand `files get-review-stats` in `scratch-git-2/src/cli/main.rs` + `scratch-git-2/src/cli/commands/files.rs`. Just calls `shared::review_stats::get_review_stats` and prints JSON. Keeps standalone scratchmd CLI useful.
- Rust unit test in `review_stats.rs`: seed a folder index with mixed bits, assert aggregate.
- Update `scratch-git-2/src/cli/commands/generate_docs.rs` so the command appears in generated CLI docs.

**Acceptance**: `cargo test`, `cargo fmt`. `scratchmd files get-review-stats` against a real workspace prints expected counts.

### Slice 2 — Rust: extend napi binding

- In `scratch-git-2/napi/src/lib.rs`, expose three new functions:
  - `pub async fn get_review_stats(workspace_dir: String) -> napi::Result<Vec<ReviewStat>>`
  - `pub async fn refresh_folder(workspace_dir: String, folder: String) -> napi::Result<RefreshFolderResult>`
  - `pub async fn get_validation_stats(workspace_dir: String) -> napi::Result<Vec<ValidationStat>>` (migrated for consistency with the review dots' latency profile)
- Mirror the existing error-code prefix convention (`napi/index.d.ts:11-30`): map known shared-layer errors to `LOCK_BUSY`, `WORKSPACE_NOT_FOUND`, `UNKNOWN_CONNECTION`, `INTERNAL`, etc.
- Update the hand-maintained `scratch-git-2/napi/index.d.ts` with the new function signatures and their types. Per the existing crate comment, do not rely on autogen.
- Add napi-side vitest specs in `scratch-git-2/napi/__tests__/` covering happy-path + a sample error mapping.
- Rebuild the `.node` artefacts for currently-supported targets via `scratch-desktop/scripts/build-native.sh` (or the equivalent native build step). Check in new `.node` files alongside the existing ones.

**Acceptance**: napi tests pass on the dev machine; new `.node` files exist for darwin-arm64 (and any other already-checked-in arch). `cargo build --release -p scratchmd-native` succeeds.

### Slice 3 — Desktop main: shared types + native shim + IPC

- Add shared TS type alongside `validation-types.ts`:
  ```ts
  // scratch-desktop/src/shared/review-types.ts
  export type ReviewStat = {
    connection: string;
    folder_path: string;
    unreviewed: number;
    approved: number;
  };
  ```
- Extend `scratch-desktop/src/main/native/scratchmd-native.ts` (the loader/shim):
  - Re-export typed wrappers: `nativeGetReviewStats(workspacePath)`, `nativeRefreshFolder(workspacePath, folder)`, `nativeGetValidationStats(workspacePath)`.
  - Reuse the existing `parseNativeErrorCode` helper for error normalisation.
- In `scratch-desktop/src/main/scratchmd.ts`:
  - Rewrite `getValidationStats` to delegate to `nativeGetValidationStats`. Keep the signature stable so call sites (`use-validation.ts:139`, `PublishChangesModal.tsx:362`, `ValidationStatsDrawer.tsx:65`) don't need to change.
  - Add `getReviewStats(workspacePath)` and `refreshFolderViaNative(workspacePath, folder)` thin wrappers.
- In `scratch-desktop/src/main/index.ts`:
  - Add `ipcMain.handle('files:get-review-stats', ...)`.
  - The existing `files:get-validation-stats` handler keeps its name but now calls the napi-backed wrapper (no renderer changes needed).
- In `scratch-desktop/src/preload/index.ts` + `index.d.ts`, expose `window.scratchFiles.getReviewStats(workspacePath)`.

**Acceptance**: vitest for `scratchmd-native.spec.ts` extended to cover the new wrappers. Existing validation-stats consumers continue to work unchanged.

### Slice 4 — Desktop main: sequential refresh queue

- New module `scratch-desktop/src/main/review-refresh-queue.ts`:
  - Holds a single in-flight queue keyed by `workspacePath`.
  - `enqueueFolderRefresh(workspacePath, folderPaths: string[])`: dedupes against pending + in-flight, appends.
  - `enqueueAllFolders(workspacePath, dataFolders)`: enumerates every folder in `dataFolder`-list order and enqueues them in one batch.
  - Worker drains the queue serially, calling `nativeRefreshFolder(workspacePath, folder)` (no child process). On each completion, emits a debounced `'review-stats-may-have-changed'` IPC event to the active renderer.
  - Quiet — silent retry once on transient error, console log on persistent failure.
- Wire into `scratch-desktop/src/main/index.ts`:
  - When the renderer signals "workspace open" (existing `files:watch-workspace-files` / open path), call `enqueueAllFolders` (Pass A).
- Declare the event channel in `scratch-desktop/src/shared/` and expose via preload as `window.scratchDesktop.onReviewStatsMayHaveChanged(cb)`.

**Acceptance**: vitest covers (a) queue runs sequentially, (b) duplicate folders coalesce across enqueues, (c) completion emits the debounced IPC event.

### Slice 5 — Renderer: `useReviewStats` hook

- New file `scratch-desktop/src/renderer/src/hooks/use-review-stats.ts`, modelled on the stats half of `use-validation.ts`:
  - State: `stats: ReviewStat[]`, `statsLoading: boolean`.
  - `loadStats` calls `window.scratchFiles.getReviewStats(workspacePath)`.
  - `useEffect` triggers `loadStats` on mount, on `workspaceLevelDataInvalidationCounter` change, and when `onReviewStatsMayHaveChanged` fires (debounced ~250 ms trailing edge so a burst of folder-completed events collapses to one refresh).
- Returns `{ stats, statsLoading, refreshStats }`.

**Acceptance**: vitest covers initial load + debounced refresh on event burst.

### Slice 6 — Plumbing through Workspace components

- `WorkspacePage.tsx`: instantiate `useReviewStats(localPath, workspaceLevelDataInvalidationCounter)`. Pass `reviewStats` and `reviewStatsLoading` down through `WorkspaceContent` → `WorkspaceSidebar`.
- `WorkspaceSidebar.tsx`: build `reviewByFolder: Map<string, { unreviewed: number; approved: number }>` next to the existing `validationByFolder`, keyed identically as `${s.connection}/${s.folder_path}`. Pass to `FolderTree` (always — no gating on `validateEnabled`).
- `FolderTree.tsx` (and `FolderTreeNodeRow`): add a `reviewByFolder` prop and forward it through the recursive render.

**Acceptance**: types compile end-to-end; sidebar receives non-empty map after queue runs.

### Slice 7 — Multi-dot rendering in FolderTree

- In `FolderTree.tsx:301-348`, replace the single absolute-positioned dot with a small `Group` (or absolute-positioned flex row) containing the four ordered dots: red → orange → blue → gray. Each dot only rendered if its count > 0.
- Tooltip restructured to a vertical list of present dots, e.g.:
  ```
  Validation
    × 3 errors
    ⚠ 1 warning
  Changes
    • 14 needs review
    • 5 approved
  ```
- Preserve current sizing (6 px dots, ~2 px gaps) and absolute positioning so layout shift is invisible for folders with only validation badges.
- Use the design tokens for the new colours: `var(--modified-needs-review-stroke)` (blue) and `var(--modified-approved-stroke)` (gray).

**Acceptance**: manual dev-server check — open a workspace with mixed states and visually confirm dot order, colour, tooltip, and that the layout matches today for folders with only validation badges. Run `yarn lint` from `scratch-desktop/`.

### Slice 8 — Wire watcher → refresh queue

- In `WorkspaceFileWatchService.flushPendingChanges` (`workspace-file-watch.ts`), after the existing renderer IPC dispatch, when `source === 'external'` and `changedFolderPaths.length > 0`, hand the affected folder paths to the refresh queue.
- The queue maps workspace-absolute folder paths back to `<connection>/<sub_path>` form using the workspace marker (helper already used by other main-process commands).
- Internal events (during pull/publish) still skip the queue — those code paths already keep the index current.

**Acceptance**: vitest test that simulates an external file event and asserts the queue receives the expected folder.

### Slice 9 — Cold-start smoke test

- Manual test plan:
  1. Open a workspace, run a fresh pull so the index is clean. Confirm no review/approved dots.
  2. Close Scratch.
  3. From a terminal, edit a JSON record file under `~/Library/.../<workspace>/<connection>/<folder>/<file>.json` (e.g. flip a string). Edit another file in a different folder.
  4. Relaunch Scratch and open the workspace.
  5. Within a few seconds of opening, both folders should show the blue "Needs review" dot — without clicking into either.
- Repeat with Scratch already open (alt-tab) — dots should appear after the 500 ms watcher debounce + refresh time.
- Also verify validation dots still appear correctly (regression check on the migrated `getValidationStats` path).

**Acceptance**: both paths show expected dots; validation dots unchanged.

## Open questions / decisions to revisit

- **Background queue progress UI?** None for v1 — the dots arriving is the progress indicator. Revisit if startup feels sluggish on real workspaces.
- **Refresh-storms.** If a user runs a script that touches thousands of files across many folders, the queue will process them serially over multiple seconds. Acceptable for v1 — main process stays responsive because work is offloaded to native async tasks (napi `tokio_rt` feature is already enabled).
- **Watcher coalescing window.** Today the watcher debounces 500 ms. If the refresh-stats IPC events from finished refreshes need a longer trailing debounce in the renderer (currently proposed ~250 ms), tune after dogfooding.
- **napi build burden.** Each platform we ship needs a fresh `.node` per added function. The build script and CI story already exist; flagging here so the next desktop release process is aware that `scratch-git-2/napi/index.darwin-*.node` (and the Windows artefacts from the 2026-05-24 plan) need to be regenerated as part of this work.
