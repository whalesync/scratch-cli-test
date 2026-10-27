/**
 * Runs in America/New_York: the bug only shows when the Node process isn't in UTC (DEV-12576), and CI runs in UTC.
 * The zone has to be set by the test environment; assigning `process.env.TZ` inside a spec has no effect.
 *
 * @jest-environment <rootDir>/../test/jest-environments/node-environment-in-fixed-time-zone.ts
 * @jest-environment-options {"timeZone": "America/New_York"}
 */
import { types as nodePostgresDefaultTypeParsers } from 'pg';
import { NODE_POSTGRES_TYPE_PARSERS_FOR_CONNECTOR_CONNECTIONS } from '../pg-temporal-type-parsers';

const POSTGRES_INTEGER_TYPE_OID = 23;
const POSTGRES_DATE_TYPE_OID = 1082;
const POSTGRES_DATE_ARRAY_TYPE_OID = 1182;
const POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID = 1114;
const POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_ARRAY_TYPE_OID = 1115;
const POSTGRES_TIMESTAMP_WITH_TIME_ZONE_TYPE_OID = 1184;
const POSTGRES_NUMERIC_TYPE_OID = 1700;

function parseWithConnectorTypeParsers(oid: number, postgresTextValue: string): unknown {
  const parsePostgresTextValue = NODE_POSTGRES_TYPE_PARSERS_FOR_CONNECTOR_CONNECTIONS.getTypeParser(oid, 'text') as (
    postgresTextValue: string,
  ) => unknown;
  return parsePostgresTextValue(postgresTextValue);
}

function isoStringOf(parsedValue: unknown): string {
  if (!(parsedValue instanceof Date)) throw new Error(`expected a Date, got ${String(parsedValue)}`);
  return parsedValue.toISOString();
}

describe('NODE_POSTGRES_TYPE_PARSERS_FOR_CONNECTOR_CONNECTIONS on a non-UTC host (DEV-12576)', () => {
  it('runs in a zone where the driver default parses a date as local midnight (control)', () => {
    const parseDateWithDriverDefault = nodePostgresDefaultTypeParsers.getTypeParser(POSTGRES_DATE_TYPE_OID, 'text') as (
      postgresTextValue: string,
    ) => unknown;
    expect(isoStringOf(parseDateWithDriverDefault('1965-07-31'))).toBe('1965-07-31T04:00:00.000Z');
  });

  it('keeps a date as the verbatim YYYY-MM-DD text, including values a Date cannot hold', () => {
    expect(parseWithConnectorTypeParsers(POSTGRES_DATE_TYPE_OID, '1965-07-31')).toBe('1965-07-31');
    expect(parseWithConnectorTypeParsers(POSTGRES_DATE_TYPE_OID, '0100-01-01')).toBe('0100-01-01');
    expect(parseWithConnectorTypeParsers(POSTGRES_DATE_TYPE_OID, '0044-03-15 BC')).toBe('0044-03-15 BC');
    expect(parseWithConnectorTypeParsers(POSTGRES_DATE_TYPE_OID, 'infinity')).toBe('infinity');
  });

  it('keeps every element of a date[] as verbatim text, with NULL as null', () => {
    expect(parseWithConnectorTypeParsers(POSTGRES_DATE_ARRAY_TYPE_OID, '{1965-07-31,NULL,2026-12-31}')).toEqual([
      '1965-07-31',
      null,
      '2026-12-31',
    ]);
    expect(parseWithConnectorTypeParsers(POSTGRES_DATE_ARRAY_TYPE_OID, '{{2026-01-01},{2026-01-02}}')).toEqual([
      ['2026-01-01'],
      ['2026-01-02'],
    ]);
    expect(parseWithConnectorTypeParsers(POSTGRES_DATE_ARRAY_TYPE_OID, '{}')).toEqual([]);
  });

  it('parses a timestamp without time zone as UTC wall-clock, whatever the host zone', () => {
    expect(
      isoStringOf(
        parseWithConnectorTypeParsers(POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID, '2026-08-05 04:30:15.123456'),
      ),
    ).toBe('2026-08-05T04:30:15.123Z');
    expect(
      isoStringOf(parseWithConnectorTypeParsers(POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID, '9999-12-31 23:59:59')),
    ).toBe('9999-12-31T23:59:59.000Z');
    // The local-time parse picked up the zone's historical LMT offset for early years.
    expect(
      isoStringOf(parseWithConnectorTypeParsers(POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID, '0100-01-01 00:00:00')),
    ).toBe('0100-01-01T00:00:00.000Z');
  });

  it('keeps the driver handling of BC years and infinity for a timestamp without time zone', () => {
    expect(
      isoStringOf(
        parseWithConnectorTypeParsers(POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID, '0044-03-15 12:00:00 BC'),
      ),
    ).toBe('-000043-03-15T12:00:00.000Z');
    expect(parseWithConnectorTypeParsers(POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID, 'infinity')).toBe(Infinity);
    expect(parseWithConnectorTypeParsers(POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID, '-infinity')).toBe(-Infinity);
  });

  it('parses every element of a timestamp[] as UTC wall-clock, with NULL as null', () => {
    const parsedTimestampArray = parseWithConnectorTypeParsers(
      POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_ARRAY_TYPE_OID,
      '{"2026-01-02 03:04:05.5",NULL}',
    );
    if (!Array.isArray(parsedTimestampArray)) throw new Error('expected an array');
    expect(parsedTimestampArray).toHaveLength(2);
    expect(isoStringOf(parsedTimestampArray[0])).toBe('2026-01-02T03:04:05.500Z');
    expect(parsedTimestampArray[1]).toBeNull();
  });

  it('leaves timestamp with time zone and every other type to the driver', () => {
    expect(
      isoStringOf(
        parseWithConnectorTypeParsers(POSTGRES_TIMESTAMP_WITH_TIME_ZONE_TYPE_OID, '2026-08-05 04:30:15.987+05:30'),
      ),
    ).toBe('2026-08-04T23:00:15.987Z');
    expect(parseWithConnectorTypeParsers(POSTGRES_INTEGER_TYPE_OID, '42')).toBe(42);
    expect(parseWithConnectorTypeParsers(POSTGRES_NUMERIC_TYPE_OID, '9007199254740993.10')).toBe('9007199254740993.10');
    expect(NODE_POSTGRES_TYPE_PARSERS_FOR_CONNECTOR_CONNECTIONS.getTypeParser(POSTGRES_DATE_TYPE_OID, 'binary')).toBe(
      nodePostgresDefaultTypeParsers.getTypeParser(POSTGRES_DATE_TYPE_OID, 'binary'),
    );
  });

  it('does not change the process-global driver parsers', () => {
    const parseDateWithDriverDefault = nodePostgresDefaultTypeParsers.getTypeParser(POSTGRES_DATE_TYPE_OID, 'text') as (
      postgresTextValue: string,
    ) => unknown;
    expect(parseDateWithDriverDefault('1965-07-31')).toBeInstanceOf(Date);
  });
});
