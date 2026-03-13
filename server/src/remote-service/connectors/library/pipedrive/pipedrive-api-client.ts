import { isAxiosError } from 'axios';
import {
  AddDealRequest,
  AddOrganizationRequest,
  AddPersonRequest,
  Configuration,
  DealFieldsApi,
  DealsApi,
  OrganizationFieldsApi,
  OrganizationsApi,
  PersonFieldsApi,
  PersonsApi,
  UpdateDealRequest,
  UpdateOrganizationRequest,
  UpdatePersonRequest,
} from 'pipedrive/v2';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { PipedriveEntityType, PipedriveField } from './pipedrive-types';

const LOG_SOURCE = 'PipedriveApiClient';

/**
 * Custom error class for Pipedrive API errors.
 */
export class PipedriveError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
    super(message);
    this.name = 'PipedriveError';
    this.statusCode = statusCode;
    this.code = code;
    this.responseData = responseData;
  }
}

/**
 * Retry options for Pipedrive API calls — detect 429 from axios errors.
 */
const PIPEDRIVE_RETRY_OPTS: WithRetryOpts = {
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
 * Build a request body with optional custom_fields sub-object.
 * The v2 API requires custom fields in a `custom_fields` key.
 */
function buildRequestBody(
  systemFields: Record<string, unknown>,
  customFields: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(customFields).length > 0) {
    return { ...systemFields, custom_fields: customFields };
  }
  return { ...systemFields };
}

/**
 * Low-level API client for Pipedrive v2 API.
 * Wraps the official `pipedrive` SDK with retry + rate limiting.
 */
export class PipedriveApiClient {
  private readonly config: Configuration;
  private readonly rateLimiter?: RateLimiter;

  // Lazy-initialized API instances
  private _dealsApi?: DealsApi;
  private _personsApi?: PersonsApi;
  private _organizationsApi?: OrganizationsApi;
  private _dealFieldsApi?: DealFieldsApi;
  private _personFieldsApi?: PersonFieldsApi;
  private _organizationFieldsApi?: OrganizationFieldsApi;

  constructor(token: string, opts?: { rateLimiter?: RateLimiter; authType?: 'apiKey' | 'oauth' }) {
    if (opts?.authType === 'oauth') {
      this.config = new Configuration({ accessToken: token });
    } else {
      this.config = new Configuration({ apiKey: token });
    }
    this.rateLimiter = opts?.rateLimiter;
  }

  // --- Lazy API getters ---

  private get dealsApi(): DealsApi {
    if (!this._dealsApi) this._dealsApi = new DealsApi(this.config);
    return this._dealsApi;
  }

  private get personsApi(): PersonsApi {
    if (!this._personsApi) this._personsApi = new PersonsApi(this.config);
    return this._personsApi;
  }

  private get organizationsApi(): OrganizationsApi {
    if (!this._organizationsApi) this._organizationsApi = new OrganizationsApi(this.config);
    return this._organizationsApi;
  }

  private get dealFieldsApi(): DealFieldsApi {
    if (!this._dealFieldsApi) this._dealFieldsApi = new DealFieldsApi(this.config);
    return this._dealFieldsApi;
  }

  private get personFieldsApi(): PersonFieldsApi {
    if (!this._personFieldsApi) this._personFieldsApi = new PersonFieldsApi(this.config);
    return this._personFieldsApi;
  }

  private get organizationFieldsApi(): OrganizationFieldsApi {
    if (!this._organizationFieldsApi) this._organizationFieldsApi = new OrganizationFieldsApi(this.config);
    return this._organizationFieldsApi;
  }

