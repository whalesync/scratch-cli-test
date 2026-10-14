import {
  AssetBucketLiveObjectDeleteOutcome,
  AssetBucketLiveObjectListing,
  ObjectStorageService,
} from 'src/asset/object-storage.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import {
  MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES,
  MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP,
  RehostedAssetReaperService,
} from '../rehosted-asset-reaper.service';

const PUBLIC_URL_PREFIX = 'https://storage.googleapis.com/test-assets/';
const DAY_MS = 24 * 60 * 60 * 1000;
// Comfortably older than the service's 7-day minimum age (which it recomputes as now - 7 days).
const OLD_TIME_CREATED = new Date(Date.now() - 8 * DAY_MS);
// Well under 7 days old.
const YOUNG_TIME_CREATED = new Date(Date.now() - DAY_MS);

// Workbook ids must have the real 14-character shape (`wkb_` + 10) — `isWorkbookId` checks it.
const WORKBOOK_A_ID = 'wkb_AAAAAAAAAA';
const WORKBOOK_B_ID = 'wkb_BBBBBBBBBB';
const WORKBOOK_A_KEY_PREFIX = `v1/${WORKBOOK_A_ID}/`;
const WORKBOOK_B_KEY_PREFIX = `v1/${WORKBOOK_B_ID}/`;

function objectKeyInWorkbookA(filename: string): string {
  return `${WORKBOOK_A_KEY_PREFIX}AIRTABLE/0123abcd/${filename}`;
}

function listedObject(
  key: string,
  overrides: Partial<Omit<AssetBucketLiveObjectListing, 'key'>> = {},
): AssetBucketLiveObjectListing {
  return { key, timeCreatedOrNull: OLD_TIME_CREATED, generationOrNull: `gen-${key}`, ...overrides };
}

async function* yieldEach<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

/** An Asset row as the reference queries see it; `workbookId` is documentation only (no query filters on it). */
interface AssetRowFixture {
  workbookId: string;
  rehostedUrl: string | null;
  url: string | null;
}

interface AssetFindManyArgs {
  where: { rehostedUrl?: { startsWith: string }; url?: { startsWith: string } };
}

/** One row of either reference query (each selects just the column it matched on). */
type AssetReferenceQueryRow = { rehostedUrl?: string | null; url?: string | null };

