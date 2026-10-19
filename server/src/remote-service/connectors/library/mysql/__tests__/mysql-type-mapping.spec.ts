import { type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT, PostgresColumnType } from '@spinner/shared-types';
import { type MySqlCatalogColumn } from '../mysql-catalog-types';
import {
  columnValueMayBeOmittedOnInsert,
  isMySqlAutoIncrementColumn,
  isMySqlGeneratedColumn,
  isMySqlInvisibleColumn,
  isMySqlReadOnlyColumn,
  mapMySqlColumnType,
  parseMySqlEnumOrSetMembers,
  pickMySqlTitleColumnPath,
} from '../mysql-type-mapping';

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
    // The default column is a VARCHAR, and every text column (ENUM / SET included) reports its charset; only a
    // binary-charset ENUM / SET reports NULL on MySQL (covered explicitly below).
    characterSetName: 'utf8mb4',
    collationName: 'utf8mb4_0900_ai_ci',
    ordinalPosition: 1,
    ...overrides,
  };
}

const NOT_A_MARIADB_JSON_ALIAS = { isMariaDbJsonAlias: false };

function mapColumnTypeSpelling(dataType: string, columnType: string, overrides: Partial<MySqlCatalogColumn> = {}) {
  return mapMySqlColumnType(buildCatalogColumn({ dataType, columnType, ...overrides }), NOT_A_MARIADB_JSON_ALIAS);
}

/** The JSON Schema TypeBox serializes to, without TypeBox's internal symbols. */
function serializedJsonSchema(schema: TSchema): unknown {
  return JSON.parse(JSON.stringify(schema)) as unknown;
}

