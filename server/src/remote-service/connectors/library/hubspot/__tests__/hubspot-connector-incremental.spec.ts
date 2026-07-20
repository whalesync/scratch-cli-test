import { Type, type TSchema } from '@sinclair/typebox';
import { IncrementalPullSupport, X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { BaseJsonTableSpec, ConnectorFile, dotPath, PullRecordFilesOptions } from '../../../types';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'HubSpot'),
}));

const mockGetProperties = jest.fn();
const mockListRecords = jest.fn();
const mockSearchRecordsModifiedSince = jest.fn();
const mockGetRecord = jest.fn();

jest.mock('../hubspot-api-client', () => ({
  HubspotApiClient: jest.fn().mockImplementation(() => ({
    getProperties: mockGetProperties,
    listRecords: mockListRecords,
    searchRecordsModifiedSince: mockSearchRecordsModifiedSince,
    getRecord: mockGetRecord,
  })),
  HubspotError: class HubspotError extends Error {},
}));

import { HubspotConnector } from '../hubspot-connector';

/**
 * Build a table spec in the HubSpot-nested shape
 * (`properties.properties.properties.<name>`). When `annotateModified` is true,
 * `hs_lastmodifieddate` carries the last-modified-field annotation so the
 * connector auto-detects it.
 */
