/**
 * Executors for the create-schema API on MySQL-protocol servers (Live Export destinations, DEV-12035). The DDL
 * itself is built by the pure functions in `mysql-create-schema.ts`; this module runs it and reads back what MySQL
 * stored.
 *
 * Rules every executor follows:
 * - DDL never runs inside a transaction: MySQL commits DDL implicitly, so a `trx` would only pretend to roll back.
 *   One statement per table / per field keeps each failure isolated (a failed field doesn't undo the others).
 * - `client.prepareSessionForSchemaChanges()` runs right before each DDL statement (not once per operation): it
 *   bounds the metadata-lock wait (`lock_wait_timeout`, default one YEAR — a waiting ALTER would queue every later
 *   query on the customer's table behind it) and lifts MariaDB's `max_statement_time`, which unlike MySQL's
 *   `max_execution_time` also kills DDL. The pool reaps idle connections, so session state set earlier in the
 *   operation may not survive until the next statement.
 * - No `SET foreign_key_checks = 0`: the new foreign-key column is all-NULL so there is nothing to skip, and managed
 *   services (Vitess / PlanetScale) may refuse the variable.
 */
import { type Knex } from 'knex';
import { WSLogger } from 'src/logger';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
import { type KnexMySqlClient } from './knex-mysql-client';
import { findSingleColumnUniqueIndexColumns, findTableRow } from './mysql-catalog-queries';
import {
  buildAddMySqlColumnQuery,
  buildAddMySqlForeignKeyColumnStatement,
  buildCreateMySqlTableQuery,
  buildMySqlCreatedTableComment,
  buildMySqlForeignKeyColumnTypeDefinition,
  buildMySqlForeignKeyConstraintName,
  findMySqlLeftoverTableColumnsMismatch,
  findMySqlLeftoverTableOwnershipMismatch,
  isMySqlDuplicateTableError,
  resolveMySqlColumnDefinitionForCreateField,
  type MySqlCreateFieldColumnDefinition,
  type MySqlForeignKeyResolution,
  type MySqlLeftoverTableColumn,
  type MySqlLeftoverTableRow,
  type ResolvedMySqlForeignKey,
} from './mysql-create-schema';
import { qualifiedMySqlTableReferenceForKnex } from './mysql-identifier-quoting';
import { isStorageEngineSafeForScratchWrites } from './mysql-table-writability';
import { type MySqlTableReference } from './mysql-types';
import { chooseMySqlUniquelyAddressableColumn } from './mysql-uniquely-addressable-column';

/** `knex.raw` on the mysql2 dialect resolves to `[rows, fields]`; anything else is an unexpected driver shape. */
async function runMySqlSchemaCreationCatalogQuery(
  knex: Knex,
  sql: string,
  bindings: readonly string[],
): Promise<Record<string, unknown>[]> {
  const rawQueryResult: unknown = await knex.raw(sql, [...bindings]);
  const resultRows: unknown = Array.isArray(rawQueryResult) ? rawQueryResult[0] : undefined;
  if (!Array.isArray(resultRows)) {
    throw new Error('Unexpected result shape from a MySQL information_schema query');
  }
  return resultRows as Record<string, unknown>[];
}

/** A catalog text value (information_schema names may arrive as Buffers from some servers / proxies). */
function readNullableCatalogText(row: Record<string, unknown>, alias: string): string | null {
  const value = row[alias];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value as number | bigint);
}

/**
 * The table's `[TABLE_SCHEMA, TABLE_NAME]` exactly as MySQL stored them, or null when the catalog doesn't show it.
 * On `lower_case_table_names=1` servers (Azure's default, Windows, macOS) MySQL lower-cases both names, so the
 * remote id Scratch records must be the stored spelling or it would never equal the `listTables` remote id.
 */
