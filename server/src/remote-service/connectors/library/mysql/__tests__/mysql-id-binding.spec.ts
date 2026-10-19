import { type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_NATIVE_COLUMN_TYPE } from '@spinner/shared-types';
import { type BaseJsonTableSpec, dotPath } from '../../../types';
import {
  type BindableMySqlPrimaryKeyValue,
  canonicalMySqlPrimaryKeyText,
  isMySqlColumnTypeAddressableById,
  type MySqlPrimaryKeyBindingKind,
  mysqlPrimaryKeyBindingKindForColumnType,
  resolveMySqlPrimaryKeyBindingKind,
  toBindableMySqlPrimaryKeyValue,
} from '../mysql-id-binding';

const TIMESTAMP_MILLIS_BINDING_KIND: MySqlPrimaryKeyBindingKind = {
  bindingKindName: 'temporal',
  temporalColumnType: { temporalKind: 'timestamp', fractionalSecondsPrecision: 3 },
};
const DATETIME_SECONDS_BINDING_KIND: MySqlPrimaryKeyBindingKind = {
  bindingKindName: 'temporal',
  temporalColumnType: { temporalKind: 'datetime', fractionalSecondsPrecision: 0 },
};
const DATE_BINDING_KIND: MySqlPrimaryKeyBindingKind = {
  bindingKindName: 'temporal',
  temporalColumnType: { temporalKind: 'date' },
};

function buildTableSpecWithIdColumnAnnotation(idColumnAnnotation: unknown, idPath = 'id'): BaseJsonTableSpec {
  return {
    id: { wsId: 'test_db__t', remoteId: ['test_db', 't'] },
    slug: 't',
    name: 't',
    schema: {
      type: 'object',
      properties: { [idPath]: { type: 'string', [X_SCRATCH_NATIVE_COLUMN_TYPE]: idColumnAnnotation } },
    } as unknown as TSchema,
    idPath: dotPath(idPath),
  };
}

function matchableValue(bindable: BindableMySqlPrimaryKeyValue): unknown {
  if (!bindable.isMatchable) throw new Error('expected a matchable id');
  return bindable.bindableValue;
}

describe('mysqlPrimaryKeyBindingKindForColumnType', () => {
  it.each<[string | undefined, MySqlPrimaryKeyBindingKind]>([
    ['int', 'integer'],
    ['int unsigned', 'integer'],
    ['int(11)', 'integer'],
    ['bigint', 'integer'],
    ['bigint(20) unsigned', 'integer'],
    ['tinyint(1)', 'integer'],
    ['smallint', 'integer'],
    ['mediumint unsigned', 'integer'],
    ['binary(16)', 'base64Binary'],
    ['varbinary(255)', 'base64Binary'],
    ['char(36)', 'text'],
    ['varchar(255)', 'text'],
    ['uuid', 'text'],
    ["enum('a','b')", 'text'],
    ["enum('a','b') character set binary", 'base64Binary'],
    ["set('a','b') character set binary", 'base64Binary'],
    ['double', 'text'],
    ['decimal(10,2)', 'text'],
    ['time(3)', 'text'],
    ['year', 'text'],
    // BIT is pulled as its unsigned integer, so it binds back as one (never as the quoted text '5' = byte 0x35).
    ['bit(8)', 'integer'],
    ['bit(64)', 'integer'],
    ['blob', 'passthrough'],
    ['point', 'passthrough'],
    ['some_future_type', 'passthrough'],
    [undefined, 'passthrough'],
  ])('%j → %s', (columnTypeSpelling, expectedBindingKind) => {
    expect(mysqlPrimaryKeyBindingKindForColumnType(columnTypeSpelling)).toBe(expectedBindingKind);
  });

  it.each<[string, MySqlPrimaryKeyBindingKind]>([
    ['date', DATE_BINDING_KIND],
    ['datetime', DATETIME_SECONDS_BINDING_KIND],
    ['timestamp(3)', TIMESTAMP_MILLIS_BINDING_KIND],
  ])('%j → a temporal binding carrying the column type', (columnTypeSpelling, expectedBindingKind) => {
    expect(mysqlPrimaryKeyBindingKindForColumnType(columnTypeSpelling)).toEqual(expectedBindingKind);
  });
});

