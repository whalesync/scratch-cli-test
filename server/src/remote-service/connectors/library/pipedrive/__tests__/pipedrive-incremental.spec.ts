import { buildPipedriveUpdatedSince, PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS } from '../pipedrive-incremental';

describe('PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — update_time is server-side while the watermark is client-side', () => {
    expect(PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('buildPipedriveUpdatedSince', () => {
  it('renders the clock-skewed watermark as a whole-second RFC3339 UTC string', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    expect(buildPipedriveUpdatedSince(since)).toBe('2026-05-14T11:59:00Z');
  });

  it('subtracts exactly PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS from the watermark', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const expected = new Date(since.getTime() - PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    expect(buildPipedriveUpdatedSince(since)).toBe(expected);
  });

  it('strips milliseconds — Pipedrive v2 rejects RFC3339 fractional seconds as an invalid datetime', () => {
    // Pipedrive's updated_since parser 400s on the .SSS component that
    // Date.toISOString() emits ("not a valid datetime"), so we truncate to the
    // whole second. The documented example is a whole-second 2025-01-01T10:20:00Z.
    const since = new Date('2026-05-14T12:00:00.123Z');
    const value = buildPipedriveUpdatedSince(since);
    expect(value).toBe('2026-05-14T11:59:00Z');
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
