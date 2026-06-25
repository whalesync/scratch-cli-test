import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { createApiClient } from '../../create-api-client';
import {
  MemberstackCreateMemberRequest,
  MemberstackDeleteMemberRequest,
  MemberstackMember,
  MemberstackPaginatedResponse,
  MemberstackUpdateMemberRequest,
} from './memberstack-types';

const MEMBERSTACK_API_BASE_URL = 'https://admin.memberstack.com';

/**
 * Custom error class for Memberstack API errors.
 */
export class MemberstackError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'MemberstackError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the Memberstack Admin API.
 *
 * Uses axios for HTTP requests with X-API-KEY header authentication.
 * API docs: https://developers.memberstack.com/admin-rest-api/member-actions
 */
export class MemberstackApiClient {
  private readonly client: AxiosInstance;

  constructor(apiKey: string) {
    const headers: RawAxiosRequestHeaders = {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    this.client = createApiClient({
      baseURL: MEMBERSTACK_API_BASE_URL,
      headers,
    });
  }

  /**
   * Validate the API key by listing members with limit=1.
   * @throws MemberstackError if the API key is invalid.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.client.get<MemberstackPaginatedResponse>('/members', {
        params: { limit: 1 },
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new MemberstackError('Invalid API key', 401, error.response?.data);
      }
      throw error;
    }
  }

  /**
   * List members with cursor-based pagination.
   * Yields pages of member records.
   */
  async *listMembers(
    pageSize = 200,
    resumeCursor?: string,
  ): AsyncGenerator<{ data: MemberstackMember[]; endCursor: string | null }, void> {
    let cursor: string | null = resumeCursor ?? null;
    let hasNextPage = true;

    while (hasNextPage) {
      const params: Record<string, unknown> = { limit: pageSize };
      if (cursor) {
        params.after = cursor;
      }

      const response = await this.client.get<MemberstackPaginatedResponse>('/members', { params });
      const { data, endCursor, hasNextPage: nextPage } = response.data;

      cursor = endCursor;
      hasNextPage = nextPage;

      if (data && data.length > 0) {
        yield { data, endCursor: cursor };
      }
    }
  }

  /**
   * Sample the custom-field keys configured for this app by scanning a single page
   * of members and taking the union of their `customFields` keys.
   *
   * Memberstack's Admin API exposes no custom-field-definitions endpoint, so the only
   * way to discover which custom fields exist is to read them off member records. Custom
   * fields are defined at the app level and present on most/all members, so one page is
   * almost always enough; a key that appears only on members beyond the sampled page is
   * picked up on the next schema refresh. Keys are returned sorted for a deterministic
   * schema (so `schema.json` doesn't churn between pulls).
   */
  async fetchSampleCustomFieldKeys(sampleSize = 200): Promise<string[]> {
    const keys = new Set<string>();
    for await (const batch of this.listMembers(sampleSize)) {
      for (const member of batch.data) {
        for (const key of Object.keys(member.customFields ?? {})) {
          keys.add(key);
        }
      }
      // One page is sufficient for app-level custom fields; stop after the first.
      break;
    }
    return [...keys].sort();
  }

  /**
   * Get a member by ID or email.
   * @returns The member, or null if not found.
   */
  async getMember(idOrEmail: string): Promise<MemberstackMember | null> {
    try {
      const response = await this.client.get<{ data: MemberstackMember }>(`/members/${encodeURIComponent(idOrEmail)}`);
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new member.
   * @returns The created member.
   */
  async createMember(data: MemberstackCreateMemberRequest): Promise<MemberstackMember> {
    const response = await this.client.post<{ data: MemberstackMember }>('/members', data);
    return response.data.data;
  }

  /**
   * Update an existing member by ID.
   * @returns The updated member.
   */
  async updateMember(id: string, data: MemberstackUpdateMemberRequest): Promise<MemberstackMember> {
    const response = await this.client.patch<{ data: MemberstackMember }>(`/members/${id}`, data);
    return response.data.data;
  }

  /**
   * Delete a member by ID.
   * @throws Does not throw on 404 (idempotent delete).
   */
  async deleteMember(id: string, options?: MemberstackDeleteMemberRequest): Promise<void> {
    try {
      await this.client.delete(`/members/${id}`, { data: options });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  /**
   * Add a free plan to a member.
   */
  async addPlan(memberId: string, planId: string): Promise<void> {
    await this.client.post(`/members/${memberId}/add-plan`, { planId });
  }

  /**
   * Remove a free plan from a member.
   */
  async removePlan(memberId: string, planId: string): Promise<void> {
    await this.client.post(`/members/${memberId}/remove-plan`, { planId });
  }
}
