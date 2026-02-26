import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { MocoCompany, MocoContact, MocoCredentials, MocoEntityType, MocoPagination, MocoProject } from './moco-types';

/**
 * Custom error class for Moco API errors.
 */
export class MocoError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
    super(message);
    this.name = 'MocoError';
    this.statusCode = statusCode;
    this.code = code;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the Moco API.
 *
 * Uses axios for HTTP requests with Token authentication.
 * API docs: https://github.com/hundertzehn/mocoapp-api-docs
 */
export class MocoApiClient {
  private readonly client: AxiosInstance;
  private readonly domain: string;

  constructor(credentials: MocoCredentials) {
    this.domain = credentials.domain;

    const headers: RawAxiosRequestHeaders = {
      Authorization: `Token token=${credentials.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    this.client = axios.create({
      baseURL: `https://${credentials.domain}.mocoapp.com/api/v1`,
      headers,
    });
  }

  /**
   * Parse pagination info from response headers
   */
  private parsePagination(headers: Record<string, unknown>): MocoPagination {
    const getHeaderValue = (key: string, defaultValue: string): string => {
      const value = headers[key];
      return typeof value === 'string' ? value : defaultValue;
    };

    return {
      page: parseInt(getHeaderValue('x-page', '1'), 10),
      perPage: parseInt(getHeaderValue('x-per-page', '100'), 10),
      total: parseInt(getHeaderValue('x-total', '0'), 10),
    };
  }

  /**
   * Validate the API key by making a request to the companies endpoint.
   * @throws MocoError if the API key is invalid.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.client.get('/companies', { params: { page: 1, per_page: 1 } });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new MocoError('Invalid API key', 401, 'UNAUTHORIZED', error.response?.data);
      }
      throw error;
    }
  }

  /**
   * Get account info (domain name)
   */
  getAccountInfo(): { name: string; domain: string } {
    return {
      name: this.domain,
      domain: this.domain,
    };
  }

  // ============= Companies =============

  /**
   * List companies with pagination.
   * Returns an async generator that yields pages of companies.
   */
  async *listCompanies(perPage = 100): AsyncGenerator<MocoCompany[], void> {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.get<MocoCompany[]>('/companies', {
        params: { page, per_page: perPage },
      });

      const pagination = this.parsePagination(response.headers as Record<string, unknown>);

      if (response.data && response.data.length > 0) {
        yield response.data;
      }

      hasMore = page * perPage < pagination.total;
      page++;
    }
  }

  /**
   * Get a single company by ID
   */
  async getCompany(id: number): Promise<MocoCompany> {
    const response = await this.client.get<MocoCompany>(`/companies/${id}`);
    return response.data;
  }

  /**
   * Create a new company
   */
  async createCompany(fields: Partial<Omit<MocoCompany, 'id' | 'created_at' | 'updated_at'>>): Promise<MocoCompany> {
    const response = await this.client.post<MocoCompany>('/companies', fields);
    return response.data;
  }

  /**
   * Update a company
   */
  async updateCompany(
    id: number,
    fields: Partial<Omit<MocoCompany, 'id' | 'created_at' | 'updated_at'>>,
  ): Promise<MocoCompany> {
    const response = await this.client.put<MocoCompany>(`/companies/${id}`, fields);
    return response.data;
  }

  /**
   * Delete a company
   */
  async deleteCompany(id: number): Promise<void> {
    await this.client.delete(`/companies/${id}`);
  }

  // ============= Contacts =============

  /**
   * List contacts with pagination.
   * Returns an async generator that yields pages of contacts.
   */
  async *listContacts(perPage = 100): AsyncGenerator<MocoContact[], void> {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.get<MocoContact[]>('/contacts/people', {
        params: { page, per_page: perPage },
      });

      const pagination = this.parsePagination(response.headers as Record<string, unknown>);

      if (response.data && response.data.length > 0) {
        yield response.data;
      }

      hasMore = page * perPage < pagination.total;
      page++;
    }
  }

  /**
   * Get a single contact by ID
   */
  async getContact(id: number): Promise<MocoContact> {
    const response = await this.client.get<MocoContact>(`/contacts/people/${id}`);
    return response.data;
  }

  /**
   * Create a new contact
   */
  async createContact(fields: Partial<Omit<MocoContact, 'id' | 'created_at' | 'updated_at'>>): Promise<MocoContact> {
    const response = await this.client.post<MocoContact>('/contacts/people', fields);
    return response.data;
  }

  /**
   * Update a contact
   */
  async updateContact(
    id: number,
    fields: Partial<Omit<MocoContact, 'id' | 'created_at' | 'updated_at'>>,
  ): Promise<MocoContact> {
    const response = await this.client.put<MocoContact>(`/contacts/people/${id}`, fields);
    return response.data;
  }

  /**
   * Delete a contact
   */
  async deleteContact(id: number): Promise<void> {
    await this.client.delete(`/contacts/people/${id}`);
  }

  // ============= Projects =============

  /**
   * List projects with pagination.
   * Returns an async generator that yields pages of projects.
   */
  async *listProjects(perPage = 100): AsyncGenerator<MocoProject[], void> {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.get<MocoProject[]>('/projects', {
        params: { page, per_page: perPage },
      });

      const pagination = this.parsePagination(response.headers as Record<string, unknown>);

      if (response.data && response.data.length > 0) {
        yield response.data;
      }

      hasMore = page * perPage < pagination.total;
      page++;
    }
  }

  /**
   * Get a single project by ID
   */
  async getProject(id: number): Promise<MocoProject> {
    const response = await this.client.get<MocoProject>(`/projects/${id}`);
    return response.data;
  }

  /**
   * Create a new project
   */
  async createProject(fields: Partial<Omit<MocoProject, 'id' | 'created_at' | 'updated_at'>>): Promise<MocoProject> {
    const response = await this.client.post<MocoProject>('/projects', fields);
    return response.data;
  }

  /**
   * Update a project
   */
  async updateProject(
    id: number,
    fields: Partial<Omit<MocoProject, 'id' | 'created_at' | 'updated_at'>>,
  ): Promise<MocoProject> {
    const response = await this.client.put<MocoProject>(`/projects/${id}`, fields);
    return response.data;
  }

  /**
   * Delete a project
   */
  async deleteProject(id: number): Promise<void> {
    await this.client.delete(`/projects/${id}`);
  }

  // ============= Generic Entity Operations =============

  /**
   * List entities by type with pagination.
   * Returns an async generator that yields pages of entities.
   */
  async *listEntities(entityType: MocoEntityType, perPage = 100): AsyncGenerator<Record<string, unknown>[], void> {
    switch (entityType) {
      case 'companies':
        for await (const page of this.listCompanies(perPage)) {
          yield page as unknown as Record<string, unknown>[];
        }
        break;
      case 'contacts':
        for await (const page of this.listContacts(perPage)) {
          yield page as unknown as Record<string, unknown>[];
        }
        break;
      case 'projects':
        for await (const page of this.listProjects(perPage)) {
          yield page as unknown as Record<string, unknown>[];
        }
        break;
      default: {
        const _exhaustiveCheck: never = entityType;
        throw new MocoError(`Unknown entity type: ${String(_exhaustiveCheck)}`, 400, 'UNKNOWN_ENTITY_TYPE');
      }
    }
  }

  /**
   * Get a single entity by type and ID.
   * Returns null if not found (404).
   */
  async getEntity(entityType: MocoEntityType, id: number): Promise<Record<string, unknown> | null> {
    try {
      switch (entityType) {
        case 'companies':
          return (await this.getCompany(id)) as unknown as Record<string, unknown>;
        case 'contacts':
          return (await this.getContact(id)) as unknown as Record<string, unknown>;
        case 'projects':
          return (await this.getProject(id)) as unknown as Record<string, unknown>;
        default: {
          const _exhaustiveCheck: never = entityType;
          throw new MocoError(`Unknown entity type: ${String(_exhaustiveCheck)}`, 400, 'UNKNOWN_ENTITY_TYPE');
        }
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create an entity by type
   */
  async createEntity(entityType: MocoEntityType, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (entityType) {
      case 'companies':
        return (await this.createCompany(fields)) as unknown as Record<string, unknown>;
      case 'contacts':
        return (await this.createContact(fields)) as unknown as Record<string, unknown>;
      case 'projects':
        return (await this.createProject(fields)) as unknown as Record<string, unknown>;
      default: {
        const _exhaustiveCheck: never = entityType;
        throw new MocoError(`Unknown entity type: ${String(_exhaustiveCheck)}`, 400, 'UNKNOWN_ENTITY_TYPE');
      }
    }
  }

  /**
   * Update an entity by type
   */
  async updateEntity(
    entityType: MocoEntityType,
    id: number,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (entityType) {
      case 'companies':
        return (await this.updateCompany(id, fields)) as unknown as Record<string, unknown>;
      case 'contacts':
        return (await this.updateContact(id, fields)) as unknown as Record<string, unknown>;
      case 'projects':
        return (await this.updateProject(id, fields)) as unknown as Record<string, unknown>;
      default: {
        const _exhaustiveCheck: never = entityType;
        throw new MocoError(`Unknown entity type: ${String(_exhaustiveCheck)}`, 400, 'UNKNOWN_ENTITY_TYPE');
      }
    }
  }

  /**
   * Delete an entity by type
   */
  async deleteEntity(entityType: MocoEntityType, id: number): Promise<void> {
    switch (entityType) {
      case 'companies':
        return this.deleteCompany(id);
      case 'contacts':
        return this.deleteContact(id);
      case 'projects':
        return this.deleteProject(id);
      default: {
        const _exhaustiveCheck: never = entityType;
        throw new MocoError(`Unknown entity type: ${String(_exhaustiveCheck)}`, 400, 'UNKNOWN_ENTITY_TYPE');
      }
    }
  }
}

/**
 * Create a Moco client from credentials
 */
export function createMocoClient(credentials: MocoCredentials): MocoApiClient {
  return new MocoApiClient(credentials);
}
