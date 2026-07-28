import {
  DataFolderId,
  Service,
  TransformerFieldDescriptor,
  TransformerOptions,
  TransformerType,
} from '@spinner/shared-types';
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
  /** Connection-relative path of the destination record file (no leading slash). */
  destinationFilePath: string;
  destinationRemoteId: string | null;
  /**
   * The destination connection's folder name — the first segment of a
   * workspace-absolute pseudo-ref (`sanitizeConnectionFolderName(displayName)`).
   * Prepended to `destinationFilePath` so the sync producer emits the canonical
   * `@/<connection>/<folder>/<file>.json` form (DEV-10880). Null when the
   * destination folder has no connection (should not happen for FK targets).
   */
  destinationConnectionFolder: string | null;
}

/**
 * Result of resolving a foreign-key VALUE to the referenced record's SOURCE remote id — the
 * identity every other piece of the FK machinery is keyed on.
 *
 * `ambiguous` is deliberately distinct from `no_match`: a target key that names two records is a
 * data error the user needs to see and fix, not a coin flip between them.
 */
export type ForeignKeyTargetResolution =
  | { kind: 'resolved'; targetSourceRemoteId: string }
  | { kind: 'no_match' }
  | { kind: 'ambiguous'; matchCount: number };

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
   * Resolves a foreign-key VALUE to the SOURCE remote id of the record it points at — the
   * step that runs BEFORE {@link getDestinationMappingForSourceFk}, which is keyed on that id.
   *
   * With no `targetKeyPath` this is the identity function: the value already IS the remote id,
   * which is true for every connector whose reference fields carry ids. With one, the
   * referenced folder's source records are indexed by that path and the value is matched
   * against it — exactly, with no fallback to id matching, so a declared key means that key
   * only. See `ForeignKeyOptionSchema.targetKeyPath` for the full contract.
   *
   * @param foreignKeyValue - The foreign key value read off the source record
   * @param referencedDataFolderId - The (source) DataFolder holding the referenced records
   * @param targetKeyPath - Dot path in the referenced record the value matches; omit for remote id
   */
  resolveForeignKeyValueToTargetRemoteId(
    foreignKeyValue: string,
    referencedDataFolderId: DataFolderId,
    targetKeyPath?: string,
  ): Promise<ForeignKeyTargetResolution>;

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

  /**
   * Finds all destination assets whose contentHash matches the source asset's contentHash.
   * Returns an array of matching remoteAssetIds (empty if no match).
   */
  matchDestinationAssetByHash(
    sourceAssetRemoteId: string,
    sourceDataFolderId: DataFolderId,
    destinationDataFolderId: DataFolderId,
  ): Promise<string[]>;
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

import { TSchema } from '@sinclair/typebox';

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

  /**
   * Predicts the return (output) schema type based on the input schema type and transformer options.
   * If not provided, the transformer is assumed to not change the type, or it's unknown.
   *
   * @param inputType The JSON schema (TSchema) of the single field being transformed.
   * @param options The transformer-specific configuration options.
   */
  returnType?(inputType: TSchema, options?: TransformerOptions): TSchema;

  /**
   * Declares the expected parameter (input) schema type this transformer accepts.
   * If not provided, the transformer accepts any type.
   *
   * @param options The transformer-specific configuration options.
   */
  paramType?(options?: TransformerOptions): TSchema;

  /** UI field descriptors for the options form. If absent, transformer has no configurable options. */
  readonly optionsSchema?: TransformerFieldDescriptor[];
}