export async function findStoredMySqlTableReference(
  knex: Knex,
  table: MySqlTableReference,
): Promise<MySqlTableReference | null> {
  const catalogRows = await runMySqlSchemaCreationCatalogQuery(
    knex,
    `SELECT TABLE_SCHEMA AS stored_database_name, TABLE_NAME AS stored_table_name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [table.databaseName, table.tableName],
  );
  const storedDatabaseName =
    catalogRows.length > 0 ? readNullableCatalogText(catalogRows[0], 'stored_database_name') : null;
  const storedTableName = catalogRows.length > 0 ? readNullableCatalogText(catalogRows[0], 'stored_table_name') : null;
  if (storedDatabaseName === null || storedTableName === null) return null;
  return { databaseName: storedDatabaseName, tableName: storedTableName };
}

/**
 * `CREATE TABLE` with the injected `bigint unsigned auto_increment` primary key, every non-foreign-key field and, for
 * a Live Export, the comment naming its source table ({@link buildMySqlCreatedTableComment}). Foreign keys are added
 * afterwards, one atomic ALTER each. Returns the per-field skip reasons and the table's address as MySQL stored it
 * (falls back to the requested names if the catalog doesn't show the table).
 *
 * DDL commits at once, so a save interrupted after the CREATE (the worker died, or the read-back below failed)
 * leaves the table behind, and the retry's CREATE hits "table exists" (1050). For a Live Export, the table is then
 * reused when it carries this request's comment, is as planned and is empty
 * ({@link findWhyMySqlLeftoverTableIsNotReusable}). Otherwise the 1050 error is rethrown and the caller reports the
 * name as taken.
 */
export async function createTableWithAutoIncrementPrimaryKey(
  client: KnexMySqlClient,
  table: MySqlTableReference,
  nonForeignKeyFields: ResolvedCreateFieldSpec[],
  request: { createRef: string; foreignKeyFieldNames: ReadonlySet<string> },
): Promise<{ skipReasonByFieldName: Map<string, string>; storedTable: MySqlTableReference }> {
  const skipReasonByFieldName = new Map<string, string>();
  const tableComment = buildMySqlCreatedTableComment(request.createRef);
  const createTableQuery = buildCreateMySqlTableQuery(
    client.knex,
    table,
    nonForeignKeyFields,
    skipReasonByFieldName,
    tableComment,
  );
  await client.prepareSessionForSchemaChanges();
  try {
    await createTableQuery;
  } catch (error) {
    if (!isMySqlDuplicateTableError(error) || tableComment === undefined) throw error;
    const leftoverTable = await findReusableMySqlTableLeftByInterruptedCreate(client.knex, table, {
      tableComment,
      nonForeignKeyFields,
      foreignKeyFieldNames: request.foreignKeyFieldNames,
    });
    if (leftoverTable === null) throw error;
    return { skipReasonByFieldName, storedTable: leftoverTable };
  }
  const storedTable = (await findStoredMySqlTableReference(client.knex, table)) ?? table;
  return { skipReasonByFieldName, storedTable };
}

/**
 * The table an earlier attempt of the same create request left behind, as MySQL stored it, or null when the table
 * that blocked the CREATE isn't one to reuse (or can't be read).
 */
async function findReusableMySqlTableLeftByInterruptedCreate(
  knex: Knex,
  table: MySqlTableReference,
  expected: {
    tableComment: string;
    nonForeignKeyFields: ResolvedCreateFieldSpec[];
    foreignKeyFieldNames: ReadonlySet<string>;
  },
): Promise<MySqlTableReference | null> {
  const plannedColumns = new Map<string, Extract<MySqlCreateFieldColumnDefinition, { outcome: 'column' }>>();
  for (const field of expected.nonForeignKeyFields) {
    const columnDefinition = resolveMySqlColumnDefinitionForCreateField(field, { isCreatingTable: true });
    if (columnDefinition.outcome === 'column') plannedColumns.set(field.name, columnDefinition);
  }
  try {
    const leftoverTable = await readMySqlLeftoverTableRow(knex, table);
    if (leftoverTable === null) return null;
    const mismatch = await findWhyMySqlLeftoverTableIsNotReusable(knex, leftoverTable, {
      tableComment: expected.tableComment,
      plannedColumns,
      foreignKeyFieldNames: expected.foreignKeyFieldNames,
    });
    WSLogger.info({
      source: 'MySqlSchemaCreation.createTableWithAutoIncrementPrimaryKey',
      message:
        mismatch === undefined
          ? 'Reusing the table an interrupted create left behind'
          : 'The table blocking the create is not one to reuse',
      ...(mismatch !== undefined ? { reason: mismatch } : {}),
      tableComment: expected.tableComment,
    });
    return mismatch === undefined ? leftoverTable.storedTable : null;
  } catch (error) {
    WSLogger.warn({
      source: 'MySqlSchemaCreation.createTableWithAutoIncrementPrimaryKey',
      message: "Couldn't read the table blocking the create, so it isn't reused",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Why the table that blocked the CREATE isn't one to reuse, or `undefined` when it is. Cheapest check first: its
 * TABLES row must show this request's InnoDB base table before its columns are read, and its columns must be as
 * planned before it is checked for rows. A row check on a view would compute the view, and on MariaDB the session
 * prepared for schema changes has no statement timeout.
 */
async function findWhyMySqlLeftoverTableIsNotReusable(
  knex: Knex,
  leftoverTable: { storedTable: MySqlTableReference; tableRow: MySqlLeftoverTableRow },
  expected: Parameters<typeof findMySqlLeftoverTableColumnsMismatch>[1] & { tableComment: string },
): Promise<string | undefined> {
  const ownershipMismatch = findMySqlLeftoverTableOwnershipMismatch(leftoverTable.tableRow, expected.tableComment);
  if (ownershipMismatch !== undefined) return ownershipMismatch;
  const columns = await readMySqlLeftoverTableColumns(knex, leftoverTable.storedTable);
  const columnsMismatch = findMySqlLeftoverTableColumnsMismatch(columns, expected);
  if (columnsMismatch !== undefined) return columnsMismatch;
  const anyRow = await runMySqlSchemaCreationCatalogQuery(knex, 'SELECT 1 AS any_row FROM ?? LIMIT 1', [
    qualifiedMySqlTableReferenceForKnex(leftoverTable.storedTable),
  ]);
  return anyRow.length > 0 ? 'it already has rows' : undefined;
}

/** The TABLES row of a table that blocked a CREATE TABLE, under the names MySQL stored, or null if it's gone. */
async function readMySqlLeftoverTableRow(
  knex: Knex,
  table: MySqlTableReference,
): Promise<{ storedTable: MySqlTableReference; tableRow: MySqlLeftoverTableRow } | null> {
  const tableRows = await runMySqlSchemaCreationCatalogQuery(
    knex,
    `SELECT TABLE_SCHEMA AS stored_database_name, TABLE_NAME AS stored_table_name, TABLE_TYPE AS table_type,
            ENGINE AS storage_engine, TABLE_COMMENT AS table_comment
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [table.databaseName, table.tableName],
  );
  if (tableRows.length === 0) return null;
  const storedDatabaseName = readNullableCatalogText(tableRows[0], 'stored_database_name');
  const storedTableName = readNullableCatalogText(tableRows[0], 'stored_table_name');
  if (storedDatabaseName === null || storedTableName === null) return null;
  return {
    storedTable: { databaseName: storedDatabaseName, tableName: storedTableName },
    tableRow: {
      tableType: readNullableCatalogText(tableRows[0], 'table_type') ?? '',
      storageEngine: readNullableCatalogText(tableRows[0], 'storage_engine'),
      tableComment: readNullableCatalogText(tableRows[0], 'table_comment') ?? '',
    },
  };
}

