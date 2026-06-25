import { TObject } from '@sinclair/typebox';
import { connectorMetadata, IncrementalPullSupport } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import TurndownService from 'turndown';
import { extractStandaloneEntity } from '../../asset-extraction-helpers';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
} from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  findLastModifiedFieldName,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { WordPressAuthParser } from './wordpress-auth-parser';
import {
  WORDPRESS_BATCH_SIZE,
  WORDPRESS_CREATE_UNSUPPORTED_TABLE_IDS,
  WORDPRESS_ORG_V2_PATH,
  WORDPRESS_POLLING_PAGE_SIZE,
  WORDPRESS_STATIC_FOREIGN_KEY_COLUMN_IDS,
  WORDPRESS_STATUS_COLUMN_ID,
} from './wordpress-constants';
import { WordPressHttpClient } from './wordpress-http-client';
import { formatWordPressModifiedAfter } from './wordpress-incremental';
import { buildWordPressJsonTableSpec } from './wordpress-json-schema';
import {
  buildTaxonomyForeignKeys,
  parseTableInfoFromTaxonomies,
  parseTableInfoFromTypes,
} from './wordpress-schema-parser';
import {
  WordPressBatchRequestItem,
  WordPressBatchResponse,
  WordPressDownloadProgress,
  WordPressRecord,
} from './wordpress-types';

/**
 * Resolve the field name used for the `modified_after` filter, preferring an
 * explicit user setting over the schema-annotated auto-detection. Pure (no
 * `this`) so both the connector instance and the REST-layer capability resolver
 * can call it. A `null` tableSpec means no schema is on hand, so only an
 * explicit `options.modifiedAtField` can resolve.
 */
export function resolveWordPressModifiedAtField(
  options: PullRecordFilesOptions,
  tableSpec: BaseJsonTableSpec | null,
): string | undefined {
  if (typeof options.modifiedAtField === 'string' && options.modifiedAtField.trim() !== '') {
    return options.modifiedAtField.trim();
  }
  return tableSpec ? findLastModifiedFieldName(tableSpec) : undefined;
}

/**
 * Three-state incremental-pull capability for WordPress. Post-type and media
 * collections expose an auto-detectable `modified` field (`SUPPORTED`); taxonomy
 * collections (categories/tags/terms) have neither a modified field nor a
 * `modified_after` param and can never run incremental (`NOT_SUPPORTED`) — there
 * is no user configuration that would change that, so this never returns
 * `NEEDS_CONFIGURATION`. With a `null` tableSpec the field can't be auto-detected
 * yet; the REST layer reads the schema and re-resolves whenever the answer isn't
 * already `SUPPORTED`.
 */
export function wordPressIncrementalPullSupport(
  options: PullRecordFilesOptions,
  tableSpec: BaseJsonTableSpec | null,
): IncrementalPullSupport {
  return resolveWordPressModifiedAtField(options, tableSpec) !== undefined
    ? IncrementalPullSupport.SUPPORTED
    : IncrementalPullSupport.NOT_SUPPORTED;
}

export class WordPressConnector extends Connector<string, WordPressDownloadProgress> {
  readonly service = Service.WORDPRESS;
  static readonly displayName = 'WordPress';
  static readonly metadata = connectorMetadata({
    displayName: 'WordPress',
    table: 'post',
    tables: 'posts',
    record: 'post',
    records: 'posts',
    logo: 'https://static.scratch.md/connector-icons/wordpress.svg',
    incrementalPull: true,
    incrementalPullInstructions:
      'Incremental pull only downloads content changed since the last pull, based on the modified date of each item. Posts and media support this automatically. Taxonomy tables such as categories and tags cannot be filtered by modified date, so they always re-download in full.',
    credentialFields: {
      user_provided_params: [
        {
          key: 'username',
          type: 'string',
          label: 'Username',
          placeholder: 'Enter your WordPress username',
          required: true,
        },
        {
          key: 'password',
          type: 'password',
          label: 'Application password',
          placeholder: 'Enter your application password here',
          required: true,
        },
        {
          key: 'endpoint',
          type: 'string',
          label: 'WordPress URL',
          placeholder: 'Enter the address of your WordPress site here',
          required: true,
        },
      ],
    },
  });
  override supportsFileUpload = true;

  private client: WordPressHttpClient;
  private readonly turndownService: TurndownService = new TurndownService({
    headingStyle: 'atx',
  });

  constructor(username: string, password: string, endpoint: string) {
    super();
    this.client = new WordPressHttpClient(endpoint, username, password);
  }

