# Resolve the last 88 unscoped FileIndex rows, then delete the unscoped-row fallback

- **Date:** 2026-08-09
- **Author:** Curtis Fonger
- **Status:** In Progress
- **Linear:** [DEV-11242](https://linear.app/whalesync/issue/DEV-11242/resolve-the-last-88-unscoped-fileindex-rows-so-the-unscoped-row)
- **Related:** [DEV-10880](https://linear.app/whalesync/issue/DEV-10880) (introduced the discriminator), [DEV-10885](https://linear.app/whalesync/issue/DEV-10885) (orphan GC that took prod 94,357 → 88), [DEV-11238](https://linear.app/whalesync/issue/DEV-11238) (removes the legacy pseudo-ref format)

## Goal

Drive `FileIndex.connectorAccountId IS NULL` to zero in prod, then delete the unscoped-row
fallback in `pickPreferredRecordId` (`server/src/publish-plan/file-index.service.ts`) so a
connection-scoped lookup is a strict match: that connection's row, or nothing.

## What the prod investigation found (2026-08-09, read-only)

The ticket asked one gating question first: **are the 88 rows reachable at all, or is a GC the
whole fix?** Answer: **a GC is _not_ the whole fix — only 5 of 88 are dead.**

Method: list the 88 rows from the prod DB, list the claimant connections for each
`(workbookId, folderPath)`, then probe each claimant connection's **git repo** (read-only, via
`terraform/tools/connect_to_git_service_ssh.sh production` → `sudo gitops-git <repo> ls-tree`)
for a file at `<folderPath>/<filename>` on `main` and `dirty`.

| Outcome | Rows | Meaning |
| -- | -- | -- |
| Exactly one claimant repo holds the file | **82** | Ownership is decidable — scope the row to that connection |
| No claimant repo holds the file (`main` **or** `dirty`) | **5** | Dead row — GC |
| Two claimant repos hold the file | **1** | Needs a tie-break |

Breakdown of the 82 decidable rows:

| Workbook / folderPath | Rows | Resolves to |
| -- | -- | -- |
| `wkb_lvpLzBghY5` / `Projects` | 43 | Linear (`coa_jkDcmvC863`) |
| `wkb_lvpLzBghY5` / `Projects` | 12 | Copper (`coa_pZGpVqn3QT`) |
| `wkb_lvpLzBghY5` / `Leads` | 12 | Copper (`coa_pZGpVqn3QT`) |
| `wkb_uPBxvloY48` / `Blog Posts` | 5 | Wix Blog (`coa_ETgfgRVz4x`) |
| `wkb_uPBxvloY48` / `Blog Posts` | 1 | Wix Blog 1 (`coa_HVoKjS9hjk`) |
| `wkb_WrAOapRE8n` / `Pages` | 5 | WordPress (`coa_x3pP2colTZ`) |
| `wkb_I49SQ5BE1L` / `Notes` | 4 | Pipedrive (`coa_RaCsQb2bnI`) |

The 5 dead rows (verified absent from **every** claimant repo on both `main` and `dirty`):

| Workbook | Path | recordId | lastSeenAt |
| -- | -- | -- | -- |
| `wkb_I49SQ5BE1L` | `Notes/30549220.json` | `30549220` | 2026-04-20 |
| `wkb_Tg8G6O4sss` | `Deposits/27802.json` | `27802` | 2026-07-07 |
| `wkb_Tg8G6O4sss` | `Purchases/27742.json` | `27742` | 2026-07-07 |
| `wkb_wi45a7p30d` | `Products/reversible-bucket-hat.json` | `gid://shopify/Product/10055551746297` | 2026-05-14 |
| `wkb_wi45a7p30d` | `Products/white-glossy-mug-scratch.json` | `gid://shopify/Product/10051364716793` | 2026-05-14 |

The 1 ambiguous row: `wkb_KAxALCGMfk` / `_testing__ryder_colors/conversion-test.json`
(recordId `26f51c96-d209-80da-afb8-d90cd6d3214e`) exists in **both** Notion connections
(`coa_FuJsG3v2e8` "Notion 1" and `coa_GAmYn6wLKE` "Notion"). Reading both files shows they are
**the same Notion page** — same `id`, same `parent.data_source_id`, byte-identical content. The
user connected the same Notion workspace twice and pulled the same database.

### Two supporting findings

1. **Every one of the 88 rows was last written before DEV-10880 deployed.** The newest
   `lastSeenAt` across all 88 is 2026-07-08; the discriminator fix deployed ~2026-07-19. So
   nothing is still writing unscoped rows — this is a closed population, not a leak.
2. **Nothing GCs a FileIndex row when its record disappears upstream.**
   `FileIndexService.findStaleEntries` / `removeBatch` have **no production callers** (verified
   by grep; the only deletes are workbook delete, connection delete/reset, folder delete, and
   the DEV-10885 migration). That is why the 5 dead rows survived pulls that ran as recently as
   today. Out of scope here — noted so it can be ticketed separately.

## Why the existing backfill can't finish the job

`fileindex-connector-account-backfill` infers ownership from `(workbookId, folderPath)` alone.
All 88 survivors sit at a folderPath claimed by 2+ connections, which is exactly the case that
inference declares ambiguous and skips. The missing signal is **which connection's repo actually
holds the file** — which is the definition of ownership, and which the backfill never consults.

## Phase 1 — `fileindex-unscoped-row-resolve` code-migration

A new admin-gated code-migration that resolves an unscoped row by probing git.

Per candidate workbook:

1. Load its `connectorAccountId IS NULL` FileIndex rows.
2. Find each row's **claimant** connections: the connections whose DataFolder is the
   longest-prefix owner of the row's `folderPath` (its own path or an ancestor — the same
   ownership rule `deleteRowsOwnedByDeletedFolder` and the orphan GC use, so a row stored deeper
   than the DataFolder path is attributed to the right folder).
