import { connectorMetadata, IncrementalPullSupport, TableView } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
  ReadonlyFieldEditError,
  readonlyFieldEditErrorMessage,
} from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { MocoApiClient, MocoError } from './moco-api-client';
import { buildMocoDefaultView } from './moco-default-view';
import { buildMocoUpdatedAfter } from './moco-incremental';
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
export class MocoConnector extends Connector {
  readonly service = Service.MOCO;
  static readonly displayName = 'Moco CRM';
  static readonly metadata = connectorMetadata({
    displayName: 'Moco CRM',
    table: 'entity',
    tables: 'entities',
    base: 'account',
    bases: 'accounts',
    logo: 'https://static.scratch.md/connector-icons/moco.svg',
    incrementalPull: true,
    // No user-facing caveats: `updated_at` is a fixed system field on every Moco
    // entity and `updated_after` is unconditional, so there are no notes to show
    // (same as Linear). Set explicitly per the field's "always provide a value"
    // convention rather than relying on the default.
    incrementalPullInstructions: null,
    credentialFields: {
      user_provided_params: [
        {
          key: 'domain',
          type: 'string',
          label: 'Moco Domain',
          placeholder: 'yourcompany',
          description: "Your Moco subdomain (e.g., 'yourcompany' from yourcompany.mocoapp.com)",
          required: true,
        },
        {
          key: 'apiKey',
          type: 'password',
          label: 'API Key',
          placeholder: 'Enter your Moco API key',
          description: 'Generate an API key in your Moco account under Integrations',
          required: true,
        },
      ],
    },
  });

  private readonly client: MocoApiClient;

  constructor(credentials: MocoCredentials, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new MocoApiClient(credentials, opts);
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
   * Build the curated default view for a Moco table, derived purely from the
   * fetched spec. The entity type is carried on `spec.id.wsId` (see
   * {@link fetchJsonTableSpec}), and the view is generated from `spec.schema`
   * with the same priority/hidden-field rules used at pull time.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    const entityType = spec.id.wsId as MocoEntityType;
    return buildMocoDefaultView(spec.schema, entityType);
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
   * Moco supports incremental pulls unconditionally: every entity type
   * (companies, contacts, projects) has a guaranteed server-side `updated_at`
   * system field and Moco accepts the `updated_after` filter on each list
   * endpoint. The field is fixed (not user-selectable), so there is no
   * per-folder config to inspect — this always returns `SUPPORTED`.
   */
  override incrementalPullSupport(): IncrementalPullSupport {
    return IncrementalPullSupport.SUPPORTED;
  }

  /**
   * Download entities as JSON files.
   *
   * Full pull (default): scan every entity. Incremental pull: filter each list
   * endpoint by `updated_after` (the clock-skewed watermark) and return the new
   * watermark for the job to persist.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = tableSpec.id.wsId as MocoEntityType;
    let page = (progress as { nextPage?: number })?.nextPage ?? 1;

    // Capture the watermark BEFORE the first API call so records changed
    // mid-pull aren't lost on the next run. Moco's `updated_after` filter is
    // boundary-exclusive and `updated_at` is server-side while the watermark is
    // client-side, so the helper subtracts a clock-skew margin; idempotent
    // commits absorb the small re-pulled window. Moco has no user
    // `options.filter` today — nothing to combine.
    let newWatermark: Date | undefined;
    let updatedAfter: string | undefined;
    if (options.pullMode === 'incremental' && options.since instanceof Date) {
      newWatermark = new Date();
      updatedAfter = buildMocoUpdatedAfter(options.since);
    }

    for await (const entities of this.client.listEntities(entityType, 100, page, updatedAfter)) {
      page++;
      await callback({ files: entities as unknown as ConnectorFile[], connectorProgress: { nextPage: page } });
    }
    return newWatermark ? { newWatermark } : {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as MocoEntityType;
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const numericId = parseInt(id, 10);
      if (isNaN(numericId)) {
        WSLogger.warn({
          source: 'MocoConnector',
          message: `Invalid non-numeric ID "${id}" for ${entityType}, skipping`,
        });
        continue;
      }

      const entity = await this.client.getEntity(entityType, numericId);
      if (entity) {
        buffer.push(entity as ConnectorFile);
      }

      if (buffer.length >= BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
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
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.wsId as MocoEntityType;

    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const entityId = parseInt(String(files[i].id), 10);
      const updateData = this.transformToUpdateRequest(entityType, changedFields[i]);
      const updated = await this.client.updateEntity(entityType, entityId, updateData);
      results.push(updated as unknown as ConnectorFile);
    }
    return results;
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
   * Transform the user's sparse changed fields to Moco's update request format,
   * throwing if any changed field is read-only / not writable (DEV-10597).
   * Unlike {@link transformToCreateRequest} (which receives the full record on
   * create and drops everything outside the allow-list), the keys here are only
   * what the user actually changed, so a non-allowed key is a genuine read-only
   * edit that must be surfaced rather than silently dropped to a no-op PUT.
   */
  private transformToUpdateRequest(
    entityType: MocoEntityType,
    changedFields: Record<string, unknown>,
  ): Record<string, unknown> {
    const allowedFields = new Set(MocoConnector.ALLOWED_FIELDS[entityType]);
    const result: Record<string, unknown> = {};
    const readonlyChangedFieldNames: string[] = [];

    for (const [key, value] of Object.entries(changedFields)) {
      if (key === 'id') continue;
      // contacts: a changed `company` relation maps to the writable company_id.
      if (entityType === 'contacts' && key === 'company') {
        if (value && typeof value === 'object') {
          const company = value as { id?: number };
          if (company.id) result['company_id'] = company.id;
        }
        continue;
      }
      if (!allowedFields.has(key)) {
        readonlyChangedFieldNames.push(key);
        continue;
      }
      if (value !== undefined) result[key] = value;
    }

    if (readonlyChangedFieldNames.length > 0) {
      throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
    }
    return result;
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titlePath && !tableSpec.titlePath.includes('.') ? tableSpec.titlePath : undefined;
    return suggestFileNamesFromFieldPaths(records, titlePath);
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

    return this.fallbackErrorDetails(error);
  }
}

connectorRegistry.register({
  service: Service.MOCO,
  metadata: MocoConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 100, duration: 120 }, // Moco standard plan: 120 req/2min
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Moco', Service.MOCO);
    }
    if (!ctx.decryptedCredentials?.domain) {
      throw new ConnectorInstantiationError('Domain is required for Moco', Service.MOCO);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('API key is required for Moco', Service.MOCO);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    return new MocoConnector(
      { domain: ctx.decryptedCredentials.domain, apiKey: ctx.decryptedCredentials.apiKey },
      { rateLimiter },
    );
  },
});
