import { ConnectorErrorCode, connectorMetadata, IncrementalPullSupport, TableView } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { chunk } from 'lodash';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError, ErrorMessageTemplates, extractCommonDetailsFromAxiosError } from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  findLastModifiedFieldName,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  readRecordIdAsString,
  TablePreview,
} from '../../types';
import {
  SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS,
  SalesforceApiClient,
  SalesforceApiError,
  salesforceErrorsFromAxiosError,
  SalesforceReportedError,
} from './salesforce-api-client';
import { buildSalesforceDefaultView } from './salesforce-default-view';
import { salesforceModifiedSinceWithClockSkewMargin } from './salesforce-incremental';
import {
  buildSalesforceJsonTableSpec,
  SALESFORCE_RECORD_ID_FIELD,
  salesforcePullFieldApiNames,
  salesforceTableWsId,
} from './salesforce-json-schema';
import { SALESFORCE_LOGO_DATA_URI } from './salesforce-logo';
import {
  buildSelectEveryFieldQuery,
  fieldIsAfterInstantPredicate,
  isSalesforceRecordId,
  recordIdIsAfterPredicate,
  recordIdIsOneOfPredicate,
} from './salesforce-soql';
import {
  parseSalesforceInstanceUrl,
  SalesforceDownloadProgress,
  SalesforceQueryResponse,
  SalesforceRecord,
  SalesforceSaveResult,
  SalesforceSObjectSummary,
} from './salesforce-types';
import {
  buildSalesforceCreateRecordBody,
  buildSalesforceUpdateRecordBodyFromChangedFields,
  buildSalesforceUpdateRecordBodyFromFullRecord,
} from './salesforce-write-payload';

const LOG_SOURCE = 'SalesforceConnector';

/**
 * Objects Salesforce refuses to query unless the query filters on a parent record ("Implementation restriction:
 * ContentDocumentLink requires a filter by a single Id on ContentDocumentId or LinkedEntityId…"), so the whole
 * object can never be pulled. Measured against every queryable, user-facing object of a Developer Edition org.
 */
const SALESFORCE_OBJECTS_QUERYABLE_ONLY_BY_PARENT = new Set(['ContentDocumentLink', 'ContentFolderItem']);

/**
 * The objects a CRM user reaches for first. Listed in their own group ahead of the rest of the org's catalog,
 * which runs to hundreds of standard objects. Grouping only: every listed object is available either way.
 */
const SALESFORCE_CORE_CRM_OBJECT_API_NAMES = new Set([
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'OpportunityLineItem',
  'OpportunityContactRole',
  'Campaign',
  'CampaignMember',
  'Case',
  'Task',
  'Event',
  'User',
  'Product2',
  'Pricebook2',
  'PricebookEntry',
  'Contract',
  'Order',
  'OrderItem',
  'Quote',
  'QuoteLineItem',
  'Asset',
  'Note',
]);

const CORE_CRM_OBJECTS_GROUP = 'Core CRM objects';
const CUSTOM_OBJECTS_GROUP = 'Custom objects';
const OTHER_STANDARD_OBJECTS_GROUP = 'Other standard objects';
const TABLE_GROUP_ORDER = [CORE_CRM_OBJECTS_GROUP, CUSTOM_OBJECTS_GROUP, OTHER_STANDARD_OBJECTS_GROUP];

/**
 * The suffix of an org's own record objects (custom objects and custom settings, managed-package ones included).
 * The catalog also flags as `custom` each custom object's system companions (`__Share`, `__History`, `__Feed`,
 * `__ChangeEvent`) and other custom kinds whose SOQL support is too narrow for a whole-object pull: big objects
 * (`__b`, queryable only on their index fields), external objects (`__x`, proxies of another system), platform
 * events (`__e`) and custom metadata types (`__mdt`).
 */
const CUSTOM_RECORD_OBJECT_SUFFIX = '__c';

/**
 * Save-result codes that mean a record being deleted is already gone. A delete is meant to make the record not
 * exist, so these count as success: the record was deleted remotely, or a previous attempt of this same publish
 * deleted it before failing on another record.
 */
const SALESFORCE_ALREADY_DELETED_STATUS_CODES = new Set([
  'ENTITY_IS_DELETED',
  'INVALID_CROSS_REFERENCE_KEY',
  'NOT_FOUND',
]);

