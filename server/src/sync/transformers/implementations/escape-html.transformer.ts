import { Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Escapes HTML entities in a string value.
 *
 * Converts `<`, `>`, `&`, `"`, and `'` to their HTML entity equivalents.
 * Used when syncing plain or rich text from a source (e.g. Airtable) that stores
 * raw HTML into a destination (e.g. Webflow) that expects escaped HTML.
 */
export const escapeHtmlTransformer: FieldTransformer = {
  type: TransformerTypes.EscapeHtml,

  paramType: () => Type.String(),
  returnType: () => Type.String(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue } = ctx;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string') {
      return {
        success: false,
        error: `Expected string, got ${typeof sourceValue}`,
        useOriginal: true,
      };
    }

    const escaped = sourceValue
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    return { success: true, value: escaped };
  },
};

// Auto-register on import
registerTransformer(escapeHtmlTransformer);
