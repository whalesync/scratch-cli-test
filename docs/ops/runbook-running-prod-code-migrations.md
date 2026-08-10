# Runbook: Running a Code Migration Against Production

How to safely run a one-off **code migration** (a registered migration in the `code-migrations`
framework) against the production database — the operational counterpart to
[CONNECTOR_GUIDE.md §9](../../server/src/remote-service/connectors/CONNECTOR_GUIDE.md#9-migrating-existing-data-when-a-connectors-layout-changes),
which covers how to _write_ one. This runbook is about how to _run_ one without breaking customer data.

The pattern in one line: **scope read-only → canary one unit → dry-run (or
[pre-flight offline](#offline-pre-flight-when-a-migration-cannot-dry-run)) → batch the live runs by
volume → verify each batch in the DB → watch the logs.** It was distilled from the DEV-9698 Webflow
folder-restructure rollout (228 collections across 16 prod workbooks, 0 errored) — see the worked
example in [the DEV-9698 plan](../plans/resolved/2026-06-11-webflow-folder-structure-and-support-all/2026-06-11-webflow-folder-structure-and-support-all.md)
— and extended by the DEV-10008 sync-mapping v2 backfill (48 syncs, 0 errored), which is where the
no-dry-run and per-migration-`ids` caveats come from.

## Context

| Item                       | Value                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                   | `POST /code-migrations/run`, admin-gated — [code-migrations.controller.ts](../../server/src/code-migrations/code-migrations.controller.ts)                                       |
| Admin UI                   | **Settings → Dev → Migrations** — [client/.../settings/dev/migrations/page.tsx](../../client/src/app/settings/dev/migrations/page.tsx)                                            |
| Who can run it             | `role === ADMIN` with a `jwt` or `api-token` auth — [permissions.ts](../../server/src/auth/permissions.ts) (`hasAdminToolsPermission`)                                           |
| Request shape              | `{ migration, qty \| ids, dryRun }` — [code-migrations.dto.ts](../../packages/shared-types/src/dto/code-migrations/code-migrations.dto.ts) (`runMigrationSchema`)                |
| `ids` semantics            | **Per-migration — check before you paste.** Most take workbook ids, but not all; see [What `ids` means](#what-ids-means). `qty` takes the N oldest candidates. Provide exactly one of `ids` / `qty`. |
| Result shape               | `{ migratedIds, remainingCount, dryRun, summary }` — `summary` is a per-outcome breakdown; on a **dry-run** `migratedIds` is the _would-be_ set                                  |
| Read-only DB (verify)      | `terraform/tools/connect_to_gcp_db_readonly.sh production "<SQL>"` — read-only, `statement_timeout=30s`                                                                          |
| Prod logs                  | `gcloud logging read '<filter>' --project=spv1eu-production --billing-project=spv1eu-production` (the `--billing-project` is **required** — see [CLAUDE.md](../../CLAUDE.md))     |

## What `ids` means

`ids` is a bare `string[]` on the wire ([`runMigrationSchema`](../../packages/shared-types/src/dto/code-migrations/code-migrations.dto.ts)) — **the entity type it refers to is chosen by each migration's own handler**, and there is no server-side validation that the ids you pasted are of the right kind. Pass workbook ids to a migration that filters on `Sync.id` and every id simply matches nothing: the run reports `Migrated: 0` and succeeds. **That looks identical to "already done."** Check this table first.

| Migration                              | `ids` refers to | Filter                                            |
| -------------------------------------- | --------------- | ------------------------------------------------- |
| `init-workbook-repos`                  | Workbook ids    | `Workbook.id IN ids`                              |
| `init-scratch-repos`                   | Workbook ids    | `Workbook.id IN ids`                              |
| `notion-data-source-backfill`          | Workbook ids    | `DataFolder.workbookId IN ids`                    |
| **`sync-mapping-v2-backfill`**         | **Sync ids**    | **`Sync.id IN ids AND mappingsV2 IS NULL`**       |
| `fileindex-connector-account-backfill` | Workbook ids    | `FileIndex` rows scoped per workbook              |
| `webflow-folder-restructure`           | Workbook ids    | `DataFolder.workbookId IN ids`                    |
| `webflow-folder-restructure-inverse`   | Workbook ids    | `DataFolder.workbookId IN ids`                    |

When adding a migration, state its `ids` entity in the [`AVAILABLE_MIGRATIONS`](../../server/src/code-migrations/code-migrations.controller.ts) `description` (the admin UI renders it on selection) and add a row here.

## Not every migration supports dry-run or returns a summary

Two capabilities the process below assumes are per-migration, not universal:

- **`supportsDryRun`** — the admin UI disables the checkbox and the server rejects a dry-run request (400) when it is false, so you can never believe you dry-ran something that wrote. As of this writing only `webflow-folder-restructure`, `webflow-folder-restructure-inverse`, and `fileindex-connector-account-backfill` support it. **For the rest, step 3 below is unavailable** — substitute an offline pre-flight: dump the candidate rows read-only and run the migration's own parse/transform against them locally. See [Offline pre-flight](#offline-pre-flight-when-a-migration-cannot-dry-run).
- **`summary`** — the per-outcome breakdown is optional on `MigrationResult`; only the two Webflow migrations populate it. Without it, outcomes like "skipped, a concurrent writer won" are invisible in the UI (they just shrink the `Migrated` count) and the errored ids live only in Cloud Logging. Verify from the DB, per step 5.

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

If the checkbox is disabled, this migration doesn't support dry-run — do an
[offline pre-flight](#offline-pre-flight-when-a-migration-cannot-dry-run) instead. Don't skip
straight to a live run.

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

## Offline pre-flight (when a migration cannot dry-run)

A migration with `supportsDryRun: false` gives you no preview — but you can usually build one, because
the risky part is almost always a **pure function** (parse + transform) that you can run locally against
real production data. Dump the candidate rows read-only, feed them through the migration's own parse and
transform, and assert nothing errors. Three steps:

**1. Dump the candidates read-only.** `COPY … TO STDOUT` avoids psql's aligned-table formatting, and
`json_build_object` keeps one self-describing JSON document per line:

```bash
./terraform/tools/connect_to_gcp_db_readonly.sh production "
  COPY (SELECT json_build_object('id', s.id, 'payload', s.<column>)::text
        FROM \"<Table>\" s WHERE <candidate predicate> ORDER BY s.\"createdAt\" ASC) TO STDOUT;
" 2>/dev/null | grep '^{' > .context/<migration>-preflight.jsonl
```

**2. Run the migration's real schema + transform over the dump** in a spec that reads the file, imports
the same parser and transform the migration uses (not a reimplementation), and asserts zero failures.
Guard it with an `existsSync` check so it self-skips in CI, and keep the dump in `.context/`
(gitignored). Worked example:
[`prod-v1-backfill-preflight.spec.ts`](../../server/src/code-migrations/__tests__/prod-v1-backfill-preflight.spec.ts).

**3. Re-run the same comparison after the migration** to prove what actually landed equals what the
transform predicts, rather than merely being non-null — and that the source column is unmutated, which
is what keeps the rollback valid. Worked example:
[`prod-v1-backfill-verify.spec.ts`](../../server/src/code-migrations/__tests__/prod-v1-backfill-verify.spec.ts).

This caught nothing on the DEV-10008 sync-mapping backfill (48/48 clean, and the live run matched
exactly) — which is the point: it converted "no dry-run available, hope it parses" into a known-good
run before touching 19 customers' syncs. The zod schemas involved were `.strict()`, so a single stray
key in any stored document would have silently landed that row in `errored`.

## Gotchas (learned the hard way on DEV-9698 and DEV-10008)

- **`ids` is not always workbook ids.** See [What `ids` means](#what-ids-means). The wrong entity type
  matches nothing and reports a successful `Migrated: 0` — indistinguishable from "already done."
- **Comparing a `jsonb` column against a locally-computed value: sort object keys first.** Postgres
  `jsonb` does not preserve write-time key order, so a plain `JSON.stringify` diff reports a mismatch on
  every row even when the documents are identical. Serialize with keys sorted recursively, and keep
  array order (that's real data, not formatting).
- **A compare-and-set guarded on `updatedAt` races with anything that touches the row.** A scheduled
  sync bumps `updatedAt` via `lastSyncTime`, so migrating rows on a 5-minute cron can no-op as
  "skipped, concurrent writer won." That's benign — re-run the same ids; it's a no-op for what already
  landed. Migrate live/scheduled entities in their own final batch so the skips are easy to spot.
- **A row with no parent workbook has no organization, so it produces no audit entry.** Verify counts
  from the entity table, not from `AuditLogEvent`.
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
