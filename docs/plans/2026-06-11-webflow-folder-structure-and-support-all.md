# Webflow: site-grouped folder structure + all-workbooks migration (DEV-9698)

**Date**: 2026-06-11
**Status**: In Progress
**Author**: Curtis Fonger
**Linear**: [DEV-9698](https://linear.app/whalesync/issue/DEV-9698/proposal-support-all-of-webflow)

## Implementation progress

| Task                                         | Lane | Status                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ---- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T3** Connector nested layout + version pin | W1   | ✅ **Done** — merged to master (`263f7ba4`)                                              | New file `webflow-folder-paths.ts`; `BaseJsonTableSpec.structureVersion`; `createFolder` stamps it (no service branch); registration `version: 2`; 13 new tests + 145 webflow tests + typecheck + lint-strict + prettier green. C1 drift-guard test deferred to T2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **T1** scratch-git `move_folder`             | W2   | ✅ **Done** (uncommitted, branch `webflow-support-all-v1`)                               | New `move-folder` route + `perform_move_folder` core in `write.rs`; `GitRepo::list_blob_paths_under` in `repo.rs`; route registered in `mod.rs`; `moveFolder` on NestJS `scratch-git.client.ts` + `scratch-git.service.ts`. 12 new cargo tests; full crate suite (271+339+417+2+16) green; `cargo fmt` clean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **T2** Migration                             | W3   | ✅ **Core done + review-fixed + DB-integration-covered** — merged to master (`f252a269`) | Pure per-folder engine + atomic 7-column rewrite + ordering + account-flip + `dryRun`, wired into `code-migrations` controller as `webflow-folder-restructure`. **Three review fixes applied** (see T2 task block): (1) the 5 record-path columns store **no leading slash** — the executor now matches their no-slash form (was matching the leading-slash form → silently rewrote nothing); (2) every run is now **account-atomic** so a qty-batch split can't wedge a "Collections"-named collection; (3) `logAudit` is best-effort (a post-commit audit failure no longer misreports a migrated folder as errored). 85 code-migrations tests green; typecheck + build (14/14) + lint-strict + prettier clean. **De-risk follow-up (2026-06-14, uncommitted on `webflow-support-all-v1`):** the atomic raw-SQL rewrite was extracted to `webflow-folder-restructure-path-rewrite.ts` (controller now delegates; behavior-identical) and is now covered by a **real-Postgres integration test** (`test/integration/webflow-folder-restructure-db.spec.ts`, 3 tests) that runs the _actual_ shipped SQL against seeded rows + decoys — pins #9 dest-side resolution, #10 boundary-prefix safety, dataFolderId/account scoping, the no-leading-slash convention, and `$transaction` atomicity (mid-txn failure rolls back DataFolder too). **Deferred:** the T4 quiesce wrapper, and live-pipeline E2E (publish/sync interleave). Run only on an idle connection until T4 lands. |
| **T4** Per-connection quiesce                | W3   | ✅ **Done** — merged to master (`470afb09`)                                              | New `ConnectorAccount.migrationLockedAt` + `Schedule.disabledForMigrationAt` columns (migration `20260615110245`). New `MigrationLockService` (lock/unlock + `assertConnectionNotMigrating` edit gate + `assertEnqueueAllowedForJob` enqueue gate, fast-path no-op) wired into the write paths (files.service CRUD, CLI upload-patch commit) and the single enqueue chokepoint (`BullEnqueuerService.createAndEnqueue`). New `ConnectionQuiesceService` orchestrates acquire (lock → disable+mark schedules → cancel non-terminal PublishPlans → cancel+drain in-flight jobs, waiting for the BullMQ `active` set to clear) and release (restore marked schedules → unlock → `workbook-updated` event). `ScheduleService` disable/restore is **marker-driven → crash-safe** (#11); `PublishPlanBuildService.cancelNonTerminalPlansForConnection`; `JobService.systemCancelJob`/`getNonTerminalJobsForWorkbook`/`getActiveBullJobDatas` drain primitives. `runWebflowFolderRestructure` refactored to **per-account**: quiesce → migrate folders → flip version (while locked) → release in `finally`; a connection that won't drain in time is **released + skipped** (retried later); dryRun skips quiesce. 82 unit + 4 DB-integration tests; `main.spec` (full AppModule boot) green; typecheck + lint-strict + prettier clean. Reusable playbook documented in CONNECTOR_GUIDE.md §9.                                                                                         |
| **T5** Desktop/CLI salvage + re-clone        | W4   | ✅ **Done** (uncommitted)                                                                | P2. **Generic version-pin detection (no connector knowledge in the CLI frontend):** the migration flips `ConnectorAccount.version` 1↔2 when a connection's folders restructure; the server now exposes `version` per connector account in the CLI workbook DTO (`cli-workbook.controller.ts`/`.dto.ts`), the CLI records it in the workspace marker at `init` (`ConnectionEntry.structureVersion`) and compares it against the server's current value on **download** (`detect_structure_version_drift`) — a mismatch (scoped to the connections actually being downloaded) emits a structured `workspace_needs_reinit` (reason `structure_changed`) and **bails before re-anchor/materialize** so a stale clone's `accepted-patches.json` is never mangled by the folder move. `0`-on-either-side = "unknown" → never trips. **Non-destructive salvage:** `init --force` now **moves** an existing workspace with un-uploaded approved work (or an unparseable `accepted-patches.json`) to `<name>.salvaged-<ts>` instead of deleting it (one atomic rename preserves worktree edits + accepted patches; protects pre-T5 clones too); `find_existing_workspace` skips `.salvaged-` backups so a 2nd `--force` can't clone into an occupied dir. **Actionable error:** the server's `outside-data-folder` reject message names the likely cause (server restructured folders / stale local copy) + the re-clone recovery (code + prefix unchanged so asserts pass). **Desktop:** `reason` threaded through the existing reinit IPC + tailored modal copy. The re-clone messaging is **honest + actionable** (review fix): salvage only backs up a workspace with edits *staged for publish*, so the copy promises exactly that and tells the user to accept/publish other in-progress changes first — it does NOT claim "nothing discarded" (un-accepted working-tree edits would be lost). Aligned across modal + CLI recommendation + server `outside-data-folder` message. **Verify:** 13 new Rust unit tests (drift detection ×6, marker round-trip/back-compat ×2, salvage/find-existing ×8) + 3 review-fix tests; 5 server tests (cli-workbook version mapping + actionable-message); 1 desktop parse test. Full crate suite (271+343+433+2+16) + server typecheck + lint-strict + desktop build + lint + prettier + root build all green. **Limitation (documented):** pre-T5 clones (marker version 0) don't get download-detection — they rely on the actionable upload error + salvage-on-reclone. The version pin is the connector *code* version, so a hypothetical future non-structural connector bump would also (safely, non-destructively) prompt a re-clone. |
| **T6** Inverse/rollback migration | — | ✅ **Done** (uncommitted, branch `webflow-support-all-v1`) | New `webflow-folder-restructure-inverse` migration (un-nests v2→flat v1; flips `DataFolder.version` + `ConnectorAccount.version` 2→1; "Collections"-named reverts LAST per site). **Required a scratch-git change:** `move_folder` now handles **new-is-prefix-of-old** symmetrically — the inverse "Collections"-named move `…/Collections/Collections`→`…/Collections`, where the destination is an _ancestor_ of the source; the destination-collision guard excludes the source subtree. New `webflow-folder-restructure-inverse-backfill.ts` reuses the forward primitives; `applyWebflowFolderMovePathRewrite` parameterized by target version (no SQL drift). 33 inverse unit + 3 controller-orchestration + 1 DB round-trip integration + 4 new cargo tests; build 14/14 + root lint + lint-strict + prettier + `main.spec` + `cargo fmt`/full crate suite green. |
| **T7** Pages SEO completeness                | —    | ✅ **Done** (uncommitted, branch `webflow-support-all-v1`) | **Verification + regression guard — nothing to add.** Audited the live Webflow Data API (GET + PUT `/pages/{id}`): the entire writable SEO surface is `title`, `slug`, `seo.{title,description}`, `openGraph.{title,titleCopied,description,descriptionCopied}` — all already in the schema, editable, and forwarded by the `updateRecords` pages branch. **Open Graph image, canonical URL, and search-visibility/noindex do not exist in the Data API** (Designer-only, same boundary as page body). Closed the test gap: new `webflow-connector-pages-update.spec.ts` (5 tests) pins the SEO/slug/OG publish round-trip; strengthened `webflow-pages-json-schema.spec.ts` to assert every SEO/OG subfield is present **and editable** + the 6 read-only fields stay read-only; documented the API-impossible fields in the schema docstring. 158 webflow tests green; changed files lint-strict + prettier clean. |

## Problem

Webflow customers want to manage more than just their CMS — page SEO metadata,
assets, and pages — all for SEO. Several customer calls asked for this.

The good news from a code audit: **most of the data is already pulled.** The
Webflow connector already exposes three entity types — CMS Collection Items
(read-write), Assets (read-only), and Pages (metadata: title / slug / SEO /
Open Graph editable) — see `webflow-connector.ts:117` (`listTables`). What's
missing is **structure**, not raw capability: today every table lands as a sibling
under the site, with no grouping that matches how Webflow itself is organized
([Webflow data structure](https://developers.webflow.com/data/reference/structure-1)).

We want the on-disk / in-app tree to mirror what the user sees in Webflow:

```
BEFORE (flat)                          AFTER (site-grouped)
/<Site>/                               /<Site>/
  ├─ Blog Posts/                         ├─ Assets/
  ├─ Team Members/                       ├─ Pages/
  ├─ Assets/        ← collision risk     └─ Collections/
  ├─ Pages/         ← collision risk          ├─ Blog Posts/
  └─ Assets-a3f9c/  ← a CMS collection         ├─ Team Members/
                       named "Assets"          └─ Assets/   ← safe: disjoint namespace
```

(The Webflow **connection** already gets its own repo, so the connection name is
effectively the top level; we are not adding a literal `/Webflow/` segment.)

### This also fixes a latent collision bug

Today CMS collections are created at `/<Site>/<Collection>` while the synthetic
Assets/Pages tables are created at `/<Site>/Assets` and `/<Site>/Pages`
(`webflow-connector.ts:148,167`). A CMS collection named **"Assets"** or **"Pages"**
collides with the synthetic folder, and `ensureUniquePath` (`data-folder.service.ts:595`)
just appends `-{last5ofId}`, producing a garbage path like `/My Site/Assets-a3f9c`.
Nesting collections under `/Collections/` removes the collision **by construction**.
Call this out on the ticket — it's a real correctness fix, not only cosmetics.

## Scope (confirmed with maintainer)

- **In scope**: the nested folder structure, applied to **all existing Webflow
  workbooks via a migration**, plus a verification pass that Pages **SEO metadata**
  editing is complete.
- **"Pages content editing" = SEO metadata only.** The Webflow Data API can only
  write page _body_ (DOM) content for **secondary locales** — primary-locale page
  content is Designer-only, no API
  ([Update Page Content](https://developers.webflow.com/data/reference/pages-and-components/pages/update-static-content),
  [Localization](https://developers.webflow.com/data/docs/working-with-localization)).
  Body-content editing is **out of scope**. The SEO metadata users actually want
  (meta title, meta description, Open Graph, slug) is **already editable today**.
- **Migration strategy**: mutate `DataFolder.path` **in place** (keep the id, so all
  sync pairs, FK maps, and schedules keyed by DataFolderId keep working).
- **No mixed-layout window — use the existing version pin (eng review, supersedes the
  earlier "ship together / accept mixed state" idea).** Bump the Webflow connector
  version to 2 (DEV-10302, `ConnectorRegistration.version` → snapshotted onto
  `ConnectorAccount.version`). Existing accounts stay pinned to **v1 = flat**; the
  migration flips an account to **v2 = nested** only after all its folders are moved.
  A connection is therefore atomically all-flat or all-nested, never mixed.
- **Local CLI / desktop**: **forced re-clone**, but only after **salvaging
  un-uploaded local work** (see Client/desktop).

---

## Phase 0 — Connector emits nested layout for v2 accounts

Make Webflow folder creation honor the account's structure version. Assets and Pages
**never move** (they stay at `/<Site>/Assets`, `/<Site>/Pages`); only collections gain
the `/Collections/` parent, and only for v2 accounts.

All three builders currently share `basePath: [site.displayName ?? site.shortName ?? '']`
(`webflow-json-schema.ts:258` collections, `:323` assets, `:401` pages); the on-disk
path is built by `buildConnectorFolderPath` (`data-folder.service.ts:785`).

1. **Bump the connector version + wire a structure version.** Set Webflow's
   `ConnectorRegistration.version = 2` (`connector-registry.ts`). The connector reads
   its account's pinned version and emits the matching layout. Replace the hardcoded
   `version: 1` stamp in `createFolder` (`data-folder.service.ts:361`) with a
   **tableSpec-declared structure version** (no `if (service === WEBFLOW)` in
   `DataFolderService`) — finding #14.

2. **Single source of truth for the v2 collection path** (C1). One helper,
   `webflowCollectionBasePath(site)` → `[siteName, 'Collections']`, used by **both**
   the Phase 0 connector spec **and** the Phase 1 migration's target-path computation,
   so the two can never drift. For v1 accounts the connector keeps `[siteName]`.

3. **Collection on-disk path** — `webflow-json-schema.ts:258`: pick `basePath` from the
   helper based on account version. Assets (`:323`) / Pages (`:401`) stay `[siteName]`.

4. **Picker preview grouping** — `webflow-schema-parser.ts:13` (`parseTablePreview`):
   group v2 collection previews under `<site>/Collections` so the picker matches the
   post-pull tree. v1 previews + Assets/Pages keep `parentPath: site.displayName`. Prior
   art: `docs/plans/2026-04-11-unify-picker-grouping-and-workbook-hierarchy.md`.

5. **Discriminate collection vs Assets/Pages by `tableId` prefix** (`__assets__` /
   `__pages__`, `webflow-types.ts`), **never by name or path** — a collection named
   "Assets" exists at a suffixed path today (finding #13).

The client tree and desktop render generically from `DataFolder.path`, so the nested
structure appears with **no frontend connector code** — "keep connector knowledge out
of the frontends."

---

## Phase 1 — Migrate all existing Webflow workbooks

A one-time, admin-triggered, batched, **idempotent**, **crash-safe** migration that
re-parents every existing Webflow **collection** folder to `/<Site>/Collections/<Collection>`.
Assets/Pages folders are untouched.

> **Idempotent** = running twice converges, no double-move/corruption. **Crash-safe** =
> a process death at any step leaves state a re-run can finish.

### Home: the existing code-migrations framework

Register a migration in `server/src/code-migrations/` (admin-gated `POST /code-migrations/run`,
with `dryRun` + `qty`/`ids` batching + audit logging). Model on
`notion-data-source-backfill.ts`.

### Per-connection ordering (quiesce → move → flip)

```
per connection batch:
  Q1. capture + disable the connection's Schedules, PERSISTING prior enabled state   [#11]
  Q2. cancel/invalidate every non-terminal PublishPlan for the connection            [#1]
  Q3. drain in-flight jobs, dequeue enqueued BullMQ jobs, BLOCK live user edits       [#6]
      (web saves + desktop /upload-patch/commit write to dirty after a request-time
       path check — a write racing the move orphans at the old path)

  for each Webflow collection DataFolder (account still v1, version < 2),
      ORDERED so a collection literally named "Collections" migrates FIRST in its site:  [Ordering]
    a. NEW PATH = dirname(existing path) + '/Collections/' + escape(DataFolder.name)  [#5]
         • handle old-is-PREFIX-of-new (collection literally named "Collections")     [#4]
         • run through ensureUniquePath → re-suffix ONLY on a genuine collision        [A2]
         • skip-with-warning any unexpected path shape (≠ 2 segments, empty seg)       [#5]
    b. git move_folder old→new on BOTH main + dirty                                    [A1,#8]
         • idempotent: src absent + dst present → no-op (not error like rename:597)
         • refuse when src AND dst both exist with DIFFERING content; verify dst empty
         • asymmetric branches: move whatever's present on each; dirty-only / main-only
         • missing repo → 404 error; pulled-but-empty → 200{files:[]} no-op
    c. ONE ATOMIC Postgres txn:                                                        [Tension 1]
         DataFolder.path        := new                (in place, id stable)
         FileIndex.folderPath   := new                (EXACT-match updateMany)
         FileReference.sourceFilePath  prefix-rewrite (BOTH branches, LIKE-escaped)    [#10]
         SyncMatchKeys.filePath        prefix-rewrite (source + DEST side)             [#9]
         SyncRemoteIdMapping.destinationFilePath  rewrite via SyncTablePair.destinationDataFolderId  [#9]
         RecreatedIdMap.folder         rewrite
         UploadPatchMeta.filePath      prefix-rewrite
         DataFolder.version     := 2                  ← idempotency commit point
    d. audit-log old→new
  Q4. flip ConnectorAccount.version := 2  (AFTER all folders migrated)                 [#7]
  Q5. emit a "folder moved" workbook event (open web clients refresh)                  [#16]
  Q6. re-enable Schedules to their PERSISTED prior enabled state                       [#11]

crash anywhere → re-run: account still v1 (or partial), skips version=2 folders,
finishes the rest, flips account, repairs schedule state. Every step idempotent.
```

### Move ordering constraint — a collection named "Collections" migrates first (Ordering)

**Surfaced by the T1 implementation, not a T1 bug — the nested-folder refusal is correct;
this is an ordering obligation the migration must honor.** `move_folder` refuses to move any
data folder whose recursive blob listing contains a nested folder (a relative path with a `/`),
because the migration updates one `DataFolder` row at a time and a wholesale subtree move would
orphan a nested folder's DB path.

For the prefix case — a collection literally named **"Collections"** at `/<Site>/Collections`
moving to `/<Site>/Collections/Collections` — this interacts with sibling moves. Every other
collection in the site moves _into_ `/<Site>/Collections/<Coll>`, so once any sibling has moved,
`list_blob_paths_under("<Site>/Collections")` surfaces those relocated siblings (`Blog/rec.json`,
`Team/rec.json`, …) as nested paths. `move_folder` then refuses to move the "Collections"
collection — it looks like a folder containing nested folders.

> T1's prefix handling only excludes blobs already under the _destination_
> (`/<Site>/Collections/Collections`); it does **not** exclude sibling collections parked
> elsewhere under `/<Site>/Collections/`. So the refusal fires unless ordering prevents it.

**Therefore: within each site, migrate the "Collections"-named collection (the prefix case)
before any of its siblings.** When it moves first, `/<Site>/Collections` still holds only its own
records (no nested siblings yet) and the move succeeds; subsequent sibling moves then nest
cleanly beside the already-relocated `/<Site>/Collections/Collections`. Concretely: sort each
site's collection batch so any folder whose path equals `dirname(path) + '/Collections'` sorts
first. (Re-runs stay safe — once moved, the "Collections" collection's source converges to a
no-op regardless of order.)

### Why rewrite, not rebuild (Tension 1 decision)

A folder move changes **paths, not contents**. `FileIndex.folderPath` _is_ the folder
path (key `[workbookId, folderPath, recordId]`, `schema.prisma:496`) → an **exact-match
`updateMany`**, the precedent at `files.service.ts:417-429`. `FileReference.sourceFilePath`
is a prefix rewrite (targets are remote IDs — `schema.prisma:506` — so unmoved folders
hold no stale references). Both rewrites therefore join the **same atomic txn** as
`DataFolder.path` + `version`, collapsing the DB side into **one commit** and erasing
the crash window a separate "rebuild" step would create (finding #2). Rebuild would
reintroduce `recordId` derivation + a dirty-only/main-only branch ambiguity for no gain.

### Path-rewrite correctness details

- **One rewrite helper** (C1) encodes: exact vs prefix, the leading-slash convention
  (`FileIndex.folderPath` has **no** leading slash; `DataFolder.path` does), and a
  **prefix-safe, LIKE-escaped** match — `path = old OR path LIKE old || '/%'`, escaping
  `%`/`_` (finding #10; `/Site/Blog` must not match `/Site/Blog Posts`).
- **Sync side-awareness** (#9): `SyncRemoteIdMapping.destinationFilePath` and
  `SyncMatchKeys.filePath` rows for a _destination_ Webflow folder are keyed by the
  **source** folder's id. Resolve affected rows via `SyncTablePair.destinationDataFolderId`,
  not just `WHERE dataFolderId = migratedFolder.id`.
- **Compute path from persisted data** (no `metadata` column on `DataFolder`; `tableId`
  is remote IDs). Use `dirname(existing path)` for the site/parent segment(s) — robust
  to ≥3-segment paths (folder under a parent, `data-folder.service.ts:341`) and
  escape-emptied site names — and `DataFolder.name` for the clean leaf (repairs the
  `-{id5}` suffix for free, since the suffix only ever lands on `path`).

### `move_folder` idempotency contract (A1, #4, #8)

Model on `rename` (`write.rs:548`, main+dirty atomic, OID-preserving) but re-parent a
subtree, and: no-op when src absent + dst present; **handle old-is-prefix-of-new** (a
collection named "Collections": `/Site/Collections` → `/Site/Collections/Collections`,
where the simple "absent" check can't fire); **refuse to move a folder that has another
DataFolder nested under it**; refuse src+dst both-exist-differing; verify dst empty
before moving (covers the git-ahead-of-DB crash in #8); distinguish missing-repo 404 from
pulled-empty `200{files:[]}` (learnings `sync-dest-not-pulled-404`,
`upload-patch-commit-500-missing-repo`). Expose via `scratch-git.service.ts` +
shared-types api-client.

### Rollout: canary + reversibility (A4)

- **Canary**: migrate 1–2 internal / low-risk workbooks first (via `ids`), verify tree +
  sync + publish, then batch the rest.
- **Reversible**: the transform is invertible (new→old strips `/Collections/`); the
  inverse migration is the rollback (gated `version 2→1`) **and** flips
  `ConnectorAccount.version` back to v1 so the connector reverts emission too (finding
  #15). The inverse must handle the "Collections"-named mirror case.

---

## scratch-git changes (`/scratch-git-2`)

Add `move_folder` (the contract above) to `write.rs`, modeled on `rename`. Reuse the
OID-preserving approach so record git history follows the move.

---

## Pages SEO metadata (verification — likely already shipped)

Already editable (`disabledReason: 'Page metadata only — title, slug, SEO, and Open
Graph fields are editable'`, `webflow-connector.ts:166`; `PUT /pages/{id}`). This is a
**verification checklist**: confirm meta title / description / Open Graph / slug are
surfaced end-to-end; add any missing customer-named SEO field to the Pages schema
(visible error if Webflow rejects, per "surface failures"); file a follow-up rather than
expanding this plan if a larger gap appears. No body/DOM content.

---

## Client / desktop

- **Web**: no connector change — tree renders from `DataFolder.path`. Verify the
  intermediate `Collections` node renders as a **container** (children, no records — no
  `DataFolder` row for it). The "folder moved" event (Q5) refreshes open clients so
  in-memory paths don't go stale (#16).
- **Desktop / `scratchmd` CLI**: forced re-clone, **non-destructively** (#12, #17):
  - **Salvage first**: detect un-uploaded local edits + `accepted-patches.json` review
    state and export/upload them before wiping — re-clone must not silently destroy work
    ("default to non-destructive, reversible").
  - **Detection signal**: a workbook-level structure marker the CLI/desktop checks on
    fetch/pull; on mismatch, stop and instruct re-clone with a clear message. Note the
    server **already rejects old-path uploads** (`apply-patches.service.ts:50-57`) so a
    stale old binary fails **loudly**, not silently — the real gap is **error quality**,
    so make that message actionable.

---

## Tests

### Connector unit

- v2 account: collection → `/<Site>/Collections/<Collection>`; Assets/Pages unchanged.
- v1 account: still flat (version pin).
- Collection named "Assets"/"Pages" no longer collides.
- **(C1 drift guard)** connector v2 path == migration's recomputed path for one folder.
- **(#13)** collection vs Assets/Pages discriminated by `tableId` prefix.

### Migration unit

- N collections migrate; `DataFolder.version` 1→2; `ConnectorAccount.version` flips to 2
  only after all folders done; Assets/Pages untouched.
- **(REGRESSION)** `Assets-a3f9c` → clean `/<Site>/Collections/Assets`.
- **(A2)** colliding recomputed paths → `ensureUniquePath` re-suffixes exactly one.
- **(#4)** collection named "Collections" (old path prefix of new) migrates once; re-run
  no-op; nested-DataFolder-under-moving-path refused.
- **(Ordering)** a site with a "Collections"-named collection **plus** siblings migrates with
  the prefix-case collection first → no `move_folder` refusal; verify a wrong order (sibling
  first) would refuse, and that the migration sorts to avoid it.
- **(#5)** folder under a parent (≥3 segments) keeps its site; escape-emptied site → skip-warn.
- **Idempotency**: re-run no-op. **Crash-safety**: partial run (git moved, txn not
  committed) converges; partial connection (some folders v2, account still v1) converges.
- **(Tension 1)** all 6 path columns + version in ONE atomic txn; FileIndex exact-match;
  FileReference prefix rewrite on **both** branches; `dataFolderId`-keyed rows untouched.
- **(#9)** destination-side sync rows (folder as sync _destination_) rewritten via
  `SyncTablePair.destinationDataFolderId`.
- **(#10)** prefix-safe rewrite: `/Site/Blog` move does not touch `/Site/Blog Posts`.
- **(#1)** a non-terminal `PublishPlan` for the connection is cancelled by the migration;
  a resumed plan never commits to old paths.
- **(REGRESSION)** sync + publish on a migrated collection still work (id-keyed).
- **(A4)** inverse restores paths + flips account v2→1; round-trip converges.

### scratch-git unit (`write.rs`)

- `move_folder` re-parents on both branches, preserves OIDs, atomic.
- **(A1)** src absent + dst present → no-op; asymmetric dirty-only / main-only; dirty
  blob ≠ main blob both preserved; missing repo 404 vs pulled-empty 200{files:[]}.
- **(#8)** src+dst both exist differing → refuse; verify dst empty.

### Integration / E2E

- **(A3/#6 →E2E)** during a connection's batch: scheduled fire deferred, in-flight job
  drained, enqueued job dequeued, a live web save / `/upload-patch/commit` rejected;
  all succeed after re-enable. ✅ **Done** — `server/test/integration/webflow-migration-live-pipeline.spec.ts`
  drives the real `ConnectionQuiesceService.quiesceConnection`/`unquiesceConnection` against real
  Postgres with seeded `PublishPlan`/`DbJob`/`Schedule` rows: it asserts the connection's non-terminal
  publish plan + its in-flight publish & sync jobs are cancelled (the sync job's connection resolved
  through real `SyncTablePair` FKs), a sibling connection's plan/job in the same workbook survive
  (cancel + gate are connection-scoped), both gates (`assertConnectionNotMigrating` + the enqueue gate
  `assertEnqueueAllowedForJob`) reject with 409 while locked, the enabled schedule is disabled+marked
  (user-disabled left alone), and after release the lock clears, both gates pass, the schedule is
  restored, a `workbook-updated` event fires, and the cancelled work stays cancelled. A second test
  pins the **drain-timeout / abort-and-skip** contract: a worker that never stops fails the drain with
  `ConnectionDrainTimeoutError` while STILL holding the lock (the migration releases-and-skips in its
  `finally`). The only stubbed seam is `JobService.getActiveBullJobDatas` (the live BullMQ `active`
  poll — no worker runs in a test); seeded jobs carry no `bullJobId`, so `systemCancelJob` takes its
  pure-DB path. Requires the localdev Postgres (`yarn test:integration`); no Redis/scratch-git needed.
- **(#11)** a user-disabled schedule stays disabled after the batch; crash mid-batch →
  re-run repairs schedule state. ✅ **Done** — the "user-disabled stays disabled" half is asserted in
  the live-pipeline spec above; the marker-driven crash-repair re-run is pinned in
  `connection-quiesce-db.spec.ts`.
- **(#12 →E2E)** stale desktop clone with un-uploaded edits: salvage runs before re-clone;
  no work lost. — Desktop/CLI (T5), covered by the Rust unit tests; the live salvage-before-wipe
  remains a manual canary gate.

### Client unit

- Intermediate `Collections` node renders as a container (children, no records).

### Build/lint/typecheck

`yarn build`, `yarn lint`, `yarn lint-strict` (server), `yarn typecheck`; `cargo fmt` +
`cargo test` (scratch-git-2).

### Manual

Real Webflow workbook (≥2 collections, one named "Pages", + assets + pages): `dryRun`,
canary one workbook, then live; verify tree, sync/publish on a migrated collection, and
the desktop salvage-then-re-clone path.

---

## Failure modes

| Codepath                                                   | Realistic failure                                         | Test?         | Handling                                      | User sees         |
| ---------------------------------------------------------- | --------------------------------------------------------- | ------------- | --------------------------------------------- | ----------------- |
| pre-migration publish resumes                              | commits result files to OLD path on main                  | ✅ #1         | cancel non-terminal plans                     | nothing           |
| move_folder re-run after crash                             | `rename`-style throw on missing src                       | ✅ A1         | no-op contract                                | nothing           |
| "Collections"-named collection                             | prefix-of-new → double-move                               | ✅ #4         | prefix handling                               | nothing           |
| "Collections"-named collection migrated after its siblings | relocated siblings look nested → `move_folder` refuses it | ✅ Ordering   | migrate prefix-case collection first per site | nothing           |
| path recompute drops suffix                                | re-collision → 2 folders, 1 dir → data loss               | ✅ A2         | ensureUniquePath                              | nothing           |
| live write during migration                                | orphan at old path                                        | ✅ #6         | drain + block edits                           | "connection busy" |
| dest-side sync rows                                        | missed by source-keyed rewrite → broken sync              | ✅ #9         | SyncTablePair.destination                     | nothing           |
| prefix over-match                                          | `/Blog` clobbers `/Blog Posts`                            | ✅ #10        | LIKE-escaped prefix                           | nothing           |
| schedule re-enable                                         | clobbers user-disabled schedule                           | ✅ #11        | persist + repair                              | prior state kept  |
| stale desktop clone                                        | un-uploaded edits wiped                                   | ✅ #12        | salvage first                                 | re-clone prompt   |
| bad prod batch                                             | irrecoverable in-place move                               | manual canary | inverse + version flip                        | —                 |

No failure mode is left silent-AND-unhandled-AND-untested.

---

## NOT in scope

- **Secondary-locale page body content** (DOM) — multi-locale only; deferred.
- **Primary-locale page body content** — **API-impossible** (Designer-only).
- **Asset editing** — Webflow assets largely immutable; variants/`folderId`/writable
  `altText` are a follow-up.
- **P2 entities** — Ecommerce (filtered via `WEBFLOW_ECOMMERCE_COLLECTION_SLUGS`,
  `webflow-types.ts:19`), Forms, Users — each its own follow-up with new OAuth scopes.
- **Incremental pull for Assets/Pages** — unchanged.
- **Feature flag** — replaced by the `ConnectorAccount.version` pin.

## What already exists (reused, not rebuilt)

- **3 entities already pulled** — no new entity work.
- **Path-based folder model with `basePath` nesting** — restructure is a `basePath`
  change, not a schema change.
- **scratch-git `rename`** (`write.rs:548`) — main+dirty atomic, OID-preserving; the
  `move_folder` template.
- **Set-based path rewrite** — `files.service.ts:402-440` (rename → `updateMany` ×2, slash
  convention handled) — the migration's rewrite pattern.
- **`ConnectorAccount.version` pin** (DEV-10302) — eliminates the mixed-layout window.
- **code-migrations framework** + `notion-data-source-backfill.ts` template.
- **`DataFolder.version`** (`schema.prisma:381`) — per-folder idempotency key.

---

## Worktree parallelization strategy

| Step                                            | Modules                                                                | Depends on                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| W1 Connector + shared path helper + version pin | `connectors/library/webflow/`, `connector-registry`                    | —                          |
| W2 scratch-git `move_folder`                    | `scratch-git-2/src/service/`, `scratch-git/`                           | —                          |
| W3 Migration                                    | `code-migrations/`, `publish-plan/`, `sync/`, `workbook/`, `schedule/` | W1 (helper+pin), W2 (move) |
| W4 Desktop/CLI salvage + re-clone signal        | `scratch-desktop/`, `scratch-git-2/src/cli/`                           | —                          |

```
Lane A: W1 ─┐
Lane B: W2 ─┼─→ Lane C: W3 (depends on A + B)
Lane D: W4 (independent)
```

Launch A, B, D in parallel worktrees. Merge A + B, then C. D any time. No shared module
dirs across parallel lanes → no conflict flags.

---

## Implementation Tasks

- [x] **T1 (P1, human: ~1d / CC: ~30min)** — scratch-git — `move_folder` route with the full idempotency/prefix/both-exist contract ✅ **Done** (uncommitted)
  - Surfaced by: A1, #4, #8 — re-parent, no-op on moved, prefix-of-new, refuse both-exist, 404-vs-empty
  - Files (actual):
    - `scratch-git-2/src/service/git/repo.rs` — **new** `GitRepo::list_blob_paths_under(commit_oid, folder_path) -> Option<Vec<(rel_path, oid)>>` (recursive blob walk; `None` when folder absent) + private `collect_blob_paths_recursive`.
    - `scratch-git-2/src/service/routes/write.rs` — **new** `move_folder` axum handler + `MoveFolderBody {oldPath,newPath,message}`; core extracted to `perform_move_folder(git_repo, old, new, message) -> Result<bool /*moved*/>` (testable without HTTP); helpers `build_move_changes_for_branch`, `build_subtree_move_changes`, `old_path_is_prefix_of_new`, `normalize_folder_path`.
    - `scratch-git-2/src/service/mod.rs` — route `POST /api/repo/write/{id}/move-folder`.
    - `server/src/scratch-git/scratch-git.client.ts` + `scratch-git.service.ts` — `moveFolder(repoId, oldPath, newPath, message) -> {moved}`.
  - **Contract implemented:** moves the data folder **and its `.scratch/<path>` metadata sibling** (schema + views) on BOTH main+dirty, reusing blob OIDs (history follows the move); advances `merge_base` to new main in lockstep (mirrors `rename`, so the move is not a ghost review diff). Idempotent (`moved:false` on re-run); **old-is-prefix-of-new** handled by per-leaf deletes + excluding already-relocated blobs (so a collection literally named "Collections" re-runs cleanly); **refuses** a folder containing a nested data folder (relative blob path with a `/`) and a destination that already exists with **differing** content (identical content → converge); src-absent → no-op; asymmetric dirty-only / main-only handled; missing repo → 404 via `GitRepo::open`.
  - Verify: 12 new cargo tests in `write.rs` (relocate+OID-preserve+`.scratch`+merge_base on both branches; idempotent re-run; "Collections"-named prefix case + its re-run; nested-folder refuse; differing-dest refuse; identical-dest converge; src-absent no-op; dirty-only move; old==new no-op; 2 pure-fn shape tests). Full crate suite green; `cargo fmt` clean.
  - **Deferred to T2**: the C1 drift-guard test (connector v2 path == migration recomputed path); the NestJS `moveFolder` wrapper currently lets a 404 (missing repo) propagate as `ScratchGitNotFoundError` — the migration decides how to treat it.
- [~] **T2 (P1, human: ~3d / CC: ~1h)** — code-migrations — the folder-move migration (move → flip). 🟨 **Core done** (uncommitted, branch `webflow-support-all-v1`). **Quiesce (T4) + integration/E2E deferred.**
  - Surfaced by: Phase 1 + A1/A2/A4 + #1/#5/#6/#9/#10/#11 + Tension 1 + Ordering — atomic 6-column rewrite, ensureUniquePath, dest-side sync, prefix-safe SQL
  - Files (actual):
    - **new** `workbook/connector-folder-path.util.ts` — extracted `escapeConnectorFolderPathSegment` (C1 single source of truth, now used by both `buildConnectorFolderPath` and the migration).
    - `workbook/data-folder.service.ts` — `buildConnectorFolderPath` now calls the shared escaper.
    - **new** `code-migrations/webflow-folder-restructure-backfill.ts` — pure core: `computeNestedWebflowCollectionPath` (dirname + `Collections` + `escape(name)`, repairs the `-{id5}` suffix), `classifyWebflowTableByTableId` (#13, never by name/path), `rewriteFilePathFolderPrefix` (#10 boundary-prefix twin of the SQL), `sortWebflowCollectionFoldersForSafeMoveOrder` (Collections-named first per site), `migrateWebflowCollectionFolder` (idempotency on `DataFolder.version`, ensureUniquePath, git move, atomic rewrite, audit), summary helpers.
    - `code-migrations/code-migrations.controller.ts` — `webflow-folder-restructure` registration + orchestrator (`runWebflowFolderRestructure`), deps wiring (`buildWebflowFolderRestructureDeps`), the **atomic `$transaction` executor** `applyWebflowFolderMovePathRewrite` (DataFolder.path+version, FileIndex exact, FileReference/SyncMatchKeys/UploadPatchMeta boundary-prefix raw SQL, SyncRemoteIdMapping dest-side via `SyncTablePair.destinationDataFolderId` (#9), RecreatedIdMap exact), `ConnectorAccount.version` flip after an account's flat collections are all gone; injected `ScratchGitService`.
    - `packages/shared-types/.../code-migrations.dto.ts` — added optional `dryRun` to `runMigrationSchema`.
  - **Sync semantics confirmed against `sync.service.ts`:** `SyncMatchKeys.filePath` always lives in the folder named by its own `dataFolderId` (both source- and dest-side keys), so a `dataFolderId = folder.id` filter is correct; only `SyncRemoteIdMapping.destinationFilePath` needs the `SyncTablePair.destinationDataFolderId` resolution (#9). Boundary-prefix SQL uses `left(col, char_length(old)+1) = old || '/'` (prefix-safe by construction + multibyte-safe — supersedes the LIKE-escaped wording).
  - **Decisions:** Assets/Pages left fully **untouched** (stay v1; `isAssetTable: false` keeps the synthetic Assets table out of the candidate sweep, Pages is caught by the in-fn discriminator). `repo_missing` ⇒ skip the folder (no DB rewrite) and retry on a later run. The account-flip re-scans fresh DB state so it also repairs an account left unflipped by a crashed run.
  - **Move ordering (from T1):** within each site, a collection literally named "Collections" (the prefix case) sorts **before its siblings** — see `sortWebflowCollectionFoldersForSafeMoveOrder`.
  - **Review fixes (2 found by code-review on the first pass, both applied):**
    1. **Leading-slash bug (severe).** The 5 record-path columns (`FileReference.sourceFilePath`, `SyncMatchKeys.filePath`, `SyncRemoteIdMapping.destinationFilePath`, `UploadPatchMeta.filePath`, `RecreatedIdMap.folder`) store paths with **NO leading slash** — the system-wide convention enforced by `validateRecordPath` (UploadPatchMeta), `getAllFileContentsByFolderId`/sync `.replace(/^\//,'')` (the two sync columns), `deleteForFolder(…, folderPathNoSlash)` (FileReference), and `parsePath(filePath).folderPath` (RecreatedIdMap, "matches CLI patch paths e.g. `public/projects`"). The executor was matching them against the **leading-slash** `oldFolderPath`, so `left(col,…)=old||'/'` matched nothing and those 5 columns were silently never rewritten — breaking FK resolution / sync match-keys / recreate-id mapping after a move. **Fixed:** the executor now uses the no-leading-slash form for all 5 (and FileIndex); only `DataFolder.path` keeps the slash; the git `move_folder` route strips the slash itself so it takes the leading-slash form. Verified each column's stored format in the writing code. The pure twin's tests were updated to the no-slash format (they had pinned the wrong one).
    2. **qty-batch-split ordering wedge.** Per-batch sorting only guaranteed "Collections"-first within one fetched batch; a qty split could migrate a sibling first in an earlier batch, after which `move_folder` refuses the `/<Site>/Collections` collection forever → account never flips. **Fixed:** every run is now **account-atomic** — `ids` mode targets whole workbooks (⊇ whole accounts); `qty` mode takes `qty` oldest rows as a SEED then expands to each seeded account's full candidate set. 2 new controller tests pin this.
    3. **Audit failure misreported a migrated folder as errored.** `logAudit` runs AFTER the version-2 commit point; an unguarded `logEvent` throw rethrew out of the per-folder function → the orchestrator's catch flipped an already-migrated folder to `errored` and dropped it from `migratedIds`. **Fixed:** the `logAudit` dep now try/catches + warns + swallows (mirrors `buildSyncMappingV2BackfillDeps`). 1 new controller test (folder migrated despite a failing audit write).
  - Verify: `webflow-folder-restructure-backfill.spec.ts` (**44 tests** — path computation; **C1 drift-guard**; #13 discriminator; #10 prefix-safety on the **no-leading-slash** form; A2 re-suffix; ordering; idempotency; repo-missing/bad-shape skips; dry-run) + 3 `code-migrations.controller.spec.ts` orchestration tests (account-atomic ×2, best-effort-audit ×1). Full `code-migrations` suite **85 green**; typecheck + build (14/14) + `lint-strict` + prettier clean.
  - **DB-integration coverage landed (2026-06-14):** the atomic executor was extracted from the controller into an exported `applyWebflowFolderMovePathRewrite(prisma, input)` (`webflow-folder-restructure-path-rewrite.ts`; the controller now delegates, behavior-identical, so the SQL is a first-class testable unit that can't drift from a test copy) and exercised against **real Postgres** in `test/integration/webflow-folder-restructure-db.spec.ts` (3 tests). It seeds the full FK chain (org → workbook → account → folders → sync → table pair) plus a row in each of the 7 rewritten tables with deliberate decoys, runs the shipped SQL, and asserts: all 7 columns rewrite correctly; #9 dest-side rows resolve via `SyncTablePair.destinationDataFolderId` (a row keyed by the migrated folder _as source_ is left untouched); #10 boundary-prefix safety (`My Site/Blog` never touches `My Site/Blog Posts`); `SyncMatchKeys` `dataFolderId`-scoping + `RecreatedIdMap`/`UploadPatchMeta` `connectorAccountId`-scoping; the no-leading-slash convention; idempotent re-apply (no double-nest); and `$transaction` atomicity (a forced mid-txn unique violation rolls the `DataFolder` path+version back). The Jest-mocked-`$transaction` gap the controller spec couldn't reach is now closed.
  - **Deferred:** the per-connection **quiesce wrapper (T4)** — cancel non-terminal PublishPlans, drain/dequeue jobs, block live edits, persist+restore schedule state; and **live-pipeline E2E** (publish/sync interleaved with a migration batch). Until T4, run `webflow-folder-restructure` only on an idle connection.
- [x] **T3 (P1, human: ~4h / CC: ~20min)** — connector — version-pinned nested basePath + shared helper + tableSpec structure version ✅ **Done** (uncommitted)
  - Surfaced by: Phase 0 + C1 + #7/#13/#14 — `webflowCollectionBasePath`, version pin, tableId discriminator
  - Files (actual): **new** `connectors/library/webflow/webflow-folder-paths.ts` (C1 single-source helper + `WEBFLOW_COLLECTIONS_FOLDER_SEGMENT` + `WEBFLOW_NESTED_STRUCTURE_VERSION`); `webflow-json-schema.ts` (3 builders take `structureVersion`); `webflow-connector.ts` (stores `structureVersion` from `ctx.connectorAccount.version`, registration `version: 2`); `webflow-schema-parser.ts` (`parseTablePreview` picker grouping); `connectors/types.ts` (`BaseJsonTableSpec.structureVersion`); `workbook/data-folder.service.ts` (`version: tableSpec.structureVersion ?? 1`, no service branch); `connectors/display-names.ts` (de-stale `getConnectorCurrentVersion` docstring now that Webflow registers v2)
  - Verify: connector unit (v1 flat / v2 nested, discriminator, "Assets"/"Pages"-named no collision, picker grouping) — `webflow-folder-structure.spec.ts`, 13 tests; full webflow suite 145 green; typecheck + lint-strict + prettier clean. Confirmed `getConnectorCurrentVersion → registration.version` snapshots `2` onto new accounts.
  - ~~**Deferred to T2**: the C1 drift-guard test (connector v2 path == migration recomputed path)~~ ✅ **landed in T2** (`webflow-folder-restructure-backfill.spec.ts`, the "C1 drift guard" describe block) — and hardened beyond a test: `buildConnectorFolderPath` and the migration now share `escapeConnectorFolderPathSegment` + `WEBFLOW_COLLECTIONS_FOLDER_SEGMENT`, so they can't drift by construction.
- [x] **T4 (P1, human: ~1.5d / CC: ~40min)** — server — per-connection quiesce: drain + dequeue + block edits + cancel publish plans + persist schedule state ✅ **Done** (uncommitted, branch `webflow-support-all-v1`)
  - Surfaced by: A3, #1, #6, #11
  - Files (actual):
    - `server/prisma/schema.prisma` + migration `20260615110245_webflow_quiesce_connection_locks` — **new** `ConnectorAccount.migrationLockedAt DateTime?` (+ index) and `Schedule.disabledForMigrationAt DateTime?`.
    - **new** `migration-lock/migration-lock.service.ts` + `.module.ts` — lightweight `MigrationLockService` (DbService-only): `lockConnection`/`unlockConnection`/`isConnectionMigrating`; `assertConnectionNotMigrating` (edit gate, 409 `blocked_migrating`); `assertEnqueueAllowedForJob` (enqueue gate with fast-path no-op + job→account resolution reused by the drain). Shared DTO `ConnectionMigratingBlockedResponseDto`.
    - **new** `code-migrations/connection-quiesce.service.ts` — `ConnectionQuiesceService.quiesceConnection` (lock → disable schedules → cancel publish plans → drain) / `unquiesceConnection` (restore schedules → unlock → `workbook-updated` event) + `ConnectionDrainTimeoutError`. Drain cancels matching non-terminal jobs then waits for the BullMQ `active` set to clear.
    - `schedule/schedule.service.ts` — `disableSchedulesForConnectionMigration` / `restoreSchedulesForConnectionMigration` (marker-driven, crash-safe; all 3 schedule kinds).
    - `publish-plan/publish-plan-build.service.ts` — `cancelNonTerminalPlansForConnection`.
    - `job/job.service.ts` — `getNonTerminalJobsForWorkbook`, `systemCancelJob` (bypasses per-actor check; removes waiting jobs), `getActiveBullJobDatas`.
    - `worker-enqueuer/bull-enqueuer.service.ts` — enqueue gate in the `createAndEnqueue` chokepoint (next to the pending-delete guard, DeleteWorkbook exempt).
    - `workbook/files.service.ts` (create/update/delete) + `cli/upload-patch.controller.ts` (commit) — edit gates.
    - `code-migrations/code-migrations.controller.ts` — `runWebflowFolderRestructure` refactored **per-account**: quiesce → migrate folders → flip version (while locked) → release in `finally`; drain-timeout ⇒ release + skip the account; dryRun skips quiesce. Descriptor updated. Module wires the new deps.
  - **Decisions (confirmed):** dedicated lock column (not `extras`); gate blocks edits **and** enqueues; in-flight jobs **cancelled** (resumable); schedule restore via marker column (crash-safe); **no auto-TTL** on the lock; drain-timeout ⇒ **abort-and-skip** the account.
  - Verify: 82 unit tests (`migration-lock.service.spec` + `connection-quiesce.service.spec` + `schedule.service.connection-migration.spec` + 2 new `code-migrations.controller.spec` quiesce-wrapping/abort-skip + fixed existing specs) + **4 DB-integration** (`test/integration/connection-quiesce-db.spec.ts`: lock gate + schedule disable/restore + crash-repair re-run, real Postgres). `main.spec` (full AppModule DI boot) green; typecheck + `lint-strict` + prettier clean.
  - **Reusable playbook** documented in `CONNECTOR_GUIDE.md` §9 (version-pin → code-migrations idempotency/crash-safety → per-connection quiesce → local-checkout re-clone).
- [x] **T5 (P2, human: ~1.5d / CC: ~40min)** — desktop/CLI — salvage un-uploaded work, then forced re-clone on structure mismatch ✅ **Done** (uncommitted)
  - Surfaced by: Client/desktop, #12, #16, #17
  - Files (actual):
    - **server** — `cli/dtos/cli-workbook.dto.ts` (`CliConnectorAccountDto.version`), `cli/cli-workbook.controller.ts` (`getWorkbook` maps `version: ca.version`), `utils/path-validation.ts` (actionable `outside-data-folder` message; code + leading phrase preserved). Tests: `cli/__tests__/cli-workbook.controller.spec.ts` (version mapping), `utils/__tests__/path-validation.spec.ts` (actionable message).
    - **CLI** — `cli/api/mod.rs` (`ConnectorAccount.version`, serde default 0); `cli/config/markers.rs` (`ConnectionEntry.structureVersion`, serde default 0 = back-compat); `cli/commands/workspaces.rs` (`init_v2` stamps `structure_version: ca.version`; new `clear_existing_workspace_preserving_pending_edits` / `workspace_has_pending_accepted_edits` / `choose_salvage_path` + `SALVAGE_DIR_INFIX`; `find_existing_workspace` skips `.salvaged-` backups; `init` reports `salvagedTo`); `cli/commands/files.rs` (`fetch_connection_server_state` returns `ConnectionServerState{data_folders,structure_version}`; `detect_structure_version_drift`; `print_structure_change_reinit_result`; `run_download` bails on drift (scoped to selected `contexts`), `download_workbook` skips+warns, both before re-anchor/materialize).
    - **desktop** — `shared/workspace-reinit-events.ts` (`reason?`/`recommendation?` on the event); `main/scratchmd.ts` (`broadcastWorkspaceNeedsReinit` forwards them; the payload type already carried `reason`); `renderer/.../WorkspacePage.tsx` (tracks `reinitReason`, passes to modal); `renderer/.../workspace/ReinitWorkspaceModal.tsx` (reason-tailored headline + an **honest** salvage caveat — see review fix #4).
  - **Detection is generic (CLI-frontend stays connector-agnostic):** a plain integer version compare; `recorded != 0 && server != 0 && recorded != server`. Scoped to the connections actually being downloaded so a healthy connection isn't blocked by an unrelated stale one.
  - **Salvage is non-destructive + conservative:** moves (atomic rename, same-parent → no EXDEV) a workspace with non-empty *or unparseable* `accepted-patches.json`; deletes only when provably clean. `find_existing_workspace` ignoring `.salvaged-` dirs prevents a 2nd `--force` cloning into an occupied dir.
  - **Four adversarial-review fixes folded in:** (1) unparseable/too-new `accepted-patches.json` now preserves (`load(...).unwrap_or(true)`) instead of deleting — closed a data-loss hole; (2) `find_existing_workspace` skips salvage backups — closed a 2nd-`--force` clone-collision; (3) drift bail scoped to the downloaded `contexts`; (4) **messaging-honesty** — salvage only backs up a workspace with edits *staged for publish* (non-empty `accepted-patches.json`), so a user with only *un-accepted* working-tree edits would still lose them on re-clone. Dropped the "nothing is discarded" overclaim across all three surfaces (modal, CLI `structure_changed` recommendation, server `outside-data-folder` message) → now "edits staged for publish are backed up first; accept or publish other changes before re-cloning to keep them."
  - Verify: 13 new Rust unit tests + 3 review-fix tests (433 scratchmd-bin tests green; full crate 271+343+433+2+16); 5 server tests; 1 desktop parse test; server typecheck + lint-strict; desktop build + lint; prettier; root build — all green.
  - **NOT done (out of T5 scope / operational):** the live salvage-before-wipe **E2E** against a real stale desktop clone (manual canary gate); pre-T5 clones rely on the actionable upload error + salvage-on-reclone (no download-detection baseline).
- [x] **T6 (P2, human: ~3h / CC: ~1h)** — code-migrations — inverse/rollback (paths + `ConnectorAccount.version` 2→1) ✅ **Done** (uncommitted, branch `webflow-support-all-v1`)
  - Surfaced by: A4, #15
  - Files (actual):
    - `scratch-git-2/src/service/routes/write.rs` — **scratch-git scope addition (not in the original plan):** `build_move_changes_for_branch` now handles **new-is-prefix-of-old** (destination is an _ancestor_ of the source) symmetrically with the existing old-is-prefix-of-new. The inverse "Collections"-named move `…/Collections/Collections` → `…/Collections` puts the source subtree _inside_ the destination, so the non-destructive collision guard now excludes the source's own blobs from the destination listing before judging "differing content". The disjoint delete-whole-folder branch already does the right thing for this direction. 4 new cargo tests (invert normal collection; invert "Collections"-named with no siblings → succeeds; refuses while a sibling is still present; converges after a partial crash). **No NestJS client change** — `moveFolder(old,new)` is direction-agnostic.
    - **new** `server/src/code-migrations/webflow-folder-restructure-inverse-backfill.ts` — pure core mirroring the forward backfill: `computeFlatWebflowCollectionPath` (strips `/Collections/` via dirname-of-dirname; robust to legacy ≥3-segment sites; recomputes leaf from `name`), `isInverseCollectionsNamedFolder`, `sortWebflowCollectionFoldersForSafeInverseMoveOrder` ("Collections"-named **LAST** per site — mirror of forward-first), `invertWebflowCollectionFolder` (idempotency on `version < 2`), summary helpers, `WEBFLOW_FOLDER_RESTRUCTURE_INVERSE_AUDIT_MARKER`. Reuses `splitFolderPathIntoParentAndLeaf` / `classifyWebflowTableByTableId` / `WebflowFolderRestructureDeps` from the forward module so path-parsing + column-rewrite can't drift.
    - `server/src/code-migrations/webflow-folder-restructure-path-rewrite.ts` — `applyWebflowFolderMovePathRewrite` now takes a **`targetFolderVersion`** arg (forward passes 2, inverse passes 1); the leading-slash convention + 7-column SQL are otherwise direction-agnostic, so the one shipped function serves both directions (the DB-integration test runs the actual SQL in both directions — no copy to drift).
    - `server/src/code-migrations/code-migrations.controller.ts` — `webflow-folder-restructure-inverse` descriptor + switch case + `runWebflowFolderRestructureInverse` (mirror of the forward orchestrator: nested candidates `version >= 2`, account-atomic, per-connection quiesce, flip `ConnectorAccount.version` → 1 **while locked**, release in `finally`, drain-timeout ⇒ release+skip, dryRun skips quiesce, ids-mode crash-repair for accounts stuck at v2). `buildWebflowFolderRestructureDeps(dryRun, targetFolderVersion)` now shared by both directions.
    - `server/src/remote-service/connectors/library/webflow/webflow-folder-paths.ts` — **new** `WEBFLOW_FLAT_STRUCTURE_VERSION = 1`.
  - **Decisions:** the "Collections"-named mirror case is handled **completely** (via the symmetric `move_folder` fix) rather than skip-with-warning, so a rollback can never wedge an account that happens to contain a collection named "Collections" (0 in prod, but a break-glass tool shouldn't have a latent wedge). The inverse degrades safely even on an un-upgraded scratch-git: a refused move → `errored` → folder stays v2 → account stays v2 → logged, never corrupts.
  - Verify: 33 inverse unit (`webflow-folder-restructure-inverse-backfill.spec.ts`, incl. a forward↔inverse **round-trip drift guard**) + 3 controller-orchestration (`code-migrations.controller.spec.ts`: nested candidate selection, quiesce/flip-to-v1, drain-skip) + 1 DB round-trip integration (`webflow-folder-restructure-db.spec.ts`: forward then inverse restores all 7 columns + version exactly, real Postgres) + 4 cargo (`write.rs`). Full code-migrations suite **129 green**; `main.spec` (AppModule DI boot) green; typecheck + build 14/14 + root lint + server `lint-strict` + prettier clean; `cargo fmt` + full crate suite (271+343+417+2+16) green.
  - **Deferred / follow-up:** committing on `webflow-support-all-v1`; the live round-trip canary (migrate→invert→migrate on a real workbook) still pending a real Webflow workbook.
- [x] **T7 (P2, human: ~2h / CC: ~10min)** — connector — Pages SEO-metadata completeness check ✅ **Done** (uncommitted, branch `webflow-support-all-v1`)
  - Surfaced by: Pages SEO section
  - **Finding: the SEO surface is already complete — there is no missing field to add.** Audited the live Webflow Data API (`GET /pages/{id}` metadata + `PUT /pages/{id}` settings). The full **writable** SEO/page surface the API exposes is exactly: `title`, `slug`, `seo.{title,description}`, `openGraph.{title,titleCopied,description,descriptionCopied}`. Every one of these is already declared in `buildWebflowPagesJsonTableSpec`, is left editable (not `X_SCRATCH_READONLY`), and is forwarded by the `updateRecords` pages branch (`webflow-connector.ts:603-633`), which refetches via `getPageMetadata` and routes through `normalizeWebflowPageForFile` so the published blob is byte-equal to a fresh pull.
  - **API-impossible (Designer-only, documented honestly, NOT a connector omission):** Open Graph **image**, **canonical URL**, and the per-page **search-visibility / noindex** toggle — none exist in the Webflow Data API (confirmed against both the GET and PUT OpenAPI specs). Same boundary as page body/DOM content. Captured in the `buildWebflowPagesJsonTableSpec` docstring so a future reader doesn't mistake the absence for a bug.
  - Files (actual):
    - `connectors/library/webflow/webflow-json-schema.ts` — docstring on `buildWebflowPagesJsonTableSpec` enumerating the editable SEO surface + the three API-impossible fields.
    - **new** `connectors/library/webflow/__tests__/webflow-connector-pages-update.spec.ts` — 5 tests pinning the previously-untested pages write branch: forwards every editable group (`title`/`slug`/`seo`/`openGraph`) to `updatePageSettings`; normalizes the post-write refetch to the canonical on-disk shape (drops `siteId`/`collectionId`/`canBranch`/`localeId`); partial `changedFields` edit sends only the changed SEO sub-object; a read-only-only edit fires **no** write and returns the input unchanged; multiple pages processed in input order.
    - `connectors/library/webflow/__tests__/webflow-pages-json-schema.spec.ts` — strengthened: asserts `seo.{title,description}` + all four `openGraph.*` subfields are present **and editable**, and that the 6 read-only metadata fields (`publishedPath`/`parentId`/`archived`/`draft`/`createdOn`/`lastUpdated`) stay read-only.
  - Verify: 158 webflow connector tests green (28 in the two pages specs); changed files `lint-strict` + prettier clean; zero typecheck errors in any touched file.
  - **Follow-up candidate (NOT done — larger gap, out of T7 scope per plan):** `normalizeWebflowPageForFile` hand-whitelists page fields rather than storing the verbatim API response, dropping `siteId`/`collectionId`/`canBranch`/`isBranch`/`branchId`/`localeId` (a mild fidelity-principle deviation; none are SEO-relevant). File separately if we want full page fidelity.

## Decisions

- **Pages "content" = SEO metadata only** — body/DOM out (primary-locale API-impossible,
  secondary deferred).
- **Migrate all workbooks, in place** — mutate `DataFolder.path`, keep id, idempotency on
  `DataFolder.version` 1→2.
- **Forced re-clone, but salvage un-uploaded local work first** (#12).
- **`/Collections/` grouping is also a collision-bug fix** — note on the ticket.
- **(Eng review) Rewrite, not rebuild** — all 6 path columns + version in one atomic txn
  (kills the rebuild crash window).
- **(Eng review) `ConnectorAccount.version` pin, not a flag** — connection is atomically
  all-flat or all-nested; no mixed window.

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status       | Findings                                    |
| ------------- | --------------------- | ------------------------------- | ---- | ------------ | ------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —            | not run (scope already set with maintainer) |
| Outside Voice | Claude Fable 5        | Independent 2nd opinion         | 1    | ISSUES_FOUND | 17 findings, all folded in                  |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN) | 16 issues, 0 critical gaps, all resolved    |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | —            | minimal UI (generic tree render)            |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —            | not run                                     |

- **OUTSIDE VOICE (Claude Fable 5):** found 17 findings including **2 cross-model
  tensions** — (1) rebuild vs rewrite of FileIndex/FileReference, (2) feature flag vs
  `ConnectorAccount.version` pin. Both were **reversed toward the outside voice** by the
  maintainer; the other 15 findings were all folded into the plan.
- **CROSS-MODEL:** review and outside voice **converged** after the 2 tensions resolved.
  The reversals simplified the design (one atomic DB txn; no mixed-layout window).
- **UNRESOLVED:** 0.
- **VERDICT:** **ENG CLEARED — ready to implement.** Highest-risk surface is T2 (the
  migration); land it isolated, canary-first.
