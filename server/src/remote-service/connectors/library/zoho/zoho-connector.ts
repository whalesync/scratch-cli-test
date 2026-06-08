import { connectorMetadata, IncrementalPullSupport } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
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
import { ZOHO_PAGE_TOKEN_RECORD_CEILING, ZOHO_WRITE_BATCH_SIZE, ZohoApiClient, ZohoError } from './zoho-api-client';
import { buildZohoJsonTableSpec, sanitizeZohoWritePayload, ZOHO_MODIFIED_TIME_FIELD } from './zoho-json-schema';
import {
  categoryForModule,
  normalizeZohoDataCenter,
  ZohoConnectorCredentials,
  ZohoDownloadProgress,
  ZohoFieldMetadata,
} from './zoho-types';

const LOG_SOURCE = 'ZohoConnector';

/** Field data types not returned by the records list endpoint — excluded from pull. */
const NON_LIST_DATA_TYPES = new Set(['subform', 'subformfield', 'multiselectlookup']);

/**
 * Connector for Zoho CRM.
 *
 * Dynamic discovery: modules (tables) come from `/settings/modules` and each
 * module's schema from `/settings/fields`, so standard, custom, and
 * edition-gated modules all surface with no connector change. Records are
 * stored as the verbatim Zoho response (1 file per record). Pull uses
 * `page_token` pagination with an incremental `If-Modified-Since` path.
 */
export class ZohoConnector extends Connector<string, ZohoDownloadProgress> {
  readonly service = Service.ZOHO;
  static readonly displayName = 'Zoho CRM';
  static readonly metadata = connectorMetadata({
    displayName: 'Zoho CRM',
    table: 'module',
    tables: 'modules',
    logo: 'https://static.scratch.md/connector-icons/zoho.svg',
    // Hidden from the connection picker until v1 is complete (users table, live
    // create/delete, Tier 2). Flip to true (or remove) to expose it.
    visible: false,
    incrementalPull: true,
    userProvidedParamsLabel: 'OAuth Credentials',
    setupGuide: { label: 'How to get Zoho credentials', url: 'https://www.zoho.com/crm/developer/docs/api/v8/' },
    credentialFields: {
      user_provided_params: [
        { key: 'zohoClientId', type: 'string', label: 'Client ID', placeholder: '1000.XXXXXXXX', required: true },
        { key: 'zohoClientSecret', type: 'password', label: 'Client Secret', required: true },
        { key: 'zohoRefreshToken', type: 'password', label: 'Refresh Token', required: true },
        {
          key: 'zohoDataCenter',
          type: 'string',
          label: 'Data Center',
          placeholder: 'US | EU | IN | AU | JP | CA | CN | SA',
          required: false,
        },
      ],
    },
  });

  private readonly client: ZohoApiClient;

  /** Cache of the field api_names to request when pulling each module. */
  private readonly pullFieldNamesCache = new Map<string, string[]>();

