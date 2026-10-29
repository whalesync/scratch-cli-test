import { Type, type TSchema } from '@sinclair/typebox';
import {
  JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT,
  PostgresColumnType,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_NATIVE_COLUMN_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import {
  areFieldValuesCanonicallyEqual,
  type FieldValueCanonicalizer,
  type FieldValueCanonicalizerContext,
} from 'src/remote-service/connectors/field-value-canonicalization';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { getSchemaAtFieldPath } from 'src/utils/field-path';
import { extractSchemaFields } from 'src/utils/schema-helpers';
import {
  mysqlFieldValueCanonicalizerForNativeColumnType,
  parseMySqlEnumOrSetColumnTypeMembers,
  resolveMySqlFieldValueCanonicalizer,
} from '../mysql-field-value-canonicalizer';

interface MySqlTestColumn {
  /** `COLUMN_TYPE` as the read side annotates it; omitted to test the family/format fallback. */
  nativeColumnType?: string;
  connectorDataType: PostgresColumnType;
  valueSchema: TSchema;
  isReadOnly?: boolean;
}

/** A column schema shaped like the read side's (`mysql-json-schema.ts`): nullable wrap + family + native type. */
function buildMySqlColumnSchema(column: MySqlTestColumn): TSchema {
  return {
    ...Type.Union([column.valueSchema, Type.Null()]),
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: column.connectorDataType,
    ...(column.nativeColumnType !== undefined
      ? {
          [X_SCRATCH_NATIVE_COLUMN_TYPE]: {
            typeSystem: 'mysql',
            type: column.nativeColumnType,
            isRecreatableVerbatim: false,
          },
        }
      : {}),
    ...(column.isReadOnly ? { [X_SCRATCH_READONLY]: true } : {}),
  };
}

function buildMySqlTableSpec(columns: Record<string, MySqlTestColumn>): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {};
  for (const [columnName, column] of Object.entries(columns)) {
    properties[columnName] = buildMySqlColumnSchema(column);
  }
  return { schema: Type.Object(properties), idPath: 'id' } as unknown as BaseJsonTableSpec;
}

/** Run the hook over every field the way `resolveFieldValueCanonicalizersForTable` does. */
function resolveCanonicalizersForTableSpec(tableSpec: BaseJsonTableSpec): Map<string, FieldValueCanonicalizer> {
  const canonicalizerByFieldPath = new Map<string, FieldValueCanonicalizer>();
  for (const schemaField of extractSchemaFields(tableSpec.schema)) {
    const context: FieldValueCanonicalizerContext = {
      fieldPath: schemaField.path,
      fieldSchema: getSchemaAtFieldPath(tableSpec.schema, schemaField.path),
      schemaField,
      tableSpec,
    };
    const canonicalizer = resolveMySqlFieldValueCanonicalizer(context);
    if (canonicalizer) canonicalizerByFieldPath.set(schemaField.path, canonicalizer);
  }
  return canonicalizerByFieldPath;
}

const textColumn = (nativeColumnType: string): MySqlTestColumn => ({
  nativeColumnType,
  connectorDataType: PostgresColumnType.TEXT,
  valueSchema: Type.String(),
});
const numberColumn = (nativeColumnType: string): MySqlTestColumn => ({
  nativeColumnType,
  connectorDataType: PostgresColumnType.NUMERIC,
  valueSchema: Type.Number(),
});
const numericStringColumn = (nativeColumnType: string): MySqlTestColumn => ({
  nativeColumnType,
  connectorDataType: PostgresColumnType.NUMERIC_STRING,
  valueSchema: Type.Union([Type.String(), Type.Number()]),
});