describe('isMySqlColumnTypeAddressableById', () => {
  it.each([
    'int unsigned',
    'bigint(20)',
    'decimal(10,2)',
    'double',
    'char(36)',
    'varchar(255)',
    "enum('a','b')",
    'binary(16)',
    'varbinary(64)',
    'bit(8)',
    'date',
    'datetime(3)',
    'timestamp(6)',
    'time',
    'year',
    'uuid',
  ])('addresses records by a %s column', (columnTypeSpelling) => {
    expect(isMySqlColumnTypeAddressableById(columnTypeSpelling)).toBe(true);
  });

  it.each([
    // The pulled 6-digit rendering never equals the stored float32.
    'float',
    'float(7,4)',
    'float unsigned',
    // Pulled encodings MySQL would compare as text.
    'blob',
    'tinyblob',
    'geometry',
    'vector(3)',
    'some_future_type',
  ])('never addresses records by a %s column', (columnTypeSpelling) => {
    expect(isMySqlColumnTypeAddressableById(columnTypeSpelling)).toBe(false);
  });
});

describe('resolveMySqlPrimaryKeyBindingKind', () => {
  it("reads the id column's MySQL native type annotation", () => {
    expect(
      resolveMySqlPrimaryKeyBindingKind(
        buildTableSpecWithIdColumnAnnotation({
          typeSystem: 'mysql',
          type: 'bigint unsigned',
          isRecreatableVerbatim: true,
        }),
      ),
    ).toBe('integer');
    expect(
      resolveMySqlPrimaryKeyBindingKind(
        buildTableSpecWithIdColumnAnnotation({ typeSystem: 'mysql', type: 'binary(16)', isRecreatableVerbatim: false }),
      ),
    ).toBe('base64Binary');
  });

  it('binds a TIMESTAMP id through its temporal column type', () => {
    expect(
      resolveMySqlPrimaryKeyBindingKind(
        buildTableSpecWithIdColumnAnnotation(
          { typeSystem: 'mysql', type: 'timestamp(3)', isRecreatableVerbatim: true },
          'recorded_at',
        ),
      ),
    ).toEqual(TIMESTAMP_MILLIS_BINDING_KIND);
  });

  it('follows a non-default id column (e.g. the invisible primary key my_row_id)', () => {
    expect(
      resolveMySqlPrimaryKeyBindingKind(
        buildTableSpecWithIdColumnAnnotation({ typeSystem: 'mysql', type: 'bigint unsigned' }, 'my_row_id'),
      ),
    ).toBe('integer');
  });

  it('passes ids through when the annotation is missing or from another type system', () => {
    expect(resolveMySqlPrimaryKeyBindingKind(buildTableSpecWithIdColumnAnnotation(undefined))).toBe('passthrough');
    expect(
      resolveMySqlPrimaryKeyBindingKind(
        buildTableSpecWithIdColumnAnnotation({ typeSystem: 'postgres', type: 'bigint' }),
      ),
    ).toBe('passthrough');
  });
});

