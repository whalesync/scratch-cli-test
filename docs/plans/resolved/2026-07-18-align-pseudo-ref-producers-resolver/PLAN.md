# DEV-10880 — Align all pseudo-ref (`@/…`) producers + resolver to the canonical workspace-absolute format

Status: **Resolved.** Code merged to `master` + deployed to prod (MRs !3085 docs + the resolver/FileIndex
code change, commit `cc0c64a3c`). Prod data verified self-healed read-only (see [Final state](#final-state--prod-verification-2026-07-19));
the `fileindex-connector-account-backfill` code-migration is a **no-op on current prod** and does not need to
be run. Green (lint-strict, prettier, build, no schema drift).
Branch: `align-pseudo-ref-producers-v2` (merged)
Canonical spec: [`docs/pseudo-refs.md`](../../pseudo-refs.md)

## Problem (verified against prod `wkb_wi45a7p30d`)

A pseudo-ref is the **workspace-absolute** path to a target record file, connection folder
first: `@/HubSpot/Contacts/marcos-perales-greyhound.json`. The desktop/agent authors this
canonical form. But the server resolver + FileIndex are keyed **connection-relative**
(`Contacts`, no connection segment), so the resolver looks up `folder="HubSpot/Contacts"`
verbatim, finds nothing, and publish fails:

```
Cannot resolve pseudo-ref "@/HubSpot/Contacts/…": no record ID found in FileIndex
for folder="HubSpot/Contacts" file="marcos-perales-greyhound.json"
```

Ground truth confirmed by read-only prod query:

- The workbook has **two HubSpot connections** — `coa_pFo7gysFqD` (displayName `HubSpot`) and
  `coa_ntsdSrBuRt` (`HubSpot Testing`). This is exactly the "two connections share a
  `Contacts` folder" case.
- **24,256 `Contacts` FileIndex rows all under bare `folderPath="Contacts"`** — both HubSpot
  connections collapse into one ambiguous key. FileIndex has **no connection discriminator**.

## Key facts (from code)

- **Connection folder segment = `sanitize_filename(displayName)`** (Rust `markers.rs`) — new
  workspaces; legacy workspaces use `sanitize_filename("{SERVICE} - {displayName}")`. For
  ordinary names this is identity. Computed client-side; **not stored server-side**.
- `DataFolder.path` is **connection-relative** — `buildConnectorFolderPath` deliberately
  ignores the display name (`_connectorDisplayName`). Each connection is its own git repo.
- `FileIndex.folderPath` is `DataFolder.path` minus the leading slash — connection-relative at
  **every** write site (2 pull jobs + 2 publish dispatch sites).
- A `PublishPlan` is **single-connection** (`plan.connectorAccountId`), available in every
  create/backfill dispatch — but `resolveBatchPseudoRefs(workbookId, …)` is called with **no**
  connection context.
- A DataFolder join **cannot** disambiguate two connections sharing a folder name, because both
  connections' FileIndex rows carry the identical `folderPath` string. A discriminator column
  on FileIndex is required to satisfy the acceptance criterion.
- Sync's `source-fk-to-dest-fk` transformer emits `@/${destinationFilePath}` where
  `destinationFilePath` is the **connection-relative** record `filePath` → wrong (missing the
  connection folder).
- `FileReference` stores FK values by remote id; a `@/…` string would be stored verbatim as
  `targetRemoteId` (harmless noise, never matches a real id) and self-heals on re-pull. **No
  change required** beyond a defensive note.

## Design decision: add `connectorAccountId` to FileIndex + translate in the resolver

Per `pseudo-refs.md` Implementation Notes ("the connection segment selects the connection; the
remainder is the connection-relative file path"), and because two connections can share a
folder name:

1. **FileIndex gains a nullable `connectorAccountId` column** + a lookup index
   `@@index([workbookId, connectorAccountId, folderPath, filename])`. The existing unique key is
   left unchanged (lower migration risk); `connectorAccountId` is a routing/scoping column.
   Populate it at all 4 `upsertBatch` write sites (all already have the connectorAccountId).
2. **Resolver translates + scopes, leniently.** `resolveBatchPseudoRefs` gains a
   `planConnectorAccountId` argument. For each `@/<seg1>/<rest>`:
   - Build a per-workbook map `folderName → connectorAccountId` from every connection's
     `sanitize_filename(displayName)` and `sanitize_filename("{SERVICE} - {displayName}")`.
   - If `<seg1>` matches a connection folder → target = that connection, connection-relative
     path = `<rest>` (workspace-absolute form).
   - Else → legacy connection-relative ref: target = plan's connection, path = full path.
   - Look up FileIndex scoped to the target `connectorAccountId`; if the scoped lookup misses
     (e.g. an existing row whose `connectorAccountId` is still null pre-backfill), **fall back**
     to the workbook-global lookup (today's behavior). This is the "lenient during rollout"
     read — no on-disk or FileIndex data migration is required for correctness of co-pending
     publishes, because the referenced co-pending record is (re)indexed **with** its
     `connectorAccountId` during this same plan's create phase.
3. **Sync producer** emits the workspace-absolute form: `@/${connFolder}/${destinationFilePath}`
   where `connFolder = sanitize_filename(destination connection displayName)`, plumbed via
   `FkMappingResult`. (Idempotency check will rewrite old connection-relative refs to canonical
   on the next sync — a beneficial one-time migration of pending refs.)
4. **Data migration (optional, admin-gated code-migration).** Backfill `FileIndex.connectorAccountId`
   via a per-DataFolder loop (`workbookId, ltrim(path,'/') → connectorAccountId`) for the
   unambiguous majority. Shared-folder-name rows across two connections stay null and are fixed
   by the next pull (which writes the correct connectorAccountId). On-disk `@/` values need **no**
   git rewrite — the lenient resolver accepts the legacy form.
5. **Docs**: remove the "Known gap" note in `pseudo-refs.md` once the resolver conforms.

### Why not store FileIndex.folderPath workspace-absolute (the other option)?

It would force every FileIndex consumer (pull dedup, stale detection, rename, publish crud) to
switch to workspace-absolute keys, making `folderPath` inconsistent with `DataFolder.path`,
`recreatedIdMap.folder`, CLI patch paths, and `FileReference.sourceFilePath` (all
connection-relative). The connection folder name is also mutable (rename orphans keys) and
client-computed (not reproducible in SQL). Adding a stable `connectorAccountId` keeps
`folderPath` connection-relative everywhere and disambiguates by the stable account id.

## Work items

### Code
- [x] `server/prisma/schema.prisma` + migration `20260718150000_file_index_add_connector_account_id`:
      `FileIndex.connectorAccountId String?` only. **No dedicated index** — runtime lookups query by
      `(workbookId, folderPath, filename)` and apply the connection preference in JS, so they use the
      existing index; nothing filters on `connectorAccountId` in a hot path (review catch: a permanent
      4-column index would be pure write-cost on a multi-million-row table for zero read benefit).
- [x] `file-index.service.ts`: `connectorAccountId` on `FileIndexEntry`; written in `upsertBatch`
      (sticky — `?? undefined` in UPDATE so the rename upsert can't clobber it); connection-aware
      `getRecordId`/`getRecordIds` via exported `pickPreferredRecordId` (prefer scoped row, else first).
- [x] `connector-folder-path.util.ts`: `sanitizeConnectionFolderName` (Rust `sanitize_filename` twin)
      + `sanitizeLegacyConnectionFolderName`; map builder lives in the resolver.
- [x] `ref-resolver.service.ts`: `planConnectorAccountId` arg; `buildConnectionFolderToAccountIdMap`
      (both naming variants, ambiguous names dropped); `translatePseudoRef` (workspace-absolute strip
      + lenient legacy fallback to the plan connection); scoped lookup.
- [x] `publish-plan-run.service.ts`: pass `connectorAccountId` to both `resolveBatchPseudoRefs` calls;
      set it on the create-batch `upsertBatch`; scope the edit-phase `getRecordId`. (Rename upsert
      needs no change — the sticky-update preserves the value.)
- [x] `pull-files.job.ts` + `pull-linked-folder-files.job.ts`: set `connectorAccountId` on
      `upsertBatch`; also scope the pull-files `getRecordIds` and publish-build delete-lookups.
- [x] `source-fk-to-dest-fk.transformer.ts` + `lookup-tools.ts` + `FkMappingResult`: emit
      workspace-absolute (prepend sanitized destination connection folder; null → legacy fallback).
- [x] `code-migrations`: `fileindex-connector-account-backfill` (admin-gated, dryRun-able) + pure
      `resolveFolderPathsToConnectorAccountIds` helper.

### Data
- [x] Backfill migration authored (unambiguous folderPaths scoped; shared-folder ones left NULL for
      re-pull). Repro workbook's co-pending publishes work via fresh create-phase writes; its ambiguous
      HubSpot `Contacts` rows resolve on next pull. **Run pending** (admin action on prod).

### Tests (all green)
- [x] `publish-plan-ref-resolver.service.spec.ts`: workspace-absolute strip, two-connection routing,
      legacy + `"<SERVICE> - <displayName>"` forms, unresolvable error message.
- [x] `source-fk-to-dest-fk.transformer.spec.ts`: workspace-absolute output + null fallback + stale-ref rewrite.
- [x] `file-index.service.spec.ts`: `pickPreferredRecordId` + connection-scoped `getRecordIds` disambiguation.
- [x] `fileindex-connector-account-backfill.spec.ts`: unambiguous vs ambiguous folderPath resolution.
- [x] `connector-folder-path.util.spec.ts`: Rust-parity sanitizer cases.
- [x] Integration `fetch-edit-publish.spec.ts`: co-pending create + FK now authored **workspace-absolute** (real PG, green).
- [x] Integration `pseudo-ref-connection-scoping.spec.ts` (new): **two HubSpot connections sharing `Contacts`**, real PG — segment routing + legacy fallback (green).
- [x] CLI `driver-run.js`: FK pseudo-ref flipped to workspace-absolute (the two driver-publish cases stay `.skip`'d for the separate re-anchor bug, `docs/plans/2026-06-01-publish-backfill-reanchor-bug`).
- [x] `docs/pseudo-refs.md`: "Known gap" note removed; Implementation notes now describe the shipped resolver.

## Adversarial review — 6 confirmed findings, 4 fixed

An adversarial multi-agent review of the diff confirmed 6 defects. Applied fixes:

- **[MED] create-phase omitted `connectorAccountId`** (`publish-plan-run.service.ts` `dispatchCreateBatch`)
  — the create call to `resolveBatchPseudoRefs` was workbook-global; now passes the plan connection
  (mirrors the edit/backfill path). **Fixed.**
- **[HIGH] sync producer used the SOURCE connection folder** (`lookup-tools.ts`) — `referencedDataFolderId`
  is a source folder, so it emitted `@/<sourceConn>/<destPath>`. Now hops `SyncTablePair`
  (source→destination) and reads the **destination** folder's connection. **Fixed** (+ `lookup-tools.spec.ts`).
- **[MED] delete-phase deleted a sibling connection's index row** (`dispatchDeleteBatch`) — deleted by
  `(folderPath, filename)`, which also matched another connection's same-named file. Now deletes by the
  unique `(folderPath, recordId)` (every delete entry has `remoteRecordId`). **Fixed.**
- **[LOW] legacy ref whose first segment coincides with a connection name was misrouted** (`ref-resolver`)
  — added a **lazy legacy fallback**: if the primary (workspace-absolute) interpretation misses, retry the
  connection-relative interpretation within the plan connection (second bulk lookup, only for misses, so
  the common path still pays one query). **Fixed** (+ resolver test).

### Accepted limitations (documented, not fixed here)
- **[LOW] one-batch cross-connection same-file collision** — `getRecordIds` returns a `folderPath:filename`
  keyed map, so a single record with two link fields pointing at two connections' records that share BOTH
  folder name AND filename resolves both to one id. Astronomically rare (needs identical folder + filename
  across connections in one record); noted in `dedupeRefs`.
- **[MED, pre-existing] FileIndex unique-key remote-id collision** — two same-service connections whose
  records share a remote id collapse on `@@unique([workbookId, folderPath, recordId])`. Pre-existing (not a
  regression); adding `connectorAccountId` to the unique key is unsafe while it's nullable (NULL-distinct →
  duplicate-insert on upsert). Documented in `schema.prisma`; tracked separately.

## Sequencing
Land lenient/translating resolver + producer + writes + schema together (one coherent change;
resolver leniency means no flag-day). Run the backfill code-migration afterward. Tighten docs.

## Final state — prod verification (2026-07-19)

Both MRs are merged to `master` and deployed to `prod` (docs `aae66b5a9` + code `cc0c64a3c`). A
read-only prod investigation (`connect_to_gcp_db_readonly.sh production`) confirmed the acceptance
criteria are met **without running the backfill**:

- **Code is live and scoping.** `FileIndex`: 2,112,265 rows total, **2,017,833 already carry
  `connectorAccountId`** — the write-path (both pull jobs + both publish dispatch sites) is populating
  the discriminator on every pull/publish.
- **Repro workbook `wkb_wi45a7p30d` is repaired.** Its two HubSpot connections are `HubSpot` and
  `HubSpot Testing` (distinct folder segments → the resolver's connection-segment routing
  disambiguates them). All `Contacts` rows are scoped; the workbook is 97.7% scoped (203,138 /
  208,022). Co-pending publishes resolve via fresh create-phase writes.
- **The backfill would scope 0 rows.** Running the read-only equivalent of the dry-run across all 28
  workbooks with unscoped rows, `would_scope = 0` for every one. Every live, unambiguous folder is
  already scoped; the 94,432 leftover unscoped rows are **~93,556 orphans (99.1%)** — index rows whose
  `folderPath` has no live DataFolder (folders/connections deleted months ago, e.g. `wkb_DyOZyRsutG`'s
  `Airtable/Extreme/*` last seen 2026-03-02) — plus an ~876-row ambiguous shared-folder tail that the
  next pull scopes. There is nothing left for the backfill to map to a live connection.

**Decision:** do not run `fileindex-connector-account-backfill` on prod — it is a no-op on this data
set. The self-healing write-path already satisfies "existing prod data migrated/repaired."

**Spun-out follow-up:** the orphaned-row finding is a pre-existing cleanup gap unrelated to the
pseudo-ref format — connection delete/reset (`ConnectorAccountService.removeConnectionData` /
`resetConnection`) bulk-delete DataFolders via `deleteMany`, bypassing the per-folder `FileIndex` /
`FileReference` cleanup. Tracked as **DEV-10885** (GC the ~93.5k orphans + close the cleanup gap).
