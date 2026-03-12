import { Type } from '@sinclair/typebox';
import { LookupFieldOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Looks up a field value from a record referenced by a foreign key.
 * Uses the SyncForeignKeyRecord cache populated during fillSyncCaches.
 *
 * Options:
 * - referencedDataFolderId: The source DataFolder ID containing the referenced records
 * - referencedFieldPath: Dot-path to extract from the referenced record (e.g. 'name')
 *
 * Only operates in DATA phase. Skips in FOREIGN_KEY_MAPPING phase.
 */
export const lookupFieldTransformer: FieldTransformer = {
  type: TransformerTypes.LookupField,

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, lookupTools, options } = ctx;
    const typedOptions = options as LookupFieldOptions;

    // Handle null/undefined FK value — pass through as null
    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Handle arrays — look up each element
    if (Array.isArray(sourceValue)) {
      const results: unknown[] = [];
      for (const element of sourceValue) {
        if (element === null || element === undefined) {
          results.push(null);
          continue;
        }
        const fkStr = String(element);
        const fieldValue = await lookupTools.lookupFieldFromFkRecord(
          fkStr,
          typedOptions.referencedDataFolderId,
          typedOptions.referencedFieldPath,
        );
        if (fieldValue === undefined) {
          return {
            success: false,
            error: `Could not find referenced record "${fkStr}" in DataFolder ${typedOptions.referencedDataFolderId}`,
          };
        }
        results.push(fieldValue);
      }
      return { success: true, value: results };
    }

    // Handle scalar — coerce to string and look up
    if (typeof sourceValue !== 'string' && typeof sourceValue !== 'number') {
      return {
        success: false,
        error: `Expected string, number, or array for FK value, got ${typeof sourceValue}`,
      };
    }

    const fkStr = String(sourceValue);
    const fieldValue = await lookupTools.lookupFieldFromFkRecord(
      fkStr,
      typedOptions.referencedDataFolderId,
      typedOptions.referencedFieldPath,
    );

    if (fieldValue === undefined) {
      return {
        success: false,
        error: `Could not find referenced record "${fkStr}" in DataFolder ${typedOptions.referencedDataFolderId}`,
      };
    }

    return { success: true, value: fieldValue };
  },
};

// Auto-register on import
registerTransformer(lookupFieldTransformer);