/** The columns of a table that blocked a CREATE TABLE, in table order. */
async function readMySqlLeftoverTableColumns(
  knex: Knex,
  storedTable: MySqlTableReference,
): Promise<MySqlLeftoverTableColumn[]> {
  const columnRows = await runMySqlSchemaCreationCatalogQuery(
    knex,
    `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable,
            COLUMN_KEY AS column_key, EXTRA AS extra
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [storedTable.databaseName, storedTable.tableName],
  );
  return columnRows.map((columnRow) => ({
    columnName: readNullableCatalogText(columnRow, 'column_name') ?? '',
    columnType: readNullableCatalogText(columnRow, 'column_type') ?? '',
    isNullable: (readNullableCatalogText(columnRow, 'is_nullable') ?? '').toUpperCase() === 'YES',
    columnKey: (readNullableCatalogText(columnRow, 'column_key') ?? '').toUpperCase(),
    extra: readNullableCatalogText(columnRow, 'extra') ?? '',
  }));
}

/**
 * A catalog read made after a 1060 (duplicate column). A failed read means "not as planned", so the caller reports
 * the original 1060 rather than the read's error.
 */
async function runCatalogQueryForDuplicateColumnCheck(
  knex: Knex,
  sql: string,
  bindings: readonly string[],
): Promise<Record<string, unknown>[]> {
  try {
    return await runMySqlSchemaCreationCatalogQuery(knex, sql, bindings);
  } catch (error) {
    WSLogger.warn({
      source: 'MySqlSchemaCreation.duplicateColumnCheck',
      message: "Couldn't read the existing column after a duplicate-column error, so it isn't reused",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Whether `table` carries exactly `tableComment` ({@link buildMySqlCreatedTableComment}), i.e. it was created for the
 * Live Export source table the comment names. A failed read counts as no.
 */
export async function doesMySqlTableCarryCreatedTableComment(
  client: KnexMySqlClient,
  table: MySqlTableReference,
  tableComment: string,
): Promise<boolean> {
  const tableRows = await runCatalogQueryForDuplicateColumnCheck(
    client.knex,
    `SELECT TABLE_COMMENT AS table_comment
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [table.databaseName, table.tableName],
  );
  return tableRows.length === 1 && readNullableCatalogText(tableRows[0], 'table_comment') === tableComment;
}

