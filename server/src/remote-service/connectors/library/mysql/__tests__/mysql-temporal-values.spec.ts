import { formatInstantAsMySqlUtcDateTimeLiteral, renderMySqlTimestampTextAsRfc3339Utc } from '../mysql-temporal-values';

describe('renderMySqlTimestampTextAsRfc3339Utc', () => {
  it.each([
    ['2026-01-02 03:04:05', '2026-01-02T03:04:05Z'],
    ['2026-01-02 03:04:05.123', '2026-01-02T03:04:05.123Z'],
    ['2026-01-02 03:04:05.123456', '2026-01-02T03:04:05.123456Z'],
    ['2026-01-02 03:04:05.000000', '2026-01-02T03:04:05.000000Z'],
    ['1970-01-01 00:00:01', '1970-01-01T00:00:01Z'],
  ])('rewrites %j as %j, keeping every fractional digit MySQL printed', (timestampText, expectedRfc3339Text) => {
    expect(renderMySqlTimestampTextAsRfc3339Utc(timestampText)).toBe(expectedRfc3339Text);
  });

  it.each(['0000-00-00 00:00:00', '0000-00-00 00:00:00.000'])('keeps the zero date %j verbatim', (zeroDateText) => {
    expect(renderMySqlTimestampTextAsRfc3339Utc(zeroDateText)).toBe(zeroDateText);
  });

  it.each(['2026-01-02', '2026-01-02T03:04:05Z', 'not a timestamp', '2026-01-02 03:04:05.1234567'])(
    'leaves unexpected text %j unchanged',
    (unexpectedText) => {
      expect(renderMySqlTimestampTextAsRfc3339Utc(unexpectedText)).toBe(unexpectedText);
    },
  );

  it('passes NULL through', () => {
    expect(renderMySqlTimestampTextAsRfc3339Utc(null)).toBeNull();
  });
});

describe('formatInstantAsMySqlUtcDateTimeLiteral', () => {
  it('formats an instant as a UTC datetime literal with microseconds', () => {
    expect(formatInstantAsMySqlUtcDateTimeLiteral(new Date('2026-01-02T03:04:05.678Z'))).toBe(
      '2026-01-02 03:04:05.678000',
    );
  });

  it('renders the instant in UTC whatever the offset it was created with', () => {
    expect(formatInstantAsMySqlUtcDateTimeLiteral(new Date('2026-01-02T05:04:05.000+02:00'))).toBe(
      '2026-01-02 03:04:05.000000',
    );
  });

  it('pads whole seconds to six fractional digits', () => {
    expect(formatInstantAsMySqlUtcDateTimeLiteral(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe(
      '2026-12-31 23:59:59.000000',
    );
  });
});
