import axios, { AxiosInstance } from 'axios';
import { RateLimiter, WithRetryOpts, withRetry as standaloneWithRetry } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  AirtableApiCreateField,
  AirtableApiCreateFieldResponse,
  AirtableApiCreateTableRequest,
  AirtableApiCreateTableResponse,
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
  private readonly retryOpts: WithRetryOpts;

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter; retryOverrides?: Partial<WithRetryOpts> }) {
    this.client = createApiClient({
      baseURL: AIRTABLE_API_BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
    });
    this.rateLimiter = opts?.rateLimiter;
    this.retryOpts = opts?.retryOverrides ? { ...AIRTABLE_RETRY_OPTS, ...opts.retryOverrides } : AIRTABLE_RETRY_OPTS;
  }

  private async retryableRequest<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, this.retryOpts);
    }
    return standaloneWithRetry(fn, this.retryOpts);
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
    options: { filterByFormula?: string; view?: string; resumeOffset?: string } = {},
  ): AsyncGenerator<{ records: AirtableRecord[]; nextOffset?: string }, void> {
    const { resumeOffset, ...apiOptions } = options;
    let offset: string | undefined = resumeOffset;
    do {
      const r = await this.retryableRequest(() =>
        this.client.get<{
          records: AirtableRecord[];
          offset?: string;
        }>(`/${baseId}/${tableId}`, {
          params: { offset, ...apiOptions },
        }),
      );
      offset = r.data.offset;
      yield { records: r.data.records, nextOffset: offset };
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

  /**
   * Create a new table (with its initial fields) in a base.
   * https://airtable.com/developers/web/api/create-table
   *
   * Requires the token to have the `schema.bases:write` scope; a read-only token
   * gets a 403, which the connector surfaces as a failed create.
   */
  async createTable(baseId: string, request: AirtableApiCreateTableRequest): Promise<AirtableApiCreateTableResponse> {
    const r = await this.retryableRequest(() =>
      this.client.post<AirtableApiCreateTableResponse>(`/meta/bases/${baseId}/tables`, request, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    return r.data;
  }

  /**
   * Add a single field to an existing table.
   * https://airtable.com/developers/web/api/create-field
   *
   * Requires the `schema.bases:write` scope. Airtable creates one field per call,
   * so the connector loops for bulk field creation.
   */
  async createField(
    baseId: string,
    tableId: string,
    field: AirtableApiCreateField,
  ): Promise<AirtableApiCreateFieldResponse> {
    const r = await this.retryableRequest(() =>
      this.client.post<AirtableApiCreateFieldResponse>(`/meta/bases/${baseId}/tables/${tableId}/fields`, field, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    return r.data;
  }

  /**
   * Fetch base metadata including the workspaceId.
   * https://airtable.com/developers/web/api/get-base
   */
  async getBaseMetadata(baseId: string): Promise<{ id: string; workspaceId: string }> {
    const r = await this.retryableRequest(() =>
      this.client.get<{ id: string; workspaceId: string }>(`/meta/bases/${baseId}`),
    );
    return r.data;
  }
}
