import { TObject, TSchema } from '@sinclair/typebox';
import { connectorMetadata, ConnectorPullOptions } from '@spinner/shared-types';
import _ from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Webflow, WebflowClient, WebflowError } from 'webflow-api';
import { TooManyRequestsError } from 'webflow-api/api/errors';
import { minifyHtml } from '../../../../wrappers/html-minify';
import {
  defaultResolveFieldValue,
  extractFromAnnotatedSchema,
  extractStandaloneEntity,
} from '../../asset-extraction-helpers';
import { Connector } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError } from '../../error';
import { Service } from '../../service-constants';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import {
  buildWebflowAssetsJsonTableSpec,
  buildWebflowJsonTableSpec,
  WEBFLOW_ASSETS_TABLE_ID_PREFIX,
} from './webflow-json-schema';
import { WebflowSchemaParser } from './webflow-schema-parser';
import { WEBFLOW_ECOMMERCE_COLLECTION_SLUGS } from './webflow-types';

export const WEBFLOW_DEFAULT_BATCH_SIZE = 100;

const WEBFLOW_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => error instanceof TooManyRequestsError,
  getRetryAfterS: (error) => {
    if (!(error instanceof TooManyRequestsError)) return undefined;
    const header = error.rawResponse?.headers?.get('retry-after');
    const seconds = header ? parseInt(header, 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

export class WebflowConnector extends Connector {
  readonly service = Service.WEBFLOW;
  static readonly displayName = 'Webflow';
  static readonly metadata = connectorMetadata({
    displayName: 'Webflow',
    table: 'collection',
    tables: 'collections',
    record: 'item',
    records: 'items',
    logo: 'https://static.scratch.md/connector-icons/webflow.svg',
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'API Key', placeholder: 'Enter API Key', required: true },
      ],
    },
  });
  override supportsFileUpload = true;

  private readonly client: WebflowClient;
  private readonly schemaParser = new WebflowSchemaParser();
  private readonly rateLimiter?: RateLimiter;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new WebflowClient({ accessToken });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, WEBFLOW_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, WEBFLOW_RETRY_OPTS);
  }

  public async testConnection(): Promise<void> {
    // Test connection by listing sites
    await this.client.sites.list();
  }

  async listTables(): Promise<TablePreview[]> {
    const tables: TablePreview[] = [];

    // Get all sites
    const sitesResponse = await this.withRetry(() => this.client.sites.list());
    const sites = sitesResponse.sites || [];

    // For each site, get all collections + an Assets table
    for (const site of sites) {
      const collectionsResponse = await this.withRetry(() => this.client.collections.list(site.id));
      const collections = collectionsResponse.collections || [];

      for (const collection of collections) {
        // Skip ecommerce collections (Products, Categories, SKUs)
        if (collection.slug && WEBFLOW_ECOMMERCE_COLLECTION_SLUGS.includes(collection.slug)) {
          continue;
        }
        tables.push(this.schemaParser.parseTablePreview(site, collection));
      }

      // Add a site-level Assets table
      const assetsTableId = `${WEBFLOW_ASSETS_TABLE_ID_PREFIX}${site.id}`;
      tables.push({
        id: {
          wsId: assetsTableId,
          remoteId: [site.id, assetsTableId],
        },
        displayName: `Assets`,
        disabledCreates: true,
        parentPath: site.displayName,
        metadata: {
          siteId: site.id,
          siteName: site.displayName,
          isAssetsTable: true,
        },
      });
    }

    return tables;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    const newFile: Record<string, unknown> = {
      cmsLocaleId: null,
      isArchived: false,
      isDraft: true,
      fieldData: {},
    };

    // Populate fieldData based on schema
    const schema = tableSpec.schema as TObject;
    const fieldDataSchema = schema.properties?.['fieldData'] as TObject | undefined;

    if (fieldDataSchema && fieldDataSchema.type === 'object' && fieldDataSchema.properties) {
      const fieldData: Record<string, unknown> = {};
      const properties = fieldDataSchema.properties as Record<string, TSchema>;

      for (const [key, propSchema] of Object.entries(properties)) {
        fieldData[key] = this.getDefaultValueForSchema(propSchema);
      }

      newFile.fieldData = fieldData;
    }

    return newFile;
  }

  private getDefaultValueForSchema(schema: TSchema): unknown {
    if (schema.default !== undefined) {
      return schema.default;
    }

    // Handle Optional wrapper (TypeBox Union of [Type, Null] or similar structure for Optional)
    // In TypeBox, Type.Optional(X) often creates a Modifier, but when compiled/inspected it might look specific.
    // However, our `webflowFieldToJsonSchema` mostly returns simple types or Type.Optional wrappers.
    // We'll approximate based on `type`.

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const type = schema.type;

    if (type === 'string') {
      if (schema.format === 'date-time') {
        return new Date().toISOString();
      }
      if (schema.format === 'uri') {
        return '';
      }
      return '';
    }

    if (type === 'number' || type === 'integer') {
      return 0;
    }

    if (type === 'boolean') {
      return false;
    }

    if (type === 'array') {
      return [];
    }

    if (type === 'object') {
      // For Image/File objects
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if ((schema as any).properties?.url) {
        return { url: '', alt: '' };
      }
      return {};
    }

    return null;
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    WSLogger.info({ source: 'WebflowConnector', message: 'pullRecordFiles called', tableId: tableSpec.id.wsId });
    const [siteId, collectionId] = tableSpec.id.remoteId;

    // Handle assets table
    if (collectionId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX)) {
      await this.pullAssets(siteId, callback);
      return;
    }

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      // List items with pagination
      const response = await this.withRetry(() =>
        this.client.collections.items.listItems(collectionId, {
          offset,
          limit: WEBFLOW_DEFAULT_BATCH_SIZE,
        }),
      );

      const items = response.items || [];

      if (items.length === 0) {
        hasMore = false;
        break;
      }

      await callback({ files: items as unknown as ConnectorFile[] });

      // Check if there are more items
      const pagination = response.pagination;
      if (pagination) {
        const total = pagination.total || 0;
        offset += items.length;
        hasMore = offset < total;
      } else {
        // If no pagination info, assume we're done if we got less than limit
        hasMore = items.length === WEBFLOW_DEFAULT_BATCH_SIZE;
        offset += items.length;
      }
    }
  }

  /**
   * Pull all assets for a site via the Webflow Assets API.
   */
  private async pullAssets(
    siteId: string,
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.withRetry(() =>
        this.client.assets.list(siteId, {
          offset,
          limit: WEBFLOW_DEFAULT_BATCH_SIZE,
        }),
      );

      const assets = response.assets || [];

      if (assets.length === 0) {
        hasMore = false;
        break;
      }

      // Normalize asset records: convert Date fields to ISO strings
      const files: ConnectorFile[] = assets.map((asset) => ({
        ...asset,
        createdOn: asset.createdOn instanceof Date ? asset.createdOn.toISOString() : asset.createdOn,
        lastUpdated: asset.lastUpdated instanceof Date ? asset.lastUpdated.toISOString() : asset.lastUpdated,
      }));

      await callback({ files });

      const pagination = response.pagination;
      if (pagination) {
        const total = pagination.total || 0;
        offset += assets.length;
        hasMore = offset < total;
      } else {
        hasMore = assets.length === WEBFLOW_DEFAULT_BATCH_SIZE;
        offset += assets.length;
      }
    }
  }

  /**
   * Fetch JSON Table Spec directly from the Webflow API for a collection or assets table.
   * Converts Webflow field types to JSON Schema types for AI consumption.
   * Uses field slugs as property keys.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const [siteId, collectionId] = id.remoteId;

    // Handle assets table
    if (collectionId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX)) {
      const site = await this.withRetry(() => this.client.sites.get(siteId));
      return buildWebflowAssetsJsonTableSpec(id, site);
    }

    // Fetch site and collection directly from Webflow API
    const [site, collection] = await Promise.all([
      this.withRetry(() => this.client.sites.get(siteId)),
      this.withRetry(() => this.client.collections.get(collectionId)),
    ]);

    return buildWebflowJsonTableSpec(id, site, collection);
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const [, collectionId] = tableSpec.id.remoteId;

    // Handle assets table
    if (collectionId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX)) {
      const buffer: ConnectorFile[] = [];
      for (const assetId of ids) {
        try {
          const asset = await this.withRetry(() => this.client.assets.get(assetId));
          if (asset) {
            buffer.push({
              ...asset,
              createdOn: asset.createdOn instanceof Date ? asset.createdOn.toISOString() : asset.createdOn,
              lastUpdated: asset.lastUpdated instanceof Date ? asset.lastUpdated.toISOString() : asset.lastUpdated,
            } as unknown as ConnectorFile);
          }
        } catch (error) {
          if (error instanceof WebflowError && error.statusCode === 404) {
            WSLogger.warn({
              source: 'WebflowConnector',
              message: `Asset ${assetId} not found, skipping`,
            });
            continue;
          }
          throw error;
        }
      }
      if (buffer.length > 0) {
        await callback({ files: buffer });
      }
      return;
    }

    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const itemId of ids) {
      try {
        const item = await this.withRetry(() => this.client.collections.items.getItem(collectionId, itemId));
        if (item) {
          buffer.push(item as unknown as ConnectorFile);
        }

        if (buffer.length >= BATCH_SIZE) {
          await callback({ files: buffer.splice(0) });
        }
      } catch (error) {
        if (error instanceof WebflowError && error.statusCode === 404) {
          WSLogger.warn({
            source: 'WebflowConnector',
            message: `Item ${itemId} not found in collection ${collectionId}, skipping`,
          });
          continue;
        }
        throw error;
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  getBatchSize(): number {
    // Webflow supports bulk operations up to 100 items
    return WEBFLOW_DEFAULT_BATCH_SIZE;
  }

  /**
   * Create items in Webflow from raw JSON files.
   * Files should contain Webflow fieldData.
   * Returns the created items.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const [, collectionId] = tableSpec.id.remoteId;

    const fieldDataArray: Record<string, unknown>[] = [];
    for (const file of files) {
      const fields = await this.extractFieldDataForApi(file, tableSpec);
      fieldDataArray.push(fields);
    }

    const created = await this.withRetry(() =>
      this.client.collections.items.createItems(collectionId, {
        skipInvalidFiles: false,
        isArchived: false,
        isDraft: false,
        fieldData: fieldDataArray as Webflow.collections.CreateBulkCollectionItemRequestBodyFieldData,
      }),
    );

    const createdItems = _.get(created, 'items', []) as Webflow.CollectionItem[];
    return createdItems as unknown as ConnectorFile[];
  }

  /**
   * Update items in Webflow from raw JSON files.
   * Files should have an 'id' field and fieldData to update.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedKeys?: (string[] | undefined)[],
  ): Promise<void> {
    const [, collectionId] = tableSpec.id.remoteId;

    const items: { id: string; fieldData: Webflow.CollectionItemFieldData }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const source = changedKeys?.[i]
        ? (Object.fromEntries(changedKeys[i]!.map((k) => [k, file[k]])) as ConnectorFile)
        : file;
      const fieldData = await this.extractFieldDataForApi(source, tableSpec);
      items.push({
        id: file.id as string,
        fieldData: fieldData as Webflow.CollectionItemFieldData,
      });
    }

    await this.withRetry(() =>
      this.client.collections.items.updateItems(collectionId, { skipInvalidFiles: false, items }),
    );
  }

  /**
   * Delete items from Webflow.
   * Files should have an 'id' field with the item ID to delete.
   * Returns successfully if items are already deleted (404).
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const [, collectionId] = tableSpec.id.remoteId;

    const items = files.map((file) => ({ id: file.id as string }));
    try {
      await this.withRetry(() => this.client.collections.items.deleteItems(collectionId, { items }));
    } catch (e) {
      // If item not found (404), that's fine - it's already deleted
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (errorMessage.includes('404') || errorMessage.includes('not_found') || errorMessage.includes('not found')) {
        // Item already deleted on remote, return success
        return;
      }
      throw e;
    }
  }

  /**
   * Extracts and processes fieldData for sending to Webflow API.
   * Extracts fieldData from the file and minifies RichText fields.
   */
  private async extractFieldDataForApi(
    file: ConnectorFile,
    tableSpec: BaseJsonTableSpec,
  ): Promise<Record<string, unknown>> {
    // Extract fieldData wrapper - this is the Webflow native JSON format
    const fieldData = (file.fieldData as Record<string, unknown>) || {};
    return this.processFieldDataWithSchema(fieldData, tableSpec);
  }

  /**
   * Process fieldData using JSON schema to identify and minify RichText fields.
   * RichText fields are identified by contentMediaType: 'text/html' in the schema.
   * Only fields that exist in the schema are included - unknown fields are filtered out.
   */
  private async processFieldDataWithSchema(
    fieldData: Record<string, unknown>,
    tableSpec: BaseJsonTableSpec,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    // Get the fieldData schema properties
    const schema = tableSpec.schema as TObject;
    const fieldDataSchema = schema.properties?.['fieldData'] as TObject | undefined;
    const fieldProperties = fieldDataSchema?.properties as Record<string, TSchema> | undefined;

    for (const [key, value] of Object.entries(fieldData)) {
      if (value === undefined) {
        continue;
      }

      // Only include fields that are defined in the schema
      const fieldSchema = fieldProperties?.[key];
      if (!fieldSchema) {
        // Skip unknown fields - they would cause Webflow API validation errors
        continue;
      }

      // Check if this field is a RichText field (has contentMediaType: 'text/html')
      const isRichText = (fieldSchema as { contentMediaType?: string }).contentMediaType === 'text/html';

      if (isRichText && typeof value === 'string') {
        result[key] = await minifyHtml(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Upload a file to Webflow as a site asset.
   *
   * The `metadata` object must include `siteId` — the Webflow site to upload to.
   * Optionally, `parentFolder` can specify an asset folder ID.
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
    _mimeType: string,
    metadata?: Record<string, unknown>,
  ): Promise<ConnectorAssetResult> {
    const siteId = metadata?.siteId as string | undefined;
    if (!siteId) {
      throw new Error('metadata.siteId is required to upload a Webflow asset');
    }

    const parentFolder = metadata?.parentFolder as string | undefined;

    // createAndUpload handles MD5 hashing, metadata creation, and S3 upload
    const uploadResult = await this.withRetry(() =>
      this.client.assets.utilities.createAndUpload(siteId, {
        file: new Uint8Array(buffer).buffer,
        fileName: filename,
        ...(parentFolder && { parentFolder }),
      }),
    );

    if (!uploadResult.id) {
      throw new Error('Webflow asset upload succeeded but no asset ID was returned');
    }

    // Re-fetch the full asset record to get all metadata
    const asset = await this.withRetry(() => this.client.assets.get(uploadResult.id!));

    return {
      remoteAssetId: asset.id!,
      url: asset.hostedUrl ?? undefined,
      filename: asset.originalFileName ?? undefined,
      mimeType: asset.contentType ?? undefined,
      size: asset.size ?? undefined,
      altText: asset.altText ?? undefined,
    };
  }

  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    // Phase 0: Standalone entity (Webflow Assets table)
    const standalone = extractStandaloneEntity(input);
    if (standalone) return [standalone];

    // Phase 1: Schema-driven (Image/MultiImage fields)
    return extractFromAnnotatedSchema(input, {
      extractUrl: (item) => (typeof item['url'] === 'string' ? item['url'] : undefined),
      resolveFieldValue: defaultResolveFieldValue,
    });
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    const errors = _.get(error, 'body.errors');
    if (errors && Array.isArray(errors)) {
      const formattedError = {
        userFriendlyMessage: (errors as { message: string }[]).map((error) => error.message).join('; '),
        description: (errors as { message: string }[]).map((error) => error.message).join('; '),
      };
      return formattedError;
    }
    if (error instanceof WebflowError) {
      if (
        error.statusCode === 409 &&
        error.message.includes("You've created all the items in your CMS Database allowed on your current plan.")
      ) {
        return {
          userFriendlyMessage: 'You have reached the maximum number of CMS items allowed for your plan.',
        };
      }
      return {
        userFriendlyMessage: error.message,
        description: error.message,
      };
    }
    return this.fallbackErrorDetails(error);
  }
}

connectorRegistry.register({
  service: Service.WEBFLOW,
  metadata: WebflowConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 120, duration: 60 },
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Webflow', Service.WEBFLOW);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new WebflowConnector(accessToken, { rateLimiter });
    } else {
      if (!ctx.decryptedCredentials?.apiKey) {
        throw new ConnectorInstantiationError('API key is required for Webflow', Service.WEBFLOW);
      }
      return new WebflowConnector(ctx.decryptedCredentials.apiKey, { rateLimiter });
    }
  },
});
