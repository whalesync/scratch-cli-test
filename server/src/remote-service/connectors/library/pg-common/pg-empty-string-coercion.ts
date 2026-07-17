/**
 * Coercing empty strings to NULL for typed Postgres columns on write.
 *
 * Shared by every Knex-based PG connector (generic Postgres, Supabase, …) — an
 * empty string is never a legal literal for a `timestamp`/`date`, `numeric`,
 * `boolean`, or `jsonb` column, so an INSERT/UPDATE carrying `""` fails outright
 * (e.g. `invalid input syntax for type timestamp with time zone: ""`).
 *
 * Connectors that represent an unset value as `""` rather than `null` — HubSpot
 * returns `""` for an unset datetime, see `hubspot-json-schema.ts` — flow that
 * empty string straight into these columns when synced into Postgres. We
 * translate `""` → NULL on write for them (the faithful representation of
 * "unset"), while `text` columns keep `""` verbatim (DEV-10877).
 *
 * The coercion is safe for any currently-succeeding write: `""` is *guaranteed*
 * to be rejected by Postgres for every type below, so nulling it can only turn a
 * certain failure into a correct NULL — it can never change a write that would
 * otherwise have succeeded.
 */
import type { TSchema } from '@sinclair/typebox';
import { PostgresColumnType, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';

const POSTGRES_COLUMN_TYPES_REJECTING_EMPTY_STRING: ReadonlySet<PostgresColumnType> = new Set([
  PostgresColumnType.TIMESTAMP,
  PostgresColumnType.NUMERIC,
  PostgresColumnType.BOOLEAN,
  PostgresColumnType.JSONB,
]);

/**
 * Column names on this table whose Postgres type rejects an empty string
 * (timestamp/date, numeric, boolean, jsonb). Read from each column's
 * `x-scratch-connector-data-type` annotation on the table schema — the
 * annotation survives the `Type.Optional`/nullable wrapping the connectors apply
 * when building the spec. Compute this once per publish batch, then pass it to
 * {@link replaceEmptyStringsWithNullForPgTypedColumns} per record.
 */
export function collectPgColumnNamesRejectingEmptyString(tableSpec: BaseJsonTableSpec): Set<string> {
  const columnSchemasByName = (tableSpec.schema as { properties?: Record<string, TSchema> }).properties ?? {};
  const columnNamesRejectingEmptyString = new Set<string>();
  for (const [columnName, columnSchema] of Object.entries(columnSchemasByName)) {
    const connectorDataType = (columnSchema as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE];
    if (POSTGRES_COLUMN_TYPES_REJECTING_EMPTY_STRING.has(connectorDataType as PostgresColumnType)) {
      columnNamesRejectingEmptyString.add(columnName);
    }
  }
  return columnNamesRejectingEmptyString;
}

/**
 * Return a copy of `record` with any empty-string value in an empty-string-
 * rejecting column replaced by NULL. Returns the original object untouched when
 * there is nothing to coerce, so the common case allocates nothing.
 */
export function replaceEmptyStringsWithNullForPgTypedColumns(
  record: Record<string, unknown>,
  columnNamesRejectingEmptyString: Set<string>,
): Record<string, unknown> {
  if (columnNamesRejectingEmptyString.size === 0) return record;
  let coercedRecord: Record<string, unknown> | undefined;
  for (const columnName of columnNamesRejectingEmptyString) {
    if (record[columnName] === '') {
      coercedRecord ??= { ...record };
      coercedRecord[columnName] = null;
    }
  }
  return coercedRecord ?? record;
}
