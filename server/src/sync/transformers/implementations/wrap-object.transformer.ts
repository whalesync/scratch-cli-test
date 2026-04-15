import { Type } from '@sinclair/typebox';
import { TransformerTypes, WrapObjectOptions } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Wraps a scalar value into an object using a template.
 *
 * The template is an object where any string value equal to `"$value"` is replaced
 * with the source value. All other values in the template are kept as-is.
 *
 * Example:
 *   source: "Tag 1"
 *   template: { "name": "$value" }
 *   result: { "name": "Tag 1" }
 */
export const wrapObjectTransformer: FieldTransformer = {
  type: TransformerTypes.WrapObject,

  optionsSchema: [
    {
      key: 'template',
      widget: 'json_editor',
      label: 'Template',
      description: 'JSON object where "$value" is replaced with the source value',
      defaultValue: {},
    },
  ],

  returnType: () => Type.Object({}),
  paramType: () => Type.Any(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { template } = options as WrapObjectOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (!template || typeof template !== 'object') {
      return { success: false, error: 'wrap_object requires a "template" option (object)' };
    }

    const result = applyTemplate(template, sourceValue);
    return { success: true, value: result };
  },
};

function applyTemplate(template: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, templateValue] of Object.entries(template)) {
    if (templateValue === '$value') {
      result[key] = value;
    } else {
      result[key] = templateValue;
    }
  }
  return result;
}

registerTransformer(wrapObjectTransformer);
