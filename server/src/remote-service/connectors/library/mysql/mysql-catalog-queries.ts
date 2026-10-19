/**
 * `information_schema` discovery queries: databases, tables, columns, keys and foreign keys.
 *
 * Conventions every query here follows:
 * - Every function takes a knex instance OR a transaction first, so write-path preflights can run inside `trx`.
 * - SQL is built from the constants below plus bindings only. The one dynamic piece, the database-scope fragment,
 *   is assembled from our own column references by `buildDatabaseScopeSqlFragment`.
 * - Every selected catalog column gets a lower-case alias: MySQL 8 returns UPPER-case labels for unaliased
 *   `information_schema` columns while MariaDB returns them as written, so aliases are the only stable spelling.
 * - `knex.raw` on the mysql2 dialect resolves to `[rows, fields]`; {@link runMySqlCatalogQuery} unwraps it.
 * - Catalog BIGINTs arrive as strings (`bigNumberStrings`), so rows are normalized before they leave this module.
 * - Catalog names are grouped and joined BYTE-EXACTLY. MariaDB's `information_schema` name columns use
 *   `utf8mb3_general_ci`, which ignores case AND accents, yet with `lower_case_table_names=0` (the Linux and RDS
 *   default) `Orders` / `orders` and `café` / `cafe` are distinct databases and tables, and both servers allow index,
 *   column and (MariaDB) foreign-key names that differ only by an accent. A plain `GROUP BY TABLE_NAME` would merge
 *   such a pair into one group whose `COUNT(*)` then fails a single-column check, and a plain join would match the
 *   other object's row. So:
 *   - `GROUP BY CAST(name AS BINARY)`, selecting `MIN(name)`: every value in a group is byte-identical, so MIN just
 *     reads it, and the query stays valid under ONLY_FULL_GROUP_BY;
 *   - a join between two catalog names adds `CAST(a AS BINARY) = CAST(b AS BINARY)` next to the plain `a = b`, which
 *     is kept because it lets MySQL 8 look the name up in its data-dictionary indexes (a bytes-only join makes it
 *     scan and hash-join every table and column in scope);
 *   - no `SELECT DISTINCT` over names (it folds them the same way); callers collect the rows into a Set instead.
 *   Constant lookups (`TABLE_SCHEMA = ?`, the scope fragment) stay as they are: both servers resolve a constant to
 *   the one table or database with exactly that name (verified on MySQL 8.4 and MariaDB 11.4), and a constant keeps
 *   MariaDB from opening every table in the catalog.
 */
import { type Knex } from 'knex';
import { WSLogger } from 'src/logger';
import {
  buildDatabaseScopeSqlFragment,
  buildMySqlTableLookupKey,
  normalizeMySqlCatalogColumnRow,
  parseNullableCatalogInteger,
} from './mysql-catalog';
import {
  type MySqlCatalogColumn,
  type MySqlDiscoveryScope,
  type MySqlSingleColumnForeignKey,
  type MySqlSingleColumnUniqueIndexColumn,
  type MySqlTableRow,
} from './mysql-catalog-types';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';
import { isMySqlColumnTypeAddressableById } from './mysql-id-binding';
import { qualifiedMySqlTableReferenceForKnex } from './mysql-identifier-quoting';
import { type MySqlTableReference } from './mysql-types';

export type MySqlCatalogQueryRunner = Knex | Knex.Transaction;

/**
 * Table types Scratch lists. MariaDB's `SEQUENCE` (a one-row counter object) and `TEMPORARY` (the current session's
 * temporary tables) are deliberately left out; `SYSTEM VERSIONED` is an ordinary MariaDB table with history.
 */
export const MYSQL_LISTABLE_TABLE_TYPES: readonly string[] = ['BASE TABLE', 'VIEW', 'SYSTEM VERSIONED'];

