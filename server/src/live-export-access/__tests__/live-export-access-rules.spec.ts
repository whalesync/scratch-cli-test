import { Prisma } from '@prisma/client';
import { LiveExportCadence, WhalesyncLiveExportAccess } from '@spinner/shared-types';
import {
  buildWhalesyncPlanMetadataForLiveExportAccess,
  extractLiveExportCadence,
  extractLiveExportRecordCountLimit,
  extractLiveExportsPaused,
  isCronScheduleFasterThanLiveExportCadence,
  isSameLiveExportAccess,
  leastTimeBetweenScheduledLiveExportRuns,
  liveExportAccessFromWhalesyncSubscriptionPayload,
  readLiveExportAccessFromWhalesyncPlanMetadata,
} from '../live-export-access-rules';

const NOW = new Date('2027-03-10T00:00:00Z');

describe('readLiveExportAccessFromWhalesyncPlanMetadata', () => {
  it('reads the pause and both limits', () => {
    expect(
      readLiveExportAccessFromWhalesyncPlanMetadata({
        liveExportsPaused: true,
        liveExportRecordCountLimit: 1_000_000,
        liveExportCadence: 'daily',
      }),
    ).toEqual({ paused: true, recordLimit: 1_000_000, fastestCadence: 'daily' });
  });

  it('reads a row from before Live Export access as not paused, keeping its limits', () => {
    expect(
      readLiveExportAccessFromWhalesyncPlanMetadata({
        whalesyncStatus: 'expired',
        whalesyncProductType: 'Zn8Ry3',
        liveExportRecordCountLimit: 10_000,
        liveExportCadence: 'frequent',
      }),
    ).toEqual({ paused: false, recordLimit: 10_000, fastestCadence: 'frequent' });
  });

  it.each([null, {}, ['hourly'], 'hourly'])('reads %j as running with no limits', (metadata) => {
    expect(readLiveExportAccessFromWhalesyncPlanMetadata(metadata)).toEqual({
      paused: false,
      recordLimit: null,
      fastestCadence: null,
    });
  });
});

describe('buildWhalesyncPlanMetadataForLiveExportAccess', () => {
  it.each<[WhalesyncLiveExportAccess, Record<string, unknown>]>([
    [
      { paused: true, recordLimit: 1_000_000, fastestCadence: 'frequent' },
      { liveExportsPaused: true, liveExportRecordCountLimit: 1_000_000, liveExportCadence: 'frequent' },
    ],
    [
      { paused: false, recordLimit: 0, fastestCadence: null },
      { liveExportsPaused: false, liveExportRecordCountLimit: 0 },
    ],
    [{ paused: false, recordLimit: null, fastestCadence: null }, { liveExportsPaused: false }],
  ])('stores %j as %j, and reads it back the same', (liveExportAccess, metadata) => {
    expect(buildWhalesyncPlanMetadataForLiveExportAccess(liveExportAccess)).toEqual(metadata);
    const storedMetadata = buildWhalesyncPlanMetadataForLiveExportAccess(liveExportAccess) as Prisma.JsonObject;
    expect(readLiveExportAccessFromWhalesyncPlanMetadata(storedMetadata)).toEqual(liveExportAccess);
  });
});

describe('liveExportAccessFromWhalesyncSubscriptionPayload', () => {
  it.each([
    ['active', false],
    ['cancelled', true],
    ['expired', true],
    ['none', true],
  ] as const)("pauses the team for status '%s': %s", (status, paused) => {
    expect(
      liveExportAccessFromWhalesyncSubscriptionPayload({
        status,
        whalesyncProductType: 'Pd7Nw3',
        liveExportRecordCountLimit: 500_000,
        liveExportCadence: 'hourly',
        expiresAt: '2026-12-14T00:00:00.000Z',
      }),
    ).toEqual({ paused, recordLimit: 500_000, fastestCadence: 'hourly' });
  });

  it('maps a payload with no limits onto an access with none', () => {
    expect(liveExportAccessFromWhalesyncSubscriptionPayload({ status: 'active' })).toEqual({
      paused: false,
      recordLimit: null,
      fastestCadence: null,
    });
  });
});

