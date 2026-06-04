import { PipedriveApiClient } from '../pipedrive-api-client';
import { PipedriveEntityType } from '../pipedrive-types';

const mockGetDeals = jest.fn();
const mockGetPersons = jest.fn();
const mockGetOrganizations = jest.fn();

// Mock the v2 SDK so the real Pipedrive HTTP client is never constructed; each
// list API surfaces a jest.fn() we can assert the request params against.
jest.mock('pipedrive/v2', () => ({
  Configuration: jest.fn(),
  DealsApi: jest.fn().mockImplementation(() => ({ getDeals: mockGetDeals })),
  PersonsApi: jest.fn().mockImplementation(() => ({ getPersons: mockGetPersons })),
  OrganizationsApi: jest.fn().mockImplementation(() => ({ getOrganizations: mockGetOrganizations })),
  DealFieldsApi: jest.fn(),
  PersonFieldsApi: jest.fn(),
  OrganizationFieldsApi: jest.fn(),
}));

describe('PipedriveApiClient.listEntities updated_since', () => {
  let client: PipedriveApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    // One page with no next_cursor → the generator stops after the first page.
    const onePage = { data: [{ id: 1, update_time: '2026-05-14T13:00:00Z' }], additional_data: {} };
    mockGetDeals.mockResolvedValue(onePage);
    mockGetPersons.mockResolvedValue(onePage);
    mockGetOrganizations.mockResolvedValue(onePage);
    client = new PipedriveApiClient('fake-key');
  });

  async function drain(gen: AsyncIterable<unknown>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _page of gen) {
      // consume the generator
    }
  }

  // entityType → its list API mock
  const cases: Array<[PipedriveEntityType, jest.Mock]> = [
    ['deals', mockGetDeals],
    ['persons', mockGetPersons],
    ['organizations', mockGetOrganizations],
  ];

  it.each(cases)('full scan for %s omits updated_since', async (entityType, mockFn) => {
    await drain(client.listEntities(entityType));
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith({ limit: 500 });
  });

  it.each(cases)('incremental for %s adds updated_since verbatim', async (entityType, mockFn) => {
    await drain(client.listEntities(entityType, undefined, '2026-05-14T11:59:00.000Z'));
    expect(mockFn).toHaveBeenCalledWith({ limit: 500, updated_since: '2026-05-14T11:59:00.000Z' });
  });

  it('threads the resume cursor alongside updated_since', async () => {
    await drain(client.listEntities('deals', 'CURSOR123', '2026-05-14T11:59:00.000Z'));
    expect(mockGetDeals).toHaveBeenCalledWith({
      limit: 500,
      cursor: 'CURSOR123',
      updated_since: '2026-05-14T11:59:00.000Z',
    });
  });

  it('re-sends updated_since on every page across cursor pagination (not just the first)', async () => {
    // First page carries a next_cursor → a second request is made; the second
    // page has none → the generator stops.
    mockGetDeals.mockReset();
    mockGetDeals
      .mockResolvedValueOnce({ data: [{ id: 1 }], additional_data: { next_cursor: 'C2' } })
      .mockResolvedValueOnce({ data: [{ id: 2 }], additional_data: {} });

    await drain(client.listEntities('deals', undefined, '2026-05-14T11:59:00.000Z'));

    expect(mockGetDeals).toHaveBeenCalledTimes(2);
    expect(mockGetDeals).toHaveBeenNthCalledWith(1, { limit: 500, updated_since: '2026-05-14T11:59:00.000Z' });
    expect(mockGetDeals).toHaveBeenNthCalledWith(2, {
      limit: 500,
      cursor: 'C2',
      updated_since: '2026-05-14T11:59:00.000Z',
    });
  });
});
