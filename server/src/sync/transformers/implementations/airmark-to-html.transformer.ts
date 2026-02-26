import { TransformerTypes } from '@spinner/shared-types';
import { airMarkToHtml } from '../../../remote-service/connectors/library/airtable/conversion/airtable-airmark-to-html-converter';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

export const airmarkToHtmlTransformer: FieldTransformer = {
  type: TransformerTypes.AirmarkToHtml,

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue } = ctx;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string') {
      return {
        success: false,
        error: `Expected string for AirMark value, got ${typeof sourceValue}`,
        useOriginal: true,
      };
    }

    if (sourceValue === '') {
      return { success: true, value: '' };
    }

    const html = await airMarkToHtml(sourceValue);
    return { success: true, value: html };
  },
};

registerTransformer(airmarkToHtmlTransformer);
