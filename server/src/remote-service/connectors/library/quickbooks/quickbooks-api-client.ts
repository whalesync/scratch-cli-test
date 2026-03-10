import axios, { AxiosInstance } from 'axios';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { QuickBooksCredentials, QuickBooksQueryResponse } from './quickbooks-types';

const QBO_PRODUCTION_BASE = 'https://quickbooks.api.intuit.com';
const QBO_SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const QBO_MAX_RESULTS = 1000;

/**
 * Custom error class for QuickBooks API errors.
 */
export class QuickBooksError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
    super(message);
    this.name = 'QuickBooksError';
    this.statusCode = statusCode;
    this.code = code;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the QuickBooks Online API.
 *
 * Uses the QBO v3 REST API with OAuth 2.0 Bearer token authentication.
 * API docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities
 */
export class QuickBooksApiClient {
  private readonly client: AxiosInstance;
  private readonly realmId: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(credentials: QuickBooksCredentials, opts?: { rateLimiter?: RateLimiter; sandbox?: boolean }) {
    this.realmId = credentials.realmId;
    this.rateLimiter = opts?.rateLimiter;

    const baseURL = opts?.sandbox ? QBO_SANDBOX_BASE : QBO_PRODUCTION_BASE;

    this.client = axios.create({
      baseURL: `${baseURL}/v3/company/${credentials.realmId}`,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Execute a rate-limited request.
   */
  private async rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      await this.rateLimiter.waitForQuota();
    }
    return fn();
  }

  /**
   * Test connection by querying CompanyInfo.
   */
  async testConnection(): Promise<void> {
    try {
      await this.rateLimitedRequest(() =>
        this.client.get<QuickBooksQueryResponse>('/query', {
          params: { query: 'SELECT CompanyName FROM CompanyInfo' },
        }),
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
          throw new QuickBooksError('Invalid or expired QuickBooks credentials', status, 'UNAUTHORIZED');
        }
      }
      throw error;
    }
  }

  /**
   * Query entities using QBO's SQL-like query language.
   * Returns the array of entities and whether more results exist.
   *
   * QBO uses 1-based STARTPOSITION.
   */
  async query(
    entityType: string,
    startPosition: number,
    maxResults: number = QBO_MAX_RESULTS,
  ): Promise<{ entities: Record<string, unknown>[]; hasMore: boolean }> {
    const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const response = await this.rateLimitedRequest(() =>
      this.client.get<QuickBooksQueryResponse>('/query', { params: { query } }),
    );

    const queryResponse = response.data.QueryResponse;
    const entities = (queryResponse[entityType] as Record<string, unknown>[] | undefined) ?? [];
    const hasMore = entities.length === maxResults;

    return { entities, hasMore };
  }

  /**
   * Get a single entity by type and ID.
   * Returns null if not found (404).
   */
  async getEntity(entityType: string, id: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.rateLimitedRequest(() =>
        this.client.get<Record<string, Record<string, unknown>>>(`/${entityType.toLowerCase()}/${id}`),
      );
      return response.data[entityType] ?? null;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