  // --- Retry wrapper ---

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, PIPEDRIVE_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, PIPEDRIVE_RETRY_OPTS);
  }

  // --- Connection test ---

  async testConnection(): Promise<void> {
    try {
      await this.withRetry(async () => this.dealsApi.getDeals({ limit: 1 }) as Promise<unknown>);
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        throw new PipedriveError('Invalid API key or access token', 401, 'UNAUTHORIZED', error.response?.data);
      }
      throw error;
    }
  }

  // --- Fields API ---

  /**
   * Fetch all fields for an entity type, paginating if needed.
   */
  async getFields(entityType: PipedriveEntityType): Promise<PipedriveField[]> {
    const allFields: PipedriveField[] = [];
    let cursor: string | undefined;

    do {
      const response: Record<string, unknown> = await this.withRetry(async () => {
        const params: { limit?: number; cursor?: string } = { limit: 500 };
        if (cursor) params.cursor = cursor;

        switch (entityType) {
          case 'deals':
            return this.dealFieldsApi.getDealFields(params) as Promise<Record<string, unknown>>;
          case 'persons':
            return this.personFieldsApi.getPersonFields(params) as Promise<Record<string, unknown>>;
          case 'organizations':
            return this.organizationFieldsApi.getOrganizationFields(params) as Promise<Record<string, unknown>>;
        }
      });

      const data = response?.data;
      if (Array.isArray(data)) {
        allFields.push(...(data as PipedriveField[]));
      }

      const additionalData = response?.additional_data as { next_cursor?: string } | undefined;
      cursor = additionalData?.next_cursor ?? undefined;
    } while (cursor);

    return allFields;
  }

  // --- Entity listing (cursor-paginated async generator) ---

  /**
   * List all entities of a given type using cursor pagination.
   * Yields batches of entities.
   */
  async *listEntities(entityType: PipedriveEntityType): AsyncGenerator<Record<string, unknown>[], void> {
    let cursor: string | undefined;

    do {
      const response: Record<string, unknown> = await this.withRetry(async () => {
        const params: { limit?: number; cursor?: string } = { limit: 500 };
        if (cursor) params.cursor = cursor;

        switch (entityType) {
          case 'deals':
            return this.dealsApi.getDeals(params) as Promise<Record<string, unknown>>;
          case 'persons':
            return this.personsApi.getPersons(params) as Promise<Record<string, unknown>>;
          case 'organizations':
            return this.organizationsApi.getOrganizations(params) as Promise<Record<string, unknown>>;
        }
      });

      const data = response?.data;
      if (Array.isArray(data) && data.length > 0) {
        yield data as Record<string, unknown>[];
      }

      const additionalData = response?.additional_data as { next_cursor?: string } | undefined;
      cursor = additionalData?.next_cursor ?? undefined;
    } while (cursor);
  }

  // --- Single entity fetch ---

  /**
   * Get a single entity by type and ID. Returns null on 404.
   */
  async getEntity(entityType: PipedriveEntityType, id: number): Promise<Record<string, unknown> | null> {
    try {
      const response: Record<string, unknown> = await this.withRetry(async () => {
        switch (entityType) {
          case 'deals':
            return this.dealsApi.getDeal({ id }) as Promise<Record<string, unknown>>;
          case 'persons':
            return this.personsApi.getPerson({ id }) as Promise<Record<string, unknown>>;
          case 'organizations':
            return this.organizationsApi.getOrganization({ id }) as Promise<Record<string, unknown>>;
        }
      });

      const data = response?.data;
      return (data as Record<string, unknown>) ?? null;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- Create ---

  /**
   * Create an entity. Separates system fields from custom_fields.
   */
  async createEntity(
    entityType: PipedriveEntityType,
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): Promise<Record<string, unknown>> {
    const { systemFields, customFields } = this.separateFields(data, customFieldKeys);
    const body = buildRequestBody(systemFields, customFields);

    // SDK request types have required fields (e.g. title for deals) but we're dynamically constructing
    // payloads from user data, so we cast through unknown to satisfy the type system.
    const response: Record<string, unknown> = await this.withRetry(async () => {
      switch (entityType) {
        case 'deals':
          return this.dealsApi.addDeal({
            AddDealRequest: body as unknown as AddDealRequest,
          }) as Promise<Record<string, unknown>>;
        case 'persons':
          return this.personsApi.addPerson({
            AddPersonRequest: body as unknown as AddPersonRequest,
          }) as Promise<Record<string, unknown>>;
        case 'organizations':
          return this.organizationsApi.addOrganization({
            AddOrganizationRequest: body as unknown as AddOrganizationRequest,
          }) as Promise<Record<string, unknown>>;
      }
    });

    const responseData = response?.data;
    return (responseData as Record<string, unknown>) ?? {};
  }

  // --- Update ---

  /**
   * Update an entity. Separates system fields from custom_fields.
   */
  async updateEntity(
    entityType: PipedriveEntityType,
    id: number,
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): Promise<Record<string, unknown>> {
    const { systemFields, customFields } = this.separateFields(data, customFieldKeys);
    const body = buildRequestBody(systemFields, customFields);

    const response: Record<string, unknown> = await this.withRetry(async () => {
      switch (entityType) {
        case 'deals':
          return this.dealsApi.updateDeal({
            id,
            UpdateDealRequest: body as unknown as UpdateDealRequest,
          }) as Promise<Record<string, unknown>>;
        case 'persons':
          return this.personsApi.updatePerson({
            id,
            UpdatePersonRequest: body as unknown as UpdatePersonRequest,
          }) as Promise<Record<string, unknown>>;
        case 'organizations':
          return this.organizationsApi.updateOrganization({
            id,
            UpdateOrganizationRequest: body as unknown as UpdateOrganizationRequest,
          }) as Promise<Record<string, unknown>>;
      }
    });

    const responseData = response?.data;
    return (responseData as Record<string, unknown>) ?? {};
  }

  // --- Delete ---

  /**
   * Delete an entity by type and ID. Throws on non-404 errors.
   */
  async deleteEntity(entityType: PipedriveEntityType, id: number): Promise<void> {
    try {
      await this.withRetry(async () => {
        switch (entityType) {
          case 'deals':
            return this.dealsApi.deleteDeal({ id }) as Promise<unknown>;
          case 'persons':
            return this.personsApi.deletePerson({ id }) as Promise<unknown>;
          case 'organizations':
            return this.organizationsApi.deleteOrganization({ id }) as Promise<unknown>;
        }
      });
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Entity ${entityType}/${id} not found (404) during delete, ignoring`,
        });
        return;
      }
      throw error;
    }
  }

  // --- Field separation ---

  /**
   * Separate data into system fields and custom fields.
   * Custom fields are identified by their hash keys from the Fields API.
   */
  separateFields(
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): { systemFields: Record<string, unknown>; customFields: Record<string, unknown> } {
    const systemFields: Record<string, unknown> = {};
    const customFields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (key === 'id' || key === 'add_time' || key === 'update_time' || key === 'custom_fields') {
        // Skip read-only fields and the custom_fields wrapper itself
        continue;
      }
      if (customFieldKeys.has(key)) {
        customFields[key] = value;
      } else {
        systemFields[key] = value;
      }
    }

    return { systemFields, customFields };
  }
}
