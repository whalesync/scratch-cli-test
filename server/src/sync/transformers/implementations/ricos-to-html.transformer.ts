import { Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import { WixToHtmlConverter } from '../../../remote-service/connectors/library/wix/rich-content/ricos-to-html';
import { isWixDocument } from '../../../remote-service/connectors/library/wix/rich-content/types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Renders a Wix Ricos rich-content document to HTML.
 *
 * Ricos is the node tree Wix Blog stores a post body as — `{ nodes: [...], metadata, documentStyle }`.
 * We keep that tree verbatim on disk (Connector Prime Directive), so without this transformer the
 * body reaches every destination as an unreadable multi-thousand-character JSON blob (DEV-11114).
 *
 * This is the `toCore` half of the Wix Blog `Content` column's codec: it runs when the value leaves
 * Scratch for a destination, and never on the way in. There is deliberately no `fromCore` — HTML
 * round-tripping back into Ricos is `HtmlToWixConverter`'s job on the connector's publish path, not
 * something the sync engine should attempt implicitly.
 *
 * A value that isn't a Ricos document passes through untouched rather than erroring: `richContent`
 * is optional on a draft post, and a post with no body should export as empty, not as a failed field.
 */
export const ricosToHtmlTransformer: FieldTransformer = {
  type: TransformerTypes.RicosToHtml,

  paramType: () => Type.Object({}, { additionalProperties: true }),
  returnType: () => Type.String(),
  optionsSchema: [],

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue } = ctx;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // `isWixDocument` only checks for a `nodes` array — a body Wix returned with no nodes at all,
    // or a value that never was a Ricos document, has nothing to render.
    if (!isWixDocument(sourceValue as never)) {
      return { success: true, value: '' };
    }

    const html = new WixToHtmlConverter({ prettify: false }).convert(sourceValue as never);
    return { success: true, value: html };
  },
};

// Auto-register on import
registerTransformer(ricosToHtmlTransformer);
