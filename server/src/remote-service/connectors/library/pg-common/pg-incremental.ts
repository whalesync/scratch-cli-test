/**
 * Incremental-pull helpers shared by every Knex-based PostgreSQL connector
 * (generic Postgres + Supabase). Mirrors the shape of
 * `airtable/airtable-incremental.ts` so the per-connector code reads the same,
 * even though the modified-since mechanism is a SQL `WHERE` predicate rather
 * than an Airtable formula.
 *
 * SQL has no last-modified convention, so — unlike Airtable/Webflow — there is
 * no schema annotation to auto-detect. Incremental support is gated entirely on
 * the user declaring `modifiedAtField` in the folder's advanced settings.
 */
import { IncrementalPullSupport } from '@spinner/shared-types';
import type { PullRecordFilesOptions } from '../../types';
import { KnexPGClientError } from './knex-pg-client';

/**
 * Clock-skew safety margin subtracted from the watermark when building the
 * `WHERE <col> > $since` predicate. The watermark is captured client-side
 * (`new Date()` on the worker) while the row's modified-at column is written
 * server-side by the database. If the clocks drift, a row modified just before
 * `pullStartedAt` could otherwise be missed. Idempotent commits absorb the
 * duplicate rows this overlap re-pulls.
 */
export const PG_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Resolve the column to use for the modified-since predicate. SQL has no
 * last-modified convention and no `x-scratch-last-modified-field` annotation,
 * so this is the explicit, user-declared `options.modifiedAtField` only — no
 * auto-detection fallback. Returns `undefined` (incremental unsupported) when
 * unset or blank. Kept as a standalone function so both PG connectors share
 * one definition and `airtable`-style `resolveModifiedAtField` parity holds.
 */
export function resolvePgModifiedAtField(options: PullRecordFilesOptions): string | undefined {
  if (typeof options.modifiedAtField === 'string' && options.modifiedAtField.trim() !== '') {
    return options.modifiedAtField.trim();
  }
  return undefined;
}

/**
 * Three-state incremental-pull capability for the Knex-based PostgreSQL
 * connectors. SQL has no last-modified convention, so support hinges entirely
 * on the user declaring `modifiedAtField`: declared → `SUPPORTED`, otherwise
 * `NEEDS_CONFIGURATION` (never `NOT_SUPPORTED` — any PG table can do incremental
 * once a column is chosen). Shared by Postgres and Supabase.
 */
export function pgIncrementalPullSupport(options: PullRecordFilesOptions): IncrementalPullSupport {
  return resolvePgModifiedAtField(options) !== undefined
    ? IncrementalPullSupport.SUPPORTED
    : IncrementalPullSupport.NEEDS_CONFIGURATION;
}

/**
 * Apply the clock-skew overlap to the incremental watermark. The connector
 * passes the result as the lower bound of the `>` predicate.
 */
export function applyPgClockSkew(since: Date): Date {
  return new Date(since.getTime() - PG_INCREMENTAL_CLOCK_SKEW_MS);
}

/**
 * Confirm the user-supplied modified-at column actually exists on the table
 * before it is used in a SQL predicate. `modifiedAtField` comes from user
 * options, so a typo would otherwise surface as an opaque `column ... does not
 * exist` SQL error part-way through a pull. We validate against the column
 * names already discovered from `information_schema.columns` — i.e. the
 * top-level properties of the table spec's JSON schema — and fail fast with a
 * message that lists the valid columns.
 *
 * @throws {KnexPGClientError} when `column` is not a column of the table.
 */
export function assertModifiedAtColumnExists(schema: unknown, tableName: string, column: string): void {
  const properties = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  const columnNames = properties ? Object.keys(properties) : [];
  if (!columnNames.includes(column)) {
    throw new KnexPGClientError(
      `Configured last-modified column "${column}" does not exist on table "${tableName}". ` +
        `Set a valid column in the folder's advanced settings. Available columns: ${columnNames.join(', ')}.`,
      'INVALID_MODIFIED_AT_FIELD',
    );
  }
}