const destinationTableSpec = buildMySqlTableSpec({
  id: { ...numericStringColumn('bigint unsigned'), isReadOnly: true },
  created_at: {
    nativeColumnType: 'datetime(3)',
    connectorDataType: PostgresColumnType.TIMESTAMP,
    valueSchema: Type.String({ format: JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT }),
  },
  starts_at: {
    nativeColumnType: 'datetime',
    connectorDataType: PostgresColumnType.TIMESTAMP,
    valueSchema: Type.String({ format: JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT }),
  },
  seen_at: {
    nativeColumnType: 'timestamp(3)',
    connectorDataType: PostgresColumnType.TIMESTAMP,
    valueSchema: Type.String({ format: 'date-time' }),
  },
  due_on: {
    nativeColumnType: 'date',
    connectorDataType: PostgresColumnType.TIMESTAMP,
    valueSchema: Type.String({ format: 'date' }),
  },
  legacy_datetime: {
    connectorDataType: PostgresColumnType.TIMESTAMP,
    valueSchema: Type.String({ format: JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT }),
  },
  price: numericStringColumn('decimal(10,4)'),
  cents: numericStringColumn('decimal(10,2)'),
  tiny_fraction: numericStringColumn('decimal(10,8)'),
  whole_amount: numericStringColumn('decimal(10,0)'),
  bare_decimal: numericStringColumn('decimal'),
  precision_only_decimal: numericStringColumn('decimal(5)'),
  big_id: numericStringColumn('bigint'),
  ratio: numberColumn('float'),
  scaled_ratio: numberColumn('float(7,3)'),
  rounded_price: numberColumn('double(10,2)'),
  whole_double: numberColumn('double(10,0)'),
  score: numberColumn('double'),
  is_active: numberColumn('tinyint(1)'),
  rating: numberColumn('tinyint'),
  quantity: numberColumn('int(11)'),
  founded: numberColumn('year'),
  stage: textColumn("enum('a','it''s','b\\\\c','Mixed')"),
  tags: textColumn("set('x','y','z')"),
  country_code: textColumn('char(5)'),
  name: textColumn('varchar(255)'),
  notes: textColumn('mediumtext'),
  opens_at: textColumn('time'),
  opens_at_with_milliseconds: textColumn('time(3)'),
  payload: { nativeColumnType: 'json', connectorDataType: PostgresColumnType.JSONB, valueSchema: Type.Unknown() },
  legacy_payload: { connectorDataType: PostgresColumnType.JSONB, valueSchema: Type.Unknown() },
  picture: { ...textColumn('blob'), isReadOnly: true },
  computed_total: { ...numberColumn('int'), isReadOnly: true },
});

const canonicalizerByFieldPath = resolveCanonicalizersForTableSpec(destinationTableSpec);

function canonicalizerFor(fieldPath: string): FieldValueCanonicalizer {
  const canonicalizer = canonicalizerByFieldPath.get(fieldPath);
  if (!canonicalizer) throw new Error(`expected a canonicalizer for ${fieldPath}`);
  return canonicalizer;
}

function expectSame(fieldPath: string, storedValue: unknown, sourceValue: unknown): void {
  expect(areFieldValuesCanonicallyEqual(canonicalizerFor(fieldPath), storedValue, sourceValue)).toBe(true);
}

function expectDifferent(fieldPath: string, storedValue: unknown, sourceValue: unknown): void {
  expect(areFieldValuesCanonicallyEqual(canonicalizerFor(fieldPath), storedValue, sourceValue)).toBe(false);
}

