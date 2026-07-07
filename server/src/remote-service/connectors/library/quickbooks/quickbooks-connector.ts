import { connectorMetadata, isQuickBooksConnectorExtras } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { assertUnreachable } from 'src/utils/asserts';
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
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { QuickBooksApiClient, QuickBooksError } from './quickbooks-api-client';
import { buildQuickBooksJsonTableSpec } from './quickbooks-json-schema';
import {
  ENTITY_CONFIG,
  ENTITY_NEW_FILE_TEMPLATES,
  ENTITY_REQUIRED_UPDATE_FIELDS,
  ENTITY_TYPES,
  ENTITY_WRITE_CAPABILITIES,
  QuickBooksCredentials,
  QuickBooksDownloadProgress,
  QuickBooksEntityType,
} from './quickbooks-types';

const PAGE_SIZE = 1000;

/**
 * QBO system/envelope fields that describe the record wrapper rather than the
 * record's own data: `SyncToken` (optimistic-concurrency counter, injected
 * fresh on every write), `MetaData` (server-set create/update timestamps),
 * `domain`, and `sparse` (read-time response artifacts). These are never user
 * content, so they're stripped from create bodies and from any fallback update
 * body — QBO manages them itself. (`Id` is handled separately: dropped on create,
 * required on update.)
 */
const QBO_SYSTEM_ENVELOPE_FIELDS = new Set(['SyncToken', 'MetaData', 'domain', 'sparse']);

/**
 * Read/write connector for QuickBooks Online.
 *
 * Features:
 * - OAuth 2.0 authentication (access tokens last 1 hour, refresh tokens 100 days)
 * - Static schemas based on Intuit's API documentation (no runtime inference)
 * - Offset-based pagination using QBO's SQL-like query language
 * - Supports 23 entity types (Invoices, Customers, Items, Bills, etc.)
 *
 * Write support (see {@link ENTITY_WRITE_CAPABILITIES}): 20 of the 23 entities
 * are writable. Transaction entities support create/update/hard-delete; name-list
 * entities support create/update and deactivate-only (`Active: false`, since QBO
 * forbids hard-deleting them); `CompanyInfo` is update-only; `TaxCode`/`TaxRate`
 * are read-only. Three QBO-specific write mechanics are handled here:
 * - **Sparse updates** — updates always send `sparse: true` so only changed
 *   fields are written (a non-sparse update nulls every omitted field).
 * - **SyncToken optimistic concurrency** — every write carries the record's
 *   `SyncToken`; on a stale-object rejection the connector re-fetches the current
 *   token and retries once.
 * - **Full nested containers on edit** — a sparse update replaces each supplied
 *   top-level field wholesale (no deep-merge), so when the change set touches a
 *   nested object or array (`Line`, `BillAddr`, …) the connector re-sends that
 *   field's entire current value from the record file, not the partial diff.
 */
export class QuickBooksConnector extends Connector<string, QuickBooksDownloadProgress> {
  readonly service = Service.QUICKBOOKS;
  static readonly displayName = 'QuickBooks Online';
  static readonly metadata = connectorMetadata({
    displayName: 'QuickBooks Online',
    table: 'entity',
    tables: 'entities',
    base: 'company',
    bases: 'companies',
    logo: 'https://static.scratch.md/connector-icons/quickbooks.svg',
    oauth: { label: 'OAuth' },
    credentialFields: {
      oauth: [
        {
          key: 'quickbooksSandbox',
          type: 'boolean',
          label: 'Sandbox mode',
          description: 'Connect to the QuickBooks sandbox environment for testing',
          required: false,
        },
      ],
    },
  });

  private readonly client: QuickBooksApiClient;

  constructor(credentials: QuickBooksCredentials, opts?: { rateLimiter?: RateLimiter; sandbox?: boolean }) {
    super();
    this.client = new QuickBooksApiClient(credentials, { rateLimiter: opts?.rateLimiter, sandbox: opts?.sandbox });
  }