/** Codes meaning the record a call targeted no longer exists. */
const SALESFORCE_RECORD_GONE_STATUS_CODES = new Set(['ENTITY_IS_DELETED', 'NOT_FOUND']);

/** Placeholder code Salesforce reports for every record an all-or-none request rolled back because another failed. */
const SALESFORCE_ROLLED_BACK_STATUS_CODE = 'ALL_OR_NONE_OPERATION_ROLLED_BACK';

/** Which objects appear in the table picker: anything the API can read in full, minus deprecated objects. */
function isListableSalesforceObject(sObjectSummary: SalesforceSObjectSummary): boolean {
  if (!sObjectSummary.queryable || !sObjectSummary.retrieveable || sObjectSummary.deprecatedAndHidden) {
    return false;
  }
  if (sObjectSummary.custom) {
    return sObjectSummary.name.endsWith(CUSTOM_RECORD_OBJECT_SUFFIX);
  }
  // `layoutable` marks the user-facing standard objects (those with page layouts), which keeps the org's ~1,000
  // queryable system objects — feeds, histories, shares, setup metadata — out of the picker.
  return sObjectSummary.layoutable || SALESFORCE_CORE_CRM_OBJECT_API_NAMES.has(sObjectSummary.name);
}

function tableGroupOfSalesforceObject(sObjectSummary: SalesforceSObjectSummary): string {
  if (SALESFORCE_CORE_CRM_OBJECT_API_NAMES.has(sObjectSummary.name)) return CORE_CRM_OBJECTS_GROUP;
  if (sObjectSummary.custom) return CUSTOM_OBJECTS_GROUP;
  return OTHER_STANDARD_OBJECTS_GROUP;
}

function tablePreviewOfSalesforceObject(sObjectSummary: SalesforceSObjectSummary): TablePreview {
  const tablePreview: TablePreview = {
    id: { wsId: salesforceTableWsId(sObjectSummary.name), remoteId: [sObjectSummary.name] },
    displayName: sObjectSummary.labelPlural || sObjectSummary.label || sObjectSummary.name,
    parentPath: tableGroupOfSalesforceObject(sObjectSummary),
    metadata: { objectApiName: sObjectSummary.name },
  };
  if (SALESFORCE_OBJECTS_QUERYABLE_ONLY_BY_PARENT.has(sObjectSummary.name)) {
    tablePreview.disabled = true;
    tablePreview.disabledReason = `Salesforce only returns ${tablePreview.displayName} for one parent record at a time, so the object can't be downloaded as a whole.`;
    return tablePreview;
  }
  const unsupportedWriteOperations: string[] = [];
  if (!sObjectSummary.createable) {
    tablePreview.disabledCreates = true;
    unsupportedWriteOperations.push('creating');
  }
  if (!sObjectSummary.updateable) {
    tablePreview.disabledUpdates = true;
    unsupportedWriteOperations.push('editing');
  }
  if (!sObjectSummary.deletable) {
    tablePreview.disabledDeletes = true;
    unsupportedWriteOperations.push('deleting');
  }
  if (unsupportedWriteOperations.length > 0) {
    tablePreview.disabledReason = `Salesforce doesn't allow ${unsupportedWriteOperations.join(', ')} ${tablePreview.displayName} records for this connection.`;
  }
  return tablePreview;
}

/** Incremental pulls filter on the field the schema annotates as last-modified (`SystemModstamp`). */
function salesforceIncrementalPullSupport(tableSpec: BaseJsonTableSpec | null): IncrementalPullSupport {
  // With no schema on hand, be optimistic: nearly every Salesforce object carries SystemModstamp.
  if (!tableSpec) return IncrementalPullSupport.SUPPORTED;
  return findLastModifiedFieldName(tableSpec) !== undefined
    ? IncrementalPullSupport.SUPPORTED
    : IncrementalPullSupport.NOT_SUPPORTED;
}

/**
 * The errors that made a collection request fail, each prefixed with which record it was (when the request had more
 * than one). `isFailedSaveResult` decides which results count; an all-or-none request's rolled-back placeholders never
 * do, since they only echo another record's failure.
 */