describe('toBindableMySqlPrimaryKeyValue', () => {
  describe('integer keys', () => {
    it('binds pulled id text above 2^53 as an exact BigInt (not a DOUBLE-compared string)', () => {
      expect(matchableValue(toBindableMySqlPrimaryKeyValue('9007199254740993', 'integer'))).toBe(9007199254740993n);
    });

    it.each<[unknown, bigint]>([
      ['42', 42n],
      ['-5', -5n],
      ['007', 7n],
      ['18446744073709551615', 18446744073709551615n],
      [42, 42n],
      [0, 0n],
      [9007199254740993n, 9007199254740993n],
    ])('%p → %p', (recordId, expectedBigInt) => {
      expect(matchableValue(toBindableMySqlPrimaryKeyValue(recordId, 'integer'))).toBe(expectedBigInt);
    });

    it.each<[string, unknown]>([
      ['text with a numeric prefix (MySQL would match row 12)', '12abc'],
      ['a decimal', '1.5'],
      ['surrounding whitespace', ' 12'],
      ['an empty string', ''],
      ['a fractional number', 1.5],
      ['an unsafe number', 2 ** 53 + 2],
      ['null', null],
      ['an object', { id: 1 }],
    ])('reports %s as unmatchable', (_description, recordId) => {
      expect(toBindableMySqlPrimaryKeyValue(recordId, 'integer')).toEqual({ isMatchable: false });
    });
  });

  describe('binary keys', () => {
    it('binds pulled base64 back as the exact bytes', () => {
      const binaryIdBytes = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
      const bindableValue = matchableValue(
        toBindableMySqlPrimaryKeyValue(binaryIdBytes.toString('base64'), 'base64Binary'),
      );
      expect(Buffer.isBuffer(bindableValue)).toBe(true);
      expect((bindableValue as Buffer).equals(binaryIdBytes)).toBe(true);
    });

    it.each<[string, unknown]>([
      ['base64 of the wrong length', 'abc'],
      ['characters outside the base64 alphabet', 'ab!='],
      ['URL-safe base64', 'ab-_'],
      ['a number', 12],
    ])('reports %s as unmatchable', (_description, recordId) => {
      expect(toBindableMySqlPrimaryKeyValue(recordId, 'base64Binary')).toEqual({ isMatchable: false });
    });
  });

  describe('text keys', () => {
    it('binds strings as-is and numbers as their text', () => {
      expect(matchableValue(toBindableMySqlPrimaryKeyValue('abc-123', 'text'))).toBe('abc-123');
      expect(matchableValue(toBindableMySqlPrimaryKeyValue(12, 'text'))).toBe('12');
    });

    it('reports a non-scalar as unmatchable', () => {
      expect(toBindableMySqlPrimaryKeyValue(null, 'text')).toEqual({ isMatchable: false });
      expect(toBindableMySqlPrimaryKeyValue({ id: 'x' }, 'text')).toEqual({ isMatchable: false });
    });
  });

  describe('BIT keys (integer binding)', () => {
    it('binds the pulled number or decimal text as an exact integer', () => {
      expect(matchableValue(toBindableMySqlPrimaryKeyValue(5, 'integer'))).toBe(5n);
      expect(matchableValue(toBindableMySqlPrimaryKeyValue('5', 'integer'))).toBe(5n);
      // BIT(64) above 2^53 is pulled as decimal text.
      expect(matchableValue(toBindableMySqlPrimaryKeyValue('18446744073709551615', 'integer'))).toBe(
        18446744073709551615n,
      );
    });
  });

  describe('temporal keys', () => {
    it('binds a pulled TIMESTAMP (RFC 3339, UTC) as the UTC literal MySQL stores', () => {
      expect(
        matchableValue(toBindableMySqlPrimaryKeyValue('2026-01-02T03:04:05.678Z', TIMESTAMP_MILLIS_BINDING_KIND)),
      ).toBe('2026-01-02 03:04:05.678');
    });

    it('pads and truncates the fraction to the column precision, as the write path does', () => {
      expect(
        matchableValue(toBindableMySqlPrimaryKeyValue('2026-01-02T03:04:05Z', TIMESTAMP_MILLIS_BINDING_KIND)),
      ).toBe('2026-01-02 03:04:05.000');
      expect(
        matchableValue(toBindableMySqlPrimaryKeyValue('2026-01-02 03:04:05.6789', TIMESTAMP_MILLIS_BINDING_KIND)),
      ).toBe('2026-01-02 03:04:05.678');
    });

    it('binds a pulled DATETIME / DATE verbatim (they are pulled exactly as MySQL prints them)', () => {
      expect(matchableValue(toBindableMySqlPrimaryKeyValue('2026-01-02 03:04:05', DATETIME_SECONDS_BINDING_KIND))).toBe(
        '2026-01-02 03:04:05',
      );
      expect(matchableValue(toBindableMySqlPrimaryKeyValue('2026-01-02', DATE_BINDING_KIND))).toBe('2026-01-02');
    });

    it('binds a zero date in the column shape', () => {
      expect(
        matchableValue(toBindableMySqlPrimaryKeyValue('0000-00-00 00:00:00.000', TIMESTAMP_MILLIS_BINDING_KIND)),
      ).toBe('0000-00-00 00:00:00.000');
    });

    it.each<[string, unknown, MySqlPrimaryKeyBindingKind]>([
      ['text that is no date', 'not-a-date', TIMESTAMP_MILLIS_BINDING_KIND],
      ['an impossible calendar date', '2026-02-30 00:00:00', DATETIME_SECONDS_BINDING_KIND],
      ['a time of day for a DATE column', '2026-01-02T03:04:05Z', DATE_BINDING_KIND],
      ['a number (epoch millis)', 1767323045678, TIMESTAMP_MILLIS_BINDING_KIND],
      ['null', null, DATE_BINDING_KIND],
    ])('reports %s as unmatchable', (_description, recordId, bindingKind) => {
      expect(toBindableMySqlPrimaryKeyValue(recordId, bindingKind)).toEqual({ isMatchable: false });
    });
  });

  describe('passthrough keys', () => {
    it('binds strings, numbers and BigInts unchanged', () => {
      expect(matchableValue(toBindableMySqlPrimaryKeyValue('x', 'passthrough'))).toBe('x');
      expect(matchableValue(toBindableMySqlPrimaryKeyValue(5, 'passthrough'))).toBe(5);
      expect(matchableValue(toBindableMySqlPrimaryKeyValue(5n, 'passthrough'))).toBe(5n);
    });

    it('reports anything else as unmatchable', () => {
      expect(toBindableMySqlPrimaryKeyValue(undefined, 'passthrough')).toEqual({ isMatchable: false });
      expect(toBindableMySqlPrimaryKeyValue([1], 'passthrough')).toEqual({ isMatchable: false });
    });
  });
});