describe('resolveMySqlFieldValueCanonicalizer', () => {
  it('declares canonicalizers for re-rendered columns only — never for read-only or verbatim text columns', () => {
    expect([...canonicalizerByFieldPath.keys()].sort()).toEqual(
      [
        'created_at',
        'starts_at',
        'seen_at',
        'due_on',
        'legacy_datetime',
        'price',
        'cents',
        'tiny_fraction',
        'whole_amount',
        'bare_decimal',
        'precision_only_decimal',
        'big_id',
        'ratio',
        'scaled_ratio',
        'rounded_price',
        'whole_double',
        'score',
        'is_active',
        'rating',
        'quantity',
        'founded',
        'stage',
        'tags',
        'country_code',
        'opens_at',
        'opens_at_with_milliseconds',
        'payload',
        'legacy_payload',
      ].sort(),
    );
  });

  describe('DATETIME / TIMESTAMP / DATE compare as the literal the write path sends', () => {
    it('converts offsets to UTC wall clock and pads to the column precision', () => {
      expectSame('created_at', '2026-03-05 19:30:00.000', '2026-03-05T14:30:00-05:00');
      expectSame('created_at', '2026-03-05 19:30:00.000', '2026-03-05T19:30:00Z');
      expectSame('created_at', '2026-03-05 14:30:00.000', '2026-03-05T14:30');
      expectDifferent('created_at', '2026-03-05 19:30:00.000', '2026-03-05T19:30:01Z');
    });

    it('truncates fractional seconds to the column precision, as the write path does', () => {
      expectSame('created_at', '2026-03-05 19:30:00.123', '2026-03-05T19:30:00.123999Z');
      expectDifferent('created_at', '2026-03-05 19:30:00.123', '2026-03-05T19:30:00.124Z');
    });

    it('treats a bare DATETIME as precision 0 (MySQL prints datetime(0) as "datetime")', () => {
      expectSame('starts_at', '2026-03-05 14:30:00', '2026-03-05T14:30:00.600Z');
      expectSame('starts_at', '2026-03-05 14:30:00', '2026-03-05 14:30:00');
    });

    it('compares a pulled TIMESTAMP (RFC 3339 UTC) with any rendering of the same instant', () => {
      expectSame('seen_at', '2026-03-05T19:30:00.000Z', '2026-03-05T14:30:00-05:00');
      expectSame('seen_at', '2026-03-05T00:00:00.000Z', '2026-03-05');
      expectSame('seen_at', '2026-12-31T04:30:00.000Z', '2026-12-30T23:30:00-05:00');
      expectDifferent('seen_at', '2026-03-05T19:30:00.000Z', '2026-03-05T19:30:00.001Z');
    });

    it('keeps DATE literal: a midnight date-time in any offset is that date; another time of day is a real difference', () => {
      expectSame('due_on', '2026-03-05', '2026-03-05');
      expectSame('due_on', '2026-03-05', '2026-03-05T00:00:00+05:00');
      expectDifferent('due_on', '2026-03-05', '2026-03-05T14:30:00Z');
    });

    it('falls back to the schema format without a native annotation (precision unknown: trailing zeros ignored)', () => {
      expectSame('legacy_datetime', '2026-03-05 14:30:00.000', '2026-03-05T14:30:00Z');
      expectSame('legacy_datetime', '2026-03-05 14:30:00.500', '2026-03-05T14:30:00.5');
      expectDifferent('legacy_datetime', '2026-03-05 14:30:00.500', '2026-03-05T14:30:00.51');
    });

    it('passes zero dates, unparseable text and non-strings through unchanged', () => {
      expectSame('created_at', '0000-00-00 00:00:00', '0000-00-00 00:00:00');
      expectDifferent('created_at', 'not a date', '2026-03-05 00:00:00.000');
      expect(canonicalizerFor('created_at')('not a date')).toBe('not a date');
      expect(canonicalizerFor('created_at')(20260305)).toBe(20260305);
    });

    it("treats '' as NULL (the write path writes '' as NULL)", () => {
      expectSame('created_at', null, '');
      expectSame('due_on', null, undefined);
    });
  });

  describe('DECIMAL(p,s) and BIGINT compare as decimal text, never through a float', () => {
    it('rounds to the column scale half away from zero, as MySQL stores it', () => {
      expectSame('price', '1.2346', '1.23456');
      expectSame('price', '1.2346', 1.23456);
      expectSame('price', '1.2346', '1.23455');
      expectSame('price', '-1.2346', '-1.23455');
      expectSame('price', '0.0000', '-0.00001');
      expectSame('price', '10.0000', '9.99995');
      expectDifferent('price', '1.2346', '1.2345');
      expectSame('cents', '1.50', 1.5);
      expectSame('cents', '1.50', '+1.5');
      expectDifferent('cents', '1.50', '1.51');
    });

    it('expands exponent notation before rounding', () => {
      expectSame('tiny_fraction', '0.00000010', 1e-7);
      expectSame('tiny_fraction', '1500.00000000', '1.5E+3');
    });

    it('normalises BIGINT text without losing precision', () => {
      expectSame('big_id', '9007199254740993', '9007199254740993');
      expectSame('big_id', '7', '007');
      expectSame('big_id', '1', true);
      expectDifferent('big_id', '9007199254740993', '9007199254740992');
    });

    it('gives a leading-dot literal its 0 (MySQL stores .5 in DECIMAL(10,2) as 0.50)', () => {
      expectSame('cents', '0.50', '.5');
      expectSame('cents', '-0.50', '-.5');
      expect(canonicalizerFor('cents')('.5')).toBe('0.5');
    });

    it('counts booleans as 1 / 0 in DECIMAL columns, as MySQL stores them', () => {
      expectSame('cents', '1.00', true);
      expectSame('cents', '0.00', false);
      expectSame('whole_amount', '1', true);
    });

    it("treats '' as NULL", () => {
      expectSame('price', null, '');
    });
  });

  describe('floating point and integers', () => {
    it('compares FLOAT at 6 significant digits, as MySQL renders float32', () => {
      expectSame('ratio', 3.14159, 3.14159265);
      expectSame('ratio', 123457000, 123456789);
      expectSame('ratio', 3.14159, '3.14159265');
      expectDifferent('ratio', 3.14, 3.15);
    });

    it('rounds FLOAT(M,D) to its declared scale first', () => {
      expectSame('scaled_ratio', 1.235, 1.23456);
      expectDifferent('scaled_ratio', 1.235, 1.2344);
    });

    // Every stored value below is what MySQL 8.4 and MariaDB 11.4 return for the source value.
    it('rounds an exact binary tie in DOUBLE(M,D) to the even digit, as MySQL stores it (not up, like toFixed)', () => {
      expectSame('rounded_price', 1.12, 1.125);
      expectSame('rounded_price', 1.38, 1.375);
      expectSame('rounded_price', -1.12, -1.125);
      expectSame('rounded_price', -1.38, -1.375);
      expectSame('rounded_price', 0.12, 0.125);
      expectSame('rounded_price', 1.12, '1.125');
      expect(canonicalizerFor('rounded_price')(1.125)).toBe(1.12);
      expectDifferent('rounded_price', 1.13, 1.125);
    });

    it('rounds non-ties in DOUBLE(M,D) from their float64 value, with MySQL arithmetic', () => {
      expectSame('rounded_price', 2.67, 2.675); // 2.675 is 2.67499999… in binary
      expectSame('rounded_price', 1, 1.005);
      expectSame('rounded_price', 1.05, 1.055); // rint(1.055 * 100) would say 1.06
      expectSame('rounded_price', 12.35, 12.345);
      expectDifferent('rounded_price', 1.06, 1.055);
    });

    it('rounds a DOUBLE(M,0) tie DOWN, as MySQL does (its rint only sees the fraction)', () => {
      expectSame('whole_double', 0, 0.5);
      expectSame('whole_double', 1, 1.5);
      expectSame('whole_double', 2, 2.5);
      expectSame('whole_double', 3, 3.5);
      expectSame('whole_double', -1, -0.5);
      expectSame('whole_double', -2, -1.5);
      expectSame('whole_double', -3, -2.5);
      expectSame('whole_double', 1, 0.75);
      expectSame('whole_double', 3, 2.675);
      expectDifferent('whole_double', 2, 1.5);
      expectDifferent('whole_double', 0, -0.5);
    });

    it('compares DOUBLE at 15 significant digits', () => {
      expectSame('score', 0.3, 0.30000000000000004);
      expectSame('score', 3.5, '3.5');
      expectDifferent('score', 1.5, 1.6);
    });

    it('compares TINYINT(1) booleans as 1 / 0', () => {
      expectSame('is_active', 1, true);
      expectSame('is_active', 0, false);
      expectDifferent('is_active', 0, true);
    });

    it('compares integers exactly, accepting numeric text', () => {
      expectSame('quantity', 12, '12');
      expectSame('founded', 2026, 2026);
      expectDifferent('quantity', 12, 13);
      expectSame('quantity', null, '');
    });

    // Every stored value below is what MySQL 8.4 and MariaDB 11.4 return for the source value.
    it('rounds a fraction half AWAY from zero in integer columns, as MySQL stores it (not like Math.round)', () => {
      expectSame('quantity', 4, 3.7);
      expectSame('quantity', 3, 2.5);
      expectSame('quantity', -3, -2.5);
      expectSame('quantity', -1, -0.5);
      expectSame('quantity', 0, -0.4);
      expectSame('quantity', 4, '3.7');
      expectSame('quantity', 4, ' 3.7 ');
      expectSame('quantity', -3, '-2.5');
      expectSame('quantity', 3, '2.5e0');
      expectSame('quantity', 5, '0.5e1');
      expectSame('quantity', 1, '.5');
      expectSame('quantity', 0, '1e-7');
      expectSame('quantity', 0, 5e-7);
      expectSame('rating', 26, 25.5);
      expectSame('founded', 2025, 2024.5);
      expect(canonicalizerFor('quantity')(-2.5)).toBe(-3);
      expect(canonicalizerFor('quantity')(-0.4)).toBe(0);
      expectDifferent('quantity', 3, 3.5);
      expectDifferent('quantity', -2, -2.5);
    });

    it('rounds BIGINT fractions half away from zero in decimal text, exact beyond 2^53', () => {
      expectSame('big_id', '4', 3.7);
      expectSame('big_id', '-3', '-2.5');
      expectSame('big_id', '0', '-0.4');
      expectSame('big_id', '9007199254740994', '9007199254740993.5');
      expectDifferent('big_id', '9007199254740993', '9007199254740993.5');
      expect(canonicalizerFor('big_id')('-0.4')).toBe('0');
    });

    it('rounds whole-number DECIMAL columns (DECIMAL(p,0), a bare DECIMAL, DECIMAL(p)) half away from zero', () => {
      for (const fieldPath of ['whole_amount', 'bare_decimal', 'precision_only_decimal']) {
        expectSame(fieldPath, '4', 3.7);
        expectSame(fieldPath, '3', 2.5);
        expectSame(fieldPath, '-3', -2.5);
        expectSame(fieldPath, '3', '2.5e0');
        expectDifferent(fieldPath, '3', 3.5);
      }
    });
  });

  describe('ENUM / SET / CHAR', () => {
    it('case-folds an ENUM value to the declared member', () => {
      expectSame('stage', 'Mixed', 'MIXED');
      expectSame('stage', "it's", "IT'S");
      expectSame('stage', 'b\\c', 'B\\C');
      expectDifferent('stage', 'Mixed', 'other');
    });

    it('puts SET members in declared order, case-folded and de-duplicated', () => {
      expectSame('tags', 'x,z', 'z,x,X');
      expectSame('tags', 'x,y', 'y,x');
      expectSame('tags', '', '');
      expectDifferent('tags', 'x', 'x,q');
      expect(canonicalizerFor('tags')('x,q')).toBe('x,q');
    });

    it('drops the trailing spaces MySQL strips from CHAR values', () => {
      expectSame('country_code', 'ab', 'ab  ');
      expectDifferent('country_code', 'ab', ' ab');
    });
  });

  it('compares JSON documents as values', () => {
    expectSame('payload', { a: 2, b: [1, 2] }, '{"b":[1,2],"a":2}');
    expectSame('payload', { a: 2 }, { a: 2 });
    expectDifferent('payload', { a: 2 }, '{"a":3}');
    expectSame('payload', null, '');
  });

  // DEV-12415: the publish can deliver a number one float64 step off (DEV-12614), and MySQL stores what it was sent.
  it('compares numbers inside a JSON document that are not safe integers at 15 significant digits, like DOUBLE', () => {
    for (const fieldPath of ['payload', 'legacy_payload']) {
      expectSame(fieldPath, { big: 12345678901234570000 }, '{"big":12345678901234567000}');
      expectSame(fieldPath, { big: 12345678901234570000 }, { big: 12345678901234567000 });
      expectSame(fieldPath, { ratio: 0.3 }, { ratio: 0.30000000000000004 });
      expectSame(fieldPath, { a: [1, { b: 12345678901234570000 }] }, '{"a":[1,{"b":12345678901234567000}]}');
      expectSame(fieldPath, 12345678901234570000, 12345678901234567000);
      expectDifferent(fieldPath, { x: 1.5 }, { x: 1.6 });
      expectDifferent(fieldPath, { big: 12345678901234570000 }, { big: 12345678901235000000 });
    }
  });

  it('keeps safe integers and strings inside a JSON document exact', () => {
    expectDifferent('payload', { id: 1234567890123456 }, { id: 1234567890123457 });
    expectDifferent('payload', { id: 9007199254740991 }, { id: 9007199254740990 });
    expectDifferent('payload', { n: 2 }, { n: 3 });
    expectDifferent('payload', { s: '12345678901234567000' }, { s: '12345678901234570000' });
    expectDifferent('payload', [true, 'x'], [false, 'x']);
    const storedDocument = { nested: { big: 12345678901234567000, keep: 'text' } };
    expect(canonicalizerFor('payload')(storedDocument)).toEqual({
      nested: { big: 12345678901234600000, keep: 'text' },
    });
    expect(storedDocument).toEqual({ nested: { big: 12345678901234567000, keep: 'text' } });
  });

  describe('TIME compares as the literal the write path sends', () => {
    // Every stored value below is what MySQL 8.4 and MariaDB 11.4 return after the write path converted the source.
    it('adds seconds and truncates the fraction to the column precision', () => {
      expectSame('opens_at', '14:30:00', '14:30');
      expectSame('opens_at', '14:30:00', '14:30:00.5');
      expectSame('opens_at', '14:30:00', '14:30:00.999');
      expectSame('opens_at', '-01:00:00', '-01:00:00');
      expectSame('opens_at', '838:59:59', '838:59:59');
      expectSame('opens_at', '09:05:00', '9:05');
      expectSame('opens_at_with_milliseconds', '14:30:00.000', '14:30');
      expectSame('opens_at_with_milliseconds', '14:30:00.500', '14:30:00.5');
      expectSame('opens_at_with_milliseconds', '14:30:00.999', '14:30:00.999');
      expectSame('opens_at_with_milliseconds', '-01:00:00.000', '-01:00:00');
      expectSame('opens_at_with_milliseconds', '838:59:59.000', '838:59:59');
      expectDifferent('opens_at', '14:30:01', '14:30:00.999');
      expectDifferent('opens_at_with_milliseconds', '14:30:00.500', '14:30:00.501');
    });

    it("maps '' to NULL (the write path writes '' as NULL)", () => {
      expectSame('opens_at', null, '');
      expectSame('opens_at_with_milliseconds', null, undefined);
    });

    it('passes shapes it leaves to MySQL, and non-strings, through unchanged', () => {
      expect(canonicalizerFor('opens_at')('1 12:00:00')).toBe('1 12:00:00');
      expect(canonicalizerFor('opens_at')('839:00:00')).toBe('839:00:00');
      expect(canonicalizerFor('opens_at')(143000)).toBe(143000);
      expectDifferent('opens_at', '36:00:00', '1 12:00:00');
    });
  });

  it('is total: never throws on unexpected shapes', () => {
    const unexpectedValues: unknown[] = [
      undefined,
      null,
      '',
      '   ',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      {},
      [],
      ['a'],
      { nested: { deep: true } },
      BigInt(5),
      '1e400',
      '--1',
      '.',
      '9'.repeat(400),
    ];
    for (const canonicalizer of canonicalizerByFieldPath.values()) {
      for (const unexpectedValue of unexpectedValues) {
        expect(() => canonicalizer(unexpectedValue)).not.toThrow();
      }
    }
  });
});

