import { TSchema } from '@sinclair/typebox';
import { IncrementalPullSupport } from '@spinner/shared-types';
import { BaseJsonTableSpec, PullRecordFilesOptions, idPath } from '../../../types';

// Break the connector-registry circular import chain (same shape as the existing
// pipedrive-connector spec).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
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
import { PipedriveEntityType } from '../pipedrive-types';

function buildTableSpec(entityType: PipedriveEntityType): BaseJsonTableSpec {
  return {
    id: { wsId: entityType, remoteId: [entityType] },
    slug: entityType,
    name: entityType,
    idColumnRemoteId: idPath('id'),
    schema: {} as unknown as TSchema,
  };
}

function lastListEntitiesCall(): unknown[] {
  return mockListEntities.mock.calls[mockListEntities.mock.calls.length - 1] as unknown[];
}

describe('PipedriveConnector incremental support', () => {
  const connector = new PipedriveConnector('fake-key');
  const noOptions = {} as PullRecordFilesOptions;

  it('supportsIncrementalPull is true for objects with an indexed update_time (deals)', () => {
    expect(connector.supportsIncrementalPull(noOptions, buildTableSpec('deals'))).toBe(true);
    expect(connector.supportsIncrementalPull(noOptions, buildTableSpec('leads'))).toBe(true);
    expect(connector.supportsIncrementalPull(noOptions, buildTableSpec('notes'))).toBe(true);
  });

  it('supportsIncrementalPull is false for the config endpoints that reject updated_since (pipelines/stages)', () => {
    expect(connector.supportsIncrementalPull(noOptions, buildTableSpec('pipelines'))).toBe(false);
    expect(connector.supportsIncrementalPull(noOptions, buildTableSpec('stages'))).toBe(false);
  });

  it('incrementalPullSupport is per-entity and reports the general capability when the spec is null', () => {
    expect(connector.incrementalPullSupport(noOptions, buildTableSpec('deals'))).toBe(IncrementalPullSupport.SUPPORTED);
    expect(connector.incrementalPullSupport(noOptions, buildTableSpec('pipelines'))).toBe(
      IncrementalPullSupport.NOT_SUPPORTED,
    );
    // No schema on hand (REST pre-pull) → report the connector's general capability.
    expect(connector.incrementalPullSupport(noOptions, null)).toBe(IncrementalPullSupport.SUPPORTED);
  });
});

describe('PipedriveConnector.pullRecordFiles — cursor entities (v2)', () => {
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
    const result = await connector.pullRecordFiles(buildTableSpec('deals'), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    // listEntities(entityType, resume, updatedSince) — cursor resume is empty, no filter.
    expect(lastListEntitiesCall()).toEqual(['deals', { cursor: undefined }, undefined]);
  });

  it('passes updated_since and returns a newWatermark when incremental', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options = { pullMode: 'incremental', since } as PullRecordFilesOptions;

    const before = Date.now();
    const result = await connector.pullRecordFiles(buildTableSpec('deals'), callback, {}, options);
    const after = Date.now();

    expect(lastListEntitiesCall()).toEqual(['deals', { cursor: undefined }, buildPipedriveUpdatedSince(since)]);
    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 1, update_time: '2026-05-14T13:00:00Z' }],
      connectorProgress: {},
    });
  });

  it('resumes from progress.nextCursor and keeps the updated_since filter', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    await connector.pullRecordFiles(buildTableSpec('deals'), callback, { nextCursor: 'CUR42' }, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(lastListEntitiesCall()).toEqual(['deals', { cursor: 'CUR42' }, buildPipedriveUpdatedSince(since)]);
  });

  it('checkpoints the next cursor when a page returns one', async () => {
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield { data: [{ id: 7 }], nextCursor: 'NEXT99' };
    });

    await connector.pullRecordFiles(buildTableSpec('deals'), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 7 }],
      connectorProgress: { nextCursor: 'NEXT99' },
    });
  });
});

describe('PipedriveConnector.pullRecordFiles — offset entities (v1)', () => {
  let connector: PipedriveConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield { data: [{ id: 1 }], nextStart: undefined };
    });
    connector = new PipedriveConnector('fake-key');
  });

  it('resumes from progress.nextStart (not a cursor) for v1 entities', async () => {
    await connector.pullRecordFiles(buildTableSpec('leads'), callback, { nextStart: 40 }, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(lastListEntitiesCall()).toEqual(['leads', { start: 40 }, undefined]);
  });

  it('passes a fresh-start resume ({ start: undefined }) when there is no progress', async () => {
    await connector.pullRecordFiles(buildTableSpec('notes'), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(lastListEntitiesCall()).toEqual(['notes', { start: undefined }, undefined]);
  });

  it('checkpoints nextStart (not nextCursor) when a page returns one', async () => {
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield { data: [{ id: 7 }], nextStart: 2 };
    });

    await connector.pullRecordFiles(buildTableSpec('leads'), callback, {}, {
      pullMode: 'incremental',
      since: new Date('2026-05-01T12:00:00.000Z'),
    } as PullRecordFilesOptions);

    expect(callback).toHaveBeenCalledWith({
      files: [{ id: 7 }],
      connectorProgress: { nextStart: 2 },
    });
  });
});

describe('PipedriveConnector.pullRecordFiles — full-pull-only entities (pipelines/stages)', () => {
  let connector: PipedriveConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListEntities.mockImplementation(async function* () {
      await Promise.resolve();
      yield { data: [{ id: 1 }], nextCursor: undefined };
    });
    connector = new PipedriveConnector('fake-key');
  });

  it.each([['pipelines'], ['stages']] as Array<[PipedriveEntityType]>)(
    'never sends updated_since for %s even when incremental is requested, and returns no watermark',
    async (entityType) => {
      const result = await connector.pullRecordFiles(buildTableSpec(entityType), callback, {}, {
        pullMode: 'incremental',
        since: new Date('2026-05-01T12:00:00.000Z'),
      } as PullRecordFilesOptions);

      // updatedSince (3rd arg) must be undefined; no watermark is issued.
      expect(lastListEntitiesCall()).toEqual([entityType, { cursor: undefined }, undefined]);
      expect(result).toEqual({});
    },
  );
});
