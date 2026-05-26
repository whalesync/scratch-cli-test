/**
 * Phase 2 of the @notionhq/client 3.x → 5.x upgrade (DEV-8910): per-folder
 * decision logic for backfilling `data_source_id` into the `tableId` column of
 * every Notion DataFolder.
 *
 * This module exports the pure, dependency-injected core of the backfill.
 * The orchestrator lives in [CodeMigrationsController](./code-migrations.controller.ts)
 * (`runNotionDataSourceBackfill`) — it wires the real Prisma/Notion/audit
 * services into `BackfillDeps` and iterates DataFolders, calling
 * `backfillNotionFolder` once per row. Triggered manually via the admin
 * `POST /code-migrations/run` endpoint with `migration: 'notion-data-source-backfill'`.
 *
 * Behavior
 * --------
 * In Notion API 2025-09-03, a database is a *container* of one or more data
 * sources, and properties + rows live on the data source rather than the
 * database. Today (API 2022-06-28) we store only the database ID in
 * `DataFolder.tableId` ⇒ `[databaseId]`. After this backfill:
 *
 *   - Single-source databases (the common case): `tableId` ⇒ `[databaseId, dataSourceId]`.
 *     Transparent to the user.
 *   - Multi-source databases: the existing folder is rewritten to point at
 *     `data_sources[0]`, AND new DataFolder rows are created for each
 *     additional source. New rows are empty until the user's next pull.
 *     The audit log carries the `notion_multisource_backfill` marker so the
 *     new rows are discoverable for rollback.
 *
 * The orchestrator constructs the Notion `Client` with
 * `notionVersion: '2025-09-03'` so `databases.retrieve` returns the
 * `data_sources` array. The production connector's Client is unchanged in
 * this phase — Phase 3 bumps it in lockstep with `fetchJsonTableSpec`'s
 * switch to `dataSources.retrieve` (the response shape under 2025-09-03 no
 * longer carries `db.properties`).
 *
 * Idempotency: re-runs skip folders that already have `tableId.length === 2`.
 */

import { Prisma } from '@prisma/client';
import { createDataFolderId, DataFolderId } from '@spinner/shared-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker placed on audit log entries created by this backfill, so a future
 * rollback (or audit) can identify exactly which DataFolders / tableId
 * mutations came from this migration vs. ordinary user activity. Queryable
 * via `WHERE context->>'marker' = 'notion_multisource_backfill'`.
 */
export const BACKFILL_AUDIT_MARKER = 'notion_multisource_backfill';

// ---------------------------------------------------------------------------
// Core types — injected into `backfillNotionFolder` for unit testing.
// ---------------------------------------------------------------------------

export interface DataSourceInfo {
  id: string;
  name: string;
}

/**
 * Per-folder state needed to backfill. Drawn from the `DataFolder` and the
 * parent `Workbook` (for the audit log entry's organizationId).
 */
export interface FolderToBackfill {
  id: DataFolderId;
  workbookId: string;
  organizationId: string;
  connectorAccountId: string;
  tableId: string[];
  name: string;
}

export type NotionFetchOutcome =
  | { kind: 'ok'; dataSources: DataSourceInfo[] }
  | { kind: 'not_found' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; error: unknown };

export interface BackfillDeps {
  /** Look up the data sources for a Notion database, scoped to the credentials
   * of the given connector account. Implementations cache the per-account
   * Notion Client. */
  fetchDataSources: (databaseId: string, connectorAccountId: string) => Promise<NotionFetchOutcome>;

  /** Persist a new `tableId` array onto an existing DataFolder. */
  updateFolderTableId: (folderId: DataFolderId, tableId: string[]) => Promise<void>;

  /** Create a new DataFolder row in the same Workbook, scoped to the same
   * ConnectorAccount, with the supplied name + tableId. Returns the new id. */
  createDataFolder: (input: NewDataFolderInput) => Promise<DataFolderId>;

  /** Write an audit log entry. Implementations forward to AuditLogService. */
  logAudit: (entry: AuditLogEntry) => Promise<void>;

  /** When true, no writes are performed — the function still walks the
   * decision tree and returns the would-be result. Mainly a safety hatch for
   * test scaffolding; the production controller always passes `false`. */
  dryRun: boolean;
}

export interface NewDataFolderInput {
  id: DataFolderId;
  workbookId: string;
  connectorAccountId: string;
  name: string;
  tableId: string[];
}

export interface AuditLogEntry {
  /** The DataFolder the audit entry concerns — either the folder we rewrote
   * (single/multi-source primary case) or a newly-created folder for an
   * additional data source. Typed as `DataFolderId` so the live impl can pass
   * it straight to AuditLogService (which requires the branded `AnyId`). */
  entityId: DataFolderId;
  organizationId: string;
  message: string;
  /** Free-form context. Always includes `marker: BACKFILL_AUDIT_MARKER`. Typed
   * against Prisma's JSON-object input so the live impl can hand it straight
   * to AuditLogService without a cast. */
  context: Prisma.InputJsonObject;
}

export type FolderResult =
  | { kind: 'skipped_already_backfilled' }
  | { kind: 'single_source_rewritten'; dataSourceId: string }
  | { kind: 'multi_source_expanded'; primaryDataSourceId: string; newFolderIds: DataFolderId[] }
  | { kind: 'skipped_missing_in_notion'; reason: 'not_found' | 'unauthorized' }
  | { kind: 'errored'; error: unknown };