  constructor(credentials: ZohoConnectorCredentials, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new ZohoApiClient(credentials, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * List modules the org exposes, applying the eligibility policy: only
   * `api_supported` modules are listed; non-creatable/editable/deletable
   * modules are flagged read-only via the corresponding `disabled*` markers.
   * No static fallback — a discovery failure surfaces (after retry) rather than
   * masking the real org with a hardcoded list.
   */
  async listTables(): Promise<TablePreview[]> {
    const modules = await this.client.listModules();
    const tables: TablePreview[] = [];

    for (const module of modules) {
      // Skip modules the records API can't serve, and subform sub-modules.
      if (module.api_supported !== true) continue;
      if (module.subform === true) continue;

      const apiName = module.api_name;
      const displayName = module.plural_label ?? module.module_name ?? apiName;
      const noCreate = module.creatable === false;
      const noUpdate = module.editable === false;
      const noDelete = module.deletable === false;

      tables.push({
        id: { wsId: apiName, remoteId: [apiName] },
        displayName,
        parentPath: categoryForModule(apiName),
        ...(noCreate ? { disabledCreates: true } : {}),
        ...(noUpdate ? { disabledUpdates: true } : {}),
        ...(noDelete ? { disabledDeletes: true } : {}),
        ...(noCreate || noUpdate || noDelete
          ? { disabledReason: 'Zoho reports this module as not fully writable for the API.' }
          : {}),
        metadata: { displayName, generatedType: module.generated_type },
      });
    }

    return tables;
  }

  /**
   * Build the JSON table spec for a module from its live field metadata, and
   * cache the list-safe field names for the pull path.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const moduleApiName = id.remoteId[0];
    const fields = await this.client.getFields(moduleApiName);
    this.pullFieldNamesCache.set(moduleApiName, pullFieldNamesFrom(fields));
    return buildZohoJsonTableSpec(id, moduleApiName, moduleApiName, fields);
  }

  incrementalPullSupport(
    _options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    // Optimistic when we have no schema (REST layer): nearly every Zoho record
    // module carries Modified_Time. With a schema in hand, confirm it.
    if (!tableSpec) return IncrementalPullSupport.SUPPORTED;
    const properties = (tableSpec.schema as unknown as { properties?: Record<string, unknown> }).properties;
    return properties && ZOHO_MODIFIED_TIME_FIELD in properties
      ? IncrementalPullSupport.SUPPORTED
      : IncrementalPullSupport.NOT_SUPPORTED;
  }

  /**
   * Pull records via `page_token` pagination. On an incremental run, sends
   * `If-Modified-Since` and returns the server-time high-water mark captured
   * before the first page (so anything modified mid-run is re-pulled next time).
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: ZohoDownloadProgress }) => Promise<void>,
    progress: ZohoDownloadProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const moduleApiName = tableSpec.id.remoteId[0];
    const fieldNames = await this.getPullFieldNames(moduleApiName);

    const isIncremental = options.pullMode === 'incremental' && !!options.since;
    const ifModifiedSince = isIncremental && options.since ? options.since.toISOString() : undefined;

    let pageToken = progress.pageToken;
    let watermarkFromServer: string | undefined = progress.watermark;
    let pulledCount = 0;

    while (true) {
      const page = await this.client.listRecordsPage(moduleApiName, fieldNames, { pageToken, ifModifiedSince });

      // Capture the server time of the first request as the new watermark.
      if (watermarkFromServer === undefined && page.serverDate) {
        watermarkFromServer = page.serverDate;
      }

      pulledCount += page.records.length;
      pageToken = page.nextPageToken;

      if (page.records.length > 0) {
        await callback({
          files: page.records as ConnectorFile[],
          connectorProgress: { pageToken, watermark: watermarkFromServer },
        });
      }

      if (!pageToken || !page.moreRecords) break;

      // page_token tops out at 100k records; beyond that we need Bulk Read.
      if (pulledCount >= ZOHO_PAGE_TOKEN_RECORD_CEILING) {
        throw new ZohoError(
          `Module "${moduleApiName}" exceeds the ${ZOHO_PAGE_TOKEN_RECORD_CEILING.toLocaleString()} ` +
            `page_token record limit. Bulk Read support is required to fully sync it.`,
          undefined,
          'MODULE_TOO_LARGE',
        );
      }
    }

    if (isIncremental) {
      return { newWatermark: watermarkFromServer ? new Date(watermarkFromServer) : undefined };
    }
    return {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const moduleApiName = tableSpec.id.remoteId[0];
    const fieldNames = await this.getPullFieldNames(moduleApiName);
    const BUFFER_SIZE = 50;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const record = await this.client.getRecord(moduleApiName, id, fieldNames);
      if (record) buffer.push(record as ConnectorFile);
      if (buffer.length >= BUFFER_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }
    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  getBatchSize(): number {
    return ZOHO_WRITE_BATCH_SIZE;
  }

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const moduleApiName = tableSpec.id.remoteId[0];
    const payloads = files.map((file) => sanitizeZohoWritePayload(file, tableSpec));
    const results = await this.client.createRecords(moduleApiName, payloads);
    return files.map((file, index) => {
      const assignedId = results[index]?.id;
      return assignedId !== undefined ? { ...file, id: assignedId } : file;
    });
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const moduleApiName = tableSpec.id.remoteId[0];
    const payloads = files.map((file, index) => {
      const source = changedFields?.[index] ?? file;
      const payload = sanitizeZohoWritePayload(source, tableSpec);
      payload.id = String(file.id);
      return payload;
    });
    await this.client.updateRecords(moduleApiName, payloads);
    // Read-back not yet wired; returning the sent files is the allowed placeholder.
    return files;
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const moduleApiName = tableSpec.id.remoteId[0];
    const ids = files.map((file) => String(file.id)).filter((id) => id && id !== 'undefined');
    await this.client.deleteRecords(moduleApiName, ids);
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titleColumnRemoteId?.length === 1 ? tableSpec.titleColumnRemoteId[0] : undefined;
    return suggestFileNamesFromFieldPaths(records, titlePath);
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof ZohoError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { status: error.statusCode, code: error.code, responseData: error.responseData },
      };
    }
    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;
      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'code']),
        description: error.message,
        additionalContext: { status: error.response?.status },
      };
    }
    return this.fallbackErrorDetails(error);
  }

  // --- Private helpers ---

  private async getPullFieldNames(moduleApiName: string): Promise<string[]> {
    const cached = this.pullFieldNamesCache.get(moduleApiName);
    if (cached) return cached;
    const fields = await this.client.getFields(moduleApiName);
    const names = pullFieldNamesFrom(fields);
    this.pullFieldNamesCache.set(moduleApiName, names);
    return names;
  }
}

/**
 * The field api_names safe to request in a records list call: every field
 * except subforms and multi-valued lookups, which the list endpoint doesn't
 * return (they require a single-record fetch — deferred to v1's subform work).
 * `id` is always included.
 */
function pullFieldNamesFrom(fields: ZohoFieldMetadata[]): string[] {
  const names = new Set<string>(['id']);
  for (const field of fields) {
    if (NON_LIST_DATA_TYPES.has(field.data_type)) continue;
    names.add(field.api_name);
  }
  return [...names];
}

// --- Self-registration ---

connectorRegistry.register({
  service: Service.ZOHO,
  metadata: ZohoConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // Zoho concurrency is 5–25 in-flight depending on edition; 10 req/s is safe.
  rateLimiterSpec: { points: 10, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    const credentials = ctx.decryptedCredentials;
    if (!credentials?.zohoClientId || !credentials.zohoClientSecret || !credentials.zohoRefreshToken) {
      throw new ConnectorInstantiationError(
        'Zoho CRM requires a Client ID, Client Secret, and Refresh Token',
        Service.ZOHO,
      );
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount?.id ?? 'default');
    WSLogger.info({ source: LOG_SOURCE, message: 'Instantiating Zoho connector' });
    return new ZohoConnector(
      {
        clientId: credentials.zohoClientId,
        clientSecret: credentials.zohoClientSecret,
        refreshToken: credentials.zohoRefreshToken,
        dataCenter: normalizeZohoDataCenter(credentials.zohoDataCenter),
      },
      { rateLimiter },
    );
  },
});
