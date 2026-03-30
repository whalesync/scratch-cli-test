import { Type } from '@sinclair/typebox';
import { MatchAssetByHashOptions, TransformerTypes } from '@spinner/shared-types';
import { WSLogger } from '../../../logger';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Matches a source asset to a destination asset by content hash.
 *
 * For each source asset remote ID, looks up the source asset's contentHash,
 * then searches for a destination asset with the same hash. If found, returns
 * the destination asset's remoteAssetId (so the synced file references the
 * existing destination asset). If not found, returns null or fails depending
 * on onUnresolved.
 *
 * This is useful for migrations where assets already exist on both sides
 * (e.g. migrated via Whalesync) and we want to link them without re-uploading.
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

    const resolved: string[] = [];
    const warnings: string[] = [];

    for (const element of elements) {
      if (element === null || element === undefined) {
        continue;
      }
      if (typeof element !== 'string') {
        return {
          success: false,
          error: `Expected string for asset ID array element, got ${typeof element}`,
        };
      }

      const destRemoteId = await lookupTools.matchDestinationAssetByHash(
        element,
        typedOptions.sourceDataFolderId,
        typedOptions.destinationDataFolderId,
      );

      if (destRemoteId) {
        resolved.push(destRemoteId);
      } else {
        const msg = `No destination asset with matching hash for source asset "${element}"`;
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
    }

    // Check if resolved values match existing destination — skip if identical
    if (destinationValue !== undefined) {
      const destElements = Array.isArray(destinationValue) ? destinationValue : [destinationValue];
      if (resolved.length === destElements.length && resolved.every((r, i) => String(destElements[i]) === r)) {
        return warnings.length > 0 ? { success: true, skip: true, warnings } : { success: true, skip: true };
      }
    }

    const isDestScalar = isSourceScalar || typedOptions.outputType === 'single';
    const value = isDestScalar ? (resolved[0] ?? null) : resolved;
    return warnings.length > 0 ? { success: true, value, warnings } : { success: true, value };
  },
};

registerTransformer(matchAssetByHashTransformer);
