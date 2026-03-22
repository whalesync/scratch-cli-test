import type {
  BlockObjectResponse,
  RichTextItemResponse,
  TextRichTextItemResponse,
} from '@notionhq/client/build/src/api-endpoints';
import * as cheerio from 'cheerio';
import { ElementType } from 'domelementtype';
import { ChildNode } from 'domhandler';
import * as _ from 'lodash';
import { isArray } from 'lodash';
import { minifyHtml } from '../../../../../wrappers/html-minify';
import { escapeHtmlAndSpaces, isHtmlBlockLevelTag, unescapeSafeSpacesInHtml } from './notion-conversion-helpers';
import type { ConvertedNotionBlock } from './notion-rich-text-push-types';

/**
 * Annotation structure for rich text formatting
 */
type NotionAnnotations = TextRichTextItemResponse['annotations'];

/**
 * Value structure for media blocks (image, video, audio).
 * Each media block has a type discriminator and optional caption array.
 */
interface NotionMediaValue {
  type: 'external' | 'file';
  external?: { url: string };
  file?: { url: string; expiry_time?: string };
  caption: RichTextItemResponse[];
}

/**
 * Value structure for blocks containing rich text (paragraph, heading, list items, etc.).
 * Includes optional `checked` for to_do blocks.
 */
interface NotionRichTextBlockValue {
  rich_text: RichTextItemResponse[] | RichTextItemResponse;
  checked?: boolean;
  [key: string]: unknown;
}

/**
 * Value structure for link-type blocks (bookmark, embed, link_preview).
 */
interface NotionLinkValue {
  url: string;
  caption?: RichTextItemResponse[];
}

/**
 * Color type for Notion blocks and rich text
 */
type NotionColor = NotionAnnotations['color'];

/**
 * Notion block object that may include children (API responses don't include children,
 * but our internal representations do for hierarchical operations)
 */
export type NotionBlockObject = ConvertedNotionBlock | BlockObjectResponse;

/**
 * A helpful intermediate data structure used to convert HTML to Notion rich text. In the parsing process, we **might**
 * need to surround both sides of a block-level element with a newline, but whether it gets translated into a newline
 * depends on whether the previous item is also a block-level element.
 */
type IntermediateRichTextItem =
  | RichTextItemResponse
  | { type: 'block_element_boundary'; annotations: NotionAnnotations };

function getUnstyledHtml(richTextItem: RichTextItemResponse): string {
  if (richTextItem.type === 'text') {
    let html = escapeHtmlAndSpaces(richTextItem.text.content);
    html = html.replaceAll('\n', '<br>');

    if (richTextItem.text?.link?.url) {
      html = `<a href="${richTextItem.text.link.url}">${html}</a>`;
    }
    return html;
  } else if (richTextItem.type === 'equation') {
    return escapeHtmlAndSpaces(richTextItem.equation.expression);
  } else if (richTextItem.type === 'mention') {
    return escapeHtmlAndSpaces(richTextItem.plain_text);
  } else {
    return '';
  }
}

function notionColorsToCssColors(annotations: NotionAnnotations): {
  color?: string;
  backgroundColor?: string;
} {
  // Thanks Tem! https://optemization.com/notion-color-guide
  switch (annotations.color.toLowerCase()) {
    case 'gray':
      return { color: '#9B9A97' };
    case 'brown':
      return { color: '#64473A' };
    case 'orange':
      return { color: '#D9730D' };
    case 'yellow':
      return { color: '#DFAB01' };
    case 'green':
      return { color: '#0F7B6C' };
    case 'blue':
      return { color: '#0B6E99' };
    case 'purple':
      return { color: '#6940A5' };
    case 'pink':
      return { color: '#AD1A72' };
    case 'red':
      return { color: '#E03E3E' };
    case 'gray_background':
      return { backgroundColor: '#EBECED' };
    case 'brown_background':
      return { backgroundColor: '#E9E5E3' };
    case 'orange_background':
      return { backgroundColor: '#FAEBDD' };
    case 'yellow_background':
      return { backgroundColor: '#FBF3DB' };
    case 'green_background':
      return { backgroundColor: '#DDEDEA' };
    case 'blue_background':
      return { backgroundColor: '#DDEBF1' };
    case 'purple_background':
      return { backgroundColor: '#EAE4F2' };
    case 'pink_background':
      return { backgroundColor: '#F4DFEB' };
    case 'red_background':
      return { backgroundColor: '#FBE4E4' };
    default:
      // We don't know what color this is, so fall through.
      break;
  }
  return {};
}