function makeService(deps: {
  workbookKeyPrefixes: string[];
  objectsByWorkbookKeyPrefix: Record<string, AssetBucketLiveObjectListing[]>;
  assetRows?: AssetRowFixture[];
  rehostedUrlsOutsideTheirOwnWorkbookKeyPrefix?: number;
  deletesEnabled?: boolean;
  isAssetBucketConfigured?: boolean;
  isAllowedToRunOutsideCloudRun?: boolean;
}) {
  const deleteLiveObjectFromAssetBucketIfGenerationMatches = jest
    .fn<Promise<AssetBucketLiveObjectDeleteOutcome>, [string, string]>()
    .mockResolvedValue('deleted');
  const listLiveObjectsInAssetBucketWithKeyPrefix = jest.fn((keyPrefix: string) =>
    yieldEach(deps.objectsByWorkbookKeyPrefix[keyPrefix] ?? []),
  );
  const listWorkbookKeyPrefixesInAssetBucket = jest.fn().mockResolvedValue(deps.workbookKeyPrefixes);
  const objectStorage = {
    isConfigured: () => deps.isAssetBucketConfigured ?? true,
    buildPublicUrlPrefixForAssetBucket: () => PUBLIC_URL_PREFIX,
    listWorkbookKeyPrefixesInAssetBucket,
    listLiveObjectsInAssetBucketWithKeyPrefix,
    deleteLiveObjectFromAssetBucketIfGenerationMatches,
  } as unknown as ObjectStorageService;

  // Mimics Postgres for the two reference queries: a `startsWith` match on one column, distinct values.
  const assetRows = deps.assetRows ?? [];
  const assetFindMany = jest.fn((args: AssetFindManyArgs): Promise<AssetReferenceQueryRow[]> => {
    const rehostedUrlPrefix = args.where.rehostedUrl?.startsWith;
    if (rehostedUrlPrefix !== undefined) {
      const matching = assetRows.filter((row) => row.rehostedUrl?.startsWith(rehostedUrlPrefix));
      return Promise.resolve(
        [...new Set(matching.map((row) => row.rehostedUrl))].map((rehostedUrl) => ({ rehostedUrl })),
      );
    }
    const urlPrefix = args.where.url?.startsWith;
    if (urlPrefix !== undefined) {
      const matching = assetRows.filter((row) => row.url?.startsWith(urlPrefix));
      return Promise.resolve([...new Set(matching.map((row) => row.url))].map((url) => ({ url })));
    }
    return Promise.reject(new Error('unexpected asset.findMany query'));
  });
  const queryRaw = jest
    .fn()
    .mockResolvedValue([
      { rehostedUrlsOutsideTheirOwnWorkbookKeyPrefix: deps.rehostedUrlsOutsideTheirOwnWorkbookKeyPrefix ?? 0 },
    ]);
  const db = { client: { asset: { findMany: assetFindMany }, $queryRaw: queryRaw } } as unknown as DbService;

  const config = {
    isRehostedAssetReaperAllowedToRunOutsideCloudRun: () => deps.isAllowedToRunOutsideCloudRun ?? false,
  } as unknown as ScratchConfigService;
  const metricsService = { logValue: jest.fn() };
  const getBooleanFlag = jest.fn().mockResolvedValue(deps.deletesEnabled ?? true);

  const service = new RehostedAssetReaperService(
    db,
    objectStorage,
    config,
    metricsService as unknown as CustomMetricsService,
    { getBooleanFlag } as unknown as ExperimentsService,
  );
  return {
    service,
    deleteLiveObjectFromAssetBucketIfGenerationMatches,
    listLiveObjectsInAssetBucketWithKeyPrefix,
    listWorkbookKeyPrefixesInAssetBucket,
    assetFindMany,
    queryRaw,
    metricsService,
    getBooleanFlag,
  };
}

type LoggedEntry = { message: string; [field: string]: unknown };

function findLoggedEntry(spy: jest.SpyInstance, messagePrefix: string): LoggedEntry | undefined {
  return spy.mock.calls
    .map((call: unknown[]) => call[0] as LoggedEntry)
    .find((entry) => entry.message.startsWith(messagePrefix));
}

function deletedKeys(deleteMock: jest.Mock): string[] {
  return deleteMock.mock.calls.map((call: unknown[]) => call[0] as string);
}

