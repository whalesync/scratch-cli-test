import { TSchema, Type } from '@sinclair/typebox';
import { SerialDateOptions, TransformerTypes } from '@spinner/shared-types';
import { serialDateNumberToIsoString } from '@spinner/shared-types/transform';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';
import { collectSchemaTypeKeywords } from './epoch-to-iso.transformer';

/**
 * Converts a spreadsheet serial-date NUMBER (days since 1899-12-30, fraction = time of
 * day — the encoding Excel, Google Sheets, and LibreOffice share) to an ISO-8601
 * wall-clock string.
 *
 * Google Sheets' API returns date/time cells as serial numbers when read losslessly
 * (`valueRenderOption=UNFORMATTED_VALUE`), so without this transformer a date column
 * exports as a bare number like `46238.5` — the same failure mode `epoch_to_iso` exists
 * for. Serials are timezone-naive, so the output carries no `Z`/offset.
 */
export const serialDateToIsoTransformer: FieldTransformer = {
  type: TransformerTypes.SerialDateToIso,

  optionsSchema: [
    {
      key: 'isoShape',
      widget: 'select',
      label: 'Output shape',
      description: 'Force a date-only or date-time output; auto emits date-only for whole-day serials.',
      defaultValue: 'auto',
      selectOptions: [
        { value: 'auto', label: 'Auto' },
        { value: 'date', label: 'Date only' },
        { value: 'datetime', label: 'Date and time' },
      ],
    },
  ],

  paramType: () => Type.Number(),

  returnType: (inputType: TSchema) => {
    // Same union-aware keyword collection as epoch_to_iso; string is allowed
    // (a serial that rode through a text cell) and the runtime transform still
    // rejects values it can't read as a serial.
    const typeKeywords = collectSchemaTypeKeywords(inputType);
    const hasUnreadableTypeKeyword = typeKeywords.some(
      (keyword) => keyword !== 'number' && keyword !== 'integer' && keyword !== 'string' && keyword !== 'null',
    );
    if (hasUnreadableTypeKeyword) {
      throw new Error(`Spreadsheet Serial to Date expects a number input, got ${typeKeywords.join(' | ')}`);
    }
    return Type.String({ format: 'date-time' });
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { isoShape = 'auto' } = (options ?? {}) as SerialDateOptions;

    // Whitespace-only counts as empty — Number('  ') is 0, which would
    // otherwise silently become the 1899-12-30 epoch.
    if (
      sourceValue === null ||
      sourceValue === undefined ||
      (typeof sourceValue === 'string' && sourceValue.trim() === '')
    ) {
      return { success: true, value: null };
    }

    // A numeric string is accepted defensively (a serial that rode through a text cell).
    const serialValue = typeof sourceValue === 'string' ? Number(sourceValue) : sourceValue;
    if (typeof serialValue !== 'number' || !Number.isFinite(serialValue)) {
      return {
        success: false,
        error: `Expected a spreadsheet serial-date number, got ${
          typeof sourceValue === 'string' ? `"${sourceValue}"` : typeof sourceValue
        }`,
        useOriginal: true,
      };
    }

    const isoString = serialDateNumberToIsoString(serialValue, isoShape);
    if (isoString === null) {
      return {
        success: false,
        error: `Spreadsheet serial ${serialValue} is outside the representable date range`,
        useOriginal: true,
      };
    }
    return { success: true, value: isoString };
  },
};

// Auto-register on import
registerTransformer(serialDateToIsoTransformer);
