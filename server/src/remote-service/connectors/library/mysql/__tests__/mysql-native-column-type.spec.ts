import { X_SCRATCH_NATIVE_COLUMN_TYPE } from '@spinner/shared-types';
import {
  buildMySqlNativeColumnTypeAnnotation,
  classifyMySqlTemporalColumnType,
  isMySqlBinaryCharacterSetEnumOrSetColumn,
  isMySqlBinaryCharacterSetEnumOrSetSpelling,
  isMySqlIntegerColumnType,
  isMySqlTextOrBlobOrJsonColumnType,
  isRecreatableMySqlNativeColumnType,
  MYSQL_BINARY_CHARACTER_SET_CLAUSE,
  MYSQL_NATIVE_TYPE_SYSTEM,
  mysqlColumnHasNonWritableRepresentation,
  readMySqlNativeColumnType,
  readMySqlNativeColumnTypeBaseName,
  resolveMySqlDeclaredColumnTypeSpelling,
} from '../mysql-native-column-type';

/** A column that is neither a MariaDB JSON alias nor character data (numbers, dates, JSON, BLOB, ...). */
const NON_CHARACTER_COLUMN_CONTEXT = { isMariaDbJsonAlias: false, characterSetName: null };
/** Character data in the character set every created table uses. */
const UTF8MB4_CHARACTER_COLUMN_CONTEXT = { isMariaDbJsonAlias: false, characterSetName: 'utf8mb4' };

describe('isRecreatableMySqlNativeColumnType', () => {
  it.each([
    // Integers, with MariaDB's display widths and unsigned.
    'tinyint',
    'tinyint(1)',
    'tinyint(1) unsigned',
    'smallint unsigned',
    'mediumint',
    'int',
    'int(11)',
    'int unsigned',
    'bigint',
    'bigint unsigned',
    'bigint(20) unsigned',
    // Fixed point, within MySQL's DECIMAL(65,30) bounds.
    'decimal',
    'decimal(10,2)',
    'decimal(10,2) unsigned',
    'decimal(65,30)',
    'decimal(10)',
    'numeric(10,2)',
    // Floating point: bare, or with (M,D).
    'float',
    'float(7,3)',
    'double',
    'double(10,2)',
    // Character types.
    'char',
    'char(1)',
    'char(255)',
    'varchar(1)',
    'varchar(255)',
    'varchar(16383)',
    'tinytext',
    'text',
    'mediumtext',
    'longtext',
    'json',
    // Temporal types, fsp 0-6.
    'date',
    'year',
    'year(4)',
    'time',
    'time(6)',
    'datetime',
    'datetime(3)',
    'datetime(6)',
    'timestamp',
    'timestamp(6)',
    // The input is trimmed and lower-cased first.
    '  int  ',
    'INT UNSIGNED',
    'DECIMAL(10,2)',
  ])('recreates %s', (columnTypeSpelling) => {
    expect(isRecreatableMySqlNativeColumnType(columnTypeSpelling)).toBe(true);
  });

  it.each([
    // ENUM / SET member lists would need a real quoted-literal parser (a grammar bug there is DDL injection).
    "enum('a','b')",
    "set('a','b')",
    // Pulled as base64 / numbers / encoded text: writing the pulled value back would store different bytes.
    'blob',
    'mediumblob',
    'binary(16)',
    'varbinary(255)',
    'bit(1)',
    'geometry',
    'point',
    'vector(3)',
    // MariaDB-only string-like types (not in the recreatable allowlist).
    'uuid',
    'inet6',
    // Modifiers outside MySQL's bounds.
    'varchar',
    'varchar(0)',
    'varchar(16384)',
    'char(256)',
    'decimal(0,0)',
    'decimal(66,2)',
    'decimal(10,31)',
    'decimal(10,11)',
    'float(10)',
    'float(7,8)',
    'int(256)',
    'int(10,2)',
    'year(2)',
    'datetime(7)',
    'time(10)',
    'json(1)',
    'date(1)',
    // unsigned only applies to numbers.
    'varchar(10) unsigned',
    'date unsigned',
    'datetime(3) unsigned',
    // zerofill, charset clauses, spacing variants and injection attempts never match the grammar.
    'int unsigned zerofill',
    'int(10) unsigned zerofill',
    'varchar(10) character set latin1',
    'int  unsigned',
    'decimal(10, 2)',
    'decimal(10,2);drop table users',
    'int); drop table users; --',
    'int -- comment',
    '`int`',
    'integer',
    'real',
    'bool',
    '',
  ])('does not recreate %s', (columnTypeSpelling) => {
    expect(isRecreatableMySqlNativeColumnType(columnTypeSpelling)).toBe(false);
  });
});

