import { DataFolderId, TransformerOptions, TransformerType } from '@spinner/shared-types';

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

  /** Tools for FK lookups (only available for lookup-based transformers) */
  lookupTools: LookupTools;

  /** The current destination value for the mapped field (if record already exists) */
  destinationValue?: unknown;

  /** Transformer-specific configuration options */
  options: TransformerOptions;

  /** The current sync phase — transformers can use this to vary behavior */
  phase: SyncPhase;
}

/**
 * Result of a field transformation.
 */
export type TransformResult =
  | { success: true; value?: unknown; skip?: boolean }
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