// ---------------------------------------------------------------------------
// Core logic — the only thing the unit test cares about.
// ---------------------------------------------------------------------------

/**
 * Apply the backfill decision tree to a single folder. Pure-ish: every side
 * effect goes through `deps`, so the test substitutes in-memory stubs and
 * asserts on the call graph.
 *
 * Decision tree:
 *   1. If `tableId.length >= 2` → already backfilled, skip.
 *   2. Call `fetchDataSources`. On not_found/unauthorized, log and skip; on
 *      transport error, return errored (caller decides whether to abort).
 *   3. If exactly one data source → rewrite tableId in place.
 *   4. If multiple data sources → rewrite to source[0], create one new
 *      DataFolder per remaining source, and write audit log entries for each
 *      action.
 */
export async function backfillNotionFolder(folder: FolderToBackfill, deps: BackfillDeps): Promise<FolderResult> {
  if (folder.tableId.length >= 2) {
    return { kind: 'skipped_already_backfilled' };
  }
  if (folder.tableId.length !== 1) {
    // Defensive: a Notion folder is supposed to have exactly one element today.
    // Anything else (0 elements) is malformed — log and skip rather than corrupt.
    return { kind: 'errored', error: `unexpected tableId.length: ${folder.tableId.length}` };
  }
  const databaseId = folder.tableId[0];

  const outcome = await deps.fetchDataSources(databaseId, folder.connectorAccountId);
  if (outcome.kind === 'not_found') return { kind: 'skipped_missing_in_notion', reason: 'not_found' };
  if (outcome.kind === 'unauthorized') return { kind: 'skipped_missing_in_notion', reason: 'unauthorized' };
  if (outcome.kind === 'error') return { kind: 'errored', error: outcome.error };

  const dataSources = outcome.dataSources;
  if (dataSources.length === 0) {
    // Should never happen — a database always has at least one data source.
    return { kind: 'errored', error: 'Notion database returned zero data sources' };
  }

  const primary = dataSources[0];
  const newTableId = [databaseId, primary.id];

  if (!deps.dryRun) {
    await deps.updateFolderTableId(folder.id, newTableId);
    await deps.logAudit({
      entityId: folder.id,
      organizationId: folder.organizationId,
      message:
        dataSources.length === 1
          ? `Backfilled Notion data source ID into folder "${folder.name}"`
          : `Backfilled Notion data source ID into folder "${folder.name}" (primary source of ${dataSources.length})`,
      context: {
        marker: BACKFILL_AUDIT_MARKER,
        action: 'rewrite_tableid',
        databaseId,
        dataSourceId: primary.id,
        dataSourceName: primary.name,
        totalDataSources: dataSources.length,
      },
    });
  }

  if (dataSources.length === 1) {
    return { kind: 'single_source_rewritten', dataSourceId: primary.id };
  }

  // Multi-source: create a new folder per additional source.
  const newFolderIds: DataFolderId[] = [];
  for (let i = 1; i < dataSources.length; i++) {
    const ds = dataSources[i];
    const newFolderId = createDataFolderId();
    newFolderIds.push(newFolderId);

    if (!deps.dryRun) {
      await deps.createDataFolder({
        id: newFolderId,
        workbookId: folder.workbookId,
        connectorAccountId: folder.connectorAccountId,
        name: ds.name || `${folder.name} (source ${i + 1})`,
        tableId: [databaseId, ds.id],
      });
      await deps.logAudit({
        entityId: newFolderId,
        organizationId: folder.organizationId,
        message: `Created data folder "${ds.name}" for additional Notion data source in database backing "${folder.name}"`,
        context: {
          marker: BACKFILL_AUDIT_MARKER,
          action: 'create_folder_for_additional_source',
          databaseId,
          dataSourceId: ds.id,
          dataSourceName: ds.name,
          originalFolderId: folder.id,
          sourceIndex: i,
        },
      });
    }
  }

  return { kind: 'multi_source_expanded', primaryDataSourceId: primary.id, newFolderIds };
}

// ---------------------------------------------------------------------------
// Summary aggregation — also testable.
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  total: number;
  single_source_rewritten: number;
  multi_source_expanded: number;
  multi_source_new_folders: number;
  skipped_already_backfilled: number;
  skipped_missing_in_notion: number;
  errored: number;
}

export function emptySummary(): BackfillSummary {
  return {
    total: 0,
    single_source_rewritten: 0,
    multi_source_expanded: 0,
    multi_source_new_folders: 0,
    skipped_already_backfilled: 0,
    skipped_missing_in_notion: 0,
    errored: 0,
  };
}

export function accumulate(summary: BackfillSummary, result: FolderResult): void {
  summary.total += 1;
  switch (result.kind) {
    case 'skipped_already_backfilled':
      summary.skipped_already_backfilled += 1;
      break;
    case 'single_source_rewritten':
      summary.single_source_rewritten += 1;
      break;
    case 'multi_source_expanded':
      summary.multi_source_expanded += 1;
      summary.multi_source_new_folders += result.newFolderIds.length;
      break;
    case 'skipped_missing_in_notion':
      summary.skipped_missing_in_notion += 1;
      break;
    case 'errored':
      summary.errored += 1;
      break;
  }
}
