import { ConnectorPullOptions, Service } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
import { extractCommonDetailsFromAxiosError, extractErrorMessageFromAxiosError } from '../../error';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { AudiencefulApiClient, AudiencefulError } from './audienceful-api-client';
import { buildAudiencefulJsonTableSpec } from './audienceful-json-schema';
import { AudiencefulField } from './audienceful-types';

/**
 * Connector for the Audienceful email marketing platform.
 *
 * This is a JSON-only connector that implements:
 * - fetchJsonTableSpec() for schema discovery
 * - pullRecordFiles() for fetching records
 *
 */
export class AudiencefulConnector extends Connector<typeof Service.AUDIENCEFUL> {
  readonly service = Service.AUDIENCEFUL;
  static readonly displayName = 'Audienceful';

  private readonly client: AudiencefulApiClient;

  constructor(apiKey: string) {
    super();
    this.client = new AudiencefulApiClient(apiKey);
  }

  /**
   * Test the connection by validating the API key.
   */
  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  /**
   * List available tables. Audienceful has a single "People" table.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    // Audienceful has a flat structure with only one entity type: people
    return [
      {
        id: {
          wsId: 'people',
          remoteId: ['people'],
        },
        displayName: 'People',
        metadata: {
          description: 'Email subscribers in your Audienceful account',
        },
      },
    ];
  }

  /**
   * Fetch the JSON Table Spec for the People table.
   * Builds a TypeBox schema from the API fields.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    // Validate that we're requesting the people table
    if (id.wsId !== 'people' || !id.remoteId.includes('people')) {
      throw new AudiencefulError(`Table '${id.wsId}' not found. Audienceful only supports the 'People' table.`, 404);
    }

    // Fetch custom fields from the API
    let customFields: AudiencefulField[] = [];
    try {
      customFields = await this.client.listFields();
    } catch (error) {
      // If listFields fails, continue with empty custom fields
      // The standard fields will still be available
      console.warn('Failed to fetch Audienceful custom fields:', error);
    }

    return buildAudiencefulJsonTableSpec(id, customFields);
  }

  /**
   * Download all people as JSON files.
   */
  async pullRecordFiles(
    _tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    for await (const people of this.client.listPeople()) {
      await callback({ files: people as unknown as ConnectorFile[] });
    }
  }

  /**
   * Get the batch size for CRUD operations.
   * Audienceful supports batch operations.
   */
  getBatchSize(): number {
    return 10;
  }

  /**
   * Create new people records.
   */
  /**
   * Create people in Audienceful from raw JSON files.
   * Files should contain Audienceful person data.
   * Returns the created people.
   */
  async createRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const createData = this.transformToCreateRequest(file);
      const created = await this.client.createPerson(createData);
      results.push(created as unknown as ConnectorFile);
    }

    return results;
  }

  /**
   * Update people in Audienceful from raw JSON files.
   * Files should contain the person data to update (including email).
   */
  async updateRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      const updateData = this.transformToUpdateRequest(file);
      await this.client.updatePerson(updateData);
    }
  }

  /**
   * Delete people from Audienceful.
   * Files should contain at least an 'email' field or 'uid' to identify the person.
   */
  async deleteRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      // If email is provided, use it directly
      if (file.email) {
        await this.client.deletePerson({ email: file.email as string });
        continue;
      }

      // Otherwise fetch the person by uid to get the email
      const uid = (file.uid || file.id) as string;
      const person = await this.client.getPerson(uid);
      if (!person) {
        // Person already deleted, skip
        continue;
      }
      await this.client.deletePerson({ email: person.email });
    }
  }

  /**
   * Transform fields to Audienceful create request format.
   */
  private transformToCreateRequest(fields: Record<string, unknown>): {
    email: string;
    tags?: string;
    notes?: string;
    extra_data?: Record<string, unknown>;
    [key: string]: unknown;
  } {
    const { email, tags, notes, extra_data, ...customFields } = fields;

    const request: {
      email: string;
      tags?: string;
      notes?: string;
      extra_data?: Record<string, unknown>;
      [key: string]: unknown;
    } = {
      email: email as string,
    };

    // Transform tags array to comma-separated string (API expects tag names)
    if (tags && Array.isArray(tags)) {
      const tagNames = (tags as { name: string; color?: string }[]).map((t) => t.name);
      request.tags = tagNames.join(',');
    }

    if (notes !== undefined && notes !== null) {
      request.notes = notes as string;
    }

    if (extra_data && typeof extra_data === 'object') {
      request.extra_data = extra_data as Record<string, unknown>;
    }

    // Add custom fields
    for (const [key, value] of Object.entries(customFields)) {
      // Skip internal fields
      if (key === 'uid' || key === 'status' || key === 'created_at' || key === 'updated_at') {
        continue;
      }
      request[key] = value;
    }

    return request;
  }

  /**
   * Transform fields to Audienceful update request format.
   */
  private transformToUpdateRequest(fields: Record<string, unknown>): {
    email: string;
    tags?: string;
    notes?: string;
    extra_data?: Record<string, unknown>;
    [key: string]: unknown;
  } {
    // Update uses the same format as create
    return this.transformToCreateRequest(fields);
  }

  /**
   * Extract error details from an error.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof AudiencefulError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'errors']),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return {
      userFriendlyMessage: 'An error occurred while connecting to Audienceful',
      description: error instanceof Error ? error.message : String(error),
    };
  }
}
