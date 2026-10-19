/**
 * Pull helpers that depend only on the table spec: which columns a read selects, how many rows a page holds, and
 * whether the user-declared `modifiedAtField` can drive an incremental pull.
 *
 * Incremental pulls reuse the Postgres policy from `pg-common/pg-incremental.ts` unchanged
 * (`pgIncrementalPullSupport`, `resolvePgModifiedAtField`, `applyPgClockSkew`): SQL has no last-modified convention,
 * so the column is always user-declared and never auto-detected in v1. Only the column check differs — Postgres's
 * `assertModifiedAtColumnExists` throws the Postgres error class and accepts any column.
 *
 * How the watermark compares (record in STATE.md):
 * - TIMESTAMP: the bound literal is read in the session time zone (`+00:00`), so the comparison is exact.
 * - DATETIME: a naive wall-clock comparison, correct only when the application writes UTC (Rails, Django with
 *   USE_TZ, and the RDS / Cloud SQL / Azure defaults do). A writer in a zone west of UTC makes rows get missed.
 * - Rows whose modified-at is NULL are never pulled incrementally (Postgres parity).
 */
import { TIME_BEARING_DATE_FORMATS } from '@spinner/shared-types';
import { type BaseJsonTableSpec } from '../../types';
import { applyPgClockSkew } from '../pg-common/pg-incremental';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';
import { readMySqlNativeColumnType, readMySqlNativeColumnTypeBaseName } from './mysql-native-column-type';
import { formatInstantAsMySqlUtcDateTimeLiteral } from './mysql-temporal-values';

/** Rows per page for a normal table. */
export const MYSQL_DEFAULT_READ_PAGE_SIZE = 500;

/**
 * Rows per page when the table has a MEDIUMBLOB / LONGBLOB column. BLOBs are pulled (as base64, Prime Directive),
 * and one such value can be up to `max_allowed_packet` bytes, so a 500-row page could hold gigabytes.
 */
export const MYSQL_LARGE_BINARY_OBJECT_READ_PAGE_SIZE = 50;

const MYSQL_LARGE_BINARY_OBJECT_BASE_TYPE_NAMES: ReadonlySet<string> = new Set(['mediumblob', 'longblob']);

/** The `WHERE <column> > '<literal>'` lower bound of an incremental page query. */
export interface MySqlModifiedSinceLowerBound {
  readonly columnName: string;
  /** `YYYY-MM-DD HH:MM:SS.ffffff`, UTC. Bound as text so the comparison doesn't depend on driver Date handling. */
  readonly exclusiveLowerBoundUtcLiteral: string;
}

function readTopLevelSchemaProperties(tableSpec: BaseJsonTableSpec): Record<string, unknown> {
  const schemaProperties = (tableSpec.schema as { properties?: unknown } | null | undefined)?.properties;
  return typeof schemaProperties === 'object' && schemaProperties !== null
    ? (schemaProperties as Record<string, unknown>)
    : {};
}

/**
 * A column schema's JSON Schema `format`, looking inside `anyOf` / `oneOf` / `allOf` so a nullable column
 * (`{ anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] }`) reports its underlying format. Same
 * resolution the folder settings picker uses for `fieldSelectFormats`.
 */
function resolveColumnSchemaStringFormat(columnSchema: unknown): string | undefined {
  if (typeof columnSchema !== 'object' || columnSchema === null) return undefined;
  const columnSchemaObject = columnSchema as Record<string, unknown>;
  if (typeof columnSchemaObject.format === 'string') return columnSchemaObject.format;
  for (const unionKeyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const unionVariants = columnSchemaObject[unionKeyword];
    if (!Array.isArray(unionVariants)) continue;
    for (const unionVariant of unionVariants) {
      const variantFormat = resolveColumnSchemaStringFormat(unionVariant);
      if (variantFormat !== undefined) return variantFormat;
    }
  }
  return undefined;
}

/** The MySQL native type annotated on a column schema, or on one of its union variants. */
function resolveColumnSchemaMySqlNativeType(columnSchema: unknown): string | undefined {
  const topLevelNativeType = readMySqlNativeColumnType(columnSchema);
  if (topLevelNativeType !== undefined) return topLevelNativeType;
  if (typeof columnSchema !== 'object' || columnSchema === null) return undefined;
  for (const unionKeyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const unionVariants = (columnSchema as Record<string, unknown>)[unionKeyword];
    if (!Array.isArray(unionVariants)) continue;
    for (const unionVariant of unionVariants) {
      const variantNativeType = readMySqlNativeColumnType(unionVariant);
      if (variantNativeType !== undefined) return variantNativeType;
    }
  }
  return undefined;
}