  /**
   * Test the connection by querying CompanyInfo.
   */
  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * List available entity types. Returns a hardcoded list since QBO has no discovery API.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ENTITY_TYPES.map((entityType) => ({
      id: {
        wsId: entityType.toLowerCase(),
        remoteId: [entityType],
      },
      displayName: ENTITY_CONFIG[entityType].displayName,
      metadata: {
        description: ENTITY_CONFIG[entityType].description,
        entityType,
      },
    }));
  }

  /**
   * Fetch the JSON Table Spec using static schemas.
   *
   * Returns a pre-defined TypeBox schema for the entity type. All schemas
   * have additionalProperties: true to handle undocumented fields gracefully.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const entityType = id.remoteId[0] as QuickBooksEntityType;

    if (!ENTITY_TYPES.includes(entityType)) {
      throw new QuickBooksError(
        `Entity type '${entityType}' is not supported. Supported types: ${ENTITY_TYPES.join(', ')}`,
        400,
        'UNSUPPORTED_ENTITY',
      );
    }

    return buildQuickBooksJsonTableSpec(id, entityType);
  }

  /**
   * Seed a newly-created record with the fields QBO requires on create (e.g. an
   * Invoice needs `CustomerRef` + a `Line`). Returns a fresh clone so callers
   * can't mutate the shared template; entities without a template start blank.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    const entityType = tableSpec.id.remoteId[0] as QuickBooksEntityType;
    const template = ENTITY_NEW_FILE_TEMPLATES[entityType];
    return template ? structuredClone(template) : {};
  }

  /**
   * Pull all records using offset-based pagination.
   *
   * QBO uses 1-based STARTPOSITION with MAXRESULTS up to 1000.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: QuickBooksDownloadProgress }) => Promise<void>,
    progress: QuickBooksDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = tableSpec.id.remoteId[0];
    let startPosition = progress.nextStartPosition ?? 1;
    let hasMore = true;

    while (hasMore) {
      const result = await this.client.query(entityType, startPosition, PAGE_SIZE);
      hasMore = result.hasMore;
      startPosition += result.entities.length;

      if (result.entities.length > 0) {
        await callback({
          files: result.entities as ConnectorFile[],
          connectorProgress: { nextStartPosition: startPosition },
        });
      }
    }
    return {};
  }

  /**
   * Fetch specific records by their IDs.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const entityType = tableSpec.id.remoteId[0];
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      try {
        const entity = await this.client.getEntity(entityType, id);
        if (entity) {
          buffer.push(entity as ConnectorFile);
        }
      } catch (error) {
        WSLogger.warn({
          source: 'QuickBooksConnector',
          message: `Failed to fetch ${entityType} with ID "${id}", skipping`,
          error,
        });
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
   * QBO has no bulk write API (its batch endpoint is out of scope) — each
   * create/update/delete is a separate request.
   */
  getBatchSize(): number {
    return 1;
  }

  /**
   * Create records in QuickBooks.
   *
   * Sends the record with QBO's system/envelope fields stripped (no `Id`,
   * `SyncToken`, `MetaData`, …). Returns each created record as QBO stored it,
   * carrying the server-assigned `Id` + initial `SyncToken` so the framework can
   * link the new file to its remote record.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.remoteId[0] as QuickBooksEntityType;
    if (!ENTITY_WRITE_CAPABILITIES[entityType].canCreate) {
      throw new QuickBooksError(
        `Creating ${entityType} records is not supported by the QuickBooks API.`,
        400,
        'CREATE_NOT_SUPPORTED',
      );
    }

    const results: ConnectorFile[] = [];
    for (const file of files) {
      const created = await this.client.createEntity(entityType, this.extractWritableData(file));
      results.push(created as ConnectorFile);
    }
    return results;
  }

  /**
   * Update records in QuickBooks with a sparse update.
   *
   * Uses `changedFields` (the per-record sparse diff) as the payload so only the
   * fields the user actually changed are written; falls back to the full record
   * when a diff isn't available (legacy publish paths). Each write carries the
   * record's `Id` + `SyncToken` + `sparse: true`, and retries once on a
   * stale-object rejection with a freshly re-fetched token.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.remoteId[0] as QuickBooksEntityType;
    if (!ENTITY_WRITE_CAPABILITIES[entityType].canUpdate) {
      throw new QuickBooksError(
        `Updating ${entityType} records is not supported by the QuickBooks API.`,
        400,
        'UPDATE_NOT_SUPPORTED',
      );
    }

    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const id = this.extractRemoteId(file);
      if (!id) {
        WSLogger.warn({
          source: 'QuickBooksConnector',
          message: `Missing Id on ${entityType} record, skipping update`,
        });
        continue;
      }

      const sparseFields = this.buildSparseUpdateFields(entityType, file, changedFields?.[i]);
      if (Object.keys(sparseFields).length === 0) {
        // Nothing writable changed (e.g. only computed/system fields differed);
        // leave the remote record untouched and echo the file back.
        results.push(file);
        continue;
      }

      const updated = await this.writeSparseUpdateWithStaleRetry(entityType, id, file, sparseFields);
      results.push(updated as ConnectorFile);
    }
    return results;
  }

  /**
   * Delete records from QuickBooks, routed by the entity's delete behavior:
   * transaction entities are hard-deleted (`?operation=delete`); name-list
   * entities are deactivated (`Active: false`) since QBO forbids hard-deleting
   * them; `CompanyInfo`/`TaxCode`/`TaxRate` cannot be deleted at all. Each write
   * retries once on a stale-object rejection, and an already-gone record is a
   * no-op.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const entityType = tableSpec.id.remoteId[0] as QuickBooksEntityType;
    const behavior = ENTITY_WRITE_CAPABILITIES[entityType].deleteBehavior;

    switch (behavior) {
      case 'notDeletable':
        throw new QuickBooksError(
          `Deleting ${entityType} records is not supported by the QuickBooks API.`,
          400,
          'DELETE_NOT_SUPPORTED',
        );
      case 'hardDeleteViaOperationParam':
        for (const file of files) {
          await this.hardDeleteWithStaleRetry(entityType, file);
        }
        return;
      case 'deactivateViaActiveFalse':
        for (const file of files) {
          await this.deactivateRecord(entityType, file);
        }
        return;
      default:
        assertUnreachable(behavior);
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titlePath && !tableSpec.titlePath.includes('.') ? tableSpec.titlePath : undefined;
    return suggestFileNamesFromFieldPaths(records, titlePath);
  }

  /**
   * Extract error details from QuickBooks API errors.
   *
   * QBO error response shape: { Fault: { Error: [{ Message, Detail, code }] } }
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof QuickBooksError) {
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
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, [
          'Fault.Error[0].Detail',
          'Fault.Error[0].Message',
          'fault.error[0].detail',
          'fault.error[0].message',
        ]),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  // --- Private write helpers ---

  /**
   * The record's remote id (QBO stores it under `Id`). Returns undefined for a
   * record with no usable id so callers can skip it.
   */
  private extractRemoteId(file: ConnectorFile): string | undefined {
    const id = file.Id;
    if (typeof id === 'string' && id.length > 0) return id;
    if (typeof id === 'number') return String(id);
    return undefined;
  }

  /**
   * The record's stored `SyncToken` from the last pull, as a string. Defaults to
   * `'0'` (a freshly-created record's token) when absent — a wrong guess simply
   * triggers the stale-object refetch-and-retry path.
   */
  private extractStoredSyncToken(file: ConnectorFile): string {
    const token = file.SyncToken;
    if (typeof token === 'string' && token.length > 0) return token;
    if (typeof token === 'number') return String(token);
    return '0';
  }

  /**
   * Strip QBO's system/envelope fields and `Id` from a record — the writable
   * subset used as the create body and as the update fallback when no per-field
   * diff is available. User-editable computed fields (e.g. `TotalAmt`) are NOT
   * stripped: they pass through so QBO can reject/ignore them, rather than
   * silently dropping a user's edit.
   */
  private extractWritableData(file: ConnectorFile): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(file)) {
      if (key === 'Id' || QBO_SYSTEM_ENVELOPE_FIELDS.has(key)) continue;
      data[key] = value;
    }
    return data;
  }

  /**
   * Build the changed-fields payload for a sparse update. Prefers the per-record
   * `changedFields` diff (only what the user changed); falls back to the full
   * writable record. Three adjustments:
   * - System/envelope fields and `Id` are dropped (they're set explicitly on the
   *   write, not carried in the diff).
   * - **Full nested containers.** A QBO sparse update replaces each supplied
   *   *top-level* field wholesale — it does NOT deep-merge nested objects or
   *   arrays. So a partial diff into a nested container (one line of `Line`, one
   *   field of an address like `BillAddr`) would null every sibling line/sub-field
   *   → silent data loss. For any changed key whose value is an object or array,
   *   re-send the entire current value from the record file. `files[i]` is the
   *   same fully-transformed content the diff is masked from (see
   *   `publish-plan-run.service`), so the file value already carries FK-resolved /
   *   transformed values — no merge with the diff is needed.
   * - **Required-on-update fields.** QBO rejects a sparse update on some entities
   *   unless their required fields are present, even when unchanged (e.g. a Bill
   *   sparse update 400s without `VendorRef`). Those fields (see
   *   {@link ENTITY_REQUIRED_UPDATE_FIELDS}) are carried from the record file.
   */
  private buildSparseUpdateFields(
    entityType: QuickBooksEntityType,
    file: ConnectorFile,
    changedFieldsEntry: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const source = changedFieldsEntry ?? this.extractWritableData(file);

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === 'Id' || QBO_SYSTEM_ENVELOPE_FIELDS.has(key)) continue;
      const touchesNestedContainer = typeof value === 'object' && value !== null && key in file;
      fields[key] = touchesNestedContainer ? file[key] : value;
    }

    for (const requiredField of ENTITY_REQUIRED_UPDATE_FIELDS[entityType] ?? []) {
      if (!(requiredField in fields) && requiredField in file) {
        fields[requiredField] = file[requiredField];
      }
    }
    return fields;
  }

  /**
   * Send a sparse update with the record's `Id` + `SyncToken` + `sparse: true`.
   * Tries the stored token first; on QBO's stale-object rejection, re-fetches the
   * current token and retries once. If the record has vanished on refetch, the
   * original error surfaces.
   */
  private async writeSparseUpdateWithStaleRetry(
    entityType: QuickBooksEntityType,
    id: string,
    file: ConnectorFile,
    sparseFields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const write = (syncToken: string): Promise<Record<string, unknown>> =>
      this.client.updateEntity(entityType, { ...sparseFields, Id: id, SyncToken: syncToken, sparse: true });

    try {
      return await write(this.extractStoredSyncToken(file));
    } catch (error) {
      if (!QuickBooksApiClient.isStaleObjectError(error)) throw error;
      const currentToken = await this.fetchCurrentSyncToken(entityType, id);
      if (currentToken === null) throw error;
      return write(currentToken);
    }
  }

  /**
   * Permanently delete a transaction, retrying once on a stale-object rejection
   * with a re-fetched token. An already-deleted record (404 / vanished) is a
   * no-op.
   */
  private async hardDeleteWithStaleRetry(entityType: QuickBooksEntityType, file: ConnectorFile): Promise<void> {
    const id = this.extractRemoteId(file);
    if (!id) {
      WSLogger.warn({ source: 'QuickBooksConnector', message: `Missing Id on ${entityType} record, skipping delete` });
      return;
    }

    try {
      await this.client.deleteTransaction(entityType, id, this.extractStoredSyncToken(file));
    } catch (error) {
      if (!QuickBooksApiClient.isStaleObjectError(error)) throw error;
      const currentToken = await this.fetchCurrentSyncToken(entityType, id);
      if (currentToken === null) return; // already gone
      await this.client.deleteTransaction(entityType, id, currentToken);
    }
  }

  /**
   * "Delete" a name-list entity by deactivating it (`Active: false`) — QBO forbids
   * hard-deleting these, and deactivation is reversible. Built through
   * {@link buildSparseUpdateFields} (not a bare `{ Active: false }`) so the write
   * carries the entity's required-on-update fields too — a deactivate is a sparse
   * update and must satisfy the same required-field rule (e.g. a `Term` sparse
   * write needs `Type`/`DueDays`). Inherits the SyncToken stale-object retry.
   */
  private async deactivateRecord(entityType: QuickBooksEntityType, file: ConnectorFile): Promise<void> {
    const id = this.extractRemoteId(file);
    if (!id) {
      WSLogger.warn({
        source: 'QuickBooksConnector',
        message: `Missing Id on ${entityType} record, skipping deactivate`,
      });
      return;
    }
    const sparseFields = this.buildSparseUpdateFields(entityType, file, { Active: false });
    await this.writeSparseUpdateWithStaleRetry(entityType, id, file, sparseFields);
  }

  /**
   * Re-fetch a record's current `SyncToken` from QBO. Returns null if the record
   * no longer exists.
   */
  private async fetchCurrentSyncToken(entityType: QuickBooksEntityType, id: string): Promise<string | null> {
    const current = await this.client.getEntity(entityType, id);
    if (!current) return null;
    const token = current.SyncToken;
    if (typeof token === 'string' && token.length > 0) return token;
    if (typeof token === 'number') return String(token);
    return null;
  }
}

connectorRegistry.register({
  service: Service.QUICKBOOKS,
  metadata: QuickBooksConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['oauth'],
  rateLimiterSpec: { points: 450, duration: 60 },
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for QuickBooks', Service.QUICKBOOKS);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (!isQuickBooksConnectorExtras(ctx.connectorAccount.extras)) {
      throw new ConnectorInstantiationError('Realm ID is required for QuickBooks', Service.QUICKBOOKS);
    }
    const { realmId, sandbox } = ctx.connectorAccount.extras;
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new QuickBooksConnector({ accessToken, realmId }, { rateLimiter, sandbox: sandbox ?? false });
    } else {
      throw new ConnectorInstantiationError('QuickBooks only supports OAuth authentication', Service.QUICKBOOKS);
    }
  },
});
