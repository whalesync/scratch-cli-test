import {
  type BlockObjectResponse,
  type RichTextItemResponse,
  type TableBlockObjectResponse,
  type TableRowBlockObjectResponse,
} from '@notionhq/client';
import { Type } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { TransformContext, TransformResult } from '../transformer.types';

// Define the shape of a block with children, consistent with our recursive fetcher
export type ConvertedNotionBlock = BlockObjectResponse & {
  children?: ConvertedNotionBlock[];
};

type MediaValue =
  | { type: 'external'; external: { url: string }; caption: RichTextItemResponse[] }
  | { type: 'file'; file: { url: string; expiry_time: string }; caption: RichTextItemResponse[] };

export const NotionToHtmlTransformer = {
  type: TransformerTypes.NotionToHtml,

  paramType: () => Type.Array(Type.Any()),
  returnType: () => Type.String(),
  optionsSchema: [],

  async transform(ctx: TransformContext): Promise<TransformResult> {
    const blocks = await Promise.resolve(ctx.sourceValue as ConvertedNotionBlock[]);
    if (!blocks || !Array.isArray(blocks)) {
      return { success: true, value: '' };
    }

    let html = '';
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      // Handle list merging logic
      if (block.type === 'bulleted_list_item') {
        html += '<ul>';
        while (i < blocks.length && blocks[i].type === 'bulleted_list_item') {
          html += convertNotionBlockObjectToHtml(blocks[i]);
          i++;
        }
        html += '</ul>';
        i--;
      } else if (block.type === 'numbered_list_item') {
        html += '<ol>';
        while (i < blocks.length && blocks[i].type === 'numbered_list_item') {
          html += convertNotionBlockObjectToHtml(blocks[i]);
          i++;
        }
        html += '</ol>';
        i--;
      } else {
        html += convertNotionBlockObjectToHtml(block);
      }
    }

    return { success: true, value: html };
  },
};

function convertNotionBlockObjectToHtml(input: ConvertedNotionBlock): string {
  // We use the strict BlockObjectResponse type for checking 'type'
  // but cast 'children' access since BlockObjectResponse doesn't have it by default
  const block = input;

  let subBlocksText = '';
  if (input.children && input.children.length > 0) {
    if (block.type === 'table') {
      // Tables handle their own children
    } else {
      // Recursively convert children
      const childrenHtml = input.children.map((child) => convertNotionBlockObjectToHtml(child)).join('');
      if (block.type === 'bulleted_list_item') {
        subBlocksText = `<ul>${childrenHtml}</ul>`;
      } else if (block.type === 'numbered_list_item') {
        subBlocksText = `<ol>${childrenHtml}</ol>`;
      } else {
        subBlocksText = `<div style="padding: 4px; padding-left: 24px;">${childrenHtml}</div>`;
      }
    }
  }

  // Use discriminated union to safely access properties
  switch (block.type) {
    case 'paragraph':
      return handleRichTextTypes(block.type, block.paragraph, subBlocksText);
    case 'heading_1':
      return handleRichTextTypes(block.type, block.heading_1, subBlocksText);
    case 'heading_2':
      return handleRichTextTypes(block.type, block.heading_2, subBlocksText);
    case 'heading_3':
      return handleRichTextTypes(block.type, block.heading_3, subBlocksText);
    case 'bulleted_list_item':
      return handleRichTextTypes(block.type, block.bulleted_list_item, subBlocksText);
    case 'numbered_list_item':
      return handleRichTextTypes(block.type, block.numbered_list_item, subBlocksText);
    case 'quote':
      return handleRichTextTypes(block.type, block.quote, subBlocksText);
    case 'to_do':
      return handleRichTextTypes(block.type, block.to_do, subBlocksText); // TODOChecked
    case 'toggle':
      return handleRichTextTypes(block.type, block.toggle, subBlocksText);
    case 'callout':
      return handleRichTextTypes(block.type, block.callout, subBlocksText); // CalloutIcon
    case 'image':
      return handleMediaTypes('image', block.id, block.image as MediaValue);
    case 'video':
      return handleMediaTypes('video', block.id, block.video as MediaValue);
    case 'audio': // audio type not in Notion SDK's BlockObjectResponse yet — same structure as image/video
      return handleMediaTypes('audio', block.id, (block as Record<string, unknown>).audio as MediaValue);
    case 'embed':
      return `<iframe style="width:100%;min-height:400px;" src="${block.embed.url}"></iframe>`;
    case 'divider':
      return '<hr/>';
    case 'code':
      return `<pre><code class="language-${block.code.language}">${escapeHtmlAndSpaces(
        block.code.rich_text[0]?.plain_text || '',
      )}</code></pre>`;
    case 'table':
      return convertNotionSimpleTableBlockToHtml(block, input.children);
    default:
      return '';
  }
}

