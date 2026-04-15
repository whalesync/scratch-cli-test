import { Type } from '@sinclair/typebox';
import { SkipIfDestMatchesOptions, TransformerTypes } from '@spinner/shared-types';
import { JsonValue, query } from 'jsonpath-rfc9535';
import isEqual from 'lodash/isEqual';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Compares extracted values from the source and destination using JSONPath expressions.
 * If they match (deep equality), returns `skip: true` to preserve the existing destination value.
 * Otherwise, passes through the source value unchanged.
 *
 * Useful when the destination stores a richer structure than the source provides
 * (e.g. Webflow VideoLink `{url, metadata}` vs a plain URL string). The comparison
 * can target a specific subfield of the destination while the source value flows through.
 *
 * Options:
 * - `sourceExpression` (default: "$") — JSONPath into the source value
 * - `destinationExpression` (default: "$") — JSONPath into the destination value
 */
export const skipIfDestMatchesTransformer: FieldTransformer = {
  type: TransformerTypes.SkipIfDestMatches,

  optionsSchema: [
    {
      key: 'sourceExpression',
      widget: 'text',
      label: 'Source Expression',
      description: 'JSONPath to extract from source value (default: $ = whole value)',
      placeholder: '$',
    },
    {
      key: 'destinationExpression',
      widget: 'text',
      label: 'Destination Expression',
      description: 'JSONPath to extract from destination value (default: $ = whole value)',
      placeholder: '$.url',
    },
  ],

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, destinationValue, options } = ctx;
    const { sourceExpression = '$', destinationExpression = '$' } = (options ?? {}) as SkipIfDestMatchesOptions;

    // Both null/undefined → skip
    if (
      (sourceValue === null || sourceValue === undefined) &&
      (destinationValue === null || destinationValue === undefined)
    ) {
      return { success: true, skip: true };
    }

    // Only compare when both sides have values
    if (
      sourceValue !== null &&
      sourceValue !== undefined &&
      destinationValue !== null &&
      destinationValue !== undefined
    ) {
      try {
        const sourceExtracted = query(sourceValue as JsonValue, sourceExpression);
        const destExtracted = query(destinationValue as JsonValue, destinationExpression);

        const sourceVal = sourceExtracted.length === 1 ? sourceExtracted[0] : sourceExtracted;
        const destVal = destExtracted.length === 1 ? destExtracted[0] : destExtracted;

        if (isEqual(sourceVal, destVal)) {
          return { success: true, skip: true };
        }
      } catch {
        // If JSONPath evaluation fails, fall through to pass the value
      }
    }

    // No match — pass through the source value unchanged
    return { success: true, value: sourceValue };
  },
};

registerTransformer(skipIfDestMatchesTransformer);
