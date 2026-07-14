/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  ConnectorSettingDefinition,
  CreateFieldResult,
  CreateTableResult,
  DataFolderOptions,
  IncrementalPullSupport,
  SchemaCreationCapabilities,
  TableDiscoveryMode,
  TableView,
} from '@spinner/shared-types';
import _ from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import { JsonSafeObject } from 'src/utils/objects';
import { getServiceDisplayName } from './display-names';
import { NormalizedCreateFieldsPlan, NormalizedCreateTablePlan } from './schema-creation.types';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  CreateDestination,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from './types';

/**
 * Defines a utility that parses the user provided parameters for a given service into a set of credentials and extras.
 * This is usefule for services that need pre parsing of the user provided parameters for a better user experience.
 * For example: WordPress requires an endpoint and users most of the time will not have the exact one we need so we do a couple transformations to get the correct one.
 */
export abstract class AuthParser<T extends string = string> {
  abstract readonly service: T;

  /**
   * Parse the authentication credentials (apiKey, username, password, endpoint, etc.) for the service.
   * @param userProvidedParams The user provided parameters to parse.
   * @returns The parsed user provided parameters into a set of credentials and extras.
   */
  abstract parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }>;
}

/**
 * Defines a utility that abstracts the interaction with a data source.
 */
export abstract class Connector<T extends string = string, TConnectorProgress extends JsonSafeObject = JsonSafeObject> {
  abstract readonly service: T;

  /**
   * Get the display name for for the data service the connector operates on
   * @returns The display name for the connector.
   */
  static readonly displayName: string;

  /** Current connector code version. See ConnectorRegistration.version (DEV-10302). */
  static readonly version: number = 1;

  /**
   * Advanced settings that this connector exposes for per-folder configuration.
   * Connectors with custom pull options should override this with their setting definitions.
   */
  static readonly advancedSettings: ConnectorSettingDefinition[] = [];

  /**
   * The discovery mode for listing tables. Defaults to LIST.
   * Connectors with slow list APIs (e.g. Notion) should override this to SEARCH.
   */
  get tableDiscoveryMode(): TableDiscoveryMode {
    return TableDiscoveryMode.LIST;
  }

  /**
   * Whether this connector supports uploading files/assets to the remote service.
   * Connectors that support `uploadFile()` should override this to `true`.
   */
  supportsFileUpload = false;

  /**
   * Test the current state of the connection to the Datasource.
   * @throws Error if the connection is not valid.
   */
  abstract testConnection(): Promise<void>;

  /**
   * Fetch the current API quota / rate-limit state for this connector account.
   *
   * Return one of three shapes:
   *   - `{ quota: JsonSafeObject }` — raw quota data (rendered as pretty JSON).
   *   - `{ dashboardUrl: string }` — no API-level quota, but a link to the
   *     service's usage dashboard where the user can check manually.
   *   - `null` — no quota concept at all (the dialog shows a generic
   *     "unsupported" message).
   */
  getApiQuota(): Promise<{ quota: JsonSafeObject } | { dashboardUrl: string } | null> {
    return Promise.resolve(null);
  }

  /**
   * List the tables available in the data source that can be used for snapshots
   * @returns A list of table previews.
   * @throws Error if the tables cannot be listed.
   */
  abstract listTables(): Promise<TablePreview[]>;

  /**
   * List the locations where the user can create a new table on the remote
   * service — e.g. Airtable bases, Postgres schemas, Notion pages. Each entry is
   * a minimal `{ id, name }`: `id` is the remote identifier the create-table flow
   * uses as the new table's parent, `name` is the label shown in the picker.
   *
   * Optional: only connectors that support creating tables implement it. The
   * REST layer returns a `not supported` error when a connector leaves it
   * undefined.
   *
   * @returns The create destinations, unsorted (the REST layer sorts by name).
   * @throws Error if the destinations cannot be listed.
   */
  listCreateDestinations?(): Promise<CreateDestination[]>;

  /**
   * Search for tables by name. Only used when tableDiscoveryMode is SEARCH.
   * Connectors opting into SEARCH mode must override this method.
   * @param searchTerm The search term to filter tables by.
   * @returns A list of matching table previews and whether more results exist.
   */
  searchTables(searchTerm: string): Promise<{ tables: TablePreview[]; hasMore: boolean }> {
    throw new Error('searchTables is not implemented for this connector');
  }

