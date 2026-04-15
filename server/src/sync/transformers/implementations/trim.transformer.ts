import { Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Trims leading and trailing whitespace from a string value.
 */
export const trimTransformer: FieldTransformer = {
  type: TransformerTypes.Trim,

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

    return { success: true, value: sourceValue.trim() };
  },
};

registerTransformer(trimTransformer);
