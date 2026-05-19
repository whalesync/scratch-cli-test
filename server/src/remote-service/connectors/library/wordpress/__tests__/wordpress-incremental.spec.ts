import {
  applyWordPressClockSkew,
  formatWordPressModifiedAfter,
  WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS,
} from '../wordpress-incremental';

describe('WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — covers residual clock drift (the systematic tz offset is handled separately)', () => {
    expect(WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('applyWordPressClockSkew', () => {
  it('subtracts the clock-skew margin from the watermark (instant-space, UTC)', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    expect(applyWordPressClockSkew(since).toISOString()).toBe('2026-05-14T11:59:00.000Z');
  });

  it('subtracts exactly WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    expect(applyWordPressClockSkew(since).getTime()).toBe(since.getTime() - WORDPRESS_INCREMENTAL_CLOCK_SKEW_MS);
  });
});

describe('formatWordPressModifiedAfter', () => {
  // since 12:00:00Z → clock-skewed cutoff is 11:59:00Z; every expectation
  // below is that instant rendered as the site's local wall clock.
  const since = new Date('2026-05-14T12:00:00.000Z');

  it('falls back to UTC wall clock when no timezone is known (empty {})', () => {
    expect(formatWordPressModifiedAfter(since, {})).toBe('2026-05-14T11:59:00');
  });

  it('renders an IANA timezone with DST resolved for that instant (EDT, summer → UTC-4)', () => {
    expect(formatWordPressModifiedAfter(since, { timezoneString: 'America/New_York' })).toBe('2026-05-14T07:59:00');
  });

  it('resolves the other side of DST for a winter instant (EST → UTC-5)', () => {
    const winter = new Date('2026-01-15T12:00:00.000Z'); // cutoff 11:59:00Z
    expect(formatWordPressModifiedAfter(winter, { timezoneString: 'America/New_York' })).toBe('2026-01-15T06:59:00');
  });

  it('renders a positive fractional fixed offset when there is no IANA name', () => {
    expect(formatWordPressModifiedAfter(since, { gmtOffsetHours: 5.5 })).toBe('2026-05-14T17:29:00');
  });

  it('renders a negative fixed offset when there is no IANA name', () => {
    expect(formatWordPressModifiedAfter(since, { gmtOffsetHours: -5 })).toBe('2026-05-14T06:59:00');
  });

  it('prefers the IANA name over a (possibly stale) fixed offset', () => {
    expect(formatWordPressModifiedAfter(since, { timezoneString: 'America/New_York', gmtOffsetHours: -9 })).toBe(
      '2026-05-14T07:59:00',
    );
  });

  it('falls back to the fixed offset when the IANA name is invalid', () => {
    expect(formatWordPressModifiedAfter(since, { timezoneString: 'Not/AZone', gmtOffsetHours: 2 })).toBe(
      '2026-05-14T13:59:00',
    );
  });

  it('falls back to UTC when the IANA name is invalid and there is no offset', () => {
    expect(formatWordPressModifiedAfter(since, { timezoneString: 'Not/AZone' })).toBe('2026-05-14T11:59:00');
  });

  it('emits no timezone designator (a floating datetime WordPress reads as site-local)', () => {
    const value = formatWordPressModifiedAfter(since, { timezoneString: 'America/New_York' });
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(value.endsWith('Z')).toBe(false);
  });
});
