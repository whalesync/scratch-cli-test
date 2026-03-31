import { Type } from '@sinclair/typebox';
import { AutoConvertOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Generic type-conversion transformer that handles common mismatches
 * between source and destination field types.
 *
 * Requires a `targetType` option: 'string' | 'number' | 'boolean' | 'array'.
 */
export const autoConvertTransformer: FieldTransformer = {
  type: TransformerTypes.AutoConvert,

  returnType: (_inputType, options) => {
    const typedOptions = options as AutoConvertOptions;
    const targetType = typedOptions?.targetType;
    switch (targetType) {
      case 'string':
        return Type.String();
      case 'number':
      case 'integer':
        return Type.Number();
      case 'boolean':
        return Type.Boolean();
      case 'array':
        return Type.Array(Type.Any());
      default:
        return Type.Any();
    }
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { targetType } = options as AutoConvertOptions;

    if (sourceValue === null || sourceValue === undefined) {
      // For boolean, null/undefined → false (falsy conversion)
      if (targetType === 'boolean') {
        return { success: true, value: false };
      }
      return { success: true, value: null };
    }

    switch (targetType) {
      case 'string':
        return convertToString(sourceValue);
      case 'number':
        return convertToNumber(sourceValue);
      case 'integer':
        return convertToInteger(sourceValue);
      case 'boolean':
        return convertToBoolean(sourceValue);
      case 'array':
        return convertToArray(sourceValue);
      default:
        return {
          success: false,
          error: `Unable to convert automatically to destination type: ${targetType as string}`,
          useOriginal: true,
        };
    }
  },
};

function convertToString(value: unknown): TransformResult {
  if (typeof value === 'string') {
    return { success: true, value };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { success: true, value: String(value) };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { success: true, value: '' };
    }
    if (value.length === 1) {
      return { success: true, value: String(value[0]) };
    }
    return { success: true, value: value.map(String).join(', ') };
  }
  return { success: false, error: `Cannot convert ${typeof value} to string`, useOriginal: true };
}

function convertToNumber(value: unknown): TransformResult {
  if (typeof value === 'number') {
    return { success: true, value };
  }
  if (typeof value === 'boolean') {
    return { success: true, value: value ? 1 : 0 };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return { success: true, value: null };
    }
    const parsed = Number(trimmed);
    if (isNaN(parsed)) {
      return { success: false, error: `Cannot convert "${value}" to number`, useOriginal: true };
    }
    return { success: true, value: parsed };
  }
  if (Array.isArray(value)) {
    if (value.length === 1) {
      return convertToNumber(value[0]);
    }
    return { success: false, error: `Cannot convert array with ${value.length} elements to number`, useOriginal: true };
  }
  return { success: false, error: `Cannot convert ${typeof value} to number`, useOriginal: true };
}

function convertToInteger(value: unknown): TransformResult {
  const result = convertToNumber(value);
  if (result.success && result.value != null && typeof result.value === 'number') {
    return { success: true, value: Math.trunc(result.value) };
  }
  return result;
}

function convertToBoolean(value: unknown): TransformResult {
  if (typeof value === 'boolean') {
    return { success: true, value };
  }
  if (typeof value === 'number') {
    return { success: true, value: value !== 0 };
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === '') {
      return { success: true, value: null };
    }
    if (lower === 'true' || lower === 'yes' || lower === '1') {
      return { success: true, value: true };
    }
    if (lower === 'false' || lower === 'no' || lower === '0') {
      return { success: true, value: false };
    }
    return { success: false, error: `Cannot convert "${value}" to boolean`, useOriginal: true };
  }
  if (Array.isArray(value)) {
    if (value.length === 1) {
      return convertToBoolean(value[0]);
    }
    return {
      success: false,
      error: `Cannot convert array with ${value.length} elements to boolean`,
      useOriginal: true,
    };
  }
  return { success: false, error: `Cannot convert ${typeof value} to boolean`, useOriginal: true };
}

function convertToArray(value: unknown): TransformResult {
  if (Array.isArray(value)) {
    return { success: true, value };
  }
  return { success: true, value: [value] };
}

// Auto-register on import
registerTransformer(autoConvertTransformer);
