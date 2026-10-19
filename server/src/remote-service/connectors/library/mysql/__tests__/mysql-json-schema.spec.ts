import { type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  PostgresColumnType,
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_NATIVE_COLUMN_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { buildMySqlTableLookupKey } from '../mysql-catalog';
import {
  type MySqlCatalogColumn,
  type MySqlSingleColumnUniqueIndexColumn,
  type MySqlTableRow,
} from '../mysql-catalog-types';
import {
  buildMySqlJsonTableSpec,
  buildMySqlTablePreview,
  MYSQL_TABLE_WITHOUT_SINGLE_COLUMN_UNIQUE_KEY_DISABLED_REASON,
  MYSQL_VIEW_DISABLED_REASON,
  type BuildMySqlJsonTableSpecInput,
} from '../mysql-json-schema';
import { TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON } from '../mysql-table-writability';

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
    // The default column is a VARCHAR; text columns (ENUM / SET included) always report their charset.
    characterSetName: 'utf8mb4',
    collationName: 'utf8mb4_0900_ai_ci',
    ordinalPosition: 1,
    ...overrides,
  };
}

function buildUniqueIndexColumn(
  overrides: Partial<MySqlSingleColumnUniqueIndexColumn>,
): MySqlSingleColumnUniqueIndexColumn {
  return {
    indexName: 'PRIMARY',
    columnName: 'id',
    nativeType: 'int',
    isPrimaryKey: true,
    isNullable: false,
    isAutoIncrement: true,
    ordinalPosition: 1,
    ...overrides,
  };
}

const AUTO_INCREMENT_ID_COLUMN = buildCatalogColumn({
  columnName: 'id',
  dataType: 'int',
  columnType: 'int unsigned',
  extra: 'auto_increment',
  columnKey: 'PRI',
  ordinalPosition: 1,
});

function buildSpecInput(overrides: Partial<BuildMySqlJsonTableSpecInput>): BuildMySqlJsonTableSpecInput {
  return {
    entityId: { wsId: 'shop__orders', remoteId: ['shop', 'orders'] },
    table: { databaseName: 'shop', tableName: 'orders' },
    columns: [AUTO_INCREMENT_ID_COLUMN],
    primaryKeyColumnNames: ['id'],
    singleColumnUniqueIndexColumns: [buildUniqueIndexColumn({})],
    foreignKeys: [],
    mariaDbJsonAliasColumnNames: new Set(),
    ...overrides,
  };
}

function specProperties(schema: TSchema): Record<string, TSchema & Record<string, unknown>> {
  return (schema as TSchema & { properties: Record<string, TSchema & Record<string, unknown>> }).properties;
}

function requiredColumnNames(schema: TSchema): string[] {
  return (schema as TSchema & { required?: string[] }).required ?? [];
}