async function runMySqlCatalogQuery(
  knex: MySqlCatalogQueryRunner,
  sql: string,
  bindings: readonly string[],
): Promise<Record<string, unknown>[]> {
  const rawQueryResult: unknown = await knex.raw(sql, [...bindings]);
  const resultRows: unknown = Array.isArray(rawQueryResult) ? rawQueryResult[0] : undefined;
  if (!Array.isArray(resultRows)) {
    // Never report "no rows" for a result we can't read: an empty catalog answer means "table not found" upstream.
    throw new Error('Unexpected result shape from a MySQL information_schema query');
  }
  return resultRows as Record<string, unknown>[];
}

function readCatalogRowText(row: Record<string, unknown>, alias: string): string {
  const value = row[alias];
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value === null || value === undefined) return '';
  return String(value as string | number | bigint);
}

function readNullableCatalogRowText(row: Record<string, unknown>, alias: string): string | null {
  const value = row[alias];
  return value === null || value === undefined ? null : readCatalogRowText(row, alias);
}

function normalizeMySqlTableRow(row: Record<string, unknown>): MySqlTableRow {
  return {
    databaseName: readCatalogRowText(row, 'database_name'),
    tableName: readCatalogRowText(row, 'table_name'),
    tableType: readCatalogRowText(row, 'table_type'),
    storageEngine: readNullableCatalogRowText(row, 'storage_engine'),
  };
}

function describeTableForMessages(table: MySqlTableReference): string {
  return `"${table.databaseName}"."${table.tableName}"`;
}

// ---------------------------------------------------------------------------------------------------------------
// Databases and tables (scope-wide)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Databases the user can see, minus the scope's exclusions (limited to the configured database when there is one).
 * `SCHEMATA` only lists databases the account holds some privilege on (unless it has SHOW DATABASES). One row per
 * database with no grouping, so MariaDB's case-insensitive collation can't merge `Shop` and `shop`.
 */
