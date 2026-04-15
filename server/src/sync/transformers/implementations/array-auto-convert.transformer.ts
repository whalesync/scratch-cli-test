import { Type } from '@sinclair/typebox';
import { ArrayAutoConvertOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';
import { autoConvertTransformer } from './auto-convert.transformer';

/**
 * Applies AutoConvert element-wise to each item in an array.
 *
 * Example: ["1", "2"] with targetType 'number' → [1, 2]
 */
export const arrayAutoConvertTransformer: FieldTransformer = {
  type: TransformerTypes.ArrayAutoConvert,

  optionsSchema: [
    {
      key: 'targetType',
      widget: 'select',
      label: 'Target Element Type',
      description: 'The data type to convert each array element to',
      required: true,
      defaultValue: 'string',
      selectOptions: [
        { value: 'string', label: 'String' },
        { value: 'number', label: 'Number' },
        { value: 'integer', label: 'Integer' },
        { value: 'boolean', label: 'Boolean' },
      ],
    },
  ],

  paramType: () => Type.Array(Type.Any()),
  returnType: () => Type.Array(Type.Any()),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { targetType } = options as ArrayAutoConvertOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (!Array.isArray(sourceValue)) {
      return {
        success: false,
        error: `ArrayAutoConvert expects an array, got ${typeof sourceValue}`,
        useOriginal: true,
      };
    }

    const results: unknown[] = [];
    for (const element of sourceValue) {
      const result = await autoConvertTransformer.transform({ ...ctx, sourceValue: element, options: { targetType } });
      if (!result.success) {
        return result;
      }
      results.push(result.value);
    }

    return { success: true, value: results };
  },
};

// Auto-register on import
registerTransformer(arrayAutoConvertTransformer);
