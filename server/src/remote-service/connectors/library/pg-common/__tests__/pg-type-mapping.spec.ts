import { type TSchema } from '@sinclair/typebox';
import { PostgresColumnType } from '@spinner/shared-types';
import { mapPgType, mapScalarPgType } from '../pg-type-mapping';

/** A structural view of the (possibly nullable) string-column schemas this module emits. */
type StringColumnSchema = { format?: string; anyOf?: { type?: string; format?: string }[] };

const asColumnSchema = (schema: TSchema): StringColumnSchema => schema as StringColumnSchema;

/** Read the JSON Schema `format` of a (possibly null-unioned) string column schema. */
function stringFormatOf(schema: TSchema): string | undefined {
  const columnSchema = asColumnSchema(schema);
  if (columnSchema.format !== undefined) return columnSchema.format;
  return columnSchema.anyOf?.find((member) => member.type === 'string')?.format;
}

describe('mapScalarPgType', () => {
  it('maps numeric types to a number with the NUMERIC connector type', () => {
    const { schema, pgType } = mapScalarPgType('integer');
    expect((schema as { type?: string }).type).toBe('number');
    expect(pgType).toBe(PostgresColumnType.NUMERIC);
  });

  it('maps timestamp types to String(format: date-time)', () => {
    for (const timestampType of ['timestamp', 'timestamptz', 'timestamp with time zone']) {
      const { schema, pgType } = mapScalarPgType(timestampType);
      expect(stringFormatOf(schema)).toBe('date-time');
      expect(pgType).toBe(PostgresColumnType.TIMESTAMP);
    }
  });

  // DEV-10453: the node-postgres driver parses a `date` column (OID 1082) into a JS Date, which
  // serializes to a full RFC 3339 date-time on disk (e.g. "1944-11-19T00:00:00.000Z"), never
  // YYYY-MM-DD. So a `date` column must be typed `format: 'date-time'` to match the stored value;
  // `format: 'date'` would reject every verbatim record.
  it('maps a date column to String(format: date-time), matching how the driver materializes it', () => {
    const { schema, pgType } = mapScalarPgType('date');
    expect(stringFormatOf(schema)).toBe('date-time');
    expect(pgType).toBe(PostgresColumnType.TIMESTAMP);
  });
});

describe('mapPgType', () => {
  it('wraps a nullable date column as a date-time string unioned with null', () => {
    const { schema } = mapPgType('date', 'date', true);
    const columnSchema = asColumnSchema(schema);
    expect(columnSchema.anyOf).toHaveLength(2);
    expect(stringFormatOf(schema)).toBe('date-time');
    expect(columnSchema.anyOf?.some((member) => member.type === 'null')).toBe(true);
  });

  it('keeps a non-nullable date column as a bare date-time string', () => {
    const { schema } = mapPgType('date', 'date', false);
    expect(asColumnSchema(schema).anyOf).toBeUndefined();
    expect(stringFormatOf(schema)).toBe('date-time');
  });
});
