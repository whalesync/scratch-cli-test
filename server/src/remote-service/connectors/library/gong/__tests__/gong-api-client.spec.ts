import { GongApiClient } from '../gong-api-client';

/**
 * Pagination tests for the Gong API client's cursor loops.
 *
 * These run against a mocked HTTP layer because live pagination CANNOT be
 * forced below 100 records/page: Gong silently ignores every page-size
 * parameter (verified live 2026-08-06 — `GET /v2/users?limit=1` returns the
 * full page, `POST /v2/calls/extensive` with `limit: 2` returns all records).
 * The cursor envelope (`records.cursor`) only appears past 100 records, so the
 * loop logic — threading the cursor, resuming from a checkpoint, terminating
 * on the last page, mapping the empty-result 404 — is what we own and what
 * these tests pin.
 */

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({ get: mockGet, post: mockPost })),
}));

function axios404WithErrors(errors: string[]): Error & { isAxiosError: boolean; response: unknown } {
  const error = new Error('Request failed with status code 404') as Error & {
    isAxiosError: boolean;
    response: unknown;
  };
  error.isAxiosError = true;
  error.response = { status: 404, data: { errors } };
  return error;
}

/** Typed accessors for jest mock-call arguments (axios args are untyped). */
function getCallParams(call_index: number): Record<string, unknown> {
  return (mockGet.mock.calls[call_index] as unknown[])[1] as { params: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}
function postCallBody(call_index: number): Record<string, unknown> {
  return (mockPost.mock.calls[call_index] as unknown[])[1] as Record<string, unknown>;
}

describe('GongApiClient pagination', () => {
  let client: GongApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new GongApiClient('key', 'secret', 'https://test.api.gong.io');
  });

  it('listUsers walks all pages by threading the records.cursor', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: { users: [{ id: 'u1' }, { id: 'u2' }], records: { totalRecords: 5, cursor: 'CURSOR-A' } },
      })
      .mockResolvedValueOnce({
        data: { users: [{ id: 'u3' }, { id: 'u4' }], records: { totalRecords: 5, cursor: 'CURSOR-B' } },
      })
      .mockResolvedValueOnce({
        data: { users: [{ id: 'u5' }], records: { totalRecords: 5 } }, // no cursor → last page
      });

    const pages: { ids: string[]; nextCursor: string | undefined }[] = [];
    for await (const { items, nextCursor } of client.listUsers()) {
      pages.push({ ids: items.map((user) => user.id), nextCursor });
    }

    expect(pages).toEqual([
      { ids: ['u1', 'u2'], nextCursor: 'CURSOR-A' },
      { ids: ['u3', 'u4'], nextCursor: 'CURSOR-B' },
      { ids: ['u5'], nextCursor: undefined },
    ]);
    // The cursor from each page must be sent on the next request.
    expect((getCallParams(0) as { params: Record<string, unknown> }).params.cursor).toBeUndefined();
    expect((getCallParams(1) as { params: Record<string, unknown> }).params.cursor).toBe('CURSOR-A');
    expect((getCallParams(2) as { params: Record<string, unknown> }).params.cursor).toBe('CURSOR-B');
  });

  it('listUsers resumes from a checkpointed cursor (crash-resume path)', async () => {
    mockGet.mockResolvedValueOnce({ data: { users: [{ id: 'u5' }], records: { totalRecords: 5 } } });

    const pages = [];
    for await (const page of client.listUsers('RESUME-CURSOR')) pages.push(page);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect((getCallParams(0) as { params: Record<string, unknown> }).params.cursor).toBe('RESUME-CURSOR');
    expect(pages[0].items.map((user) => user.id)).toEqual(['u5']);
  });

  it('listCallsExtensive threads the cursor through the POST body and stops on the last page', async () => {
    mockPost
      .mockResolvedValueOnce({
        data: { calls: [{ metaData: { id: 'c1' } }, { metaData: { id: 'c2' } }], records: { cursor: 'PAGE-2' } },
      })
      .mockResolvedValueOnce({
        data: { calls: [{ metaData: { id: 'c3' } }], records: {} },
      });

    const pulled_call_ids: string[] = [];
    for await (const { items } of client.listCallsExtensive('ws-1')) {
      pulled_call_ids.push(...items.map((call) => call.metaData.id));
    }

    expect(pulled_call_ids).toEqual(['c1', 'c2', 'c3']);
    expect(mockPost).toHaveBeenCalledTimes(2);
    const first_body = postCallBody(0);
    const second_body = postCallBody(1);
    expect(first_body.cursor).toBeUndefined();
    expect(first_body.filter).toEqual({ workspaceId: 'ws-1' });
    expect(first_body.contentSelector).toBeDefined();
    expect(second_body.cursor).toBe('PAGE-2');
  });

  it('maps the empty-result 404 to an empty stream (first page)', async () => {
    mockPost.mockRejectedValueOnce(axios404WithErrors(['No calls found corresponding to the provided filters']));

    const pages = [];
    for await (const page of client.listCallsExtensive('ws-1')) pages.push(page);

    expect(pages).toEqual([]);
  });

  it('propagates a genuine 404 (not the empty-result shape)', async () => {
    mockPost.mockRejectedValueOnce(axios404WithErrors(['Some other failure']));

    const consume = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _page of client.listCallsExtensive('ws-1')) {
        // no-op
      }
    };
    await expect(consume()).rejects.toThrow('404');
  });

  it('listCallsExtensiveByIds accumulates across cursored pages', async () => {
    mockPost
      .mockResolvedValueOnce({
        data: { calls: [{ metaData: { id: 'c1' } }], records: { cursor: 'MORE' } },
      })
      .mockResolvedValueOnce({
        data: { calls: [{ metaData: { id: 'c2' } }], records: {} },
      });

    const calls = await client.listCallsExtensiveByIds(['c1', 'c2']);
    expect(calls.map((call) => call.metaData.id)).toEqual(['c1', 'c2']);
    expect(postCallBody(0).filter).toEqual({ callIds: ['c1', 'c2'] });
    expect(postCallBody(1).cursor).toBe('MORE');
  });

  it('listCallTranscripts pages like the calls endpoint but without a contentSelector', async () => {
    mockPost
      .mockResolvedValueOnce({
        data: { callTranscripts: [{ callId: 'c1', transcript: [] }], records: { cursor: 'T2' } },
      })
      .mockResolvedValueOnce({
        data: { callTranscripts: [{ callId: 'c2', transcript: [] }], records: {} },
      });

    const transcript_call_ids: string[] = [];
    for await (const { items } of client.listCallTranscripts('ws-1')) {
      transcript_call_ids.push(...items.map((transcript) => transcript.callId));
    }

    expect(transcript_call_ids).toEqual(['c1', 'c2']);
    expect(postCallBody(0).contentSelector).toBeUndefined();
    expect(postCallBody(1).cursor).toBe('T2');
  });
});