  async testConnection(): Promise<void> {
    await this.client.testEndpoint();
  }

  async listTables(): Promise<TablePreview[]> {
    // Fetch post types and taxonomies in parallel
    const [typesResponse, taxonomiesResponse] = await Promise.all([
      this.client.getTypes(),
      this.client.getTaxonomies(),
    ]);

    const postTypeTables = parseTableInfoFromTypes(typesResponse);
    const taxonomyTables = parseTableInfoFromTaxonomies(taxonomiesResponse);

    return [...postTypeTables, ...taxonomyTables];
  }

  /**
   * Fetch JSON Table Spec directly from the WordPress API for a post type/endpoint.
   * Returns a schema that describes the raw WordPress record format with rendered objects.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const [tableId] = id.remoteId;
    const [optionsResponse, taxonomiesResponse] = await Promise.all([
      this.client.getEndpointOptions(tableId),
      this.client.getTaxonomies(),
    ]);

    const taxonomyForeignKeys = buildTaxonomyForeignKeys(taxonomiesResponse);
    const foreignKeyColumnIds = [...WORDPRESS_STATIC_FOREIGN_KEY_COLUMN_IDS, ...taxonomyForeignKeys];
    return buildWordPressJsonTableSpec(id, optionsResponse, foreignKeyColumnIds);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    const schema = tableSpec.schema as TObject;
    const hasStatus = schema.properties?.[WORDPRESS_STATUS_COLUMN_ID] !== undefined;
    if (hasStatus) {
      return { status: 'draft' };
    }
    return {};
  }

  /**
   * WordPress supports incremental pulls when the collection exposes a
   * last-modified column. Post-type and media collections have `modified`
   * (annotated `x-scratch-last-modified-field` by the schema builder), so they
   * auto-detect with zero config. Taxonomy collections (categories/tags/terms)
   * have no `modified` field and no `modified_after` param — they resolve to
   * `undefined` here, so this returns `false` and the job demotes the folder to
   * a full scan. Resolution order: explicit `options.modifiedAtField` →
   * schema-annotated auto-detect.
   */
  override incrementalPullSupport(
    options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return wordPressIncrementalPullSupport(options, tableSpec);
  }

