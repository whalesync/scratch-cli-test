import { Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import he from 'he';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Encodes a string value as HTML using named entity references.
 *
 * Converts special characters and Unicode symbols to their HTML entity equivalents
 * (e.g. `<` → `&lt;`, `–` → `&ndash;`, `©` → `&copy;`).
 *
 * Used when syncing plain or rich text from a source (e.g. Airtable) that stores
 * raw text into a destination (e.g. Webflow) that expects HTML-encoded content.
 */
export const escapeHtmlTransformer: FieldTransformer = {
  type: TransformerTypes.EscapeHtml,

  paramType: () => Type.String(),
  returnType: () => Type.String(),
  optionsSchema: [],

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

    const escaped = he.encode(sourceValue, { useNamedReferences: true });
    return { success: true, value: escaped };
  },
};

// Auto-register on import
registerTransformer(escapeHtmlTransformer);