export async function findDatabaseNames(knex: MySqlCatalogQueryRunner, scope: MySqlDiscoveryScope): Promise<string[]> {
  const databaseScope = buildDatabaseScopeSqlFragment(scope, 'SCHEMA_NAME');
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT SCHEMA_NAME AS database_name FROM information_schema.SCHEMATA WHERE ${databaseScope.sql} ORDER BY SCHEMA_NAME`,
    databaseScope.bindings,
  );
  return rows.map((row) => readCatalogRowText(row, 'database_name'));
}

/** Every listable table and view in scope. `storageEngine` is null for views. */
export async function findAllTables(
  knex: MySqlCatalogQueryRunner,
  scope: MySqlDiscoveryScope,
): Promise<MySqlTableRow[]> {
  const databaseScope = buildDatabaseScopeSqlFragment(scope, 'TABLE_SCHEMA');
  const tableTypePlaceholders = MYSQL_LISTABLE_TABLE_TYPES.map(() => '?').join(', ');
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT TABLE_SCHEMA AS database_name, TABLE_NAME AS table_name, TABLE_TYPE AS table_type, ENGINE AS storage_engine
     FROM information_schema.TABLES
     WHERE ${databaseScope.sql} AND TABLE_TYPE IN (${tableTypePlaceholders})
     ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    [...databaseScope.bindings, ...MYSQL_LISTABLE_TABLE_TYPES],
  );
  return rows.map(normalizeMySqlTableRow);
}

/**
 * Lookup keys ({@link buildMySqlTableLookupKey}) of the tables that have at least one single-column unique index
 * (the primary key included) — the only tables whose rows Scratch can address.
 *
 * The column count happens INSIDE `STATISTICS`, before any join: a functional key part (MySQL 8.0.13+
 * `UNIQUE (a, (lower(b)))`) is a STATISTICS row with `COLUMN_NAME` NULL, so `COUNT(*) = 1 AND COUNT(COLUMN_NAME) = 1`
 * rejects both multi-part and functional indexes. (Joining COLUMNS first would drop the NULL part and make the index
 * look single-column.) A unique PREFIX index (`SUB_PART`) still counts: a unique prefix implies a unique column.
 *
 * Grouped byte-exactly (see the module header): on MariaDB a plain `GROUP BY TABLE_NAME` merges `Orders` and
 * `orders` (or `café` and `cafe`) into one two-row "PRIMARY" group and wrongly disables both tables. One row comes
 * back per qualifying index; the Set collapses a table's several indexes into one key.
 *
 * Only indexes on a column Scratch can address rows by count ({@link isMySqlColumnTypeAddressableById}): a FLOAT
 * (whose pulled 6-digit rendering never equals the stored float32) or a BLOB / spatial key can't be matched by id,
 * and the spec builder's id chooser skips such columns, so the table preview must agree or an "enabled" table
 * would fail when added.
 */
export async function findTablesWithSingleColumnUniqueIndex(
  knex: MySqlCatalogQueryRunner,
  scope: MySqlDiscoveryScope,
): Promise<Set<string>> {
  const databaseScope = buildDatabaseScopeSqlFragment(scope, 'TABLE_SCHEMA');
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT single_column_unique_index.database_name AS database_name,
            single_column_unique_index.table_name AS table_name,
            unique_column.COLUMN_TYPE AS column_type
     FROM (
       SELECT MIN(TABLE_SCHEMA) AS database_name, MIN(TABLE_NAME) AS table_name, MIN(COLUMN_NAME) AS column_name
       FROM information_schema.STATISTICS
       WHERE NON_UNIQUE = 0 AND ${databaseScope.sql}
       GROUP BY CAST(TABLE_SCHEMA AS BINARY), CAST(TABLE_NAME AS BINARY), CAST(INDEX_NAME AS BINARY)
       HAVING COUNT(*) = 1 AND COUNT(COLUMN_NAME) = 1
     ) AS single_column_unique_index
     JOIN information_schema.COLUMNS AS unique_column
       ON unique_column.TABLE_SCHEMA = single_column_unique_index.database_name
      AND unique_column.TABLE_NAME = single_column_unique_index.table_name
      AND unique_column.COLUMN_NAME = single_column_unique_index.column_name
      AND CAST(unique_column.TABLE_SCHEMA AS BINARY) = CAST(single_column_unique_index.database_name AS BINARY)
      AND CAST(unique_column.TABLE_NAME AS BINARY) = CAST(single_column_unique_index.table_name AS BINARY)
      AND CAST(unique_column.COLUMN_NAME AS BINARY) = CAST(single_column_unique_index.column_name AS BINARY)`,
    databaseScope.bindings,
  );
  return new Set(
    rows
      .filter((row) => isMySqlColumnTypeAddressableById(readCatalogRowText(row, 'column_type')))
      .map((row) =>
        buildMySqlTableLookupKey(readCatalogRowText(row, 'database_name'), readCatalogRowText(row, 'table_name')),
      ),
  );
}

/**
 * Lookup keys of the tables whose primary key is a single AUTO_INCREMENT column — the only tables where MySQL
 * generates the id of a new row (`insertId`), so the only ones Scratch can create rows in. `DEFAULT_GENERATED`
 * (e.g. `DEFAULT (uuid())`) never counts: mysql2 can't report the generated value back.
 *
 * The primary key's part count is taken inside STATISTICS first (as for unique indexes); only then is the single
 * part joined to COLUMNS to read its EXTRA. EXTRA is matched case-insensitively (MariaDB spells it in lower case).
 *
 * Grouped and joined byte-exactly (see the module header). On MariaDB a collation-aware join would also match the
 * primary-key column of `Orders` for the table `orders` when both keys are named `id`, reporting the wrong table's
 * AUTO_INCREMENT. The byte-exact join yields one row per table, so no DISTINCT is needed.
 */