describe('mapMySqlColumnType', () => {
  describe('numbers', () => {
    it.each([
      ['tinyint', 'tinyint'],
      ['tinyint', 'tinyint(1)'],
      ['smallint', 'smallint unsigned'],
      ['mediumint', 'mediumint'],
      ['int', 'int unsigned'],
      ['int', 'int(11)'],
      ['year', 'year'],
      ['float', 'float'],
      ['double', 'double'],
    ])('%s (%s) → Number / NUMERIC', (dataType, columnType) => {
      const columnTypeMapping = mapColumnTypeSpelling(dataType, columnType);
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'number' });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.NUMERIC);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(false);
    });

    it.each([
      ['bigint', 'bigint'],
      ['bigint', 'bigint unsigned'],
      ['bigint', 'bigint(20) unsigned'],
      ['decimal', 'decimal(10,2)'],
      ['decimal', 'decimal(65,30) unsigned zerofill'],
    ])('%s (%s) → verbatim string (string ∪ number) / NUMERIC_STRING', (dataType, columnType) => {
      const columnTypeMapping = mapColumnTypeSpelling(dataType, columnType);
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({
        anyOf: [{ type: 'string' }, { type: 'number' }],
      });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.NUMERIC_STRING);
      expect(Value.Check(columnTypeMapping.valueSchema, '9007199254740993')).toBe(true);
    });

    it('BIT(n ≤ 53) is a number and read-only', () => {
      const columnTypeMapping = mapColumnTypeSpelling('bit', 'bit(1)', { numericPrecision: 1 });
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'number' });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.NUMERIC);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(true);
      expect(columnTypeMapping.agentInstructions).toMatch(/BIT column/);
    });

    it('BIT(64) is a decimal string and read-only', () => {
      const columnTypeMapping = mapColumnTypeSpelling('bit', 'bit(64)', { numericPrecision: 64 });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.NUMERIC_STRING);
      expect(Value.Check(columnTypeMapping.valueSchema, '18446744073709551615')).toBe(true);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(true);
    });

    it('BIT without a width in COLUMN_TYPE falls back to NUMERIC_PRECISION', () => {
      expect(mapColumnTypeSpelling('bit', 'bit', { numericPrecision: 60 }).columnFamily).toBe(
        PostgresColumnType.NUMERIC_STRING,
      );
      expect(mapColumnTypeSpelling('bit', 'bit').columnFamily).toBe(PostgresColumnType.NUMERIC);
    });
  });

  describe('text', () => {
    it.each([
      ['char', 'char(3)'],
      ['varchar', 'varchar(255)'],
      ['tinytext', 'tinytext'],
      ['text', 'text'],
      ['mediumtext', 'mediumtext'],
      ['longtext', 'longtext'],
      ['time', 'time(3)'],
      ['uuid', 'uuid'],
      ['inet4', 'inet4'],
      ['inet6', 'inet6'],
    ])('%s (%s) → String / TEXT, writable', (dataType, columnType) => {
      const columnTypeMapping = mapColumnTypeSpelling(dataType, columnType);
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'string' });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TEXT);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(false);
      expect(columnTypeMapping.agentInstructions).toBeUndefined();
    });

    it('ENUM → closed union of its members plus the empty-string error value', () => {
      const columnTypeMapping = mapColumnTypeSpelling('enum', "enum('lead','it''s','b\\\\c')");
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({
        anyOf: [
          { const: 'lead', type: 'string' },
          { const: "it's", type: 'string' },
          { const: 'b\\c', type: 'string' },
          { const: '', type: 'string' },
        ],
      });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TEXT);
      expect(Value.Check(columnTypeMapping.valueSchema, 'lead')).toBe(true);
      expect(Value.Check(columnTypeMapping.valueSchema, '')).toBe(true);
      expect(Value.Check(columnTypeMapping.valueSchema, 'Lead')).toBe(false);
    });

    it("doesn't duplicate an explicit '' member", () => {
      const columnTypeMapping = mapColumnTypeSpelling('enum', "enum('','a')");
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({
        anyOf: [
          { const: '', type: 'string' },
          { const: 'a', type: 'string' },
        ],
      });
    });

    it('falls back to a plain string for an unparsable ENUM', () => {
      const columnTypeMapping = mapColumnTypeSpelling('enum', "enum('broken");
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'string' });
    });

    it('SET → String with the member list in the agent instructions', () => {
      const columnTypeMapping = mapColumnTypeSpelling('set', "set('x','y z')");
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'string' });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TEXT);
      expect(columnTypeMapping.agentInstructions).toBe(
        'MySQL SET column: a comma-separated subset (no spaces) of: "x", "y z". Empty string = no members.',
      );
    });
  });

  describe('ENUM / SET declared CHARACTER SET binary', () => {
    it.each<[string, string, string | null]>([
      // MySQL 8.4 reports CHARACTER_SET_NAME NULL, MariaDB 11.4 'binary'.
      ['enum', "enum('p','q')", null],
      ['enum', "enum('p','q')", 'binary'],
      ['set', "set('m','n')", null],
      ['set', "set('m','n')", 'binary'],
    ])(
      '%s %s (charset %j) → base64 string, read-only (the decoder stores the bytes as base64)',
      (dataType, columnType, characterSetName) => {
        const columnTypeMapping = mapColumnTypeSpelling(dataType, columnType, {
          characterSetName,
          collationName: null,
        });
        expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({
          type: 'string',
          contentEncoding: 'base64',
        });
        expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TEXT);
        expect(columnTypeMapping.hasNonWritableRepresentation).toBe(true);
        expect(columnTypeMapping.agentInstructions).toMatch(/base64/);
        // What the row decoder pulls for member 'q' / 'm,n' validates.
        expect(Value.Check(columnTypeMapping.valueSchema, Buffer.from('q').toString('base64'))).toBe(true);
      },
    );

    it('makes the column read-only', () => {
      const binaryEnumColumn = buildCatalogColumn({
        dataType: 'enum',
        columnType: "enum('p','q')",
        characterSetName: null,
        collationName: null,
      });
      expect(
        isMySqlReadOnlyColumn(binaryEnumColumn, mapMySqlColumnType(binaryEnumColumn, NOT_A_MARIADB_JSON_ALIAS)),
      ).toBe(true);
    });

    it('leaves a text ENUM / SET (any real charset) as the member union / plain string, writable', () => {
      const latin1EnumMapping = mapColumnTypeSpelling('enum', "enum('p','q')", { characterSetName: 'latin1' });
      expect(Value.Check(latin1EnumMapping.valueSchema, 'q')).toBe(true);
      expect(latin1EnumMapping.hasNonWritableRepresentation).toBe(false);
      expect(mapColumnTypeSpelling('set', "set('m','n')").hasNonWritableRepresentation).toBe(false);
    });
  });

  describe('dates and times', () => {
    it('DATE → verbatim string with format date', () => {
      const columnTypeMapping = mapColumnTypeSpelling('date', 'date');
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'string', format: 'date' });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TIMESTAMP);
    });

    it('DATETIME → verbatim string with the non-asserting local date-time format', () => {
      const columnTypeMapping = mapColumnTypeSpelling('datetime', 'datetime(6)');
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({
        type: 'string',
        format: JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT,
      });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TIMESTAMP);
    });

    it('TIMESTAMP → RFC 3339 string with format date-time', () => {
      const columnTypeMapping = mapColumnTypeSpelling('timestamp', 'timestamp(3)');
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'string', format: 'date-time' });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TIMESTAMP);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(false);
    });
  });

  describe('JSON', () => {
    it('JSON → Unknown / JSONB, writable', () => {
      const columnTypeMapping = mapColumnTypeSpelling('json', 'json');
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({});
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.JSONB);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(false);
    });

    it('a MariaDB JSON column (reported as longtext) → JSONB, judged writable by its declared json type', () => {
      const mariaDbJsonColumn = buildCatalogColumn({ dataType: 'longtext', columnType: 'longtext' });
      const columnTypeMapping = mapMySqlColumnType(mariaDbJsonColumn, { isMariaDbJsonAlias: true });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.JSONB);
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({});
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(false);
      // The same longtext without the flag stays text.
      expect(mapMySqlColumnType(mariaDbJsonColumn, NOT_A_MARIADB_JSON_ALIAS).columnFamily).toBe(
        PostgresColumnType.TEXT,
      );
    });
  });

  describe('non-writable representations', () => {
    it.each([
      ['binary', 'binary(16)'],
      ['varbinary', 'varbinary(64)'],
      ['tinyblob', 'tinyblob'],
      ['blob', 'blob'],
      ['mediumblob', 'mediumblob'],
      ['longblob', 'longblob'],
    ])('%s (%s) → base64 string, read-only', (dataType, columnType) => {
      const columnTypeMapping = mapColumnTypeSpelling(dataType, columnType);
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({
        type: 'string',
        contentEncoding: 'base64',
      });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TEXT);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(true);
      expect(columnTypeMapping.agentInstructions).toMatch(/base64/);
    });

    it.each([
      'geometry',
      'point',
      'linestring',
      'polygon',
      'multipoint',
      'multilinestring',
      'multipolygon',
      'geometrycollection',
      'geomcollection',
    ])('spatial %s → base64 (SRID + WKB), read-only', (spatialType) => {
      const columnTypeMapping = mapColumnTypeSpelling(spatialType, spatialType);
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({
        type: 'string',
        contentEncoding: 'base64',
      });
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(true);
      expect(columnTypeMapping.agentInstructions).toMatch(/SRID/);
    });

    it('VECTOR → number[] / NUMERIC_ARRAY, read-only', () => {
      const columnTypeMapping = mapColumnTypeSpelling('vector', 'vector(3)');
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({ type: 'array', items: { type: 'number' } });
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.NUMERIC_ARRAY);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(true);
    });

    it('an unknown type → Unknown / TEXT, read-only', () => {
      const columnTypeMapping = mapColumnTypeSpelling('xml_thing', 'xml_thing');
      expect(serializedJsonSchema(columnTypeMapping.valueSchema)).toEqual({});
      expect(columnTypeMapping.columnFamily).toBe(PostgresColumnType.TEXT);
      expect(columnTypeMapping.hasNonWritableRepresentation).toBe(true);
    });
  });

  it('maps DATA_TYPE case-insensitively', () => {
    expect(mapColumnTypeSpelling('INT', 'int').columnFamily).toBe(PostgresColumnType.NUMERIC);
  });
});

