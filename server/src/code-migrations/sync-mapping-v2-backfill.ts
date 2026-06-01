/**
 * Phase 3 of the sync-mapping v1 → v2 dual-column migration (DEV-10008):
 * per-row decision logic for backfilling the v2 mapping shape into
 * `Sync.mappingsV2` for syncs created before the dual-column model shipped.
 *
 * This module exports the pure, dependency-injected core of the backfill. The
 * orchestrator lives in [CodeMigrationsController](./code-migrations.controller.ts)
 * (`runSyncMappingV2Backfill`) — it wires the real Prisma / audit services into
 * `SyncMappingV2BackfillDeps` and iterates `Sync` rows where `mappingsV2 IS
 * NULL`, calling `backfillSyncMappingRow` once per row. Triggered manually via
 * the admin `POST /code-migrations/run` endpoint with
 * `migration: 'sync-mapping-v2-backfill'`.
 *
 * Behaviour
 * ---------
 * Each candidate row still has its real v1 mapping in the frozen `mappings`
 * column and `mappingsV2 = NULL`. The backfill parses `mappings` as v1, runs
 * `transformV1ToV2` in memory, and writes the result to `mappingsV2` via a
 * compare-and-set guarded on `updatedAt` being unchanged AND `mappingsV2`
 * still being NULL. If a concurrent save (or a parallel backfill batch)
 * populated `mappingsV2` between the read and the write, the conditional
 * update touches zero rows and we report it as a skip — the row is already
 * migrated, so leaving it alone is correct.
 *
 * The frozen v1 `mappings` column is never modified: the migration is
 * non-destructive and fully reversible by clearing `mappingsV2` back to NULL.
 *
 * Idempotency: the candidate query filters `mappingsV2 IS NULL`, so re-runs
 * naturally skip rows already at v2. Safe to re-run; safe to run in parallel
 * batches (the compare-and-set deduplicates writes).
 *
 * Malformed v1 on disk (a row whose `mappings` fails the v1 zod schema) is
 * accumulated into the batch summary as an error and skipped — never thrown to
 * HTTP. Such a row keeps reading its v1 `mappings` via the read choke point
 * until the underlying data is repaired.
 */

import { Prisma } from '@prisma/client';
import { SyncId, SyncMappingV1, SyncMappingV2, transformV1ToV2 } from '@spinner/shared-types';
import { syncMappingV1Schema } from '../sync/sync-mapping.schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker placed on audit log entries created by this backfill, so a future
 * audit (or the Phase 4 rollback) can identify exactly which `Sync` rows had
 * their `mappingsV2` populated by this migration vs. ordinary user activity.
 * Queryable via `WHERE context->>'marker' = 'sync_mapping_v2_backfill'`.
 */
export const SYNC_MAPPING_V2_BACKFILL_AUDIT_MARKER = 'sync_mapping_v2_backfill';

// ---------------------------------------------------------------------------
// Core types — injected into `backfillSyncMappingRow` for unit testing.
// ---------------------------------------------------------------------------

/**
 * Per-row state needed to backfill a single sync. Drawn from the `Sync` row
 * (id, the frozen v1 `mappings`, `updatedAt` for the compare-and-set) and its
 * parent `Workbook` (for the audit entry's organizationId).
 */
export interface SyncRowToBackfill {
  id: SyncId;
  /** Parent workbook's organization. `null` when the sync has no workbook (an
   * orphaned row) — such a row is still backfilled, but no audit entry is
   * written because audit events require an organization. */
  organizationId: string | null;
  /** Read alongside `mappings` so the compare-and-set can detect a concurrent
   * edit between read and write. */
  updatedAt: Date;
  /** The raw, frozen v1 `mappings` JSON column. Parsed here pre-transform. */
  rawV1Mappings: Prisma.JsonValue;
}

export interface SyncMappingV2BackfillDeps {
  /**
   * Compare-and-set write: set `mappingsV2` for `syncId` only when its
   * `updatedAt` still equals `previouslyReadUpdatedAt` AND `mappingsV2` is
   * still NULL. Returns the number of rows actually written (0 or 1). A
   * concurrent save or parallel backfill batch that populated `mappingsV2`
   * between the row read and this write makes it a no-op (returns 0).
   */
  writeMappingsV2IfUnchanged: (
    syncId: SyncId,
    previouslyReadUpdatedAt: Date,
    mappingsV2: SyncMappingV2,
  ) => Promise<number>;

