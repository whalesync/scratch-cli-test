import { Type } from '@sinclair/typebox';
import { JSONPathOptions, TransformerTypes } from '@spinner/shared-types';
import { JsonValue, query } from 'jsonpath-rfc9535';
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

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { arrayHandling = 'first' } = options as JSONPathOptions;
    let { expression } = options as JSONPathOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    let document: JsonValue = sourceValue as JsonValue;

    if (typeof sourceValue === 'string') {
      try {
        document = JSON.parse(sourceValue) as JsonValue;
      } catch {
        return {
          success: false,
          error: `Source value is a string that is not valid JSON`,
          useOriginal: false,
        };
      }
    }

    // Ensure expression starts with '$' (required by RFC 9535)
    if (!expression.startsWith('$')) {
      expression = `$.${expression}`;
    }

    try {
      const results = query(document, expression);

      switch (arrayHandling) {
        case 'array':
          return { success: true, value: results };
        case 'join_space':
        case 'join_comma':
        case 'concat': {
          if (results.some((r) => typeof r === 'object' && r !== null)) {
            return {
              success: false,
              error: `JSONPath results contain objects that cannot be joined into a string`,
              useOriginal: false,
            };
          }
          const delimiter = arrayHandling === 'join_space' ? ' ' : arrayHandling === 'join_comma' ? ', ' : '';
          return { success: true, value: results.map(String).join(delimiter) };
        }
        case 'first':
        default:
          return { success: true, value: results[0] };
      }
    } catch (err) {
      return {
        success: false,
        error: `Invalid JSONPath expression: ${err instanceof Error ? err.message : String(err)}`,
        useOriginal: false,
      };
    }
  },
};

// Auto-register on import
registerTransformer(jsonpathTransformer);