function describeFailedSaveResults(
  saveResults: SalesforceSaveResult[],
  labelOfRecordAt: (recordIndex: number) => string,
  isFailedSaveResult: (saveResult: SalesforceSaveResult) => boolean = (saveResult) => !saveResult.success,
): {
  message: string;
  reportedErrors: SalesforceReportedError[];
} {
  const reportedErrors: SalesforceReportedError[] = [];
  const failureDescriptions: string[] = [];
  saveResults.forEach((saveResult, recordIndex) => {
    if (!isFailedSaveResult(saveResult)) return;
    const causingErrors = saveResult.errors.filter((error) => error.statusCode !== SALESFORCE_ROLLED_BACK_STATUS_CODE);
    if (causingErrors.length === 0) return;
    for (const causingError of causingErrors) {
      reportedErrors.push({
        code: causingError.statusCode,
        message: causingError.message,
        fields: causingError.fields,
      });
    }
    const causingErrorMessages = causingErrors.map((error) => error.message).join(' • ');
    failureDescriptions.push(
      saveResults.length > 1 ? `${labelOfRecordAt(recordIndex)}: ${causingErrorMessages}` : causingErrorMessages,
    );
  });
  return { message: failureDescriptions.join('; '), reportedErrors };
}

/** Throw when an all-or-none collection request failed. Every record rolls back together, so nothing was saved. */
function throwIfCollectionRequestFailed(saveResults: SalesforceSaveResult[], expectedResultCount: number): void {
  if (saveResults.length !== expectedResultCount) {
    throw new Error(`Salesforce returned ${saveResults.length} results for ${expectedResultCount} records`);
  }
  if (saveResults.every((saveResult) => saveResult.success)) return;
  const { message, reportedErrors } = describeFailedSaveResults(
    saveResults,
    (recordIndex) => `Record ${recordIndex + 1}`,
  );
  throw new SalesforceApiError(message || 'Salesforce rejected the batch without saying why', reportedErrors);
}

/**
 * Connector for Salesforce.
 *
 * Dynamic discovery: objects (tables) come from the org's `/sobjects` catalog and each object's schema from its
 * live describe, so standard objects, custom objects, and custom fields all surface with no connector change.
 * Records are stored exactly as SOQL returns them (`attributes` + every describe field), queried in `Id` order
 * so a stalled pull resumes after the last record it delivered. Writes go through sObject Collections, 200
 * records per request, all-or-none.
 */
export class SalesforceConnector extends Connector<string, SalesforceDownloadProgress> {
  readonly service = Service.SALESFORCE;
  static readonly displayName = 'Salesforce';
  static readonly metadata = connectorMetadata({
    displayName: 'Salesforce',
    table: 'object',
    tables: 'objects',
    base: 'org',
    bases: 'orgs',
    logo: SALESFORCE_LOGO_DATA_URI,
    // Hidden until the OAuth app is wired in each environment and the connector has been QA'd end to end.
    visible: false,
    incrementalPull: true,
    oauth: { label: 'Connect with Salesforce' },
    credentialFields: {
      oauth: [
        {
          key: 'salesforceSandbox',
          type: 'boolean',
          label: 'Sandbox org',
          description: 'Sign in at test.salesforce.com. Leave unchecked for production and Developer Edition orgs.',
          required: false,
        },
      ],
    },
  });

  private readonly client: SalesforceApiClient;

  /** Field API names to select per object, filled by `fetchJsonTableSpec` so a pull right after doesn't describe twice. */
  private readonly pullFieldApiNamesByObjectApiName = new Map<string, string[]>();

