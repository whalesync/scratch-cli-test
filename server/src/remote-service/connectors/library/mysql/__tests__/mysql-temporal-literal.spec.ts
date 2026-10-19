import { type MySqlTemporalColumnType } from '../mysql-native-column-type';
import {
  convertRecognizedTimeTextToMySqlTimeLiteral,
  convertTemporalValueToMySqlLiteral,
  readMySqlTimeColumnFractionalSecondsPrecision,
} from '../mysql-temporal-literal';

const DATE_COLUMN: MySqlTemporalColumnType = { temporalKind: 'date' };
const DATETIME_COLUMN_WITHOUT_FRACTION: MySqlTemporalColumnType = {
  temporalKind: 'datetime',
  fractionalSecondsPrecision: 0,
};
const DATETIME_COLUMN_WITH_MILLISECONDS: MySqlTemporalColumnType = {
  temporalKind: 'datetime',
  fractionalSecondsPrecision: 3,
};
const DATETIME_COLUMN_WITH_UNKNOWN_PRECISION: MySqlTemporalColumnType = {
  temporalKind: 'datetime',
  fractionalSecondsPrecision: undefined,
};
const TIMESTAMP_COLUMN_WITH_MICROSECONDS: MySqlTemporalColumnType = {
  temporalKind: 'timestamp',
  fractionalSecondsPrecision: 6,
};

function expectConvertedLiteral(value: string, columnType: MySqlTemporalColumnType, expectedMySqlLiteral: string) {
  expect(convertTemporalValueToMySqlLiteral(value, columnType)).toEqual({
    outcome: 'converted',
    mySqlLiteral: expectedMySqlLiteral,
  });
}

function expectRejectionReason(value: string, columnType: MySqlTemporalColumnType): string {
  const conversion = convertTemporalValueToMySqlLiteral(value, columnType);
  if (conversion.outcome !== 'rejected') {
    throw new Error(`expected "${value}" to be rejected, got ${JSON.stringify(conversion)}`);
  }
  return conversion.rejectionReason;
}

