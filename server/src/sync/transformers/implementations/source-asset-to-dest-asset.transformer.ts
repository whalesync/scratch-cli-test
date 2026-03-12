import { Type } from '@sinclair/typebox';
import { isScratchPendingPublishId, SourceAssetToDestAssetOptions, TransformerTypes } from '@spinner/shared-types';
import { WSLogger } from '../../../logger';
import { registerTransformer } from '../transformer-registry';
import { AssetMappingResult, FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Transforms a source asset remote ID to the corresponding destination asset remote ID.
 * Uses the Asset table's sourceAssetId FK to find existing destination assets, or creates
 * new destination assets on demand when they don't exist yet.
 *
 * Runs in FOREIGN_KEY_MAPPING phase (enforced by getColumnMappingPhase, not by the transformer).
 *
 * Options:
 * - sourceDataFolderId: The DataFolder ID for the source assets table — primary scope for source asset lookup
 * - destinationDataFolderId: The DataFolder ID on the destination side for created assets
 * - onUnresolved: 'fail' (default) stops the sync; 'ignore' skips unresolved assets with a warning
 * - outputType: 'array' (default) preserves arrays, 'single' unwraps to first element
 *
 * Source/destination service are provided via TransformContext.
 *
 * Handles scalars, arrays, and null/undefined values.
 * Skips transformation when the destination already has the correct value.
 */
export const sourceAssetToDestAssetTransformer: FieldTransformer = {
  type: TransformerTypes.SourceAssetToDestAsset,

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, lookupTools, options, destinationValue } = ctx;
    const typedOptions = options as SourceAssetToDestAssetOptions;
    const ignoreUnresolved = typedOptions.onUnresolved === 'ignore';

    // Handle null/undefined
    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Normalize scalar to array for uniform processing
    const isSourceScalar = !Array.isArray(sourceValue);
    if (isSourceScalar && typeof sourceValue !== 'string') {
      return {
        success: false,
        error: `Expected string or array for asset ID value, got ${typeof sourceValue}`,
      };
    }
    const elements: unknown[] = isSourceScalar ? [sourceValue] : sourceValue;

    // Normalize destination value for comparison
    const destElements: unknown[] | undefined =
      destinationValue !== undefined
        ? Array.isArray(destinationValue)
          ? destinationValue
          : [destinationValue]
        : undefined;

    const resolved: string[] = [];
    const warnings: string[] = [];
    let allMatch = destElements !== undefined;

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element === null || element === undefined) {
        continue;
      }
      if (typeof element !== 'string') {
        return {
          success: false,
          error: `Expected string for asset ID array element, got ${typeof element}`,
        };
      }

      let mapping: AssetMappingResult;
      try {
        mapping = await lookupTools.getOrCreateDestinationAssetMapping(
          element,
          typedOptions.sourceDataFolderId,
          typedOptions.destinationDataFolderId,
        );
      } catch (err) {
        if (err instanceof Error && err.message === 'ASSET_NOT_FOUND') {
          const msg = `Source asset "${element}" not found. Pull the source table again so all assets are indexed.`;
          if (ignoreUnresolved) {
            warnings.push(msg);
            WSLogger.warn({
              source: 'sourceAssetToDestAssetTransformer',
              message: msg,
              sourceRecordId: ctx.sourceRecord.id,
              sourceFieldPath: ctx.sourceFieldPath,
            });
            continue;
          }
          return { success: false, error: msg };
        }
        if (err instanceof Error && err.message === 'ASSET_NOT_REHOSTED') {
          const msg = `Source asset "${element}" is not rehosted. Run pull assets on the source table first.`;
          if (ignoreUnresolved) {
            warnings.push(msg);
            WSLogger.warn({
              source: 'sourceAssetToDestAssetTransformer',
              message: msg,
              sourceRecordId: ctx.sourceRecord.id,
              sourceFieldPath: ctx.sourceFieldPath,
            });
            continue;
          }
          return { success: false, error: msg };
        }
        throw err;
      }

      // Use @asset/ pseudo-reference (keyed by Asset DB id) for new assets or assets with
      // pending publish IDs, otherwise use the raw destination remote asset ID.
      const ref =
        mapping.isNew || isScratchPendingPublishId(mapping.destinationAssetRemoteId)
          ? `@asset/${mapping.destinationAssetId}`
          : mapping.destinationAssetRemoteId;
      resolved.push(ref);

      // Check if the existing destination value already matches
      if (allMatch) {
        allMatch = doesElementMatch(destElements!, resolved.length - 1, ref, mapping);
      }
    }

    // If all resolved elements match the existing destination value (and lengths match), skip
    if (allMatch && destElements !== undefined && resolved.length === destElements.length) {
      return warnings.length > 0 ? { success: true, skip: true, warnings } : { success: true, skip: true };
    }

    const isDestScalar = isSourceScalar || typedOptions.outputType === 'single';
    const value = isDestScalar ? (resolved[0] ?? null) : resolved;
    return warnings.length > 0 ? { success: true, value, warnings } : { success: true, value };
  },
};

/**
 * Checks whether a single resolved element matches the corresponding destination element.
 * A match means the existing value is either the resolved `@asset/` pseudo-ref
 * or the raw `destinationAssetRemoteId`.
 */
function doesElementMatch(
  destElements: unknown[],
  resolvedIndex: number,
  pseudoRef: string,
  mapping: AssetMappingResult,
): boolean {
  if (resolvedIndex >= destElements.length) {
    return false;
  }
  const existing = destElements[resolvedIndex];
  if (String(existing) === pseudoRef) {
    return true;
  }
  if (String(existing) === mapping.destinationAssetRemoteId) {
    return true;
  }
  return false;
}

// Auto-register on import
registerTransformer(sourceAssetToDestAssetTransformer);