  /**
   * Fetch the JSON Table Spec for a table directly from the remote API.
   * Returns a spec that includes metadata and a TSchema describing valid field values.
   * Uses field slugs/names as property keys in the schema.
   *
   * @param id The id of the table to fetch the JSON Table Spec for.
   * @param pendingFolderOptions Options about to be persisted on the new DataFolder
   *   row, supplied during create-folder before the row exists. Connectors that
   *   need per-folder state at spec time (e.g. GENERIC_API's probe) can use this
   *   to avoid a chicken-and-egg with the DB. Optional; most connectors ignore it.
   * @returns A BaseJsonTableSpec containing table metadata and JSON Schema.
   */
  abstract fetchJsonTableSpec(id: EntityId, pendingFolderOptions?: DataFolderOptions): Promise<BaseJsonTableSpec>;

  /**
   * Build this table's default grid view — column order/visibility, banner
   * grouping, and which column is the title — as a PURE function of the
   * already-computed {@link BaseJsonTableSpec}. Receives ONLY the spec: no raw
   * API payloads, no per-folder options, nothing that isn't already on
   * `spec.schema` (including its `x-scratch-*` annotations) or another spec
   * field (`spec.id`, `spec.titlePath`, etc.). The signature makes a non-spec
   * dependency structurally impossible, so a checked-in view can always be
   * regenerated from the schema — this is the `api → schema → view` pipeline's
   * final, drift-proof stage (the schema *describes*; the view *editorializes*).
   *
   * Editorial choices — which fields lead, which get grouped under a banner,
   * which stay hidden — are CODE in the override, keyed off `spec.id`/`spec.slug`
   * (the table/entity type), never passed-in config and never a schema
   * annotation invented just for view-building. The schema stays a faithful,
   * display-agnostic description of the API's data (Connector Prime Directive);
   * the View is where display opinions live. When the view genuinely needs a
   * value the schema doesn't already carry, add an `x-scratch-*` annotation in
   * the schema stage (a faithful fact about the data) rather than passing config.
   *
   * Called by the write sites AFTER `fetchJsonTableSpec` and after any user
   * id/name field overrides have been re-applied to `spec.idPath`/`spec.titlePath`,
   * so the rebuilt view reflects the record's actual configured title field.
   *
   * The default returns `undefined` — connectors with no curated default view
   * don't override this, and no `views/default.json` is written for them.
   *
   * @param spec The fetched (and override-adjusted) table spec.
   * @returns The default TableView, or `undefined` if this table has none.
   */
  buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return undefined;
  }

  /**
   * Get a new file template for the given table spec.
   * @param tableSpec The table spec to get the new file template for.
   * @returns The new file template.
   */
  getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  /**
   * Whether this connector can answer "what changed since X?" for a given folder.
   * The default returns `false` — connectors whose remote API supports a modified-since
   * (or change-token) endpoint override this to return `true`. Connectors may inspect
   * per-folder configuration (e.g. a user-declared `modifiedAtField` on `options`) or
   * the table schema (e.g. an auto-detected last-modified field annotated with
   * `X_SCRATCH_LAST_MODIFIED_FIELD`), which is why both `options` and `tableSpec` are
   * passed in.
   *
   * The job consults this flag before issuing an incremental pull; folders backed by
   * connectors that return `false` are silently demoted to a full scan.
   */
  supportsIncrementalPull(options: PullRecordFilesOptions, tableSpec: BaseJsonTableSpec): boolean {
    return this.incrementalPullSupport(options, tableSpec) === IncrementalPullSupport.SUPPORTED;
  }

  /**
   * The three-state version of {@link supportsIncrementalPull} — distinguishes a
   * connector/table that fundamentally can't do incremental pulls
   * (`NOT_SUPPORTED`) from one that could once the user configures a
   * last-modified field (`NEEDS_CONFIGURATION`). This is the single source of
   * truth: `supportsIncrementalPull` is derived from it.
   *
   * The default returns `NOT_SUPPORTED`. Connectors that implement the
   * incremental-pull contract override this. `tableSpec` may be `null` when the
   * caller has no schema on hand (e.g. the REST layer computing the value for a
   * folder that has never been pulled); connectors that auto-detect a
   * last-modified field from the schema should treat a `null` spec as
   * "not configured yet" and return `NEEDS_CONFIGURATION`.
   */
  incrementalPullSupport(options: PullRecordFilesOptions, tableSpec: BaseJsonTableSpec | null): IncrementalPullSupport {
    return IncrementalPullSupport.NOT_SUPPORTED;
  }

  /**
   * Pull records for a table.
   *
   * `options` is a {@link PullRecordFilesOptions}: every persisted
   * `DataFolderOptions` field (filter, readOnly, connector-specific extras)
   * plus the runtime additions set by the job:
   *   - `pullMode === 'full'` (default if absent): full scan, existing behavior.
   *     The connector should ignore `since`/`cursor`.
   *   - `pullMode === 'incremental'`: pull only records changed since
   *     `options.since` (or after the opaque `options.cursor` if the connector
   *     uses tokens). Only invoked when `supportsIncrementalPull(options)`
   *     returns true.
   *
   * For incremental runs the connector returns the new high-water mark and/or
   * cursor for the job to persist. For full runs the connector returns an empty
   * result (`{}`).
   *
   * @param tableSpec The JSON table spec to pull records for.
   * @param callback The callback that will process batches of files as they are pulled.
   * @param progress The progress object to update with the pull progress.
   * @param options Persisted folder options plus runtime pull-mode/since/cursor fields.
   */
  abstract pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: TConnectorProgress }) => Promise<void>,
    progress: TConnectorProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult>;

  /**
   * Fetch specific records by their IDs from the remote service.
   * Uses bulk API endpoints where supported, falling back to individual fetches otherwise.
   * Records that cannot be found (e.g. deleted/404) are silently skipped.
   *
   * @param tableSpec The JSON table spec for the target table.
   * @param ids Array of record IDs to fetch.
   * @param callback Receives batches of fetched files, same pattern as pullRecordFiles.
   */
  abstract pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void>;

  /**
   * Validate files against the table schema before publishing.
   * This is an optional method that connectors can override to provide custom validation logic.
   * By default, returns undefined to indicate that the connector does not support validation.
   *
   * @param tableSpec - The table spec to validate files against.
   * @param files - Array of files to validate, each containing filename, optional id, and data as key-value pairs.
   * @returns Array of validation results, each containing the original file data plus a publishable boolean,
   *          or undefined if the connector does not support validation.
   */
  validateFiles?(
    tableSpec: BaseJsonTableSpec,
    files: { filename: string; id?: string; data: Record<string, unknown> }[],
  ): Promise<
    { filename: string; id?: string; data: Record<string, unknown>; publishable: boolean; errors?: string[] }[]
  >;

  /**
   * Whether the connector supports filter expressions for pulling records.
   */
  supportsFilters(): boolean {
    return false;
  }

  /**
   * Whether the connector supports field/column selection when adding tables.
   */
  supportsFieldSelection(): boolean {
    return false;
  }

  /**
   * Whether this connector can create new tables/fields on the remote service
   * (the create-schema API, DEV-10378). Defaults to `false`; connectors that
   * implement `createTable`/`createFields` override this to `true`. The
   * create-schema endpoints return a `not_supported` result when this is false.
   */
  supportsSchemaCreation(): boolean {
    return false;
  }

  /**
   * Declarative, connector-agnostic description of what this connector can
   * create — which logical field kinds it supports, whether it mandates a
   * primary/title field (Notion, Webflow), and any name-length limits. The
   * generic create-schema validator consumes this to fail fast, so a connector's
   * rules live here rather than being hardcoded in the server or any frontend.
   *
   * Optional: connectors that support schema creation should implement it;
   * `undefined` means "no extra declared constraints beyond the generic ones".
   */
  getSchemaCreationCapabilities?(): SchemaCreationCapabilities;

  /**
   * Create one table and its fields on the remote service. The connector decides
   * internally whether its API creates the table and fields in a single call or
   * in multiple calls. ForeignKey targets in `plan.fields` are already resolved
   * to concrete remote table ids by the server; `plan.deferredFkFields` (cyclic
   * cross-table FKs) are NOT created here — the server adds them via
   * {@link createFields} once every table exists.
   *
   * Optional; the default throws. Implement alongside `supportsSchemaCreation()`.
   */
  createTable?(plan: NormalizedCreateTablePlan): Promise<CreateTableResult>;

  /**
   * Add fields to an existing remote table. Also used for the deferred cyclic-FK
   * pass after all tables in a multi-table create have been created.
   *
   * Optional; the default throws. Implement alongside `supportsSchemaCreation()`.
   */
  createFields?(plan: NormalizedCreateFieldsPlan): Promise<CreateFieldResult[]>;

  /**
   * Get the batch size for a given operation.
   * @param operation The operation to get the batch size for.
   * @returns The batch size for the given operation. Must be a value greater than 0.
   */
  abstract getBatchSize(operation: 'create' | 'update' | 'delete'): number;

  /**
   * Attempts to push creates to the data source.
   * @param tableSpec - The table spec to create records for.
   * @param files - The files to create.
   * @throws Error if there is a problem creating the records.
   */
  abstract createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]>;

  /**
   * Attempts to push updates to the data source.
   * @param tableSpec - The table spec to update records for.
   * @param files - The files to update (full content, used for ID extraction and any
   *   fields the connector needs beyond the changed set — e.g. record IDs in path params).
   * @param changedFields - Parallel array where changedFields[i] is a deep sparse object
   *   containing only the fields that changed for files[i], with values already transformed
   *   (FK resolution, transformers, etc.). Connectors should send this as the partial
   *   payload so unchanged fields (especially computed/read-only ones) are not re-sent.
   * @returns The persisted records as the remote service actually stored them — preserving
   *   trigger-set timestamps, server-normalized values, computed columns, and native PK
   *   types. Should be parallel to `files` with the same length and ordering when possible
   *   (callers that pair results to inputs by index). Until the `UPDATE_RECORDS_RETURNS_REMOTE_DATA`
   *   flag is wired through to the caller, connectors that don't yet have read-back support
   *   are allowed to return `files` (the sent payload) as a placeholder — the caller still
   *   uses the sent payload in that case.
   * @throws Error if there is a problem updating the records.
   */
  abstract updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]>;

  /**
   * Delete records from the data source
   * @param tableSpec - The table spec to delete records from.
   * @param files - The files to delete.
   * @throws Error if there is a problem deleting the records.
   */
  abstract deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void>;

  /**
   * Extract asset metadata from a record's content and schema.
   * Connectors with asset fields should override this to handle their service-specific
   * data shapes (e.g. Notion property wrappers, Wix richContent blocks).
   *
   * The default implementation returns an empty array (no assets).
   *
   * @param input - The record content, schema, and optional record remote ID.
   * @returns Array of extracted asset results.
   */
  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    return [];
  }

  /**
   * Resolves an asset reference for use in a record field during publish.
   *
   * Different connectors need different formats:
   * - Most connectors accept a URL string (Webflow, Airtable, Wix, HubSpot, etc.)
   * - WordPress needs an integer media ID (uploaded separately)
   * - Notion needs a nested object `{ type: 'external', external: { url } }`
   *
   * The default implementation returns the best available URL.
   * Connectors with non-URL asset references should override this method.
   *
   * @param asset - The asset metadata from the Asset table.
   * @returns The value to write into the record field.
   */
  resolveAssetReference(asset: { remoteAssetId: string; rehostedUrl: string | null; url: string | null }): unknown {
    return asset.rehostedUrl ?? asset.url;
  }

  /**
   * Upload a file to the remote service and return asset metadata.
   * Not all connectors support file uploads — the default implementation throws.
   *
   * @param buffer - The raw file contents.
   * @param filename - The name of the file (e.g. "photo.jpg").
   * @param mimeType - The MIME type of the file (e.g. "image/jpeg").
   * @param metadata - Optional service-specific metadata to include with the upload.
   * @returns Asset metadata describing the uploaded file.
   */
  uploadFile(
    buffer: Buffer,
    filename: string,
    mimeType: string,
    metadata?: Record<string, unknown>,
  ): Promise<ConnectorAssetResult> {
    throw new Error('uploadFile is not implemented for this connector');
  }

  /**
   * Suggest human-friendly filenames for pulled records.
   * Returns an array parallel to `records` where each element is either a suggested
   * filename string (without extension) or undefined to fall back to the record's ID.
   * These suggestions are only used for initial naming — once set, filenames don't change.
   */
  abstract getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[];

  /**
   * Evaluate the error object in the context of the connector and return some standardised error details that can be return to a user or logged.
   * @param error - The error to evaluate.
   * @returns The connector error details.
   */
  abstract extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails;

  /**
   * Default fallback error details that always includes the actual error message.
   * Connectors should call this as their final fallback in extractConnectorErrorDetails.
   */
  protected fallbackErrorDetails(error: unknown): ConnectorErrorDetails {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const serviceName = getServiceDisplayName(this.service);
    return {
      userFriendlyMessage: `${serviceName} error: ${errorMessage}`,
      description: errorMessage,
      ...(error instanceof Error && {
        additionalContext: {
          errorName: error.name,
          stack: error.stack,
          ...(error.cause !== undefined && {
            cause:
              error.cause instanceof Error
                ? { name: error.cause.name, message: error.cause.message }
                : JSON.stringify(error.cause),
          }),
        },
      }),
    };
  }
}

/**
 * Helper for connectors with simple record structures.
 * Tries each lodash dot-path in order, returning the first non-empty string value found.
 * Connectors with complex record structures (e.g. Notion rich text) should implement
 * getSuggestedRecordFileNames directly instead of using this helper.
 */
export function suggestFileNamesFromFieldPaths(
  records: ConnectorFile[],
  ...fieldPaths: (string | undefined)[]
): (string | undefined)[] {
  const paths = fieldPaths.filter((p): p is string => !!p);
  if (paths.length === 0) {
    return records.map(() => undefined);
  }
  return records.map((record) => {
    for (const path of paths) {
      const value = _.get(record, path);
      if (typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
  });
}
