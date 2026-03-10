import { isScratchPendingPublishId, SourceFkToDestFkOptions, TransformerTypes } from '@spinner/shared-types';
import { WSLogger } from '../../../logger';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, FkMappingResult, TransformContext, TransformResult } from '../transformer.types';

/**
 * Transforms a source foreign key ID to the corresponding destination foreign key ID.
 * Uses SyncRemoteIdMapping to resolve source FK values to destination IDs.
 *
 * Options:
 * - referencedDataFolderId: The source DataFolder ID of the referenced table mapping
 * - onUnresolved: 'fail' (default) stops the sync; 'ignore' skips unresolved FKs with a warning
 *
 * Handles scalars, arrays, and null/undefined values.
 * Skips transformation when the destination already has the correct value.
 */
export const sourceFkToDestFkTransformer: FieldTransformer = {
  type: TransformerTypes.SourceFkToDestFk,

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, lookupTools, options, destinationValue } = ctx;
    const typedOptions = options as SourceFkToDestFkOptions;
    const ignoreUnresolved = typedOptions.onUnresolved === 'ignore';

    // Handle null/undefined
    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Normalize scalar to array for uniform processing
    const isSourceScalar = !Array.isArray(sourceValue);
    if (isSourceScalar && typeof sourceValue !== 'string' && typeof sourceValue !== 'number') {
      return {
        success: false,
        error: `Expected string, number, or array for FK value, got ${typeof sourceValue}`,
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
      if (typeof element !== 'string' && typeof element !== 'number') {
        return {
          success: false,
          error: `Expected string or number for FK array element, got ${typeof element}`,
        };
      }
      const fkStr = String(element);
      const mapping = await lookupTools.getDestinationMappingForSourceFk(fkStr, typedOptions.referencedDataFolderId);
      if (mapping === null) {
        if (ignoreUnresolved) {
          const msg = `Skipped unresolved foreign key "${fkStr}" in DataFolder ${typedOptions.referencedDataFolderId}`;
          warnings.push(msg);
          WSLogger.warn({
            source: 'sourceFkToDestFkTransformer',
            message: msg,
            sourceRecordId: ctx.sourceRecord.id,
            sourceFieldPath: ctx.sourceFieldPath,
          });
          continue;
        }
        return {
          success: false,
          error: `Could not resolve foreign key "${fkStr}" to a destination path in DataFolder ${typedOptions.referencedDataFolderId}`,
        };
      }
      // Use the real destination remote ID if it exists already, otherwise a reference to the file.
      const ref =
        mapping.destinationRemoteId && !isScratchPendingPublishId(mapping.destinationRemoteId)
          ? mapping.destinationRemoteId
          : `@/${mapping.destinationFilePath}`;
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
 * A match means the existing value is either the resolved `@/path` pseudo-ref
 * or the raw `destinationRemoteId`.
 */
function doesElementMatch(
  destElements: unknown[],
  resolvedIndex: number,
  pseudoRef: string,
  mapping: FkMappingResult,
): boolean {
  if (resolvedIndex >= destElements.length) {
    return false;
  }
  const existing = destElements[resolvedIndex];
  if (String(existing) === pseudoRef) {
    return true;
  }
  if (mapping.destinationRemoteId !== null && String(existing) === String(mapping.destinationRemoteId)) {
    return true;
  }
  return false;
}

// Auto-register on import
registerTransformer(sourceFkToDestFkTransformer);
