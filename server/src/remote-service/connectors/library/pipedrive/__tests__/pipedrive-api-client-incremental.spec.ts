import { PipedriveApiClient } from '../pipedrive-api-client';
import { PipedriveEntityType } from '../pipedrive-types';

// Mock create-api-client so the real Pipedrive HTTP client is never constructed;
// the single `get` jest.fn() surfaces the exact path + query params we assert on.
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    put: mockPut,
    delete: mockDelete,
  })),
}));

// entityType → its full REST collection path
const ENTITY_PATH: Record<PipedriveEntityType, string> = {
  deals: '/api/v2/deals',
  persons: '/api/v2/persons',
  organizations: '/api/v2/organizations',
  products: '/api/v2/products',
  activities: '/api/v2/activities',
  leads: '/v1/leads',
  notes: '/v1/notes',
  pipelines: '/api/v2/pipelines',
  stages: '/api/v2/stages',
};

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _page of gen) {
    // consume the generator
  }
}

describe('PipedriveApiClient.listEntities updated_since — cursor (v2)', () => {
  let client: PipedriveApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    // One page with no next_cursor → the generator stops after the first page.
    mockGet.mockResolvedValue({
      data: { data: [{ id: 1, update_time: '2026-05-14T13:00:00Z' }], additional_data: {} },
    });
    client = new PipedriveApiClient('fake-key');
  });

  const cursorCases: Array<[PipedriveEntityType]> = [
    ['deals'],
    ['persons'],
    ['organizations'],
    ['products'],
    ['activities'],
  ];

  it.each(cursorCases)('full scan for %s hits its collection path and omits updated_since', async (entityType) => {
    await drain(client.listEntities(entityType));
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(ENTITY_PATH[entityType], { params: { limit: 500 } });
  });

  // Pipelines/stages are cursor-paginated v2 config endpoints. They are always
  // full-pulled (the connector never passes updated_since — their endpoints 400
  // on it), so only the full-scan path is exercised here.
  it.each([['pipelines'], ['stages']] as Array<[PipedriveEntityType]>)(
    'full scan for %s hits its collection path',
    async (entityType) => {
      await drain(client.listEntities(entityType));
      expect(mockGet).toHaveBeenCalledWith(ENTITY_PATH[entityType], { params: { limit: 500 } });
    },
  );

  it.each(cursorCases)('incremental for %s adds updated_since verbatim', async (entityType) => {
    await drain(client.listEntities(entityType, undefined, '2026-05-14T11:59:00Z'));
    expect(mockGet).toHaveBeenCalledWith(ENTITY_PATH[entityType], {
      params: { limit: 500, updated_since: '2026-05-14T11:59:00Z' },
    });
  });

  it('threads the resume cursor alongside updated_since', async () => {
    await drain(client.listEntities('deals', { cursor: 'CURSOR123' }, '2026-05-14T11:59:00Z'));
    expect(mockGet).toHaveBeenCalledWith('/api/v2/deals', {
      params: { limit: 500, cursor: 'CURSOR123', updated_since: '2026-05-14T11:59:00Z' },
    });
  });

  it('re-sends updated_since on every page across cursor pagination (not just the first)', async () => {
    mockGet.mockReset();
    mockGet
      .mockResolvedValueOnce({ data: { data: [{ id: 1 }], additional_data: { next_cursor: 'C2' } } })
      .mockResolvedValueOnce({ data: { data: [{ id: 2 }], additional_data: {} } });

    await drain(client.listEntities('deals', undefined, '2026-05-14T11:59:00Z'));

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenNthCalledWith(1, '/api/v2/deals', {
      params: { limit: 500, updated_since: '2026-05-14T11:59:00Z' },
    });
    expect(mockGet).toHaveBeenNthCalledWith(2, '/api/v2/deals', {
      params: { limit: 500, cursor: 'C2', updated_since: '2026-05-14T11:59:00Z' },
    });
  });
});

describe('PipedriveApiClient.listEntities updated_since — offset (v1)', () => {
  let client: PipedriveApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({
      data: { data: [{ id: 1 }], additional_data: { pagination: { more_items_in_collection: false } } },
    });
    client = new PipedriveApiClient('fake-key');
  });

  const offsetCases: Array<[PipedriveEntityType]> = [['leads'], ['notes']];

  it.each(offsetCases)('full scan for %s sends start=0 and omits updated_since', async (entityType) => {
    await drain(client.listEntities(entityType));
    expect(mockGet).toHaveBeenCalledWith(ENTITY_PATH[entityType], { params: { limit: 500, start: 0 } });
  });

  it.each(offsetCases)('incremental for %s adds updated_since alongside start', async (entityType) => {
    await drain(client.listEntities(entityType, undefined, '2026-05-14T11:59:00Z'));
    expect(mockGet).toHaveBeenCalledWith(ENTITY_PATH[entityType], {
      params: { limit: 500, start: 0, updated_since: '2026-05-14T11:59:00Z' },
    });
  });

  it('re-sends updated_since on every page across offset pagination', async () => {
    mockGet.mockReset();
    mockGet
      .mockResolvedValueOnce({
        data: { data: [{ id: 1 }], additional_data: { pagination: { more_items_in_collection: true, next_start: 2 } } },
      })
      .mockResolvedValueOnce({
        data: { data: [{ id: 2 }], additional_data: { pagination: { more_items_in_collection: false } } },
      });

    await drain(client.listEntities('leads', undefined, '2026-05-14T11:59:00Z'));

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenNthCalledWith(1, '/v1/leads', {
      params: { limit: 500, start: 0, updated_since: '2026-05-14T11:59:00Z' },
    });
    expect(mockGet).toHaveBeenNthCalledWith(2, '/v1/leads', {
      params: { limit: 500, start: 2, updated_since: '2026-05-14T11:59:00Z' },
    });
  });
});