export function cssColorsToNotionColors(args: { color?: string; backgroundColor?: string }): NotionColor | undefined {
  // Thanks Tem! https://optemization.com/notion-color-guide
  switch (args.color?.toUpperCase()) {
    case '#9B9A97':
      return 'gray';
    case '#64473A':
      return 'brown';
    case '#D9730D':
      return 'orange';
    case '#DFAB01':
      return 'yellow';
    case '#0F7B6C':
      return 'green';
    case '#0B6E99':
      return 'blue';
    case '#6940A5':
      return 'purple';
    case '#AD1A72':
      return 'pink';
    case '#E03E3E':
      return 'red';
    default:
      // We don't know what color this is, so fall through.
      break;
  }

  switch (args.backgroundColor?.toUpperCase()) {
    case '#EBECED':
      return 'gray_background';
    case '#E9E5E3':
      return 'brown_background';
    case '#FAEBDD':
      return 'orange_background';
    case '#FBF3DB':
      return 'yellow_background';
    case '#DDEDEA':
      return 'green_background';
    case '#DDEBF1':
      return 'blue_background';
    case '#EAE4F2':
      return 'purple_background';
    case '#F4DFEB':
      return 'pink_background';
    case '#FBE4E4':
      return 'red_background';
    default:
      // We don't know what color this is, so fall through.
      break;
  }
  return undefined;
}

export function applyHtmlTagFromType(type: string, html: string): string {
  switch (type) {
    case 'paragraph':
      if (html === '') {
        return `<p><br></p>`;
      }
      return `<p>${html}</p>`;
    case 'heading_1':
      return `<h1>${html}</h1>`;
    case 'heading_2':
      return `<h2>${html}</h2>`;
    case 'heading_3': {
      // Check if this heading_3 contains markdown heading syntax for h4, h5, h6
      const convertedMarkdownHtml = convertMarkdownHeadingsToHtml(html);
      if (convertedMarkdownHtml !== html) {
        // This was a markdown heading (h4, h5, h6), return the converted HTML directly
        return convertedMarkdownHtml;
      }
      return `<h3>${html}</h3>`;
    }
    case 'bulleted_list':
      return `<ul>${html}</ul>`;
    case 'numbered_list':
      return `<ol>${html}</ol>`;
    case 'bulleted_list_item':
    case 'numbered_list_item':
      return `<li>${html}</li>`;
    case 'code': {
      const style = 'background-color:#f1f1f1; padding:20px; width:100%; font-size:115%;';
      return `<div style="${style}"><code>${html}</code></div>`;
    }
    case 'quote':
      return `<blockquote>${html}</blockquote>`;
    case 'child_page':
      if (html === undefined || html === '') {
        return '';
      }
      return `<article>${html}</article>`;
    case 'divider':
      return `<hr/>`;
    case 'toggle':
      return `<details>${html}</details>`;
    case 'to_do':
      return `<div><label>${html}</label></div>`;
    case 'summary':
      return `<summary>${html}</summary>`;
    case 'description_list':
      return `<dl>${html}</dl>`;
    case 'description_term':
      return `<dt>${html}</dt>`;
    case 'description_definition':
      return `<dd>${html}</dd>`;
    default:
      return `<div>${html}</div>`;
  }
}

