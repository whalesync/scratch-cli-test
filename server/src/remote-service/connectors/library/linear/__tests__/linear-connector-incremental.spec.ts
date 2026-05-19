import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, PullRecordFilesOptions } from '../../../types';

// Break the connector-registry circular import chain (same shape as the
// Notion incremental spec).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Linear'),
}));

const mockListEntities = jest.fn();

jest.mock('../linear-api-client', () => {
  class LinearError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code?: string,
    ) {
      super(message);
      this.name = 'LinearError';
    }
  }
  return {
    LinearError,
    LinearApiClient: jest.fn().mockImplementation(() => ({
      listEntities: mockListEntities,
    })),
  };
});

import { LinearConnector } from '../linear-connector';
import { buildLinearUpdatedAtFilter } from '../linear-incremental';

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'issues', remoteId: ['issues'] },
    slug: 'issues',
    name: 'Issues',
    idColumnRemoteId: 'id',
    schema: {} as unknown as TSchema,
  };
}

function lastListEntitiesCall(): unknown[] {
  return mockListEntities.mock.calls[mockListEntities.mock.calls.length - 1] as unknown[];
}

describe('LinearConnector.supportsIncrementalPull', () => {
  it('is always true — every Linear entity has a server-side updatedAt', () => {
    const connector = new LinearConnector({ accessToken: 'fake' });
    expect(connector.supportsIncrementalPull()).toBe(true);
  });
});

describe('LinearConnector.pullRecordFiles (incremental)', () => {
  let connector: LinearConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield { nodes: [{ id: 'issue_1', updatedAt: '2026-05-14T13:00:00.000Z' }], endCursor: null };
    });
    connector = new LinearConnector({ accessToken: 'fake' });
  });

  it('runs a full pull and returns {} when pullMode is not incremental (no filter passed)', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    // listEntities(entityType, pageSize, resumeCursor, filter) — filter is undefined.
    expect(lastListEntitiesCall()).toEqual(['issues', 50, undefined, undefined]);
  });

  it('passes the updatedAt filter and returns a newWatermark when incremental', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options = { pullMode: 'incremental', since } as PullRecordFilesOptions;

    const before = Date.now();
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, options);
    const after = Date.now();

    expect(lastListEntitiesCall()).toEqual(['issues', 50, undefined, buildLinearUpdatedAtFilter(since)]);
    expect(result.newWatermark).toBeInstanceOf(Date);
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
  });

  it('treats incremental without a `since` as a full pull (no filter, no watermark)', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, {
      pullMode: 'incremental',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(lastListEntitiesCall()).toEqual(['issues', 50, undefined, undefined]);
  });

  it('forwards a resume cursor from progress', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    await connector.pullRecordFiles(buildTableSpec(), callback, { endCursor: 'cur_42' }, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(lastListEntitiesCall()).toEqual(['issues', 50, 'cur_42', buildLinearUpdatedAtFilter(since)]);
  });
});
