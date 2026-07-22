import { Type } from '@sinclair/typebox';
import { TransformerTypes, WrapObjectOptions } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Wraps a value into an object using a template.
 *
 * The template is an object in which every string equal to `"$value"` — at any
 * depth, including inside nested objects and arrays — is replaced with the source
 * value. All other template values are kept as-is. This lets a single wrap_object
 * build a deeply nested shape.
 *
 * Examples:
 *   source: "Tag 1"
 *   template: { "name": "$value" }
 *   result:   { "name": "Tag 1" }
 *
 *   source: "Hi"
 *   template: { type: 'rich_text', rich_text: [{ type: 'text', text: { content: '$value' } }] }
 *   result:   { type: 'rich_text', rich_text: [{ type: 'text', text: { content: 'Hi' } }] }
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
    const { template, emptyTemplate } = options as WrapObjectOptions;

    // An empty source clears the field. `emptyTemplate` (when the connector declares one)
    // is the service's "cleared" shape — e.g. Notion date `{ type: 'date', date: null }` or
    // rich_text `{ rich_text: [] }` — so syncing an empty value clears the destination instead
    // of wrapping "" into the envelope (which a service like Notion rejects). Without an
    // emptyTemplate we fall back to `null`, which the write path drops (field left unchanged).
    // `undefined` never reaches here — transformRecordAsync maps a cleared (absent) source
    // field to `null` before running the pipeline, and skips it entirely when the
    // destination has no value to clear.
    if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
      return { success: true, value: emptyTemplate ? applyTemplate(emptyTemplate, null) : null };
    }

    if (!template || typeof template !== 'object') {
      return { success: false, error: 'wrap_object requires a "template" option (object)' };
    }

    const result = applyTemplate(template, sourceValue);
    return { success: true, value: result };
  },
};

/**
 * Replace every `"$value"` in the template — at any depth, inside nested objects
 * and arrays — with the source value, keeping all other template values as-is.
 * Exported for map_array's `resultTemplate` (the same substitution applied to the
 * mapped array).
 */
export function applyTemplate(template: unknown, value: unknown): unknown {
  if (template === '$value') return value;
  if (Array.isArray(template)) return template.map((entry) => applyTemplate(entry, value));
  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, templateValue] of Object.entries(template as Record<string, unknown>)) {
      result[key] = applyTemplate(templateValue, value);
    }
    return result;
  }
  return template;
}

registerTransformer(wrapObjectTransformer);
