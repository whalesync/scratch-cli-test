import { createApiClient } from '../../../create-api-client';
import { MocoApiClient } from '../moco-api-client';
import { MocoEntityType } from '../moco-types';

jest.mock('../../../create-api-client');

describe('MocoApiClient list endpoints updated_after', () => {
  let mockGet: jest.Mock;
  let client: MocoApiClient;

  beforeEach(() => {
    // One page of one record, then stop: x-total=1 with per_page≥1 makes
    // `page * per_page < total` false after the first page.
    mockGet = jest.fn().mockResolvedValue({
      data: [{ id: 1, updated_at: '2026-05-14T13:00:00.000Z' }],
      headers: { 'x-total': '1' },
    });
    (createApiClient as jest.Mock).mockReturnValue({ get: mockGet });
    client = new MocoApiClient({ domain: 'acme', apiKey: 'fake' });
  });

  async function drain(gen: AsyncIterable<unknown>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _page of gen) {
      // consume the generator
    }
  }

  function lastGetCall(): [string, { params: Record<string, unknown> }] {
    return mockGet.mock.calls[mockGet.mock.calls.length - 1] as [string, { params: Record<string, unknown> }];
  }

  // entityType → list endpoint path
  const cases: Array<[MocoEntityType, string]> = [
    ['companies', '/companies'],
    ['contacts', '/contacts/people'],
    ['projects', '/projects'],
  ];

  it.each(cases)('full scan for %s omits updated_after', async (entityType, url) => {
    await drain(client.listEntities(entityType, 100, 1));
    const [calledUrl, { params }] = lastGetCall();
    expect(calledUrl).toBe(url);
    expect(params).toEqual({ page: 1, per_page: 100 });
  });

  it.each(cases)('incremental for %s adds updated_after verbatim', async (entityType, url) => {
    await drain(client.listEntities(entityType, 100, 1, '2026-05-14T11:59:00Z'));
    const [calledUrl, { params }] = lastGetCall();
    expect(calledUrl).toBe(url);
    expect(params).toEqual({ page: 1, per_page: 100, updated_after: '2026-05-14T11:59:00Z' });
  });

  it('keeps page pagination alongside updated_after (startPage threaded through)', async () => {
    await drain(client.listCompanies(50, 3, '2026-05-14T11:59:00Z'));
    const [, { params }] = lastGetCall();
    expect(params).toEqual({ page: 3, per_page: 50, updated_after: '2026-05-14T11:59:00Z' });
  });

  it('re-sends updated_after on every page across pagination (not just the first)', async () => {
    // x-total=150 with per_page=100 → page 1 has more (1*100 < 150), page 2 stops (2*100 < 150 is false).
    mockGet.mockReset();
    mockGet
      .mockResolvedValueOnce({
        data: [{ id: 1, updated_at: '2026-05-14T13:00:00.000Z' }],
        headers: { 'x-total': '150' },
      })
      .mockResolvedValueOnce({
        data: [{ id: 2, updated_at: '2026-05-14T13:30:00.000Z' }],
        headers: { 'x-total': '150' },
      });

    await drain(client.listCompanies(100, 1, '2026-05-14T11:59:00Z'));

    expect(mockGet).toHaveBeenCalledTimes(2);
    const [, firstOpts] = mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }];
    const [, secondOpts] = mockGet.mock.calls[1] as [string, { params: Record<string, unknown> }];
    expect(firstOpts.params).toEqual({ page: 1, per_page: 100, updated_after: '2026-05-14T11:59:00Z' });
    expect(secondOpts.params).toEqual({ page: 2, per_page: 100, updated_after: '2026-05-14T11:59:00Z' });
  });
});