function applyHtmlTagFromType(
  type: BlockObjectResponse['type'] | 'bulleted_list' | 'numbered_list' | 'summary',
  html: string,
): string {
  switch (type) {
    case 'paragraph':
      return `<p>${html}</p>`;
    case 'heading_1':
      return `<h1>${html}</h1>`;
    case 'heading_2':
      return `<h2>${html}</h2>`;
    case 'heading_3':
      return `<h3>${html}</h3>`;
    case 'bulleted_list_item':
      return `<li>${html}</li>`;
    case 'numbered_list_item':
      return `<li>${html}</li>`;
    case 'quote':
      return `<blockquote>${html}</blockquote>`;
    case 'to_do':
      // Checkbox is handled in handleRichTextTypes or needs explicit handling if we want the box
      return `<div><input type="checkbox" disabled /> ${html}</div>`;
    case 'toggle':
      // The content is in subBlocksText which is appended inside details
      return `<details><summary>${html}</summary></details>`;
    case 'callout':
      return `<div style="padding: 16px; background-color: #f1f1f1; border-radius: 4px;">${html}</div>`;
    case 'divider':
      return `<hr/>`;
    default:
      return `<div>${html}</div>`;
  }
}

function handleRichTextTypes(
  type: BlockObjectResponse['type'],
  value: { rich_text: RichTextItemResponse[] },
  subBlocksText: string,
): string {
  let blockText = '';
  // Special case for empty paragraph => <br>
  if (type === 'paragraph' && value.rich_text.length === 0) {
    blockText = '<br/>';
  }

  for (const item of value.rich_text) {
    if (item.plain_text !== undefined) {
      blockText += handleRichTextSubItem(item);
    }
  }

  if (type === 'toggle') {
    // For toggle, the blockText is the summary, and subBlocksText is the content
    return `<details><summary>${blockText}</summary>${subBlocksText}</details>`;
  }

  // Append sub-blocks for other types (like indented lists or paragraphs with children)
  return applyHtmlTagFromType(type, blockText + subBlocksText);
}

function handleRichTextSubItem(value: RichTextItemResponse): string {
  let blockText = sanitizeAndApplyAnnotations(value.plain_text, value.annotations);

  if (value.type === 'text') {
    const textObj = value;
    const url = textObj.text.link?.url;
    if (url !== undefined) {
      blockText = `<a href="${url}">${blockText}</a>`;
    }
  }

  return blockText;
}

function convertNotionSimpleTableBlockToHtml(
  tableBlock: TableBlockObjectResponse,
  children: ConvertedNotionBlock[] | undefined,
): string {
  const tableValue = tableBlock.table;
  const hasColumnHeader: boolean = tableValue.has_column_header;
  const hasRowHeader: boolean = tableValue.has_row_header;

  let tableInner = '';

  if (children) {
    for (let i = 0; i < children.length; i++) {
      const rowBlock = children[i] as unknown as TableRowBlockObjectResponse;
      if (rowBlock.type !== 'table_row') continue;

      const cells = rowBlock.table_row.cells;
      let rowHtml = '';

      for (let j = 0; j < cells.length; j++) {
        const cellContent = cells[j].map((c) => handleRichTextSubItem(c)).join('');
        const isHeader = (hasColumnHeader && i === 0) || (hasRowHeader && j === 0);
        const tag = isHeader ? 'th' : 'td';
        rowHtml += `<${tag} style="border: 1px solid #ddd; padding: 8px;">${cellContent}</${tag}>`;
      }
      tableInner += `<tr>${rowHtml}</tr>`;
    }
  }

  return `<table style="border-collapse: collapse; width: 100%;">${tableInner}</table>`;
}

function handleMediaTypes(type: 'image' | 'video' | 'audio', blockId: string, value: MediaValue): string {
  let url: string | undefined = undefined;

  if (value.type === 'external') {
    url = value.external?.url;
  } else if (value.type === 'file') {
    url = value.file?.url;
  }

  if (!url) {
    return '';
  }

  let caption: string | undefined = undefined;
  if (value.caption && value.caption.length > 0) {
    caption = value.caption[0]?.plain_text || '';
  }

  const style = `width:100%;height:auto;`;
  if (type === 'image' && url !== undefined) {
    let imageHtml = caption
      ? `<img style="${style}" src="${url}" alt="${caption}">`
      : `<img style="${style}" src="${url}">`;
    if (url.includes('unsplash.com')) {
      const sourceUrl = caption ? caption : url;
      imageHtml += `<br/><a href="${sourceUrl}" style="color:#999;font-size:12px">Photo by Unsplash</a>`;
    }
    return imageHtml;
  }

  if (type === 'video' && url !== undefined) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const videoId = url.split('v=')[1] || url.split('/').pop();
      return `<iframe width="100%" height="315" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    }
    if (url.includes('vimeo.com')) {
      const videoId = url.split('/').pop();
      return `<iframe src="https://player.vimeo.com/video/${videoId}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
    }
    // Generic video
  }

  // Fallback for generic file/link
  const href = url;
  return `<p style="${style}"><a href="${href}" target="_blank">${href}</a><br/>${caption}</p>`;
}

function sanitizeAndApplyAnnotations(text: string, annotations: RichTextItemResponse['annotations']): string {
  let content = escapeHtmlAndSpaces(text);

  if (annotations.bold) content = `<b>${content}</b>`;
  if (annotations.italic) content = `<i>${content}</i>`;
  if (annotations.strikethrough) content = `<s>${content}</s>`;
  if (annotations.underline) content = `<u>${content}</u>`;
  if (annotations.code) content = `<code>${content}</code>`;
  if (annotations.color && annotations.color !== 'default') {
    content = `<span style="color:${annotations.color}">${content}</span>`;
  }

  return content;
}

function escapeHtmlAndSpaces(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

registerTransformer(NotionToHtmlTransformer);