describe('convertTemporalValueToMySqlLiteral', () => {
  describe('DATETIME / TIMESTAMP', () => {
    it('keeps the wall clock of naive values in the T and space forms', () => {
      expectConvertedLiteral('2026-03-05T14:30:05', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:05');
      expectConvertedLiteral('2026-03-05 14:30:05', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:05');
      expectConvertedLiteral('2026-03-05t14:30:05', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:05');
    });

    it('adds missing seconds and turns a date-only value into midnight', () => {
      expectConvertedLiteral('2026-03-05T14:30', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:00');
      expectConvertedLiteral('2026-03-05', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 00:00:00');
    });

    it('trims surrounding whitespace', () => {
      expectConvertedLiteral('  2026-03-05 14:30:05  ', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:05');
    });

    it('keeps the wall clock of Z / z / -00:00 values (already UTC)', () => {
      expectConvertedLiteral('2026-03-05T14:30:00Z', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:00');
      expectConvertedLiteral('2026-03-05T14:30:00z', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:00');
      expectConvertedLiteral('2026-03-05T14:30:00-00:00', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 14:30:00');
    });

    it('converts ±hh:mm, ±hhmm and ±hh offsets to the UTC wall clock', () => {
      expectConvertedLiteral('2026-03-05T14:30:00+05:30', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 09:00:00');
      expectConvertedLiteral('2026-03-05T14:30:00-0800', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 22:30:00');
      expectConvertedLiteral('2026-03-05T14:30:00+05', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 09:30:00');
      expectConvertedLiteral('2026-03-05 14:30:00 +01:00', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-05 13:30:00');
    });

    it('rolls the day, the month (leap day included) and the year over when the offset crosses midnight', () => {
      expectConvertedLiteral('2026-03-05T02:00:00+05:00', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-03-04 21:00:00');
      expectConvertedLiteral('2024-03-01T01:00:00+02:00', DATETIME_COLUMN_WITHOUT_FRACTION, '2024-02-29 23:00:00');
      expectConvertedLiteral('2026-12-31T23:30:00-05:00', DATETIME_COLUMN_WITHOUT_FRACTION, '2027-01-01 04:30:00');
    });

    it('carries fractional seconds through an offset conversion unchanged', () => {
      expectConvertedLiteral(
        '2026-03-05T14:30:00.123456-05:00',
        TIMESTAMP_COLUMN_WITH_MICROSECONDS,
        '2026-03-05 19:30:00.123456',
      );
      expectConvertedLiteral(
        '2026-03-05T14:30:00.25+01:00',
        DATETIME_COLUMN_WITH_MILLISECONDS,
        '2026-03-05 13:30:00.250',
      );
    });

    it("TRUNCATES the fraction to the column's precision (never rounds into the next second, day or year)", () => {
      expectConvertedLiteral(
        '2026-03-05T14:30:00.9999999Z',
        DATETIME_COLUMN_WITH_MILLISECONDS,
        '2026-03-05 14:30:00.999',
      );
      expectConvertedLiteral('2026-12-31T23:59:59.9999Z', DATETIME_COLUMN_WITHOUT_FRACTION, '2026-12-31 23:59:59');
    });

    it("pads the fraction to the column's precision so the literal is canonical", () => {
      expectConvertedLiteral('2026-03-05T14:30:00Z', DATETIME_COLUMN_WITH_MILLISECONDS, '2026-03-05 14:30:00.000');
      expectConvertedLiteral('2026-03-05 14:30:00.5', TIMESTAMP_COLUMN_WITH_MICROSECONDS, '2026-03-05 14:30:00.500000');
    });

    it('keeps up to 6 fractional digits when the precision is unknown', () => {
      expectConvertedLiteral(
        '2026-03-05T14:30:00.1234567Z',
        DATETIME_COLUMN_WITH_UNKNOWN_PRECISION,
        '2026-03-05 14:30:00.123456',
      );
      expectConvertedLiteral(
        '2026-03-05T14:30:00.12Z',
        DATETIME_COLUMN_WITH_UNKNOWN_PRECISION,
        '2026-03-05 14:30:00.12',
      );
      expectConvertedLiteral('2026-03-05T14:30:00Z', DATETIME_COLUMN_WITH_UNKNOWN_PRECISION, '2026-03-05 14:30:00');
    });

    it('treats TIMESTAMP columns exactly like DATETIME columns', () => {
      expectConvertedLiteral(
        '2026-12-31T23:30:00.1234567+01:00',
        TIMESTAMP_COLUMN_WITH_MICROSECONDS,
        '2026-12-31 22:30:00.123456',
      );
    });

    it('accepts a real leap day', () => {
      expectConvertedLiteral('2024-02-29T12:00:00', DATETIME_COLUMN_WITHOUT_FRACTION, '2024-02-29 12:00:00');
    });

    it("writes zero dates in the column's own shape (how MySQL reads them back)", () => {
      expectConvertedLiteral('0000-00-00 00:00:00', DATETIME_COLUMN_WITHOUT_FRACTION, '0000-00-00 00:00:00');
      expectConvertedLiteral('0000-00-00', TIMESTAMP_COLUMN_WITH_MICROSECONDS, '0000-00-00 00:00:00.000000');
      expectConvertedLiteral('0000-00-00T00:00:00.000', DATETIME_COLUMN_WITH_MILLISECONDS, '0000-00-00 00:00:00.000');
      expectConvertedLiteral('0000-00-00 00:00:00', DATE_COLUMN, '0000-00-00');
    });

    it('keeps years before 100 (Date.UTC would map them to 19xx)', () => {
      expectConvertedLiteral('0050-06-01T12:00:00+02:00', DATETIME_COLUMN_WITHOUT_FRACTION, '0050-06-01 10:00:00');
      expectConvertedLiteral('0004-02-29', DATE_COLUMN, '0004-02-29');
    });

    it('rejects an offset that pushes the value past year 9999', () => {
      expect(expectRejectionReason('9999-12-31T23:30:00-05:00', DATETIME_COLUMN_WITHOUT_FRACTION)).toContain(
        'DATETIME column',
      );
    });
  });

  describe('DATE', () => {
    it('keeps a calendar date verbatim', () => {
      expectConvertedLiteral('2026-03-05', DATE_COLUMN, '2026-03-05');
      expectConvertedLiteral('2024-02-29', DATE_COLUMN, '2024-02-29');
    });

    it('takes the LITERAL date part of a midnight date-time, whatever its offset', () => {
      expectConvertedLiteral('2026-03-05T00:00:00+05:00', DATE_COLUMN, '2026-03-05');
      expectConvertedLiteral('2026-03-05T00:00:00.000Z', DATE_COLUMN, '2026-03-05');
      expectConvertedLiteral('2026-03-05 00:00', DATE_COLUMN, '2026-03-05');
      expectConvertedLiteral('2026-03-05-08:00', DATE_COLUMN, '2026-03-05');
    });

    it('rejects a date-time with a time of day instead of silently dropping it', () => {
      const rejectionReason = expectRejectionReason('2026-03-05T14:30:00Z', DATE_COLUMN);
      expect(rejectionReason).toBe(
        '"2026-03-05T14:30:00Z" includes a time of day, but this is a DATE column. Send a calendar date (YYYY-MM-DD), or change the column to DATETIME.',
      );
      expect(expectRejectionReason('2026-03-05T00:00:00.001Z', DATE_COLUMN)).toContain('includes a time of day');
    });

    it('passes a zero date through verbatim', () => {
      expectConvertedLiteral('0000-00-00', DATE_COLUMN, '0000-00-00');
    });
  });

  describe('rejections', () => {
    it.each([
      ['not a date'],
      [''],
      ['03/05/2026'],
      ['2026/03/05'],
      ['2026-3-5'],
      ['2026-W10-4'],
      ['20260305'],
      ['2026-13-01'],
      ['2026-00-10'],
      ['2026-02-29'],
      ['2026-04-31'],
      ['2026-03-05T24:00:00'],
      ['2026-03-05T14:60:00'],
      ['2026-03-05T23:59:60'],
      ['2026-03-05T14:30:00+24:00'],
      ['2026-03-05T14:30:00+05:60'],
      ['2026-03-05T14:30:00 PST'],
    ])('rejects %j for DATETIME and DATE columns', (value) => {
      expect(expectRejectionReason(value, DATETIME_COLUMN_WITH_MILLISECONDS)).toBe(
        `"${value}" isn't a value MySQL can store in a DATETIME column. Send a date and time (YYYY-MM-DD HH:MM:SS, or an ISO 8601 date-time).`,
      );
      expect(expectRejectionReason(value, DATE_COLUMN)).toBe(
        `"${value}" isn't a value MySQL can store in a DATE column. Send a calendar date (YYYY-MM-DD).`,
      );
    });

    it('names the TIMESTAMP kind in the reason for a TIMESTAMP column', () => {
      expect(expectRejectionReason('yesterday', TIMESTAMP_COLUMN_WITH_MICROSECONDS)).toContain('TIMESTAMP column');
    });

    it('quotes the original (untrimmed) value in the reason', () => {
      expect(expectRejectionReason(' nope ', DATE_COLUMN)).toContain('" nope "');
    });
  });
});

describe('readMySqlTimeColumnFractionalSecondsPrecision', () => {
  it.each([
    ['time', 0],
    ['time(0)', 0],
    ['time(3)', 3],
    ['TIME(6)', 6],
    [' time(1) ', 1],
  ])('%j → %j', (columnTypeSpelling, expectedFractionalSecondsPrecision) => {
    expect(readMySqlTimeColumnFractionalSecondsPrecision(columnTypeSpelling)).toBe(expectedFractionalSecondsPrecision);
  });

  it.each(['datetime', 'datetime(3)', 'timestamp(6)', 'date', 'time(7)', 'tinytext', 'varchar(8)', ''])(
    'is undefined for %j',
    (columnTypeSpelling) => {
      expect(readMySqlTimeColumnFractionalSecondsPrecision(columnTypeSpelling)).toBeUndefined();
    },
  );
});

describe('convertRecognizedTimeTextToMySqlTimeLiteral', () => {
  // Every expectation below is what MySQL 8.4 and MariaDB 11.4 return after storing the converted literal.
  it.each([
    ['14:30', 0, '14:30:00'],
    ['14:30', 3, '14:30:00.000'],
    ['14:30:00', 6, '14:30:00.000000'],
    ['9:05', 0, '09:05:00'],
    ['1:2', 0, '01:02:00'],
    ['1:2:3', 0, '01:02:03'],
    ['14:30:5', 0, '14:30:05'],
    ['009:05:00', 0, '09:05:00'],
    ['100:00:00', 0, '100:00:00'],
    ['838:59:59', 0, '838:59:59'],
    ['-838:59:59', 3, '-838:59:59.000'],
    ['-01:00:00', 0, '-01:00:00'],
    ['-00:30', 0, '-00:30:00'],
    ['  14:30:00  ', 0, '14:30:00'],
    ['14:30:00.', 0, '14:30:00'],
  ])('adds seconds and pads every part: %j in TIME(%i) → %j', (timeText, fractionalSecondsPrecision, expected) => {
    expect(convertRecognizedTimeTextToMySqlTimeLiteral(timeText, fractionalSecondsPrecision)).toBe(expected);
  });

  it.each([
    ['14:30:00.5', 0, '14:30:00'],
    ['14:30:00.999', 0, '14:30:00'],
    ['14:30:00.5', 1, '14:30:00.5'],
    ['14:30:00.5', 3, '14:30:00.500'],
    ['14:30:00.999', 3, '14:30:00.999'],
    ['14:30:00.1234567', 6, '14:30:00.123456'],
    ['-100:00:00.25', 1, '-100:00:00.2'],
    ['838:59:59.9', 0, '838:59:59'],
  ])(
    "TRUNCATES the fraction to the column's precision (MySQL would round, MariaDB truncates): %j in TIME(%i) → %j",
    (timeText, fractionalSecondsPrecision, expected) => {
      expect(convertRecognizedTimeTextToMySqlTimeLiteral(timeText, fractionalSecondsPrecision)).toBe(expected);
    },
  );

  it('drops the sign of a value that is zero after truncation, as MySQL stores it', () => {
    expect(convertRecognizedTimeTextToMySqlTimeLiteral('-00:00:00', 0)).toBe('00:00:00');
    expect(convertRecognizedTimeTextToMySqlTimeLiteral('-00:00:00.5', 0)).toBe('00:00:00');
    expect(convertRecognizedTimeTextToMySqlTimeLiteral('-00:00:00.5', 3)).toBe('-00:00:00.500');
  });

  it.each([
    ['839:00:00'],
    ['1000:00:00'],
    ['12:60:00'],
    ['12:30:60'],
    ['1 12:00:00'],
    ['143000'],
    ['1430'],
    ['14:30.5'],
    ['+14:30'],
    ['1:2:3:4'],
    ['12:30:45.5.5'],
    ['noon'],
    [''],
  ])('leaves %j to MySQL (another TIME shape, or out of range): undefined', (timeText) => {
    expect(convertRecognizedTimeTextToMySqlTimeLiteral(timeText, 0)).toBeUndefined();
    expect(convertRecognizedTimeTextToMySqlTimeLiteral(timeText, 3)).toBeUndefined();
  });

  it('returns what MySQL reads back unchanged, so a pulled value compares equal to itself', () => {
    for (const [pulledTimeText, fractionalSecondsPrecision] of [
      ['14:30:00', 0],
      ['-838:59:59', 0],
      ['14:30:00.500', 3],
      ['-00:00:00.500', 3],
      ['36:00:00.000000', 6],
    ] as const) {
      expect(convertRecognizedTimeTextToMySqlTimeLiteral(pulledTimeText, fractionalSecondsPrecision)).toBe(
        pulledTimeText,
      );
    }
  });
});
