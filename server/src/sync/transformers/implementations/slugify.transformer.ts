import { TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Transforms a string value into a URL-friendly slug.
 *
 * Rules (Webflow + WordPress compatible):
 * - Lowercase everything
 * - Replace spaces and underscores with hyphens
 * - Strip diacritics/accents (é → e, ñ → n)
 * - Remove all characters that aren't [a-z0-9-]
 * - Collapse consecutive hyphens into one
 * - Trim leading/trailing hyphens
 */
export const slugifyTransformer: FieldTransformer = {
  type: TransformerTypes.Slugify,

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, phase } = ctx;

    if (phase !== 'DATA') {
      return { success: true, skip: true };
    }

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

    const slug = sourceValue
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip combining marks (diacritics)
      .toLowerCase()
      .replace(/[\s_]/g, '-') // spaces and underscores → hyphens
      .replace(/[^a-z0-9-]/g, '') // remove non-alphanumeric except hyphens
      .replace(/-{2,}/g, '-') // collapse consecutive hyphens
      .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens

    return { success: true, value: slug };
  },
};

// Auto-register on import
registerTransformer(slugifyTransformer);
