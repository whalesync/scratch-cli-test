import { TSchema } from '@sinclair/typebox';
import { IncrementalPullSupport } from '@spinner/shared-types';
import { BaseJsonTableSpec, PullRecordFilesOptions, dotPath } from '../../../types';

// Break the connector-registry circular import chain (same shape as the Linear
// incremental spec).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Moco CRM'),
}));

const mockListEntities = jest.fn();

jest.mock('../moco-api-client', () => {
  class MocoError extends Error {
    constructor(
      message: string,
      public statusCode?: number,
      public code?: string,
      public responseData?: unknown,
    ) {
      super(message);
      this.name = 'MocoError';
    }
  }
  return {
    MocoError,
    MocoApiClient: jest.fn().mockImplementation(() => ({
      listEntities: mockListEntities,
    })),
  };
});

import { MocoConnector } from '../moco-connector';
import { buildMocoUpdatedAfter } from '../moco-incremental';

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'companies', remoteId: ['companies'] },
    slug: 'companies',
    name: 'Companies',
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

function lastListEntitiesCall(): unknown[] {
  return mockListEntities.mock.calls[mockListEntities.mock.calls.length - 1] as unknown[];
}

describe('MocoConnector incremental support', () => {
  const connector = new MocoConnector({ domain: 'acme', apiKey: 'fake' });

  it('supportsIncrementalPull is always true — every Moco entity has a server-side updated_at', () => {
    expect(connector.supportsIncrementalPull({} as PullRecordFilesOptions, buildTableSpec())).toBe(true);
  });

  it('incrementalPullSupport returns SUPPORTED unconditionally', () => {
    // The override takes no args — `updated_at` is a fixed system field on every
    // Moco entity, so there is nothing per-folder to branch on.
    expect(connector.incrementalPullSupport()).toBe(IncrementalPullSupport.SUPPORTED);
  });
});

describe('MocoConnector.pullRecordFiles (incremental)', () => {
  let connector: MocoConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield [{ id: 1, updated_at: '2026-05-14T13:00:00.000Z' }];
    });
    connector = new MocoConnector({ domain: 'acme', apiKey: 'fake' });
  });

  it('runs a full pull and returns {} when pullMode is not incremental (no updated_after passed)', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    // listEntities(entityType, perPage, startPage, updatedAfter) — updatedAfter is undefined.
    expect(lastListEntitiesCall()).toEqual(['companies', 100, 1, undefined]);
  });

  it('passes updated_after and returns a newWatermark when incremental', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options = { pullMode: 'incremental', since } as PullRecordFilesOptions;

    const before = Date.now();
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, options);
    const after = Date.now();

    expect(lastListEntitiesCall()).toEqual(['companies', 100, 1, buildMocoUpdatedAfter(since)]);
    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    // The callback forwards the page's records verbatim and checkpoints the next
    // page (1 → 2) so the pull stays resumable.
    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 1, updated_at: '2026-05-14T13:00:00.000Z' }],
      connectorProgress: { nextPage: 2 },
    });
  });

  it('treats incremental without a `since` as a full pull (no updated_after, no watermark)', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, {}, {
      pullMode: 'incremental',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(lastListEntitiesCall()).toEqual(['companies', 100, 1, undefined]);
  });

  it('resumes from progress.nextPage and keeps the updated_after filter', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    await connector.pullRecordFiles(buildTableSpec(), callback, { nextPage: 4 }, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(lastListEntitiesCall()).toEqual(['companies', 100, 4, buildMocoUpdatedAfter(since)]);
    // The checkpoint advances from the resumed page (4 → 5), not from 1.
    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 1, updated_at: '2026-05-14T13:00:00.000Z' }],
      connectorProgress: { nextPage: 5 },
    });
  });
});
