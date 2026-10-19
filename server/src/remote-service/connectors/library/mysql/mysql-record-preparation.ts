/**
 * Write-side preparation of record values for MySQL `INSERT` / `UPDATE` (creates and updates share it).
 *
 * The on-disk record is exactly what the read side decoded (Connector Prime Directive), so this module is the
 * inverse of `mysql-row-value-decoder.ts`, applied value by value, never mutating its input:
 *
 *  1. `undefined` values are dropped (knex would bind them as DEFAULT, which is not what an absent key means).
 *  2. A non-null value in a column whose pulled representation can't be written back (BLOB / BINARY as base64,
 *     BIT as a number, spatial as base64 WKB, VECTOR, unknown types) fails the write with
 *     `NonWritableFieldEditError`: MySQL would otherwise silently store the base64 TEXT's bytes in the BLOB.
 *     Generated columns are deliberately NOT pre-checked: MySQL rejects a write to them (3105, MariaDB 1906) and
 *     the error mapper surfaces that ("send the data and let the service reject it").
 *  3. `''` becomes NULL in columns whose type can never store an empty string (numbers, temporal, JSON, TIME,
 *     MariaDB UUID / INET) — the pg-common rationale: under `STRICT_TRANS_TABLES` MySQL is guaranteed to reject
 *     `''` there, so this only turns a certain failure into the faithful "unset".
 *  4. JSON columns: NULL stays SQL NULL; every other value — strings included — is `JSON.stringify`'d. The read
 *     side parses documents into JS values, so stringify is its exact inverse: a JSON string document `"x"`
 *     round-trips instead of failing with 3140 (this deliberately differs from Postgres' legacy
 *     string-as-JSON-text insert behaviour).
 *  5. DATE / DATETIME / TIMESTAMP: text goes through `convertTemporalValueToMySqlLiteral` (the same converter
 *     the field-value canonicalizer uses, so what we write and what we later compare can't disagree); a value it
 *     rejects, or a non-string (MySQL would read the number 20260305 as a date), fails the write.
 *     TIME: text in a recognised `[-]H:M[:S[.f]]` shape goes through `convertRecognizedTimeTextToMySqlTimeLiteral`
 *     (also shared with the canonicalizer: pads the parts, truncates the fraction to the column's precision so
 *     MySQL — which would round — and MariaDB — which truncates — store the same value). Anything else is sent
 *     unchanged and MySQL decides: TIME accepts other shapes (`D HH:MM:SS`, `HHMMSS`, numbers), so rejecting them
 *     here would refuse values MySQL stores fine.
 *  6. Any other plain object or array is `JSON.stringify`'d: mysql2's client-side formatter would otherwise bind
 *     an object as `'[object Object]'` and an array as a comma list that shifts every following column
 *     (verified in the spike, LOG.md). Everything else (strings, numbers, booleans) is bound as-is.
 */
import { JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { isPlainObject } from 'lodash';
import { assertUnreachable } from 'src/utils/asserts';
import { NonWritableFieldEditError, NonWritableFieldReason, nonWritableFieldEditErrorMessage } from '../../error';
import { type BaseJsonTableSpec, type ConnectorFile } from '../../types';
import { collectPgColumnNamesRejectingEmptyString } from '../pg-common/pg-empty-string-coercion';
import { collectPgJsonColumnNames } from '../pg-common/pg-json-column-insert-serialization';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';
import { resolveMySqlPrimaryKeyBindingKind, type MySqlPrimaryKeyBindingKind } from './mysql-id-binding';
import {
  classifyMySqlTemporalColumnType,
  mysqlColumnHasNonWritableRepresentation,
  readMySqlNativeColumnType,
  readMySqlNativeColumnTypeBaseName,
  type MySqlTemporalColumnType,
} from './mysql-native-column-type';
import {
  convertRecognizedTimeTextToMySqlTimeLiteral,
  convertTemporalValueToMySqlLiteral,
  readMySqlTimeColumnFractionalSecondsPrecision,
} from './mysql-temporal-literal';

/** How one column's values are prepared for a write. */
export interface MySqlColumnWriteProfile {
  columnName: string;
  /** DATE / DATETIME / TIMESTAMP (with fractional-seconds precision); undefined for every other column. */
  temporalColumnType: MySqlTemporalColumnType | undefined;
  /** A TIME column's fractional-seconds precision (0-6); undefined for every other column. */
  timeColumnFractionalSecondsPrecision: number | undefined;
  /** A JSON column (or MariaDB's LONGTEXT + `json_valid` alias): every non-null value is sent as JSON text. */
  isJsonDocumentColumn: boolean;
  /** `''` is never a legal value for this column's type, so it is written as NULL. */
  rejectsEmptyString: boolean;
  /** The pulled value is a lossy / encoded rendering (base64 bytes, BIT number, ...) that can't be written back. */
  isPulledInNonWritableRepresentation: boolean;
}

/** Everything the write path needs to know about a table, derived once per publish batch from its spec. */
export interface MySqlTableWriteProfile {
  primaryKeyColumnName: string;
  primaryKeyBindingKind: MySqlPrimaryKeyBindingKind;
  columnWriteProfileByColumnName: ReadonlyMap<string, MySqlColumnWriteProfile>;
}

/**
 * Native base types that the shared `x-scratch-connector-data-type` families don't flag, yet whose columns reject
 * `''` under strict mode: TIME (pulled as text, TEXT family) and MariaDB's UUID / INET4 / INET6 (text-like).
 * YEAR is in the NUMERIC family already; it is listed so the rule doesn't depend on that mapping.
 */
const MYSQL_NATIVE_BASE_TYPES_REJECTING_EMPTY_STRING: ReadonlySet<string> = new Set([
  'time',
  'year',
  'uuid',
  'inet4',
  'inet6',
]);

/**
 * Whether MySQL (strict mode) rejects `''` for a column of this native type, beyond the shared family rule
 * (`collectPgColumnNamesRejectingEmptyString`). Exported so the field-value canonicalizer applies `emptyAsNull`
 * to exactly the columns this module writes `''` as NULL for.
 */
export function mysqlNativeColumnTypeRejectsEmptyString(columnTypeSpelling: string): boolean {
  return MYSQL_NATIVE_BASE_TYPES_REJECTING_EMPTY_STRING.has(readMySqlNativeColumnTypeBaseName(columnTypeSpelling));
}

/** A column schema's string `format`, looking through the nullable `anyOf` wrapping the read side applies. */
function readJsonSchemaStringFormatThroughNullableWrapping(columnSchema: unknown): string | undefined {
  if (typeof columnSchema !== 'object' || columnSchema === null) return undefined;
  const { format, anyOf } = columnSchema as { format?: unknown; anyOf?: unknown };
  if (typeof format === 'string') return format;
  if (!Array.isArray(anyOf)) return undefined;
  for (const unionMemberSchema of anyOf) {
    const unionMemberFormat = readJsonSchemaStringFormatThroughNullableWrapping(unionMemberSchema);
    if (unionMemberFormat !== undefined) return unionMemberFormat;
  }
  return undefined;
}

/**
 * Fallback when a column carries no MySQL native type annotation: infer the temporal kind from the schema
 * `format` the read side assigns (`date` → DATE, `date-time` → TIMESTAMP, `date-time-local` → DATETIME). The
 * precision is unknown, so the converter keeps up to 6 fractional digits.
 */
function temporalColumnTypeFromSchemaFormat(columnSchema: unknown): MySqlTemporalColumnType | undefined {
  switch (readJsonSchemaStringFormatThroughNullableWrapping(columnSchema)) {
    case 'date':
      return { temporalKind: 'date' };
    case 'date-time':
      return { temporalKind: 'timestamp', fractionalSecondsPrecision: undefined };
    case JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT:
      return { temporalKind: 'datetime', fractionalSecondsPrecision: undefined };
    default:
      return undefined;
  }
}

/** Build the write profile of a table from its spec (the read side's annotations). Pure. */
export function buildMySqlTableWriteProfile(tableSpec: BaseJsonTableSpec): MySqlTableWriteProfile {
  const columnSchemaByColumnName = (tableSpec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const columnNamesRejectingEmptyStringByFamily = collectPgColumnNamesRejectingEmptyString(tableSpec);
  const jsonDocumentColumnNamesByFamily = collectPgJsonColumnNames(tableSpec);

  const columnWriteProfileByColumnName = new Map<string, MySqlColumnWriteProfile>();
  for (const [columnName, columnSchema] of Object.entries(columnSchemaByColumnName)) {
    const nativeColumnType = readMySqlNativeColumnType(columnSchema);
    const columnIsReadOnly =
      typeof columnSchema === 'object' &&
      columnSchema !== null &&
      (columnSchema as Record<string, unknown>)[X_SCRATCH_READONLY] === true;
    columnWriteProfileByColumnName.set(columnName, {
      columnName,
      temporalColumnType:
        nativeColumnType !== undefined
          ? classifyMySqlTemporalColumnType(nativeColumnType)
          : temporalColumnTypeFromSchemaFormat(columnSchema),
      // Only from the native type: a pulled TIME is plain text in the TEXT family, with no schema format to go by.
      timeColumnFractionalSecondsPrecision:
        nativeColumnType !== undefined ? readMySqlTimeColumnFractionalSecondsPrecision(nativeColumnType) : undefined,
      isJsonDocumentColumn:
        jsonDocumentColumnNamesByFamily.has(columnName) ||
        (nativeColumnType !== undefined && readMySqlNativeColumnTypeBaseName(nativeColumnType) === 'json'),
      rejectsEmptyString:
        columnNamesRejectingEmptyStringByFamily.has(columnName) ||
        (nativeColumnType !== undefined && mysqlNativeColumnTypeRejectsEmptyString(nativeColumnType)),
      isPulledInNonWritableRepresentation:
        nativeColumnType !== undefined && mysqlColumnHasNonWritableRepresentation(nativeColumnType) && columnIsReadOnly,
    });
  }

  return {
    primaryKeyColumnName: tableSpec.idPath,
    primaryKeyBindingKind: resolveMySqlPrimaryKeyBindingKind(tableSpec),
    columnWriteProfileByColumnName,
  };
}

/** A short, value-free description of a non-string value for error messages. */
function describeNonStringValueKind(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'boolean') return 'a true/false value';
  if (typeof value === 'number' || typeof value === 'bigint') return 'a number';
  return `a ${typeof value} value`;
}

function exampleTemporalTextForColumnType(temporalColumnType: MySqlTemporalColumnType): string {
  return temporalColumnType.temporalKind === 'date' ? '"2026-03-05"' : '"2026-03-05 14:30:00"';
}

/** Step 5: a DATE / DATETIME / TIMESTAMP value → the literal MySQL stores, or a thrown MySqlClientError. */
function convertTemporalColumnValueForMySqlWrite(
  columnName: string,
  value: unknown,
  temporalColumnType: MySqlTemporalColumnType,
): string {
  const temporalColumnTypeLabel = temporalColumnType.temporalKind.toUpperCase();
  if (typeof value !== 'string') {
    throw new MySqlClientError(
      MySqlClientProblem.NonStringTemporalValue,
      `Column "${columnName}" is a ${temporalColumnTypeLabel} column, but the value is ${describeNonStringValueKind(value)}, not text. Send the ${temporalColumnType.temporalKind === 'date' ? 'date' : 'date and time'} as text, e.g. ${exampleTemporalTextForColumnType(temporalColumnType)}.`,
    );
  }
  const temporalLiteralConversion = convertTemporalValueToMySqlLiteral(value, temporalColumnType);
  switch (temporalLiteralConversion.outcome) {
    case 'converted':
      return temporalLiteralConversion.mySqlLiteral;
    case 'rejected':
      throw new MySqlClientError(
        MySqlClientProblem.InvalidTemporalValue,
        `Column "${columnName}": ${temporalLiteralConversion.rejectionReason}`,
      );
    default:
      return assertUnreachable(temporalLiteralConversion);
  }
}

/** Steps 3-6 for one (defined) value. */
function prepareColumnValueForMySqlWrite(
  columnName: string,
  value: unknown,
  columnWriteProfile: MySqlColumnWriteProfile | undefined,
): unknown {
  if (value === '' && columnWriteProfile?.rejectsEmptyString) return null;
  if (value === null) return null;
  if (columnWriteProfile?.isJsonDocumentColumn) return JSON.stringify(value);
  if (columnWriteProfile?.temporalColumnType !== undefined) {
    return convertTemporalColumnValueForMySqlWrite(columnName, value, columnWriteProfile.temporalColumnType);
  }
  if (columnWriteProfile?.timeColumnFractionalSecondsPrecision !== undefined && typeof value === 'string') {
    // TIME text MySQL reads in another shape (or rejects) is sent unchanged: MySQL decides, not us.
    return (
      convertRecognizedTimeTextToMySqlTimeLiteral(value, columnWriteProfile.timeColumnFractionalSecondsPrecision) ??
      value
    );
  }
  if (Array.isArray(value) || isPlainObject(value)) return JSON.stringify(value);
  return value;
}

/**
 * Prepare records (full records for creates, change sets for updates) for binding. Returns new objects in the
 * same order and never mutates the input. Throws before any SQL runs, so the publish runner's per-record retry
 * isolates the offending record.
 *
 * The primary key is exempt from the non-writable-representation check (step 2): it addresses the row rather
 * than being an edit, and the write paths never send it (creates let AUTO_INCREMENT assign it, updates drop it).
 */
export function prepareRecordsForMySqlWrite(
  records: Record<string, unknown>[],
  profile: MySqlTableWriteProfile,
): Record<string, unknown>[] {
  const columnNamesWithNonWritableValues = new Set<string>();
  for (const record of records) {
    for (const [columnName, value] of Object.entries(record)) {
      if (value === undefined || value === null || columnName === profile.primaryKeyColumnName) continue;
      if (profile.columnWriteProfileByColumnName.get(columnName)?.isPulledInNonWritableRepresentation) {
        columnNamesWithNonWritableValues.add(columnName);
      }
    }
  }
  if (columnNamesWithNonWritableValues.size > 0) {
    throw new NonWritableFieldEditError(
      nonWritableFieldEditErrorMessage({
        [NonWritableFieldReason.NotYetSupported]: [...columnNamesWithNonWritableValues],
      }),
    );
  }

  return records.map((record) => {
    const preparedRecord: Record<string, unknown> = {};
    for (const [columnName, value] of Object.entries(record)) {
      if (value === undefined) continue;
      preparedRecord[columnName] = prepareColumnValueForMySqlWrite(
        columnName,
        value,
        profile.columnWriteProfileByColumnName.get(columnName),
      );
    }
    return preparedRecord;
  });
}

/**
 * The column values an UPDATE writes for one record: the CHANGED top-level keys, each with its WHOLE value from
 * the full record file.
 *
 * `changedFields` from the publish pipeline is a deep sparse diff (`computeChangedFields` recurses into plain
 * objects), so editing one key of a JSON document yields `{ meta: { a: 2 } }`. Writing that sparse object would
 * REPLACE the stored document and lose its other keys; taking `file.meta` instead writes the full edited document.
 * (Postgres still has this clobber at `postgres-connector.ts` updateRecords — a separate follow-up.)
 *
 * Without `sparseChangedFields` every key of the file is written. The primary key is never part of the change set
 * (it addresses the row). A changed key the file lacks (not produced by the pipeline, whose `pickByShape` only
 * keeps keys present in the file) keeps its changed value rather than silently dropping the edit.
 */
export function buildMySqlUpdateChangeSetWithWholeTopLevelValues(
  file: ConnectorFile,
  sparseChangedFields: Record<string, unknown> | undefined,
  primaryKeyColumnName: string,
): Record<string, unknown> {
  const changedTopLevelValuesSource = sparseChangedFields ?? file;
  const changeSetWithWholeTopLevelValues: Record<string, unknown> = {};
  for (const changedTopLevelColumnName of Object.keys(changedTopLevelValuesSource)) {
    if (changedTopLevelColumnName === primaryKeyColumnName) continue;
    changeSetWithWholeTopLevelValues[changedTopLevelColumnName] = Object.prototype.hasOwnProperty.call(
      file,
      changedTopLevelColumnName,
    )
      ? file[changedTopLevelColumnName]
      : changedTopLevelValuesSource[changedTopLevelColumnName];
  }
  return changeSetWithWholeTopLevelValues;
}