3. For each `(claimant, folderPath)` pair, list the claimant repo's files in that folder on
   `main` (memoized, one call per pair).
4. Classify each row by how many claimant repos hold `<folderPath>/<filename>`:
   - **no claimant at all** → leave the row completely alone. No connector-backed folder owns
     the path, so no repo was probed and "no holder" says nothing about whether the file
     exists. Two populations land here and neither is this migration's: a row under a
     connector-less (scratch) folder, whose NULL is the one legitimate NULL; and a row
     orphaned by a past connection delete/reset, which is `fileindex-filereference-orphan-gc`'s
     job — it considers *all* DataFolders and sweeps the matching `FileReference` rows, neither
     of which happens here. Prod has 0 of these; **test has 47,113** (47,111 orphans + 2
     scratch), so treating them as dead would have been a 47k-row mistake.
   - **exactly one** → scope the row to that connection (`updateMany`);
   - **zero, but claimants exist** → re-probe `dirty` before concluding anything, so an
     unpublished local state can only ever *rescue* a row from deletion, never manufacture
     ambiguity. Still zero → the row is dead → delete. An empty listing is ambiguous
     though: scratch-git returns `[]` for a missing repo (a 404 the client deliberately
     swallows) and for an unresolvable branch ref (a 200) as well as for a folder that
     genuinely holds no such file, and neither of the first two raises, so neither is
     caught by the per-workbook `try`. An empty `main` listing therefore has to prove the
     repo is readable — by listing its root, which every real connection repo populates
     with `.scratch` — before it counts as evidence. Unprovable → skip the workbook;
   - **two or more** → tie-break by content (below).

**Tie-break for a multi-owner row.** Read the file from each candidate repo. If every candidate's
content is byte-identical, all candidates describe the same record, so every candidate yields the
same `recordId` and the choice is free — scope to the lowest `connectorAccountId` (arbitrary but
deterministic, and recorded in the log). If the contents differ, the candidates are genuinely
different records, we cannot know which one the row describes, so **leave it NULL and report it**
rather than baking in a wrong link. That keeps the migration honest; `remainingCount` then tells
us whether Phase 2 is unblocked.

Properties: dry-run-able, idempotent (a re-run finds nothing left to do), `ids`/`qty` batch
selection like its siblings. Only NULL rows are ever written or deleted, so a scoped row can
never be touched.

No `FileReference` cleanup: the five dead paths have **zero** `FileReference` rows on prod
(verified), so there is nothing to sweep and the migration stays lean.

### Phase 1 status

**Implemented** on branch `resolve-unscoped-fileindex-rows`:
`server/src/code-migrations/fileindex-unscoped-row-resolve.ts` (pure decision logic),
the `runFileIndexUnscopedRowResolve` orchestrator + descriptor in
`code-migrations.controller.ts`, and unit tests across the two spec files. Build,
`lint-strict`, and the full `src/code-migrations` + `src/publish-plan` suites are green.

