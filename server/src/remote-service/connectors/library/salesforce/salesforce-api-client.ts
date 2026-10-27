import { AxiosError, AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { ConnectorAuthTokenOrProvider, toConnectorAuthTokenProvider } from '../../connector-auth-token';
import { createApiClient } from '../../create-api-client';
import {
  SALESFORCE_API_VERSION,
  SalesforceCompositeResponse,
  SalesforceQueryResponse,
  SalesforceRestErrorBody,
  SalesforceSaveResult,
  SalesforceSObjectDescribe,
  SalesforceSObjectListResponse,
  SalesforceSObjectSummary,
} from './salesforce-types';

/** sObject Collections (`/composite/sobjects`) accept at most 200 records per request. */
export const SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS = 200;

/**
 * Longest encoded SOQL string sent as a plain `GET /query?q=`. Salesforce rejects request lines past roughly
 * 20,000 characters with HTTP 431 (measured), and an `ORDER BY Id` pull that selects every field of a wide object
 * can exceed that. Longer queries run as a GET subrequest inside `POST /composite`, which carries the URL in the
 * request body (verified with a 47,000-character query).
 */
const SALESFORCE_MAX_ENCODED_SOQL_LENGTH_FOR_GET = 15_000;

/** The `referenceId` of the single subrequest a long query is wrapped in. */
const COMPOSITE_QUERY_REFERENCE_ID = 'query';

/** One error Salesforce reported, whether from a failed REST call or from one record of a collection request. */
export interface SalesforceReportedError {
  code: string;
  message: string;
  fields: string[];
}

/**
 * A failure Salesforce reported inside an otherwise-successful HTTP response: a record rejected by an sObject
 * Collections request, or a failed subrequest of a `/composite` call. HTTP-level failures stay `AxiosError`s so
 * the shared 401/403/timeout handling applies to them.
 */
export class SalesforceApiError extends Error {
  constructor(
    message: string,
    public readonly reportedErrors: SalesforceReportedError[],
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'SalesforceApiError';
  }

  hasErrorCode(errorCode: string): boolean {
    return this.reportedErrors.some((reportedError) => reportedError.code === errorCode);
  }
}

/** The `[{ errorCode, message }]` array Salesforce returns as the body of a failed REST call, if that's what it is. */
export function salesforceErrorsFromResponseBody(responseBody: unknown): SalesforceReportedError[] {
  if (!Array.isArray(responseBody)) {
    return [];
  }
  return responseBody
    .filter(
      (element): element is SalesforceRestErrorBody =>
        typeof element === 'object' &&
        element !== null &&
        typeof (element as { message?: unknown }).message === 'string',
    )
    .map((element) => ({ code: element.errorCode, message: element.message, fields: element.fields ?? [] }));
}

export function salesforceErrorsFromAxiosError(error: AxiosError): SalesforceReportedError[] {
  return salesforceErrorsFromResponseBody(error.response?.data);
}

/** HTTP statuses that mean the request never completed on a healthy Salesforce server. */
const SALESFORCE_RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

/**
 * True for a Salesforce failure that is worth retrying after a pause:
 *  - 429, or a 502/503/504 gateway/availability failure — the request did not complete, so even a create is
 *    safe to resend;
 *  - `REQUEST_LIMIT_EXCEEDED` for the org's *concurrent* long-running request limit, which clears as soon as
 *    other requests finish.
 *
 * The org's *daily* API request limit uses the same error code (`TotalRequests Limit exceeded`) but does not
 * clear for up to 24 hours, so it is not retried.
 */
export function isTransientSalesforceError(error: unknown): boolean {
  if (!isAxiosError(error)) {
    return false;
  }
  const httpStatus = error.response?.status ?? 0;
  if (SALESFORCE_RETRYABLE_HTTP_STATUSES.has(httpStatus)) {
    return true;
  }
  return salesforceErrorsFromAxiosError(error).some(
    (reportedError) => reportedError.code === 'REQUEST_LIMIT_EXCEEDED' && /concurrent/i.test(reportedError.message),
  );
}

export const SALESFORCE_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: isTransientSalesforceError,
  // Salesforce sends no Retry-After, so the limiter's exponential backoff paces the retries.
  defaultCooldownS: 5,
};

/**
 * HTTP client for the Salesforce REST API of one org.
 *
 * Every call targets `<instanceUrl>/services/data/<SALESFORCE_API_VERSION>/`. The access token is resolved per
 * request so a long pull or publish picks up the host's token refreshes.
 */
