import { JSONPathOptions, TransformerTypes } from '@spinner/shared-types';
import { JsonValue, query } from 'jsonpath-rfc9535';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * JSONPath transformer that extracts values from complex JSON structures
 * using RFC 9535 JSONPath expressions.
 *
 * If the source value is a string, it attempts to JSON.parse it first.
 * Returns the matched value (unwrapped if single), or the full array for multiple matches.
 */
export const jsonpathTransformer: FieldTransformer = {
  type: TransformerTypes.JSONPath,

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options, phase } = ctx;
    const { arrayHandling = 'first' } = options as JSONPathOptions;
    let { expression } = options as JSONPathOptions;

    if (phase !== 'DATA') {
      return { success: true, skip: true };
    }

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

      if (results.length === 0) {
        return {
          success: false,
          error: `JSONPath expression "${expression}" matched no values`,
          useOriginal: false,
        };
      }

      if (results.length === 1) {
        return { success: true, value: results[0] };
      }

      switch (arrayHandling) {
        case 'array':
          return { success: true, value: results };
        case 'join_space':
          return { success: true, value: results.map(String).join(' ') };
        case 'join_comma':
          return { success: true, value: results.map(String).join(', ') };
        case 'concat':
          return { success: true, value: results.map(String).join('') };
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
