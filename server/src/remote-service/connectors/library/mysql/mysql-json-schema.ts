/**
 * Pure builders turning `information_schema` facts into the connector contracts: the table picker entry
 * ({@link buildMySqlTablePreview}) and the table's JSON spec ({@link buildMySqlJsonTableSpec}). No I/O — the
 * connector fetches the catalog rows (`mysql-catalog-queries.ts`) and hands them over.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_NATIVE_COLUMN_TYPE,
  X_SCRATCH_READONLY,
  type ForeignKeyOptionSchema,
} from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import { dotPath, type BaseJsonTableSpec, type DotPath, type EntityId, type TablePreview } from '../../types';
import { buildMySqlTableLookupKey } from './mysql-catalog';
import {
  type MySqlCatalogColumn,
  type MySqlSingleColumnForeignKey,
  type MySqlSingleColumnUniqueIndexColumn,
  type MySqlTableRow,
} from './mysql-catalog-types';
import { buildMySqlNativeColumnTypeAnnotation } from './mysql-native-column-type';
import { buildMySqlTablePreviewWriteRestrictions } from './mysql-table-writability';
import {
  columnValueMayBeOmittedOnInsert,
  isMySqlInvisibleColumn,
  isMySqlReadOnlyColumn,
  mapMySqlColumnType,
  pickMySqlTitleColumnPath,
} from './mysql-type-mapping';
import { type MySqlTableReference } from './mysql-types';
import { chooseMySqlUniquelyAddressableColumn } from './mysql-uniquely-addressable-column';

/** The only character types whose `X_SCRATCH_MAX_LENGTH` is a real, enforced limit worth surfacing. */
const MYSQL_DATA_TYPES_WITH_MAX_LENGTH_ANNOTATION: ReadonlySet<string> = new Set(['char', 'varchar']);

/** The id column name used when a table has no uniquely addressable column (flagged for user selection). */
const FALLBACK_ID_COLUMN_NAME = 'id';

export const MYSQL_VIEW_DISABLED_REASON =
  "This is a view. Views aren't supported yet: MySQL doesn't report a unique key for a view, so its rows can't be uniquely identified.";

/** Same wording as the Postgres connector, so both SQL connectors explain the rule identically. */
export const MYSQL_TABLE_WITHOUT_SINGLE_COLUMN_UNIQUE_KEY_DISABLED_REASON =
  "This table has no single-column unique key (a primary key or unique index on one column), so its rows can't be uniquely identified.";

/**
 * The table picker entry. Rules, first match wins:
 *  1. a VIEW → disabled (no unique key is reported for views);
 *  2. no single-column unique index (e.g. only a composite primary key) → disabled;
 *  3. otherwise the write restrictions from `mysql-table-writability.ts`: a non-InnoDB engine disables every write,
 *     a primary key that isn't AUTO_INCREMENT disables creates.
 */
export function buildMySqlTablePreview(
  table: MySqlTableRow,
  lookups: { tablesWithSingleColumnUniqueIndex: Set<string>; tablesWithAutoIncrementPrimaryKey: Set<string> },
): TablePreview {
  const tableLookupKey = buildMySqlTableLookupKey(table.databaseName, table.tableName);
  const isView = table.tableType.toUpperCase() === 'VIEW';
  const tablePreviewIdentity: TablePreview = {
    id: {
      wsId: sanitizeForTableWsId(`${table.databaseName}__${table.tableName}`),
      remoteId: [table.databaseName, table.tableName],
    },
    displayName: table.tableName,
    parentPath: table.databaseName,
    metadata: {
      database: table.databaseName,
      tableType: table.tableType,
      storageEngine: table.storageEngine,
      description: `${isView ? 'View' : 'Table'} "${table.tableName}" in database "${table.databaseName}"`,
    },
  };

  if (isView) {
    return { ...tablePreviewIdentity, disabled: true, disabledReason: MYSQL_VIEW_DISABLED_REASON };
  }
  if (!lookups.tablesWithSingleColumnUniqueIndex.has(tableLookupKey)) {
    return {
      ...tablePreviewIdentity,
      disabled: true,
      disabledReason: MYSQL_TABLE_WITHOUT_SINGLE_COLUMN_UNIQUE_KEY_DISABLED_REASON,
    };
  }
  return {
    ...tablePreviewIdentity,
    ...buildMySqlTablePreviewWriteRestrictions({
      storageEngine: table.storageEngine,
      hasAutoIncrementPrimaryKey: lookups.tablesWithAutoIncrementPrimaryKey.has(tableLookupKey),
    }),
  };
}

