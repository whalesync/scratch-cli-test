import { Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { TransformContext, TransformResult } from '../transformer.types';

/**
 * Convert a Sanity Portable Text array (https://portabletext.org) to HTML.
 *
 * Portable Text stores rich text as an array of typed objects. Text lives in
 * `_type: 'block'` items: each block has a `style` (`normal`, `h1`…`h6`,
 * `blockquote`), `children` spans carrying `text` + `marks`, and `markDefs`
 * holding data-carrying annotations (links) the marks reference by `_key`.
 * List membership is a `listItem` + `level` on the block itself — consecutive
 * list blocks are merged into `<ul>`/`<ol>` runs here.
 *
 * Read-only direction (Portable Text → HTML) for Live Export destinations.
 * Non-text custom blocks (image embeds, code blocks, a customer's own types)
 * are skipped — rendering them needs per-type knowledge (and, for images,
 * asset-URL resolution) this transformer doesn't have.
 */

interface PortableTextSpan {
  _type?: string;
  text?: string;
  marks?: string[];
}

interface PortableTextMarkDef {
  _key?: string;
  _type?: string;
  href?: string;
}

interface PortableTextBlock {
  _type?: string;
  style?: string;
  listItem?: string;
  level?: number;
  children?: PortableTextSpan[];
  markDefs?: PortableTextMarkDef[];
}

/** Decorator marks (plain strings in `marks`) → HTML tag. */
const DECORATOR_MARK_TO_HTML_TAG: Record<string, string> = {
  strong: 'strong',
  em: 'em',
  underline: 'u',
  'strike-through': 's',
  code: 'code',
};

const BLOCK_STYLE_TO_HTML_TAG: Record<string, string> = {
  normal: 'p',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  blockquote: 'blockquote',
};

export const PortableTextToHtmlTransformer = {
  type: TransformerTypes.PortableTextToHtml,

  paramType: () => Type.Array(Type.Any()),
  returnType: () => Type.String(),
  optionsSchema: [],

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const blocks = ctx.sourceValue as PortableTextBlock[];
    if (!blocks || !Array.isArray(blocks)) {
      return { success: true, value: '' };
    }

    let html = '';
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      if (block?._type === 'block' && block.listItem) {
        // Merge the consecutive run of list blocks into nested <ul>/<ol> lists.
        const listRun: PortableTextBlock[] = [];
        while (blockIndex < blocks.length && blocks[blockIndex]?._type === 'block' && blocks[blockIndex].listItem) {
          listRun.push(blocks[blockIndex]);
          blockIndex++;
        }
        blockIndex--;
        html += convertListRunToHtml(listRun);
      } else if (block?._type === 'block') {
        const tag = BLOCK_STYLE_TO_HTML_TAG[block.style ?? 'normal'] ?? 'p';
        html += `<${tag}>${convertSpansToHtml(block)}</${tag}>`;
      }
      // Any other _type is a custom object block (image, code, customer types) — skipped.
    }

    return { success: true, value: html };
  },
};

/** Render one run of consecutive list blocks, opening/closing lists as `level` moves. */
function convertListRunToHtml(listRun: PortableTextBlock[]): string {
  let html = '';
  const openListTagStack: string[] = [];

  for (const listBlock of listRun) {
    const targetLevel = Math.max(1, listBlock.level ?? 1);
    const listTag = listBlock.listItem === 'number' ? 'ol' : 'ul';

    while (openListTagStack.length > targetLevel) {
      html += `</${openListTagStack.pop() ?? 'ul'}>`;
    }
    if (openListTagStack.length === targetLevel && openListTagStack[openListTagStack.length - 1] !== listTag) {
      html += `</${openListTagStack.pop() ?? 'ul'}>`;
    }
    while (openListTagStack.length < targetLevel) {
      html += `<${listTag}>`;
      openListTagStack.push(listTag);
    }

    html += `<li>${convertSpansToHtml(listBlock)}</li>`;
  }

  while (openListTagStack.length > 0) {
    html += `</${openListTagStack.pop() ?? 'ul'}>`;
  }
  return html;
}

function convertSpansToHtml(block: PortableTextBlock): string {
  if (!block.children || !Array.isArray(block.children)) return '';
  return block.children.map((span) => convertOneSpanToHtml(span, block.markDefs ?? [])).join('');
}

function convertOneSpanToHtml(span: PortableTextSpan, markDefs: PortableTextMarkDef[]): string {
  let spanHtml = escapeHtml(span.text ?? '');

  for (const mark of span.marks ?? []) {
    const decoratorTag = DECORATOR_MARK_TO_HTML_TAG[mark];
    if (decoratorTag) {
      spanHtml = `<${decoratorTag}>${spanHtml}</${decoratorTag}>`;
      continue;
    }
    // Not a known decorator — a markDef key. Links render; unknown annotation
    // types pass the text through unwrapped rather than dropping it.
    const markDef = markDefs.find((def) => def._key === mark);
    if (markDef?._type === 'link' && markDef.href) {
      spanHtml = `<a href="${escapeHtml(markDef.href)}">${spanHtml}</a>`;
    }
  }

  return spanHtml;
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

registerTransformer(PortableTextToHtmlTransformer);
