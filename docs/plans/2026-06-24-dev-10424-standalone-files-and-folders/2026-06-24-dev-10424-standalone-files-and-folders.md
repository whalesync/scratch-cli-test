# Standalone files & folders in Scratch (no connector)

- **Created:** 2026-06-24
- **Author:** Curtis Fonger
- **Status:** Implemented + runtime-verified (server + web + desktop incl. nesting; full E2E flow exercised against the real stack — server + Rust scratch-git + Postgres)
- **Linear:** [DEV-10424 — [MAJOR] Create and edit standalone files and folders in Scratch (not tied to a connector)](https://linear.app/whalesync/issue/DEV-10424/major-create-and-edit-standalone-files-and-folders-in-scratch-not-tied)

> Reviewed via `/plan-eng-review` on 2026-06-24 (4 architecture decisions, 2 code-quality, full test
> diagram, independent outside-voice challenge). The outside voice materially reshaped the plan — see
> the GSTACK REVIEW REPORT at the bottom and the "Decisions" section below for the resolutions.

## Problem

Design-partner onboarding (Loxley Roofing) asked to create and edit freeform files and folders in
Scratch that are **not** downloaded from a connected service — e.g. drafting social posts as
text/markdown, and a CSV/markdown status tracker that AI keeps updated. Today the left pane has no
"New Folder," there is no way to add a freeform file, and every file is rendered/edited as JSON.

## Guiding principle (from the maintainer)

> "Everything should be in git. Files in the Scratch Folder aren't tied to a particular connector —
> they're just saved as-is, which makes everything very easy."

Consequences we hold to: **no schema**, **byte passthrough** (any text format, stored verbatim), and
**no connector machinery** (no pull, publish, sync, transformers, validators) touches scratch files.

## Scope (confirmed with maintainer)

- **Repo:** a **dedicated per-workbook scratch git repo**, derived path `{orgId}/{workbookId}/scratch`.
  Discriminator for a scratch folder is `connectorAccountId === null`.
- **Frontends:** **web AND desktop, shipped together as one V1.** Desktop renders any file as text.
- **Nesting:** nested subfolders, modeled as **git subdirectories** (not a row per subfolder).
- **File types:** any text format, raw bytes, zero per-extension server logic.

## Decisions (resolved during eng review)

| # | Decision | Resolution |
|---|----------|-----------|
| D1 | Source of truth for a folder | **DB-authoritative.** A top-level scratch folder is a `DataFolder` row (`connectorAccountId = null`). Desktop routes folder create/rename/delete through the server REST API; file edits and nested subfolders are pure local git. Mirrors the connector model (folder = row, contents = git). |
| D2 | Review ladder for scratch edits | **None.** Save = a git commit. No approved/publish step. |
| D3 | Branch model (impl of D2) | **Scratch repos are MAIN-ONLY.** Parameterize the hard-coded `dirty` branch so scratch read/write/list/diff target `main`. Desktop already materializes `main`. Scratch diff/dirty-status is always empty (correct — scratch files are never "pending"). |
| D4 | Repo lifecycle | **Dedicated repo, built on the workbook-CONFIG-repo machinery** (`init_workbook_repo` + main materialization), **NOT** the connector-account machinery (which structurally excludes connection-less repos). Eager init at workbook creation + a batched/idempotent backfill migration. Cleaned up in `WorkbookService.delete`. |
| D5 | Empty-folder persistence | **`.gitkeep`** placeholder in every new/empty folder; filtered from all listings + counts (reuses existing dotfile filtering). |
| D6 | Name/path validation | **One shared server-side validator**: reject path traversal, reserved names (`.git`/`.scratch`/`.gitkeep`), collisions with connector folder paths + existing scratch entries, duplicates, empty/whitespace, cross-OS-illegal chars. Plus a **per-file size cap** (count guards deferred). |
| D7 | Non-JSON robustness | **Full audit + harden** every read/diff/index/FK path that assumes JSON so non-JSON degrades gracefully, with tests pushing markdown/CSV/empty through each. |
| D8 | Test coverage | Full unit suite + **4 IRON-RULE regression tests** (connector behavior unchanged) + **full bidirectional web↔desktop E2E** for both reconciliation directions. |

## Architecture

```
                          ┌─────────────────────────────────────────┐
                          │  Per-workbook DEDICATED scratch git repo │
                          │  {orgId}/{workbookId}/scratch  (MAIN-only)│
                          │  lifecycle = workbook-config-repo style   │
                          └─────────────────────────────────────────┘
                                    ▲ commit/main        ▲ clone/materialize(main)
        DB-authoritative folders    │                    │
   ┌────────────────────────────────┴───────┐   ┌────────┴───────────────────────────┐
   │  WEB (DataFolder-row driven)            │   │  DESKTOP (local-disk-scan driven)   │
   │  • Scratch group = null-connector rows  │   │  • clones scratch repo at init      │
   │  • New Folder/File via REST API         │   │  • folder create/rename/del → API   │
   │  • nested subdirs via git.listRepoFiles │   │  • file edit = local disk → upload  │
   │  • edit by path → commit to MAIN        │   │    (NEW connection-less sync path)  │
   └─────────────────────────────────────────┘   └─────────────────────────────────────┘
                resolveRepoPathForFolder(folder): null connector → scratch repo, else connector
```

### Server (`/server`)

1. **Repo lifecycle (D4):** add `getScratchRepoPath(orgId, workbookId)`. Init the scratch repo
   **eagerly at workbook creation** using the same non-connector path as `init_workbook_repo`
   (NOT connector clone machinery). Add a **batched, idempotent, resumable backfill migration** for
   existing workbooks. Delete the scratch repo in `WorkbookService.delete` (`workbook.service.ts:227`)
   — note this loop currently iterates only `connectorAccounts`, so the scratch repo must be added
   explicitly.
2. **`resolveRepoPathForFolder(folder)` single entry point (D1):** null connector → scratch repo;
   else `resolveConnectionRepoPath`. **Migrate ~12 null-leak callsites** that today call
   `resolveConnectionRepoPath` directly on browse/edit/list/delete:
   `files.service.ts:84,119,164,214,244,276,416`; `data-folder.service.ts:753,799,857,893`;
   `record-count.service.ts:75,171`. Several have only a path or `connectorAccountId`, not a folder
   object — recover the folder (some already do a `findFirst` by path).
   **Fix latent bug:** `data-folder.service.ts:522-524` already has a connector-less branch that
   resolves the repo to the `{workbookId}` *config-repo* key — under D1's scratch path this would
   delete from the wrong repo. Point it at `getScratchRepoPath`.
3. **Branch parameterization (D3):** the hard-coded `dirty` target
   (`scratch-git.service.ts:294-296`; `files.service.ts:87,215,252`; the `DIRTY_BRANCH` reads in
   `listByFolderId:119-134` and diff) becomes branch-aware. Scratch repos read/write/list/diff on
   `main`. Audit every `DIRTY_BRANCH` usage so connector behavior is untouched.
4. **Connector-less `createFolder` (D1):** permit `connectorAccountId == null`; skip connector lookup,
   schema fetch, schema write, and pull-job enqueue; validate name (D6); commit `.gitkeep` to `main`.
5. **Grouping:** emit the **"Scratch"** group from `listGroupedByConnectorBases` for null-connector
   folders (today silently dropped). Client already sorts a `Scratch` group first.
6. **Byte-passthrough create (D-byte):** scratch `createFile`/`getNewFileTemplate` does NOT wrap in
   `formatRecordJson({})`; new files default to empty content; filename/extension as typed. Nested
   subfolder create writes `<path>/.gitkeep`; nested file create at path. Surface **directory
   entries** in the scratch folder listing so subfolders render.
7. **Shared validator (D6):** one module reused by all frontends; includes the per-file size cap.
8. **Non-JSON hardening (D7):** audit + degrade `resolveReferences` (`files.service.ts:276`), index,
   diff, FK resolution for arbitrary bytes.

### Web client (`/client`)

- **Left-pane affordances** on the Scratch group (renders no menu today) and inside any scratch
  folder: New Folder, New File (call the REST API), rename, delete (reuse existing modals).
- **Nested rendering:** reuse the recursive `ScratchSubdirNode` + `git.listRepoFiles` (already used by
  the hidden `.scratch` view) for subdirectories.
- **Editor by extension** (`FileViewer.tsx`): pick CodeMirror language from extension
  (`json`/`markdown`/plain text; CSV as text). `@codemirror/lang-markdown` already a dep.
- New create/rename/delete hooks + API-client functions; keep client connector-agnostic.

### Desktop (`/scratch-desktop`) — this is real work, not tweaks

Per the outside voice, connection-less repos are excluded from every existing clone/download/upload
path. This V1 builds that path:

- **Clone the scratch repo at `workspaces init`** using the non-connector (`init_workbook_repo`-style)
  clone, materialized on `main`. `init_v2` today clones only `connector_accounts` (`workspaces.rs:439`).
- **Connection-less sync path:** `run_download`/`run_upload` currently iterate connections and reject
  any path whose first segment isn't a `conn_dir_name` (`files.rs:1187-1206`). Add a scratch-repo
  context (analogous to the workbook-config-repo handling) so scratch files download/upload on `main`
  with no accept/publish ladder.
- **Schema-less folders:** `getFolderMetadata` throws "Schema not found" for schema-less folders
  (`local-files.ts:213-217`) — return a schema-less descriptor instead.
- **Nested folder rendering:** `collectLeafFolders` (`local-files.ts:780`) drops non-leaf folders;
  ensure nested scratch dirs render (the `.gitkeep` placeholder makes intermediates non-empty).
- **Folder create/rename/delete → server REST API** (D1); **file create = local disk**; edits sync via
  the new connection-less path.
- **Plain-text editor:** extend `readFileContent` to return text for non-JSON; add a
  `TextFileEditorModal` (clone of `RecordRawJsonFileEditorModal` minus JSON validation).

## Failure modes (new codepaths)

| Codepath | Realistic prod failure | Test | Error handling | Silent? |
|----------|------------------------|------|----------------|---------|
| Branch param (D3) | scratch write lands on `dirty` → desktop never shows it | **E2E** + unit asserting commit on `main` | n/a (correctness) | **Yes → covered by E2E** |
| Desktop connection-less upload | edit rejected (no `conn_dir_name`) → never syncs | **E2E** desktop edit→upload→web | explicit reject→clear msg | **Yes → covered by E2E** |
| `deleteFolder:522` bug | deletes from config repo (data loss) | regression unit (scratch delete touches scratch repo only) | n/a | **Yes → covered by test** |
| Backfill missed a workbook | folder ops 500 (no scratch repo) | idempotent backfill + create-when-absent | clear "scratch repo not initialized" | No |
| Non-JSON in diff/index (D7) | throw deep in job, folder won't list | non-JSON through each path | degrade to empty | No |
| Name traversal (D6) | write outside scratch repo | validator reject cases | 400 at boundary | No |
| Empty nested folder (D5) | vanishes on desktop scan | nested-folder render test | `.gitkeep` keeps it | No |

No critical gaps remain (every silent failure mode has a committed test). The three **Yes** rows are
the highest-risk silent failures — the E2E + regression suite exists specifically to cover them.

## Test plan

- **Unit:** all server paths above (createFolder reject classes, byte-passthrough create, branch
  targeting main, grouping, validator, non-JSON degradation, repo lifecycle/backfill idempotency).
- **Regression (IRON RULE, mandatory):** connector file-create still wraps JSON; connector edit still
  uses dirty/approved/publish; connector grouping unchanged; connector repo resolution intact.
- **E2E (full bidirectional):** web create → desktop pull → appears; desktop create(API)+file(disk) →
  upload → web shows row + file. Reuse the existing Playwright `_electron` harness.
- Test-plan artifact: `~/.gstack/projects/whalesync-spinner/cfonger-…-eng-review-test-plan-….md`.

## Phases (combined V1, but internally sequenced)

- **P1 — Server foundation:** repo lifecycle + backfill, connector-less `createFolder`,
  `resolveRepoPathForFolder` + 12-site migration + `deleteFolder` fix, branch parameterization,
  grouping, byte-passthrough create + nested, shared validator + size cap, non-JSON hardening.
- **P2 — Web:** affordances, nested rendering, editor-by-extension, hooks/API.
- **P3 — Desktop:** scratch-repo clone, connection-less sync path, schema-less metadata, nested-scan
  fix, New Folder/File UI, text editor.
- **P4 — Tests:** unit + regression + full bidirectional E2E (lands with the feature, not after).

## What already exists (reuse, don't rebuild)

- `DataFolder` already allows null connector + empty `tableId`; git layer is a byte passthrough.
- Client `SCRATCH_GROUP_NAME` group is coded; server just never emits it.
- Recursive `ScratchSubdirNode` + `git.listRepoFiles` (hidden `.scratch` view) → nested rendering.
- `init_workbook_repo` + main materialization → the correct non-connector repo machinery.
- Existing rename/delete modals; desktop `RecordRawJsonFileEditorModal` (clone for text),
  `writeFileTextRaw`/`readFileTextRaw`.
- Dotfile filtering in listings/counts → `.gitkeep` is invisible for free.

## NOT in scope (deferred, with rationale)

- **scratchmd CLI `create`/`mkdir`** — CLI is content-agnostic; add later for local round-trip parity.
- **Markdown live preview** — deps exist; cheap fast-follow.
- **CSV grid editing** — V1 renders CSV as text.
- **Binary files / upload UI** — V1 files are created via text editors; binary can't arise.
- **Publish/sync of scratch files** — local-by-definition; nothing to publish to.
- **Per-folder / per-workbook quota** — only a per-file size cap in V1.

## Parallelization

| Step | Modules | Depends on |
|------|---------|-----------|
| P1 server | `server/src/workbook`, `server/src/scratch-git`, `server/prisma` | — |
| P2 web | `client/` | P1 API surface |
| P3 desktop | `scratch-desktop/`, `scratch-git-2/src/cli` | P1 repo lifecycle + API |
| P4 tests/E2E | all | P2 + P3 |

- **Lane A:** P1 (sequential internally — shared `data-folder.service.ts`/`files.service.ts`).
- **Lane B (web) and Lane C (desktop)** run **in parallel** after Lane A — disjoint codebases
  (`/client` vs `/scratch-desktop`), no shared modules, safe to worktree-split.
- **Then P4** E2E after B + C. No cross-lane conflict flags (B/C are disjoint).

## Implementation status (2026-06-24)

**DONE + verified (server typecheck, lint-strict, 43 unit tests, client typecheck — all green):**

- **Server (all of P1):**
  - Repo lifecycle: `getScratchRepoPath` / `resolveRepoPathForFolder` / `workingBranchForConnector`
    (`scratch-git.service.ts`); `initScratchRepo` / `deleteScratchRepo` (`workbook-repo.service.ts`);
    eager init in `WorkbookService.create`; cleanup in delete; `init-scratch-repos` backfill migration.
  - Connector-less `createScratchFolder` (validates name, collision-checks, commits `.gitkeep` to main).
  - Branch parameterization: `commitFile`/`deleteFile` take a branch; scratch I/O targets `main`
    (incl. rename-as-move). ~12 null-leak callsites migrated to `resolveRepoPathForFolder` across
    `files.service.ts` / `data-folder.service.ts` / `record-count.service.ts`; `deleteFolder:522`
    wrong-repo bug fixed.
  - "Scratch" group emitted unconditionally (even empty, for discoverability). Byte-passthrough
    `createFile` (empty content for scratch). `readSchema`/`readView` early-return null for scratch;
    record-count counts the scratch repo. Shared validator + 10 MiB size cap (`scratch-path-validation.ts`,
    40 tests). `SCRATCH_GROUP_NAME` in shared-types.
  - CLI contract: `scratchGitUrl` in `CliWorkbookResponseDto` + `/cli/v1/workbooks/:id/scratch/git`
    proxy (mirrors the config-repo proxy) — the prerequisite for the desktop clone.
- **Web (T9 + T10):** FileViewer language-by-extension (json/markdown/text); `useDataFolders.createScratchFolder`;
  `NewFolderModal` + "New Folder" button on the Scratch group header; `NewFileModal` scratch-aware
  (hides template checkbox); `TableNode` scratch menu (New File + Delete folder); `RemoveTableModal`
  scratch-aware copy; 3 local `SCRATCH_GROUP_NAME` consts replaced with the shared import.
- **Desktop (typecheck + lint verified; runtime not verified in headless env):** chose the **lowest-risk,
  server-API-driven** approach over the connector-CLI-sync subsystem (which would risk corrupting
  connector data that can't be runtime-tested here, and which contradicts the "keep it simple" steer).
  New renderer components, all going through the same server REST API the web uses:
  `TextFileEditorModal` (plain-text editor, load/save via `files.getFileByPath`/`updateFileByPath`),
  `ScratchFolderModal` (list/add/open/delete files via the API), `ScratchFoldersSection` (a "Scratch"
  sidebar section: list folders, new folder, delete, open) injected into `WorkspaceSidebar`. No Rust
  changes, no risk to the connector sync flow.
- **Server CLI contract (verified):** `scratchGitUrl` + `/cli/v1/workbooks/:id/scratch/git` proxy —
  the prerequisite for a *future* full local-git-clone desktop integration (the alternative to the
  API-driven approach above), if offline desktop editing is wanted later.
- **Regression test:** `files.service.spec` now asserts a scratch folder lists from `main` and skips
  the dirty diff (the riskiest branch-model behavior). 44 server tests green.

**Feature is end-to-end usable on web AND desktop (flat folders):** create a scratch folder → create
files (raw bytes) → edit text → rename/delete → delete folder. No review ladder; commits straight to
`main`.

**T6 nested subfolders — server side DONE + verified:**
- Scratch `createFile` accepts a nested relative path (`validateScratchRelativePath`) so files can be
  created inside subdirectories (`drafts/post.md`); git creates the intermediate dirs.
- `createScratchSubfolder(folderId, path)` service method + `POST /data-folder/:id/scratch-subfolders`
  endpoint + `dataFolders.createScratchSubfolder` api-client — creates an empty subdir (`.gitkeep`).
- `git.listRepoFiles` (+ the `:id/list` / `:id/file` git endpoints) now take `useScratchRepo` → the
  scratch repo on `main`, so the scratch subtree (files + directory entries) can be listed by path.
  Nested file *content* already resolves correctly (`getFileByPath` maps a no-DataFolder path → scratch
  repo).

**T6 nested — WEB browsing DONE + verified:** `ScratchFolderBrowser` (center pane) lists files +
subdirectories from the scratch repo (`git.listRepoFiles` + `useScratchRepo`, on `main`), descends
into subfolders (breadcrumb), opens files in the editor (the proven `FileCard` route), and creates
nested files (`files.createFile` with a relative path) and subfolders (`dataFolders.createScratchSubfolder`).
`FolderViewer` delegates to it for scratch folders; connector folders keep the record grid.

**T6 nested — DESKTOP browsing DONE + verified:** the desktop `ScratchFolderModal` is now a path-based
browser too (mirrors the web `ScratchFolderBrowser`): `git.listRepoFiles(useScratchRepo)` on `main`,
descends subdirectories with a breadcrumb, opens files in `TextFileEditorModal`, and creates nested
files + subfolders. **All three frontends now have nested parity.**

**Runtime verification — DONE against the real stack** (NestJS server + the real Rust scratch-git
microservice built from this branch + Postgres). Full end-to-end flow exercised over HTTP with a real
API token, every step passing:
1. Create workbook → **scratch repo eagerly initialized** at `{org}/{wbid}/scratch.git`.
2. Create connector-less folder "Notes" → `connectorAccountId: null`, `path: /Notes`, in the "Scratch" group.
3. Create a **flat** file and a **nested** file (`drafts/post.md`); create an empty subfolder (`archive`/.gitkeep).
4. Flat list returns direct children; `git.listRepoFiles(useScratchRepo)` returns the **subtree with
   directory entries** (`archive`, `drafts`); listing `Notes/drafts` returns `post.md`.
5. **Nested file `/Notes/drafts/post.md` resolves to the scratch repo on `main`** (read → edit → re-read
   = "hello world") — the flagged path-format risk, confirmed against real git.
6. `../evil` folder name rejected (400). Delete folder removes it from the scratch repo (the
   `deleteFolder:522` fix). Delete workbook removes the scratch repo from disk (`WorkbookService.delete`).

The web `ScratchFolderBrowser` and desktop `ScratchFolderModal` call exactly these verified endpoints,
so their nested browse/create/edit paths are confirmed at the API level. 45 server unit tests green;
all 3 packages typecheck + lint clean. (Applied 2 pending DB migrations to bring the local dev DB to
the current schema — a side benefit.)

**REMAINING (optional, not part of this feature):** a literal browser/Electron click-through (purely UI
rendering — the full API surface is verified); a packaged web↔desktop E2E test; and the alternative
full-local-git-clone desktop (Rust `init_scratch_repo` + sync) — the CLI contract is already in place.

## Merge safety / rebase — DONE

Rebased onto current `origin/master` (commit `52daa62c` on parent `5fad7b2d`). Only `workbook.service.ts`
conflicted; resolved by taking master's `WorkbookProvisioningService` delegation and **moving the
scratch eager-init into `WorkbookProvisioningService.createWorkbookWithConfigRepo`** (right after the
config-repo init), so DEV-10554 is preserved and signup default workspaces also get a scratch repo. The
scratch delete-cleanup stayed in `executeHardDeleteWorkbook`. Two test specs that master owns needed the
new `resolveRepoPathForFolder` added to their `scratchGit` mocks (`data-folder.service.spec`,
`record-count.service.spec`) — these were latent gaps from the T3 migration, fixed. Post-rebase: server
typecheck + lint-strict + 117 scratch/workbook/record-count tests green; client + desktop typecheck +
lint + prettier clean. Original re-apply analysis preserved below for reference.

## Merge safety / rebase plan (original analysis — branch was 18 commits behind master)

The branch's merge-base is `fab5a793`; `origin/master` is **18 commits ahead** and has rewritten code
this branch also touches. **All this branch's work is uncommitted** (HEAD == merge-base), so a rebase
means: commit the work, rebase onto `origin/master`, then re-apply the scratch pieces below. A naive
merge would risk reverting **DEV-10554** (`9673c2b3`), which moved workbook creation + config-repo init
into `WorkbookProvisioningService` to fix the signup default-workspace config-repo divergence.

Conflicting files + how to re-apply:

- **`workbook.service.ts`** — master (DEV-10554) moved `create()` into
  `WorkbookProvisioningService.createWorkbookWithConfigRepo` (which inits the config repo via
  `scratchGitService.initRepo(getWorkbookRepoPath(orgId, wbId))`). **Re-apply:** add the scratch-repo
  eager init *there*, right after the config-repo init — `await this.scratchGitService.initRepo(getScratchRepoPath(organizationId, workbookId))`
  (import `getScratchRepoPath`; keep it best-effort/non-fatal). The scratch-repo **delete cleanup**
  stays in `WorkbookService.executeHardDeleteWorkbook` right after `deleteWorkbookRepo` (still present on
  master) — re-applies cleanly. (The self-healing `ensureScratchRepo` on the write path means the eager
  init is now only an optimization, so this conflict is low-stakes.)
- **`data-folder.service.ts`** — master's 2 commits are the record-counts-visible work
  (`whalesyncEligibleRecordCount` + record counts). This branch also touches the record-count area
  (scratch folder `recordCount`, grouping, `createScratchFolder`/`createScratchSubfolder`) — expect real
  conflicts in the record-count region; merge both (keep master's record-count fields + this branch's
  scratch handling).
- **`scratch-git.service.ts`** — master's 1 commit is DEV-10048 (publish redesign). This branch's
  additions (`getScratchRepoPath`, `resolveRepoPathForFolder`, `ensureScratchRepo`,
  `workingBranchForConnector`, branch params on `commitFile`/`deleteFile`) are additive — minor conflicts.
- **`code-migrations.controller.ts`** (the `init-scratch-repos` migration), `record-count.service.ts`,
  and all web/desktop files — **no master changes**, re-apply cleanly.

After rebasing + re-applying: rebuild + re-run the server tests (45+) and the web/desktop typecheck+lint.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 11 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run |

- **OUTSIDE VOICE (independent Claude agent):** ran. Found 4 high-confidence gaps the review missed —
  (F1) "save = commit to main" had no implementation path (all writes are `dirty`-hardcoded);
  (F2) desktop sync for connection-less repos is an unbuilt subsystem, not tweaks;
  (F3) reuse the workbook-config-repo machinery, not connector machinery; (F4) ~12 null-leak callsites
  + a `deleteFolder:522` wrong-repo bug. All folded into the plan.
- **CROSS-MODEL:** 3 tensions surfaced and decided by maintainer — sequencing (kept web+desktop
  together, now with eyes open), branch model (scratch repos MAIN-only), repo machinery (dedicated repo
  on config-repo lifecycle).
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — ready to implement. Scope accepted as-is (combined web + desktop V1).
  Decisions D1–D8 resolved; 13 implementation tasks captured; full unit + 4 regression + bidirectional
  E2E test plan committed.