export class SalesforceApiClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(
    private readonly instanceUrl: string,
    accessTokenOrProvider: ConnectorAuthTokenOrProvider,
    opts?: { rateLimiter?: RateLimiter },
  ) {
    const accessTokenProvider = toConnectorAuthTokenProvider(accessTokenOrProvider);
    this.rateLimiter = opts?.rateLimiter;
    this.http = createApiClient(
      {
        baseURL: `${instanceUrl}/services/data/${SALESFORCE_API_VERSION}/`,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      },
      { authorizationHeaderValueProvider: async () => `Bearer ${await accessTokenProvider()}` },
    );
  }

  /** The org's object catalog (`GET /sobjects`). One call, regardless of how many objects the org has. */
  async listSObjects(): Promise<SalesforceSObjectSummary[]> {
    const response = await this.requestWithRetry(() => this.http.get<SalesforceSObjectListResponse>('sobjects/'));
    return response.data.sobjects;
  }

  /** One object's full field metadata (`GET /sobjects/{object}/describe`). */
  async describeSObject(objectApiName: string): Promise<SalesforceSObjectDescribe> {
    const response = await this.requestWithRetry(() =>
      this.http.get<SalesforceSObjectDescribe>(`sobjects/${encodeURIComponent(objectApiName)}/describe/`),
    );
    return response.data;
  }

  /**
   * The resources this API version offers (`GET /services/data/<version>/`). The lightest authenticated call there
   * is, and it needs no permission beyond API access — unlike `/limits`, which needs "View Setup and Configuration".
   */
  async listApiResources(): Promise<Record<string, string>> {
    const response = await this.requestWithRetry(() => this.http.get<Record<string, string>>(''));
    return response.data;
  }

  /** The org's API limits and remaining allowances (`GET /limits`). Needs "View Setup and Configuration". */
  async getOrgLimits(): Promise<Record<string, unknown>> {
    const response = await this.requestWithRetry(() => this.http.get<Record<string, unknown>>('limits/'));
    return response.data;
  }

  /**
   * Run a SOQL query and return its first batch. A query too long for a GET request line runs through
   * `POST /composite` instead; the composite envelope is stripped so both paths return the same shape.
   */
  async query(soql: string): Promise<SalesforceQueryResponse> {
    const encodedSoql = encodeURIComponent(soql);
    if (encodedSoql.length <= SALESFORCE_MAX_ENCODED_SOQL_LENGTH_FOR_GET) {
      const response = await this.requestWithRetry(() =>
        this.http.get<SalesforceQueryResponse>(`query/?q=${encodedSoql}`),
      );
      return response.data;
    }
    return this.queryThroughCompositeRequest(encodedSoql);
  }

  /** Fetch the next batch of a query from the `nextRecordsUrl` Salesforce returned with the previous batch. */
  async queryMore(nextRecordsUrl: string): Promise<SalesforceQueryResponse> {
    if (!nextRecordsUrl.startsWith('/services/data/')) {
      throw new Error(`Unexpected Salesforce nextRecordsUrl: ${nextRecordsUrl}`);
    }
    const response = await this.requestWithRetry(() =>
      this.http.get<SalesforceQueryResponse>(`${this.instanceUrl}${nextRecordsUrl}`),
    );
    return response.data;
  }

  /**
   * Create up to {@link SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS} records in one all-or-none request: either every
   * record is created or none is, so a failed batch never leaves records behind for a retry to duplicate. Each
   * record carries `attributes.type`. Results are in request order.
   */
  async createRecords(recordsWithAttributesType: Record<string, unknown>[]): Promise<SalesforceSaveResult[]> {
    const response = await this.requestWithRetry(() =>
      this.http.post<SalesforceSaveResult[]>('composite/sobjects/', {
        allOrNone: true,
        records: recordsWithAttributesType,
      }),
    );
    return response.data;
  }

  /**
   * Update up to {@link SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS} records in one all-or-none request. Each record
   * carries `attributes.type` and `id`, plus only the fields to change. Results are in request order.
   */
  async updateRecords(recordsWithAttributesTypeAndId: Record<string, unknown>[]): Promise<SalesforceSaveResult[]> {
    const response = await this.requestWithRetry(() =>
      this.http.patch<SalesforceSaveResult[]>('composite/sobjects/', {
        allOrNone: true,
        records: recordsWithAttributesTypeAndId,
      }),
    );
    return response.data;
  }

  /**
   * Delete up to {@link SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS} records. Not all-or-none: a record that is
   * already gone reports `ENTITY_IS_DELETED` without blocking the rest. Results are in request order.
   */
  async deleteRecords(recordIds: string[]): Promise<SalesforceSaveResult[]> {
    const response = await this.requestWithRetry(() =>
      this.http.delete<SalesforceSaveResult[]>('composite/sobjects/', {
        params: { ids: recordIds.join(','), allOrNone: false },
      }),
    );
    return response.data;
  }

  private async queryThroughCompositeRequest(encodedSoql: string): Promise<SalesforceQueryResponse> {
    const response = await this.requestWithRetry(() =>
      this.http.post<SalesforceCompositeResponse>('composite/', {
        allOrNone: false,
        compositeRequest: [
          {
            method: 'GET',
            url: `/services/data/${SALESFORCE_API_VERSION}/query/?q=${encodedSoql}`,
            referenceId: COMPOSITE_QUERY_REFERENCE_ID,
          },
        ],
      }),
    );
    const querySubresponse = response.data.compositeResponse.find(
      (subresponse) => subresponse.referenceId === COMPOSITE_QUERY_REFERENCE_ID,
    );
    if (!querySubresponse) {
      throw new Error('Salesforce returned no result for the composite query request');
    }
    if (querySubresponse.httpStatusCode >= 400) {
      const reportedErrors = salesforceErrorsFromResponseBody(querySubresponse.body);
      throw new SalesforceApiError(
        reportedErrors.map((reportedError) => reportedError.message).join(' • ') ||
          `Salesforce query failed with HTTP ${querySubresponse.httpStatusCode}`,
        reportedErrors,
        querySubresponse.httpStatusCode,
      );
    }
    return querySubresponse.body as SalesforceQueryResponse;
  }

  private requestWithRetry<T>(request: () => Promise<T>): Promise<T> {
    return this.rateLimiter
      ? this.rateLimiter.withRetry(request, SALESFORCE_RETRY_OPTS)
      : standaloneWithRetry(request, SALESFORCE_RETRY_OPTS);
  }
}
