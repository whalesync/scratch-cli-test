import { Type } from '@sinclair/typebox';
import { MapArrayOptions, TransformerTypes } from '@spinner/shared-types';
import { getTransformer, registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';
import { applyTemplate } from './wrap-object.transformer';

/**
 * Applies a transformer to each element of an array, producing a new array.
 *
 * Options:
 * - `elementTransformer` — a TransformerConfig to apply to each element.
 * - `resultTemplate` — optional envelope applied AFTER the element mapping: every `"$value"`
 *   in it (at any depth) is replaced with the mapped array. With a resultTemplate, a
 *   null/undefined input maps to an EMPTY array before wrapping, so syncing an empty value
 *   emits the service's "cleared" shape instead of leaving the field unchanged (mirrors
 *   wrap_object's emptyTemplate clear-on-empty behavior).
 *
 * Examples:
 *   source: ["Tag 1", "Tag 2"]
 *   elementTransformer: { type: "wrap_object", options: { template: { name: "$value" } } }
 *   result: [{ name: "Tag 1" }, { name: "Tag 2" }]
 *
 *   source: ["id1", "id2"]  (a Notion relation pack)
 *   elementTransformer: { type: "wrap_object", options: { template: { id: "$value" } } }
 *   resultTemplate: { type: "relation", relation: "$value" }
 *   result: { type: "relation", relation: [{ id: "id1" }, { id: "id2" }] }
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
    {
      key: 'resultTemplate',
      widget: 'json_editor',
      label: 'Result Template',
      description: 'Optional JSON object where "$value" is replaced with the mapped array',
      defaultValue: {},
    },
  ],

  // With a resultTemplate the mapped array is wrapped into an object envelope; without one
  // the output stays an array of mapped elements.
  returnType: (_inputType, options) => {
    const { resultTemplate } = (options ?? {}) as Partial<MapArrayOptions>;
    return resultTemplate && Object.keys(resultTemplate).length > 0 ? Type.Object({}) : Type.Array(Type.Any());
  },
  paramType: () => Type.Array(Type.Any()),

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { elementTransformer, resultTemplate } = options as MapArrayOptions;
    const hasResultTemplate =
      resultTemplate !== undefined && typeof resultTemplate === 'object' && Object.keys(resultTemplate).length > 0;

    if (sourceValue === null || sourceValue === undefined) {
      // With a resultTemplate, an empty source emits the wrapped EMPTY array — the
      // service's "cleared" shape (e.g. Notion relation `{ relation: [] }`) — so syncing
      // an empty value clears the destination field. Without one, null passes through
      // (the write path drops it, leaving the field unchanged) exactly as before.
      return { success: true, value: hasResultTemplate ? applyTemplate(resultTemplate, []) : null };
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

    const value = hasResultTemplate ? applyTemplate(resultTemplate, results) : results;
    return { success: true, value, ...(warnings.length > 0 ? { warnings } : {}) };
  },
};

registerTransformer(mapArrayTransformer);
