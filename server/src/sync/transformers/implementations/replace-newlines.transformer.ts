import { Type } from '@sinclair/typebox';
import { ReplaceNewlinesOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Replaces all Unicode newline characters in a string with a configurable replacement.
 *
 * Handles all newline variants from Unicode 5.2 table 5.1:
 * CR+LF, CR, LF, NEL (U+0085), VT (U+000B), FF (U+000C), LS (U+2028), PS (U+2029)
 *
 * Options:
 * - `replacement` (default: "") — the string to substitute for each newline
 */
export const replaceNewlinesTransformer: FieldTransformer = {
  type: TransformerTypes.ReplaceNewlines,

  paramType: () => Type.String(),
  returnType: () => Type.String(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { replacement = '' } = (options ?? {}) as ReplaceNewlinesOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string') {
      return { success: true, value: sourceValue };
    }

    // From table 5.1 in http://unicode.org/versions/Unicode5.2.0/ch05.pdf
    // eslint-disable-next-line no-control-regex
    const value = sourceValue.replace(/(\r\n|\r|\n|\u0085|\v|\u000C|\u2028|\u2029)/gm, replacement);
    return { success: true, value };
  },
};

registerTransformer(replaceNewlinesTransformer);
