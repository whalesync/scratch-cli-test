import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class RunMigrationDto {
  @IsString()
  migration?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];
}

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