  /**
   * Pull all records for a table as JSON files.
   *
   * Full pull (default): scan every record. Incremental pull: pass
   * `modified_after` (the watermark minus a clock-skew margin) into every
   * paginated request so WordPress server-side filters to records changed since
   * the previous run, and return the new watermark for the job to persist.
   * WordPress has no user `options.filter` today — nothing to combine.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: WordPressDownloadProgress }) => Promise<void>,
    progress: WordPressDownloadProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const [tableId] = tableSpec.id.remoteId;
    let offset = progress?.nextOffset ?? 0;
    let hasMore = true;

    // Capture the watermark BEFORE the first API call so changes made mid-pull
    // aren't lost on the next run; idempotent commits absorb the small
    // re-pulled window. `modified_after` is filtered against `post_modified`,
    // which WordPress stores in the *site's* timezone, while our watermark is a
    // UTC instant — `formatWordPressModifiedAfter` resolves the site timezone
    // (from the REST index, memoized) and renders the clock-skewed watermark as
    // site-local wall-clock time so the comparison is correct. Incremental only
    // applies when the field resolves (post/media) — taxonomy is gated out by
    // `supportsIncrementalPull` and falls through to a full scan here.
    let newWatermark: Date | undefined;
    let modifiedAfter: string | undefined;
    const incremental =
      options.pullMode === 'incremental' &&
      options.since instanceof Date &&
      resolveWordPressModifiedAtField(options, tableSpec) !== undefined;
    if (incremental && options.since) {
      newWatermark = new Date();
      const siteTimezone = await this.client.getSiteTimezone();
      modifiedAfter = formatWordPressModifiedAfter(options.since, siteTimezone);
    }

    while (hasMore) {
      const response = await this.client.pollRecords(tableId, offset, WORDPRESS_POLLING_PAGE_SIZE, modifiedAfter);

      if (!Array.isArray(response)) {
        throw new Error(`Unexpected response format from WordPress: expected array, got ${typeof response}`);
      }

      const returnedCount = response.length;
      if (returnedCount < WORDPRESS_POLLING_PAGE_SIZE) {
        hasMore = false;
        await callback({ files: response as unknown as ConnectorFile[], connectorProgress: { nextOffset: undefined } });
      } else {
        offset += returnedCount;
        await callback({ files: response as unknown as ConnectorFile[], connectorProgress: { nextOffset: offset } });
      }
    }
    return newWatermark ? { newWatermark } : {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const [tableId] = tableSpec.id.remoteId;
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const recordId of ids) {
      const record = await this.client.getRecord(tableId, recordId);
      if (record) {
        buffer.push(record as unknown as ConnectorFile);
      }

      if (buffer.length >= BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  getBatchSize(): number {
    return WORDPRESS_BATCH_SIZE;
  }

  /**
   * Create records in WordPress using the batch API (POST /batch/v1).
   * Uses "require-all-validate" so WordPress rejects the entire batch if any request
   * fails validation (returns 207 with failed:"validation"). Once past validation,
   * all requests execute and are expected to succeed.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const [tableId] = tableSpec.id.remoteId;

    if (WORDPRESS_CREATE_UNSUPPORTED_TABLE_IDS.includes(tableId)) {
      throw new Error(`Table "${tableId}" does not support record creation`);
    }

    const requests: WordPressBatchRequestItem[] = files.map((file) => ({
      method: 'POST' as const,
      path: `/${WORDPRESS_ORG_V2_PATH}${tableId}`,
      body: this.fileToWordPressRecord(file) as Record<string, unknown>,
    }));

    const batchResponse = await this.client.batchRequest(requests);
    this.assertBatchValidation(batchResponse, requests);

    return batchResponse.responses.map((r) => r.body as unknown as ConnectorFile);
  }

  /**
   * Update records in WordPress using the batch API (POST /batch/v1).
   * Uses "require-all-validate" so WordPress rejects the entire batch if any request
   * fails validation. Once past validation, all requests execute and are expected to succeed.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const [tableId] = tableSpec.id.remoteId;

    const requests: WordPressBatchRequestItem[] = files.map((file, i) => ({
      method: 'PATCH' as const,
      path: `/${WORDPRESS_ORG_V2_PATH}${tableId}/${String(file.id)}`,
      body: this.fileToWordPressRecord(changedFields[i] as ConnectorFile) as Record<string, unknown>,
    }));

    const batchResponse = await this.client.batchRequest(requests);
    this.assertBatchValidation(batchResponse, requests);
    // After validation passes every `responses[i].body` is the persisted
    // WordPressRecord (or an error wrapper for skipped rows). Map back
    // parallel to `files`; fall back to the input file for any non-record
    // body (defensive — shouldn't happen post-validation).
    return batchResponse.responses.map((item, i) => {
      const body = item?.body as Record<string, unknown> | undefined;
      if (body && typeof body === 'object' && 'id' in body) {
        return body as ConnectorFile;
      }
      return files[i];
    });
  }

  /**
   * Delete records from WordPress using the batch API (POST /batch/v1).
   * Uses "require-all-validate" so WordPress rejects the entire batch if any request
   * fails validation. Once past validation, all requests execute and are expected to succeed.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const [tableId] = tableSpec.id.remoteId;

    const requests: WordPressBatchRequestItem[] = files.map((file) => ({
      method: 'DELETE' as const,
      path: `/${WORDPRESS_ORG_V2_PATH}${tableId}/${String(file.id)}?force=true`,
    }));

    const batchResponse = await this.client.batchRequest(requests);
    this.assertBatchValidation(batchResponse, requests);
  }

  /**
   * WordPress references uploaded media by integer ID (e.g. featured_media: 42).
   */
  override resolveAssetReference(asset: {
    remoteAssetId: string;
    rehostedUrl: string | null;
    url: string | null;
  }): unknown {
    const id = parseInt(asset.remoteAssetId, 10);
    return isNaN(id) ? asset.remoteAssetId : id;
  }

  /**
   * Upload a media file to WordPress.
   * Sends the raw file buffer to the /wp/v2/media endpoint.
   */
  async uploadFile(buffer: Buffer, filename: string, mimeType: string): Promise<ConnectorAssetResult> {
    const result = await this.client.uploadMedia(buffer, filename, mimeType);
    return {
      remoteAssetId: String(result.id),
      url: result.source_url,
      filename,
      mimeType: result.mime_type,
    };
  }

