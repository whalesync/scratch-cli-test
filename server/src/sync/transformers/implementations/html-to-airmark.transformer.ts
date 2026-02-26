import { TransformerTypes } from '@spinner/shared-types';
import {
  AirmarkConversionError,
  htmlToAirMark,
} from '../../../remote-service/connectors/library/airtable/conversion/airtable-html-to-airmark-converter';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

export const htmlToAirmarkTransformer: FieldTransformer = {
  type: TransformerTypes.HtmlToAirmark,

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue } = ctx;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string') {
      return {
        success: false,
        error: `Expected string for HTML value, got ${typeof sourceValue}`,
        useOriginal: true,
      };
    }

    if (sourceValue === '') {
      return { success: true, value: '' };
    }

    const result = await htmlToAirMark(sourceValue);
    if (result instanceof AirmarkConversionError) {
      return { success: false, error: result.message };
    }

    return { success: true, value: result };
  },
};

registerTransformer(htmlToAirmarkTransformer);
