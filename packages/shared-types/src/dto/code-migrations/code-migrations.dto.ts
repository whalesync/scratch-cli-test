import { z } from 'zod';

export const runMigrationSchema = z.object({
  migration: z.string(),
  qty: z.number().int().min(1).optional(),
  ids: z.array(z.string()).optional(),
});

export type RunMigrationDto = z.infer<typeof runMigrationSchema>;

export type ValidatedRunMigrationDto = Required<Pick<RunMigrationDto, 'migration'>> &
  Pick<RunMigrationDto, 'qty' | 'ids'>;

export interface MigrationDescriptor {
  /** Stable identifier — used as the `migration` field on `RunMigrationDto`. */
  name: string;
  /** Human-readable summary surfaced in the admin UI when this migration is
   * selected. Should explain what the migration does, when to run it, and any
   * notable side effects (e.g. creates new entities, is/isn't idempotent). */
  description: string;
}

export interface AvailableMigrationsResponse {
  migrations: MigrationDescriptor[];
}

export interface MigrationResult {
  migratedIds: string[];
  remainingCount: number;
  migrationName: string;
}