/**
 * The columns every read selects, in schema order: exactly the spec's top-level properties. Reads never use `*`,
 * which would drop INVISIBLE columns — including MySQL's generated invisible primary key `my_row_id`, often a
 * table's only key.
 */
export function listSelectableColumnNames(tableSpec: BaseJsonTableSpec): string[] {
  return Object.keys(readTopLevelSchemaProperties(tableSpec));
}

/** {@link MYSQL_LARGE_BINARY_OBJECT_READ_PAGE_SIZE} when any column is a MEDIUMBLOB / LONGBLOB, else the default. */
export function readPageSizeForTableSpec(tableSpec: BaseJsonTableSpec): number {
  const hasLargeBinaryObjectColumn = Object.values(readTopLevelSchemaProperties(tableSpec)).some((columnSchema) => {
    const columnNativeType = resolveColumnSchemaMySqlNativeType(columnSchema);
    return (
      columnNativeType !== undefined &&
      MYSQL_LARGE_BINARY_OBJECT_BASE_TYPE_NAMES.has(readMySqlNativeColumnTypeBaseName(columnNativeType))
    );
  });
  return hasLargeBinaryObjectColumn ? MYSQL_LARGE_BINARY_OBJECT_READ_PAGE_SIZE : MYSQL_DEFAULT_READ_PAGE_SIZE;
}

/** Columns whose schema format carries a time of day (TIMESTAMP → `date-time`, DATETIME → `date-time-local`). */
function listTimeBearingColumnNames(tableSpec: BaseJsonTableSpec): string[] {
  return Object.entries(readTopLevelSchemaProperties(tableSpec))
    .filter(([, columnSchema]) => {
      const columnFormat = resolveColumnSchemaStringFormat(columnSchema);
      return columnFormat !== undefined && TIME_BEARING_DATE_FORMATS.has(columnFormat);
    })
    .map(([columnName]) => columnName);
}

function describeUsableModifiedAtColumns(usableColumnNames: string[]): string {
  return usableColumnNames.length > 0
    ? `Choose one of its TIMESTAMP or DATETIME columns in the folder's advanced settings: ${usableColumnNames.join(', ')}.`
    : "It has no TIMESTAMP or DATETIME column, so clear the update field in the folder's advanced settings to run full pulls.";
}

/**
 * Fail fast (before connecting) when the user-declared modified-at column can't drive an incremental pull: it
 * isn't a column of the table (a typo would otherwise surface as MySQL error 1054 mid-pull), or it has no time of
 * day. A DATE column compared with a date-time watermark would miss rows changed later on the watermark's day.
 *
 * @throws {MySqlClientError} with problem `InvalidModifiedAtField`; the message lists the usable columns.
 */
export function assertMySqlModifiedAtColumnIsUsable(tableSpec: BaseJsonTableSpec, columnName: string): void {
  const schemaProperties = readTopLevelSchemaProperties(tableSpec);
  const usableColumnNames = listTimeBearingColumnNames(tableSpec);
  if (!Object.prototype.hasOwnProperty.call(schemaProperties, columnName)) {
    throw new MySqlClientError(
      MySqlClientProblem.InvalidModifiedAtField,
      `The update field "${columnName}" isn't a column of the table "${tableSpec.name}". ${describeUsableModifiedAtColumns(usableColumnNames)}`,
    );
  }
  if (!usableColumnNames.includes(columnName)) {
    throw new MySqlClientError(
      MySqlClientProblem.InvalidModifiedAtField,
      `The update field "${columnName}" of the table "${tableSpec.name}" isn't a TIMESTAMP or DATETIME column, so it can't tell which rows changed since the last pull. ${describeUsableModifiedAtColumns(usableColumnNames)}`,
    );
  }
}

/**
 * The lower bound for an incremental page query: the previous pull's watermark minus the shared 60-second
 * clock-skew overlap (the watermark is the worker's clock, the column is written by the database's), as a UTC
 * datetime literal with microseconds. Idempotent commits absorb the rows the overlap re-pulls.
 */
export function buildMySqlModifiedSinceLowerBoundWithClockSkew(
  modifiedAtColumnName: string,
  previousPullWatermark: Date,
): MySqlModifiedSinceLowerBound {
  return {
    columnName: modifiedAtColumnName,
    exclusiveLowerBoundUtcLiteral: formatInstantAsMySqlUtcDateTimeLiteral(applyPgClockSkew(previousPullWatermark)),
  };
}