// For more information: https://www.w3schools.com/tags/att_source_type.asp
function detectMediaFormat(fileName: string): string | undefined {
  if (fileName.endsWith('mp4')) {
    return 'mp4';
  } else if (fileName.endsWith('mp3')) {
    return 'mpeg';
  } else if (fileName.endsWith('ogg')) {
    return 'ogg';
  } else if (fileName.endsWith('webm')) {
    return 'webm';
  }
  return undefined;
}

/**
 * Handles media block types (image, video, audio)
 * @param value - Block-specific value structure (e.g., ImageBlockObjectResponse['image'])
 */
export function handleMediaTypes(type: 'image' | 'video' | 'audio', value: NotionMediaValue): string {
  let url: string | undefined = undefined;
  if (value.type === 'external') {
    url = value.external?.url;
  } else if (value.type === 'file') {
    url = value.file?.url;
  } else {
    return '';
  }

  let caption: string | undefined = undefined;
  if ((type === 'image' || type === 'video' || type === 'audio') && value.caption[0] !== undefined) {
    caption = value.caption[0] !== undefined ? value.caption[0]?.plain_text : '';
  }

  const style = `width:100%;height:auto;`;
  if (type === 'image' && url !== undefined) {
    let imageHtml = caption
      ? `<img style="${style}" src="${url}" alt="${caption}">`
      : `<img style="${style}" src="${url}">`;
    if (url.includes('unsplash.com')) {
      const parseUrl = new URL(url);
      const unsplashImageType = parseUrl.searchParams.get('fm');
      imageHtml = `<embed style="${style}" type="image/${unsplashImageType}" src="${url}">`;
    }

    // Always wrap in figure tag for semantic HTML
    if (caption !== undefined && caption !== '') {
      const captionHtml = `<figcaption align="center">${caption}</figcaption>`;
      return `<figure>${imageHtml}${captionHtml}</figure>`;
    } else {
      return `<figure>${imageHtml}</figure>`;
    }
  } else if ((type === 'video' || type === 'audio') && url !== undefined) {
    const iframeStyle = 'width:100%;aspect-ratio:16/9';
    let mediaHtml = '';

    if (url.includes('youtube')) {
      const parseUrl = new URL(url);
      const youtubeVideoId = parseUrl.searchParams.get('v');
      const title = 'YouTube video player';
      mediaHtml = `<iframe style="${iframeStyle}" src="https://www.youtube.com/embed/${youtubeVideoId}" title="${title}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen webkitallowfullscreen></iframe>`;
    } else if (url.includes('wistia.com/medias/')) {
      const parseUrl = new URL(url);
      const wistiaVideoId = parseUrl.pathname.replace('/medias/', '');
      const title = 'Wistia video player';
      // See documentation: https://wistia.com/support/embed-and-share/media-on-your-website
      mediaHtml = `<iframe style="${iframeStyle}" src="//fast.wistia.net/embed/iframe/${wistiaVideoId}" title="${title}" frameborder="0" scrolling="no" class="wistia_embed" name="wistia_embed" allowtransparency="true" allowfullscreen webkitallowfullscreen></iframe>
        <script src="//fast.wistia.net/assets/external/E-v1.js" async></script>`;
    } else if (url.includes('vimeo.com')) {
      const parseUrl = new URL(url);
      const vimeoVideoId = parseUrl.pathname.replace('/', '');
      const title = 'Vimeo video player';
      mediaHtml = `<iframe style="${iframeStyle}" src="https://player.vimeo.com/video/${vimeoVideoId}" title="${title}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen webkitallowfullscreen></iframe>`;
    } else {
      const fileExtension = detectMediaFormat(url);
      let sourceHtml = '';
      if (fileExtension !== undefined) {
        sourceHtml = `<source src="${url}" type="${type}/${fileExtension}">`;
      } else {
        sourceHtml = `The ${type} format for ${url} is unsupported.`;
      }
      mediaHtml = `<${type} style="${style}" controls>${sourceHtml}</${type}>`;
    }

    // Always wrap in figure tag for semantic HTML
    if (caption !== undefined && caption !== '') {
      const captionHtml = `<figcaption align="center">${caption}</figcaption>`;
      return `<figure>${mediaHtml}${captionHtml}</figure>`;
    } else {
      return `<figure>${mediaHtml}</figure>`;
    }
  }
  return '';
}

