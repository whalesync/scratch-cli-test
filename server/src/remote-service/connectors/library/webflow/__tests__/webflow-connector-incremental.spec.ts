import { IncrementalPullSupport } from '@spinner/shared-types';
import { BaseJsonTableSpec, PullRecordFilesOptions } from '../../../types';

// Mock display-names to break the connector-registry circular import chain (it
// imports every connector), matching the other webflow connector specs.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so the connector's internal `this.client` is the
// mock. The connector-level spec can't catch a wrong URL/query param (the
// api-client spec does), but it pins the per-table routing and the watermark.
const mockListCollectionItems = jest.fn();
const mockListAssets = jest.fn();
const mockListPages = jest.fn();
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    listCollectionItems: mockListCollectionItems,
    listAssets: mockListAssets,
    listPages: mockListPages,
  })),
  WebflowError: class WebflowError extends Error {},
}));

import { WebflowConnector } from '../webflow-connector';
import { buildWebflowLastUpdatedFilter } from '../webflow-incremental';
import { WEBFLOW_ASSETS_TABLE_ID_PREFIX } from '../webflow-json-schema';
import { WEBFLOW_PAGES_TABLE_ID_PREFIX } from '../webflow-types';

const COLLECTION_ID = 'col-1';

function specForRemoteId(collectionRemoteId: string): BaseJsonTableSpec {
  return {
    id: { wsId: 'ws', remoteId: ['site-1', collectionRemoteId] },
    slug: 's',
    name: 'n',
    schema: {},
  } as unknown as BaseJsonTableSpec;
}

const collectionSpec = (): BaseJsonTableSpec => specForRemoteId(COLLECTION_ID);
const assetsSpec = (): BaseJsonTableSpec => specForRemoteId(`${WEBFLOW_ASSETS_TABLE_ID_PREFIX}site-1`);
const pagesSpec = (): BaseJsonTableSpec => specForRemoteId(`${WEBFLOW_PAGES_TABLE_ID_PREFIX}site-1`);

describe('WebflowConnector incremental support', () => {
  const connector = new WebflowConnector('test-token');
  const noOptions = {} as PullRecordFilesOptions;

  it('is SUPPORTED for CMS collections', () => {
    expect(connector.incrementalPullSupport(noOptions, collectionSpec())).toBe(IncrementalPullSupport.SUPPORTED);
    expect(connector.supportsIncrementalPull(noOptions, collectionSpec())).toBe(true);
  });

  it('is NOT_SUPPORTED for the Assets and Pages tables', () => {
    expect(connector.incrementalPullSupport(noOptions, assetsSpec())).toBe(IncrementalPullSupport.NOT_SUPPORTED);
    expect(connector.incrementalPullSupport(noOptions, pagesSpec())).toBe(IncrementalPullSupport.NOT_SUPPORTED);
    expect(connector.supportsIncrementalPull(noOptions, assetsSpec())).toBe(false);
    expect(connector.supportsIncrementalPull(noOptions, pagesSpec())).toBe(false);
  });

  it('reports the general capability (SUPPORTED) when the spec is null', () => {
    expect(connector.incrementalPullSupport(noOptions, null)).toBe(IncrementalPullSupport.SUPPORTED);
  });
});

describe('WebflowConnector.pullRecordFiles — CMS collection items', () => {
  let connector: WebflowConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListCollectionItems.mockResolvedValue({
      items: [{ id: 'i1', lastUpdated: '2026-05-14T13:00:00.000Z' }],
      pagination: { total: 1, offset: 0, limit: 100 },
    });
    connector = new WebflowConnector('test-token');
  });

  it('runs a full pull (no lastUpdated filter) and returns {} when pullMode is not incremental', async () => {
    const result = await connector.pullRecordFiles(collectionSpec(), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(mockListCollectionItems).toHaveBeenCalledWith(COLLECTION_ID, {
      offset: 0,
      limit: 100,
      lastUpdatedSince: undefined,
    });
  });

  it('passes the lastUpdated filter and returns a newWatermark when incremental', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const before = Date.now();
    const result = await connector.pullRecordFiles(collectionSpec(), callback, {}, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);
    const after = Date.now();

    expect(mockListCollectionItems).toHaveBeenCalledWith(COLLECTION_ID, {
      offset: 0,
      limit: 100,
      lastUpdatedSince: buildWebflowLastUpdatedFilter(since),
    });
    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 'i1', lastUpdated: '2026-05-14T13:00:00.000Z' }],
      connectorProgress: { nextOffset: 1 },
    });
  });

  it('demotes an incremental request with no `since` to a full scan (no filter, no watermark)', async () => {
    const result = await connector.pullRecordFiles(collectionSpec(), callback, {}, {
      pullMode: 'incremental',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(mockListCollectionItems).toHaveBeenCalledWith(COLLECTION_ID, {
      offset: 0,
      limit: 100,
      lastUpdatedSince: undefined,
    });
  });

  it('resumes from progress.nextOffset and keeps the lastUpdated filter', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    mockListCollectionItems.mockResolvedValue({
      items: [{ id: 'i2' }],
      pagination: { total: 101, offset: 100, limit: 100 },
    });

    await connector.pullRecordFiles(collectionSpec(), callback, { nextOffset: 100 }, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(mockListCollectionItems).toHaveBeenCalledWith(COLLECTION_ID, {
      offset: 100,
      limit: 100,
      lastUpdatedSince: buildWebflowLastUpdatedFilter(since),
    });
  });
});

describe('WebflowConnector.pullRecordFiles — Assets/Pages tables never go incremental', () => {
  let connector: WebflowConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListAssets.mockResolvedValue({ assets: [], pagination: { total: 0 } });
    mockListPages.mockResolvedValue({ pages: [], pagination: { total: 0 } });
    connector = new WebflowConnector('test-token');
  });

  it('the Assets table returns {} and never calls listCollectionItems even when incremental is requested', async () => {
    const result = await connector.pullRecordFiles(assetsSpec(), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(mockListAssets).toHaveBeenCalled();
    expect(mockListCollectionItems).not.toHaveBeenCalled();
  });

  it('the Pages table returns {} and never calls listCollectionItems even when incremental is requested', async () => {
    const result = await connector.pullRecordFiles(pagesSpec(), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(mockListPages).toHaveBeenCalled();
    expect(mockListCollectionItems).not.toHaveBeenCalled();
  });
});
