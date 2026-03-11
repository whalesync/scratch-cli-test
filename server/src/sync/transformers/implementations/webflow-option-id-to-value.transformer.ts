import { TransformerTypes } from '@spinner/shared-types';
import { z } from 'zod';
import { getSchemaAtPath } from '../../schema-validator';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/** Expected schema for a Webflow Option field's anyOf entries */
const webflowOptionSchemaShape = z.object({
  anyOf: z.array(
    z.object({
      // User-readable name: what we convert TO.
      title: z.string(),
      // Webflow internal ID: what we convert FROM.
      const: z.string(),
    }),
  ),
});

/**
 * Converts a Webflow option ID (e.g. "b078d4c8613429000f373d278551e33f") to the
 * corresponding human-readable value (e.g. "a").
 *
 * Reads the source field's JSON Schema `anyOf` entries to build the
 * option ID → title mapping at transform time.
 */
export const webflowOptionIdToValueTransformer: FieldTransformer = {
  type: TransformerTypes.WebflowOptionIdToValue,

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, sourceTableSpec, sourceFieldPath } = ctx;

    if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string') {
      return { success: false, error: `Expected a string value, got ${typeof sourceValue}`, useOriginal: true };
    }

    if (!sourceTableSpec) {
      return { success: false, error: 'Schema not found for source folder', useOriginal: true };
    }

    const rawSchema = getSchemaAtPath(sourceTableSpec.schema, sourceFieldPath);
    const parsed = webflowOptionSchemaShape.safeParse(rawSchema);
    if (!parsed.success) {
      return { success: false, error: 'Source field is not a Webflow Option schema', useOriginal: true };
    }

    const { anyOf } = parsed.data;

    const match = anyOf.find((o) => o.const === sourceValue);
    if (match) {
      return { success: true, value: match.title };
    }

    return {
      success: false,
      error: `No matching Webflow option found for ID "${sourceValue}". Available IDs: ${anyOf.map((o) => o.const).join(', ')}`,
      useOriginal: true,
    };
  },
};

// Auto-register on import
registerTransformer(webflowOptionIdToValueTransformer);