export async function findTablesWithAutoIncrementPrimaryKey(
  knex: MySqlCatalogQueryRunner,
  scope: MySqlDiscoveryScope,
): Promise<Set<string>> {
  const primaryKeyDatabaseScope = buildDatabaseScopeSqlFragment(scope, 'TABLE_SCHEMA');
  // The same scope on the COLUMNS side lets both servers prune the catalog scan (MariaDB opens every table it can't
  // rule out by a constant predicate).
  const primaryKeyColumnDatabaseScope = buildDatabaseScopeSqlFragment(scope, 'primary_key_column.TABLE_SCHEMA');
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT single_column_primary_key.database_name AS database_name,
            single_column_primary_key.table_name AS table_name
     FROM (
       SELECT MIN(TABLE_SCHEMA) AS database_name, MIN(TABLE_NAME) AS table_name, MAX(COLUMN_NAME) AS column_name
       FROM information_schema.STATISTICS
       WHERE INDEX_NAME = 'PRIMARY' AND ${primaryKeyDatabaseScope.sql}
       GROUP BY CAST(TABLE_SCHEMA AS BINARY), CAST(TABLE_NAME AS BINARY)
       HAVING COUNT(*) = 1 AND COUNT(COLUMN_NAME) = 1
     ) AS single_column_primary_key
     JOIN information_schema.COLUMNS AS primary_key_column
       ON primary_key_column.TABLE_SCHEMA = single_column_primary_key.database_name
      AND primary_key_column.TABLE_NAME = single_column_primary_key.table_name
      AND primary_key_column.COLUMN_NAME = single_column_primary_key.column_name
      AND CAST(primary_key_column.TABLE_SCHEMA AS BINARY) = CAST(single_column_primary_key.database_name AS BINARY)
      AND CAST(primary_key_column.TABLE_NAME AS BINARY) = CAST(single_column_primary_key.table_name AS BINARY)
      AND CAST(primary_key_column.COLUMN_NAME AS BINARY) = CAST(single_column_primary_key.column_name AS BINARY)
     WHERE ${primaryKeyColumnDatabaseScope.sql}
       AND LOWER(primary_key_column.EXTRA) LIKE '%auto_increment%'`,
    [...primaryKeyDatabaseScope.bindings, ...primaryKeyColumnDatabaseScope.bindings],
  );
  return new Set(
    rows.map((row) =>
      buildMySqlTableLookupKey(readCatalogRowText(row, 'database_name'), readCatalogRowText(row, 'table_name')),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One table
// ---------------------------------------------------------------------------------------------------------------

/** The table's catalog row (any table type), or null when it doesn't exist or the account can't see it. */
export async function findTableRow(
  knex: MySqlCatalogQueryRunner,
  table: MySqlTableReference,
): Promise<MySqlTableRow | null> {
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT TABLE_SCHEMA AS database_name, TABLE_NAME AS table_name, TABLE_TYPE AS table_type, ENGINE AS storage_engine
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [table.databaseName, table.tableName],
  );
  return rows.length > 0 ? normalizeMySqlTableRow(rows[0]) : null;
}

/**
 * Every column the account can see, in table order, INVISIBLE columns included (the spec builder decides which to
 * keep). Unlike the Postgres connector, zero rows is an error rather than an empty spec: the table was dropped or
 * renamed, or the account lost its privileges, and an empty schema would silently hide that.
 */
export async function findAllColumnsInTable(
  knex: MySqlCatalogQueryRunner,
  table: MySqlTableReference,
): Promise<MySqlCatalogColumn[]> {
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra,
            GENERATION_EXPRESSION AS generation_expression, PRIVILEGES AS privileges, COLUMN_KEY AS column_key,
            CHARACTER_MAXIMUM_LENGTH AS character_maximum_length, NUMERIC_PRECISION AS numeric_precision,
            NUMERIC_SCALE AS numeric_scale, DATETIME_PRECISION AS datetime_precision,
            CHARACTER_SET_NAME AS character_set_name, COLLATION_NAME AS collation_name,
            ORDINAL_POSITION AS ordinal_position
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [table.databaseName, table.tableName],
  );
  if (rows.length === 0) {
    throw new MySqlClientError(
      MySqlClientProblem.TableNotFound,
      `Table ${describeTableForMessages(table)} was not found, or you can't read any of its columns.`,
    );
  }
  return rows.map(normalizeMySqlCatalogColumnRow);
}