  /**
   * Throws if any request in the batch returned an error status.
   * The batch endpoint always returns HTTP 207 (axios won't throw), so we must
   * check response statuses manually. With "require-all-validate", WordPress validates
   * all requests upfront and refuses to execute any if validation fails (failed:"validation").
   * But even when validation passes (failed:"none"), individual requests can still fail
   * at execution time (e.g. term_exists for duplicate taxonomy terms).
   */
  private assertBatchValidation(response: WordPressBatchResponse, requests: WordPressBatchRequestItem[]): void {
    const errors = response.responses
      .map((r, i) => ({ r, path: requests[i]?.path }))
      .filter(({ r }) => r !== null && r?.status >= 400)
      .map(({ r, path }) => {
        const body = r.body as { message?: string };
        const msg = body.message || `HTTP ${r.status}`;
        return path ? `${path}: ${msg}` : msg;
      });

    if (errors.length > 0) {
      const prefix =
        response.failed === 'validation' ? 'WordPress batch failed validation' : 'WordPress batch request failed';
      throw new Error(`${prefix}: ${errors.join('; ')}`);
    }
  }

  /**
   * Convert a ConnectorFile to a WordPress record for API calls.
   * Extracts writable fields and handles rendered content objects.
   */
  private fileToWordPressRecord(file: ConnectorFile): WordPressRecord {
    const wpRecord: WordPressRecord = {};

    for (const [key, value] of Object.entries(file)) {
      // Skip id and metadata fields
      if (key === 'id' || key === 'createdTime') {
        continue;
      }

      // Handle rendered objects - WordPress expects the raw value for writes
      if (value && typeof value === 'object' && 'raw' in value) {
        wpRecord[key] = (value as { raw: unknown }).raw;
      } else {
        wpRecord[key] = value;
      }
    }

    return wpRecord;
  }

  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    // WordPress media table is a standalone asset entity
    const standalone = extractStandaloneEntity(input);
    return standalone ? [standalone] : [];
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath ?? tableSpec.slugColumnRemoteId);
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      const responseData = error.response?.data as Record<string, unknown> | undefined;

      // WordPress 500: surface the underlying PHP/plugin error from the response body
      if (error.response?.status === 500) {
        const phpError = (responseData?.data as Record<string, unknown> | undefined)?.error as
          | Record<string, unknown>
          | undefined;
        const phpMessage = typeof phpError?.message === 'string' ? phpError.message : null;
        const phpFile = typeof phpError?.file === 'string' ? phpError.file : '';
        const phpLine = typeof phpError?.line === 'number' ? phpError.line : '';
        const remoteDetail = phpMessage
          ? `${phpMessage} (${phpFile}:${String(phpLine)})`
          : extractErrorMessageFromAxiosError(this.service, error, ['message']);
        return {
          userFriendlyMessage:
            'WordPress returned a server error — this is likely caused by a plugin conflict or PHP error on the site.',
          description: remoteDetail,
        };
      }

      // WordPress permission errors: status=any rejected or context=edit forbidden
      const wpCode = typeof responseData?.code === 'string' ? responseData.code : null;
      if (
        wpCode === 'rest_forbidden_context' ||
        wpCode === 'rest_forbidden_status' ||
        wpCode === 'rest_invalid_param'
      ) {
        const remoteMessage = typeof responseData?.message === 'string' ? responseData.message : undefined;
        return {
          userFriendlyMessage:
            'WordPress rejected the request due to insufficient permissions. Pages, Categories, and Tags require Editor or Administrator role.',
          description: remoteMessage,
        };
      }

      const message = extractErrorMessageFromAxiosError(this.service, error, ['message']);
      return {
        userFriendlyMessage: `WordPress returned an error: ${message}`,
        description: `WordPress returned HTTP ${String(error.response?.status)}: ${message}`,
      };
    }

    return this.fallbackErrorDetails(error);
  }
}

connectorRegistry.register({
  service: Service.WORDPRESS,
  metadata: WordPressConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  resolveIncrementalPullSupport: ({ options, tableSpec }) => wordPressIncrementalPullSupport(options, tableSpec),
  incrementalPullAutoDetectsFromSchema: true,
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for WordPress', Service.WORDPRESS);
    }
    if (!ctx.decryptedCredentials?.username) {
      throw new ConnectorInstantiationError('Username is required for WordPress', Service.WORDPRESS);
    }
    if (!ctx.decryptedCredentials?.password) {
      throw new ConnectorInstantiationError('Password is required for WordPress', Service.WORDPRESS);
    }
    if (!ctx.decryptedCredentials?.endpoint) {
      throw new ConnectorInstantiationError('Endpoint is required for WordPress', Service.WORDPRESS);
    }
    return new WordPressConnector(
      ctx.decryptedCredentials.username,
      ctx.decryptedCredentials.password,
      ctx.decryptedCredentials.endpoint,
    );
  },
  createAuthParser() {
    return new WordPressAuthParser();
  },
});
