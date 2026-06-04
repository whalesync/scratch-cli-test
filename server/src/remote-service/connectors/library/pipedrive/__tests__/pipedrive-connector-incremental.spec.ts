import { TSchema } from '@sinclair/typebox';
import { IncrementalPullSupport } from '@spinner/shared-types';
import { BaseJsonTableSpec, PullRecordFilesOptions, idPath } from '../../../types';

// Break the connector-registry circular import chain (same shape as the existing
// pipedrive-connector spec).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
}));

// The connector pulls in the v2 SDK transitively via the api-client; mock it so
// the real SDK is never constructed.
jest.mock('pipedrive/v2', () => ({
  Configuration: jest.fn(),
  DealsApi: jest.fn(),
  PersonsApi: jest.fn(),
  OrganizationsApi: jest.fn(),
  DealFieldsApi: jest.fn(),
  PersonFieldsApi: jest.fn(),
  OrganizationFieldsApi: jest.fn(),
}));

const mockListEntities = jest.fn();

jest.mock('../pipedrive-api-client', () => ({
  PipedriveApiClient: jest.fn().mockImplementation(() => ({
    listEntities: mockListEntities,
  })),
  PipedriveError: class PipedriveError extends Error {
    statusCode?: number;
    code?: string;
    responseData?: unknown;
    constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
      super(message);
      this.name = 'PipedriveError';
      this.statusCode = statusCode;
      this.code = code;
      this.responseData = responseData;
    }
  },
}));

import { PipedriveConnector } from '../pipedrive-connector';
import { buildPipedriveUpdatedSince } from '../pipedrive-incremental';

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'deals', remoteId: ['deals'] },
    slug: 'deals',
    name: 'Deals',
    idColumnRemoteId: idPath('id'),
    schema: {} as unknown as TSchema,
  };
}

function lastListEntitiesCall(): unknown[] {
  return mockListEntities.mock.calls[mockListEntities.mock.calls.length - 1] as unknown[];
}

describe('PipedriveConnector incremental support', () => {
  const connector = new PipedriveConnector('fake-key');

  it('supportsIncrementalPull is always true — every Pipedrive entity has a server-side update_time', () => {
    expect(connector.supportsIncrementalPull({} as PullRecordFilesOptions, buildTableSpec())).toBe(true);
  });

  it('incrementalPullSupport returns SUPPORTED unconditionally', () => {
    // The override takes no args — `update_time` is a fixed system field on every
    // Pipedrive entity, so there is nothing per-folder to branch on.
    expect(connector.incrementalPullSupport()).toBe(IncrementalPullSupport.SUPPORTED);
  });
});

describe('PipedriveConnector.pullRecordFiles (incremental)', () => {
  let connector: PipedriveConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield { data: [{ id: 1, update_time: '2026-05-14T13:00:00Z' }], nextCursor: undefined };
    });
    connector = new PipedriveConnector('fake-key');
  });

  it('runs a full pull and returns {} when pullMode is not incremental (no updated_since passed)', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    // listEntities(entityType, resumeCursor, updatedSince) — both undefined.
    expect(lastListEntitiesCall()).toEqual(['deals', undefined, undefined]);
  });

  it('passes updated_since and returns a newWatermark when incremental', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options = { pullMode: 'incremental', since } as PullRecordFilesOptions;

    const before = Date.now();
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, options);
    const after = Date.now();

    expect(lastListEntitiesCall()).toEqual(['deals', undefined, buildPipedriveUpdatedSince(since)]);
    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    // The callback forwards the page's records verbatim; with no next cursor the
    // checkpoint is an empty progress object.
    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 1, update_time: '2026-05-14T13:00:00Z' }],
      connectorProgress: {},
    });
  });

  it('treats incremental without a `since` as a full pull (no updated_since, no watermark)', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, {
      pullMode: 'incremental',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(lastListEntitiesCall()).toEqual(['deals', undefined, undefined]);
  });

  it('resumes from progress.nextCursor and keeps the updated_since filter', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: 'CUR42' }, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(lastListEntitiesCall()).toEqual(['deals', 'CUR42', buildPipedriveUpdatedSince(since)]);
  });

  it('checkpoints the next cursor when a page returns one', async () => {
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield { data: [{ id: 7 }], nextCursor: 'NEXT99' };
    });

    await connector.pullRecordFiles(buildTableSpec(), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 7 }],
      connectorProgress: { nextCursor: 'NEXT99' },
    });
  });
});