Still to do: merge + deploy, then execute the runbook below on test and prod.

On prod the dry-run should report **scoped 83, dead 5, left NULL 0, untouched 0**. (83, not 82:
the two Notion candidate files are byte-identical — verified, both are git blob
`495cfb89c28f2e6d2d3501625e621ce764cf8f19` — so the content tie-break resolves that row too.
A "left NULL 1" instead would mean the files diverged since 2026-08-09 and the row needs a
decision.)

## Phase 2 — delete the unscoped fallback

**Must not deploy before Phase 1 has run to zero on BOTH test and prod.** Merging to master
deploys to the test environment first, and test is far dirtier than prod (measured read-only
2026-08-09):

| | test | prod |
| -- | -- | -- |
| `FileIndex` rows | 248,064 | 2,300,839 |
| `connectorAccountId IS NULL` | **160,593** (65%) | **88** |
| …unscoped workbooks | 37 | 7 |
| newest unscoped `lastSeenAt` | 2026-07-16 | 2026-07-08 |

Test's newest `lastSeenAt` also predates the DEV-10880 deploy, so it is the same closed pre-fix
population — nothing is still leaking rows there either.

Once the fallback is gone, a scoped lookup that lands on an unscoped row resolves to `null`:
`dispatchUpdateBatch` throws "Could not resolve remote ID", pseudo-ref resolution throws, and
publish can't map a file back to its record. Test is what the server integration suite, the
`scratchmd` CLI integration suite, and desktop QA run against, so shipping Phase 2 without
cleaning test first would look like a broad, confusing product regression.

### The change

- `pickPreferredRecordId` returns `string | null`: with a requested connection it matches that
  connection's row or returns `null`; with no requested connection it keeps the "first matching
  row" behavior (an unscoped *lookup* is still legal — e.g. a scratch folder).
- `getRecordId` returns `null`; `getRecordIds` omits the key. Both are already in the callers'
  contracts (`publish-plan-build.service.ts`, `publish-plan-run.service.ts`,
  `ref-resolver.service.ts` all handle a missing id), so no caller changes are required.
- `server/prisma/schema.prisma` — drop the legacy-row carve-out from the
  `FileIndex.connectorAccountId` comment (scratch folders remain a legitimate NULL).
- Same for the `FileIndexEntry.connectorAccountId` doc comment and `getRecordId` /
  `getRecordIds` doc comments in `file-index.service.ts`.
- `server/src/publish-plan/__tests__/file-index.service.spec.ts` — invert the "falls back to an
  UNSCOPED row" test into an assertion that it returns `null`.

**Status: implemented, and the gate is now satisfied on both environments** (prod at a literal 0,
test at A + B = 0 with only its 2 permanent scratch rows). Safe to merge.

### What the gate actually is

Not "`connectorAccountId IS NULL` returns 0" — it is **zero unscoped rows at a folderPath a live
connector folder owns**, because only those can be reached by a scoped lookup. Splitting the
unscoped rows by how many connector folders claim their path (measured 2026-08-09):

| Bucket | test | prod | Tool |
| -- | -- | -- | -- |
| **A** — exactly 1 connector claimant | 113,280 rows | 0 | `fileindex-connector-account-backfill` (pure SQL, no git) |
| **B** — 2+ connector claimants | 82 rows / 2 wkbs | 88 rows / 7 wkbs | `fileindex-unscoped-row-resolve` (this ticket) |
| **C** — 0 connector claimants | 2 rows (scratch) | 0 | not a gate — see below |

(Test's figures are **post-GC**, which ran 2026-08-09 — see below. Before it: A 113,398 / B 82 /
C 47,113, total 160,593.)