export interface BuildMySqlJsonTableSpecInput {
  entityId: EntityId;
  table: MySqlTableReference;
  columns: MySqlCatalogColumn[];
  primaryKeyColumnNames: string[];
  singleColumnUniqueIndexColumns: MySqlSingleColumnUniqueIndexColumn[];
  foreignKeys: MySqlSingleColumnForeignKey[];
  /** Columns MariaDB reports as JSON documents (see `findMariaDbJsonAliasColumnNames`); empty on MySQL. */
  mariaDbJsonAliasColumnNames: ReadonlySet<string>;
}

/** A nullable column also accepts a present `null` (same nesting as the Postgres mapping). */
function wrapNullableValueSchema(valueSchema: TSchema, isNullable: boolean): TSchema {
  return isNullable ? Type.Union([valueSchema, Type.Null()]) : valueSchema;
}

/**
 * The column's JSON Schema, annotated for the rest of the pipeline:
 * - `x-scratch-connector-data-type`: the shared family (drives the default view, empty-string coercion, JSON writes);
 * - `x-scratch-native-column-type`: the exact `COLUMN_TYPE` (MariaDB JSON → `json`), for same-type-system Live Export;
 * - `x-scratch-max-length` (CHAR/VARCHAR only), `x-scratch-readonly`, `x-scratch-agent-instructions`, and the
 *   foreign-key target.
 *
 * The chosen id column is always read-only: it ADDRESSES the row, so an edited id would make an update land on
 * whichever row owns the new value. Nothing needs to write it — creates are only enabled for AUTO_INCREMENT ids,
 * which MySQL assigns (and which are read-only already).
 */
function buildMySqlColumnPropertySchema(
  column: MySqlCatalogColumn,
  context: {
    isMariaDbJsonAlias: boolean;
    isChosenIdColumn: boolean;
    foreignKeyOptions: ForeignKeyOptionSchema | undefined;
  },
): TSchema {
  const columnTypeMapping = mapMySqlColumnType(column, { isMariaDbJsonAlias: context.isMariaDbJsonAlias });
  const annotatedColumnSchema: Record<string, unknown> = {
    ...wrapNullableValueSchema(columnTypeMapping.valueSchema, column.isNullable),
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: columnTypeMapping.columnFamily,
    [X_SCRATCH_NATIVE_COLUMN_TYPE]: buildMySqlNativeColumnTypeAnnotation(column.columnType, {
      isMariaDbJsonAlias: context.isMariaDbJsonAlias,
      characterSetName: column.characterSetName,
    }),
  };
  if (
    !context.isMariaDbJsonAlias &&
    MYSQL_DATA_TYPES_WITH_MAX_LENGTH_ANNOTATION.has(column.dataType) &&
    column.characterMaximumLength !== null
  ) {
    annotatedColumnSchema[X_SCRATCH_MAX_LENGTH] = column.characterMaximumLength;
  }
  if (context.isChosenIdColumn || isMySqlReadOnlyColumn(column, columnTypeMapping)) {
    annotatedColumnSchema[X_SCRATCH_READONLY] = true;
  }
  if (columnTypeMapping.agentInstructions !== undefined) {
    annotatedColumnSchema[X_SCRATCH_AGENT_INSTRUCTIONS] = columnTypeMapping.agentInstructions;
  }
  if (context.foreignKeyOptions) {
    annotatedColumnSchema[X_SCRATCH_FOREIGN_KEY_OPTIONS] = context.foreignKeyOptions;
  }
  const columnSchema = annotatedColumnSchema as TSchema;
  return columnValueMayBeOmittedOnInsert(column) ? Type.Optional(columnSchema) : columnSchema;
}

