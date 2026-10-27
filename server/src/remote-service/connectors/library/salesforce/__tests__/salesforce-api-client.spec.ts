import { AxiosError } from 'axios';
import { withRetry } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../../create-api-client';
import {
  isTransientSalesforceError,
  SALESFORCE_RETRY_OPTS,
  SalesforceApiClient,
  SalesforceApiError,
} from '../salesforce-api-client';

jest.mock('../../../create-api-client');

const fakeHttp = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() };
(createApiClient as jest.Mock).mockReturnValue(fakeHttp);

function salesforceAxiosError(status: number, body: unknown = []): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data: body, statusText: '', headers: {}, config: {} },
  });
}

describe('isTransientSalesforceError', () => {
  it.each([429, 502, 503, 504])('retries HTTP %i', (status) => {
    expect(isTransientSalesforceError(salesforceAxiosError(status))).toBe(true);
  });

  it('retries the concurrent request limit, which clears as other requests finish', () => {
    expect(
      isTransientSalesforceError(
        salesforceAxiosError(403, [
          { errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'ConcurrentPerOrgLongTxn Limit exceeded.' },
        ]),
      ),
    ).toBe(true);
  });

  it('does not retry the daily request limit, which lasts up to a day', () => {
    expect(
      isTransientSalesforceError(
        salesforceAxiosError(403, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }]),
      ),
    ).toBe(false);
  });

  it.each([400, 401, 403, 404, 500])('does not retry HTTP %i', (status) => {
    expect(isTransientSalesforceError(salesforceAxiosError(status))).toBe(false);
  });

  it('recovers from a 503 within the retry budget', async () => {
    const request = jest.fn().mockRejectedValueOnce(salesforceAxiosError(503)).mockResolvedValueOnce('ok');
    await expect(withRetry(request, { ...SALESFORCE_RETRY_OPTS, initialRetryDelayMs: 1, maxRetries: 2 })).resolves.toBe(
      'ok',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('SalesforceApiClient', () => {
  const client = new SalesforceApiClient('https://acme.my.salesforce.com', 'token');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('targets the pinned API version on the org instance', () => {
    new SalesforceApiClient('https://acme.my.salesforce.com', 'token');
    const [axiosConfig, apiClientOptions] = (createApiClient as jest.Mock).mock.calls.at(-1) as [
      { baseURL: string },
      { authorizationHeaderValueProvider?: unknown },
    ];
    expect(axiosConfig.baseURL).toBe('https://acme.my.salesforce.com/services/data/v66.0/');
    expect(typeof apiClientOptions.authorizationHeaderValueProvider).toBe('function');
  });

  it('tests the connection against the version root, which needs no admin permission', async () => {
    fakeHttp.get.mockResolvedValue({ data: { sobjects: '/services/data/v66.0/sobjects' } });
    await client.listApiResources();
    expect(fakeHttp.get).toHaveBeenCalledWith('');
  });

  it('runs a short query as a GET', async () => {
    fakeHttp.get.mockResolvedValue({ data: { totalSize: 0, done: true, records: [] } });
    await client.query('SELECT Id FROM Account');
    expect(fakeHttp.get).toHaveBeenCalledWith('query/?q=SELECT%20Id%20FROM%20Account');
  });

  it('runs a query too long for a GET request line through POST /composite and unwraps the result', async () => {
    const queryResult = { totalSize: 1, done: true, records: [{ Id: '001000000000001AAA' }] };
    fakeHttp.post.mockResolvedValue({
      data: { compositeResponse: [{ body: queryResult, httpStatusCode: 200, referenceId: 'query' }] },
    });
    const longSoql = `SELECT ${Array.from({ length: 2000 }, (_, index) => `Field${index}__c`).join(',')} FROM Account`;

    await expect(client.query(longSoql)).resolves.toEqual(queryResult);
    expect(fakeHttp.get).not.toHaveBeenCalled();
    const [path, body] = fakeHttp.post.mock.calls[0] as [
      string,
      { compositeRequest: { method: string; url: string }[] },
    ];
    expect(path).toBe('composite/');
    expect(body.compositeRequest).toEqual([
      expect.objectContaining({ method: 'GET', url: `/services/data/v66.0/query/?q=${encodeURIComponent(longSoql)}` }),
    ]);
  });

  it('throws the failure of a composite query', async () => {
    fakeHttp.post.mockResolvedValue({
      data: {
        compositeResponse: [
          {
            body: [{ errorCode: 'INVALID_FIELD', message: 'No such column' }],
            httpStatusCode: 400,
            referenceId: 'query',
          },
        ],
      },
    });
    await expect(client.query(`SELECT ${'X'.repeat(16_000)} FROM Account`)).rejects.toThrow(
      new SalesforceApiError('No such column', []),
    );
  });

  it('follows a nextRecordsUrl on the instance, and refuses one that points elsewhere', async () => {
    fakeHttp.get.mockResolvedValue({ data: { totalSize: 0, done: true, records: [] } });
    await client.queryMore('/services/data/v66.0/query/01gXX-2000');
    expect(fakeHttp.get).toHaveBeenCalledWith('https://acme.my.salesforce.com/services/data/v66.0/query/01gXX-2000');
    await expect(client.queryMore('https://evil.example/steal')).rejects.toThrow(
      /Unexpected Salesforce nextRecordsUrl/,
    );
  });

  it('creates and updates all-or-none, and deletes record by record', async () => {
    fakeHttp.post.mockResolvedValue({ data: [] });
    fakeHttp.patch.mockResolvedValue({ data: [] });
    fakeHttp.delete.mockResolvedValue({ data: [] });

    await client.createRecords([{ attributes: { type: 'Account' }, Name: 'A' }]);
    await client.updateRecords([{ attributes: { type: 'Account' }, id: '001000000000001AAA', Name: 'B' }]);
    await client.deleteRecords(['001000000000001AAA', '001000000000002AAA']);

    expect(fakeHttp.post).toHaveBeenCalledWith('composite/sobjects/', {
      allOrNone: true,
      records: [{ attributes: { type: 'Account' }, Name: 'A' }],
    });
    expect(fakeHttp.patch).toHaveBeenCalledWith('composite/sobjects/', {
      allOrNone: true,
      records: [{ attributes: { type: 'Account' }, id: '001000000000001AAA', Name: 'B' }],
    });
    expect(fakeHttp.delete).toHaveBeenCalledWith('composite/sobjects/', {
      params: { ids: '001000000000001AAA,001000000000002AAA', allOrNone: false },
    });
  });
});
