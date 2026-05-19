import { buildIntercomUpdatedSinceQuery, INTERCOM_INCREMENTAL_CLOCK_SKEW_MS } from '../intercom-incremental';

describe('INTERCOM_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — Intercom search `>` is exclusive and the watermark is client-side', () => {
    expect(INTERCOM_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('buildIntercomUpdatedSinceQuery', () => {
  it('builds an exclusive `updated_at > since` clause in Unix seconds with the clock-skew margin subtracted', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    expect(buildIntercomUpdatedSinceQuery(since)).toEqual({
      field: 'updated_at',
      operator: '>',
      value: Math.floor((since.getTime() - INTERCOM_INCREMENTAL_CLOCK_SKEW_MS) / 1000),
    });
  });

  it('subtracts exactly INTERCOM_INCREMENTAL_CLOCK_SKEW_MS and floors to whole seconds', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const expected = Math.floor((since.getTime() - INTERCOM_INCREMENTAL_CLOCK_SKEW_MS) / 1000);
    expect(buildIntercomUpdatedSinceQuery(since).value).toBe(expected);
  });

  it('floors sub-second precision down (never rounds up past the cutoff)', () => {
    // 1.999s past the skew boundary must floor to the lower whole second.
    const since = new Date(60_000 + 5_999); // since - 60s = 5999ms → floor(5.999) = 5
    expect(buildIntercomUpdatedSinceQuery(since).value).toBe(5);
  });
});
