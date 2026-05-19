import { buildLinearUpdatedAtFilter, LINEAR_INCREMENTAL_CLOCK_SKEW_MS } from '../linear-incremental';

describe('LINEAR_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — Linear `gt` is exclusive and the watermark is client-side', () => {
    expect(LINEAR_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('buildLinearUpdatedAtFilter', () => {
  it('builds an exclusive `updatedAt > since` filter with the clock-skew margin subtracted', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    expect(buildLinearUpdatedAtFilter(since)).toEqual({
      updatedAt: { gt: '2026-05-14T11:59:00.000Z' },
    });
  });

  it('subtracts exactly LINEAR_INCREMENTAL_CLOCK_SKEW_MS from the watermark', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const expected = new Date(since.getTime() - LINEAR_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
    expect(buildLinearUpdatedAtFilter(since).updatedAt.gt).toBe(expected);
  });
});
