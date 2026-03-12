import { TSchema, Type } from '@sinclair/typebox';
import { StringToNumberOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

function getSchemaType(schema: TSchema): string | undefined {
  return (schema as { type?: string }).type;
}

/**
 * Transforms a string value to a number.
 *
 * Options:
 * - stripCurrency: Remove currency symbols before parsing
 * - parseInteger: Use parseInt instead of parseFloat (rounds down)
 */
export const stringToNumberTransformer: FieldTransformer = {
  type: TransformerTypes.StringToNumber,

  returnType: (inputType: TSchema) => {
    const t = getSchemaType(inputType);
    if (t !== 'string' && t !== 'number') {
      throw new Error(`String to Number expects string or number input, got ${t ?? 'unknown'}`);
    }
    return Type.Number();
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const typedOptions = options as StringToNumberOptions;

    // Handle null/undefined
    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Already a number
    if (typeof sourceValue === 'number') {
      if (typedOptions.parseInteger) {
        return { success: true, value: Math.floor(sourceValue) };
      }
      return { success: true, value: sourceValue };
    }

    // Must be a string to transform
    if (typeof sourceValue !== 'string') {
      return {
        success: false,
        error: `Expected string or number, got ${typeof sourceValue}`,
        useOriginal: true,
      };
    }

    let cleanedValue = sourceValue.trim();

    // Strip currency symbols if requested
    if (typedOptions.stripCurrency) {
      // Common currency symbols
      cleanedValue = cleanedValue.replace(/[$€£¥₹₽₩₴₸₪฿₫₦₵₲]/g, '');
      // Also remove commas used as thousands separators
      cleanedValue = cleanedValue.replace(/,/g, '');
      cleanedValue = cleanedValue.trim();
    }

    // Empty string after cleaning
    if (cleanedValue === '') {
      return { success: true, value: null };
    }

    // Parse the number
    const parsedValue = typedOptions.parseInteger ? parseInt(cleanedValue, 10) : parseFloat(cleanedValue);

    if (isNaN(parsedValue)) {
      return {
        success: false,
        error: `Could not parse "${sourceValue}" as a number`,
        useOriginal: true,
      };
    }

    return { success: true, value: parsedValue };
  },
};

// Auto-register on import
registerTransformer(stringToNumberTransformer);
