/* eslint-disable @typescript-eslint/no-unused-vars */
import { ConnectorPullOptions, ConnectorSettingDefinition, TableDiscoveryMode } from '@spinner/shared-types';
import _ from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import { JsonSafeObject } from 'src/utils/objects';
import { getServiceDisplayName } from './display-names';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from './types';

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
   * List the tables available in the data source that can be used for snapshots
   * @returns A list of table previews.
   * @throws Error if the tables cannot be listed.
   */
  abstract listTables(): Promise<TablePreview[]>;

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
   * @returns A BaseJsonTableSpec containing table metadata and JSON Schema.
   */
  abstract fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec>;

  /**
   * Get a new file template for the given table spec.
   * @param tableSpec The table spec to get the new file template for.
   * @returns The new file template.
   */
  getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  /**
   * Does a full poll of target remote table and pulls all of the available records as JSON files.
   * This is the new method that uses JSON schema instead of column-based specs.
   * @param tableSpec The JSON table spec to pull records for.
   * @param callback The callback that will process batches of files as they are pulled.
   * @param progress The progress object to update with the pull progress.
   */
  abstract pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: TConnectorProgress }) => Promise<void>,
    progress: TConnectorProgress,
    options: ConnectorPullOptions,
  ): Promise<void>;

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
   * @param files - The files to update (full content).
   * @param changedFields - Optional parallel array where changedFields[i] is a deep sparse object
   *   containing only the fields that changed for files[i], with values already transformed
   *   (FK resolution, transformers, etc.). Connectors can use this directly as a partial payload
   *   or inspect its structure to decide what to update.
   *   When undefined, connectors send the full file content (backward compatible).
   * @throws Error if there is a problem updating the records.
   */
  abstract updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<void>;

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
