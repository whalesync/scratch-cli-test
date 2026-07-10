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

  optionsSchema: [
    {
      key: 'targetType',
      widget: 'select',
      label: 'Target Type',
      description: 'The data type to convert the source value to',
      required: true,
      defaultValue: 'string',
      selectOptions: [
        { value: 'string', label: 'String' },
        { value: 'number', label: 'Number' },
        { value: 'integer', label: 'Integer' },
        { value: 'boolean', label: 'Boolean' },
        { value: 'array', label: 'Array' },
      ],
    },
    {
      key: 'preserveNull',
      widget: 'checkbox',
      label: 'Preserve null values',
      description: 'When enabled, null values pass through as null instead of being converted (e.g. to empty string)',
      defaultValue: false,
    },
  ],

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
      const { preserveNull } = options as AutoConvertOptions;
      if (preserveNull) {
        return { success: true, value: null };
      }
      switch (targetType) {
        case 'string':
          return { success: true, value: '' };
        case 'number':
        case 'integer':
          return { success: true, value: 0 };
        case 'boolean':
          return { success: true, value: false };
        case 'array':
          return { success: true, value: [] };
        default:
          return { success: true, value: null };
      }
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
      return { success: true, value: stringifyElement(value[0]) };
    }
    return { success: true, value: value.map(stringifyElement).join(', ') };
  }
  // Objects (and any other non-scalar) get a JSON string rather than failing the
  // record — a non-string value going into a string/text column should always
  // fall back to a stringify. This is what makes nested source values (e.g.
  // Shopify's `featuredImage` / `category` objects) land in a text destination
  // column on a Live Export instead of aborting the whole record.
  return { success: true, value: safeJsonStringify(value) };
}

/** Stringify one array element: scalars via `String`, objects as JSON (so an array of objects doesn't become "[object Object]"). */
function stringifyElement(value: unknown): string {
  return value !== null && typeof value === 'object' ? safeJsonStringify(value) : String(value);
}

/** `JSON.stringify`, but never throws (e.g. on a circular reference) — falls back to `String(value)`. */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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
