import { z } from 'zod';

export const runMigrationSchema = z.object({
  migration: z.string(),
  qty: z.number().int().min(1).optional(),
  ids: z.array(z.string()).optional(),
  /**
   * When true, a migration that supports it walks its decision tree and reports
   * the would-be changes without performing any writes. Migrations that do not
   * support dry-run ignore it. Defaults to false (a real run).
   */
  dryRun: z.boolean().optional(),
});

export type RunMigrationDto = z.infer<typeof runMigrationSchema>;

export type ValidatedRunMigrationDto = Required<Pick<RunMigrationDto, 'migration'>> &
  Pick<RunMigrationDto, 'qty' | 'ids' | 'dryRun'>;

export interface MigrationDescriptor {
  /** Stable identifier — used as the `migration` field on `RunMigrationDto`. */
  name: string;
  /** Human-readable summary surfaced in the admin UI when this migration is
   * selected. Should explain what the migration does, when to run it, and any
   * notable side effects (e.g. creates new entities, is/isn't idempotent). */
  description: string;
  /**
   * Whether this migration honors `RunMigrationDto.dryRun` (walks its decision
   * tree and reports the would-be changes without writing). The admin UI only
   * enables the dry-run checkbox for migrations where this is true, and the
   * server rejects a dry-run request for a migration where it is false (so a
   * user can never believe they dry-ran a migration that actually wrote).
   */
  supportsDryRun: boolean;
}

export interface AvailableMigrationsResponse {
  migrations: MigrationDescriptor[];
}

/**
 * One line of a migration's per-outcome breakdown, rendered verbatim by the
 * admin UI. Kept migration-agnostic (a labeled count, not a typed enum) so the
 * frontend needs no per-migration knowledge — every migration that produces a
 * summary emits its own labels.
 */
export interface MigrationResultSummaryRow {
  label: string;
  count: number;
}

export interface MigrationResult {
  /**
   * Ids of the entities that were migrated. On a dry-run this instead lists the
   * entities that *would* be migrated (nothing is written) — see `dryRun`.
   */
  migratedIds: string[];
  remainingCount: number;
  migrationName: string;
  /**
   * True when this run was a dry-run — the migration reported its would-be
   * changes and wrote nothing. Always false for a real run (and for migrations
   * that do not support dry-run, which always perform a real run).
   */
  dryRun: boolean;
  /**
   * Optional per-outcome breakdown (e.g. migrated / skipped-by-reason / errored
   * / accounts flipped). Present for migrations that produce one; omitted by
   * those that don't, in which case the UI shows only `migratedIds` +
   * `remainingCount`.
   */
  summary?: MigrationResultSummaryRow[];
}
