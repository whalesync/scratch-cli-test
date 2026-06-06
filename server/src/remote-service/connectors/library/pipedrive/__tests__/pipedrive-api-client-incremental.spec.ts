import { PipedriveApiClient } from '../pipedrive-api-client';
import { PipedriveEntityType } from '../pipedrive-types';

// Mock create-api-client so the real Pipedrive HTTP client is never constructed;
// the single `get` jest.fn() surfaces the exact path + query params we assert on.
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    delete: mockDelete,
  })),
}));

// entityType → its REST collection path
const ENTITY_PATH: Record<PipedriveEntityType, string> = {
  deals: '/deals',
  persons: '/persons',
  organizations: '/organizations',
};

describe('PipedriveApiClient.listEntities updated_since', () => {
  let client: PipedriveApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    // One page with no next_cursor → the generator stops after the first page.
    // axios wraps the response body under `.data`; the body is the Pipedrive
    // envelope `{ data, additional_data }`.
    mockGet.mockResolvedValue({
      data: { data: [{ id: 1, update_time: '2026-05-14T13:00:00Z' }], additional_data: {} },
    });
    client = new PipedriveApiClient('fake-key');
  });

  async function drain(gen: AsyncIterable<unknown>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _page of gen) {
      // consume the generator
    }
  }

  const cases: Array<[PipedriveEntityType]> = [['deals'], ['persons'], ['organizations']];

  it.each(cases)('full scan for %s hits its collection path and omits updated_since', async (entityType) => {
    await drain(client.listEntities(entityType));
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(ENTITY_PATH[entityType], { params: { limit: 500 } });
  });

  it.each(cases)('incremental for %s adds updated_since verbatim', async (entityType) => {
    await drain(client.listEntities(entityType, undefined, '2026-05-14T11:59:00.000Z'));
    expect(mockGet).toHaveBeenCalledWith(ENTITY_PATH[entityType], {
      params: { limit: 500, updated_since: '2026-05-14T11:59:00.000Z' },
    });
  });

  it('threads the resume cursor alongside updated_since', async () => {
    await drain(client.listEntities('deals', 'CURSOR123', '2026-05-14T11:59:00.000Z'));
    expect(mockGet).toHaveBeenCalledWith('/deals', {
      params: { limit: 500, cursor: 'CURSOR123', updated_since: '2026-05-14T11:59:00.000Z' },
    });
  });

  it('re-sends updated_since on every page across cursor pagination (not just the first)', async () => {
    // First page carries a next_cursor → a second request is made; the second
    // page has none → the generator stops.
    mockGet.mockReset();
    mockGet
      .mockResolvedValueOnce({ data: { data: [{ id: 1 }], additional_data: { next_cursor: 'C2' } } })
      .mockResolvedValueOnce({ data: { data: [{ id: 2 }], additional_data: {} } });

    await drain(client.listEntities('deals', undefined, '2026-05-14T11:59:00.000Z'));

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenNthCalledWith(1, '/deals', {
      params: { limit: 500, updated_since: '2026-05-14T11:59:00.000Z' },
    });
    expect(mockGet).toHaveBeenNthCalledWith(2, '/deals', {
      params: { limit: 500, cursor: 'C2', updated_since: '2026-05-14T11:59:00.000Z' },
    });
  });
});