describe('isSameLiveExportAccess', () => {
  const pausedDaily: WhalesyncLiveExportAccess = { paused: true, recordLimit: 1000, fastestCadence: 'daily' };

  it.each<[string, WhalesyncLiveExportAccess, boolean]>([
    ['an equal access', { ...pausedDaily }, true],
    ['another pause', { ...pausedDaily, paused: false }, false],
    ['another record limit', { ...pausedDaily, recordLimit: null }, false],
    ['another speed', { ...pausedDaily, fastestCadence: 'hourly' }, false],
  ])('compares with %s: same %s', (_description, otherAccess, same) => {
    expect(isSameLiveExportAccess(pausedDaily, otherAccess)).toBe(same);
  });
});

describe('leastTimeBetweenScheduledLiveExportRuns', () => {
  it.each<[LiveExportCadence, number]>([
    ['frequent', 9],
    ['hourly', 59],
    // An hour and a minute under a day, for the 23-hour day when the clocks go forward.
    ['daily', 1379],
  ])('leaves at least %s minutes for %s', (cadence, leastMinutes) => {
    expect(leastTimeBetweenScheduledLiveExportRuns(cadence).ms()).toBe(leastMinutes * 60 * 1000);
  });
});

describe('isCronScheduleFasterThanLiveExportCadence', () => {
  // Whalesync's own schedules: every 10 or 30 minutes on `frequent`, hourly from `hourly`, and daily on every plan.
  it.each<[string, string | null, LiveExportCadence, boolean]>([
    ['*/10 * * * *', null, 'frequent', false],
    ['*/30 * * * *', null, 'frequent', false],
    ['0 * * * *', null, 'frequent', false],
    ['*/5 * * * *', null, 'frequent', true],
    ['*/10 * * * *', null, 'hourly', true],
    ['*/30 * * * *', null, 'hourly', true],
    ['0 * * * *', 'America/New_York', 'hourly', false],
    ['0 9 * * *', 'America/Los_Angeles', 'hourly', false],
    ['0 * * * *', null, 'daily', true],
    ['0 9,10 * * *', null, 'daily', true],
    ['0 9 * * *', 'America/Los_Angeles', 'daily', false],
    // 2:00 doesn't exist in Los Angeles on 2027-03-14, so that run lands 23 hours after the one before.
    ['0 2 * * *', 'America/Los_Angeles', 'daily', false],
    ['0 9 * * 1', 'Europe/Berlin', 'daily', false],
  ])('%s in %s against %s: faster %s', (cronExpression, timezone, cadence, faster) => {
    expect(isCronScheduleFasterThanLiveExportCadence(cronExpression, timezone, cadence, NOW)).toBe(faster);
  });

  it('stops comparing at runs more than about a year away', () => {
    // Every leap day: the next run is 2028-02-29, past the horizon, so nothing is compared.
    expect(isCronScheduleFasterThanLiveExportCadence('0 0 29 2 *', null, 'daily', NOW)).toBe(false);
  });

  it.each(['not a cron', '0 0 31 2 *'])('cannot read %s', (cronExpression) => {
    expect(isCronScheduleFasterThanLiveExportCadence(cronExpression, null, 'daily', NOW)).toBeNull();
  });
});

describe('Whalesync plan metadata readers', () => {
  it.each([
    [{ liveExportsPaused: true, liveExportCadence: 'frequent', liveExportRecordCountLimit: 0 }, true, 'frequent', 0],
    [
      { liveExportsPaused: 'true', liveExportCadence: 'realtime', liveExportRecordCountLimit: '5000' },
      false,
      undefined,
      undefined,
    ],
    [{ whalesyncStatus: 'active' }, false, undefined, undefined],
    [['hourly'], false, undefined, undefined],
    ['hourly', false, undefined, undefined],
    [null, false, undefined, undefined],
  ])('reads %j as paused %s, speed %s, and record limit %s', (metadata, paused, cadence, recordCountLimit) => {
    expect(extractLiveExportsPaused(metadata)).toBe(paused);
    expect(extractLiveExportCadence(metadata)).toBe(cadence);
    expect(extractLiveExportRecordCountLimit(metadata)).toBe(recordCountLimit);
  });
});
