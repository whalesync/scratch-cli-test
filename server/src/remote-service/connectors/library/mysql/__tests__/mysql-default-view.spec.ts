import { Type, type TSchema } from '@sinclair/typebox';
import { type TableViewCol } from '@spinner/shared-types';
import { type MySqlCatalogColumn } from '../mysql-catalog-types';
import { buildMySqlDefaultView } from '../mysql-default-view';
import { buildMySqlJsonTableSpec } from '../mysql-json-schema';

function buildCatalogColumn(overrides: Partial<MySqlCatalogColumn>): MySqlCatalogColumn {
  return {
    columnName: 'value',
    dataType: 'varchar',
    columnType: 'varchar(255)',
    isNullable: false,
    columnDefault: null,
    extra: '',
    generationExpression: null,
    privileges: 'select,insert,update,references',
    columnKey: '',
    characterMaximumLength: null,
    numericPrecision: null,
    numericScale: null,
    datetimePrecision: null,
    // Text columns (ENUM / SET included) always report a charset; NULL marks a binary-charset ENUM / SET.
    characterSetName: 'utf8mb4',
    collationName: 'utf8mb4_0900_ai_ci',
    ordinalPosition: 1,
    ...overrides,
  };
}

/** A spec schema built exactly as the connector builds it, from catalog columns. */
function buildTableSchema(columns: MySqlCatalogColumn[], mariaDbJsonAliasColumnNames: string[] = []): TSchema {
  return buildMySqlJsonTableSpec({
    entityId: { wsId: 'shop__orders', remoteId: ['shop', 'orders'] },
    table: { databaseName: 'shop', tableName: 'orders' },
    columns,
    primaryKeyColumnNames: ['id'],
    singleColumnUniqueIndexColumns: [
      {
        indexName: 'PRIMARY',
        columnName: 'id',
        nativeType: 'int',
        isPrimaryKey: true,
        isNullable: false,
        isAutoIncrement: true,
        ordinalPosition: 1,
      },
    ],
    foreignKeys: [],
    mariaDbJsonAliasColumnNames: new Set(mariaDbJsonAliasColumnNames),
  }).schema;
}

function viewColumnsByPath(schema: TSchema): Map<string, TableViewCol> {
  const viewColumns = buildMySqlDefaultView(schema).cols.filter(
    (viewColumn): viewColumn is TableViewCol => viewColumn.kind === 'col',
  );
  return new Map(viewColumns.map((viewColumn) => [viewColumn.path, viewColumn]));
}

describe('buildMySqlDefaultView', () => {
  const tableSchema = buildTableSchema(
    [
      buildCatalogColumn({ columnName: 'id', dataType: 'int', columnType: 'int', extra: 'auto_increment' }),
      buildCatalogColumn({ columnName: 'status', dataType: 'enum', columnType: "enum('lead','won')" }),
      buildCatalogColumn({
        columnName: 'priority',
        dataType: 'enum',
        columnType: "enum('low','high')",
        isNullable: true,
      }),
      buildCatalogColumn({ columnName: 'tags', dataType: 'set', columnType: "set('x','y')", isNullable: true }),
      buildCatalogColumn({ columnName: 'flag', dataType: 'tinyint', columnType: 'tinyint(1)' }),
      buildCatalogColumn({ columnName: 'total', dataType: 'decimal', columnType: 'decimal(10,2)' }),
      buildCatalogColumn({ columnName: 'shipped_on', dataType: 'date', columnType: 'date', isNullable: true }),
      buildCatalogColumn({ columnName: 'updated_at', dataType: 'timestamp', columnType: 'timestamp' }),
      buildCatalogColumn({ columnName: 'doc', dataType: 'json', columnType: 'json', isNullable: true }),
      buildCatalogColumn({ columnName: 'attributes', dataType: 'longtext', columnType: 'longtext', isNullable: true }),
      buildCatalogColumn({ columnName: 'photo', dataType: 'blob', columnType: 'blob', isNullable: true }),
      buildCatalogColumn({ columnName: 'name', dataType: 'varchar', columnType: 'varchar(80)' }),
    ],
    ['attributes'],
  );
  const viewColumns = viewColumnsByPath(tableSchema);

  it('shows an ENUM (nullable or not) as a select whose render type stays string', () => {
    expect(viewColumns.get('status')).toEqual(
      expect.objectContaining({ type: 'string', logicalType: 'select', name: 'Status' }),
    );
    expect(viewColumns.get('priority')).toEqual(expect.objectContaining({ type: 'string', logicalType: 'select' }));
  });

  it('leaves SET and plain text columns as strings (no select)', () => {
    expect(viewColumns.get('tags')?.logicalType).toBeUndefined();
    expect(viewColumns.get('tags')?.type).toBeUndefined();
    expect(viewColumns.get('name')?.logicalType).toBeUndefined();
  });

  it('keeps the shared family → cell mapping (TINYINT(1) stays a number, not a checkbox)', () => {
    expect(viewColumns.get('flag')?.type).toBe('number');
    expect(viewColumns.get('total')?.type).toBeUndefined();
    expect(viewColumns.get('shipped_on')?.type).toBe('date');
    expect(viewColumns.get('updated_at')?.type).toBe('date');
    expect(viewColumns.get('doc')?.type).toBe('object');
    expect(viewColumns.get('attributes')?.type).toBe('object');
  });

  it('passes read-only flags through', () => {
    expect(viewColumns.get('id')?.readonly).toBe(true);
    expect(viewColumns.get('photo')?.readonly).toBe(true);
    expect(viewColumns.get('name')?.readonly).toBeUndefined();
  });

  it('keeps the priority-column ordering of the shared view', () => {
    const orderedPaths = buildMySqlDefaultView(tableSchema).cols.map((viewColumn) =>
      viewColumn.kind === 'col' ? viewColumn.path : viewColumn.kind,
    );
    expect(orderedPaths.slice(0, 4)).toEqual(['id', 'name', 'status', 'updated_at']);
  });

  it('does not turn an ENUM whose members could not be parsed into a select', () => {
    const malformedEnumSchema = buildTableSchema([
      buildCatalogColumn({ columnName: 'id', dataType: 'int', columnType: 'int', extra: 'auto_increment' }),
      buildCatalogColumn({ columnName: 'status', dataType: 'enum', columnType: "enum('unterminated" }),
    ]);
    expect(viewColumnsByPath(malformedEnumSchema).get('status')?.logicalType).toBeUndefined();
  });

  it('ignores a literal union that is not a MySQL ENUM', () => {
    const foreignSchema = Type.Object({ state: Type.Union([Type.Literal('a'), Type.Literal('b')]) });
    expect(viewColumnsByPath(foreignSchema).get('state')?.logicalType).toBeUndefined();
  });
});
