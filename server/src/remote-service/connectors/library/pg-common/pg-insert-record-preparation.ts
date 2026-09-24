/**
 * The single write-side preparation every Knex-based Postgres connector (Postgres, Supabase) applies to
 * records before `KnexPGClient.insertMany`, so a new insert path can't miss one of the steps:
 *   1. `""` → NULL in columns whose type rejects an empty string (`pg-empty-string-coercion.ts`);
 *   2. arrays bound for `json`/`jsonb` columns sent as JSON text (`pg-json-column-insert-serialization.ts`).
 */
import type { BaseJsonTableSpec } from '../../types';
import {
  collectPgColumnNamesRejectingEmptyString,
  replaceEmptyStringsWithNullForPgTypedColumns,
} from './pg-empty-string-coercion';
import { collectPgJsonColumnNames, serializeJsonColumnArraysForInsert } from './pg-json-column-insert-serialization';

/** Prepare records for INSERT into the table described by `tableSpec`. Never mutates the input records. */
export function prepareRecordsForPgInsert<RecordType extends Record<string, unknown>>(
  tableSpec: BaseJsonTableSpec,
  records: RecordType[],
): Record<string, unknown>[] {
  const columnNamesRejectingEmptyString = collectPgColumnNamesRejectingEmptyString(tableSpec);
  const jsonColumnNames = collectPgJsonColumnNames(tableSpec);
  return records.map((record) =>
    serializeJsonColumnArraysForInsert(
      replaceEmptyStringsWithNullForPgTypedColumns(record, columnNamesRejectingEmptyString),
      jsonColumnNames,
    ),
  );
}