/** The primary key's column names in key order (empty when the table has no primary key). */
export async function findPrimaryKeyColumnNames(
  knex: MySqlCatalogQueryRunner,
  table: MySqlTableReference,
): Promise<string[]> {
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT COLUMN_NAME AS column_name
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
     ORDER BY SEQ_IN_INDEX`,
    [table.databaseName, table.tableName],
  );
  return rows.map((row) => readCatalogRowText(row, 'column_name')).filter((columnName) => columnName.length > 0);
}

/**
 * The columns that carry a single-column unique index, primary key first, then in column order. As in
 * {@link findTablesWithSingleColumnUniqueIndex}, the part count is taken inside STATISTICS BEFORE joining COLUMNS,
 * so a functional key part can't make a multi-part index look single-column. A column with several qualifying
 * indexes (e.g. the primary key plus a redundant UNIQUE) appears once per index.
 *
 * Grouped and joined byte-exactly (see the module header). On MariaDB, unique indexes `idx_café` and `idx_cafe`
 * would otherwise merge into one two-part group (both dropped), and a unique `café` column would also match a
 * non-unique `cafe` column, which the id chooser could then pick.
 */
export async function findSingleColumnUniqueIndexColumns(
  knex: MySqlCatalogQueryRunner,
  table: MySqlTableReference,
): Promise<MySqlSingleColumnUniqueIndexColumn[]> {
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT single_column_unique_index.index_name AS index_name, unique_column.COLUMN_NAME AS column_name,
            unique_column.COLUMN_TYPE AS native_type, unique_column.IS_NULLABLE AS is_nullable,
            unique_column.EXTRA AS extra, unique_column.ORDINAL_POSITION AS ordinal_position
     FROM (
       SELECT MIN(INDEX_NAME) AS index_name, MAX(COLUMN_NAME) AS column_name
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0
       GROUP BY CAST(INDEX_NAME AS BINARY)
       HAVING COUNT(*) = 1 AND COUNT(COLUMN_NAME) = 1
     ) AS single_column_unique_index
     JOIN information_schema.COLUMNS AS unique_column
       ON unique_column.TABLE_SCHEMA = ? AND unique_column.TABLE_NAME = ?
      AND unique_column.COLUMN_NAME = single_column_unique_index.column_name
      AND CAST(unique_column.COLUMN_NAME AS BINARY) = CAST(single_column_unique_index.column_name AS BINARY)
     ORDER BY unique_column.ORDINAL_POSITION, single_column_unique_index.index_name`,
    [table.databaseName, table.tableName, table.databaseName, table.tableName],
  );
  const singleColumnUniqueIndexColumns = rows.map(
    (row): MySqlSingleColumnUniqueIndexColumn => ({
      indexName: readCatalogRowText(row, 'index_name'),
      columnName: readCatalogRowText(row, 'column_name'),
      nativeType: readCatalogRowText(row, 'native_type'),
      // MySQL names the primary key index `PRIMARY` (always, and no other index may use that name).
      isPrimaryKey: readCatalogRowText(row, 'index_name') === 'PRIMARY',
      isNullable: readCatalogRowText(row, 'is_nullable').toUpperCase() === 'YES',
      isAutoIncrement: /\bauto_increment\b/i.test(readCatalogRowText(row, 'extra')),
      ordinalPosition: parseNullableCatalogInteger(row.ordinal_position) ?? 0,
    }),
  );
  return singleColumnUniqueIndexColumns.sort(
    (first, second) =>
      Number(second.isPrimaryKey) - Number(first.isPrimaryKey) || first.ordinalPosition - second.ordinalPosition,
  );
}

/**
 * Single-column foreign keys declared on the table (composite foreign keys can't be represented as one linked
 * field and are skipped). Grouping by constraint keeps this one catalog scan; `MAX()` just reads the group's only
 * row. MyISAM tables store no foreign keys, so they naturally return nothing.
 *
 * Grouped byte-exactly (see the module header): MariaDB accepts constraints `fk_café` and `fk_cafe` on one table,
 * and a plain `GROUP BY CONSTRAINT_NAME` would merge them into one two-row group and drop both foreign keys.
 */
