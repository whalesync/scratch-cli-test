import { Type } from '@sinclair/typebox';
import { isScratchPendingPublishId, MatchAssetByHashOptions, TransformerTypes } from '@spinner/shared-types';
import get from 'lodash/get';
import { WSLogger } from '../../../logger';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Resolves source assets to destination assets, preferring content hash matching
 * and falling back to creating new destination assets for upload.
 *
 * For each source asset remote ID:
 * 1. Try to find destination assets with the same contentHash (zero-upload match)
 * 2. Compare against existing destination values — if all match, skip
 * 3. If any element doesn't match, fall back to @asset/ refs for the ENTIRE array
 *
 * Runs in FOREIGN_KEY_MAPPING phase.
 */
export const matchAssetByHashTransformer: FieldTransformer = {
  type: TransformerTypes.MatchAssetByHash,

  optionsSchema: [
    {
      key: 'sourceDataFolderId',
      widget: 'folder_picker',
      label: 'Source Asset Folder',
      description: 'The folder containing the source assets',
      placeholder: 'Select asset folder',
      required: true,
      defaultValue: '',
    },
    {
      key: 'destinationDataFolderId',
      widget: 'folder_picker',
      label: 'Destination Asset Folder',
      description: 'The folder to search for matching asset hashes',
      placeholder: 'Select asset folder',
      required: true,
      defaultValue: '',
      assetFoldersOnly: true,
    },
    {
      key: 'sourceIdPath',
      widget: 'text',
      label: 'Source ID Path',
      description: "Dot-path to extract the asset ID from each source element (e.g. 'id')",
      placeholder: 'e.g. id',
    },
    {
      key: 'destinationIdPath',
      widget: 'text',
      label: 'Destination ID Path',
      description: "Dot-path to extract the asset ID from each destination element (e.g. 'fileId')",
      placeholder: 'e.g. fileId',
    },
    {
      key: 'outputType',
      widget: 'select',
      label: 'Output type',
      description: 'Whether to output multiple values (array) or a single value',
      defaultValue: 'array',
      selectOptions: [
        { value: 'array', label: 'Multiple values (array)' },
        { value: 'single', label: 'Single value (first item)' },
      ],
    },
    {
      key: 'onUnresolved',
      widget: 'select',
      label: 'When no hash match is found',
      defaultValue: 'fail',
      selectOptions: [
        { value: 'fail', label: 'Stop and fail the sync' },
        { value: 'ignore', label: 'Ignore missing record and sync the rest' },
      ],
    },
  ],

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
    const elements: unknown[] = isSourceScalar ? [sourceValue] : (sourceValue as unknown[]);

    // Normalize destination value for comparison
    const destElements: unknown[] | undefined =
      destinationValue !== undefined
        ? Array.isArray(destinationValue)
          ? destinationValue
          : [destinationValue]
        : undefined;

    // Phase 1: Try hash matching on all elements
    const hashResults: { assetId: string; matches: string[] }[] = [];
    const warnings: string[] = [];

    for (const element of elements) {
      if (element === null || element === undefined) {
        continue;
      }

      const assetId: unknown = typedOptions.sourceIdPath ? get(element, typedOptions.sourceIdPath) : element;
      if (typeof assetId !== 'string') {
        return {
          success: false,
          error: `Expected string asset ID${typedOptions.sourceIdPath ? ` at path "${typedOptions.sourceIdPath}"` : ''}, got ${typeof assetId}`,
        };
      }

      const matches = await lookupTools.matchDestinationAssetByHash(
        assetId,
        typedOptions.sourceDataFolderId,
        typedOptions.destinationDataFolderId,
      );

      hashResults.push({ assetId, matches });
    }

    // Phase 2: Check if all elements match the existing destination
    let allMatch = destElements !== undefined && hashResults.length === destElements.length;

    if (allMatch && destElements !== undefined) {
      for (let i = 0; i < hashResults.length; i++) {
        const { matches } = hashResults[i];
        if (matches.length === 0) {
          allMatch = false;
          break;
        }
        // Extract the destination's current ID for comparison
        const destEl = destElements[i];
        const destId: unknown =
          typedOptions.destinationIdPath && destEl ? get(destEl, typedOptions.destinationIdPath) : destEl;
        // Check if the destination's current ID is among the hash matches
        if (!matches.includes(String(destId))) {
          allMatch = false;
          break;
        }
      }
    }

    if (allMatch) {
      return { success: true, skip: true };
    }

    // Phase 3: Not all matched — fall back to @asset/ refs for ALL elements
    const resolved: string[] = [];

    for (const { assetId } of hashResults) {
      try {
        const mapping = await lookupTools.getOrCreateDestinationAssetMapping(
          assetId,
          typedOptions.sourceDataFolderId,
          typedOptions.destinationDataFolderId,
        );

        const ref =
          mapping.isNew || isScratchPendingPublishId(mapping.destinationAssetRemoteId)
            ? `@asset/${mapping.destinationAssetId}`
            : mapping.destinationAssetRemoteId;
        resolved.push(ref);
      } catch (err) {
        if (err instanceof Error && err.message === 'ASSET_NOT_FOUND') {
          const msg = `Source asset "${assetId}" not found. Pull the source table again so all assets are indexed.`;
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
          const msg = `Source asset "${assetId}" is not rehosted. Run "Pull Assets" with "Store copies" enabled first.`;
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
    }

    const isDestScalar = isSourceScalar || typedOptions.outputType === 'single';
    const value = isDestScalar ? (resolved[0] ?? null) : resolved;
    return warnings.length > 0 ? { success: true, value, warnings } : { success: true, value };
  },
};

registerTransformer(matchAssetByHashTransformer);
