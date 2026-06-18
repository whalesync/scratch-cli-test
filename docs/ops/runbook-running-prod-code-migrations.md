# Runbook: Running a Code Migration Against Production

How to safely run a one-off **code migration** (a registered migration in the `code-migrations`
framework) against the production database — the operational counterpart to
[CONNECTOR_GUIDE.md §9](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md#9-migrating-existing-data-when-a-connectors-layout-changes),
which covers how to _write_ one. This runbook is about how to _run_ one without breaking customer data.

The pattern in one line: **scope read-only → canary one workbook → dry-run → batch the live runs by
volume → verify each batch in the DB → watch the logs.** It was distilled from the DEV-9698 Webflow
folder-restructure rollout (228 collections across 16 prod workbooks, 0 errored) — see the worked
example in [the DEV-9698 plan](../plans/resolved/2026-06-11-webflow-folder-structure-and-support-all.md).

## Context

| Item                       | Value                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                   | `POST /code-migrations/run`, admin-gated — [code-migrations.controller.ts](../../server/src/code-migrations/code-migrations.controller.ts)                                       |
| Admin UI                   | **Settings → Dev → Migrations** — [client/.../settings/dev/migrations/page.tsx](../../client/src/app/settings/dev/migrations/page.tsx)                                            |
| Who can run it             | `role === ADMIN` with a `jwt` or `api-token` auth — [permissions.ts](../../server/src/auth/permissions.ts) (`hasAdminToolsPermission`)                                           |
| Request shape              | `{ migration, qty \| ids, dryRun }` — [code-migrations.dto.ts](../../packages/shared-types/src/dto/code-migrations/code-migrations.dto.ts) (`runMigrationSchema`)                |
| `ids` semantics            | **Workbook ids** (the run filters `DataFolder.workbookId IN ids`). `qty` takes the N oldest candidates. Provide exactly one of `ids` / `qty`.                                    |
| Result shape               | `{ migratedIds, remainingCount, dryRun, summary }` — `summary` is a per-outcome breakdown; on a **dry-run** `migratedIds` is the _would-be_ set                                  |
| Read-only DB (verify)      | `terraform/tools/connect_to_gcp_db_readonly.sh production "<SQL>"` — read-only, `statement_timeout=30s`                                                                          |
| Prod logs                  | `gcloud logging read '<filter>' --project=spv1eu-production --billing-project=spv1eu-production` (the `--billing-project` is **required** — see [CLAUDE.md](../../CLAUDE.md))     |

## Properties you can rely on

A migration written to the framework's conventions (see CONNECTOR_GUIDE §9) gives you:

- **Idempotent** — re-running converges (each migration version-gates its candidates), so a re-run skips
  already-done rows. A crashed/timed-out run is finished by simply running it again.
- **Per-connection quiesce** — while a connection migrates, its schedules are disabled, non-terminal
  publish plans cancelled, in-flight jobs drained, and live edits/enqueues blocked (409). Released in a
  `finally`. A connection too busy to drain in time is **skipped and retried**, not migrated unsafely
  ([connection-quiesce.service.ts](../../server/src/code-migrations/connection-quiesce.service.ts)).
- **Atomic per-unit rewrite** — each folder/record's multi-column rewrite is one transaction, so a failure
  rolls back cleanly with no half-migrated state.
- **Reversible** — write (and test) the inverse migration so a bad batch can be walked back.

## Process

### 1. Scope it (read-only)

Before touching the endpoint, query the prod DB read-only to learn the blast radius:

- Which workbooks/accounts are in scope, and how many units each.
- **Volume per workbook** of whatever the migration rewrites (for a path migration, `FileReference` rows —
  this drives both per-unit transaction time and total request duration).
- Which workbooks have **active syncs** (and which side) — these exercise the trickiest rewrite paths.

### 2. Canary

- **First canary: an internal / low-stakes workbook** with real (but small) data. Dry-run → live → verify
  in the DB.
- **If the migration touches sync state, do a second canary on a workbook with _populated_ sync rows**
  (a sync that has actually run) before migrating synced workbooks at large — the sync-row rewrite is the
  most failure-prone path and is _not_ exercised by a sync-less workbook. Prefer a non-critical / "(Copy)"
  workbook; keep critical customers for last.

### 3. Dry-run first

Check **Dry run** in the admin UI. A dry-run performs **no writes** (no quiesce, no flip), so you can
dry-run the **entire fleet at once** to confirm the totals: `would migrate ≈ expected`, `errored: 0`,
`unexpected path shape: 0`. Investigate any `errored` or unexpected-skip before any live run.

### 4. Batch the live runs

> ⚠️ **`POST /code-migrations/run` is synchronous** — it does every git move + DB transaction inside the
> one HTTP request. A run touching hundreds of units risks an HTTP/gateway timeout. The work still commits
> server-side and is idempotent, but you lose the result summary.

- **Size batches by volume** (from step 1) so each request stays comfortably inside the request window.
- **Separate synced from non-synced**; do the heavy and the critical-customer workbooks **isolated / last**.
- Paste `ids` = the batch's workbook ids; leave **Dry run** unchecked.

### 5. Verify each batch in the DB

Don't trust the UI summary alone — confirm against the database (read-only). Two checks:

- **Version flips** — the per-unit version and the account version. An account only flips once it has zero
  un-migrated units, so **account-at-target is itself strong proof every unit migrated**.
- **Invariant + counts preserved** — for a path migration, confirm every dependent path row still sits
  _under_ its folder (`*_outside = 0`) and row counts are unchanged. Because the path columns are rewritten
  in the **same transaction** as the version, a flipped unit's rows necessarily moved with it — so the cheap
  version check suffices for routine batches; reserve the heavy row scans for the canaries.

See [Verification SQL](#verification-sql) for the patterns used in DEV-9698.

### 6. Watch the logs (especially on a long run)

The controller logs each unit's outcome and a final `<migration> complete: {…summary…}` line. If the UI
times out, read the true result from Cloud Logging:

```bash
gcloud logging read '"<migration-name>"' \
  --project=spv1eu-production --billing-project=spv1eu-production \
  --freshness=1h --limit=50 --format='value(timestamp, jsonPayload.message, textPayload)'
```

### 7. Handle stragglers

- **Errored units / a timed-out request** → just re-run the same `ids`; idempotency skips what's done and
  finishes the rest.
- **`Accounts skipped (too busy to drain)`** → not an error; that connection had live traffic. Re-run it
  later.

## Gotchas (learned the hard way on DEV-9698)

- **Prisma's default interactive-transaction timeout is 5 s.** A large per-unit rewrite (e.g. a
  `FileReference` UPDATE over ~800k rows took ~81 s) blows past it and aborts (clean rollback, but the unit
  errors). Pass an explicit `{ timeout, maxWait }` to the `$transaction` for any rewrite whose size scales
  with user data — see [webflow-folder-restructure-path-rewrite.ts](../../server/src/code-migrations/webflow-folder-restructure-path-rewrite.ts).
- **The read-only DB connection has `statement_timeout=30s`.** Keep verification queries cheap; prefer the
  version-flip check (O(folders)) over full-table scans of `FileReference`/sync tables.
- **`gcloud logging` needs `--billing-project=spv1eu-production`** or it checks the read-only service
  account's home project (where the Logging API is disabled) and fails with a misleading `SERVICE_DISABLED`.
- **Destination-side sync rows are keyed by the _source_ folder.** When verifying a synced workbook, resolve
  affected `SyncRemoteIdMapping` rows via `SyncTablePair.destinationDataFolderId`, not by the migrated
  folder's own id (finding #9 in the DEV-9698 plan).
- **The admin UI gained `dryRun` only in DEV-9698.** Older builds can't dry-run from the UI; you'd need to
  `curl` the endpoint with an admin token.

## Verification SQL

Patterns used in DEV-9698 (adapt the table/column names to your migration). All are read-only.

**Version flips + account state** (the cheap, primary check):

```sql
SELECT version, count(*) FROM "ConnectorAccount" WHERE service = '<SERVICE>' GROUP BY version;

SELECT w.name,
  count(*) FILTER (WHERE df.version = 2) AS at_target,
  count(*) FILTER (WHERE df.version = 1) AS still_old
FROM "DataFolder" df JOIN "Workbook" w ON w.id = df."workbookId"
WHERE df."workbookId" IN ('wkb_…') AND df."connectorService" = '<SERVICE>' AND df."isAssetTable" = false
GROUP BY w.name;
```

**Sync invariant** (per folder: rows still under their folder = 0 "outside"; do this for the canaries):

```sql
SELECT df.name, df.version,
  (SELECT count(*) FROM "SyncMatchKeys" k WHERE k."dataFolderId" = df.id
     AND k."filePath" NOT LIKE ltrim(df.path,'/') || '/%') AS mk_outside,
  (SELECT count(*) FROM "SyncRemoteIdMapping" m
     JOIN "SyncTablePair" tp ON tp."destinationDataFolderId" = df.id AND tp."sourceDataFolderId" = m."dataFolderId"
     WHERE m."destinationFilePath" IS NOT NULL
       AND m."destinationFilePath" NOT LIKE ltrim(df.path,'/') || '/%') AS dest_outside
FROM "DataFolder" df
WHERE df."workbookId" = 'wkb_…' AND df."connectorService" = '<SERVICE>';
-- expect mk_outside = 0 and dest_outside = 0 for every folder, both before and after
```

**`FileReference` moved** (no stragglers at the old path; `regexp_replace` derives the pre-migration path):

```sql
WITH coll AS (
  SELECT df."workbookId", ltrim(df.path,'/') AS new_pfx,
         ltrim(regexp_replace(df.path, '/Collections/([^/]+)$', '/\1'),'/') AS old_pfx
  FROM "DataFolder" df
  WHERE df."workbookId" = 'wkb_…' AND df."connectorService" = '<SERVICE>' AND df.version = 2
)
SELECT
  (SELECT count(*) FROM "FileReference" fr, coll c WHERE fr."workbookId" = c."workbookId" AND fr."sourceFilePath" LIKE c.new_pfx || '/%') AS refs_at_new,
  (SELECT count(*) FROM "FileReference" fr, coll c WHERE fr."workbookId" = c."workbookId" AND fr."sourceFilePath" LIKE c.old_pfx || '/%') AS refs_at_old;
-- expect refs_at_old = 0; refs_at_new = the pre-migration total
```