describe('mysqlFieldValueCanonicalizerForNativeColumnType', () => {
  it.each(['varchar(255)', 'text', 'longtext', 'uuid', 'binary(16)', "enum('unterminated)"])(
    'declares nothing for %s',
    (nativeColumnType) => {
      expect(mysqlFieldValueCanonicalizerForNativeColumnType(nativeColumnType)).toBeUndefined();
    },
  );

  it.each(['time', 'time(3)', 'TIME(6)'])('declares the TIME literal canonicalizer for %s', (nativeColumnType) => {
    const timeCanonicalizer = mysqlFieldValueCanonicalizerForNativeColumnType(nativeColumnType);
    expect(timeCanonicalizer?.('14:30')).toMatch(/^14:30:00(\.0+)?$/);
  });

  it.each([
    ['tinyint', 4],
    ['tinyint unsigned', 4],
    ['smallint', 4],
    ['mediumint(9)', 4],
    ['int', 4],
    ['int(11) unsigned', 4],
    ['bigint', '4'],
    ['bigint(20) unsigned', '4'],
    ['year', 4],
    ['decimal(10,0)', '4'],
  ])('rounds 3.7 half away from zero for %s → %j', (nativeColumnType, expectedCanonicalValue) => {
    const integerCanonicalizer = mysqlFieldValueCanonicalizerForNativeColumnType(nativeColumnType);
    expect(integerCanonicalizer?.(3.7)).toBe(expectedCanonicalValue);
    expect(integerCanonicalizer?.(-2.5)).toBe(typeof expectedCanonicalValue === 'string' ? '-3' : -3);
  });
});

describe('parseMySqlEnumOrSetColumnTypeMembers', () => {
  it.each([
    ["enum('a','b')", ['a', 'b']],
    ["enum('a','it''s','b\\\\c','Mixed')", ['a', "it's", 'b\\c', 'Mixed']],
    ["set('x','y','z')", ['x', 'y', 'z']],
    ["enum('')", ['']],
    ["ENUM('a, b','c')", ['a, b', 'c']],
    ["enum('\\'quoted\\'')", ["'quoted'"]],
  ])('parses %j', (columnTypeSpelling, expectedMembers) => {
    expect(parseMySqlEnumOrSetColumnTypeMembers(columnTypeSpelling)).toEqual(expectedMembers);
  });

  it.each(["enum('a'", "enum('a',)", 'enum(a,b)', "enum('a''", "enum('\\n')", 'enum()', 'varchar(10)', "enum('a')x"])(
    'is undefined for malformed %j',
    (columnTypeSpelling) => {
      expect(parseMySqlEnumOrSetColumnTypeMembers(columnTypeSpelling)).toBeUndefined();
    },
  );
});