  /** Write an audit log entry. Implementations forward to AuditLogService. */
  logAudit: (entry: SyncMappingV2BackfillAuditEntry) => Promise<void>;

  /** When true, no writes are performed — the function still parses and
   * transforms and returns the would-be result. Test/scaffolding hatch; the
   * production controller always passes `false`. */
  dryRun: boolean;
}

export interface SyncMappingV2BackfillAuditEntry {
  /** The `Sync` whose `mappingsV2` we populated. */
  entityId: SyncId;
  organizationId: string;
  message: string;
  /** Free-form context. Always includes `marker: SYNC_MAPPING_V2_BACKFILL_AUDIT_MARKER`. */
  context: Prisma.InputJsonObject;
}

export type SyncMappingV2BackfillResult =
  | { kind: 'transformed' } // parsed v1, wrote v2
  | { kind: 'skipped_concurrent_write' } // compare-and-set wrote 0 rows
  | { kind: 'errored'; error: unknown }; // v1 parse / transform failed

// ---------------------------------------------------------------------------
// Core logic — the only thing the unit test cares about.
// ---------------------------------------------------------------------------

/**
 * Apply the backfill to a single sync row. Pure-ish: every side effect goes
 * through `deps`, so the test substitutes in-memory stubs and asserts on the
 * call graph and the transformed shape.
 *
 * Decision tree:
 *   1. Parse the frozen `mappings` as v1; on failure return `errored` (caller
 *      accumulates and moves on — never throws).
 *   2. Transform v1 → v2 in memory.
 *   3. In dry-run, stop here and report `transformed`.
 *   4. Compare-and-set write `mappingsV2`. If it wrote 0 rows (a concurrent
 *      writer beat us), report `skipped_concurrent_write` and write no audit.
 *   5. On a real write, emit one audit entry (when an organization is known).
 */
export async function backfillSyncMappingRow(
  row: SyncRowToBackfill,
  deps: SyncMappingV2BackfillDeps,
): Promise<SyncMappingV2BackfillResult> {
  let mappingsV2: SyncMappingV2;
  try {
    // The v1 zod schema parses to a structurally-equivalent type with plain
    // `string` where the branded shape uses `DataFolderId` etc. Match the
    // read-choke-point convention (parseStoredMappings) and cast at the
    // parse boundary.
    const mappingsV1 = syncMappingV1Schema.parse(row.rawV1Mappings) as unknown as SyncMappingV1;
    mappingsV2 = transformV1ToV2(mappingsV1);
  } catch (error) {
    return { kind: 'errored', error };
  }

  if (deps.dryRun) {
    return { kind: 'transformed' };
  }

  const rowsWritten = await deps.writeMappingsV2IfUnchanged(row.id, row.updatedAt, mappingsV2);
  if (rowsWritten === 0) {
    return { kind: 'skipped_concurrent_write' };
  }

  if (row.organizationId !== null) {
    await deps.logAudit({
      entityId: row.id,
      organizationId: row.organizationId,
      message: 'Backfilled sync mappings to the v2 format',
      context: {
        marker: SYNC_MAPPING_V2_BACKFILL_AUDIT_MARKER,
        action: 'transform_v1_to_v2',
        syncId: row.id,
      },
    });
  }

  return { kind: 'transformed' };
}

// ---------------------------------------------------------------------------
// Summary aggregation — also testable.
// ---------------------------------------------------------------------------

export interface SyncMappingV2BackfillSummary {
  total: number;
  transformed: number;
  skipped_concurrent_write: number;
  errored: number;
  /** The id + message of each row that failed to parse/transform, so the
   * operator can see which syncs need data repair without scraping logs. */
  errors: Array<{ syncId: string; message: string }>;
}

export function emptySyncMappingV2BackfillSummary(): SyncMappingV2BackfillSummary {
  return {
    total: 0,
    transformed: 0,
    skipped_concurrent_write: 0,
    errored: 0,
    errors: [],
  };
}

export function accumulateSyncMappingV2Backfill(
  summary: SyncMappingV2BackfillSummary,
  syncId: string,
  result: SyncMappingV2BackfillResult,
): void {
  summary.total += 1;
  switch (result.kind) {
    case 'transformed':
      summary.transformed += 1;
      break;
    case 'skipped_concurrent_write':
      summary.skipped_concurrent_write += 1;
      break;
    case 'errored':
      summary.errored += 1;
      summary.errors.push({
        syncId,
        message: result.error instanceof Error ? result.error.message : String(result.error),
      });
      break;
  }
}
