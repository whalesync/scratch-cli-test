import axios, { AxiosInstance } from 'axios';
import { RateLimiter, WithRetryOpts, withRetry as standaloneWithRetry } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  AirtableApiPushResponse,
  AirtableBaseSchemaResponseV2,
  AirtableListBasesResponse,
  AirtableRecord,
} from './airtable-types';

const AIRTABLE_API_BASE_URL = 'https://api.airtable.com/v0';

const AIRTABLE_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => axios.isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!axios.isAxiosError(error)) return undefined;
    const header = String(error.response?.headers?.['retry-after'] ?? '');
    const seconds = header ? parseInt(header, 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/**
 * Client for making api calls to airtable.
 */
export class AirtableApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter }) {
    this.client = createApiClient({
      baseURL: AIRTABLE_API_BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async retryableRequest<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, AIRTABLE_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, AIRTABLE_RETRY_OPTS);
  }

  /**
   * https://airtable.com/developers/web/api/list-bases
   */
  async listBases(): Promise<AirtableListBasesResponse> {
    const r = await this.retryableRequest(() => this.client.get<AirtableListBasesResponse>('/meta/bases'));
    return r.data;
  }

  async getBaseSchema(baseId: string): Promise<AirtableBaseSchemaResponseV2> {
    const r = await this.retryableRequest(() =>
      this.client.get<AirtableBaseSchemaResponseV2>(`/meta/bases/${baseId}/tables`),
    );
    return r.data;
  }

  async *listRecords(
    baseId: string,
    tableId: string,
    options: { filterByFormula?: string; view?: string } = {},
  ): AsyncGenerator<AirtableRecord[], void> {
    let offset: string | undefined;
    do {
      const r = await this.retryableRequest(() =>
        this.client.get<{
          records: AirtableRecord[];
          offset?: string;
        }>(`/${baseId}/${tableId}`, {
          params: { offset, ...options },
        }),
      );
      yield r.data.records;
      offset = r.data.offset;
    } while (offset);
  }

  // Fields are keyed by airtable field ids.
  async createRecords(
    baseId: string,
    tableId: string,
    records: { fields: Record<string, unknown> }[],
  ): Promise<AirtableRecord[]> {
    const r = await this.retryableRequest(() =>
      this.client.post<AirtableApiPushResponse>(
        `/${baseId}/${tableId}`,
        { records, typecast: true },
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    return r.data.records ?? [];
  }

  async updateRecords(
    baseId: string,
    tableId: string,
    records: { id?: string; fields: Record<string, unknown> }[],
  ): Promise<AirtableRecord[]> {
    const r = await this.retryableRequest(() =>
      this.client.patch<AirtableApiPushResponse>(
        `/${baseId}/${tableId}`,
        { records, typecast: true },
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    return r.data.records ?? [];
  }

  async deleteRecords(baseId: string, tableId: string, recordIds: string[]): Promise<void> {
    await this.retryableRequest(() =>
      this.client.delete(`/${baseId}/${tableId}`, {
        params: { records: recordIds },
      }),
    );
  }
}
