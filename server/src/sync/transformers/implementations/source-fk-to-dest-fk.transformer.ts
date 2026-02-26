import { SourceFkToDestFkOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, FkMappingResult, TransformContext, TransformResult } from '../transformer.types';

/**
 * Transforms a source foreign key ID to the corresponding destination foreign key ID.
 * Uses SyncRemoteIdMapping to resolve source FK values to destination IDs.
 *
 * Options:
 * - referencedDataFolderId: The source DataFolder ID of the referenced table mapping
 *
 * Handles scalars, arrays, and null/undefined values.
 * Skips transformation when the destination already has the correct value.
 */
export const sourceFkToDestFkTransformer: FieldTransformer = {
  type: TransformerTypes.SourceFkToDestFk,

  async transform(ctx: TransformContext): Promise<TransformResult> {
    // In DATA phase, skip transform: resolution happens in FOREIGN_KEY_MAPPING phase
    if (ctx.phase === 'DATA') {
      return { success: true, skip: true };
    }

    const { sourceValue, lookupTools, options, destinationValue } = ctx;
    const typedOptions = options as SourceFkToDestFkOptions;

    // Handle null/undefined
    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Normalize scalar to array for uniform processing
    const isScalar = !Array.isArray(sourceValue);
    if (isScalar && typeof sourceValue !== 'string' && typeof sourceValue !== 'number') {
      return {
        success: false,
        error: `Expected string, number, or array for FK value, got ${typeof sourceValue}`,
      };
    }
    const elements: unknown[] = isScalar ? [sourceValue] : sourceValue;

    // Normalize destination value for comparison
    const destElements: unknown[] | undefined =
      destinationValue !== undefined
        ? Array.isArray(destinationValue)
          ? destinationValue
          : [destinationValue]
        : undefined;

    const resolved: string[] = [];
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
        return {
          success: false,
          error: `Could not resolve foreign key "${fkStr}" to a destination path in DataFolder ${typedOptions.referencedDataFolderId}`,
        };
      }
      const pseudoRef = `@/${mapping.destinationFilePath}`;
      resolved.push(pseudoRef);

      // Check if the existing destination value already matches
      if (allMatch) {
        allMatch = doesElementMatch(destElements!, resolved.length - 1, pseudoRef, mapping);
      }
    }

    // If all resolved elements match the existing destination value (and lengths match), skip
    if (allMatch && destElements !== undefined && resolved.length === destElements.length) {
      return { success: true, skip: true };
    }

    return { success: true, value: isScalar ? resolved[0] : resolved };
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
