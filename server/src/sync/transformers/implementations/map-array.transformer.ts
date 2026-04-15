import { Type } from '@sinclair/typebox';
import { MapArrayOptions, TransformerTypes } from '@spinner/shared-types';
import { getTransformer, registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Applies a transformer to each element of an array, producing a new array.
 *
 * Options:
 * - `elementTransformer` — a TransformerConfig to apply to each element.
 *
 * Example:
 *   source: ["Tag 1", "Tag 2"]
 *   elementTransformer: { type: "wrap_object", options: { template: { name: "$value" } } }
 *   result: [{ name: "Tag 1" }, { name: "Tag 2" }]
 */
export const mapArrayTransformer: FieldTransformer = {
  type: TransformerTypes.MapArray,

  optionsSchema: [
    {
      key: 'elementTransformer',
      widget: 'transformer_config',
      label: 'Element Transformer',
      description: 'Transformer config applied to each array element (as JSON)',
      defaultValue: { type: 'wrap_object', options: { template: {} } },
    },
  ],

  returnType: () => Type.Array(Type.Any()),
  paramType: () => Type.Array(Type.Any()),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { elementTransformer } = options as MapArrayOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (!Array.isArray(sourceValue)) {
      return { success: false, error: 'map_array expects an array as input' };
    }

    if (!elementTransformer || !elementTransformer.type) {
      return { success: false, error: 'map_array requires an "elementTransformer" option' };
    }

    const transformer = getTransformer(elementTransformer.type);
    if (!transformer) {
      return { success: false, error: `Unknown transformer type: ${elementTransformer.type}` };
    }

    const results: unknown[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < sourceValue.length; i++) {
      const elementCtx: TransformContext = {
        ...ctx,
        sourceValue: sourceValue[i],
        options: elementTransformer.options ?? {},
      };

      const result = await transformer.transform(elementCtx);

      if (!result.success) {
        return { success: false, error: `map_array: element ${i}: ${result.error}` };
      }

      if (result.warnings) {
        warnings.push(...result.warnings.map((w) => `element ${i}: ${w}`));
      }

      if (!result.skip) {
        results.push(result.value);
      }
    }

    return { success: true, value: results, ...(warnings.length > 0 ? { warnings } : {}) };
  },
};

registerTransformer(mapArrayTransformer);
