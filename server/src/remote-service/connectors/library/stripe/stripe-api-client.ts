import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { createApiClient } from '../../create-api-client';
import {
  StripeCharge,
  StripeCredentials,
  StripeCustomer,
  StripeEntityType,
  StripeInvoice,
  StripeListResponse,
  StripePaymentIntent,
  StripePrice,
  StripeProduct,
  StripeSubscription,
} from './stripe-types';

/**
 * Custom error class for Stripe API errors.
 */
export class StripeError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly type?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, type?: string, responseData?: unknown) {
    super(message);
    this.name = 'StripeError';
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
    this.responseData = responseData;
  }
}

/**
 * Endpoint configuration for each entity type.
 */
const ENTITY_ENDPOINTS: Record<StripeEntityType, string> = {
  customers: '/v1/customers',
  products: '/v1/products',
  prices: '/v1/prices',
  subscriptions: '/v1/subscriptions',
  invoices: '/v1/invoices',
  payment_intents: '/v1/payment_intents',
  charges: '/v1/charges',
};

/**
 * Low-level API client for the Stripe API.
 *
 * Uses axios for HTTP requests with Bearer token authentication.
 * Stripe uses cursor-based pagination with `starting_after` parameter.
 *
 * API docs: https://stripe.com/docs/api
 */
export class StripeApiClient {
  private readonly client: AxiosInstance;

  constructor(credentials: StripeCredentials) {
    const headers: RawAxiosRequestHeaders = {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    this.client = createApiClient({
      baseURL: 'https://api.stripe.com',
      headers,
    });
  }

  /**
   * Validate the API key by fetching account info.
   * @throws StripeError if the API key is invalid.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.client.get('/v1/customers', { params: { limit: 1 } });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        const data = error.response?.data as { error?: { message?: string } } | undefined;
        throw new StripeError(
          data?.error?.message ?? 'Invalid API key',
          401,
          'authentication_error',
          'authentication_error',
          error.response?.data,
        );
      }
      throw error;
    }
  }

  /**
   * List entities with cursor-based pagination.
   * Returns an async generator that yields pages of entities.
   */
  async *listEntities(entityType: StripeEntityType, limit = 100): AsyncGenerator<Record<string, unknown>[], void> {
    const endpoint = ENTITY_ENDPOINTS[entityType];
    let startingAfter: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, string | number> = { limit };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      // Expand nested objects for certain entity types to get full data
      const expandParams = this.getExpandParams(entityType);

      const response = await this.client.get<StripeListResponse<Record<string, unknown>>>(endpoint, {
        params: { ...params, ...expandParams },
      });

      const list = response.data;

      if (list.data && list.data.length > 0) {
        yield list.data;
        const lastItem = list.data[list.data.length - 1];
        startingAfter = lastItem.id as string;
      }

      hasMore = list.has_more;
    }
  }

  /**
   * Get a single entity by ID.
   * Returns null if not found (404).
   */
  async getEntity(entityType: StripeEntityType, id: string): Promise<Record<string, unknown> | null> {
    const endpoint = ENTITY_ENDPOINTS[entityType];
    try {
      const expandParams = this.getExpandParams(entityType);
      const response = await this.client.get<Record<string, unknown>>(`${endpoint}/${id}`, {
        params: expandParams,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get expand parameters for entity types that have nested objects.
   * Stripe returns IDs for related objects by default; expanding hydrates them.
   */
  private getExpandParams(entityType: StripeEntityType): Record<string, string> {
    switch (entityType) {
      case 'subscriptions':
        return { 'expand[]': 'data.items' };
      default:
        return {};
    }
  }
}

// Re-export types used by the connector
export type {
  StripeCharge,
  StripeCustomer,
  StripeInvoice,
  StripePaymentIntent,
  StripePrice,
  StripeProduct,
  StripeSubscription,
};