describe('parseMySqlEnumOrSetMembers', () => {
  it.each([
    ["enum('a','b')", ['a', 'b']],
    ["set('x','y')", ['x', 'y']],
    ["ENUM('A','b')", ['A', 'b']],
    ["enum('it''s')", ["it's"]],
    ["enum('b\\\\c')", ['b\\c']],
    ["enum('nl\\nx','tab\tx','q\"x')", ['nl\nx', 'tab\tx', 'q"x']],
    ["enum('Q,x','')", ['Q,x', '']],
    ["enum('a)b')", ['a)b']],
  ])('parses %p', (columnType, expectedMembers) => {
    expect(parseMySqlEnumOrSetMembers(columnType)).toEqual(expectedMembers);
  });

  it.each(['varchar(10)', 'enum()', "enum('a'", "enum('a',)", "enum('a' 'b')", 'enum(a,b)', "enum('a','b"])(
    'rejects malformed %p',
    (columnType) => {
      expect(parseMySqlEnumOrSetMembers(columnType)).toBeUndefined();
    },
  );
});

describe('column predicates', () => {
  it.each([
    ['auto_increment', true],
    ['AUTO_INCREMENT', true],
    ['auto_increment INVISIBLE', true],
    ['DEFAULT_GENERATED', false],
    ['', false],
  ])('isMySqlAutoIncrementColumn(%p) = %p', (extra, expected) => {
    expect(isMySqlAutoIncrementColumn(buildCatalogColumn({ extra }))).toBe(expected);
  });

  it.each([
    ['VIRTUAL GENERATED', true],
    ['STORED GENERATED', true],
    ['PERSISTENT GENERATED', true],
    ['virtual generated', true],
    ['ROW START', true],
    ['ROW END INVISIBLE', true],
    ['DEFAULT_GENERATED', false],
    ['DEFAULT_GENERATED on update CURRENT_TIMESTAMP', false],
    ['on update current_timestamp()', false],
    ['auto_increment', false],
  ])('isMySqlGeneratedColumn(%p) = %p', (extra, expected) => {
    expect(isMySqlGeneratedColumn(buildCatalogColumn({ extra }))).toBe(expected);
  });

  it.each([
    ['INVISIBLE', true],
    ['auto_increment INVISIBLE', true],
    ['', false],
    ['VIRTUAL GENERATED', false],
  ])('isMySqlInvisibleColumn(%p) = %p', (extra, expected) => {
    expect(isMySqlInvisibleColumn(buildCatalogColumn({ extra }))).toBe(expected);
  });

  describe('isMySqlReadOnlyColumn', () => {
    const writableTextMapping = mapColumnTypeSpelling('varchar', 'varchar(10)');

    it.each([
      ['auto_increment', { extra: 'auto_increment' }],
      ['VIRTUAL GENERATED', { extra: 'VIRTUAL GENERATED' }],
      ['STORED GENERATED', { extra: 'STORED GENERATED' }],
      ['PERSISTENT GENERATED', { extra: 'PERSISTENT GENERATED' }],
      ['ROW START', { extra: 'ROW START' }],
      ['no update privilege', { privileges: 'select,insert,references' }],
    ])('is read-only for %s', (_description, overrides: Partial<MySqlCatalogColumn>) => {
      expect(isMySqlReadOnlyColumn(buildCatalogColumn(overrides), writableTextMapping)).toBe(true);
    });

    it('is read-only for a non-writable representation (binary)', () => {
      const binaryColumn = buildCatalogColumn({ dataType: 'varbinary', columnType: 'varbinary(16)' });
      expect(isMySqlReadOnlyColumn(binaryColumn, mapMySqlColumnType(binaryColumn, NOT_A_MARIADB_JSON_ALIAS))).toBe(
        true,
      );
    });

    it.each([
      ['DEFAULT CURRENT_TIMESTAMP', { extra: 'DEFAULT_GENERATED', columnDefault: 'CURRENT_TIMESTAMP' }],
      ['ON UPDATE CURRENT_TIMESTAMP', { extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' }],
      ["MariaDB's on update current_timestamp()", { extra: 'on update current_timestamp()' }],
      ['an expression default', { extra: 'DEFAULT_GENERATED', columnDefault: 'uuid()' }],
      ['a blank PRIVILEGES value (unknown, not "none")', { privileges: '' }],
      ['upper-case privileges', { privileges: 'SELECT,UPDATE' }],
    ])('stays writable with %s', (_description, overrides: Partial<MySqlCatalogColumn>) => {
      expect(isMySqlReadOnlyColumn(buildCatalogColumn(overrides), writableTextMapping)).toBe(false);
    });
  });

  describe('columnValueMayBeOmittedOnInsert', () => {
    it.each([
      ['nullable', { isNullable: true }, true],
      ['has a default', { columnDefault: "'draft'" }, true],
      ['MariaDB explicit DEFAULT NULL', { isNullable: true, columnDefault: 'NULL' }, true],
      ['auto_increment (COLUMN_DEFAULT is NULL)', { extra: 'auto_increment' }, true],
      ['generated (COLUMN_DEFAULT is NULL)', { extra: 'STORED GENERATED' }, true],
      ['NOT NULL without a default', {}, false],
    ])('%s → %p', (_description, overrides: Partial<MySqlCatalogColumn>, expected) => {
      expect(columnValueMayBeOmittedOnInsert(buildCatalogColumn(overrides))).toBe(expected);
    });
  });
});

describe('pickMySqlTitleColumnPath', () => {
  it('picks the first text column named like a title, in column order', () => {
    const catalogColumns = [
      buildCatalogColumn({ columnName: 'id', dataType: 'int', columnType: 'int' }),
      buildCatalogColumn({ columnName: 'title', dataType: 'varchar' }),
      buildCatalogColumn({ columnName: 'name', dataType: 'text', columnType: 'text' }),
    ];
    expect(pickMySqlTitleColumnPath(catalogColumns)).toBe('title');
  });

  it('skips a candidate name whose type is not text', () => {
    const catalogColumns = [
      buildCatalogColumn({ columnName: 'name', dataType: 'int', columnType: 'int' }),
      buildCatalogColumn({ columnName: 'label', dataType: 'char', columnType: 'char(10)' }),
    ];
    expect(pickMySqlTitleColumnPath(catalogColumns)).toBe('label');
  });

  it('returns undefined when nothing qualifies', () => {
    expect(pickMySqlTitleColumnPath([buildCatalogColumn({ columnName: 'email' })])).toBeUndefined();
    expect(pickMySqlTitleColumnPath([])).toBeUndefined();
  });
});