function buildTableSpec(annotateModified: boolean, objectType = 'companies'): BaseJsonTableSpec {
  const propsBag: Record<string, TSchema> = {
    name: Type.Union([Type.String(), Type.Null()]),
    hs_lastmodifieddate: Type.Union(
      [Type.String(), Type.Null()],
      annotateModified ? { [X_SCRATCH_LAST_MODIFIED_FIELD]: true } : {},
    ),
  };
  return {
    id: { wsId: objectType, remoteId: [objectType] },
    slug: objectType,
    name: 'Companies',
    schema: Type.Object({
      id: Type.String(),
      properties: Type.Object(propsBag),
    }),
    idPath: dotPath('id'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

async function* onePage(records: ConnectorFile[], nextCursor?: string) {
  await Promise.resolve();
  yield { records, nextCursor };
}

describe('HubspotConnector incremental support', () => {
  let connector: HubspotConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new HubspotConnector('test-token');
  });

  it('reports SUPPORTED when the schema has an annotated last-modified property', () => {
    expect(connector.incrementalPullSupport({} as PullRecordFilesOptions, buildTableSpec(true))).toBe(
      IncrementalPullSupport.SUPPORTED,
    );
  });

  it('reports NEEDS_CONFIGURATION when no field is annotated or configured (custom object)', () => {
    expect(connector.incrementalPullSupport({} as PullRecordFilesOptions, buildTableSpec(false))).toBe(
      IncrementalPullSupport.NEEDS_CONFIGURATION,
    );
  });

  it('reports SUPPORTED when the user explicitly declares modifiedAtField, even without annotation', () => {
    expect(
      connector.incrementalPullSupport(
        { modifiedAtField: 'my_custom_modified' } as PullRecordFilesOptions,
        buildTableSpec(false),
      ),
    ).toBe(IncrementalPullSupport.SUPPORTED);
  });

  it('treats a null tableSpec as NEEDS_CONFIGURATION (REST layer has no schema yet)', () => {
    expect(connector.incrementalPullSupport({} as PullRecordFilesOptions, null)).toBe(
      IncrementalPullSupport.NEEDS_CONFIGURATION,
    );
  });
});

describe('HubspotConnector.pullRecordFiles', () => {
  let connector: HubspotConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProperties.mockResolvedValue([{ name: 'name' }, { name: 'hs_lastmodifieddate' }]);
    mockListRecords.mockImplementation(() => onePage([{ id: 'L1' } as ConnectorFile]));
    mockSearchRecordsModifiedSince.mockImplementation(() => onePage([{ id: 'S1' } as ConnectorFile]));
    // Incremental hydration: each searched record is re-fetched via GET so the
    // emitted file carries `associations` (the Search API never returns them).
    mockGetRecord.mockImplementation((_objectType: string, recordId: string) =>
      Promise.resolve({ id: recordId, associations: { companies: { results: [] } } }),
    );
    connector = new HubspotConnector('test-token');
  });

  it('runs a full pull via listRecords and returns {} when pullMode is not incremental', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(true), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(mockListRecords).toHaveBeenCalledTimes(1);
    expect(mockSearchRecordsModifiedSince).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ files: [{ id: 'L1' }], connectorProgress: { afterCursor: undefined } });
  });

  it('runs incremental via searchRecordsModifiedSince and returns a newWatermark', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const before = Date.now();
    const result = await connector.pullRecordFiles(buildTableSpec(true), callback, {}, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);
    const after = Date.now();

    expect(mockListRecords).not.toHaveBeenCalled();
    expect(mockSearchRecordsModifiedSince).toHaveBeenCalledWith(
      'companies',
      ['name', 'hs_lastmodifieddate'],
      'hs_lastmodifieddate',
      since,
      undefined,
    );
    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    // The emitted file is the hydrated GET result (with `associations`), not
    // the bare search result — a bare search result would overwrite the
    // record file WITHOUT its associations key and wipe live FK data.
    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 'S1', associations: { companies: { results: [] } } }],
      connectorProgress: { afterCursor: undefined },
    });
    expect(mockGetRecord).toHaveBeenCalledWith(
      'companies',
      'S1',
      ['name', 'hs_lastmodifieddate'],
      ['notes', 'tasks', 'tickets', 'deals', 'contacts', 'companies'],
    );
  });

  it('emits search results directly, without hydration GETs, for object types with no association types', async () => {
    // `products` is absent from ASSOCIATIONS_BY_OBJECT_TYPE — there is nothing
    // to hydrate, so the per-record GETs would be pure overhead.
    await connector.pullRecordFiles(buildTableSpec(true, 'products'), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(mockGetRecord).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ files: [{ id: 'S1' }], connectorProgress: { afterCursor: undefined } });
  });

  it('skips records deleted between the search page and the hydration GET (getRecord → null)', async () => {
    mockSearchRecordsModifiedSince.mockImplementation(() =>
      onePage([{ id: 'S1' } as ConnectorFile, { id: 'S2-deleted' } as ConnectorFile]),
    );
    mockGetRecord.mockImplementation((_objectType: string, recordId: string) =>
      Promise.resolve(recordId === 'S2-deleted' ? null : { id: recordId, associations: {} }),
    );

    await connector.pullRecordFiles(buildTableSpec(true), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 'S1', associations: {} }],
      connectorProgress: { afterCursor: undefined },
    });
  });

  it('uses the explicit modifiedAtField override for the search filter', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    await connector.pullRecordFiles(buildTableSpec(false), callback, {}, {
      pullMode: 'incremental',
      since,
      modifiedAtField: 'my_custom_modified',
    } as PullRecordFilesOptions);

    expect(mockSearchRecordsModifiedSince).toHaveBeenCalledWith(
      'companies',
      ['name', 'hs_lastmodifieddate'],
      'my_custom_modified',
      since,
      undefined,
    );
  });

  it('demotes to a full pull when incremental but no last-modified field resolves', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(false), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(mockListRecords).toHaveBeenCalledTimes(1);
    expect(mockSearchRecordsModifiedSince).not.toHaveBeenCalled();
  });

  it('demotes to a full pull when incremental but `since` is missing', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(true), callback, {}, {
      pullMode: 'incremental',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(mockListRecords).toHaveBeenCalledTimes(1);
    expect(mockSearchRecordsModifiedSince).not.toHaveBeenCalled();
  });

  it('resumes the search from progress.afterCursor', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    await connector.pullRecordFiles(buildTableSpec(true), callback, { afterCursor: 'CUR42' }, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(mockSearchRecordsModifiedSince).toHaveBeenCalledWith(
      'companies',
      ['name', 'hs_lastmodifieddate'],
      'hs_lastmodifieddate',
      since,
      'CUR42',
    );
  });
});
