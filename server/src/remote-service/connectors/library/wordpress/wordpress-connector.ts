import { ConnectorPullOptions, Service } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import TurndownService from 'turndown';
import { Connector } from '../../connector';
import { extractErrorMessageFromAxiosError } from '../../error';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import {
  WORDPRESS_BATCH_SIZE,
  WORDPRESS_CREATE_UNSUPPORTED_TABLE_IDS,
  WORDPRESS_ORG_V2_PATH,
  WORDPRESS_POLLING_PAGE_SIZE,
  WORDPRESS_STATIC_FOREIGN_KEY_COLUMN_IDS,
} from './wordpress-constants';
import { WordPressHttpClient } from './wordpress-http-client';
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

export class WordPressConnector extends Connector<typeof Service.WORDPRESS, WordPressDownloadProgress> {
  readonly service = Service.WORDPRESS;
  static readonly displayName = 'WordPress';

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

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: WordPressDownloadProgress }) => Promise<void>,
    progress: WordPressDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const [tableId] = tableSpec.id.remoteId;
    let offset = progress?.nextOffset ?? 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.pollRecords(tableId, offset, WORDPRESS_POLLING_PAGE_SIZE);

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
  async updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const [tableId] = tableSpec.id.remoteId;

    const requests: WordPressBatchRequestItem[] = files.map((file) => ({
      method: 'PATCH' as const,
      path: `/${WORDPRESS_ORG_V2_PATH}${tableId}/${String(file.id)}`,
      body: this.fileToWordPressRecord(file) as Record<string, unknown>,
    }));

    const batchResponse = await this.client.batchRequest(requests);
    this.assertBatchValidation(batchResponse, requests);
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

      // Handle rendered objects - WordPress expects just the value, not the rendered wrapper
      if (value && typeof value === 'object' && 'rendered' in value) {
        wpRecord[key] = (value as { rendered: unknown }).rendered;
      } else {
        wpRecord[key] = value;
      }
    }

    return wpRecord;
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (isAxiosError(error)) {
      const message = extractErrorMessageFromAxiosError(this.service, error, ['message']);
      return {
        userFriendlyMessage: `Wordpress returned an error: ${message}`,
        description: `Wordpress returned HTTP ${error.status}: ${message}`,
      };
    }

    return {
      userFriendlyMessage: `An error occurred while connecting to Wordpress: ${error instanceof Error ? error.message : 'Unknown error'}`,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}
