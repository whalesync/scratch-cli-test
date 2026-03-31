import { Type } from '@sinclair/typebox';
import { isScratchPendingPublishId, MatchAssetByHashOptions, TransformerTypes } from '@spinner/shared-types';
import { WSLogger } from '../../../logger';
import { registerTransformer } from '../transformer-registry';
import { AssetMappingResult, FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Resolves source assets to destination assets, preferring content hash matching
 * and falling back to creating new destination assets for upload.
 *
 * For each source asset remote ID:
 * 1. Try to find a destination asset with the same contentHash (zero-upload match)
 * 2. If no hash match, fall back to getOrCreateDestinationAssetMapping (creates a
 *    destination asset with @asset/ pseudo-ref for upload during publish)
 *
 * This handles both migration scenarios (assets already exist on both sides) and
 * fresh syncs (assets need to be uploaded to the destination).
 *
 * Runs in FOREIGN_KEY_MAPPING phase.
 */
export const matchAssetByHashTransformer: FieldTransformer = {
  type: TransformerTypes.MatchAssetByHash,

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, lookupTools, options, destinationValue } = ctx;
    const typedOptions = options as MatchAssetByHashOptions;
    const ignoreUnresolved = typedOptions.onUnresolved === 'ignore';

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Normalize to array
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

      // Strategy 1: Try hash match (no upload needed)
      const hashMatch = await lookupTools.matchDestinationAssetByHash(
        element,
        typedOptions.sourceDataFolderId,
        typedOptions.destinationDataFolderId,
      );

      if (hashMatch) {
        resolved.push(hashMatch);
        if (allMatch) {
          allMatch = i < (destElements?.length ?? 0) && String(destElements![i]) === hashMatch;
        }
        continue;
      }

      // Strategy 2: Fall back to create destination asset for upload during publish
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
              source: 'matchAssetByHashTransformer',
              message: msg,
              sourceRecordId: ctx.sourceRecord.id,
              sourceFieldPath: ctx.sourceFieldPath,
            });
            continue;
          }
          return { success: false, error: msg };
        }
        if (err instanceof Error && err.message === 'ASSET_NOT_REHOSTED') {
          const msg = `Source asset "${element}" is not rehosted. Run "Pull Assets" with "Store copies" enabled first.`;
          if (ignoreUnresolved) {
            warnings.push(msg);
            WSLogger.warn({
              source: 'matchAssetByHashTransformer',
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

      const ref =
        mapping.isNew || isScratchPendingPublishId(mapping.destinationAssetRemoteId)
          ? `@asset/${mapping.destinationAssetId}`
          : mapping.destinationAssetRemoteId;
      resolved.push(ref);

      if (allMatch) {
        allMatch =
          i < (destElements?.length ?? 0) &&
          (String(destElements![i]) === ref || String(destElements![i]) === mapping.destinationAssetRemoteId);
      }
    }

    // If all resolved elements match the existing destination value, skip
    if (allMatch && destElements !== undefined && resolved.length === destElements.length) {
      return warnings.length > 0 ? { success: true, skip: true, warnings } : { success: true, skip: true };
    }

    const isDestScalar = isSourceScalar || typedOptions.outputType === 'single';
    const value = isDestScalar ? (resolved[0] ?? null) : resolved;
    return warnings.length > 0 ? { success: true, value, warnings } : { success: true, value };
  },
};

registerTransformer(matchAssetByHashTransformer);
