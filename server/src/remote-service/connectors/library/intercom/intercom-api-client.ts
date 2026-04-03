import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { createApiClient } from '../../create-api-client';
import {
  IntercomArticle,
  IntercomCollection,
  IntercomConversation,
  IntercomConversationListItem,
  IntercomCreateArticleRequest,
  IntercomCreateCollectionRequest,
  IntercomCursorPaginatedResponse,
  IntercomPaginatedResponse,
  IntercomUpdateArticleRequest,
  IntercomUpdateCollectionRequest,
} from './intercom-types';

const INTERCOM_API_BASE_URL = 'https://api.intercom.io';
const INTERCOM_API_VERSION = '2.11';

/**
 * Custom error class for Intercom API errors.
 */
export class IntercomError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'IntercomError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the Intercom REST API.
 *
 * Uses Bearer token authentication and Intercom-Version header.
 * API docs: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/
 */
export class IntercomApiClient {
  private readonly client: AxiosInstance;

  constructor(accessToken: string) {
    const headers: RawAxiosRequestHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Intercom-Version': INTERCOM_API_VERSION,
    };

    this.client = createApiClient({
      baseURL: INTERCOM_API_BASE_URL,
      headers,
    });
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Validate the access token by fetching the authenticated admin.
   * @throws IntercomError if the token is invalid.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.client.get('/me');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new IntercomError('Invalid access token', 401, error.response?.data);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Articles
  // ---------------------------------------------------------------------------

  /**
   * List articles with page-based pagination.
   * Yields pages of article records.
   */
  async *listArticles(pageSize = 25): AsyncGenerator<IntercomArticle[], void> {
    let page = 1;
    let totalPages = Infinity;

    while (page <= totalPages) {
      const response = await this.client.get<IntercomPaginatedResponse<IntercomArticle>>('/articles', {
        params: { page, per_page: pageSize },
      });

      totalPages = response.data.pages.total_pages;
      const articles = response.data.data ?? [];

      if (articles.length > 0) {
        yield articles;
      }

      page++;
    }
  }

  /**
   * Get a single article by ID.
   * @returns The article, or null if not found.
   */
  async getArticle(id: string): Promise<IntercomArticle | null> {
    try {
      const response = await this.client.get<IntercomArticle>(`/articles/${id}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new article.
   * @returns The created article.
   */
  async createArticle(data: IntercomCreateArticleRequest): Promise<IntercomArticle> {
    const response = await this.client.post<IntercomArticle>('/articles', data);
    return response.data;
  }

  /**
   * Update an existing article by ID.
   */
  async updateArticle(id: string, data: IntercomUpdateArticleRequest): Promise<IntercomArticle> {
    const response = await this.client.put<IntercomArticle>(`/articles/${id}`, data);
    return response.data;
  }

  /**
   * Delete an article by ID.
   * Does not throw on 404 (idempotent delete).
   */
  async deleteArticle(id: string): Promise<void> {
    try {
      await this.client.delete(`/articles/${id}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------

  /**
   * List collections with page-based pagination.
   * Yields pages of collection records.
   */
  async *listCollections(pageSize = 20): AsyncGenerator<IntercomCollection[], void> {
    let page = 1;
    let totalPages = Infinity;

    while (page <= totalPages) {
      const response = await this.client.get<IntercomPaginatedResponse<IntercomCollection>>(
        '/help_center/collections',
        { params: { page, per_page: pageSize } },
      );

      totalPages = response.data.pages.total_pages;
      const collections = response.data.data ?? [];

      if (collections.length > 0) {
        yield collections;
      }

      page++;
    }
  }

  /**
   * Get a single collection by ID.
   * @returns The collection, or null if not found.
   */
  async getCollection(id: string): Promise<IntercomCollection | null> {
    try {
      const response = await this.client.get<IntercomCollection>(`/help_center/collections/${id}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new collection.
   * @returns The created collection.
   */
  async createCollection(data: IntercomCreateCollectionRequest): Promise<IntercomCollection> {
    const response = await this.client.post<IntercomCollection>('/help_center/collections', data);
    return response.data;
  }

  /**
   * Update an existing collection by ID.
   */
  async updateCollection(id: string, data: IntercomUpdateCollectionRequest): Promise<IntercomCollection> {
    const response = await this.client.put<IntercomCollection>(`/help_center/collections/${id}`, data);
    return response.data;
  }

  /**
   * Delete a collection by ID.
   * Does not throw on 404 (idempotent delete).
   */
  async deleteCollection(id: string): Promise<void> {
    try {
      await this.client.delete(`/help_center/collections/${id}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Conversations (read-only)
  // ---------------------------------------------------------------------------

  /**
   * List conversations with cursor-based pagination.
   *
   * When `hydrate` is true (default), each conversation is individually fetched via
   * getConversation to include `conversation_parts`. This is slow for large workspaces
   * (one API call per conversation).
   *
   * When `hydrate` is false, conversations are returned as-is from the list endpoint
   * (no `conversation_parts`). Much faster for large workspaces.
   */
  async *listConversations(
    pageSize = 20,
    hydrate = true,
  ): AsyncGenerator<(IntercomConversation | IntercomConversationListItem)[], void> {
    let startingAfter: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, unknown> = { per_page: pageSize };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const response = await this.client.get<IntercomCursorPaginatedResponse<IntercomConversationListItem>>(
        '/conversations',
        { params },
      );

      const items = response.data.conversations ?? [];

      if (items.length > 0) {
        if (hydrate) {
          // Hydrate each conversation to get conversation_parts
          const fullConversations: IntercomConversation[] = [];
          for (const item of items) {
            const full = await this.getConversation(item.id);
            if (full) {
              fullConversations.push(full);
            }
          }
          if (fullConversations.length > 0) {
            yield fullConversations;
          }
        } else {
          yield items;
        }
      }

      if (response.data.pages.next?.starting_after) {
        startingAfter = response.data.pages.next.starting_after;
      } else {
        hasMore = false;
      }
    }
  }

  /**
   * Get a single conversation by ID, including conversation_parts.
   * @returns The full conversation, or null if not found.
   */
  async getConversation(id: string): Promise<IntercomConversation | null> {
    try {
      const response = await this.client.get<IntercomConversation>(`/conversations/${id}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