/**
 * After a 1060 (duplicate column) on the foreign-key ALTER: whether the column already carries the constraint Scratch
 * names for it ({@link buildMySqlForeignKeyConstraintName}) and references the resolved target. Column and constraint
 * are only ever added together, so on a table this request created ({@link doesMySqlTableCarryCreatedTableComment})
 * that means an earlier attempt of the same save added this foreign key. Only ask on such a table.
 */
export async function isExistingMySqlForeignKeyAsPlanned(
  client: KnexMySqlClient,
  table: MySqlTableReference,
  field: ResolvedCreateFieldSpec,
  resolution: ResolvedMySqlForeignKey,
): Promise<boolean> {
  const constraintRows = await runCatalogQueryForDuplicateColumnCheck(
    client.knex,
    `SELECT REFERENCED_TABLE_SCHEMA AS referenced_database_name, REFERENCED_TABLE_NAME AS referenced_table_name,
            REFERENCED_COLUMN_NAME AS referenced_column_name
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table.databaseName, table.tableName, field.name, buildMySqlForeignKeyConstraintName(table.tableName, field.name)],
  );
  return constraintRows.some(
    (constraintRow) =>
      readNullableCatalogText(constraintRow, 'referenced_database_name') === resolution.targetTable.databaseName &&
      readNullableCatalogText(constraintRow, 'referenced_table_name') === resolution.targetTable.tableName &&
      readNullableCatalogText(constraintRow, 'referenced_column_name') === resolution.targetColumnName,
  );
}

/**
 * `ALTER TABLE … ADD` one non-foreign-key field. A field that can't become a column returns its skip reason without
 * touching the server; MySQL errors (1060 duplicate column, 1142 no ALTER grant, ...) propagate to the caller.
 */
export async function addNonForeignKeyColumn(
  client: KnexMySqlClient,
  table: MySqlTableReference,
  field: ResolvedCreateFieldSpec,
): Promise<{ skipReason?: string }> {
  const columnDefinition = resolveMySqlColumnDefinitionForCreateField(field, { isCreatingTable: false });
  if (columnDefinition.outcome === 'skipped') {
    return { skipReason: columnDefinition.skipReason };
  }
  const skipReasonByFieldName = new Map<string, string>();
  const addColumnQuery = buildAddMySqlColumnQuery(client.knex, table, field, skipReasonByFieldName);
  await client.prepareSessionForSchemaChanges();
  await addColumnQuery;
  return {};
}

/**
 * Add a foreign-key column and its constraint in ONE atomic `ALTER TABLE … ADD COLUMN …, ADD CONSTRAINT …`
 * (when MySQL rejects the constraint, the column isn't left behind). Errors propagate to the caller, which reports
 * the field as failed (`mySqlSchemaCreationErrorMessage` names the cause).
 */
export async function addForeignKeyColumnWithConstraint(
  client: KnexMySqlClient,
  table: MySqlTableReference,
  field: ResolvedCreateFieldSpec,
  resolution: ResolvedMySqlForeignKey,
): Promise<void> {
  const addForeignKeyColumnStatement = buildAddMySqlForeignKeyColumnStatement(client.knex, table, field, resolution);
  await client.prepareSessionForSchemaChanges();
  await addForeignKeyColumnStatement;
}

/** The referenced column's type details and whether a full-length single-column unique index backs it. */
export interface MySqlForeignKeyTargetColumnDetails {
  readonly columnType: string;
  readonly characterSetName: string | null;
  readonly collationName: string | null;
  /**
   * Whether the column has a UNIQUE (or PRIMARY) index of exactly this one column over its FULL length. A unique
   * PREFIX index (`UNIQUE (code(5))`) identifies rows for Scratch's reads, but MySQL 8.4 refuses to reference it
   * (`restrict_fk_on_non_standard_key`, 6125) and older servers would accept an FK that isn't backed by a unique key.
   */
  readonly hasFullLengthSingleColumnUniqueIndex: boolean;
  /** A VIRTUAL generated column can't be referenced by a foreign key (MySQL 3733, MariaDB 1005). */
  readonly isVirtualGeneratedColumn: boolean;
}

/** One key part of a unique index, as read from `information_schema.STATISTICS`. */
export interface MySqlUniqueIndexKeyPart {
  readonly indexName: string;
  /** NULL for a functional key part (MySQL 8.0.13+ `UNIQUE ((lower(col)))`). */
  readonly columnName: string | null;
  /** The prefix length of a prefix key part; null when the whole column is indexed. */
  readonly prefixLength: number | null;
}

/**
 * Whether some unique index consists of exactly `columnName`, over its full length. Column names compare
 * case-insensitively, like MySQL's own.
 */
export function hasFullLengthSingleColumnUniqueIndex(
  uniqueIndexKeyParts: readonly MySqlUniqueIndexKeyPart[],
  columnName: string,
): boolean {
  const keyPartsByIndexName = new Map<string, MySqlUniqueIndexKeyPart[]>();
  for (const uniqueIndexKeyPart of uniqueIndexKeyParts) {
    const keyPartsOfIndex = keyPartsByIndexName.get(uniqueIndexKeyPart.indexName) ?? [];
    keyPartsOfIndex.push(uniqueIndexKeyPart);
    keyPartsByIndexName.set(uniqueIndexKeyPart.indexName, keyPartsOfIndex);
  }
  const lowerCasedColumnName = columnName.toLowerCase();
  return [...keyPartsByIndexName.values()].some(
    (keyPartsOfIndex) =>
      keyPartsOfIndex.length === 1 &&
      keyPartsOfIndex[0].columnName?.toLowerCase() === lowerCasedColumnName &&
      keyPartsOfIndex[0].prefixLength === null,
  );
}

function parseNullableCatalogPrefixLength(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const prefixLength = Number(typeof value === 'bigint' ? value.toString() : value);
  // An unreadable value is treated as a prefix (the conservative answer: the column is then not referenced).
  return Number.isFinite(prefixLength) ? prefixLength : 0;
}

/** Read the referenced column's type / character set / collation and its unique-index coverage (two catalog reads). */
async function readMySqlForeignKeyTargetColumnDetails(
  knex: Knex,
  targetTable: MySqlTableReference,
  targetColumnName: string,
): Promise<MySqlForeignKeyTargetColumnDetails | null> {
  const columnRows = await runMySqlSchemaCreationCatalogQuery(
    knex,
    `SELECT COLUMN_TYPE AS column_type, CHARACTER_SET_NAME AS character_set_name, COLLATION_NAME AS collation_name,
            EXTRA AS extra
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [targetTable.databaseName, targetTable.tableName, targetColumnName],
  );
  const columnType = columnRows.length > 0 ? readNullableCatalogText(columnRows[0], 'column_type') : null;
  if (columnType === null) return null;
  const uniqueIndexKeyPartRows = await runMySqlSchemaCreationCatalogQuery(
    knex,
    `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name, SUB_PART AS prefix_length
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0`,
    [targetTable.databaseName, targetTable.tableName],
  );
  const uniqueIndexKeyParts = uniqueIndexKeyPartRows.map(
    (uniqueIndexKeyPartRow): MySqlUniqueIndexKeyPart => ({
      indexName: readNullableCatalogText(uniqueIndexKeyPartRow, 'index_name') ?? '',
      columnName: readNullableCatalogText(uniqueIndexKeyPartRow, 'column_name'),
      prefixLength: parseNullableCatalogPrefixLength(uniqueIndexKeyPartRow.prefix_length),
    }),
  );
  return {
    columnType,
    characterSetName: readNullableCatalogText(columnRows[0], 'character_set_name'),
    collationName: readNullableCatalogText(columnRows[0], 'collation_name'),
    hasFullLengthSingleColumnUniqueIndex: hasFullLengthSingleColumnUniqueIndex(uniqueIndexKeyParts, targetColumnName),
    isVirtualGeneratedColumn: /\bVIRTUAL GENERATED\b/i.test(readNullableCatalogText(columnRows[0], 'extra') ?? ''),
  };
}

