/**
 * Pure helpers shared by the `information_schema` discovery queries (`mysql-catalog-queries.ts`): catalog value
 * normalization, the database-scope WHERE fragment and the `[database, table]` lookup key.
 *
 * Why normalization is needed at all: the connection runs with `supportBigNumbers` + `bigNumberStrings`, so every
 * BIGINT the catalog returns arrives as a STRING (`CHARACTER_MAXIMUM_LENGTH`, `NUMERIC_PRECISION`, and on MariaDB
 * also `DATETIME_PRECISION`, `ORDINAL_POSITION`, `NON_UNIQUE`). Left alone, `X_SCRATCH_MAX_LENGTH` would become
 * `"255"`. Every catalog number goes through {@link parseNullableCatalogInteger} instead.
 */
import { type MySqlCatalogColumn, type MySqlDiscoveryScope } from './mysql-catalog-types';

const CATALOG_INTEGER_TEXT_PATTERN = /^-?\d+$/;

/**
 * A catalog integer as a real number: accepts a number, a bigint, a decimal string (mysql2's BIGINT rendering) or a
 * Buffer holding one. Null / undefined / anything unparsable → null (the catalog reports NULL for "not applicable",
 * e.g. the character length of an INT column).
 */
export function parseNullableCatalogInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  const catalogIntegerText = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof catalogIntegerText === 'string') {
    const trimmedCatalogIntegerText = catalogIntegerText.trim();
    return CATALOG_INTEGER_TEXT_PATTERN.test(trimmedCatalogIntegerText) ? Number(trimmedCatalogIntegerText) : null;
  }
  return null;
}

/**
 * Catalog text as a string. The row decoder already turns `information_schema` Buffers into UTF-8 text, but a value
 * that passed through a derived table can lose its `information_schema` origin, so decode defensively here too.
 */
function readNullableCatalogText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function readCatalogText(value: unknown): string {
  return readNullableCatalogText(value) ?? '';
}

/**
 * One `information_schema.COLUMNS` row (selected with the lower-case aliases below) as a {@link MySqlCatalogColumn}.
 * Names and COLUMN_TYPE stay verbatim (ENUM/SET member literals keep their case); only DATA_TYPE is lower-cased.
 * COLUMN_DEFAULT is kept exactly as reported, including MariaDB's quoted literals and its `'NULL'` string for an
 * explicit `DEFAULT NULL` — callers only ever ask "is there a default", and MariaDB reports `'NULL'` solely on
 * nullable columns, which may be omitted on insert anyway.
 */
export function normalizeMySqlCatalogColumnRow(row: Record<string, unknown>): MySqlCatalogColumn {
  return {
    columnName: readCatalogText(row.column_name),
    dataType: readCatalogText(row.data_type).toLowerCase(),
    columnType: readCatalogText(row.column_type),
    isNullable: readCatalogText(row.is_nullable).toUpperCase() === 'YES',
    columnDefault: readNullableCatalogText(row.column_default),
    extra: readCatalogText(row.extra),
    generationExpression: readNullableCatalogText(row.generation_expression),
    privileges: readCatalogText(row.privileges),
    columnKey: readCatalogText(row.column_key),
    characterMaximumLength: parseNullableCatalogInteger(row.character_maximum_length),
    numericPrecision: parseNullableCatalogInteger(row.numeric_precision),
    numericScale: parseNullableCatalogInteger(row.numeric_scale),
    datetimePrecision: parseNullableCatalogInteger(row.datetime_precision),
    characterSetName: readNullableCatalogText(row.character_set_name),
    collationName: readNullableCatalogText(row.collation_name),
    ordinalPosition: parseNullableCatalogInteger(row.ordinal_position) ?? 0,
  };
}

/**
 * The column reference a scope fragment filters on is always one of OUR constants (`TABLE_SCHEMA`,
 * `c.TABLE_SCHEMA`, ...), never user input. Enforce that shape so this helper can never become an injection seam.
 */
const CATALOG_COLUMN_REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * The WHERE fragment limiting a discovery query to the scope's databases:
 * `LOWER(col) NOT IN (?, …)` for the excluded (system) databases — compared lower-cased because TiDB reports
 * `METRICS_SCHEMA` in upper case — plus `col = ?` when the connection names one database. The NOT IN clause is
 * omitted for an empty exclusion list (`NOT IN ()` is a syntax error); a scope with neither part yields `1 = 1` so
 * the fragment can always be spliced in after `WHERE` / `AND`.
 */
export function buildDatabaseScopeSqlFragment(
  scope: MySqlDiscoveryScope,
  schemaColumnSql: string,
): { sql: string; bindings: string[] } {
  if (!CATALOG_COLUMN_REFERENCE_PATTERN.test(schemaColumnSql)) {
    throw new Error(`Invalid catalog column reference for a database scope: ${schemaColumnSql}`);
  }
  const scopeConditionSqlParts: string[] = [];
  const scopeConditionBindings: string[] = [];
  if (scope.excludedDatabaseNames.length > 0) {
    const excludedDatabasePlaceholders = scope.excludedDatabaseNames.map(() => '?').join(', ');
    scopeConditionSqlParts.push(`LOWER(${schemaColumnSql}) NOT IN (${excludedDatabasePlaceholders})`);
    scopeConditionBindings.push(...scope.excludedDatabaseNames.map((databaseName) => databaseName.toLowerCase()));
  }
  if (scope.onlyDatabaseName !== undefined) {
    scopeConditionSqlParts.push(`${schemaColumnSql} = ?`);
    scopeConditionBindings.push(scope.onlyDatabaseName);
  }
  return {
    sql: scopeConditionSqlParts.length > 0 ? scopeConditionSqlParts.join(' AND ') : '1 = 1',
    bindings: scopeConditionBindings,
  };
}

/**
 * The key a `[database, table]` pair is stored under in discovery lookup sets. JSON-encoded rather than dot-joined:
 * MySQL names may contain `.`, and database `a.b` + table `c` must not collide with database `a` + table `b.c`.
 */
export function buildMySqlTableLookupKey(databaseName: string, tableName: string): string {
  return JSON.stringify([databaseName, tableName]);
}