  constructor(
    private readonly instanceUrl: string,
    accessTokenOrProvider: ConnectorAuthTokenOrProvider,
    opts?: { rateLimiter?: RateLimiter },
  ) {
    super();
    this.client = new SalesforceApiClient(instanceUrl, accessTokenOrProvider, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.listApiResources();
  }

  async getApiQuota(): Promise<{ quota: JsonSafeObject }> {
    const orgLimits = await this.client.getOrgLimits();
    return { quota: orgLimits as JsonSafeObject };
  }

  async listTables(): Promise<TablePreview[]> {
    const sObjectSummaries = await this.client.listSObjects();
    return sObjectSummaries
      .filter(isListableSalesforceObject)
      .map(tablePreviewOfSalesforceObject)
      .sort(
        (a, b) =>
          TABLE_GROUP_ORDER.indexOf(a.parentPath ?? '') - TABLE_GROUP_ORDER.indexOf(b.parentPath ?? '') ||
          a.displayName.localeCompare(b.displayName),
      );
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const objectApiName = id.remoteId[0];
    const describe = await this.client.describeSObject(objectApiName);
    this.pullFieldApiNamesByObjectApiName.set(objectApiName, salesforcePullFieldApiNames(describe));
    return buildSalesforceJsonTableSpec(id, describe, this.instanceUrl);
  }

  override buildDefaultView(spec: BaseJsonTableSpec): TableView {
    return buildSalesforceDefaultView(spec);
  }

  incrementalPullSupport(
    _options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return salesforceIncrementalPullSupport(tableSpec);
  }

  /**
   * Pull every record of an object (or, incrementally, every record modified since the last run) in `Id` order,
   * one callback per batch Salesforce returns (up to 2,000 records).
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: SalesforceDownloadProgress }) => Promise<void>,
    progress: SalesforceDownloadProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const objectApiName = tableSpec.id.remoteId[0];
    // Captured before the first request (or carried over from the run this one resumes) so anything modified
    // while the pull runs is pulled again next time rather than skipped.
    const pullWatermark = progress.pullWatermark ?? new Date().toISOString();
    const isIncrementalPull = options.pullMode === 'incremental' && !!options.since;

    const wherePredicates: string[] = [];
    if (isIncrementalPull && options.since) {
      const lastModifiedFieldApiName = findLastModifiedFieldName(tableSpec);
      if (!lastModifiedFieldApiName) {
        throw new Error(`${tableSpec.name} has no last-modified field to pull incrementally`);
      }
      wherePredicates.push(
        fieldIsAfterInstantPredicate(
          lastModifiedFieldApiName,
          salesforceModifiedSinceWithClockSkewMargin(options.since),
        ),
      );
    }
    if (progress.lastPulledRecordId) {
      wherePredicates.push(recordIdIsAfterPredicate(progress.lastPulledRecordId));
    }

    const soql = buildSelectEveryFieldQuery({
      objectApiName,
      fieldApiNames: await this.getPullFieldApiNames(objectApiName),
      wherePredicates,
      orderByRecordId: true,
    });

    let queryBatch: SalesforceQueryResponse = await this.client.query(soql);
    for (;;) {
      const records = queryBatch.records;
      if (records.length > 0) {
        await callback({
          files: records as ConnectorFile[],
          connectorProgress: { lastPulledRecordId: records[records.length - 1].Id, pullWatermark },
        });
      }
      if (queryBatch.done || !queryBatch.nextRecordsUrl) break;
      queryBatch = await this.client.queryMore(queryBatch.nextRecordsUrl);
    }

    return isIncrementalPull ? { newWatermark: new Date(pullWatermark) } : {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const recordsById = await this.queryRecordsById(tableSpec, ids);
    if (recordsById.size > 0) {
      await callback({ files: [...recordsById.values()] as ConnectorFile[] });
    }
  }

  getBatchSize(): number {
    return SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS;
  }

  /**
   * Create a batch in one all-or-none request, then read the created records back so each returned file is the
   * record as Salesforce stored it (defaults, formulas, audit fields included). A failed batch created nothing,
   * so the publish runner's one-record-at-a-time retry can't duplicate anything.
   *
   * Once the create has succeeded nothing may throw: the runner would treat the batch as not created and create
   * every record again. So a failed read-back returns the sent files with their new ids instead; the next pull
   * fills in the rest.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const createBodies = files.map((file) => buildSalesforceCreateRecordBody(file, tableSpec));
    const saveResults = await this.client.createRecords(createBodies);
    throwIfCollectionRequestFailed(saveResults, files.length);

    const createdRecordIds = saveResults.map((saveResult) => saveResult.id ?? '');
    let createdRecordsById = new Map<string, SalesforceRecord>();
    try {
      createdRecordsById = await this.queryRecordsById(tableSpec, createdRecordIds);
    } catch (error) {
      // Only the message: an AxiosError carries the request's Authorization header.
      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Read-back after creating ${createdRecordIds.length} ${tableSpec.name} records failed; returning the sent records with their new ids`,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    return createdRecordIds.map(
      (createdRecordId, fileIndex) =>
        (createdRecordsById.get(createdRecordId) as ConnectorFile | undefined) ?? {
          ...files[fileIndex],
          [SALESFORCE_RECORD_ID_FIELD]: createdRecordId,
        },
    );
  }

  /**
   * Update a batch with only each record's changed fields, in one all-or-none request, then read the records back.
   * A changed field Salesforce won't accept on update (read-only or set-on-create-only) fails the record with a
   * clear error instead of being dropped.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const recordIds = files.map((file) => {
      const recordId = readRecordIdAsString(file, tableSpec.idPath);
      if (!recordId) {
        throw new Error(`Cannot update a ${tableSpec.name} record that has no Salesforce record id`);
      }
      return recordId;
    });
    const updateBodies = files.map((file, fileIndex) => {
      const changedFieldsOfRecord = changedFields?.[fileIndex] as Record<string, unknown> | undefined;
      return changedFieldsOfRecord
        ? buildSalesforceUpdateRecordBodyFromChangedFields(recordIds[fileIndex], changedFieldsOfRecord, tableSpec)
        : buildSalesforceUpdateRecordBodyFromFullRecord(recordIds[fileIndex], file, tableSpec);
    });
    // `attributes` and `id` are always present; a body with nothing else has no change to send.
    const updateBodiesWithChanges = updateBodies.filter((updateBody) => Object.keys(updateBody).length > 2);
    if (updateBodiesWithChanges.length > 0) {
      const saveResults = await this.client.updateRecords(updateBodiesWithChanges);
      throwIfCollectionRequestFailed(saveResults, updateBodiesWithChanges.length);
    }

    const updatedRecordsById = await this.queryRecordsById(tableSpec, recordIds);
    return files.map(
      (file, fileIndex) => (updatedRecordsById.get(recordIds[fileIndex]) as ConnectorFile | undefined) ?? file,
    );
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const recordIds = files
      .map((file) => readRecordIdAsString(file, tableSpec.idPath))
      .filter((recordId): recordId is string => !!recordId);
    for (const recordIdsOfOneRequest of chunk(recordIds, SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS)) {
      const saveResults = await this.client.deleteRecords(recordIdsOfOneRequest);
      const isRefusedDelete = (saveResult: SalesforceSaveResult): boolean =>
        !saveResult.success &&
        !saveResult.errors.every((error) => SALESFORCE_ALREADY_DELETED_STATUS_CODES.has(error.statusCode));
      if (saveResults.some(isRefusedDelete)) {
        const { message, reportedErrors } = describeFailedSaveResults(
          saveResults,
          (recordIndex) => `Record ${recordIdsOfOneRequest[recordIndex]}`,
          isRefusedDelete,
        );
        throw new SalesforceApiError(message, reportedErrors);
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.titlePath);
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof SalesforceApiError) {
      const targetRecordIsGone = error.reportedErrors.some((reportedError) =>
        SALESFORCE_RECORD_GONE_STATUS_CODES.has(reportedError.code),
      );
      return {
        userFriendlyMessage: `Salesforce error: ${error.message}`,
        description: error.message,
        additionalContext: { reportedErrors: error.reportedErrors, httpStatus: error.httpStatus },
        ...(targetRecordIsGone ? { errorCode: ConnectorErrorCode.RemoteRecordNotFound } : {}),
      };
    }
    if (isAxiosError(error)) {
      const reportedErrors = salesforceErrorsFromAxiosError(error);
      // The daily API request limit arrives as a 403, which would otherwise read as a permissions problem.
      const dailyRequestLimitReached = reportedErrors.some(
        (reportedError) =>
          reportedError.code === 'REQUEST_LIMIT_EXCEEDED' && !/concurrent/i.test(reportedError.message),
      );
      if (dailyRequestLimitReached) {
        return {
          userFriendlyMessage: `${ErrorMessageTemplates.API_QUOTA_EXCEEDED('Salesforce')} ${reportedErrors[0].message}`,
          description: reportedErrors[0].message,
          additionalContext: { status: error.response?.status, reportedErrors },
        };
      }
      const commonErrorDetails = extractCommonDetailsFromAxiosError(this, error);
      if (commonErrorDetails) return commonErrorDetails;
      const message =
        reportedErrors.map((reportedError) => reportedError.message).join(' • ') ||
        error.response?.statusText ||
        error.message;
      return {
        userFriendlyMessage: `Salesforce error: ${message}`,
        description: message,
        additionalContext: { status: error.response?.status, reportedErrors },
        ...(reportedErrors.some((reportedError) => SALESFORCE_RECORD_GONE_STATUS_CODES.has(reportedError.code))
          ? { errorCode: ConnectorErrorCode.RemoteRecordNotFound }
          : {}),
      };
    }
    return this.fallbackErrorDetails(error);
  }

  /** Query records by id, 200 per query, keyed by id. Ids Salesforce doesn't return (deleted) are absent. */
  private async queryRecordsById(
    tableSpec: BaseJsonTableSpec,
    recordIds: string[],
  ): Promise<Map<string, SalesforceRecord>> {
    const objectApiName = tableSpec.id.remoteId[0];
    const uniqueValidRecordIds = [...new Set(recordIds)].filter((recordId) => {
      if (isSalesforceRecordId(recordId)) return true;
      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Skipping invalid Salesforce record id "${recordId}"`,
        objectApiName,
      });
      return false;
    });
    const recordsById = new Map<string, SalesforceRecord>();
    const fieldApiNames = uniqueValidRecordIds.length > 0 ? await this.getPullFieldApiNames(objectApiName) : [];
    for (const recordIdsOfOneQuery of chunk(uniqueValidRecordIds, SALESFORCE_SOBJECT_COLLECTION_MAX_RECORDS)) {
      const soql = buildSelectEveryFieldQuery({
        objectApiName,
        fieldApiNames,
        wherePredicates: [recordIdIsOneOfPredicate(recordIdsOfOneQuery)],
        orderByRecordId: false,
      });
      let queryBatch = await this.client.query(soql);
      for (;;) {
        for (const record of queryBatch.records) {
          if (record.Id) recordsById.set(record.Id, record);
        }
        if (queryBatch.done || !queryBatch.nextRecordsUrl) break;
        queryBatch = await this.client.queryMore(queryBatch.nextRecordsUrl);
      }
    }
    return recordsById;
  }

  private async getPullFieldApiNames(objectApiName: string): Promise<string[]> {
    const cachedFieldApiNames = this.pullFieldApiNamesByObjectApiName.get(objectApiName);
    if (cachedFieldApiNames) return cachedFieldApiNames;
    const fieldApiNames = salesforcePullFieldApiNames(await this.client.describeSObject(objectApiName));
    this.pullFieldApiNamesByObjectApiName.set(objectApiName, fieldApiNames);
    return fieldApiNames;
  }
}

// --- Self-registration ---

connectorRegistry.register({
  service: Service.SALESFORCE,
  metadata: SalesforceConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['oauth'],
  // Salesforce meters requests per day, not per second; this only keeps one connection from bursting.
  rateLimiterSpec: { points: 25, duration: 1 },
  resolveIncrementalPullSupport: ({ tableSpec }) => salesforceIncrementalPullSupport(tableSpec),
  incrementalPullAutoDetectsFromSchema: true,
  async createConnector(ctx) {
    if (ctx.connectorAccount?.authType !== 'OAUTH') {
      throw new ConnectorInstantiationError('Salesforce connections must be made with OAuth', Service.SALESFORCE);
    }
    let instanceUrl: string;
    try {
      // The org's API host, from the token response — persisted at connect time in oauthWorkspaceId.
      instanceUrl = parseSalesforceInstanceUrl(ctx.decryptedCredentials?.oauthWorkspaceId);
    } catch (error) {
      throw new ConnectorInstantiationError(
        'This Salesforce connection is missing its org address. Reconnect it to continue.',
        Service.SALESFORCE,
        error instanceof Error ? error : undefined,
      );
    }
    const accessTokenProvider = ctx.createOAuthAccessTokenProvider(ctx.connectorAccount.id);
    // Resolve once up front so a connection that can no longer mint a token fails here rather than on the first
    // API call; every later call re-resolves it.
    await accessTokenProvider();
    return new SalesforceConnector(instanceUrl, accessTokenProvider, {
      rateLimiter: ctx.createRateLimiter(ctx.connectorAccount.id),
    });
  },
});
