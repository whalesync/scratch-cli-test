import { Type } from '@sinclair/typebox';
import { SkipIfDestArrayMatchesOptions, TransformerTypes } from '@spinner/shared-types';
import { JsonValue, query } from 'jsonpath-rfc9535';
import isEqual from 'lodash/isEqual';
import sortBy from 'lodash/sortBy';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Compares two arrays element-wise using JSONPath expressions to extract comparable
 * values from each element. If the extracted value sets match, returns `skip: true`
 * to preserve the existing destination value (which may contain richer data like IDs).
 *
 * Options:
 * - `sourceElementExpression` (default: "$") — JSONPath to extract a comparable value from each source element
 * - `destinationElementExpression` (default: "$") — JSONPath to extract a comparable value from each dest element
 * - `matchOrdering` (default: false) — whether element order must match
 *
 * Example use case: Moco tags ["Tag 1", "Tag 2"] vs Audienceful tags [{id: 1, name: "Tag 1"}, {id: 2, name: "Tag 2"}]
 *   sourceElementExpression: "$"
 *   destinationElementExpression: "$.name"
 *   → extracts ["Tag 1", "Tag 2"] from both sides, matches, skips (preserving IDs in dest)
 */
export const skipIfDestArrayMatchesTransformer: FieldTransformer = {
  type: TransformerTypes.SkipIfDestArrayMatches,

  optionsSchema: [
    {
      key: 'sourceElementExpression',
      widget: 'text',
      label: 'Source Element Expression',
      description: 'JSONPath to extract a comparable value from each source element (default: $ = whole element)',
      placeholder: '$',
    },
    {
      key: 'destinationElementExpression',
      widget: 'text',
      label: 'Destination Element Expression',
      description: 'JSONPath to extract a comparable value from each destination element (default: $ = whole element)',
      placeholder: '$.name',
    },
    {
      key: 'matchOrdering',
      widget: 'checkbox',
      label: 'Match ordering (elements must appear in the same order)',
      defaultValue: false,
    },
  ],

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, destinationValue, options } = ctx;
    const {
      sourceElementExpression = '$',
      destinationElementExpression = '$',
      matchOrdering = false,
    } = (options ?? {}) as SkipIfDestArrayMatchesOptions;

    // Both null/undefined → skip
    if (
      (sourceValue === null || sourceValue === undefined) &&
      (destinationValue === null || destinationValue === undefined)
    ) {
      return { success: true, skip: true };
    }

    // Both empty arrays → skip
    if (Array.isArray(sourceValue) && Array.isArray(destinationValue)) {
      if (sourceValue.length === 0 && destinationValue.length === 0) {
        return { success: true, skip: true };
      }
    }

    // Only compare when both sides are arrays
    if (Array.isArray(sourceValue) && Array.isArray(destinationValue)) {
      try {
        const sourceExtracted = sourceValue.map((el) => extractValue(el, sourceElementExpression));
        const destExtracted = destinationValue.map((el) => extractValue(el, destinationElementExpression));

        const matches = matchOrdering
          ? isEqual(sourceExtracted, destExtracted)
          : isEqual(sortBy(sourceExtracted, JSON.stringify), sortBy(destExtracted, JSON.stringify));

        if (matches) {
          return { success: true, skip: true };
        }
      } catch {
        // If extraction fails, fall through to pass the value
      }
    }

    // No match — pass through the source value unchanged
    return { success: true, value: sourceValue };
  },
};

/**
 * Extract a single comparable value from an element using a JSONPath expression.
 */
function extractValue(element: unknown, expression: string): unknown {
  if (expression === '$') {
    return element;
  }
  const results = query(element as JsonValue, expression);
  return results.length === 1 ? results[0] : results;
}

registerTransformer(skipIfDestArrayMatchesTransformer);