**A + B must reach 0. Bucket C does not.** A row in C sits at a folderPath with no live connector
folder, and every lookup site derives its folderPath from a live folder or a plan entry
(`publish-plan-build`'s deleted-file lookups, `publish-plan-run`'s plan entries,
`ref-resolver`'s connection-folder map). Nothing ever queries a dead path, so those rows are
unreachable — dead weight, not a hazard. Of test's 47,113: 47,111 are orphans belonging to
`fileindex-filereference-orphan-gc`, and 2 are scratch-folder rows whose NULL is permanent and
correct, so a literal `count = 0` is not even achievable on test.

The bulk of test is therefore bucket A — work for the **existing** backfill, which appears never
to have run there. This ticket's migration only has 82 rows to do on test.

### Runbook

Both environments, via **Settings → Dev → Migrations** (prod: app.scratch.md). Dry-run each step
first and check the counts against the table above.

0. **test** — `fileindex-filereference-orphan-gc`. ✅ **DONE 2026-08-09**.
1. **test** — `fileindex-connector-account-backfill`. ✅ **DONE**: 113,252 rows scoped, 30
   workbooks, 3 ambiguous folderPaths left NULL.
2. **test** — `fileindex-unscoped-row-resolve`. ✅ **DONE**: 81 scoped, 29 deleted, 0 left NULL,
   0 untouched, 0 skipped.
3. **test** — verify. ✅ A = 0, B = 0, C = 2, unscoped 112 → 2, `FileIndex` down by exactly 29,
   **0 mis-scoped rows** in the two migrated workbooks.
4. **prod** — `fileindex-unscoped-row-resolve`. ✅ **DONE**: 83 scoped, 5 deleted, 0 left NULL,
   0 untouched, 0 skipped, 7 workbooks — matching the dry-run and the hand-derived prediction
   exactly. **Unscoped rows fleet-wide: 88 → 0.**
5. Merge Phase 2. ← only remaining step

#### Executed 2026-08-09 ✅ — both environments

Prod's live run reproduced, to the row, the split derived independently that morning by probing
the repos with `gitops-git ls-tree`: 83 scoped (82 single-holder + the Notion row the content
tie-break resolved), 5 dead. Two different tools, two different code paths, same answer.

Verified read-only afterwards, per row rather than per summary — Pipedrive `Notes` 1–4 →
`coa_RaCsQb2bnI`, WordPress `Pages` → `coa_x3pP2colTZ`, the Notion tie-break row → the lower
`coa_FuJsG3v2e8`, all five dead rows gone, and **zero mis-scoped rows** across the seven
workbooks (i.e. every scoped row's `connectorAccountId` genuinely owns its `folderPath`). That
last check is what actually closes the gate; the rest is corroboration.

Two things the run surfaced that the plan had not predicted:

- **The backfill scoped 113,252, not the 113,280 this doc estimated.** The bucket-A query here
  matches folderPaths by *prefix*, but the backfill's `updateMany` is **exact-`folderPath` match
  only**, so 28 rows nested deeper than any DataFolder path were structurally out of its reach.
  `fileindex-unscoped-row-resolve` then swept them, because its claimant lookup is
  longest-prefix. Not a failed run — an over-generous estimate.
- **Those 28 were DEV-11015 artifacts in a slash-collapsed variant** —
  `Product Variants/gid:/shopify/ProductVariant` (one slash) against a `gid://shopify/…`
  recordId (two). `isSplitRecordIdArtifactRow` tests
  `folderPath.includes('/' + recordIdPrefix)`, which needs the double slash, so DEV-10885's
  pass 2 could never match them. **Prod has zero rows of this shape** (checked), so the gap has
  no production impact — and asking git rather than pattern-matching the id is precisely why
  this migration caught what the predicate missed.

### Optional (not a gate): the orphan GC on test

`fileindex-filereference-orphan-gc` sweeps bucket C's 47,111 orphans and their `FileReference`
rows. DEV-10885 swept prod but never test, and those rows are 19% of `FileIndex` — worth doing as
hygiene, and it makes the plain `IS NULL` count meaningful again (it drops to the 2 permanent
scratch rows). Already merged and deployed, so it needs nothing from this ticket's branches.

Scope, measured read-only 2026-08-09. Pass 1 — 33 orphan folderPaths / 47,111 `FileIndex` rows
(all unscoped; 0 already-scoped) / ~24,003 `FileReference` rows across 10 workbooks:

| Workbook | Paths | FileIndex | FileReference |
| -- | --: | --: | --: |
| `wkb_HklMJHdK3T` | 3 | 24,000 | 24,000 |
| `wkb_WMPDtNPPZH` | 1 | 22,865 | 0 |
| `wkb_gu0ZxkkgoF` | 11 | 94 | 3 |
| `wkb_7iC2IkQbg8` | 3 | 57 | 0 |
| `wkb_V99Y88F9FF` | 3 | 38 | 0 |
| `wkb_dlzKo3jpXS` | 6 | 36 | 0 |
| `wkb_9Cw2dfcdH6` | 2 | 12 | 0 |
| `wkb_NxygJBm4Mp` | 2 | 7 | 0 |
| `wkb_mo82q1uLZ4` | 1 | 1 | 0 |
| `wkb_xbd8bLbXg7` | 1 | 1 | 0 |

Pass 2 — 118 DEV-11015 split-recordId artifact rows, all Shopify GID shapes:
`wkb_vZzQSo0j5p` 45 · `wkb_XIU9vNp01f` 45 · `wkb_dlzKo3jpXS` 28.

**`ids` must be the union of both lists — 12 workbooks.** `wkb_vZzQSo0j5p` and `wkb_XIU9vNp01f`
have no pass-1 rows and their artifact rows are already scoped, so `qty` (which selects only
workbooks with NULL rows) would never reach them. This is the same trap the prod run hit.

Batches, smallest-first per the ops runbook — `wkb_gu0ZxkkgoF` is the canary because it is the
only small workbook that also has `FileReference` rows, so it exercises both deletes:

1. Dry-run all 12 ids at once — expect FileIndex 47,229 (47,111 + 118), FileReference ~24,003.
2. Canary live: `wkb_gu0ZxkkgoF` (94 + 3). Verify in the DB.
3. `wkb_7iC2IkQbg8, wkb_9Cw2dfcdH6, wkb_dlzKo3jpXS, wkb_mo82q1uLZ4, wkb_NxygJBm4Mp, wkb_V99Y88F9FF, wkb_xbd8bLbXg7, wkb_vZzQSo0j5p, wkb_XIU9vNp01f` (~242 rows).
4. `wkb_WMPDtNPPZH` (22,865 + 0).
5. `wkb_HklMJHdK3T` (24,000 + 24,000) — heaviest, isolated and last.

`remainingCount` is per-run, not fleet-wide: 0 after a live batch, the would-delete total on a
dry-run. Verify against the DB, not the UI summary.

#### Executed on test, 2026-08-09 ✅

Fleet dry-run then four live batches, verified read-only in the DB between each. **Every batch hit
its predicted counts exactly**, and the fleet totals fell by exactly the summarised amounts each
time — which is the check that proves no collateral deletion, since a run reaching past its orphan
set would drop the totals further than it reported.

| Batch | Workbooks | FileIndex | FileReference | Artifacts |
| -- | -- | --: | --: | --: |
| 1 (canary) | `wkb_gu0ZxkkgoF` | 94 | 3 | 0 |
| 2 | the 9 small ones | 152 | 0 | 118 |
| 3 | `wkb_WMPDtNPPZH` | 22,865 | 0 | 0 |
| 4 | `wkb_HklMJHdK3T` | 24,000 | 24,000 | 0 |
| **Total** | **12** | **47,111** | **24,003** | **118** |

Final state: `FileIndex` 248,064 → **200,835**, `FileReference` 350,654 → **326,651**, orphan rows
of both kinds **0**, split-recordId artifacts **0** fleet-wide, unscoped 160,593 → **113,364**.

Two things worth carrying forward:

- **All 118 artifact rows were unscoped**, unlike prod where most were already scoped. They were
  therefore sitting inside bucket A, which the GC shrank 113,398 → 113,280 as a side effect — work
  the DEV-11242 migrations no longer have to do.
- The canary ended with **zero** surviving rows, which looks alarming and isn't:
  `wkb_gu0ZxkkgoF` has 0 live DataFolders, so every row it had was an orphan. The fleet total
  falling by exactly 94 is what rules out over-deletion, not the per-workbook survivor count.

## Risks

- **Deploy ordering** (above) is the only real one, and it is fully in our control: two MRs, with
  buckets A + B driven to zero and verified **on test and prod** before Phase 2 merges. Note that
  merging Phase 2 to master deploys to test on its own, so "verified on test" has to happen
  before the merge, not after.
- **Bucket C is assumed unreachable** — that rests on every lookup site deriving its folderPath
  from a live folder or plan entry. If a future caller ever looks up a path with no live folder,
  a bucket-C row could satisfy it. Cheap insurance: run the orphan GC on test anyway.
- **A new unscoped row appearing between Phase 1 and Phase 2.** All write paths have set the
  discriminator since DEV-10880 deployed, and the whole 88-row population predates that deploy,
  so the population is closed. Re-check the count immediately before merging Phase 2.