export async function findSingleColumnForeignKeysInTable(
  knex: MySqlCatalogQueryRunner,
  table: MySqlTableReference,
): Promise<MySqlSingleColumnForeignKey[]> {
  const rows = await runMySqlCatalogQuery(
    knex,
    `SELECT MIN(CONSTRAINT_NAME) AS constraint_name, MAX(COLUMN_NAME) AS column_name,
            MAX(REFERENCED_TABLE_SCHEMA) AS referenced_database_name,
            MAX(REFERENCED_TABLE_NAME) AS referenced_table_name,
            MAX(REFERENCED_COLUMN_NAME) AS referenced_column_name
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
     GROUP BY CAST(CONSTRAINT_NAME AS BINARY)
     HAVING COUNT(*) = 1
     ORDER BY MIN(CONSTRAINT_NAME)`,
    [table.databaseName, table.tableName],
  );
  return rows.map(
    (row): MySqlSingleColumnForeignKey => ({
      constraintName: readCatalogRowText(row, 'constraint_name'),
      columnName: readCatalogRowText(row, 'column_name'),
      referencedDatabaseName: readCatalogRowText(row, 'referenced_database_name'),
      referencedTableName: readCatalogRowText(row, 'referenced_table_name'),
      referencedColumnName: readCatalogRowText(row, 'referenced_column_name'),
    }),
  );
}

/** The part of mysql2's column definition packet (`FieldPacket`) this module reads. */
interface MySqlResultColumnDefinition {
  readonly name?: unknown;
  readonly extendedFormat?: unknown;
}

/**
 * MariaDB only: the columns MariaDB reports as JSON documents. MariaDB's `JSON` is an alias for `LONGTEXT` with a
 * `CHECK (json_valid(col))`, so `information_schema` says `longtext`; the row decoder nevertheless parses these
 * columns, keyed on the `extendedFormat: 'json'` flag MariaDB puts in the result-set metadata. The spec must agree
 * with the decoder column for column, so this reads that SAME flag, from a `SELECT * … LIMIT 0` (metadata only; the
 * server doesn't read a row).
 *
 * Why not reconstruct it from `information_schema.CHECK_CONSTRAINTS`: verified on MariaDB 11.4, the flag is set by
 * any COLUMN-level CHECK whose top-level AND list contains a `json_valid(...)` call — including on TEXT/VARCHAR
 * columns and even `CHECK (json_valid(other_column))` — but not by an equivalent TABLE-level constraint, not by
 * `json_valid(c) OR …`, and not on a JSON column whose user CHECK replaced the implicit one. It is also absent
 * altogether when a proxy doesn't negotiate MariaDB's extended metadata. Guessing wrong in the "JSON" direction
 * corrupts data (the write path `JSON.stringify`s every value of a JSON column, so a pulled raw string would be
 * written back quoted), so the metadata the decoder itself sees is the only safe source.
 *
 * Failures (e.g. a column the account can't SELECT) are logged and yield an empty set — the safe direction: the
 * column is typed as text, and a parsed document written back is re-serialized by the write path.
 */
export async function findMariaDbJsonAliasColumnNames(
  knex: MySqlCatalogQueryRunner,
  table: MySqlTableReference,
): Promise<Set<string>> {
  try {
    const rawQueryResult: unknown = await knex.raw('SELECT * FROM ?? LIMIT 0', [
      qualifiedMySqlTableReferenceForKnex(table),
    ]);
    const resultColumnDefinitions: unknown = Array.isArray(rawQueryResult) ? rawQueryResult[1] : undefined;
    if (!Array.isArray(resultColumnDefinitions)) return new Set();
    const jsonDocumentColumnNames = new Set<string>();
    for (const resultColumnDefinition of resultColumnDefinitions as MySqlResultColumnDefinition[]) {
      if (resultColumnDefinition?.extendedFormat === 'json' && typeof resultColumnDefinition.name === 'string') {
        jsonDocumentColumnNames.add(resultColumnDefinition.name);
      }
    }
    return jsonDocumentColumnNames;
  } catch (error) {
    WSLogger.warn({
      source: 'MySqlCatalogQueries',
      message: 'Could not read MariaDB JSON column metadata; treating every column as non-JSON',
      errno: typeof error === 'object' && error !== null ? (error as { errno?: unknown }).errno : undefined,
      errorCode: typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined,
    });
    return new Set();
  }
}
