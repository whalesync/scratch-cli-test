import { ConnectorPullOptions, Service } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
import { extractCommonDetailsFromAxiosError, extractErrorMessageFromAxiosError } from '../../error';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { MocoApiClient, MocoError } from './moco-api-client';
import { buildMocoJsonTableSpec } from './moco-json-schema';
import { MocoCredentials, MocoEntityType } from './moco-types';

/**
 * Entity types supported by Moco
 */
const ENTITY_TYPES: MocoEntityType[] = ['companies', 'contacts', 'projects'];

/**
 * Display names for Moco entity types
 */
const ENTITY_DISPLAY_NAMES: Record<MocoEntityType, string> = {
  companies: 'Companies',
  contacts: 'Contacts',
  projects: 'Projects',
};

/**
 * Connector for the Moco project management platform.
 *
 * Moco has three main entity types:
 * - Companies (customers/suppliers)
 * - Contacts (people associated with companies)
 * - Projects
 */
export class MocoConnector extends Connector<typeof Service.MOCO> {
  readonly service = Service.MOCO;
  static readonly displayName = 'Moco CRM';

  private readonly client: MocoApiClient;

  constructor(credentials: MocoCredentials) {
    super();
    this.client = new MocoApiClient(credentials);
  }

  /**
   * Test the connection by validating the credentials.
   */
  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  /**
   * List available tables. Moco has companies, contacts, and projects.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ENTITY_TYPES.map((entityType) => ({
      id: {
        wsId: entityType,
        remoteId: [entityType],
      },
      displayName: ENTITY_DISPLAY_NAMES[entityType],
      metadata: {
        description: `${ENTITY_DISPLAY_NAMES[entityType]} in your Moco account`,
        entityType,
      },
    }));
  }

  /**
   * Fetch the JSON Table Spec for a Moco entity type.
   * Builds a TypeBox schema based on the entity type.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const entityType = id.wsId as MocoEntityType;

    if (!ENTITY_TYPES.includes(entityType)) {
      throw new MocoError(`Entity type '${entityType}' not found. Moco supports: ${ENTITY_TYPES.join(', ')}`, 404);
    }

    return buildMocoJsonTableSpec(id, entityType);
  }

  /**
   * Download all entities as JSON files.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as MocoEntityType;

    for await (const entities of this.client.listEntities(entityType)) {
      await callback({ files: entities as unknown as ConnectorFile[] });
    }
  }

  /**
   * Get the batch size for CRUD operations.
   */
  getBatchSize(): number {
    return 10;
  }

  /**
   * Create entities in Moco from raw JSON files.
   * Files should contain Moco entity data.
   * Returns the created entities.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.wsId as MocoEntityType;
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const createData = this.transformToCreateRequest(entityType, file);
      const created = await this.client.createEntity(entityType, createData);
      results.push(created as unknown as ConnectorFile);
    }

    return results;
  }

  /**
   * Update entities in Moco from raw JSON files.
   * Files should have an 'id' field and the data to update.
   */
  async updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const entityType = tableSpec.id.wsId as MocoEntityType;

    for (const file of files) {
      const entityId = parseInt(String(file.id), 10);
      const updateData = this.transformToUpdateRequest(entityType, file);
      await this.client.updateEntity(entityType, entityId, updateData);
    }
  }

  /**
   * Delete entities from Moco.
   * Files should have an 'id' field with the entity ID to delete.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const entityType = tableSpec.id.wsId as MocoEntityType;

    for (const file of files) {
      try {
        const entityId = parseInt(String(file.id), 10);
        await this.client.deleteEntity(entityType, entityId);
      } catch (error) {
        // Ignore 404 errors - the record may already be deleted
        if (isAxiosError(error) && error.response?.status === 404) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Allowed fields for each entity type.
   * These are the fields Moco API accepts for create/update operations.
   */
  private static readonly ALLOWED_FIELDS: Record<MocoEntityType, string[]> = {
    companies: [
      'type',
      'name',
      'website',
      'email',
      'phone',
      'fax',
      'address',
      'info',
      'custom_properties',
      'labels',
      'identifier',
      'intern',
      'billing_tax',
      'currency',
      'country_code',
      'vat_identifier',
      'default_invoice_due_days',
      'debit_number',
      'credit_number',
      'iban',
      'footer',
      'tags',
    ],
    contacts: [
      'firstname',
      'lastname',
      'title',
      'gender',
      'job_position',
      'mobile_phone',
      'work_phone',
      'work_email',
      'work_fax',
      'work_address',
      'home_email',
      'home_address',
      'home_phone',
      'birthday',
      'info',
      'tags',
      'company_id',
      'custom_properties',
    ],
    projects: [
      'name',
      'identifier',
      'active',
      'billable',
      'fixed_price',
      'retainer',
      'start_date',
      'finish_date',
      'color',
      'currency',
      'budget',
      'budget_monthly',
      'hourly_rate',
      'info',
      'labels',
      'tags',
      'leader_id',
      'co_leader_id',
      'customer_id',
      'deal_id',
      'billing_address',
      'billing_email_to',
      'billing_email_cc',
      'billing_notes',
      'billing_variant',
      'budget_expenses',
      'custom_properties',
    ],
  };

  /**
   * Transform fields to Moco create request format.
   * Filters out read-only and relation fields that Moco doesn't accept.
   */
  private transformToCreateRequest(
    entityType: MocoEntityType,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const allowedFields = MocoConnector.ALLOWED_FIELDS[entityType];

    const result: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in fields && fields[field] !== undefined) {
        result[field] = fields[field];
      }
    }

    // Handle company relation - convert company object to company_id
    if (entityType === 'contacts' && 'company' in fields && fields.company && typeof fields.company === 'object') {
      const company = fields.company as { id?: number };
      if (company.id) {
        result['company_id'] = company.id;
      }
    }

    return result;
  }

  /**
   * Transform fields to Moco update request format.
   */
  private transformToUpdateRequest(
    entityType: MocoEntityType,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.transformToCreateRequest(entityType, fields);
  }

  /**
   * Extract error details from an error.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof MocoError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          code: error.code,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'error']),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return {
      userFriendlyMessage: 'An error occurred while connecting to Moco',
      description: error instanceof Error ? error.message : String(error),
    };
  }
}