function handleRichTextSubItem(value: RichTextItemResponse): string {
  let blockText = sanitizeAndApplyAnnotations(value.plain_text, value.annotations);
  if (value.type === 'text') {
    const textObj = value.text;
    const url = textObj.link?.url;
    if (url !== undefined) {
      blockText = `<a href="${url}">${blockText}</a>`;
    }
  }
  return blockText;
}

/**
 * Handles block types that contain rich text (paragraph, heading, list items, etc.)
 * @param value - Block-specific value structure (e.g., ParagraphBlockObjectResponse['paragraph'])
 */
export function handleRichTextTypes(type: string, value: NotionRichTextBlockValue, subBlocksText: string): string {
  let blockText = '';
  const richText = value.rich_text;
  if (!Array.isArray(richText)) {
    blockText = handleRichTextSubItem(richText);
  } else {
    for (const item of richText) {
      const data = item;
      if (data.plain_text !== undefined) {
        blockText = blockText.concat(handleRichTextSubItem(data));
      }
    }
  }

  if (type === 'toggle') {
    const summary = applyHtmlTagFromType('summary', blockText);
    const temp = applyHtmlTagFromType(type, summary.concat(subBlocksText));
    return temp;
  } else if (type === 'to_do') {
    const todo = value;
    const checked = todo.checked ? ' checked' : '';
    const inputTag = `<input type="checkbox"${checked}> `;
    const temp = applyHtmlTagFromType(type, inputTag.concat(blockText.concat(subBlocksText)));
    return temp;
  }

  return applyHtmlTagFromType(type, blockText.concat(subBlocksText));
}

/**
 * Handles link block types (bookmark, link_preview, etc.)
 * @param value - Block-specific value structure with a `url` property
 */