describe('canonicalMySqlPrimaryKeyText', () => {
  it('compares integer ids by value', () => {
    expect(canonicalMySqlPrimaryKeyText('007', 'integer')).toBe('7');
    expect(canonicalMySqlPrimaryKeyText(7, 'integer')).toBe('7');
    expect(canonicalMySqlPrimaryKeyText(7n, 'integer')).toBe('7');
    expect(canonicalMySqlPrimaryKeyText('9007199254740993', 'integer')).toBe('9007199254740993');
    expect(canonicalMySqlPrimaryKeyText('12abc', 'integer')).toBe('12abc');
  });

  it('renders binary ids as base64 so a returned Buffer lines up with the pulled text', () => {
    const binaryIdBytes = Buffer.from([0, 1, 2, 250]);
    expect(canonicalMySqlPrimaryKeyText(binaryIdBytes, 'base64Binary')).toBe(binaryIdBytes.toString('base64'));
    expect(canonicalMySqlPrimaryKeyText(binaryIdBytes.toString('base64'), 'base64Binary')).toBe('AAEC+g==');
  });

  it('uses the string form for text ids', () => {
    expect(canonicalMySqlPrimaryKeyText('abc', 'text')).toBe('abc');
    expect(canonicalMySqlPrimaryKeyText(12, 'text')).toBe('12');
  });

  it('lines up a bound temporal literal with the re-selected, decoded value (TIMESTAMP rendered as RFC 3339)', () => {
    const boundLiteral = matchableValue(
      toBindableMySqlPrimaryKeyValue('2026-01-02T03:04:05.678Z', TIMESTAMP_MILLIS_BINDING_KIND),
    );
    expect(canonicalMySqlPrimaryKeyText(boundLiteral, TIMESTAMP_MILLIS_BINDING_KIND)).toBe('2026-01-02 03:04:05.678');
    expect(canonicalMySqlPrimaryKeyText('2026-01-02T03:04:05.678Z', TIMESTAMP_MILLIS_BINDING_KIND)).toBe(
      '2026-01-02 03:04:05.678',
    );
    expect(canonicalMySqlPrimaryKeyText('2026-01-02 03:04:05', DATETIME_SECONDS_BINDING_KIND)).toBe(
      '2026-01-02 03:04:05',
    );
    expect(canonicalMySqlPrimaryKeyText('2026-01-02', DATE_BINDING_KIND)).toBe('2026-01-02');
  });

  it('keeps unconvertible temporal text as-is (it lines up with nothing, so the caller re-selects that row)', () => {
    expect(canonicalMySqlPrimaryKeyText('garbage', TIMESTAMP_MILLIS_BINDING_KIND)).toBe('garbage');
  });

  it('compares BIT ids (integer binding) by value', () => {
    expect(canonicalMySqlPrimaryKeyText(5, 'integer')).toBe(canonicalMySqlPrimaryKeyText(5n, 'integer'));
  });

  it('returns undefined for a missing id', () => {
    expect(canonicalMySqlPrimaryKeyText(null, 'integer')).toBeUndefined();
    expect(canonicalMySqlPrimaryKeyText(undefined, 'text')).toBeUndefined();
  });
});
