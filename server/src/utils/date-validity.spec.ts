import { isValidWritableCalendarDateString } from './date-validity';

describe('isValidWritableCalendarDateString', () => {
  it('accepts a real date-only value', () => {
    expect(isValidWritableCalendarDateString('2026-02-28')).toBe(true);
    expect(isValidWritableCalendarDateString('2024-02-29')).toBe(true); // 2024 IS a leap year
    expect(isValidWritableCalendarDateString('2026-06-04')).toBe(true);
  });

  it('accepts a real date-time value', () => {
    expect(isValidWritableCalendarDateString('2026-06-04T14:14:02Z')).toBe(true);
    expect(isValidWritableCalendarDateString('2026-06-04T14:14:02.000Z')).toBe(true);
    expect(isValidWritableCalendarDateString('2026-06-04T00:00:00+02:00')).toBe(true);
  });

  it('rejects a nonexistent calendar date that new Date() silently rolls over (DEV-11044)', () => {
    // The bug: `new Date("2026-02-29")` === 2026-03-01, not Invalid Date.
    expect(new Date('2026-02-29').getTime()).not.toBeNaN(); // proves the naive check would pass it
    expect(isValidWritableCalendarDateString('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isValidWritableCalendarDateString('2026-02-30')).toBe(false);
    expect(isValidWritableCalendarDateString('2026-04-31')).toBe(false);
    expect(isValidWritableCalendarDateString('2026-02-29T10:00:00Z')).toBe(false);
  });

  it('rejects an out-of-range month or day', () => {
    expect(isValidWritableCalendarDateString('2026-13-01')).toBe(false);
    expect(isValidWritableCalendarDateString('2026-00-01')).toBe(false);
    expect(isValidWritableCalendarDateString('2026-06-00')).toBe(false);
  });

  it('rejects an unparseable value', () => {
    expect(isValidWritableCalendarDateString('not-a-date')).toBe(false);
    expect(isValidWritableCalendarDateString('29/02/2026')).toBe(false);
    expect(isValidWritableCalendarDateString('')).toBe(false);
  });

  it('treats an extended-year instant as valid (out-of-range clamping is destination-specific, not here)', () => {
    // A real instant with a six-digit extended year — not a leading YYYY-MM-DD, parses fine.
    expect(isValidWritableCalendarDateString('+010000-01-01T07:59:59.000Z')).toBe(true);
  });

  it('does not mis-flag an early-century date via the two-digit-year mapping', () => {
    expect(isValidWritableCalendarDateString('0050-06-15')).toBe(true);
    expect(isValidWritableCalendarDateString('0050-02-29')).toBe(false); // 50 AD is not a leap year
  });

  it('ignores surrounding whitespace', () => {
    expect(isValidWritableCalendarDateString('  2026-06-04  ')).toBe(true);
    expect(isValidWritableCalendarDateString('  2026-02-29  ')).toBe(false);
  });
});
