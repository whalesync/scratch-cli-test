import { buildMocoUpdatedAfter, MOCO_INCREMENTAL_CLOCK_SKEW_MS } from '../moco-incremental';

describe('MOCO_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — Moco `updated_after` is boundary-exclusive and the watermark is client-side', () => {
    expect(MOCO_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('buildMocoUpdatedAfter', () => {
  it('renders the clock-skewed watermark as an ISO-8601 UTC string at seconds precision', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    expect(buildMocoUpdatedAfter(since)).toBe('2026-05-14T11:59:00Z');
  });

  it('subtracts exactly MOCO_INCREMENTAL_CLOCK_SKEW_MS from the watermark', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const expected = new Date(since.getTime() - MOCO_INCREMENTAL_CLOCK_SKEW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(buildMocoUpdatedAfter(since)).toBe(expected);
  });

  it('emits seconds precision with NO milliseconds — Moco 400s on fractional seconds', () => {
    // Even when the clock-skewed instant lands on a non-zero millisecond, the
    // value must be YYYY-MM-DDTHH:mm:ssZ (e.g. 2020-01-23T07:29:56Z).
    const since = new Date('2026-05-14T12:00:00.123Z');
    const value = buildMocoUpdatedAfter(since);
    expect(value).toBe('2026-05-14T11:59:00Z');
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(value).not.toContain('.');
  });
});