describe('buildMySqlJsonTableSpec', () => {
  it('builds the table-level fields ($id, basePath, title/slug paths, generatedAt)', () => {
    const tableSpec = buildMySqlJsonTableSpec(
      buildSpecInput({
        table: { databaseName: 'my.db', tableName: 'Company.io Deals' },
        columns: [
          AUTO_INCREMENT_ID_COLUMN,
          buildCatalogColumn({ columnName: 'name', ordinalPosition: 2 }),
          buildCatalogColumn({ columnName: 'slug', ordinalPosition: 3 }),
        ],
      }),
    );
    expect(tableSpec.id).toEqual({ wsId: 'shop__orders', remoteId: ['shop', 'orders'] });
    expect(tableSpec.name).toBe('Company.io Deals');
    expect(tableSpec.slug).toBe('Company.io Deals');
    expect((tableSpec.schema as TSchema & { $id?: string }).$id).toBe('mysql/my.db.Company.io Deals');
    expect((tableSpec.schema as TSchema & { title?: string }).title).toBe('Company.io Deals');
    expect(tableSpec.basePath).toEqual(['my.db']);
    expect(tableSpec.idPath).toBe('id');
    expect(tableSpec.idPathRequiresUserSelection).toBeUndefined();
    expect(tableSpec.titlePath).toBe('name');
    expect(tableSpec.slugPath).toBe('slug');
    expect(Number.isNaN(Date.parse(tableSpec.generatedAt ?? ''))).toBe(false);
  });

  describe('id choice', () => {
    it('prefers the single-column primary key', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [
            buildCatalogColumn({ columnName: 'code', ordinalPosition: 1 }),
            buildCatalogColumn({ columnName: 'uuid', dataType: 'char', columnType: 'char(36)', ordinalPosition: 2 }),
          ],
          primaryKeyColumnNames: ['uuid'],
          singleColumnUniqueIndexColumns: [
            buildUniqueIndexColumn({ indexName: 'code', columnName: 'code', isPrimaryKey: false, ordinalPosition: 1 }),
            buildUniqueIndexColumn({ columnName: 'uuid', isAutoIncrement: false, ordinalPosition: 2 }),
          ],
        }),
      );
      expect(tableSpec.idPath).toBe('uuid');
    });

    it('then an AUTO_INCREMENT unique column', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [buildCatalogColumn({ columnName: 'email' }), buildCatalogColumn({ columnName: 'serial' })],
          primaryKeyColumnNames: ['tenant', 'email'],
          singleColumnUniqueIndexColumns: [
            buildUniqueIndexColumn({
              indexName: 'email',
              columnName: 'email',
              isPrimaryKey: false,
              isAutoIncrement: false,
              ordinalPosition: 1,
            }),
            buildUniqueIndexColumn({
              indexName: 'serial',
              columnName: 'serial',
              isPrimaryKey: false,
              ordinalPosition: 2,
            }),
          ],
        }),
      );
      expect(tableSpec.idPath).toBe('serial');
    });

    it('then a NOT NULL unique column over a nullable one', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [buildCatalogColumn({ columnName: 'other' }), buildCatalogColumn({ columnName: 'email' })],
          primaryKeyColumnNames: [],
          singleColumnUniqueIndexColumns: [
            buildUniqueIndexColumn({
              indexName: 'other',
              columnName: 'other',
              isPrimaryKey: false,
              isAutoIncrement: false,
              isNullable: true,
              ordinalPosition: 1,
            }),
            buildUniqueIndexColumn({
              indexName: 'email',
              columnName: 'email',
              isPrimaryKey: false,
              isAutoIncrement: false,
              ordinalPosition: 2,
            }),
          ],
        }),
      );
      expect(tableSpec.idPath).toBe('email');
    });

    it('then the first (nullable) unique column', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [buildCatalogColumn({ columnName: 'other', isNullable: true })],
          primaryKeyColumnNames: [],
          singleColumnUniqueIndexColumns: [
            buildUniqueIndexColumn({
              indexName: 'other',
              columnName: 'other',
              isPrimaryKey: false,
              isAutoIncrement: false,
              isNullable: true,
            }),
          ],
        }),
      );
      expect(tableSpec.idPath).toBe('other');
      expect(tableSpec.idPathRequiresUserSelection).toBeUndefined();
    });

    it('flags idPathRequiresUserSelection when only a composite primary key exists', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [buildCatalogColumn({ columnName: 'a' }), buildCatalogColumn({ columnName: 'b' })],
          primaryKeyColumnNames: ['a', 'b'],
          singleColumnUniqueIndexColumns: [],
        }),
      );
      expect(tableSpec.idPath).toBe('a');
      expect(tableSpec.idPathRequiresUserSelection).toBe(true);
    });

    it('marks the chosen id column read-only even when it is not AUTO_INCREMENT (an edited id addresses another row)', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [
            buildCatalogColumn({ columnName: 'sku', dataType: 'varchar', columnType: 'varchar(10)', columnKey: 'PRI' }),
            buildCatalogColumn({ columnName: 'name', ordinalPosition: 2 }),
          ],
          primaryKeyColumnNames: ['sku'],
          singleColumnUniqueIndexColumns: [
            buildUniqueIndexColumn({ columnName: 'sku', nativeType: 'varchar(10)', isAutoIncrement: false }),
          ],
        }),
      );
      expect(tableSpec.idPath).toBe('sku');
      expect(specProperties(tableSpec.schema).sku[X_SCRATCH_READONLY]).toBe(true);
      expect(specProperties(tableSpec.schema).name[X_SCRATCH_READONLY]).toBeUndefined();
    });

    it('does not mark a fallback idPath read-only (the user picks the real id column)', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [buildCatalogColumn({ columnName: 'a' }), buildCatalogColumn({ columnName: 'b' })],
          primaryKeyColumnNames: ['a', 'b'],
          singleColumnUniqueIndexColumns: [],
        }),
      );
      expect(tableSpec.idPathRequiresUserSelection).toBe(true);
      expect(specProperties(tableSpec.schema).a[X_SCRATCH_READONLY]).toBeUndefined();
    });

    it('never addresses rows by a FLOAT key: another unique column wins, or the user must choose', () => {
      const floatKeyColumn = buildCatalogColumn({
        columnName: 'measurement',
        dataType: 'float',
        columnType: 'float',
        characterSetName: null,
        collationName: null,
      });
      const floatPrimaryKeyIndexColumn = buildUniqueIndexColumn({
        columnName: 'measurement',
        nativeType: 'float',
        isAutoIncrement: false,
      });

      const onlyFloatKeySpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [floatKeyColumn],
          primaryKeyColumnNames: ['measurement'],
          singleColumnUniqueIndexColumns: [floatPrimaryKeyIndexColumn],
        }),
      );
      expect(onlyFloatKeySpec.idPath).toBe('measurement');
      expect(onlyFloatKeySpec.idPathRequiresUserSelection).toBe(true);

      const floatKeyWithUniqueCodeSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [floatKeyColumn, buildCatalogColumn({ columnName: 'code', ordinalPosition: 2 })],
          primaryKeyColumnNames: ['measurement'],
          singleColumnUniqueIndexColumns: [
            floatPrimaryKeyIndexColumn,
            buildUniqueIndexColumn({
              indexName: 'code',
              columnName: 'code',
              nativeType: 'varchar(255)',
              isPrimaryKey: false,
              isAutoIncrement: false,
              ordinalPosition: 2,
            }),
          ],
        }),
      );
      expect(floatKeyWithUniqueCodeSpec.idPath).toBe('code');
      expect(floatKeyWithUniqueCodeSpec.idPathRequiresUserSelection).toBeUndefined();
    });

    it("falls back to 'id' (flagged) when there is no key at all", () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [buildCatalogColumn({ columnName: 'email' })],
          primaryKeyColumnNames: [],
          singleColumnUniqueIndexColumns: [],
        }),
      );
      expect(tableSpec.idPath).toBe('id');
      expect(tableSpec.idPathRequiresUserSelection).toBe(true);
    });
  });

  describe('invisible columns', () => {
    it('keeps an invisible id (GIPK my_row_id) and drops other invisible columns', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [
            buildCatalogColumn({
              columnName: 'my_row_id',
              dataType: 'bigint',
              columnType: 'bigint unsigned',
              extra: 'auto_increment INVISIBLE',
            }),
            buildCatalogColumn({ columnName: 'name', ordinalPosition: 2 }),
            buildCatalogColumn({ columnName: 'hidden_note', extra: 'INVISIBLE', isNullable: true, ordinalPosition: 3 }),
          ],
          primaryKeyColumnNames: ['my_row_id'],
          singleColumnUniqueIndexColumns: [
            buildUniqueIndexColumn({ columnName: 'my_row_id', nativeType: 'bigint unsigned' }),
          ],
        }),
      );
      expect(tableSpec.idPath).toBe('my_row_id');
      expect(Object.keys(specProperties(tableSpec.schema))).toEqual(['my_row_id', 'name']);
      expect(specProperties(tableSpec.schema).my_row_id[X_SCRATCH_READONLY]).toBe(true);
      expect(specProperties(tableSpec.schema).my_row_id[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(
        PostgresColumnType.NUMERIC_STRING,
      );
    });
  });

  describe('column annotations', () => {
    const annotatedTableSpec = buildMySqlJsonTableSpec(
      buildSpecInput({
        columns: [
          AUTO_INCREMENT_ID_COLUMN,
          buildCatalogColumn({
            columnName: 'code',
            dataType: 'char',
            columnType: 'char(3)',
            characterMaximumLength: 3,
          }),
          buildCatalogColumn({
            columnName: 'Featured?',
            dataType: 'varchar',
            columnType: 'varchar(10)',
            characterMaximumLength: 10,
            isNullable: true,
          }),
          buildCatalogColumn({
            columnName: 'body',
            dataType: 'text',
            columnType: 'text',
            characterMaximumLength: 65535,
            isNullable: true,
          }),
          buildCatalogColumn({
            columnName: 'status',
            dataType: 'enum',
            columnType: "enum('lead','won')",
            columnDefault: 'lead',
          }),
          buildCatalogColumn({
            columnName: 'total',
            dataType: 'decimal',
            columnType: 'decimal(10,2)',
            isNullable: true,
          }),
          buildCatalogColumn({
            columnName: 'created_at',
            dataType: 'datetime',
            columnType: 'datetime',
            columnDefault: 'CURRENT_TIMESTAMP',
            extra: 'DEFAULT_GENERATED',
          }),
          buildCatalogColumn({
            columnName: 'total_x2',
            dataType: 'decimal',
            columnType: 'decimal(11,2)',
            isNullable: true,
            extra: 'VIRTUAL GENERATED',
          }),
          buildCatalogColumn({ columnName: 'photo', dataType: 'blob', columnType: 'blob', isNullable: true }),
          buildCatalogColumn({ columnName: 'customer_id', dataType: 'int', columnType: 'int', isNullable: true }),
          buildCatalogColumn({ columnName: 'a.b', dataType: 'int', columnType: 'int', isNullable: true }),
          buildCatalogColumn({ columnName: 'locked', dataType: 'int', columnType: 'int', privileges: 'select' }),
          buildCatalogColumn({ columnName: 'required_note' }),
        ],
        foreignKeys: [
          {
            constraintName: 'orders_customer_fk',
            columnName: 'customer_id',
            referencedDatabaseName: 'crm.eu',
            referencedTableName: 'customers',
            referencedColumnName: 'id',
          },
        ],
      }),
    );
    const annotatedProperties = specProperties(annotatedTableSpec.schema);

    it('annotates the family and the exact native type', () => {
      expect(annotatedProperties.total[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.NUMERIC_STRING);
      expect(annotatedProperties.total[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: 'decimal(10,2)',
        isRecreatableVerbatim: true,
      });
      expect(annotatedProperties.status[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: "enum('lead','won')",
        isRecreatableVerbatim: false,
      });
      expect(annotatedProperties.photo[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: 'blob',
        isRecreatableVerbatim: false,
      });
    });

    it('adds a max length for CHAR/VARCHAR only', () => {
      expect(annotatedProperties.code[X_SCRATCH_MAX_LENGTH]).toBe(3);
      expect(annotatedProperties['Featured?'][X_SCRATCH_MAX_LENGTH]).toBe(10);
      expect(annotatedProperties.body[X_SCRATCH_MAX_LENGTH]).toBeUndefined();
    });

    it('marks AUTO_INCREMENT, generated, non-updatable and non-writable-representation columns read-only', () => {
      expect(annotatedProperties.id[X_SCRATCH_READONLY]).toBe(true);
      expect(annotatedProperties.total_x2[X_SCRATCH_READONLY]).toBe(true);
      expect(annotatedProperties.locked[X_SCRATCH_READONLY]).toBe(true);
      expect(annotatedProperties.photo[X_SCRATCH_READONLY]).toBe(true);
      expect(annotatedProperties.photo[X_SCRATCH_AGENT_INSTRUCTIONS]).toMatch(/base64/);
      // DEFAULT CURRENT_TIMESTAMP stays writable.
      expect(annotatedProperties.created_at[X_SCRATCH_READONLY]).toBeUndefined();
      expect(annotatedProperties.code[X_SCRATCH_READONLY]).toBeUndefined();
    });

    it('names a foreign-key target both as db.table and as the [db, table] remote id', () => {
      expect(annotatedProperties.customer_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'crm.eu.customers',
        linkedTableRemoteId: ['crm.eu', 'customers'],
      });
      expect(annotatedProperties.total[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
    });

    it('requires only NOT NULL columns without a default that the server does not fill', () => {
      expect(requiredColumnNames(annotatedTableSpec.schema).sort()).toEqual(['code', 'locked', 'required_note']);
    });

    it('wraps nullable columns so a present null validates, keeping the enum union intact', () => {
      expect(Value.Check(annotatedProperties['Featured?'], null)).toBe(true);
      expect(Value.Check(annotatedProperties.code, null)).toBe(false);
      expect(Value.Check(annotatedProperties.total, '12.50')).toBe(true);
      expect(Value.Check(annotatedProperties.status, 'won')).toBe(true);
      expect(Value.Check(annotatedProperties.status, 'lost')).toBe(false);
    });

    it('keeps column names verbatim', () => {
      expect(Object.keys(annotatedProperties)).toEqual(expect.arrayContaining(['Featured?', 'a.b']));
    });

    it('validates a whole pulled record', () => {
      // (created_at is left out: TypeBox's Value.Check rejects formats it has no registered checker for.)
      expect(
        Value.Check(annotatedTableSpec.schema, {
          id: 7,
          code: 'abc',
          'Featured?': null,
          body: 'hello',
          status: 'lead',
          total: '12.50',
          total_x2: '25.00',
          photo: 'AAEC',
          customer_id: 3,
          'a.b': null,
          locked: 1,
          required_note: 'x',
        }),
      ).toBe(true);
    });
  });

  describe('character sets', () => {
    const characterSetTableSpec = buildMySqlJsonTableSpec(
      buildSpecInput({
        columns: [
          AUTO_INCREMENT_ID_COLUMN,
          // A binary-charset ENUM / SET (e.g. from a DEFAULT CHARSET=binary table): MySQL reports NULL, MariaDB 'binary'.
          buildCatalogColumn({
            columnName: 'binary_enum',
            dataType: 'enum',
            columnType: "enum('p','q')",
            isNullable: true,
            characterSetName: null,
            collationName: null,
          }),
          buildCatalogColumn({
            columnName: 'binary_set',
            dataType: 'set',
            columnType: "set('m','n')",
            isNullable: true,
            characterSetName: 'binary',
            collationName: 'binary',
          }),
          buildCatalogColumn({
            columnName: 'legacy_name',
            dataType: 'varchar',
            columnType: 'varchar(255)',
            characterMaximumLength: 255,
            isNullable: true,
            characterSetName: 'latin1',
            collationName: 'latin1_swedish_ci',
          }),
          buildCatalogColumn({
            columnName: 'modern_name',
            dataType: 'varchar',
            columnType: 'varchar(255)',
            characterMaximumLength: 255,
            isNullable: true,
          }),
        ],
      }),
    );
    const characterSetProperties = specProperties(characterSetTableSpec.schema);

    it('types a binary-charset ENUM / SET as the base64 string the decoder pulls, read-only and never recreated', () => {
      for (const [columnName, columnType] of [
        ['binary_enum', "enum('p','q')"],
        ['binary_set', "set('m','n')"],
      ]) {
        const binaryColumnSchema = characterSetProperties[columnName];
        expect(binaryColumnSchema[X_SCRATCH_READONLY]).toBe(true);
        expect(binaryColumnSchema[X_SCRATCH_AGENT_INSTRUCTIONS]).toMatch(/base64/);
        expect(binaryColumnSchema[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
          typeSystem: 'mysql',
          type: `${columnType} character set binary`,
          isRecreatableVerbatim: false,
        });
      }
      // The decoder's base64 of member 'q' and of 'm,n' validate; the raw member text is not what is pulled.
      expect(Value.Check(characterSetProperties.binary_enum, 'cQ==')).toBe(true);
      expect(Value.Check(characterSetProperties.binary_set, 'bSxu')).toBe(true);
      expect(Value.Check(characterSetProperties.binary_enum, null)).toBe(true);
    });

    it("doesn't recreate a latin1 VARCHAR verbatim (a utf8mb4 copy reserves 4x the row width)", () => {
      expect(characterSetProperties.legacy_name[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: 'varchar(255)',
        isRecreatableVerbatim: false,
      });
      expect(characterSetProperties.legacy_name[X_SCRATCH_READONLY]).toBeUndefined();
      expect(characterSetProperties.modern_name[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: 'varchar(255)',
        isRecreatableVerbatim: true,
      });
    });
  });

  describe('MariaDB JSON columns', () => {
    it('types a flagged longtext as JSONB with the recreatable native type json', () => {
      const tableSpec = buildMySqlJsonTableSpec(
        buildSpecInput({
          columns: [
            AUTO_INCREMENT_ID_COLUMN,
            buildCatalogColumn({
              columnName: 'attributes',
              dataType: 'longtext',
              columnType: 'longtext',
              isNullable: true,
              collationName: 'utf8mb4_bin',
            }),
            buildCatalogColumn({
              columnName: 'short_json',
              dataType: 'varchar',
              columnType: 'varchar(100)',
              characterMaximumLength: 100,
              isNullable: true,
            }),
            buildCatalogColumn({ columnName: 'notes', dataType: 'longtext', columnType: 'longtext', isNullable: true }),
          ],
          mariaDbJsonAliasColumnNames: new Set(['attributes', 'short_json']),
        }),
      );
      const properties = specProperties(tableSpec.schema);
      expect(properties.attributes[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.JSONB);
      expect(properties.attributes[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: 'json',
        isRecreatableVerbatim: true,
      });
      expect(properties.attributes[X_SCRATCH_READONLY]).toBeUndefined();
      expect(Value.Check(properties.attributes, { a: [1, 2] })).toBe(true);
      // A JSON document isn't a string, so a VARCHAR's max length no longer describes it.
      expect(properties.short_json[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.JSONB);
      expect(properties.short_json[X_SCRATCH_MAX_LENGTH]).toBeUndefined();
      expect(properties.notes[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.TEXT);
    });
  });
});

describe('buildMySqlTablePreview', () => {
  const ORDERS_TABLE_ROW: MySqlTableRow = {
    databaseName: 'shop',
    tableName: 'orders',
    tableType: 'BASE TABLE',
    storageEngine: 'InnoDB',
  };
  const ORDERS_LOOKUP_KEY = buildMySqlTableLookupKey('shop', 'orders');

  function previewWithLookups(
    tableRow: MySqlTableRow,
    lookups: { hasSingleColumnUniqueIndex: boolean; hasAutoIncrementPrimaryKey: boolean },
  ) {
    const tableLookupKey = buildMySqlTableLookupKey(tableRow.databaseName, tableRow.tableName);
    return buildMySqlTablePreview(tableRow, {
      tablesWithSingleColumnUniqueIndex: new Set(lookups.hasSingleColumnUniqueIndex ? [tableLookupKey] : []),
      tablesWithAutoIncrementPrimaryKey: new Set(lookups.hasAutoIncrementPrimaryKey ? [tableLookupKey] : []),
    });
  }

  it('describes the table identity: [db, table] remote id, sanitized wsId, database as parent path', () => {
    const tablePreview = buildMySqlTablePreview(ORDERS_TABLE_ROW, {
      tablesWithSingleColumnUniqueIndex: new Set([ORDERS_LOOKUP_KEY]),
      tablesWithAutoIncrementPrimaryKey: new Set([ORDERS_LOOKUP_KEY]),
    });
    expect(tablePreview).toEqual({
      id: { wsId: 'shop__orders', remoteId: ['shop', 'orders'] },
      displayName: 'orders',
      parentPath: 'shop',
      metadata: {
        database: 'shop',
        tableType: 'BASE TABLE',
        storageEngine: 'InnoDB',
        description: 'Table "orders" in database "shop"',
      },
    });
  });

  it('sanitizes dots, spaces and case in the wsId but keeps the verbatim remote id', () => {
    const tablePreview = previewWithLookups(
      { ...ORDERS_TABLE_ROW, databaseName: 'My.DB', tableName: 'Company.io Deals' },
      { hasSingleColumnUniqueIndex: true, hasAutoIncrementPrimaryKey: true },
    );
    expect(tablePreview.id).toEqual({ wsId: 'my_db__company_io_deals', remoteId: ['My.DB', 'Company.io Deals'] });
    expect(tablePreview.displayName).toBe('Company.io Deals');
    expect(tablePreview.parentPath).toBe('My.DB');
  });

  it('disables views first, even when a lookup claims a unique index', () => {
    const tablePreview = previewWithLookups(
      { ...ORDERS_TABLE_ROW, tableType: 'VIEW', storageEngine: null },
      { hasSingleColumnUniqueIndex: true, hasAutoIncrementPrimaryKey: true },
    );
    expect(tablePreview.disabled).toBe(true);
    expect(tablePreview.disabledReason).toBe(MYSQL_VIEW_DISABLED_REASON);
    expect(tablePreview.metadata?.description).toBe('View "orders" in database "shop"');
  });

  it('disables a table without a single-column unique index, with the Postgres wording', () => {
    const tablePreview = previewWithLookups(ORDERS_TABLE_ROW, {
      hasSingleColumnUniqueIndex: false,
      hasAutoIncrementPrimaryKey: false,
    });
    expect(tablePreview.disabled).toBe(true);
    expect(tablePreview.disabledReason).toBe(MYSQL_TABLE_WITHOUT_SINGLE_COLUMN_UNIQUE_KEY_DISABLED_REASON);
    expect(MYSQL_TABLE_WITHOUT_SINGLE_COLUMN_UNIQUE_KEY_DISABLED_REASON).toBe(
      "This table has no single-column unique key (a primary key or unique index on one column), so its rows can't be uniquely identified.",
    );
  });

  it('makes a non-InnoDB table read-only (all writes disabled)', () => {
    const tablePreview = previewWithLookups(
      { ...ORDERS_TABLE_ROW, storageEngine: 'MyISAM' },
      { hasSingleColumnUniqueIndex: true, hasAutoIncrementPrimaryKey: true },
    );
    expect(tablePreview.disabled).toBeUndefined();
    expect(tablePreview.disabledCreates).toBe(true);
    expect(tablePreview.disabledUpdates).toBe(true);
    expect(tablePreview.disabledDeletes).toBe(true);
    expect(tablePreview.disabledReason).toMatch(/MyISAM storage engine/);
  });

  it('disables only creates when the primary key is not AUTO_INCREMENT', () => {
    const tablePreview = previewWithLookups(ORDERS_TABLE_ROW, {
      hasSingleColumnUniqueIndex: true,
      hasAutoIncrementPrimaryKey: false,
    });
    expect(tablePreview.disabled).toBeUndefined();
    expect(tablePreview.disabledCreates).toBe(true);
    expect(tablePreview.disabledUpdates).toBeUndefined();
    expect(tablePreview.disabledDeletes).toBeUndefined();
    expect(tablePreview.disabledReason).toBe(TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON);
  });

  it('enables every operation on an InnoDB table (incl. MariaDB SYSTEM VERSIONED) with an AUTO_INCREMENT key', () => {
    const tablePreview = previewWithLookups(
      { ...ORDERS_TABLE_ROW, tableType: 'SYSTEM VERSIONED' },
      { hasSingleColumnUniqueIndex: true, hasAutoIncrementPrimaryKey: true },
    );
    expect(tablePreview.disabled).toBeUndefined();
    expect(tablePreview.disabledCreates).toBeUndefined();
    expect(tablePreview.disabledReason).toBeUndefined();
  });

  it('does not confuse db a.b + table c with db a + table b.c', () => {
    const tablePreview = buildMySqlTablePreview(
      { ...ORDERS_TABLE_ROW, databaseName: 'a', tableName: 'b.c' },
      {
        tablesWithSingleColumnUniqueIndex: new Set([buildMySqlTableLookupKey('a.b', 'c')]),
        tablesWithAutoIncrementPrimaryKey: new Set([buildMySqlTableLookupKey('a.b', 'c')]),
      },
    );
    expect(tablePreview.disabled).toBe(true);
  });
});