export function handleLinkTypes(type: string, value: NotionLinkValue): string {
  if (value.url === '') {
    return `<p><br></p>`;
  }
  const href = value.url;
  let caption = href;
  if (value.caption !== undefined && isArray(value.caption) && value.caption.length > 0) {
    caption = '';
    for (const item of value.caption) {
      const data = item;
      if (data.plain_text !== undefined) {
        caption = caption.concat(handleRichTextSubItem(data));
      }
    }
  }

  // If embed, return an iframe
  if (type === 'embed') {
    const iframeStyle = 'width:100%;height:400px;border:0;';
    const embedUrl = href;
    return `<iframe style="${iframeStyle}" src="${embedUrl}" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
  }

  // Default handling for other embeds and bookmarks
  const style = 'border: 1px solid #f1f1f1; padding:20px; width:100%;';
  return `<p style="${style}"><a href="${href}" target="_blank">${href}</a><br/>${caption}</p>`;
}

function applyAnnotationsToHtml(html: string, annotations: NotionAnnotations): string {
  if (annotations.bold) {
    html = `<strong>${html}</strong>`;
  }
  if (annotations.code) {
    html = `<code>${html}</code>`;
  }
  if (annotations.color && annotations.color !== 'default') {
    const colors = notionColorsToCssColors(annotations);
    const colorStyleString = colors.color ? `color:${colors.color};` : undefined;
    const backgroundColorStyleString = colors.backgroundColor
      ? `background-color:${colors.backgroundColor};`
      : undefined;
    const styleString = [colorStyleString, backgroundColorStyleString].filter((s) => s !== undefined).join(' ');
    if (styleString) {
      html = `<span style="${styleString}">${html}</span>`;
    }
  }
  if (annotations.italic) {
    html = `<em>${html}</em>`;
  }
  if (annotations.strikethrough) {
    html = `<del>${html}</del>`;
  }
  if (annotations.underline) {
    html = `<u>${html}</u>`;
  }
  return html;
}

/**
 * Converts markdown heading syntax (####, #####, ######) to proper HTML heading tags
 */
export function convertMarkdownHeadingsToHtml(html: string): string {
  // Check for markdown heading patterns at the start of the text
  const h6Match = html.match(/^###### (.+)$/);
  if (h6Match) {
    return `<h6>${h6Match[1]}</h6>`;
  }

  const h5Match = html.match(/^##### (.+)$/);
  if (h5Match) {
    return `<h5>${h5Match[1]}</h5>`;
  }

  const h4Match = html.match(/^#### (.+)$/);
  if (h4Match) {
    return `<h4>${h4Match[1]}</h4>`;
  }

  return html;
}

export function convertNotionRichTextToHtml(richText: RichTextItemResponse[]): string | null {
  // If we have no text, we don't want to push `[""]` to the CMR. We want to push `[]`. Otherwise we run the risk of
  // unintentional syncbacks.
  if (richText.length === 0) {
    return null;
  }
  const html = richText.reduce((prev, next) => {
    let html = getUnstyledHtml(next);
    if (next.annotations) {
      html = applyAnnotationsToHtml(html, next.annotations);
    }
    return prev + html;
  }, '');

  // Check if this rich text represents a markdown heading (h4, h5, h6)
  const convertedHtml = convertMarkdownHeadingsToHtml(unescapeSafeSpacesInHtml(html));
  return convertedHtml;
}

function sanitizeAndApplyAnnotations(text: string, annotations?: NotionAnnotations): string {
  if (text === '') {
    return text;
  }
  let html = escapeHtmlAndSpaces(text);
  html = html.replaceAll('\n', '<br>');
  if (annotations !== undefined) {
    html = applyAnnotationsToHtml(html, annotations);
  }
  return unescapeSafeSpacesInHtml(html);
}

/**
 * Renders a Notion simple table block (type 'table') and its 'table_row' children into HTML.
 */
export function convertNotionSimpleTableBlockToHtml(tableBlock: NotionBlockObject): string {
  const tableValue = (tableBlock as Record<string, unknown>)['table'] as Record<string, unknown> | undefined;
  const hasColumnHeader: boolean = tableValue?.has_column_header === true;
  const hasRowHeader: boolean = tableValue?.has_row_header === true;

  const children = ((tableBlock as Record<string, unknown>)['children'] ?? []) as Array<Record<string, unknown>>;
  const rowsHtml: string[] = [];

  for (const child of children) {
    const childType = child['type'];
    if (childType !== 'table_row') {
      continue;
    }
    const rowValue = child['table_row'] as Record<string, unknown> | undefined;
    const cells: RichTextItemResponse[][] = (rowValue?.cells ?? []) as RichTextItemResponse[][];

    const cellHtmls: string[] = [];
    for (let colIdx = 0; colIdx < cells.length; colIdx++) {
      const richTextArray = cells[colIdx] ?? [];
      const html = convertNotionRichTextToHtml(richTextArray) ?? '';

      let cellTag = 'td';
      let scopeAttr = '';
      if (hasColumnHeader && rowsHtml.length === 0) {
        cellTag = 'th';
        scopeAttr = ' scope="col"';
      } else if (hasRowHeader && colIdx === 0) {
        cellTag = 'th';
        scopeAttr = ' scope="row"';
      }
      cellHtmls.push(`<${cellTag}${scopeAttr}>${html}</${cellTag}>`);
    }
    rowsHtml.push(`<tr>${cellHtmls.join('')}</tr>`);
  }

  let tableInner = '';
  if (hasColumnHeader && rowsHtml.length > 0) {
    const [headerRow, ...bodyRows] = rowsHtml;
    tableInner = `<thead>${headerRow}</thead><tbody>${bodyRows.join('')}</tbody>`;
  } else {
    tableInner = `<tbody>${rowsHtml.join('')}</tbody>`;
  }
  return `<table>${tableInner}</table>`;
}

/**
 * Converts a NotionBlockObject tree to HTML.
 * Handles both Notion API responses and our internal block representations with children.
 * */
export function convertNotionBlockObjectToHtmlv2(input: NotionBlockObject): string {
  const block = input as Record<string, unknown>;
  const type = block['type'] as string;
  const value = block[type] as Record<string, unknown>;

  let subBlocksText = '';
  if (block['has_children'] !== undefined && block['has_children'] === true) {
    // Handling lists: https://developer.mozilla.org/en-US/docs/Learn/HTML/Introduction_to_HTML/HTML_text_fundamentals#lists
    let list: 'bulleted_list_item' | 'numbered_list_item' | undefined = undefined;
    let listData = '';

    const children = block['children'] as NotionBlockObject[];
    for (const child of children) {
      const childBlock = child as Record<string, unknown>;
      const childHtml = convertNotionBlockObjectToHtmlv2(child);

      const childType = childBlock['type'] as string;
      if (childType.includes('list_item')) {
        if (list === undefined) {
          list = childType as 'bulleted_list_item' | 'numbered_list_item';
          listData = childHtml;
        } else if (list !== childType) {
          const listType = list === 'bulleted_list_item' ? 'bulleted_list' : 'numbered_list';
          subBlocksText = subBlocksText.concat(applyHtmlTagFromType(listType, listData));
          list = childType as 'bulleted_list_item' | 'numbered_list_item';
          listData = childHtml;
        } else {
          listData = listData.concat(childHtml);
        }
      } else {
        if (list !== undefined) {
          const listType = list === 'bulleted_list_item' ? 'bulleted_list' : 'numbered_list';
          subBlocksText = subBlocksText.concat(applyHtmlTagFromType(listType, listData));
          list = undefined;
          listData = '';
        }
        subBlocksText = subBlocksText.concat(childHtml);
      }
    }
    if (list !== undefined) {
      const listType = list === 'bulleted_list_item' ? 'bulleted_list' : 'numbered_list';
      subBlocksText = subBlocksText.concat(applyHtmlTagFromType(listType, listData));
    }
  }

  let html = '';

  if (value['rich_text'] !== undefined) {
    html = handleRichTextTypes(type, value as unknown as NotionRichTextBlockValue, subBlocksText);
  } else if (type === 'image' || type === 'video' || type === 'audio') {
    html = handleMediaTypes(type, value as unknown as NotionMediaValue);
  } else if (type === 'bookmark' || type === 'embed') {
    html = handleLinkTypes(type, value as unknown as NotionLinkValue);
  } else if (type === 'divider') {
    html = applyHtmlTagFromType(type, '');
  } else if (type === 'table') {
    html = convertNotionSimpleTableBlockToHtml(input);
  } else {
    html = applyHtmlTagFromType(type, subBlocksText);
  }

  // Add the block ID to the root HTML element
  return html;
}

/**
 * Converts HTML to an array of Notion rich text fields. Only HTML elements that we recognize as translatable to HTML
 * are preserved; all other tags are dropped (like `<div>`). If there is plain text inside of a non-translatable tag, we
 * keep the text. Thus this is a lossy conversion. We only support: `<a>`, `<code>`, `<del>`, `<em>`, `<i>`, `<strong>`,
 * `<u>`, and tags with inline `color` and `background-color` styles that exactly match Notion's colors.
 *
 * Nested tags are dealt with via flattening the DOM tree into an array of rich text content and styles.
 */
export async function convertHtmlToNotionRichText(
  html: string,
): Promise<RichTextItemResponse[] | RichTextItemResponse> {
  let minifiedHtml: string;
  try {
    minifiedHtml = await minifyHtml(html);
  } catch {
    return [];
  }
  const $ = cheerio.load(minifiedHtml);

  const intermediateItems: IntermediateRichTextItem[] = [];
  const bodyChildNodes = $('body')[0]?.childNodes ?? [];
  for (const n of bodyChildNodes) {
    intermediateItems.push(...convertNodesToIntermediateRichTextItems(n));
  }
  const richText = convertIntermediateRichTextItemsToNotionRichText(intermediateItems);
  if (richText.length > 100) {
    return [];
  }
  return richText;
}

function convertIntermediateRichTextItemsToNotionRichText(
  intermediateItems: IntermediateRichTextItem[],
): RichTextItemResponse[] {
  const richText: RichTextItemResponse[] = [];
  for (let i = 0; i < intermediateItems.length; ) {
    const currentItem = intermediateItems[i];
    if (currentItem.type === 'block_element_boundary') {
      // Find all of the adjacent block element boundaries and collapse them into one newline.
      let j = i + 1;
      let nextItem = intermediateItems[j];
      while (nextItem && nextItem.type === 'block_element_boundary') {
        j++;
        nextItem = intermediateItems[j];
      }
      richText.push({
        type: 'text',
        text: { content: '\n', link: null },
        annotations: currentItem.annotations,
        plain_text: '\n',
        href: null,
      });
      i = j;
    } else {
      richText.push(currentItem);
      i++;
    }
  }
  return optimizeRichTextItems(richText);
}

/**
 * Converts a tree of HTML nodes into a flat list of Notion rich text elements.
 */
function convertNodesToIntermediateRichTextItems(node: ChildNode): IntermediateRichTextItem[] {
  // The way this works:
  // A `ChildNode` represents a subtree of an HTML document. We recursively traverse the tree to convert all of the
  // children of the node into a flat list of Notion rich text elements.
  //
  // If this node is a text element, it's a leaf node and we can simply return the text with no styling.
  //
  // If this is an HTML tag, we first recursively call this function to get a flat list of the Notion rich texts. Then,
  // if it's a tag that applies a certain style, we apply its style to all of the elements in the list.
  if (node.type === ElementType.Text) {
    if (node.nodeValue === '\n') {
      return [];
    }
    const item: RichTextItemResponse = {
      type: 'text',
      text: { content: node.nodeValue, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
      plain_text: node.nodeValue,
      href: null,
    };
    return [item];
  }

  if (node.type === ElementType.Tag) {
    const tagName = node.tagName.toLowerCase();
    if (tagName === 'br') {
      // This is special. Just convert a <br> tag into a new line. It shouldn't have any children.
      const item: RichTextItemResponse = {
        type: 'text',
        text: { content: '\n', link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default',
        },
        plain_text: '\n',
        href: null,
      };
      return [item];
    }

    const childRichTexts = node.childNodes.flatMap(convertNodesToIntermediateRichTextItems);
    if (node.attribs['style']) {
      const styleList = getStyleList(node.attribs['style']);
      for (const s of styleList) {
        // Try to match colors and background colors with Notion colors. If we find a match, apply the styles to all
        // children.
        if (s.name === 'background-color') {
          const notionBgColor = cssColorsToNotionColors({ backgroundColor: s.value });
          if (notionBgColor) {
            childRichTexts.forEach((n) => (n.annotations.color = notionBgColor));
          }
        }
      }
      for (const s of styleList) {
        // NOTE: If both color and background-color are defined, we prefer the text color over the background color by
        // applying it last, which overrides any previous colors.
        if (s.name === 'color') {
          const notionColor = cssColorsToNotionColors({ color: s.value });
          if (notionColor) {
            childRichTexts.forEach((n) => (n.annotations.color = notionColor));
          }
        }
      }
    }
    if (tagName === 'strong') {
      childRichTexts.forEach((n) => (n.annotations.bold = true));
    }
    if (tagName === 'code') {
      childRichTexts.forEach((n) => (n.annotations.code = true));
    }
    if (tagName === 'em') {
      childRichTexts.forEach((n) => (n.annotations.italic = true));
    }
    if (tagName === 'del') {
      childRichTexts.forEach((n) => (n.annotations.strikethrough = true));
    }
    if (tagName === 'u') {
      childRichTexts.forEach((n) => (n.annotations.underline = true));
    }
    if (tagName === 'a' && node.attribs['href']) {
      for (const crt of childRichTexts) {
        if (crt.type === 'text') {
          crt.text.link = { url: node.attribs['href'].trim() };
        }
      }
    }
    if (isHtmlBlockLevelTag(tagName)) {
      // Block-level elements will require a newline between them. These are all of the block-level elements:
      // https://developer.mozilla.org/en-US/docs/Web/HTML/Block-level_elements
      const defaultAnnotations: NotionAnnotations = {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      };
      childRichTexts.unshift({ type: 'block_element_boundary', annotations: defaultAnnotations });
      childRichTexts.push({ type: 'block_element_boundary', annotations: defaultAnnotations });
    }

    return childRichTexts;
  }

  // We don't know what to do with anything other than tags and text.
  return [];
}

/**
 * From a string of inline CSS styles, produce a list of style names to their values.
 */
function getStyleList(styleString: string): { name: string; value: string }[] {
  const styles = styleString
    // Split the whole style string into an array of individual styles.
    .split(';')
    .map((s) => s.trim())
    .map((s) =>
      // Remove the spaces before/after the style name and the style value. Makes it easier to parse.
      s
        .split(':')
        .map((token) => token.trim())
        .join(':'),
    );
  const styleList: { name: string; value: string }[] = [];
  for (const s of styles) {
    const [name, value] = s.split(':');
    if (name && value) {
      styleList.push({ name: name.toLowerCase(), value });
    }
  }
  return styleList;
}

/**
 * Returns a new, equivalent list of rich text items whose length is less than or equal to the original list. For any
 * adjacent items in the original list that could be combined (because they had equivalent styles), those items are
 * joined together in the resulting list.
 */
export function optimizeRichTextItems(items: RichTextItemResponse[]): RichTextItemResponse[] {
  if (items.length === 0) {
    return [];
  }
  if (items.length === 1) {
    return [items[0]];
  }

  const optimized: RichTextItemResponse[] = [];
  let firstItem = items[0];
  for (let i = 1; i < items.length; i++) {
    const secondItem = items[i];
    const maybeJoinedResult = maybeJoinTwoRichTextItems(firstItem, secondItem);
    if (maybeJoinedResult.result === 'noop') {
      if (i === items.length - 1) {
        // `secondItem` was the last item, so add both and finish.
        optimized.push(firstItem);
        optimized.push(secondItem);
        break;
      } else {
        // There are more items after `secondItem`.
        optimized.push(firstItem);
        firstItem = secondItem;
      }
    } else {
      // We joined two rich text elements, so keep the train rolling.
      firstItem = maybeJoinedResult.value;
      if (i === items.length - 1) {
        // We're at the end of the array.
        optimized.push(firstItem);
        break;
      }
    }
  }

  return optimized;
}

/**
 * Attempts to combine two rich text items into one if possible. Only works for text items because equations and
 * mentions seem more complex.
 */
function maybeJoinTwoRichTextItems(
  first: RichTextItemResponse,
  second: RichTextItemResponse,
): { result: 'joined'; value: RichTextItemResponse } | { result: 'noop' } {
  const firstType = first.type;
  const secondType = second.type;
  if (firstType === secondType) {
    if (firstType === undefined) {
      return { result: 'noop' };
    }
    // For text, we also have to make sure they're not a link or the links are the same value.
    if (firstType === 'text' && secondType === 'text' && first.text.link === second.text.link) {
      if (_.isEqual(first.annotations, second.annotations)) {
        // This is text and its rich text annotations are the same, so it's safe to join them together.
        const joined = _.cloneDeep(first);
        joined.text.content = first.text.content + second.text.content;
        return { result: 'joined', value: joined };
      }
    }
  }

  return { result: 'noop' };
}
