import { EnsureTypeOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Ensures the value matches a specific runtime type.
 * If it doesn't match, handles failure according to options (null, error, omit, or fallback).
 */
export const ensureTypeTransformer: FieldTransformer = {
  type: TransformerTypes.EnsureType,

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const typedOptions = options as EnsureTypeOptions;

    const { expectedType, onFailure, fallbackValue } = typedOptions;

    let isValid = false;

    if (expectedType === 'array') {
      isValid = Array.isArray(sourceValue);
    } else if (expectedType === 'object') {
      isValid = typeof sourceValue === 'object' && sourceValue !== null && !Array.isArray(sourceValue);
    } else if (expectedType === 'string') {
      isValid = typeof sourceValue === 'string';
    } else if (expectedType === 'number') {
      isValid = typeof sourceValue === 'number' && !isNaN(sourceValue);
    } else if (expectedType === 'boolean') {
      isValid = typeof sourceValue === 'boolean';
    } else {
      // In case of an unknown expectedType (should be caught by typing)
      return { success: false, error: `Unknown expectedType: ${String(expectedType)}` };
    }

    if (isValid) {
      return { success: true, value: sourceValue };
    }

    // Handle failure
    switch (onFailure) {
      case 'null':
        return { success: true, value: null };
      case 'omit':
        return { success: true, skip: true };
      case 'other': {
        if (fallbackValue === undefined) {
          return { success: true, value: undefined };
        }

        try {
          let parsedValue: unknown = fallbackValue;

          if (expectedType === 'number') {
            const n = Number(fallbackValue);
            if (isNaN(n)) {
              return { success: false, error: `Fallback value '${fallbackValue}' could not be parsed as a number` };
            }
            parsedValue = n;
          } else if (expectedType === 'boolean') {
            parsedValue = fallbackValue === 'true';
          } else if (expectedType === 'object') {
            const parsed: unknown = JSON.parse(fallbackValue);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              return { success: false, error: `Fallback value is not a valid JSON object` };
            }
            parsedValue = parsed;
          } else if (expectedType === 'array') {
            const parsed: unknown = JSON.parse(fallbackValue);
            if (!Array.isArray(parsed)) {
              return { success: false, error: `Fallback value is not a valid JSON array` };
            }
            parsedValue = parsed;
          }

          return { success: true, value: parsedValue };
        } catch (e) {
          return {
            success: false,
            error: `Failed to parse fallback value for expected type '${expectedType}': ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      case 'error':
      default:
        return {
          success: false,
          error: `Value did not match expected type '${expectedType}' (was ${typeof sourceValue})`,
        };
    }
  },
};

// Auto-register on import
registerTransformer(ensureTypeTransformer);