describe('readMySqlNativeColumnTypeBaseName', () => {
  it.each([
    ['int unsigned', 'int'],
    ['decimal(10,2)', 'decimal'],
    ["ENUM('a','b')", 'enum'],
    ['  datetime(3)', 'datetime'],
    ['tinyint(1)', 'tinyint'],
    ['', ''],
    ['(int)', ''],
  ])('reads the base type of %j as %j', (columnTypeSpelling, expectedBaseTypeName) => {
    expect(readMySqlNativeColumnTypeBaseName(columnTypeSpelling)).toBe(expectedBaseTypeName);
  });
});

describe('mysqlColumnHasNonWritableRepresentation', () => {
  it.each([
    'tinyint(1)',
    'bigint unsigned',
    'decimal(10,2)',
    'double',
    'year',
    'char(2)',
    'varchar(255)',
    'longtext',
    "enum('a','b')",
    "set('a','b')",
    'date',
    'datetime(6)',
    'timestamp',
    'time',
    'json',
    'uuid',
    'inet4',
    'inet6',
  ])('writes %s back as pulled', (columnTypeSpelling) => {
    expect(mysqlColumnHasNonWritableRepresentation(columnTypeSpelling)).toBe(false);
  });

  it.each([
    'blob',
    'tinyblob',
    'longblob',
    'binary(16)',
    'varbinary(8)',
    'bit(1)',
    'bit(64)',
    'geometry',
    'point',
    'polygon',
    'vector(3)',
    'some_future_type',
    '',
    "enum('p','q') character set binary",
    "set('m','n') CHARACTER SET binary",
  ])('does not write %s back as pulled (encoded or unknown representation)', (columnTypeSpelling) => {
    expect(mysqlColumnHasNonWritableRepresentation(columnTypeSpelling)).toBe(true);
  });
});

describe('binary-charset ENUM / SET', () => {
  it.each<[string, string | null, boolean]>([
    // MySQL 8.4 reports NULL, MariaDB 11.4 'binary'.
    ["enum('p','q')", null, true],
    ["set('m','n')", null, true],
    ["enum('p','q')", 'binary', true],
    ["SET('m','n')", 'BINARY', true],
    ["enum('p','q')", 'utf8mb4', false],
    ["set('m','n')", 'latin1', false],
    ['varbinary(16)', null, false],
    ['int', null, false],
  ])('isMySqlBinaryCharacterSetEnumOrSetColumn(%j, %j) = %s', (columnType, characterSetName, expected) => {
    expect(isMySqlBinaryCharacterSetEnumOrSetColumn(columnType, characterSetName)).toBe(expected);
  });

  it.each<[string, boolean]>([
    [`enum('p','q')${MYSQL_BINARY_CHARACTER_SET_CLAUSE}`, true],
    ["set('m','n') CHARACTER SET BINARY", true],
    ["enum('p','q')", false],
    // The words inside a member never count: the clause must follow the member list.
    ["enum('x) character set binary')", false],
    ['varchar(10) character set binary', false],
  ])('isMySqlBinaryCharacterSetEnumOrSetSpelling(%j) = %s', (columnTypeSpelling, expected) => {
    expect(isMySqlBinaryCharacterSetEnumOrSetSpelling(columnTypeSpelling)).toBe(expected);
  });

  it('resolveMySqlDeclaredColumnTypeSpelling spells the charset for a binary ENUM / SET only', () => {
    expect(resolveMySqlDeclaredColumnTypeSpelling("enum('p','q')", NON_CHARACTER_COLUMN_CONTEXT)).toBe(
      "enum('p','q') character set binary",
    );
    expect(resolveMySqlDeclaredColumnTypeSpelling("enum('p','q')", UTF8MB4_CHARACTER_COLUMN_CONTEXT)).toBe(
      "enum('p','q')",
    );
    expect(resolveMySqlDeclaredColumnTypeSpelling('int', NON_CHARACTER_COLUMN_CONTEXT)).toBe('int');
    expect(
      resolveMySqlDeclaredColumnTypeSpelling('longtext', { isMariaDbJsonAlias: true, characterSetName: 'utf8mb4' }),
    ).toBe('json');
  });
});