/**
 * The table's JSON spec.
 *
 * - `idPath`: the uniquely addressable column (single-column primary key → AUTO_INCREMENT unique → NOT NULL unique →
 *   first unique, skipping columns whose pulled id can't be bound back, e.g. FLOAT; the same chooser the DDL slice
 *   uses for foreign-key targets), marked read-only. When none exists (the table lost its unique index after it was
 *   added, or its only unique column is a FLOAT), `idPath` falls back to the first primary-key column or `id` and
 *   `idPathRequiresUserSelection` is set, so the pipeline fails loudly instead of addressing rows by a guess. The
 *   fallback column is NOT marked read-only: the user picks the real id column, and the fallback may be editable.
 * - INVISIBLE columns are left out (reads use an explicit column list and never see them) — except the id itself,
 *   which covers MySQL's generated invisible primary key `my_row_id` (GIPK; on by default on Azure).
 * - A foreign key names its target both ways: `linkedTableId` `db.table` and `linkedTableRemoteId` `[db, table]`,
 *   which deep-equals the linked table's remote id from `listTables`.
 */
export function buildMySqlJsonTableSpec(input: BuildMySqlJsonTableSpecInput): BaseJsonTableSpec {
  const { entityId, table } = input;
  const uniquelyAddressableColumn = chooseMySqlUniquelyAddressableColumn(input.singleColumnUniqueIndexColumns);
  const idColumnName =
    uniquelyAddressableColumn?.columnName ?? input.primaryKeyColumnNames[0] ?? FALLBACK_ID_COLUMN_NAME;

  const foreignKeyOptionsByColumnName = new Map<string, ForeignKeyOptionSchema>();
  for (const foreignKey of input.foreignKeys) {
    foreignKeyOptionsByColumnName.set(foreignKey.columnName, {
      linkedTableId: `${foreignKey.referencedDatabaseName}.${foreignKey.referencedTableName}`,
      linkedTableRemoteId: [foreignKey.referencedDatabaseName, foreignKey.referencedTableName],
    });
  }

  const columnsIncludedInSchema = input.columns.filter(
    (column) => !isMySqlInvisibleColumn(column) || column.columnName === idColumnName,
  );

  const schemaPropertiesByColumnName: Record<string, TSchema> = {};
  let slugPath: DotPath | undefined;
  for (const column of columnsIncludedInSchema) {
    schemaPropertiesByColumnName[column.columnName] = buildMySqlColumnPropertySchema(column, {
      isMariaDbJsonAlias: input.mariaDbJsonAliasColumnNames.has(column.columnName),
      isChosenIdColumn: uniquelyAddressableColumn?.columnName === column.columnName,
      foreignKeyOptions: foreignKeyOptionsByColumnName.get(column.columnName),
    });
    if (column.columnName === 'slug') {
      slugPath = dotPath('slug');
    }
  }

  const tableSchema = Type.Object(schemaPropertiesByColumnName, {
    $id: `mysql/${table.databaseName}.${table.tableName}`,
    title: table.tableName,
  });

  return {
    id: entityId,
    slug: table.tableName,
    name: table.tableName,
    schema: tableSchema,
    idPath: dotPath(idColumnName),
    ...(uniquelyAddressableColumn === null ? { idPathRequiresUserSelection: true } : {}),
    titlePath: pickMySqlTitleColumnPath(columnsIncludedInSchema),
    slugPath,
    basePath: [table.databaseName],
    generatedAt: new Date().toISOString(),
  };
}