describe('RehostedAssetReaperService', () => {
  const originalRunningInCloud = process.env.RUNNING_IN_CLOUD;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    // Default to a deployed environment, where the reaper runs; guard tests opt out.
    process.env.RUNNING_IN_CLOUD = 'true';
    infoSpy = jest.spyOn(WSLogger, 'info').mockImplementation();
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
    errorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalRunningInCloud === undefined) {
      delete process.env.RUNNING_IN_CLOUD;
    } else {
      process.env.RUNNING_IN_CLOUD = originalRunningInCloud;
    }
  });

  it('reaps an old object no Asset row references, guarded by its listed generation', async () => {
    const orphanKey = objectKeyInWorkbookA('orphan.jpg');
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, metricsService, getBooleanFlag } = makeService(
      {
        workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
        objectsByWorkbookKeyPrefix: {
          [WORKBOOK_A_KEY_PREFIX]: [listedObject(orphanKey, { generationOrNull: '1711' })],
        },
      },
    );

    await service.reapUnreferencedRehostedAssetObjects();

    expect(getBooleanFlag).toHaveBeenCalledWith(SystemFeatureFlag.REHOSTED_ASSET_REAPER_DELETES_ENABLED, false);
    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).toHaveBeenCalledTimes(1);
    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).toHaveBeenCalledWith(orphanKey, '1711');
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_OBJECT_REAPED, 1);
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED, 1);
    expect(findLoggedEntry(infoSpy, 'Reaped 1 unreferenced')).toMatchObject({
      objectsReaped: [{ key: orphanKey, generation: '1711' }],
    });
  });

  it('keeps an object an Asset.rehostedUrl references', async () => {
    const referencedKey = objectKeyInWorkbookA('kept.jpg');
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(referencedKey)] },
      assetRows: [{ workbookId: WORKBOOK_A_ID, rehostedUrl: `${PUBLIC_URL_PREFIX}${referencedKey}`, url: null }],
    });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
  });

  it('keeps objects a hot-linked Asset.url references, ignoring a query string or fragment', async () => {
    // Notion pulls index an `external.url` that hot-links our bucket into Asset.url (rehostedUrl stays null).
    const hotLinkedWithQueryKey = objectKeyInWorkbookA('hotlinked-query.jpg');
    const hotLinkedWithFragmentKey = objectKeyInWorkbookA('hotlinked-fragment.jpg');
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: {
        [WORKBOOK_A_KEY_PREFIX]: [listedObject(hotLinkedWithQueryKey), listedObject(hotLinkedWithFragmentKey)],
      },
      assetRows: [
        { workbookId: WORKBOOK_A_ID, rehostedUrl: null, url: `${PUBLIC_URL_PREFIX}${hotLinkedWithQueryKey}?width=200` },
        { workbookId: WORKBOOK_A_ID, rehostedUrl: null, url: `${PUBLIC_URL_PREFIX}${hotLinkedWithFragmentKey}#cover` },
      ],
    });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
  });

  it('keeps an object a row in ANOTHER workbook references (references are matched by URL, not workbook)', async () => {
    const sharedKey = objectKeyInWorkbookA('shared.jpg');
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, assetFindMany } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(sharedKey)] },
      assetRows: [{ workbookId: WORKBOOK_B_ID, rehostedUrl: `${PUBLIC_URL_PREFIX}${sharedKey}`, url: null }],
    });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
    // Neither reference query scopes by workbook.
    expect(assetFindMany).toHaveBeenCalledWith({
      where: { rehostedUrl: { startsWith: `${PUBLIC_URL_PREFIX}${WORKBOOK_A_KEY_PREFIX}` } },
      select: { rehostedUrl: true },
      distinct: ['rehostedUrl'],
    });
    expect(assetFindMany).toHaveBeenCalledWith({
      where: { url: { startsWith: `${PUBLIC_URL_PREFIX}${WORKBOOK_A_KEY_PREFIX}` } },
      select: { url: true },
      distinct: ['url'],
    });
  });

  it('keeps objects younger than 7 days, or listed without a creation time or generation, without querying references', async () => {
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, assetFindMany } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: {
        [WORKBOOK_A_KEY_PREFIX]: [
          listedObject(objectKeyInWorkbookA('young.jpg'), { timeCreatedOrNull: YOUNG_TIME_CREATED }),
          listedObject(objectKeyInWorkbookA('undated.jpg'), { timeCreatedOrNull: null }),
          listedObject(objectKeyInWorkbookA('no-generation.jpg'), { generationOrNull: null }),
        ],
      },
    });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
    expect(assetFindMany).not.toHaveBeenCalled();
    expect(findLoggedEntry(infoSpy, 'Rehosted-asset reaper sweep complete')).toMatchObject({
      objectsScanned: 3,
      objectsKeptAsTooYoung: 3,
      objectsSelectedForReaping: 0,
    });
  });

  it('never lists or reaps a prefix that is not a workbook id', async () => {
    const { service, listLiveObjectsInAssetBucketWithKeyPrefix, deleteLiveObjectFromAssetBucketIfGenerationMatches } =
      makeService({
        workbookKeyPrefixes: ['v1/not-a-workbook/', 'v1/wkb_tooShort/', `v1/${WORKBOOK_A_ID}`],
        objectsByWorkbookKeyPrefix: {
          'v1/not-a-workbook/': [listedObject('v1/not-a-workbook/stray.jpg')],
        },
      });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(listLiveObjectsInAssetBucketWithKeyPrefix).not.toHaveBeenCalled();
    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
    expect(findLoggedEntry(infoSpy, 'Rehosted-asset reaper sweep complete')).toMatchObject({
      workbookKeyPrefixesScanned: 0,
      nonWorkbookKeyPrefixesSkipped: 3,
    });
  });

  it('reaps only the old unreferenced objects across workbooks and tallies the sweep', async () => {
    const orphanInA = objectKeyInWorkbookA('orphan.jpg');
    const referencedInA = objectKeyInWorkbookA('kept.jpg');
    const youngInA = objectKeyInWorkbookA('young.jpg');
    const orphanInB = `${WORKBOOK_B_KEY_PREFIX}NOTION/89ef/orphan.png`;
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX, WORKBOOK_B_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: {
        [WORKBOOK_A_KEY_PREFIX]: [
          listedObject(orphanInA),
          listedObject(referencedInA),
          listedObject(youngInA, { timeCreatedOrNull: YOUNG_TIME_CREATED }),
        ],
        [WORKBOOK_B_KEY_PREFIX]: [listedObject(orphanInB)],
      },
      assetRows: [{ workbookId: WORKBOOK_A_ID, rehostedUrl: `${PUBLIC_URL_PREFIX}${referencedInA}`, url: null }],
    });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deletedKeys(deleteLiveObjectFromAssetBucketIfGenerationMatches)).toEqual([orphanInA, orphanInB]);
    expect(findLoggedEntry(infoSpy, 'Rehosted-asset reaper sweep complete')).toMatchObject({
      deletesEnabled: true,
      workbookKeyPrefixesScanned: 2,
      objectsScanned: 4,
      objectsKeptAsReferenced: 1,
      objectsKeptAsTooYoung: 1,
      objectsSelectedForReaping: 2,
      objectsReaped: 2,
      objectsFailedToReap: 0,
      perSweepSelectionCapReached: false,
    });
  });

  it('is a dry run while the deletes flag is off: logs exactly what it would reap and deletes nothing', async () => {
    const orphanKey = objectKeyInWorkbookA('orphan.jpg');
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, metricsService } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(orphanKey, { generationOrNull: '42' })] },
      deletesEnabled: false,
    });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_OBJECT_REAPED, 1);
    expect(findLoggedEntry(infoSpy, 'Dry run: would reap 1 unreferenced')).toMatchObject({
      workbookKeyPrefix: WORKBOOK_A_KEY_PREFIX,
      objectsWouldReap: [{ key: orphanKey, generation: '42' }],
    });
    const summaryLogEntry = findLoggedEntry(infoSpy, 'Rehosted-asset reaper sweep complete');
    expect(summaryLogEntry?.message).toContain('dry run');
    expect(summaryLogEntry).toMatchObject({ deletesEnabled: false, objectsSelectedForReaping: 1, objectsReaped: 0 });
  });

  it('counts a re-uploaded object (412) and a vanished one (404) as neither reaped nor failed', async () => {
    const reuploadedKey = objectKeyInWorkbookA('reuploaded.jpg');
    const vanishedKey = objectKeyInWorkbookA('vanished.jpg');
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, metricsService } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(reuploadedKey), listedObject(vanishedKey)] },
    });
    deleteLiveObjectFromAssetBucketIfGenerationMatches.mockImplementation((key: string) =>
      Promise.resolve(key === reuploadedKey ? 'changed-since-listed' : 'already-gone'),
    );

    await service.reapUnreferencedRehostedAssetObjects();

    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_OBJECT_REAPED, 1);
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_OBJECT_REAP_FAILED, 1);
    expect(findLoggedEntry(infoSpy, 'Rehosted-asset reaper sweep complete')).toMatchObject({
      objectsSelectedForReaping: 2,
      objectsReaped: 0,
      objectsChangedSinceListed: 1,
      objectsAlreadyGone: 1,
      objectsFailedToReap: 0,
    });
  });

  it('is non-fatal: a failed delete is logged and counted, and the sweep continues', async () => {
    const failingKey = objectKeyInWorkbookA('boom.jpg');
    const okKeys = [objectKeyInWorkbookA('ok-1.jpg'), objectKeyInWorkbookA('ok-2.jpg')];
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, metricsService } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: {
        [WORKBOOK_A_KEY_PREFIX]: [listedObject(failingKey), ...okKeys.map((key) => listedObject(key))],
      },
    });
    deleteLiveObjectFromAssetBucketIfGenerationMatches.mockImplementation((key: string) =>
      key === failingKey ? Promise.reject(new Error('boom')) : Promise.resolve('deleted'),
    );

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).toHaveBeenCalledTimes(3);
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_OBJECT_REAP_FAILED, 1);
    expect(
      metricsService.logValue.mock.calls.filter(
        (call: unknown[]) => call[0] === CustomMetric.REHOSTED_ASSET_OBJECT_REAPED,
      ),
    ).toHaveLength(2);
    expect(findLoggedEntry(warnSpy, 'Failed to reap rehosted asset object')).toMatchObject({ key: failingKey });
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED, 1);
    expect(findLoggedEntry(infoSpy, 'Rehosted-asset reaper sweep complete')).toMatchObject({
      objectsReaped: 2,
      objectsFailedToReap: 1,
    });
  });

  it(`aborts the sweep after ${MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES} failed deletes in a row`, async () => {
    const objectCount = MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES + 30;
    const {
      service,
      deleteLiveObjectFromAssetBucketIfGenerationMatches,
      listLiveObjectsInAssetBucketWithKeyPrefix,
      metricsService,
    } = makeService({
      workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX, WORKBOOK_B_KEY_PREFIX],
      objectsByWorkbookKeyPrefix: {
        [WORKBOOK_A_KEY_PREFIX]: Array.from({ length: objectCount }, (_, index) =>
          listedObject(objectKeyInWorkbookA(`file-${index}.jpg`)),
        ),
        [WORKBOOK_B_KEY_PREFIX]: [listedObject(`${WORKBOOK_B_KEY_PREFIX}NOTION/89ef/orphan.png`)],
      },
    });
    deleteLiveObjectFromAssetBucketIfGenerationMatches.mockRejectedValue(new Error('403 Forbidden'));

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).toHaveBeenCalledTimes(
      MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES,
    );
    expect(listLiveObjectsInAssetBucketWithKeyPrefix).not.toHaveBeenCalledWith(WORKBOOK_B_KEY_PREFIX);
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED, 1);
    expect(findLoggedEntry(errorSpy, 'Rehosted-asset reaper sweep aborted')).toMatchObject({
      objectsFailedToReap: MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES,
    });
  });

  it('selects at most the per-sweep cap and leaves the rest for the next run', async () => {
    const objectCount = MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP + 7;
    const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, listLiveObjectsInAssetBucketWithKeyPrefix } =
      makeService({
        workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX, WORKBOOK_B_KEY_PREFIX],
        objectsByWorkbookKeyPrefix: {
          [WORKBOOK_A_KEY_PREFIX]: Array.from({ length: objectCount }, (_, index) =>
            listedObject(objectKeyInWorkbookA(`file-${index}.jpg`)),
          ),
          [WORKBOOK_B_KEY_PREFIX]: [listedObject(`${WORKBOOK_B_KEY_PREFIX}NOTION/89ef/orphan.png`)],
        },
      });

    await service.reapUnreferencedRehostedAssetObjects();

    expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).toHaveBeenCalledTimes(
      MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP,
    );
    // The sweep stops at the cap instead of moving on to the next workbook.
    expect(listLiveObjectsInAssetBucketWithKeyPrefix).not.toHaveBeenCalledWith(WORKBOOK_B_KEY_PREFIX);
    expect(findLoggedEntry(infoSpy, 'Rehosted-asset reaper sweep complete')).toMatchObject({
      objectsSelectedForReaping: MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP,
      perSweepSelectionCapReached: true,
    });
  });

  describe('aborts without deleting anything', () => {
    it('when the reference query fails (never treats a failed query as "no references")', async () => {
      const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches, assetFindMany, metricsService } =
        makeService({
          workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
          objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(objectKeyInWorkbookA('orphan.jpg'))] },
        });
      assetFindMany.mockImplementation(() => Promise.reject(new Error('connection reset')));

      await service.reapUnreferencedRehostedAssetObjects();

      expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED, 1);
      expect(findLoggedEntry(errorSpy, 'Rehosted-asset reaper sweep aborted')).toMatchObject({ objectsScanned: 1 });
    });

    it('when listing the bucket fails', async () => {
      const {
        service,
        deleteLiveObjectFromAssetBucketIfGenerationMatches,
        listWorkbookKeyPrefixesInAssetBucket,
        metricsService,
      } = makeService({ workbookKeyPrefixes: [], objectsByWorkbookKeyPrefix: {} });
      listWorkbookKeyPrefixesInAssetBucket.mockRejectedValue(new Error('503 Service Unavailable'));

      await service.reapUnreferencedRehostedAssetObjects();

      expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED, 1);
    });

    it('when a stored rehostedUrl is outside its own workbook prefix in this bucket (URL drift tripwire)', async () => {
      const {
        service,
        queryRaw,
        listWorkbookKeyPrefixesInAssetBucket,
        deleteLiveObjectFromAssetBucketIfGenerationMatches,
        metricsService,
      } = makeService({
        workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
        objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(objectKeyInWorkbookA('orphan.jpg'))] },
        rehostedUrlsOutsideTheirOwnWorkbookKeyPrefix: 3,
      });

      await service.reapUnreferencedRehostedAssetObjects();

      // The tripwire binds the bucket's key-root URL; the workbook id is appended per row in SQL.
      expect((queryRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([`${PUBLIC_URL_PREFIX}v1/`]);
      expect(listWorkbookKeyPrefixesInAssetBucket).not.toHaveBeenCalled();
      expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED, 1);
      expect(findLoggedEntry(errorSpy, 'Rehosted-asset reaper sweep aborted')).toBeDefined();
    });
  });

  describe('guards', () => {
    it('does nothing when GCS_ASSET_BUCKET is not configured', async () => {
      const { service, listWorkbookKeyPrefixesInAssetBucket, getBooleanFlag } = makeService({
        workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
        objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(objectKeyInWorkbookA('orphan.jpg'))] },
        isAssetBucketConfigured: false,
      });

      await service.reapUnreferencedRehostedAssetObjects();

      expect(getBooleanFlag).not.toHaveBeenCalled();
      expect(listWorkbookKeyPrefixesInAssetBucket).not.toHaveBeenCalled();
    });

    it('does nothing outside Cloud Run without REHOSTED_ASSET_REAPER_ALLOW_LOCAL', async () => {
      delete process.env.RUNNING_IN_CLOUD;
      const { service, listWorkbookKeyPrefixesInAssetBucket, deleteLiveObjectFromAssetBucketIfGenerationMatches } =
        makeService({
          workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
          objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(objectKeyInWorkbookA('orphan.jpg'))] },
          isAllowedToRunOutsideCloudRun: false,
        });

      await service.reapUnreferencedRehostedAssetObjects();

      expect(listWorkbookKeyPrefixesInAssetBucket).not.toHaveBeenCalled();
      expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).not.toHaveBeenCalled();
    });

    it('runs outside Cloud Run with REHOSTED_ASSET_REAPER_ALLOW_LOCAL', async () => {
      delete process.env.RUNNING_IN_CLOUD;
      const orphanKey = objectKeyInWorkbookA('orphan.jpg');
      const { service, deleteLiveObjectFromAssetBucketIfGenerationMatches } = makeService({
        workbookKeyPrefixes: [WORKBOOK_A_KEY_PREFIX],
        objectsByWorkbookKeyPrefix: { [WORKBOOK_A_KEY_PREFIX]: [listedObject(orphanKey)] },
        isAllowedToRunOutsideCloudRun: true,
      });

      await service.reapUnreferencedRehostedAssetObjects();

      expect(deleteLiveObjectFromAssetBucketIfGenerationMatches).toHaveBeenCalledWith(orphanKey, `gen-${orphanKey}`);
    });
  });
});
