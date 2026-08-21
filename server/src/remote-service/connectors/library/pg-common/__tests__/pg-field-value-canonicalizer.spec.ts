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
// Register both SQL connectors with the registry (their shared canonicalizer hook
// is deliberately NOT registered yet — see the DEV-10556 comments in their
// `connectorRegistry.register` blocks).
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
    // A timestamp written into a `date` column really does lose the time of day (DEV-11086) — not hidden.
    expectDifferent(PostgresColumnType.TIMESTAMP, '2026-03-14T00:00:00.000Z', '2026-03-14T15:09:26.535Z');
    expectSame(PostgresColumnType.TIMESTAMP, null, null);
    expectDifferent(PostgresColumnType.TIMESTAMP, '2026-03-14T00:00:00.000Z', null);
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

describe('Postgres / Supabase resolver on an annotated table spec (hook written but not registered — DEV-10556)', () => {
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
        price: column('double precision', 'float8'),
        amount: column('numeric', 'numeric'),
        payload: column('jsonb', 'jsonb'),
        active: column('boolean', 'bool'),
      }),
    } as unknown as BaseJsonTableSpec;
  }

  it.each([Service.POSTGRES, Service.SUPABASE])(
    'is NOT registered with the connector registry yet — the registry resolves nothing for %s',
    (service) => {
      expect(resolveFieldValueCanonicalizersForTable(service, buildTableSpec()).size).toBe(0);
    },
  );

  it('resolves canonicalizers for the re-rendered column families when run directly', () => {
    // Run the (unregistered) resolver over the spec's fields the way the registry helper would.
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

    expect([...canonicalizers.keys()].sort()).toEqual(['amount', 'created_at', 'id', 'payload', 'price'].sort());
    expect(canonicalizers.has('name')).toBe(false);
    expect(canonicalizers.has('active')).toBe(false);

    const createdAt = canonicalizers.get('created_at');
    if (!createdAt) throw new Error('expected a canonicalizer for created_at');
    expect(areFieldValuesCanonicallyEqual(createdAt, '2026-07-23T21:12:27.000Z', '2026-07-23T21:12:27Z')).toBe(true);
  });
});
