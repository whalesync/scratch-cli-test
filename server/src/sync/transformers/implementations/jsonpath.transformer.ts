import { Type } from '@sinclair/typebox';
import { JSONPathOptions, TransformerTypes } from '@spinner/shared-types';
import { applyJsonPath } from '@spinner/shared-types/transform';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * JSONPath transformer that extracts values from complex JSON structures
 * using RFC 9535 JSONPath expressions.
 *
 * If the source value is a string, it attempts to JSON.parse it first.
 * The arrayHandling option exclusively determines how the result array is processed.
 */
export const jsonpathTransformer: FieldTransformer = {
  type: TransformerTypes.JSONPath,

  optionsSchema: [
    {
      key: 'expression',
      widget: 'text',
      label: 'JSONPath Expression',
      description: 'JSONPath expression (e.g. $.store.book[0].title)',
      placeholder: '$.path.to.value',
      required: true,
      defaultValue: '',
    },
    {
      key: 'arrayHandling',
      widget: 'select',
      label: 'Multiple results',
      description: 'How to handle when the expression matches multiple values',
      defaultValue: 'first',
      selectOptions: [
        { value: 'first', label: 'First value' },
        { value: 'array', label: 'Array' },
        { value: 'concat', label: 'Join without delimiter' },
        { value: 'join_space', label: 'Join with spaces' },
        { value: 'join_comma', label: 'Join with commas' },
      ],
    },
  ],

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { arrayHandling = 'first', expression } = options as JSONPathOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Sync-pipeline adapter (NOT shared with the display path): parse a string
    // source as JSON, then map the pure evaluation onto the sync TransformResult
    // with `useOriginal: false`. The RFC-9535 query + arrayHandling reduction is
    // the shared pure core (`applyJsonPath`); display intentionally reuses only
    // that and applies its own fail-closed policy instead of this one.
    let document: unknown = sourceValue;
    if (typeof sourceValue === 'string') {
      try {
        document = JSON.parse(sourceValue);
      } catch {
        return {
          success: false,
          error: `Source value is a string that is not valid JSON`,
          useOriginal: false,
        };
      }
    }

    const result = applyJsonPath(document, expression, arrayHandling);
    if (!result.ok) {
      return { success: false, error: result.reason, useOriginal: false };
    }
    return { success: true, value: result.value };
  },
};

// Auto-register on import
registerTransformer(jsonpathTransformer);