describe('isMySqlIntegerColumnType', () => {
  it.each(['tinyint(1)', 'smallint', 'mediumint unsigned', 'int(11)', 'integer', 'bigint unsigned'])(
    'treats %s as an integer type',
    (columnTypeSpelling) => {
      expect(isMySqlIntegerColumnType(columnTypeSpelling)).toBe(true);
    },
  );

  it.each(['decimal(10,0)', 'double', 'float', 'year', 'bit(8)', 'varchar(10)', 'bigintx'])(
    'does not treat %s as an integer type',
    (columnTypeSpelling) => {
      expect(isMySqlIntegerColumnType(columnTypeSpelling)).toBe(false);
    },
  );
});

describe('isMySqlTextOrBlobOrJsonColumnType', () => {
  it.each(['tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'json'])(
    'flags %s as a type a foreign key cannot reference',
    (columnTypeSpelling) => {
      expect(isMySqlTextOrBlobOrJsonColumnType(columnTypeSpelling)).toBe(true);
    },
  );

  it.each(['varchar(255)', 'char(36)', 'binary(16)', 'bigint unsigned', 'int'])(
    'does not flag %s',
    (columnTypeSpelling) => {
      expect(isMySqlTextOrBlobOrJsonColumnType(columnTypeSpelling)).toBe(false);
    },
  );
});

describe('classifyMySqlTemporalColumnType', () => {
  it('classifies DATE without a precision', () => {
    expect(classifyMySqlTemporalColumnType('date')).toEqual({ temporalKind: 'date' });
  });

  it.each([
    ['datetime(3)', 'datetime', 3],
    ['DATETIME(6)', 'datetime', 6],
    ['timestamp(6)', 'timestamp', 6],
    ['timestamp(0)', 'timestamp', 0],
    ['datetime(3) ', 'datetime', 3],
  ] as const)('reads %j as %s with precision %d', (columnTypeSpelling, expectedTemporalKind, expectedPrecision) => {
    expect(classifyMySqlTemporalColumnType(columnTypeSpelling)).toEqual({
      temporalKind: expectedTemporalKind,
      fractionalSecondsPrecision: expectedPrecision,
    });
  });

  it('reads a bare DATETIME / TIMESTAMP as precision 0 (COLUMN_TYPE omits "(0)")', () => {
    expect(classifyMySqlTemporalColumnType('datetime')).toEqual({
      temporalKind: 'datetime',
      fractionalSecondsPrecision: 0,
    });
    expect(classifyMySqlTemporalColumnType('timestamp')).toEqual({
      temporalKind: 'timestamp',
      fractionalSecondsPrecision: 0,
    });
  });

  it.each(['time', 'time(3)', 'year', 'varchar(10)', 'datetime2', 'datetime unsigned', 'date(3)', 'datetime(7)', ''])(
    'is undefined for %j',
    (columnTypeSpelling) => {
      expect(classifyMySqlTemporalColumnType(columnTypeSpelling)).toBeUndefined();
    },
  );
});

describe('buildMySqlNativeColumnTypeAnnotation', () => {
  it('annotates a recreatable type verbatim', () => {
    expect(buildMySqlNativeColumnTypeAnnotation('int unsigned', NON_CHARACTER_COLUMN_CONTEXT)).toEqual({
      typeSystem: MYSQL_NATIVE_TYPE_SYSTEM,
      type: 'int unsigned',
      isRecreatableVerbatim: true,
    });
  });

  it("reports a MariaDB JSON alias (LONGTEXT + json_valid) as its declared, recreatable type 'json'", () => {
    expect(
      buildMySqlNativeColumnTypeAnnotation('longtext', { isMariaDbJsonAlias: true, characterSetName: 'utf8mb4' }),
    ).toEqual({
      typeSystem: MYSQL_NATIVE_TYPE_SYSTEM,
      type: 'json',
      isRecreatableVerbatim: true,
    });
  });

  it.each(['blob', 'binary(16)', 'bit(1)', 'uuid', 'int unsigned zerofill'])(
    'annotates but never recreates %s',
    (columnTypeSpelling) => {
      expect(buildMySqlNativeColumnTypeAnnotation(columnTypeSpelling, NON_CHARACTER_COLUMN_CONTEXT)).toEqual({
        typeSystem: MYSQL_NATIVE_TYPE_SYSTEM,
        type: columnTypeSpelling,
        isRecreatableVerbatim: false,
      });
    },
  );

  it.each(["enum('a','b')", "set('x')"])(
    'annotates a text ENUM / SET verbatim but never recreates it',
    (columnType) => {
      expect(buildMySqlNativeColumnTypeAnnotation(columnType, UTF8MB4_CHARACTER_COLUMN_CONTEXT)).toEqual({
        typeSystem: MYSQL_NATIVE_TYPE_SYSTEM,
        type: columnType,
        isRecreatableVerbatim: false,
      });
    },
  );

  it.each<[string, string | null]>([
    ["enum('p','q')", null],
    ["set('m','n')", 'binary'],
  ])(
    'spells a binary-charset %s (charset %j) with its charset, as a non-writable binary type',
    (columnType, charset) => {
      const annotation = buildMySqlNativeColumnTypeAnnotation(columnType, {
        isMariaDbJsonAlias: false,
        characterSetName: charset,
      });
      expect(annotation).toEqual({
        typeSystem: MYSQL_NATIVE_TYPE_SYSTEM,
        type: `${columnType} character set binary`,
        isRecreatableVerbatim: false,
      });
      expect(mysqlColumnHasNonWritableRepresentation(annotation.type)).toBe(true);
    },
  );

  describe('CHAR / VARCHAR character sets (a created table is always utf8mb4)', () => {
    it.each(['utf8mb4', 'UTF8MB4'])('recreates a %s varchar(255) / char(2) verbatim', (characterSetName) => {
      for (const columnType of ['varchar(255)', 'char(2)']) {
        expect(
          buildMySqlNativeColumnTypeAnnotation(columnType, { isMariaDbJsonAlias: false, characterSetName })
            .isRecreatableVerbatim,
        ).toBe(true);
      }
    });

    it.each<[string | null]>([['latin1'], ['ascii'], ['utf8mb3'], ['utf8'], ['ucs2'], [null]])(
      'falls back to the logical kind for a %j varchar(255) / char(2) (a wider row in utf8mb4)',
      (characterSetName) => {
        for (const columnType of ['varchar(255)', 'char(2)']) {
          expect(
            buildMySqlNativeColumnTypeAnnotation(columnType, { isMariaDbJsonAlias: false, characterSetName }),
          ).toEqual({ typeSystem: MYSQL_NATIVE_TYPE_SYSTEM, type: columnType, isRecreatableVerbatim: false });
        }
      },
    );

    it('keeps TEXT types (stored off-row) and non-character types recreatable whatever the charset', () => {
      expect(
        buildMySqlNativeColumnTypeAnnotation('text', { isMariaDbJsonAlias: false, characterSetName: 'latin1' })
          .isRecreatableVerbatim,
      ).toBe(true);
      expect(
        buildMySqlNativeColumnTypeAnnotation('decimal(10,2)', NON_CHARACTER_COLUMN_CONTEXT).isRecreatableVerbatim,
      ).toBe(true);
    });
  });
});

describe('readMySqlNativeColumnType', () => {
  it('reads a MySQL annotation back', () => {
    expect(
      readMySqlNativeColumnType({
        type: 'string',
        [X_SCRATCH_NATIVE_COLUMN_TYPE]: { typeSystem: 'mysql', type: 'datetime(3)', isRecreatableVerbatim: true },
      }),
    ).toBe('datetime(3)');
  });

  it.each([
    ['another type system', { [X_SCRATCH_NATIVE_COLUMN_TYPE]: { typeSystem: 'postgres', type: 'integer' } }],
    ['no annotation', { type: 'string' }],
    ['a non-object annotation', { [X_SCRATCH_NATIVE_COLUMN_TYPE]: 'int' }],
    ['a non-string type', { [X_SCRATCH_NATIVE_COLUMN_TYPE]: { typeSystem: 'mysql', type: 3 } }],
    ['a null annotation', { [X_SCRATCH_NATIVE_COLUMN_TYPE]: null }],
    ['a missing schema', undefined],
    ['a null schema', null],
    ['a non-object schema', 'int'],
  ])('is undefined for %s', (_label, columnSchema) => {
    expect(readMySqlNativeColumnType(columnSchema)).toBeUndefined();
  });
});
