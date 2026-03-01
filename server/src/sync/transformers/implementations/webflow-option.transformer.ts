import { TransformerTypes } from '@spinner/shared-types';
import { z } from 'zod';
import { getSchemaAtPath } from '../../schema-validator';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/** Expected schema for a Webflow Option field's anyOf entries */
const webflowOptionSchemaShape = z.object({
  anyOf: z.array(
    z.object({
      // User-readable name: what we convert FROM.
      title: z.string(),
      // Webflow internal ID: what we convert TO.
      const: z.string(),
    }),
  ),
});

/**
 * Converts a human-readable option string (e.g. "USA") to the corresponding
 * Webflow option ID (e.g. "5af437870a42563741f1d6281dfb22ca").
 *
 * Reads the destination field's JSON Schema `anyOf` entries to build the
 * title → option ID mapping at transform time.
 */
export const webflowOptionTransformer: FieldTransformer = {
  type: TransformerTypes.WebflowOption,

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, phase, destinationTableSpec, destinationFieldPath } = ctx;

    if (phase !== 'DATA') {
      return { success: true, skip: true };
    }

    if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string') {
      return { success: false, error: `Expected a string value, got ${typeof sourceValue}`, useOriginal: true };
    }

    if (!destinationTableSpec) {
      return { success: false, error: 'Schema not found for destination folder', useOriginal: true };
    }

    const rawSchema = getSchemaAtPath(destinationTableSpec.schema, destinationFieldPath);
    const parsed = webflowOptionSchemaShape.safeParse(rawSchema);
    if (!parsed.success) {
      return { success: false, error: 'Destination field is not a Webflow Option schema', useOriginal: true };
    }

    const { anyOf } = parsed.data;

    const lowerSource = sourceValue.toLowerCase();
    const match = anyOf.find((o) => o.title.toLowerCase() === lowerSource);
    if (match) {
      return { success: true, value: match.const };
    }

    return {
      success: false,
      error: `No matching Webflow option found for "${sourceValue}". Available options: ${anyOf.map((o) => o.title).join(', ')}`,
      useOriginal: true,
    };
  },
};

// Auto-register on import
registerTransformer(webflowOptionTransformer);
