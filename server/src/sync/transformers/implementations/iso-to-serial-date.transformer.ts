import { TSchema, Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import { isoStringToSerialDateNumber } from '@spinner/shared-types/transform';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';
import { collectSchemaTypeKeywords } from './epoch-to-iso.transformer';

/**
 * Converts an ISO-8601 date / date-time string to a spreadsheet serial-date NUMBER
 * (days since 1899-12-30, fraction = time of day). The inverse of `serial_date_to_iso`.
 *
 * This is the destination pack for Google Sheets date columns created by Live Export:
 * writing the serial with `valueInputOption=RAW` into a DATE/DATE_TIME-formatted column
 * renders as a real date, with no dependence on the spreadsheet's locale (writing the
 * ISO string with USER_ENTERED would gamble on Google's locale-sensitive parsing, and
 * writing it RAW would store text in a date column).
 *
 * Timezone handling: a bare wall-clock string converts verbatim; a `Z`/offset-suffixed
 * instant becomes the serial of its UTC wall clock.
 */
export const isoToSerialDateTransformer: FieldTransformer = {
  type: TransformerTypes.IsoToSerialDate,

  optionsSchema: [],

  paramType: () => Type.String(),

  returnType: (inputType: TSchema) => {
    // Same union-aware keyword collection as epoch_to_iso; number is allowed
    // (already a serial, passed through) and the runtime transform still
    // rejects strings it can't parse as an ISO date.
    const typeKeywords = collectSchemaTypeKeywords(inputType);
    const hasUnreadableTypeKeyword = typeKeywords.some(
      (keyword) => keyword !== 'string' && keyword !== 'number' && keyword !== 'integer' && keyword !== 'null',
    );
    if (hasUnreadableTypeKeyword) {
      throw new Error(`Date to Spreadsheet Serial expects a date string input, got ${typeKeywords.join(' | ')}`);
    }
    return Type.Number();
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue } = ctx;

    if (
      sourceValue === null ||
      sourceValue === undefined ||
      (typeof sourceValue === 'string' && sourceValue.trim() === '')
    ) {
      return { success: true, value: null };
    }

    // Already a number: treat as an existing serial and pass through (idempotent when a
    // Sheets→Sheets sync routes a date column through the pack twice).
    if (typeof sourceValue === 'number' && Number.isFinite(sourceValue)) {
      return { success: true, value: sourceValue };
    }

    if (typeof sourceValue !== 'string') {
      return {
        success: false,
        error: `Expected an ISO date string, got ${typeof sourceValue}`,
        useOriginal: true,
      };
    }

    const serialValue = isoStringToSerialDateNumber(sourceValue);
    if (serialValue === null) {
      return {
        success: false,
        error: `Could not parse "${sourceValue}" as an ISO date`,
        useOriginal: true,
      };
    }
    return { success: true, value: serialValue };
  },
};

// Auto-register on import
registerTransformer(isoToSerialDateTransformer);
