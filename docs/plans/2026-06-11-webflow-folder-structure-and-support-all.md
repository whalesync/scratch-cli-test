# Webflow: site-grouped folder structure + all-workbooks migration (DEV-9698)

**Date**: 2026-06-11
**Status**: In Progress
**Author**: Curtis Fonger
**Linear**: [DEV-9698](https://linear.app/whalesync/issue/DEV-9698/proposal-support-all-of-webflow)

## Implementation progress

| Task | Lane | Status | Notes |
|---|---|---|---|
| **T3** Connector nested layout + version pin | W1 | ✅ **Done** (uncommitted, branch `webflow-support-all`) | New file `webflow-folder-paths.ts`; `BaseJsonTableSpec.structureVersion`; `createFolder` stamps it (no service branch); registration `version: 2`; 13 new tests + 145 webflow tests + typecheck + lint-strict + prettier green. C1 drift-guard test deferred to T2. |
| **T1** scratch-git `move_folder` | W2 | ⬜ Not started | Next foundation lane. |
| **T2** Migration | W3 | ⬜ Not started | Highest risk; depends on T1 + T3; land isolated, canary-first. |
| **T4** Per-connection quiesce | W3 | ⬜ Not started | |
| **T5** Desktop/CLI salvage + re-clone | W4 | ⬜ Not started | P2 |
| **T6** Inverse/rollback migration | — | ⬜ Not started | P2 |
| **T7** Pages SEO completeness | — | ⬜ Not started | P2 |

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
  write page *body* (DOM) content for **secondary locales** — primary-locale page
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

  for each Webflow collection DataFolder (account still v1, version < 2):
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

### Why rewrite, not rebuild (Tension 1 decision)

A folder move changes **paths, not contents**. `FileIndex.folderPath` *is* the folder
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
  `SyncMatchKeys.filePath` rows for a *destination* Webflow folder are keyed by the
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
- **(#5)** folder under a parent (≥3 segments) keeps its site; escape-emptied site → skip-warn.
- **Idempotency**: re-run no-op. **Crash-safety**: partial run (git moved, txn not
  committed) converges; partial connection (some folders v2, account still v1) converges.
- **(Tension 1)** all 6 path columns + version in ONE atomic txn; FileIndex exact-match;
  FileReference prefix rewrite on **both** branches; `dataFolderId`-keyed rows untouched.
- **(#9)** destination-side sync rows (folder as sync *destination*) rewritten via
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
  all succeed after re-enable.
- **(#11)** a user-disabled schedule stays disabled after the batch; crash mid-batch →
  re-run repairs schedule state.
- **(#12 →E2E)** stale desktop clone with un-uploaded edits: salvage runs before re-clone;
  no work lost.

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

| Codepath | Realistic failure | Test? | Handling | User sees |
|---|---|---|---|---|
| pre-migration publish resumes | commits result files to OLD path on main | ✅ #1 | cancel non-terminal plans | nothing |
| move_folder re-run after crash | `rename`-style throw on missing src | ✅ A1 | no-op contract | nothing |
| "Collections"-named collection | prefix-of-new → double-move | ✅ #4 | prefix handling | nothing |
| path recompute drops suffix | re-collision → 2 folders, 1 dir → data loss | ✅ A2 | ensureUniquePath | nothing |
| live write during migration | orphan at old path | ✅ #6 | drain + block edits | "connection busy" |
| dest-side sync rows | missed by source-keyed rewrite → broken sync | ✅ #9 | SyncTablePair.destination | nothing |
| prefix over-match | `/Blog` clobbers `/Blog Posts` | ✅ #10 | LIKE-escaped prefix | nothing |
| schedule re-enable | clobbers user-disabled schedule | ✅ #11 | persist + repair | prior state kept |
| stale desktop clone | un-uploaded edits wiped | ✅ #12 | salvage first | re-clone prompt |
| bad prod batch | irrecoverable in-place move | manual canary | inverse + version flip | — |

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

| Step | Modules | Depends on |
|---|---|---|
| W1 Connector + shared path helper + version pin | `connectors/library/webflow/`, `connector-registry` | — |
| W2 scratch-git `move_folder` | `scratch-git-2/src/service/`, `scratch-git/` | — |
| W3 Migration | `code-migrations/`, `publish-plan/`, `sync/`, `workbook/`, `schedule/` | W1 (helper+pin), W2 (move) |
| W4 Desktop/CLI salvage + re-clone signal | `scratch-desktop/`, `scratch-git-2/src/cli/` | — |

```
Lane A: W1 ─┐
Lane B: W2 ─┼─→ Lane C: W3 (depends on A + B)
Lane D: W4 (independent)
```

Launch A, B, D in parallel worktrees. Merge A + B, then C. D any time. No shared module
dirs across parallel lanes → no conflict flags.

---

## Implementation Tasks

- [ ] **T1 (P1, human: ~1d / CC: ~30min)** — scratch-git — `move_folder` route with the full idempotency/prefix/both-exist contract
  - Surfaced by: A1, #4, #8 — re-parent, no-op on moved, prefix-of-new, refuse both-exist, 404-vs-empty
  - Files: `scratch-git-2/src/service/routes/write.rs`, `server/src/scratch-git/scratch-git.service.ts`, shared-types api-client
  - Verify: `cargo test` move_folder cases
- [ ] **T2 (P1, human: ~3d / CC: ~1h)** — code-migrations — the folder-move migration (quiesce → move → flip)
  - Surfaced by: Phase 1 + A1/A2/A4 + #1/#5/#6/#9/#10/#11 + Tension 1 — atomic 6-column rewrite, ensureUniquePath, dest-side sync, prefix-safe SQL
  - Files: `server/src/code-migrations/`, `publish-plan/file-index.service.ts`, `sync/`, `workbook/data-folder.service.ts`
  - Verify: migration unit specs (idempotency, crash, re-collision, dest-side, prefix, plan-cancel)
- [x] **T3 (P1, human: ~4h / CC: ~20min)** — connector — version-pinned nested basePath + shared helper + tableSpec structure version ✅ **Done** (uncommitted)
  - Surfaced by: Phase 0 + C1 + #7/#13/#14 — `webflowCollectionBasePath`, version pin, tableId discriminator
  - Files (actual): **new** `connectors/library/webflow/webflow-folder-paths.ts` (C1 single-source helper + `WEBFLOW_COLLECTIONS_FOLDER_SEGMENT` + `WEBFLOW_NESTED_STRUCTURE_VERSION`); `webflow-json-schema.ts` (3 builders take `structureVersion`); `webflow-connector.ts` (stores `structureVersion` from `ctx.connectorAccount.version`, registration `version: 2`); `webflow-schema-parser.ts` (`parseTablePreview` picker grouping); `connectors/types.ts` (`BaseJsonTableSpec.structureVersion`); `workbook/data-folder.service.ts` (`version: tableSpec.structureVersion ?? 1`, no service branch); `connectors/display-names.ts` (de-stale `getConnectorCurrentVersion` docstring now that Webflow registers v2)
  - Verify: connector unit (v1 flat / v2 nested, discriminator, "Assets"/"Pages"-named no collision, picker grouping) — `webflow-folder-structure.spec.ts`, 13 tests; full webflow suite 145 green; typecheck + lint-strict + prettier clean. Confirmed `getConnectorCurrentVersion → registration.version` snapshots `2` onto new accounts.
  - **Deferred to T2**: the C1 drift-guard test (connector v2 path == migration recomputed path) — needs the migration's path helper.
- [ ] **T4 (P1, human: ~1.5d / CC: ~40min)** — server — per-connection quiesce: drain + dequeue + block edits + cancel publish plans + persist schedule state
  - Surfaced by: A3, #1, #6, #11
  - Files: `server/src/schedule/`, `publish-plan/`, pull/publish/sync + `/upload-patch/commit` entry points
  - Verify: integration (op rejected during batch, ok after; schedule state repaired)
- [ ] **T5 (P2, human: ~1.5d / CC: ~40min)** — desktop/CLI — salvage un-uploaded work, then forced re-clone on structure mismatch
  - Surfaced by: Client/desktop, #12, #16, #17
  - Files: `scratch-desktop/`, `scratch-git-2/src/cli/`, workbook event emit
  - Verify: →E2E salvage-before-wipe; actionable old-path error
- [ ] **T6 (P2, human: ~3h / CC: ~15min)** — code-migrations — inverse/rollback (paths + `ConnectorAccount.version` 2→1)
  - Surfaced by: A4, #15
  - Files: `server/src/code-migrations/`
  - Verify: round-trip migrate→invert→migrate converges
- [ ] **T7 (P2, human: ~2h / CC: ~10min)** — connector — Pages SEO-metadata completeness check
  - Surfaced by: Pages SEO section
  - Files: `connectors/library/webflow/webflow-json-schema.ts`
  - Verify: manual against a real site

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

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (scope already set with maintainer) |
| Outside Voice | Claude Fable 5 | Independent 2nd opinion | 1 | ISSUES_FOUND | 17 findings, all folded in |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 16 issues, 0 critical gaps, all resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | minimal UI (generic tree render) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **OUTSIDE VOICE (Claude Fable 5):** found 17 findings including **2 cross-model
  tensions** — (1) rebuild vs rewrite of FileIndex/FileReference, (2) feature flag vs
  `ConnectorAccount.version` pin. Both were **reversed toward the outside voice** by the
  maintainer; the other 15 findings were all folded into the plan.
- **CROSS-MODEL:** review and outside voice **converged** after the 2 tensions resolved.
  The reversals simplified the design (one atomic DB txn; no mixed-layout window).
- **UNRESOLVED:** 0.
- **VERDICT:** **ENG CLEARED — ready to implement.** Highest-risk surface is T2 (the
  migration); land it isolated, canary-first.
