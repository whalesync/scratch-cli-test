import axios, { AxiosInstance, isAxiosError, RawAxiosRequestHeaders } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  AudiencefulCreatePersonRequest,
  AudiencefulDeletePersonRequest,
  AudiencefulField,
  AudiencefulFieldsResponse,
  AudiencefulPaginatedResponse,
  AudiencefulPerson,
  AudiencefulUpdatePersonRequest,
} from './audienceful-types';

const AUDIENCEFUL_API_BASE_URL = 'https://app.audienceful.com/api';

/**
 * Custom error class for Audienceful API errors.
 */
export class AudiencefulError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'AudiencefulError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

const AUDIENCEFUL_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/**
 * Low-level API client for the Audienceful API.
 *
 * Uses axios for HTTP requests with X-Api-Key header authentication.
 */
export class AudiencefulApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter }) {
    const headers: RawAxiosRequestHeaders = {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    this.client = createApiClient({
      baseURL: AUDIENCEFUL_API_BASE_URL,
      headers,
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, AUDIENCEFUL_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, AUDIENCEFUL_RETRY_OPTS);
  }

  /**
   * Validate the API key by making a request to the people endpoint.
   * @throws AudiencefulError if the API key is invalid.
   */
  async validateCredentials(): Promise<void> {
    try {
      // The API uses /people/ with trailing slash
      await this.withRetry(() => this.client.get<AudiencefulPaginatedResponse<AudiencefulPerson>>('/people/'));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new AudiencefulError('Invalid API key', 401, error.response?.data);
      }
      throw error;
    }
  }

  /**
   * List people (subscribers) with pagination.
   * Returns an async generator that yields pages of people.
   * Uses cursor-based pagination following the 'next' URL.
   */
  async *listPeople(
    resumeUrl?: string,
  ): AsyncGenerator<{ results: AudiencefulPerson[]; nextUrl: string | null }, void> {
    let nextPageUrl: string | null = resumeUrl ?? null;

    do {
      const url: string = nextPageUrl ?? '/people/'; // NextPageUrl is the full URI for pagination, but the base page is relative to the API base URL.

      const response = await this.withRetry(() =>
        this.client.get<AudiencefulPaginatedResponse<AudiencefulPerson>>(url),
      );
      nextPageUrl = response.data.next;

      if (response.data.results && response.data.results.length > 0) {
        yield { results: response.data.results, nextUrl: nextPageUrl };
      }
    } while (nextPageUrl);
  }

  /**
   * Get a person by their UID.
   * @param uid - The unique identifier of the person.
   * @returns The person, or null if not found.
   */
  async getPerson(uid: string): Promise<AudiencefulPerson | null> {
    try {
      const response = await this.withRetry(() => this.client.get<AudiencefulPerson>(`/people/${uid}/`));
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new person (subscriber).
   * @param data - The person data to create.
   * @returns The created person.
   */
  async createPerson(data: AudiencefulCreatePersonRequest): Promise<AudiencefulPerson> {
    const response = await this.withRetry(() => this.client.post<AudiencefulPerson>('/people/', data));
    return response.data;
  }

  /**
   * Update an existing person (subscriber) by email.
   * @param data - The person data to update, must include email.
   * @returns The updated person.
   */
  async updatePerson(data: AudiencefulUpdatePersonRequest): Promise<AudiencefulPerson> {
    const response = await this.withRetry(() => this.client.put<AudiencefulPerson>('/people/', data));
    return response.data;
  }

  /**
   * Delete a person (subscriber) by email.
   * @param data - The delete request with email.
   * @throws Does not throw on 404 (idempotent delete).
   */
  async deletePerson(data: AudiencefulDeletePersonRequest): Promise<void> {
    try {
      await this.withRetry(() => this.client.delete('/people/', { data }));
    } catch (error) {
      // Ignore 404 errors - the person may already be deleted
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  /**
   * List custom fields defined in the Audienceful account.
   * @returns Array of field definitions.
   */
  async listFields(): Promise<AudiencefulField[]> {
    // The fields endpoint is under /people/fields/
    const response = await this.withRetry(() => this.client.get<AudiencefulFieldsResponse>('/people/fields/'));
    return response.data;
  }
}
