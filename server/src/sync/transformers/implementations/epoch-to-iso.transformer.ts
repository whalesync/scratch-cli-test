import { TSchema, Type } from '@sinclair/typebox';
import { EpochToIsoOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Milliseconds either side of the epoch that `new Date(ms)` can represent. Outside this
 * range the Date is Invalid and `toISOString()` throws, so we reject the value instead.
 */
const MAX_REPRESENTABLE_EPOCH_MILLISECONDS = 8.64e15;

/**
 * The JSON-Schema `type` keywords this transformer will accept as input. A nullable field is
 * declared as a union (`anyOf: [{type:'number'}, {type:'null'}]`) with no top-level `type`, so
 * the union arms are unwrapped before checking — otherwise every optional epoch field (Stripe's
 * `canceled_at`, `trial_end`, …) would fail the type trace.
 */
export function collectSchemaTypeKeywords(schema: TSchema): string[] {
  const unionArms = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (unionArms) {
    return unionArms.flatMap((arm) => collectSchemaTypeKeywords(arm));
  }
  const typeKeyword = (schema as TSchema & { type?: string }).type;
  return typeKeyword ? [typeKeyword] : [];
}

/**
 * Converts a Unix-epoch timestamp to an ISO-8601 date-time string.
 *
 * Services that report times as bare epoch numbers (Stripe, Intercom, ClickUp) otherwise export
 * a date as a raw number — a destination creates a number column and the user gets `1785436554`
 * where they expected a date. Note that annotating the schema `format: 'date-time'` alone is not
 * a fix and actively makes things worse: the plan generator would create a real date column and
 * still hand the destination the bare integer, turning "wrong type" into "publish failure or
 * 1970". The conversion has to happen here, in the value pipeline.
 *
 * Options:
 * - `unit` (default: `'seconds'`) — unit of the incoming value.
 */
export const epochToIsoTransformer: FieldTransformer = {
  type: TransformerTypes.EpochToIso,

  optionsSchema: [
    {
      key: 'unit',
      widget: 'select',
      label: 'Source unit',
      description: 'Unit of the incoming Unix timestamp.',
      defaultValue: 'seconds',
      selectOptions: [
        { value: 'seconds', label: 'Seconds' },
        { value: 'milliseconds', label: 'Milliseconds' },
      ],
    },
  ],

  paramType: () => Type.Number(),

  returnType: (inputType: TSchema) => {
    const typeKeywords = collectSchemaTypeKeywords(inputType);
    // An unannotated schema (no `type` at all) is allowed through: we know nothing about it,
    // and the runtime `transform` still rejects a value it can't read as an epoch.
    const hasUnreadableTypeKeyword = typeKeywords.some(
      (keyword) => keyword !== 'number' && keyword !== 'integer' && keyword !== 'string' && keyword !== 'null',
    );
    if (hasUnreadableTypeKeyword) {
      throw new Error(`Unix Timestamp to Date expects a number input, got ${typeKeywords.join(' | ')}`);
    }
    return Type.String({ format: 'date-time' });
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { unit = 'seconds' } = (options ?? {}) as EpochToIsoOptions;

    if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
      return { success: true, value: null };
    }

    // A numeric string is accepted because some services store epochs as strings (ClickUp).
    const epochValue = typeof sourceValue === 'string' ? Number(sourceValue) : sourceValue;

    if (typeof epochValue !== 'number' || !Number.isFinite(epochValue)) {
      return {
        success: false,
        error: `Expected a Unix timestamp number, got ${typeof sourceValue === 'string' ? `"${sourceValue}"` : typeof sourceValue}`,
        useOriginal: true,
      };
    }

    const epochMilliseconds = unit === 'seconds' ? epochValue * 1000 : epochValue;

    if (Math.abs(epochMilliseconds) > MAX_REPRESENTABLE_EPOCH_MILLISECONDS) {
      return {
        success: false,
        error: `Unix timestamp ${epochValue} (${unit}) is outside the representable date range`,
        useOriginal: true,
      };
    }

    return { success: true, value: new Date(epochMilliseconds).toISOString() };
  },
};

// Auto-register on import
registerTransformer(epochToIsoTransformer);
