import {
  buildDatabaseScopeSqlFragment,
  buildMySqlTableLookupKey,
  normalizeMySqlCatalogColumnRow,
  parseNullableCatalogInteger,
} from '../mysql-catalog';
import { MYSQL_SYSTEM_DATABASE_NAMES } from '../mysql-catalog-types';

describe('parseNullableCatalogInteger', () => {
  it.each([
    ['a number', 255, 255],
    ['a BIGINT rendered as a string (bigNumberStrings)', '255', 255],
    ['a longtext maximum length', '4294967295', 4294967295],
    ['a negative string', '-3', -3],
    ['a padded string', ' 12 ', 12],
    ['a bigint', 16n, 16],
    ['a Buffer holding digits', Buffer.from('64'), 64],
    ['null', null, null],
    ['undefined', undefined, null],
    ['an empty string', '', null],
    ['non-integer text', '12abc', null],
    ['a decimal string', '1.5', null],
    ['NaN', Number.NaN, null],
    ['an object', { value: 1 }, null],
  ])('parses %s', (_description, catalogValue, expectedInteger) => {
    expect(parseNullableCatalogInteger(catalogValue)).toBe(expectedInteger);
  });
});

describe('normalizeMySqlCatalogColumnRow', () => {
  it('normalizes a MySQL 8 row (catalog BIGINTs as strings)', () => {
    const catalogColumn = normalizeMySqlCatalogColumnRow({
      column_name: 'Featured?',
      data_type: 'VARCHAR',
      column_type: 'varchar(255)',
      is_nullable: 'YES',
      column_default: null,
      extra: '',
      generation_expression: '',
      privileges: 'select,insert,update,references',
      column_key: 'UNI',
      character_maximum_length: '255',
      numeric_precision: null,
      numeric_scale: null,
      datetime_precision: null,
      character_set_name: 'utf8mb4',
      collation_name: 'utf8mb4_0900_ai_ci',
      ordinal_position: '3',
    });
    expect(catalogColumn).toEqual({
      columnName: 'Featured?',
      dataType: 'varchar',
      columnType: 'varchar(255)',
      isNullable: true,
      columnDefault: null,
      extra: '',
      generationExpression: '',
      privileges: 'select,insert,update,references',
      columnKey: 'UNI',
      characterMaximumLength: 255,
      numericPrecision: null,
      numericScale: null,
      datetimePrecision: null,
      characterSetName: 'utf8mb4',
      collationName: 'utf8mb4_0900_ai_ci',
      ordinalPosition: 3,
    });
  });

  it("keeps COLUMN_TYPE and COLUMN_DEFAULT verbatim (enum case, MariaDB's quoted literals and 'NULL')", () => {
    const enumColumn = normalizeMySqlCatalogColumnRow({
      column_name: 'status',
      data_type: 'enum',
      column_type: "enum('Lead','It''s')",
      is_nullable: 'YES',
      column_default: 'NULL',
      extra: 'on update current_timestamp()',
      ordinal_position: 2,
    });
    expect(enumColumn.columnType).toBe("enum('Lead','It''s')");
    expect(enumColumn.columnDefault).toBe('NULL');
    expect(enumColumn.extra).toBe('on update current_timestamp()');
    expect(enumColumn.ordinalPosition).toBe(2);
  });

  it('treats missing optional catalog fields as empty / null and decodes Buffers', () => {
    const catalogColumn = normalizeMySqlCatalogColumnRow({
      column_name: Buffer.from('id'),
      data_type: 'int',
      column_type: 'int',
      is_nullable: 'NO',
    });
    expect(catalogColumn.columnName).toBe('id');
    expect(catalogColumn.isNullable).toBe(false);
    expect(catalogColumn.extra).toBe('');
    expect(catalogColumn.privileges).toBe('');
    expect(catalogColumn.generationExpression).toBeNull();
    expect(catalogColumn.characterMaximumLength).toBeNull();
    expect(catalogColumn.ordinalPosition).toBe(0);
  });
});

describe('buildDatabaseScopeSqlFragment', () => {
  it('excludes the system databases case-insensitively and binds lower-cased names', () => {
    const databaseScope = buildDatabaseScopeSqlFragment(
      { excludedDatabaseNames: ['information_schema', 'METRICS_SCHEMA'] },
      'TABLE_SCHEMA',
    );
    expect(databaseScope).toEqual({
      sql: 'LOWER(TABLE_SCHEMA) NOT IN (?, ?)',
      bindings: ['information_schema', 'metrics_schema'],
    });
  });

  it('adds the configured database after the exclusions', () => {
    const databaseScope = buildDatabaseScopeSqlFragment(
      { excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES, onlyDatabaseName: 'Shop.DB' },
      'c.TABLE_SCHEMA',
    );
    expect(databaseScope.sql).toBe(
      `LOWER(c.TABLE_SCHEMA) NOT IN (${MYSQL_SYSTEM_DATABASE_NAMES.map(() => '?').join(', ')}) AND c.TABLE_SCHEMA = ?`,
    );
    expect(databaseScope.bindings).toEqual([...MYSQL_SYSTEM_DATABASE_NAMES, 'Shop.DB']);
  });

  it('omits the NOT IN clause for an empty exclusion list (NOT IN () is a syntax error)', () => {
    expect(
      buildDatabaseScopeSqlFragment({ excludedDatabaseNames: [], onlyDatabaseName: 'app' }, 'SCHEMA_NAME'),
    ).toEqual({ sql: 'SCHEMA_NAME = ?', bindings: ['app'] });
  });

  it('yields an always-true condition when the scope has neither part', () => {
    expect(buildDatabaseScopeSqlFragment({ excludedDatabaseNames: [] }, 'SCHEMA_NAME')).toEqual({
      sql: '1 = 1',
      bindings: [],
    });
  });

  it('keeps the placeholder count equal to the binding count', () => {
    const databaseScope = buildDatabaseScopeSqlFragment(
      { excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES, onlyDatabaseName: 'app' },
      'TABLE_SCHEMA',
    );
    expect(databaseScope.sql.split('?').length - 1).toBe(databaseScope.bindings.length);
  });

  it.each(['TABLE_SCHEMA; DROP TABLE x', 'LOWER(TABLE_SCHEMA)', '`TABLE_SCHEMA`', 'a.b.c', ''])(
    'refuses a column reference that is not a plain identifier: %p',
    (columnReference) => {
      expect(() => buildDatabaseScopeSqlFragment({ excludedDatabaseNames: [] }, columnReference)).toThrow(
        /Invalid catalog column reference/,
      );
    },
  );
});

describe('buildMySqlTableLookupKey', () => {
  it('does not collide when names contain dots', () => {
    expect(buildMySqlTableLookupKey('a.b', 'c')).not.toBe(buildMySqlTableLookupKey('a', 'b.c'));
  });

  it('is stable for the same pair', () => {
    expect(buildMySqlTableLookupKey('shop', 'orders')).toBe(buildMySqlTableLookupKey('shop', 'orders'));
    expect(buildMySqlTableLookupKey('shop', 'orders')).toBe('["shop","orders"]');
  });
});
