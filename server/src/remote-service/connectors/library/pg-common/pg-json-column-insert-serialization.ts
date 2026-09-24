/**
 * Serializing ARRAY values bound for `json` / `jsonb` columns on INSERT.
 *
 * Inserts go through knex, which hands each value to the `pg` driver as a bind parameter. The driver turns
 * a JS ARRAY into a Postgres array literal (`{"a","b"}`), which is not valid JSON input, so inserting
 * `["a", "b"]` into a `jsonb` column failed outright (`invalid input syntax for type json`). Serializing an
 * array to its JSON text first makes the insert store exactly the array the record holds.
 *
 * Only arrays are touched. Objects already work (the driver JSON-stringifies them), and a STRING keeps its
 * long-standing insert behavior — Postgres parses it as JSON text — so an existing sync writing JSON-looking
 * text into a `jsonb` column stores the same value it always did (DEV-11903 review).
 *
 * Updates don't need this: `updateMany` ships the whole row as one JSON document through
 * `json_populate_recordset`, which already maps a JSON array into a `jsonb` column as-is.
 */
import type { TSchema } from '@sinclair/typebox';
import { PostgresColumnType, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';

/**
 * Column names on this table whose Postgres type is `json` / `jsonb`, read from each column's
 * `x-scratch-connector-data-type` annotation. Compute once per publish batch.
 */
export function collectPgJsonColumnNames(tableSpec: BaseJsonTableSpec): Set<string> {
  const columnSchemasByName = (tableSpec.schema as { properties?: Record<string, TSchema> }).properties ?? {};
  const jsonColumnNames = new Set<string>();
  for (const [columnName, columnSchema] of Object.entries(columnSchemasByName)) {
    if ((columnSchema as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] === PostgresColumnType.JSONB) {
      jsonColumnNames.add(columnName);
    }
  }
  return jsonColumnNames;
}

/**
 * Return a copy of `record` with every ARRAY value in a JSON column replaced by its JSON text, ready for an
 * INSERT. Returns the original object untouched when there is nothing to serialize.
 */
export function serializeJsonColumnArraysForInsert(
  record: Record<string, unknown>,
  jsonColumnNames: Set<string>,
): Record<string, unknown> {
  if (jsonColumnNames.size === 0) return record;
  let serializedRecord: Record<string, unknown> | undefined;
  for (const columnName of jsonColumnNames) {
    const value = record[columnName];
    if (!Array.isArray(value)) continue;
    serializedRecord ??= { ...record };
    serializedRecord[columnName] = JSON.stringify(value);
  }
  return serializedRecord ?? record;
}
