import { Type } from '@sinclair/typebox';
import { ReplaceRegexOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Replaces matches of a regular expression pattern in a string.
 *
 * Options:
 * - `pattern` — regex pattern string (will be compiled with global flag)
 * - `replacement` (default: "") — replacement string, supports capture groups ($1, $2, etc.)
 */
export const replaceRegexTransformer: FieldTransformer = {
  type: TransformerTypes.ReplaceRegex,

  optionsSchema: [
    {
      key: 'pattern',
      widget: 'text',
      label: 'Pattern',
      description: 'Regular expression pattern (applied globally)',
      placeholder: 'https?://youtu\\.be/',
      required: true,
      defaultValue: '',
    },
    {
      key: 'replacement',
      widget: 'text',
      label: 'Replacement',
      description: 'Replacement string (supports $1, $2 capture groups). Leave empty to delete matches.',
      placeholder: 'https://youtube.com/watch?v=',
      defaultValue: '',
    },
  ],

  paramType: () => Type.String(),
  returnType: () => Type.String(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { pattern, replacement = '' } = (options ?? {}) as ReplaceRegexOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string') {
      return { success: true, value: sourceValue };
    }

    if (!pattern) {
      return { success: false, error: 'replace_regex requires a "pattern" option' };
    }

    try {
      const regex = new RegExp(pattern, 'g');
      const value = sourceValue.replace(regex, replacement);
      return { success: true, value };
    } catch (err) {
      return {
        success: false,
        error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

registerTransformer(replaceRegexTransformer);
