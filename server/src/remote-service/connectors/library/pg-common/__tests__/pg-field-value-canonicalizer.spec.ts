import { Type } from '@sinclair/typebox';
import { PostgresColumnType, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import {
  areFieldValuesCanonicallyEqual,
  FieldValueCanonicalizerContext,
  resolveFieldValueCanonicalizersForTable,
} from 'src/remote-service/connectors/field-value-canonicalization';
import { Service } from 'src/remote-service/connectors/service-constants';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { getSchemaAtFieldPath } from 'src/utils/field-path';
import { extractSchemaFields } from 'src/utils/schema-helpers';
import {
  pgFieldValueCanonicalizerForColumnType,
  resolvePgFieldValueCanonicalizer,
} from '../pg-field-value-canonicalizer';
import { mapPgType } from '../pg-type-mapping';
// Registers both SQL connectors (and their shared canonicalizer hook) with the registry.
import '../../postgres/postgres-connector';
import '../../supabase/supabase-connector';

function expectSame(pgType: string, pulled: unknown, written: unknown): void {
  const canonicalizer = pgFieldValueCanonicalizerForColumnType(pgType);
  if (!canonicalizer) throw new Error(`expected a canonicalizer for ${pgType}`);
  expect(areFieldValuesCanonicallyEqual(canonicalizer, pulled, written)).toBe(true);
}

function expectDifferent(pgType: string, pulled: unknown, written: unknown): void {
  const canonicalizer = pgFieldValueCanonicalizerForColumnType(pgType);
  if (!canonicalizer) throw new Error(`expected a canonicalizer for ${pgType}`);
  expect(areFieldValuesCanonicallyEqual(canonicalizer, pulled, written)).toBe(false);
}

describe('pgFieldValueCanonicalizerForColumnType', () => {
  it('compares timestamp columns as instants, so the driver rendering and the source rendering agree', () => {
    expectSame(PostgresColumnType.TIMESTAMP, '2026-07-23T21:12:27.000Z', '2026-07-23T21:12:27Z');
    expectSame(PostgresColumnType.TIMESTAMP, '2026-07-23T21:12:27.000Z', '2026-07-23T21:12:27+00:00');
    expectSame(PostgresColumnType.TIMESTAMP, '2026-07-23T23:12:27.000+02:00', '2026-07-23T21:12:27Z');
    expectDifferent(PostgresColumnType.TIMESTAMP, '2026-07-23T21:12:27.000Z', '2026-07-23T21:12:28Z');
    expectDifferent(PostgresColumnType.TIMESTAMP, '2026-03-14T00:00:00.000Z', '2026-03-14T15:09:26.535Z');
    expectSame(PostgresColumnType.TIMESTAMP, null, null);
    expectDifferent(PostgresColumnType.TIMESTAMP, '2026-03-14T00:00:00.000Z', null);
  });

  describe('date columns (TIMESTAMP family, format: date — DEV-12576)', () => {
    function expectSameDate(pulled: unknown, written: unknown): void {
      const canonicalizer = pgFieldValueCanonicalizerForColumnType(PostgresColumnType.TIMESTAMP, 'date');
      if (!canonicalizer) throw new Error('expected a canonicalizer for a date column');
      expect(areFieldValuesCanonicallyEqual(canonicalizer, pulled, written)).toBe(true);
    }
    function expectDifferentDate(pulled: unknown, written: unknown): void {
      const canonicalizer = pgFieldValueCanonicalizerForColumnType(PostgresColumnType.TIMESTAMP, 'date');
      if (!canonicalizer) throw new Error('expected a canonicalizer for a date column');
      expect(areFieldValuesCanonicallyEqual(canonicalizer, pulled, written)).toBe(false);
    }

    it('matches a pulled YYYY-MM-DD against the same date-only source value', () => {
      expectSameDate('1965-07-31', '1965-07-31');
      expectDifferentDate('1965-07-31', '1965-08-01');
    });

    it('matches a source date-time by the literal date Postgres stores, ignoring time of day and offset', () => {
      expectSameDate('2026-12-25', '2026-12-25T00:00:00.000Z');
      expectSameDate('2026-03-14', '2026-03-14T15:09:26.535Z');
      // Postgres keeps the written date, not the UTC day: `'2026-06-30T23:30:00-05:00'::date` is 2026-06-30.
      expectSameDate('2026-06-30', '2026-06-30T23:30:00-05:00');
      expectSameDate('2026-06-30', '2026-06-30 01:30:00+09');
    });

    it('matches a value pulled before DEV-12576 (a local-midnight instant) by its leading date', () => {
      expectSameDate('1965-07-31T00:00:00.000Z', '1965-07-31');
      expectSameDate('1965-07-31T04:00:00.000Z', '1965-07-31');
    });

    it('compares non-ISO text and non-strings structurally', () => {
      expectSameDate('0044-03-15 BC', '0044-03-15 BC');
      expectDifferentDate('0044-03-15 BC', '0044-03-15');
      expectSameDate('infinity', 'infinity');
      expectSameDate(null, null);
      expectDifferentDate('2026-03-14', null);
    });

    it('keeps the instant compare for a timestamp column (format: date-time)', () => {
      const timestampColumnCanonicalizer = pgFieldValueCanonicalizerForColumnType(
        PostgresColumnType.TIMESTAMP,
        'date-time',
      );
      if (!timestampColumnCanonicalizer) throw new Error('expected a canonicalizer for a timestamp column');
      expect(
        areFieldValuesCanonicallyEqual(
          timestampColumnCanonicalizer,
          '2026-03-14T00:00:00.000Z',
          '2026-03-14T15:09:26.535Z',
        ),
      ).toBe(false);
    });
  });

  it('compares float columns at 15 significant digits', () => {
    expectSame(PostgresColumnType.NUMERIC, 0.30000000000000004, 0.3);
    expectSame(PostgresColumnType.NUMERIC, 42, 42);
    expectDifferent(PostgresColumnType.NUMERIC, 1.5, 1.6);
    expectDifferent(PostgresColumnType.NUMERIC, 0, null);
  });

  it('compares arbitrary-precision numeric strings as normalised decimal text, never through a float', () => {
    expectSame(PostgresColumnType.NUMERIC_STRING, '1.50', 1.5);
    expectSame(PostgresColumnType.NUMERIC_STRING, '1.50', '1.5');
    expectSame(PostgresColumnType.NUMERIC_STRING, '9007199254740993', '9007199254740993');
    expectSame(PostgresColumnType.NUMERIC_STRING, '007', 7);
    expectSame(PostgresColumnType.NUMERIC_STRING, '-0.0', '0');
    // Differ only beyond float64 precision: a real difference, kept.
    expectDifferent(PostgresColumnType.NUMERIC_STRING, '9007199254740993', '9007199254740994');
    expectDifferent(PostgresColumnType.NUMERIC_STRING, '9007199254740993', 9007199254740992);
    expectDifferent(PostgresColumnType.NUMERIC_STRING, '1.5', '1.55');
  });

  it('compares json/jsonb columns as values regardless of serialisation', () => {
    expectSame(PostgresColumnType.JSONB, '{"b":[1,2],"a":1}', '{"a": 1, "b": [1, 2]}');
    expectSame(PostgresColumnType.JSONB, { a: 1, b: [1, 2] }, '{"a":1,"b":[1,2]}');
    expectDifferent(PostgresColumnType.JSONB, '{"a":1}', '{"a":2}');
    expectSame(PostgresColumnType.JSONB, 'not json', 'not json');
  });

  it('declares nothing for text, boolean and array columns', () => {
    for (const pgType of [
      PostgresColumnType.TEXT,
      PostgresColumnType.TEXT_ARRAY,
      PostgresColumnType.BOOLEAN,
      PostgresColumnType.BOOLEAN_ARRAY,
      PostgresColumnType.NUMERIC_ARRAY,
      'no_such_type',
    ]) {
      expect(pgFieldValueCanonicalizerForColumnType(pgType)).toBeUndefined();
    }
  });
});

describe('Postgres / Supabase resolver on an annotated table spec (registered — DEV-10556 / DEV-11420)', () => {
  /** Mirrors what both connectors' `fetchJsonTableSpec` build: a flat object of columns annotated with their pg type. */
  function buildTableSpec(): BaseJsonTableSpec {
    const column = (dataType: string, udtName: string) => {
      const { schema, pgType } = mapPgType(dataType, udtName, true);
      return { ...schema, [X_SCRATCH_CONNECTOR_DATA_TYPE]: pgType };
    };
    return {
      schema: Type.Object({
        id: column('integer', 'int4'),
        name: column('text', 'text'),
        created_at: column('timestamp with time zone', 'timestamptz'),
        due_on: column('date', 'date'),
        price: column('double precision', 'float8'),
        amount: column('numeric', 'numeric'),
        payload: column('jsonb', 'jsonb'),
        active: column('boolean', 'bool'),
      }),
    } as unknown as BaseJsonTableSpec;
  }

  it.each([Service.POSTGRES, Service.SUPABASE])(
    'is registered with the connector registry — the registry resolves the re-rendered column families for %s',
    (service) => {
      const registered = resolveFieldValueCanonicalizersForTable(service, buildTableSpec());
      expect([...registered.keys()].sort()).toEqual(
        ['amount', 'created_at', 'due_on', 'id', 'payload', 'price'].sort(),
      );
      const createdAt = registered.get('created_at');
      if (!createdAt) throw new Error('expected a canonicalizer for created_at');
      expect(areFieldValuesCanonicallyEqual(createdAt, '2026-07-23T21:12:27.000Z', '2026-07-23T21:12:27Z')).toBe(true);
      // The `date` column resolves the day-granular compare from its `format: 'date'` (DEV-12576).
      const dueOn = registered.get('due_on');
      if (!dueOn) throw new Error('expected a canonicalizer for due_on');
      expect(areFieldValuesCanonicallyEqual(dueOn, '1965-07-31', '1965-07-31')).toBe(true);
      expect(areFieldValuesCanonicallyEqual(dueOn, '1965-07-31', '1965-07-31T00:00:00.000Z')).toBe(true);
      // Only the day-granular compare makes these equal, so this fails if the format never reaches the resolver.
      expect(areFieldValuesCanonicallyEqual(dueOn, '2026-03-14', '2026-03-14T15:09:26.535Z')).toBe(true);
      expect(areFieldValuesCanonicallyEqual(createdAt, '2026-03-14T00:00:00.000Z', '2026-03-14T15:09:26.535Z')).toBe(
        false,
      );
    },
  );

  it('resolves canonicalizers for the re-rendered column families when run directly', () => {
    // Run the resolver directly over the spec's fields the way the registry helper would.
    const tableSpec = buildTableSpec();
    const canonicalizers = new Map<string, (value: unknown) => unknown>();
    for (const schemaField of extractSchemaFields(tableSpec.schema)) {
      const context: FieldValueCanonicalizerContext = {
        fieldPath: schemaField.path,
        fieldSchema: getSchemaAtFieldPath(tableSpec.schema, schemaField.path),
        schemaField,
        tableSpec,
      };
      const canonicalizer = resolvePgFieldValueCanonicalizer(context);
      if (canonicalizer) canonicalizers.set(schemaField.path, canonicalizer);
    }

    expect([...canonicalizers.keys()].sort()).toEqual(
      ['amount', 'created_at', 'due_on', 'id', 'payload', 'price'].sort(),
    );
    expect(canonicalizers.has('name')).toBe(false);
    expect(canonicalizers.has('active')).toBe(false);

    const createdAt = canonicalizers.get('created_at');
    if (!createdAt) throw new Error('expected a canonicalizer for created_at');
    expect(areFieldValuesCanonicallyEqual(createdAt, '2026-07-23T21:12:27.000Z', '2026-07-23T21:12:27Z')).toBe(true);
  });
});