/** Whether the table is partitioned: InnoDB can't reference a partitioned table (MySQL 1506, MariaDB 1005). */
async function isMySqlTablePartitioned(knex: Knex, table: MySqlTableReference): Promise<boolean> {
  const tableRows = await runMySqlSchemaCreationCatalogQuery(
    knex,
    `SELECT CREATE_OPTIONS AS create_options FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [table.databaseName, table.tableName],
  );
  const createOptions = tableRows.length > 0 ? readNullableCatalogText(tableRows[0], 'create_options') : null;
  return /\bpartitioned\b/i.test(createOptions ?? '');
}

function describeMySqlTableForMessages(table: MySqlTableReference): string {
  return `"${table.databaseName}"."${table.tableName}"`;
}

/**
 * Resolve what a foreign key into `targetTable` must reference, or why it can't be created. The referenced column
 * is chosen with {@link chooseMySqlUniquelyAddressableColumn} — the SAME choice the read side makes for the table's
 * `idPath` — so the foreign-key column holds exactly the id values the sync pipeline writes into it.
 *
 * Unresolvable (each reported as a per-field skip; reasons start lower-case so the caller can prefix
 * `couldn't create foreign key "<field>": `): the table is missing or invisible to this account, is a view, isn't
 * InnoDB (MySQL only enforces foreign keys between InnoDB tables), is partitioned, has no single-column unique
 * column, or the chosen column is TEXT / BLOB / JSON / binary / not recreatable, a VIRTUAL generated column, or unique
 * only through a prefix index.
 */
export async function resolveForeignKeyReferenceForTargetTable(
  knex: Knex,
  targetTable: MySqlTableReference,
): Promise<MySqlForeignKeyResolution> {
  const targetTableRow = await findTableRow(knex, targetTable);
  if (targetTableRow === null) {
    return {
      kind: 'unresolvable',
      reason: `the linked table ${describeMySqlTableForMessages(targetTable)} doesn't exist, or this connection's MySQL user can't see it`,
    };
  }
  const storedTargetTable: MySqlTableReference = {
    databaseName: targetTableRow.databaseName,
    tableName: targetTableRow.tableName,
  };
  const targetTableDescription = describeMySqlTableForMessages(storedTargetTable);
  if (targetTableRow.tableType.toUpperCase() === 'VIEW') {
    return {
      kind: 'unresolvable',
      reason: `the linked table ${targetTableDescription} is a view, and MySQL foreign keys can only reference tables`,
    };
  }
  if (!isStorageEngineSafeForScratchWrites(targetTableRow.storageEngine)) {
    return {
      kind: 'unresolvable',
      reason: `the linked table ${targetTableDescription} uses the ${targetTableRow.storageEngine ?? 'unknown'} storage engine, and MySQL only enforces foreign keys between InnoDB tables`,
    };
  }

  if (await isMySqlTablePartitioned(knex, storedTargetTable)) {
    return {
      kind: 'unresolvable',
      reason: `the linked table ${targetTableDescription} is partitioned, and MySQL foreign keys can't reference a partitioned table`,
    };
  }

  const referencedColumn = chooseMySqlUniquelyAddressableColumn(
    await findSingleColumnUniqueIndexColumns(knex, storedTargetTable),
  );
  if (referencedColumn === null) {
    return {
      kind: 'unresolvable',
      reason: `the linked table ${targetTableDescription} has no single-column primary key or unique column for a foreign key to reference`,
    };
  }
  const referencedColumnDetails = await readMySqlForeignKeyTargetColumnDetails(
    knex,
    storedTargetTable,
    referencedColumn.columnName,
  );
  if (referencedColumnDetails === null) {
    return {
      kind: 'unresolvable',
      reason: `the id column "${referencedColumn.columnName}" of the linked table ${targetTableDescription} disappeared while Scratch was reading it — try again`,
    };
  }
  const foreignKeyColumnType = buildMySqlForeignKeyColumnTypeDefinition(referencedColumnDetails);
  if ('unreferenceableReason' in foreignKeyColumnType) {
    return {
      kind: 'unresolvable',
      reason: `the id column "${referencedColumn.columnName}" of the linked table ${targetTableDescription} ${foreignKeyColumnType.unreferenceableReason}`,
    };
  }
  if (referencedColumnDetails.isVirtualGeneratedColumn) {
    return {
      kind: 'unresolvable',
      reason: `the id column "${referencedColumn.columnName}" of the linked table ${targetTableDescription} is a VIRTUAL generated column, which a MySQL foreign key can't reference`,
    };
  }
  if (!referencedColumnDetails.hasFullLengthSingleColumnUniqueIndex) {
    return {
      kind: 'unresolvable',
      reason: `the id column "${referencedColumn.columnName}" of the linked table ${targetTableDescription} is unique only through a prefix index, which a MySQL foreign key can't reference`,
    };
  }
  return {
    kind: 'resolved',
    targetTable: storedTargetTable,
    targetColumnName: referencedColumn.columnName,
    foreignKeyColumnTypeDefinition: foreignKeyColumnType.foreignKeyColumnTypeDefinition,
  };
}
