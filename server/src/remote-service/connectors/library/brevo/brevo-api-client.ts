import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { createApiClient } from '../../create-api-client';
import {
  BrevoContact,
  BrevoContactAttribute,
  BrevoContactsListResponse,
  BrevoCreateContactRequest,
  BrevoCreateTemplateRequest,
  BrevoMailingList,
  BrevoMailingListsResponse,
  BrevoTemplate,
  BrevoTemplatesListResponse,
  BrevoUpdateContactRequest,
  BrevoUpdateTemplateRequest,
} from './brevo-types';

const BREVO_API_BASE_URL = 'https://api.brevo.com/v3';

/**
 * Custom error class for Brevo API errors.
 */
export class BrevoError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'BrevoError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the Brevo v3 API.
 *
 * Uses axios for HTTP requests with `api-key` header authentication.
 * API docs: https://developers.brevo.com/reference
 */
export class BrevoApiClient {
  private readonly client: AxiosInstance;

  constructor(apiKey: string) {
    const headers: RawAxiosRequestHeaders = {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    this.client = createApiClient({
      baseURL: BREVO_API_BASE_URL,
      headers,
    });
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Validate the API key by listing contacts with limit=1.
   * @throws BrevoError if the API key is invalid.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.client.get<BrevoContactsListResponse>('/contacts', {
        params: { limit: 1, offset: 0 },
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new BrevoError('Invalid API key', 401, error.response?.data);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /**
   * List contacts with offset-based pagination.
   * Yields pages of contact records.
   */
  async *listContacts(pageSize = 1000): AsyncGenerator<BrevoContact[], void> {
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const response = await this.client.get<BrevoContactsListResponse>('/contacts', {
        params: { limit: pageSize, offset },
      });

      total = response.data.count;
      const contacts = response.data.contacts ?? [];

      if (contacts.length > 0) {
        yield contacts;
      }

      offset += pageSize;
    }
  }

  /**
   * Get a single contact by email or numeric ID.
   * @returns The contact, or null if not found.
   */
  async getContact(identifier: string | number): Promise<BrevoContact | null> {
    try {
      const encoded = typeof identifier === 'string' ? encodeURIComponent(identifier) : identifier;
      const response = await this.client.get<BrevoContact>(`/contacts/${encoded}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new contact.
   * The API returns only `{ id }`, so we follow up with a GET to return the full record.
   */
  async createContact(data: BrevoCreateContactRequest): Promise<BrevoContact> {
    const response = await this.client.post<{ id: number }>('/contacts', data);
    const created = await this.getContact(response.data.id);
    if (!created) {
      throw new BrevoError(`Contact created with id ${response.data.id} but could not be retrieved`);
    }
    return created;
  }

  /**
   * Update an existing contact by email or numeric ID.
   */
  async updateContact(identifier: string | number, data: BrevoUpdateContactRequest): Promise<void> {
    const encoded = typeof identifier === 'string' ? encodeURIComponent(identifier) : identifier;
    await this.client.put(`/contacts/${encoded}`, data);
  }

  /**
   * Delete a contact by email or numeric ID.
   * Does not throw on 404 (idempotent delete).
   */
  async deleteContact(identifier: string | number): Promise<void> {
    try {
      const encoded = typeof identifier === 'string' ? encodeURIComponent(identifier) : identifier;
      await this.client.delete(`/contacts/${encoded}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  /**
   * List all contact attribute definitions.
   */
  async getContactAttributes(): Promise<BrevoContactAttribute[]> {
    const response = await this.client.get<{ attributes: BrevoContactAttribute[] }>('/contacts/attributes');
    return response.data.attributes;
  }

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  /**
   * List templates with offset-based pagination.
   * Note: The list endpoint may not return `htmlContent`; use `getTemplate()` for full data.
   * Yields pages of template metadata.
   */
  async *listTemplates(pageSize = 1000): AsyncGenerator<BrevoTemplate[], void> {
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const response = await this.client.get<BrevoTemplatesListResponse>('/smtp/templates', {
        params: { limit: pageSize, offset },
      });

      total = response.data.count ?? 0;
      const templates = response.data.templates ?? [];

      if (templates.length > 0) {
        yield templates;
      }

      offset += pageSize;
    }
  }

  /**
   * Get a single template by ID, including `htmlContent`.
   * @returns The template, or null if not found.
   */
  async getTemplate(id: number): Promise<BrevoTemplate | null> {
    try {
      const response = await this.client.get<BrevoTemplate>(`/smtp/templates/${id}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new template.
   * The API returns only `{ id }`, so we follow up with a GET to return the full record.
   */
  async createTemplate(data: BrevoCreateTemplateRequest): Promise<BrevoTemplate> {
    const response = await this.client.post<{ id: number }>('/smtp/templates', data);
    const created = await this.getTemplate(response.data.id);
    if (!created) {
      throw new BrevoError(`Template created with id ${response.data.id} but could not be retrieved`);
    }
    return created;
  }

  /**
   * Update an existing template by ID.
   */
  async updateTemplate(id: number, data: BrevoUpdateTemplateRequest): Promise<void> {
    await this.client.put(`/smtp/templates/${id}`, data);
  }

  /**
   * Delete a template by ID.
   * Note: Only inactive templates can be deleted.
   * Does not throw on 404 (idempotent delete).
   */
  async deleteTemplate(id: number): Promise<void> {
    try {
      await this.client.delete(`/smtp/templates/${id}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Mailing Lists (read-only)
  // ---------------------------------------------------------------------------

  /**
   * List mailing lists with offset-based pagination.
   * Yields pages of mailing list records.
   */
  async *listMailingLists(pageSize = 50): AsyncGenerator<BrevoMailingList[], void> {
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const response = await this.client.get<BrevoMailingListsResponse>('/contacts/lists', {
        params: { limit: pageSize, offset },
      });

      total = response.data.count;
      const lists = response.data.lists ?? [];

      if (lists.length > 0) {
        yield lists;
      }

      offset += pageSize;
    }
  }

  /**
   * Get a single mailing list by ID.
   * @returns The mailing list, or null if not found.
   */
  async getMailingList(id: number): Promise<BrevoMailingList | null> {
    try {
      const response = await this.client.get<BrevoMailingList>(`/contacts/lists/${id}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
