import { DataFolderId, Service, TransformerOptions, TransformerType } from '@spinner/shared-types';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';

export type SyncPhase = 'DATA' | 'FOREIGN_KEY_MAPPING';

/**
 * A record used within the sync subsystem.
 * Parsed from JSON files and re-serialized the same way.
 */
export interface SyncRecord {
  id: string;
  filePath: string;
  fields: Record<string, unknown>;
}

/**
 * Result of resolving a source FK to a destination mapping.
 */
export interface FkMappingResult {
  destinationFilePath: string;
  destinationRemoteId: string | null;
}

/**
 * Result of resolving a source asset to a destination asset mapping.
 */
export interface AssetMappingResult {
  /** The Asset DB id (cuid) of the destination asset */
  destinationAssetId: string;
  /** The remoteAssetId of the destination asset */
  destinationAssetRemoteId: string;
  /** Whether this destination asset was just created (true) or already existed (false) */
  isNew: boolean;
}

/**
 * Tools for looking up related records during transformation.
 * These are used by FK-based transformers to resolve relationships.
 */
export interface LookupTools {
  /**
   * Gets the destination file path and remote ID for a source foreign key value.
   * Uses SyncRemoteIdMapping to find the corresponding destination record.
   *
   * @param sourceFkValue - The foreign key value from the source record
   * @param referencedDataFolderId - The DataFolder that contains the referenced records
   * @returns The destination mapping, or null if not found
   */
  getDestinationMappingForSourceFk(
    sourceFkValue: string,
    referencedDataFolderId: DataFolderId,
  ): Promise<FkMappingResult | null>;

  /**
   * Looks up a field value from a record referenced by a foreign key.
   * Uses SyncForeignKeyRecord cache or fetches the record if needed.
   *
   * @param sourceFkValue - The foreign key value from the source record
   * @param referencedDataFolderId - The DataFolder that contains the referenced records
   * @param fieldPath - Dot-path to the field in the referenced record (e.g. 'company.name')
   * @returns The field value, or undefined if not found
   */
  lookupFieldFromFkRecord(
    sourceFkValue: string,
    referencedDataFolderId: DataFolderId,
    fieldPath: string,
  ): Promise<unknown>;

  /**
   * Looks up or creates a destination asset for a source asset.
   *
   * Finds the source Asset by (workbookId, sourceDataFolderId, sourceService, remoteAssetId),
   * then upserts a destination Asset keyed by (sourceAssetId, destinationDataFolderId).
   * If no destination asset exists, creates one with a temporary remoteAssetId and the same
   * rehostedUrl. Scoping is by dataFolderId (not service) to correctly handle multiple
   * connections of the same service type.
   *
   * @throws Error with message 'ASSET_NOT_FOUND' if the source asset does not exist
   * @throws Error with message 'ASSET_NOT_REHOSTED' if the source asset has no rehostedUrl
   */
  getOrCreateDestinationAssetMapping(
    sourceAssetRemoteId: string,
    sourceDataFolderId: DataFolderId,
    destinationDataFolderId: DataFolderId,
  ): Promise<AssetMappingResult>;
}

/**
 * Context passed to transformers during field transformation.
 */
export interface TransformContext {
  /** The full source record being transformed */
  sourceRecord: SyncRecord;

  /** Path to the field being transformed (e.g. 'company.name') */
  sourceFieldPath: string;

  /** The extracted value from the source field */
  sourceValue: unknown;

  /** The JSON Schema for the source field */
  sourceTableSpec: BaseJsonTableSpec | null;

  /** The Service of the source connector (e.g. AIRTABLE) */
  sourceService: Service;

  /** Target path for the field being transformed in the destination folder (e.g. 'company.name'). */
  destinationFieldPath: string;

  /** The current destination value for the mapped field (if record already exists) */
  destinationValue?: unknown;

  /** The JSON Schema for the destination field */
  destinationTableSpec: BaseJsonTableSpec | null;

  /** The Service of the destination connector (e.g. WEBFLOW) */
  destinationService: Service;

  /** Tools for FK lookups (only available for lookup-based transformers) */
  lookupTools: LookupTools;

  /** Transformer-specific configuration options */
  options: TransformerOptions;

  /** The current sync phase — transformers can use this to vary behavior */
  phase: SyncPhase;
}

/**
 * Result of a field transformation.
 */
export type TransformResult =
  | { success: true; value?: unknown; skip?: boolean; warnings?: string[] }
  | { success: false; error: string; useOriginal?: boolean };

/**
 * Interface for field transformers.
 */
export interface FieldTransformer {
  /** The transformer type identifier */
  readonly type: TransformerType;

  /**
   * Transforms a field value.
   *
   * @param ctx - The transformation context
   * @returns The transformation result
   */
  transform(ctx: TransformContext): Promise<TransformResult>;
}
