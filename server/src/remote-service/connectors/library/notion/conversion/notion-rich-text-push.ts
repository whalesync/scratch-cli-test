import type { RichTextItemResponse } from '@notionhq/client';
import * as cheerio from 'cheerio';
import { ElementType } from 'domelementtype';
import { ChildNode, DataNode, Element } from 'domhandler';
import MarkdownIt from 'markdown-it';
import { cssColorsToNotionColors } from './notion-rich-text-conversion';
import { ConvertedNotionBlock, RichTextItemWithResponseFields } from './notion-rich-text-push-types';

/**
 * Annotation structure for rich text formatting.
 * In `@notionhq/client@5.x`, `annotations` lives on the shared
 * `RichTextItemResponseCommon` (mixed into the response union), so the type
 * is derived from the union root rather than the per-type variant.
 */
type NotionAnnotations = RichTextItemResponse['annotations'];

/**
 * Color type for Notion blocks and rich text
 */
type NotionColor = NotionAnnotations['color'];

export interface BlockWithChildren {
  block: ConvertedNotionBlock;
  children?: BlockWithChildren[];
}
/**
 * Converts HTML to an array of Notion block objects. This is a generic function that handles
 * common HTML elements and converts them to their Notion block equivalents.
 */
export function convertToNotionBlocks(html: string, isMarkdown: boolean): ConvertedNotionBlock[] {
  let convertedHtml = html;
  if (isMarkdown) {
    // If the column is expected to be Markdown, we need to convert to HTML.
    const converter = MarkdownIt({});
    convertedHtml = converter.render(html);
  }
  const $ = cheerio.load(convertedHtml);
  const blocks: ConvertedNotionBlock[] = [];

  // Remove article wrapper if it exists
  const bodyContent = $('article').length > 0 ? $('article') : $('body');
  const elements = bodyContent.children();

  for (let i = 0; i < elements.length; i++) {
    const element = elements.eq(i);
    const convertedBlocks = convertHtmlElementToNotionBlock($, element);
    if (convertedBlocks) {
      if (Array.isArray(convertedBlocks)) {
        blocks.push(...convertedBlocks);
      } else {
        blocks.push(convertedBlocks);
      }
    }
  }

  // Handle special case when article is empty but body has content
  if (blocks.length === 0) {
    const bodyElements = $('body').children();
    for (let i = 0; i < bodyElements.length; i++) {
      const element = bodyElements.eq(i);
      const convertedBlocks = convertHtmlElementToNotionBlock($, element);
      if (convertedBlocks) {
        if (Array.isArray(convertedBlocks)) {
          blocks.push(...convertedBlocks);
        } else {
          blocks.push(convertedBlocks);
        }
      }
    }
  }

  return blocks;
}

/**
 * Converts a single HTML element to a Notion block object or array of blocks
 */
function convertHtmlElementToNotionBlock(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
): ConvertedNotionBlock | ConvertedNotionBlock[] | null {
  const tagName = element.prop('tagName')?.toLowerCase();
  if (!tagName) {
    return null;
  }

  switch (tagName) {
    case 'h1':
      return createHeadingBlock(element, 'heading_1');
    case 'h2':
      return createHeadingBlock(element, 'heading_2');
    case 'h3':
      return createHeadingBlock(element, 'heading_3');
    case 'h4':
    case 'h5':
    case 'h6':
      // Convert h4, h5, h6 to paragraph blocks with markdown heading prefixes
      return createMarkdownHeadingBlock(element, tagName);
    case 'p': {
      // Check if this paragraph contains a bookmark link with border styling
      const bookmarkLink = element.find('a[target="_blank"]');
      if (bookmarkLink.length > 0 && element.attr('style')?.includes('border:')) {
        const url = bookmarkLink.attr('href') || '';
        // YouTube links should be video blocks, not bookmarks
        if (url.includes('youtube.com')) {
          return {
            object: 'block',
            has_children: false,
            type: 'video',
            video: {
              external: {
                url,
              },
              caption: [],
            },
          };
        }
        return createBookmarkBlock(bookmarkLink);
      }
      return createParagraphBlock(element);
    }
    case 'blockquote':
      return createQuoteBlock(element);
    case 'ul':
      return convertNestedListToBlocks($, element, 'bulleted_list_item');
    case 'ol':
      return convertNestedListToBlocks($, element, 'numbered_list_item');
    case 'dl':
      return convertDescriptionListToBlocks($, element);
    case 'dt':
      return createDescriptionTermBlock(element);
    case 'dd':
      return convertDescriptionDefinitionToBlocks($, element);
    case 'li': {
      // Handle individual li elements - determine type based on parent
      const liParentElement = element.parent();
      const parentTag = liParentElement.prop('tagName')?.toLowerCase();
      let listType: 'bulleted_list_item' | 'numbered_list_item';
      if (parentTag === 'ul') {
        listType = 'bulleted_list_item';
      } else if (parentTag === 'ol') {
        listType = 'numbered_list_item';
      } else {
        // Smart inference based on context when parent is unclear
        listType = inferListTypeFromContext(element, $);
      }
      // Use convertListItemToBlock to properly handle nested children
      return convertListItemToBlock($, element, listType);
    }
    case 'div': {
      // Handle code blocks with specific styling
      if (element.find('code').length > 0 && element.attr('style')?.includes('background-color:#f1f1f1')) {
        return createCodeBlock(element);
      }
      // Handle todo items
      if (element.find('input[type="checkbox"]').length > 0) {
        return createTodoBlock(element);
      }
      // Simple div - likely a callout from Notion, convert to callout
      const content = element.text().trim();
      if (content) {
        return createCalloutBlock(element);
      }
      return null;
    }
    case 'hr':
      return createDividerBlock();
    case 'details':
      // Toggle blocks are not supported - ignore details elements
      return null;
    case 'table':
      return createTableBlock($, element);
    case 'img': {
      // Check if this image has a following figcaption
      const nextElement = element.next();
      let caption = '';
      if (nextElement.prop('tagName')?.toLowerCase() === 'figcaption') {
        const figcaptionText = nextElement.text().trim();
        if (figcaptionText) {
          caption = figcaptionText;
        }
      }
      // Only create image block if src is valid
      const imgSrc = element.attr('src');
      if (!imgSrc || imgSrc.trim() === '') {
        return null;
      }
      return createImageBlock(element, caption);
    }
    case 'video':
      return createVideoBlock(element);
    case 'audio':
      return createAudioBlock(element);
    case 'iframe': {
      const iframeSrc = element.attr('src') || '';
      // YouTube iframes should be video blocks
      if (iframeSrc.includes('youtube.com/embed')) {
        return createVideoBlock(element);
      }
      return createEmbedBlock(element);
    }
    case 'embed':
      return createEmbedBlock(element);
    case 'a': {
      // Handle bookmark links - check if parent paragraph has bookmark styling
      const aParentElement = element.parent();
      if (element.attr('target') === '_blank' && aParentElement.attr('style')?.includes('border:')) {
        return createBookmarkBlock(element);
      }
      return createParagraphBlock(element);
    }
    case 'figcaption':
      // Skip figcaptions as they are handled by the preceding img element
      return null;
    case 'figure':
      // Handle figure elements that contain images or videos
      return handleFigureElement($, element);
    case 'pre':
      // Handle preformatted text as code blocks
      return createCodeBlockFromPre(element);
    default: {
      // For unknown elements, treat as paragraph if they have text content
      const text = element.text().trim();
      if (text) {
        return createParagraphBlock(element);
      }
      return null;
    }
  }
}

/**
 * Creates a block with proper rich text conversion using simpler HTML parsing
 */
function createBlockWithRichText(
  type: string,
  element: cheerio.Cheerio<Element>,
  additionalProps: Record<string, unknown> = {},
): ConvertedNotionBlock {
  // Extract rich text directly from element without async conversion
  const richText = extractRichTextFromElement(element);

  const baseBlock = {
    object: 'block' as const,
    has_children: false,
    type,
  };

  const typeProps = {
    rich_text: richText,
    color: 'default',
    ...additionalProps,
  };

  return {
    ...baseBlock,
    [type]: typeProps,
  };
}

/**
 * Extracts rich text items from a cheerio element synchronously (simplified version)
 */
function extractRichTextFromElement(element: cheerio.Cheerio<Element>): RichTextItemWithResponseFields[] {
  const richTextSegments: RichTextItemWithResponseFields[] = [];

  // Parse the element's content into segments with proper annotations
  const segments = parseElementIntoSegments(element, {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default',
  });

  // Merge consecutive segments with identical annotations to avoid unnecessary splits
  const mergedSegments = mergeConsecutiveSegments(segments);

  // Convert segments to rich text items
  for (const segment of mergedSegments) {
    if (segment.text.trim() || segment.text.includes('\n')) {
      richTextSegments.push(createTextItem(segment.text, segment.annotations, segment.href));
    }
  }

  return richTextSegments.length > 0 ? richTextSegments : [];
}

/**
 * Merges consecutive text segments that have identical annotations
 */
function mergeConsecutiveSegments(segments: TextSegment[]): TextSegment[] {
  if (segments.length === 0) {
    return [];
  }

  const merged: TextSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];

    // Check if annotations and href match
    const annotationsMatch =
      current.annotations.bold === next.annotations.bold &&
      current.annotations.italic === next.annotations.italic &&
      current.annotations.strikethrough === next.annotations.strikethrough &&
      current.annotations.underline === next.annotations.underline &&
      current.annotations.code === next.annotations.code &&
      current.annotations.color === next.annotations.color &&
      current.href === next.href;

    if (annotationsMatch) {
      // Merge the text
      current.text += next.text;
    } else {
      // Push current and start new segment
      merged.push(current);
      current = { ...next };
    }
  }

  // Push the last segment (trim trailing whitespace from final segment)
  if (current) {
    current.text = current.text.trimEnd();
    if (current.text) {
      // Only add if there's text left after trimming
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Represents a text segment with its annotations
 */
interface TextSegment {
  text: string;
  annotations: NotionAnnotations;
  href: string | null;
}

/**
 * Recursively parses an element into text segments with proper annotations
 */
function parseElementIntoSegments(
  element: cheerio.Cheerio<Element>,
  parentAnnotations: NotionAnnotations,
): TextSegment[] {
  const segments: TextSegment[] = [];
  const blockLevelTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li']);

  // Process each child node
  element.contents().each((i, node) => {
    if (node.type === ElementType.Text) {
      // Text node - create a segment with current annotations
      let text = node.data || '';

      // Decode HTML entities
      text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      if (text) {
        segments.push({
          text,
          annotations: { ...parentAnnotations },
          href: null,
        });
      }
    } else if (node.type === ElementType.Tag) {
      // Element node - recurse with updated annotations
      const elemNode = node;
      const tagName = elemNode.tagName?.toLowerCase();
      const isBlockLevel = blockLevelTags.has(tagName || '');

      // Clone parent annotations
      const newAnnotations = { ...parentAnnotations };
      let href: string | null = null;

      // Update annotations based on tag
      if (tagName === 'strong' || tagName === 'b') {
        newAnnotations.bold = true;
      } else if (tagName === 'em' || tagName === 'i') {
        newAnnotations.italic = true;
      } else if (tagName === 'u') {
        newAnnotations.underline = true;
      } else if (tagName === 'del' || tagName === 'strike') {
        newAnnotations.strikethrough = true;
      } else if (tagName === 'code') {
        newAnnotations.code = true;
      } else if (tagName === 'br') {
        // Handle line breaks
        segments.push({
          text: '\n',
          annotations: { ...parentAnnotations },
          href: null,
        });
        return; // Skip recursion for br tags
      } else if (tagName === 'a') {
        href = elemNode.attribs?.href || null;
      }

      // Check for color styling
      const style = elemNode.attribs?.style;
      if (style) {
        const color = extractColorFromStyle(style);
        if (color !== 'default') {
          newAnnotations.color = color;
        }
      }

      // Recurse into child nodes if they exist
      const segmentsBefore = segments.length;
      if (elemNode.children && elemNode.children.length > 0) {
        for (const childNode of elemNode.children) {
          const childSegs = parseNodeIntoSegments(childNode, newAnnotations);
          segments.push(...childSegs);
        }
      }

      // Add space after block-level elements (mimics Cheerio's .text() behavior)
      if (isBlockLevel && segments.length > segmentsBefore) {
        segments.push({
          text: ' ',
          annotations: { ...parentAnnotations },
          href: null,
        });
      }

      // Add href only to segments created by this link's children
      if (href) {
        for (let i = segmentsBefore; i < segments.length; i++) {
          if (!segments[i].href) {
            segments[i].href = href;
          }
        }
      }
    }
  });

  return segments;
}

/**
 * Helper function to parse a single DOM node into text segments
 */
function parseNodeIntoSegments(node: ChildNode, parentAnnotations: NotionAnnotations): TextSegment[] {
  const segments: TextSegment[] = [];
  const blockLevelTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li']);

  if (node.type === ElementType.Text) {
    // Text node
    let text = (node as DataNode).data || '';

    // Decode HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    if (text) {
      segments.push({
        text,
        annotations: { ...parentAnnotations },
        href: null,
      });
    }
  } else if (node.type === ElementType.Tag) {
    const elemNode = node;
    const tagName = elemNode.tagName?.toLowerCase();
    const isBlockLevel = blockLevelTags.has(tagName || '');

    // Clone parent annotations
    const newAnnotations = { ...parentAnnotations };
    let href: string | null = null;

    // Update annotations based on tag
    if (tagName === 'strong' || tagName === 'b') {
      newAnnotations.bold = true;
    } else if (tagName === 'em' || tagName === 'i') {
      newAnnotations.italic = true;
    } else if (tagName === 'u') {
      newAnnotations.underline = true;
    } else if (tagName === 'del' || tagName === 'strike') {
      newAnnotations.strikethrough = true;
    } else if (tagName === 'code') {
      newAnnotations.code = true;
    } else if (tagName === 'br') {
      // Handle line breaks
      segments.push({
        text: '\n',
        annotations: { ...parentAnnotations },
        href: null,
      });
      return segments;
    } else if (tagName === 'a') {
      href = elemNode.attribs?.href || null;
    }

    // Check for color styling
    const style = elemNode.attribs?.style;
    if (style) {
      const color = extractColorFromStyle(style);
      if (color !== 'default') {
        newAnnotations.color = color;
      }
    }

    // Recurse into child nodes
    const segmentsBefore = segments.length;
    if (elemNode.children && elemNode.children.length > 0) {
      for (const childNode of elemNode.children) {
        const childSegs = parseNodeIntoSegments(childNode, newAnnotations);
        segments.push(...childSegs);
      }
    }

    // Add space after block-level elements (mimics Cheerio's .text() behavior)
    if (isBlockLevel && segments.length > segmentsBefore) {
      segments.push({
        text: ' ',
        annotations: { ...parentAnnotations },
        href: null,
      });
    }

    // Add href only to segments created by this link's children
    if (href) {
      for (let i = segmentsBefore; i < segments.length; i++) {
        if (!segments[i].href) {
          segments[i].href = href;
        }
      }
    }
  }

  return segments;
}

/**
 * Extracts Notion color from CSS style string
 */
function extractColorFromStyle(style: string): NotionColor {
  // Simple extraction - look for color or background-color
  const colorMatch = style.match(/color:\s*([^;]+)/);
  const bgColorMatch = style.match(/background-color:\s*([^;]+)/);

  if (colorMatch) {
    const notionColor = cssColorsToNotionColors({ color: colorMatch[1].trim() });
    if (notionColor) {
      return notionColor;
    }
  }

  if (bgColorMatch) {
    const notionColor = cssColorsToNotionColors({ backgroundColor: bgColorMatch[1].trim() });
    if (notionColor) {
      return notionColor;
    }
  }

  return 'default';
}

/**
 * Creates a text item with annotations
 */
function createTextItem(
  content: string,
  annotations: NotionAnnotations,
  href: string | null = null,
): RichTextItemWithResponseFields {
  return {
    type: 'text',
    text: {
      content,
      link: href ? { url: href } : null,
    },
    annotations,
    plain_text: content,
    href,
  };
}

/**
 * Creates a heading block
 */
function createHeadingBlock(
  element: cheerio.Cheerio<Element>,
  type: 'heading_1' | 'heading_2' | 'heading_3',
): ConvertedNotionBlock {
  return createBlockWithRichText(type, element, { is_toggleable: false });
}

/**
 * Creates a paragraph block with markdown heading prefix for h4, h5, h6
 */
function createMarkdownHeadingBlock(
  element: cheerio.Cheerio<Element>,
  headingLevel: 'h4' | 'h5' | 'h6',
): ConvertedNotionBlock {
  // Get the heading text content
  const headingText = element.text().trim();

  // Create markdown prefix based on heading level
  const markdownPrefix = headingLevel === 'h4' ? '#### ' : headingLevel === 'h5' ? '##### ' : '###### ';

  // Create a new element with the markdown prefix
  const markdownText = markdownPrefix + headingText;

  // Extract rich text but prefix with markdown syntax
  const richText = extractRichTextFromElement(element);

  // Modify the first rich text item to include the markdown prefix
  if (richText.length > 0 && richText[0].type === 'text') {
    richText[0].text.content = markdownPrefix + richText[0].text.content;
    richText[0].plain_text = markdownPrefix + richText[0].plain_text;
  } else if (richText.length === 0) {
    // If no rich text, create a simple text item
    richText.push({
      type: 'text',
      text: { content: markdownText, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
      plain_text: markdownText,
      href: null,
    });
  }

  const baseBlock = {
    object: 'block' as const,
    has_children: false,
    type: 'heading_3',
  };

  const typeProps = {
    rich_text: richText,
    color: 'default',
    is_toggleable: false,
  };

  return {
    ...baseBlock,
    heading_3: typeProps,
  };
}

/**
 * Creates a paragraph block
 */
function createParagraphBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  // Handle empty paragraphs - they should still be created but with empty rich_text
  const textContent = element.text().trim();
  // Check for zero-width space or other invisible characters that represent blank lines
  const isBlankLine =
    !textContent ||
    textContent === '\u200D' || // Zero-width joiner (‍)
    textContent === '\u200C' || // Zero-width non-joiner
    textContent === '\uFEFF' || // Zero-width no-break space
    textContent === '\u00A0'; // Non-breaking space

  if (isBlankLine) {
    return {
      object: 'block',
      has_children: false,
      type: 'paragraph',
      paragraph: {
        rich_text: [],
        color: 'default',
      },
    };
  }
  return createBlockWithRichText('paragraph', element);
}

/**
 * Creates a quote block
 */
function createQuoteBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  return createBlockWithRichText('quote', element);
}

/**
 * Creates a code block
 */
function createCodeBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const codeElement = element.find('code');
  // Preserve line breaks in code blocks
  let content = codeElement.html() || element.html() || '';
  content = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ') // Convert non-breaking spaces to regular spaces
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

  return {
    object: 'block',
    has_children: false,
    type: 'code',
    code: {
      rich_text: [
        {
          type: 'text',
          text: {
            content,
            link: null,
          },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
          plain_text: content,
          href: null,
        },
      ],
      caption: [],
      language: 'javascript',
    },
  };
}

/**
 * Creates a todo block
 */
function createTodoBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const checkbox = element.find('input[type="checkbox"]');
  const checked = checkbox.prop('checked') || false;

  // Clone element and remove the checkbox to extract the text content with formatting
  const clonedElement = element.clone();
  clonedElement.find('input[type="checkbox"]').remove();

  // Extract rich text with formatting
  const richText = extractRichTextFromElement(clonedElement);

  // Trim leading whitespace from the first text segment
  if (richText.length > 0 && richText[0].type === 'text') {
    richText[0].text.content = richText[0].text.content.trimStart();
    richText[0].plain_text = richText[0].plain_text.trimStart();
  }

  return {
    object: 'block',
    has_children: false,
    type: 'to_do',
    to_do: {
      rich_text: richText,
      checked,
      color: 'default',
    },
  };
}

/**
 * Creates a callout block from a div element
 */
function createCalloutBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const block = createBlockWithRichText('callout', element, {
    color: 'default',
  });

  return block;
}

/**
 * Creates a divider block
 */
function createDividerBlock(): ConvertedNotionBlock {
  return {
    object: 'block',
    has_children: false,
    type: 'divider',
    divider: {},
  };
}

/**
 * Creates a table block
 */
function createTableBlock($: cheerio.CheerioAPI, element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const thead = element.find('thead');
  const tbody = element.find('tbody');
  // Include both header and body rows
  const allRows: Element[] = [];
  if (thead.length) {
    thead.find('tr').each((_, row) => {
      allRows.push(row);
    });
  }
  if (tbody.length) {
    tbody.find('tr').each((_, row) => {
      allRows.push(row);
    });
  } else {
    // If no tbody, get all tr elements
    element.find('tr').each((_, row) => {
      allRows.push(row);
    });
  }

  const hasColumnHeader = thead.length > 0;
  const hasRowHeader = false;

  const children: ConvertedNotionBlock[] = [];

  allRows.forEach((row) => {
    const cells: RichTextItemWithResponseFields[][] = [];
    $(row)
      .find('td, th')
      .each((_, cell) => {
        const $cell = $(cell);
        // Use extractRichTextFromElement to properly handle formatting in table cells
        const richText = extractRichTextFromElement($cell);
        cells.push(richText);
      });

    children.push({
      object: 'block',
      has_children: false,
      type: 'table_row',
      table_row: {
        cells,
      },
    } as ConvertedNotionBlock);
  });

  return {
    object: 'block',
    has_children: children.length > 0,
    type: 'table',
    table: {
      table_width: children.length > 0 ? (children[0].table_row as { cells: { length: number } }).cells.length || 2 : 2,
      has_column_header: hasColumnHeader,
      has_row_header: hasRowHeader,
      children: children,
    },
  };
}

/**
 * Creates an image block
 */
function createImageBlock(element: cheerio.Cheerio<Element>, caption = ''): ConvertedNotionBlock {
  const src = element.attr('src') || '';
  const alt = element.attr('alt') || '';

  let finalCaption = '';

  if (caption) {
    finalCaption = caption;
  } else if (alt) {
    finalCaption = alt;
  }

  return {
    object: 'block',
    has_children: false,
    type: 'image',
    image: {
      external: {
        url: src,
      },
      caption: finalCaption
        ? [
            {
              type: 'text',
              text: {
                content: finalCaption,
                link: null,
              },
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: 'default',
              },
              plain_text: finalCaption,
              href: null,
            },
          ]
        : [],
    },
  };
}

/**
 * Intelligently infers list type when parent tag is unclear
 */
function inferListTypeFromContext(
  element: cheerio.Cheerio<Element>,
  $: cheerio.CheerioAPI,
): 'bulleted_list_item' | 'numbered_list_item' {
  // 1. Check for explicit data attributes that hint at list type
  const hintAttr = element.attr('data-list-type');
  if (hintAttr === 'numbered') {
    return 'numbered_list_item';
  }
  if (hintAttr === 'bulleted') {
    return 'bulleted_list_item';
  }

  // 2. Look at surrounding siblings for context
  const prevSibling = element.prev();
  if (prevSibling.length > 0 && prevSibling.is('li')) {
    const prevParent = prevSibling.parent().prop('tagName')?.toLowerCase();
    if (prevParent === 'ol') {
      return 'numbered_list_item';
    }
    if (prevParent === 'ul') {
      return 'bulleted_list_item';
    }
  }

  // 3. Check if element has CSS classes that suggest list type
  const className = element.attr('class') || '';
  if (className.includes('numbered') || className.includes('decimal')) {
    return 'numbered_list_item';
  }
  if (className.includes('bullet') || className.includes('disc')) {
    return 'bulleted_list_item';
  }

  // 4. Analyze document patterns - if document heavily uses numbered lists, prefer numbered
  const olCount = $('ol').length;
  const ulCount = $('ul').length;
  if (olCount > ulCount * 2) {
    return 'numbered_list_item';
  }

  // 5. Default to bulleted as last resort (most common list type)
  return 'bulleted_list_item';
}

/**
 * Creates a video block
 */
function createVideoBlock(element: cheerio.Cheerio<Element>, caption = ''): ConvertedNotionBlock {
  const src = element.find('source').attr('src') || element.attr('src') || '';

  const captionRichText = caption
    ? [
        {
          type: 'text',
          text: {
            content: caption,
            link: null,
          },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
          plain_text: caption,
          href: null,
        },
      ]
    : [];

  return {
    object: 'block',
    has_children: false,
    type: 'video',
    video: {
      external: {
        url: src,
      },
      caption: captionRichText,
    },
  };
}

/**
 * Creates an audio block
 */
function createAudioBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const src = element.find('source').attr('src') || element.attr('src') || '';

  return {
    object: 'block',
    has_children: false,
    type: 'audio',
    audio: {
      external: {
        url: src,
      },
      caption: [],
    },
  };
}

/**
 * Creates an embed block from iframe
 */
function createEmbedBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const src = element.attr('src') || '';

  return {
    object: 'block',
    has_children: false,
    type: 'embed',
    embed: {
      url: src,
      caption: [],
    },
  };
}

/**
 * Creates a bookmark block
 */
function createBookmarkBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const href = element.attr('href') || '';

  return {
    object: 'block',
    has_children: false,
    type: 'bookmark',
    bookmark: {
      url: href,
      caption: [],
    },
  };
}

/**
 * Converts nested list elements to hierarchical blocks with proper children structure
 */
function convertNestedListToBlocks(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
  itemType: 'bulleted_list_item' | 'numbered_list_item',
): ConvertedNotionBlock[] {
  const blocks: ConvertedNotionBlock[] = [];
  const directChildren = element.children('li');

  for (let i = 0; i < directChildren.length; i++) {
    const li = directChildren.eq(i);
    const block = convertListItemToBlock($, li, itemType);
    if (block) {
      blocks.push(block);
    }
  }

  return blocks;
}

/**
 * Extracts rich text only from direct children of an element, excluding nested block-level elements
 */
function extractDirectRichTextFromListItem(
  $: cheerio.CheerioAPI,
  li: cheerio.Cheerio<Element>,
): RichTextItemWithResponseFields[] {
  // Create a temporary wrapper to hold only direct content (not nested blocks)
  const tempWrapper = $('<span></span>');

  // Clone each direct child node
  li.contents().each((i, node) => {
    if (node.type === ElementType.Text) {
      // Direct text node - include it
      tempWrapper.append($(node).clone());
    } else if (node.type === ElementType.Tag) {
      const elemNode = node;
      const tagName = elemNode.tagName?.toLowerCase();

      // Exclude block-level elements (ul, ol, p, div, etc.)
      const blockLevelTags = new Set([
        'ul',
        'ol',
        'dl',
        'p',
        'div',
        'blockquote',
        'table',
        'pre',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
      ]);

      if (!blockLevelTags.has(tagName || '')) {
        // Include inline elements like <strong>, <em>, <a>, etc.
        tempWrapper.append($(node).clone());
      }
    }
  });

  // Now extract rich text from the temporary wrapper
  return extractRichTextFromElement(tempWrapper as cheerio.Cheerio<Element>);
}

/**
 * Converts a single list item to a Notion block with proper children handling
 */
function convertListItemToBlock(
  $: cheerio.CheerioAPI,
  li: cheerio.Cheerio<Element>,
  itemType: 'bulleted_list_item' | 'numbered_list_item',
): ConvertedNotionBlock | null {
  // Extract rich text ONLY from direct children, excluding nested block elements
  let richText = extractDirectRichTextFromListItem($, li);

  // Process only block-level child elements recursively (not inline elements like <strong>, <a>, etc.)
  const children: ConvertedNotionBlock[] = [];
  const blockLevelChildren = li.children('ul, ol, dl, p, div, blockquote, table, pre, h1, h2, h3, h4, h5, h6, hr');

  // Check if we need to unwrap a <p> tag for the list item text
  let skipFirstParagraph = false;
  const hasNoDirectText =
    richText.length === 0 || !richText.some((item) => item.type === 'text' && item.text.content.trim());

  if (hasNoDirectText) {
    // No direct text content - check if we have a <p> tag we can unwrap
    const firstChild = blockLevelChildren.first();
    const firstChildTag = firstChild.prop('tagName')?.toLowerCase();

    if (firstChildTag === 'p') {
      // Extract text from the first <p> as the list item's rich text
      richText = extractRichTextFromElement(firstChild);
      skipFirstParagraph = true;
    }
  }

  // Process block-level children (skip first <p> if we unwrapped it)
  blockLevelChildren.each((i, child) => {
    // Skip the first paragraph if we used it as rich text
    if (skipFirstParagraph && i === 0 && $(child).prop('tagName')?.toLowerCase() === 'p') {
      return; // continue to next iteration
    }

    const $child = $(child);
    const convertedBlocks = convertHtmlElementToNotionBlock($, $child);

    if (convertedBlocks) {
      if (Array.isArray(convertedBlocks)) {
        children.push(...convertedBlocks);
      } else {
        children.push(convertedBlocks);
      }
    }
  });

  // If we still have no text content after attempting to unwrap <p>, skip this list item
  if (richText.length === 0 || !richText.some((item) => item.type === 'text' && item.text.content.trim())) {
    return null;
  }

  const hasChildren = children.length > 0;

  const block: ConvertedNotionBlock = {
    object: 'block',
    has_children: hasChildren,
    type: itemType,
    [itemType]: {
      rich_text: richText,
      color: 'default',
    },
  };

  // Add children if they exist
  if (hasChildren) {
    block.children = children;
  }

  return block;
}

/**
 * Handles figure elements that contain images or videos
 */
function handleFigureElement($: cheerio.CheerioAPI, element: cheerio.Cheerio<Element>): ConvertedNotionBlock | null {
  // Look for an image inside the figure
  const img = element.find('img').first();
  if (img.length > 0) {
    // Get caption from figcaption
    const figcaption = element.find('figcaption').first();
    let caption = '';
    if (figcaption.length > 0) {
      const figcaptionText = figcaption.text().trim();
      if (figcaptionText) {
        caption = figcaptionText;
      }
    }
    return createImageBlock(img, caption);
  }

  // Look for an iframe inside the figure (video/embed)
  const iframe = element.find('iframe').first();
  if (iframe.length > 0) {
    const iframeSrc = iframe.attr('src') || '';
    // Get caption from figcaption for video/embed content
    const figcaption = element.find('figcaption').first();
    let caption = '';
    if (figcaption.length > 0) {
      const figcaptionText = figcaption.text().trim();
      if (figcaptionText) {
        caption = figcaptionText;
      }
    }
    // YouTube iframes should be video blocks
    if (iframeSrc.includes('youtube.com/embed')) {
      return createVideoBlock(iframe, caption);
    }
    return createEmbedBlock(iframe);
  }

  return null;
}

/**
 * Creates a code block from pre element
 */
function createCodeBlockFromPre(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  const content = element.text();

  return {
    object: 'block',
    has_children: false,
    type: 'code',
    code: {
      rich_text: [
        {
          type: 'text',
          text: {
            content,
            link: null,
          },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
          plain_text: content,
          href: null,
        },
      ],
      caption: [],
      language: 'plain text',
    },
  };
}

/**
 * Converts description list (dl) elements to a flat sequence of blocks
 */
function convertDescriptionListToBlocks(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
): ConvertedNotionBlock[] {
  const blocks: ConvertedNotionBlock[] = [];

  // Process all dt and dd elements in sequence
  const children = element.children('dt, dd');

  for (let i = 0; i < children.length; i++) {
    const child = children.eq(i);
    const tagName = child.prop('tagName')?.toLowerCase();

    if (tagName === 'dt') {
      // Description term - treat as heading_3
      const termBlock = createDescriptionTermBlock(child);
      if (termBlock) {
        blocks.push(termBlock);
      }
    } else if (tagName === 'dd') {
      // Description definition - process its content including nested lists
      const definitionBlocks = convertDescriptionDefinitionToBlocks($, child);
      if (definitionBlocks) {
        if (Array.isArray(definitionBlocks)) {
          blocks.push(...definitionBlocks);
        } else {
          blocks.push(definitionBlocks);
        }
      }
    }
  }

  return blocks;
}

/**
 * Creates a description term block (dt) as a heading
 */
function createDescriptionTermBlock(element: cheerio.Cheerio<Element>): ConvertedNotionBlock {
  // Use heading_3 for description terms to make them stand out
  return createBlockWithRichText('heading_3', element, { is_toggleable: false });
}

/**
 * Converts description definition (dd) elements to blocks, handling nested content
 */
function convertDescriptionDefinitionToBlocks(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
): ConvertedNotionBlock | ConvertedNotionBlock[] {
  const blocks: ConvertedNotionBlock[] = [];

  // Get the immediate text content (excluding nested elements)
  const clonedElement = element.clone();
  clonedElement.find('ol, ul, dl').remove(); // Remove nested lists temporarily
  const immediateText = clonedElement.text().trim();

  // If there's immediate text content, create a paragraph block for it
  if (immediateText) {
    // Create a simplified element with just the text content
    const textElement = clonedElement;
    const textBlock = createParagraphBlock(textElement);
    blocks.push(textBlock);
  }

  // Process nested lists and other elements
  const nestedElements = element.children('ol, ul, dl, p, div, blockquote');
  for (let i = 0; i < nestedElements.length; i++) {
    const nestedElement = nestedElements.eq(i);
    const nestedBlocks = convertHtmlElementToNotionBlock($, nestedElement);

    if (nestedBlocks) {
      if (Array.isArray(nestedBlocks)) {
        blocks.push(...nestedBlocks);
      } else {
        blocks.push(nestedBlocks);
      }
    }
  }

  // If we only have one block, return it directly; otherwise return array
  if (blocks.length === 1) {
    return blocks[0];
  } else if (blocks.length === 0) {
    // Fallback: create a paragraph block with the full text content
    return createParagraphBlock(element);
  }

  return blocks;
}

/**
 * Converts HTML to hierarchical Notion blocks with proper nesting for complex structures
 */
export function convertToNotionBlocksHierarchical(html: string, isMarkdown: boolean): BlockWithChildren[] {
  let convertedHtml = html;
  if (isMarkdown) {
    const converter = MarkdownIt({});
    convertedHtml = converter.render(html);
  }
  const $ = cheerio.load(convertedHtml);
  const blocks: BlockWithChildren[] = [];

  const bodyContent = $('article').length > 0 ? $('article') : $('body');
  const elements = bodyContent.children();

  for (let i = 0; i < elements.length; i++) {
    const element = elements.eq(i);
    const convertedBlocks = convertHtmlElementToNotionBlockHierarchical($, element);
    if (convertedBlocks) {
      if (Array.isArray(convertedBlocks)) {
        blocks.push(...convertedBlocks);
      } else {
        blocks.push(convertedBlocks);
      }
    }
  }

  return blocks;
}

/**
 * Converts a single HTML element to hierarchical Notion block structure
 */
function convertHtmlElementToNotionBlockHierarchical(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
): BlockWithChildren | BlockWithChildren[] | null {
  const tagName = element.prop('tagName')?.toLowerCase();
  if (!tagName) {
    return null;
  }

  switch (tagName) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'p':
    case 'blockquote': {
      // Simple blocks without nesting
      const simpleBlock = convertHtmlElementToNotionBlock($, element);
      return simpleBlock ? { block: simpleBlock as ConvertedNotionBlock } : null;
    }

    case 'ul':
      return convertNestedListToBlocksHierarchical($, element, 'bulleted_list_item');
    case 'ol':
      return convertNestedListToBlocksHierarchical($, element, 'numbered_list_item');
    case 'dl':
      return convertDescriptionListToBlocksHierarchical($, element);

    default: {
      // For other elements, use the existing converter
      const block = convertHtmlElementToNotionBlock($, element);
      return block ? { block: block as ConvertedNotionBlock } : null;
    }
  }
}

/**
 * Converts nested list elements to hierarchical blocks with proper children structure
 */
function convertNestedListToBlocksHierarchical(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
  itemType: 'bulleted_list_item' | 'numbered_list_item',
): BlockWithChildren[] {
  const blocks: BlockWithChildren[] = [];
  const directChildren = element.children('li');

  for (let i = 0; i < directChildren.length; i++) {
    const li = directChildren.eq(i);
    const block = convertListItemToBlockHierarchical($, li, itemType);
    if (block) {
      blocks.push(block);
    }
  }

  return blocks;
}

/**
 * Converts a single list item to hierarchical block structure
 */
function convertListItemToBlockHierarchical(
  $: cheerio.CheerioAPI,
  li: cheerio.Cheerio<Element>,
  itemType: 'bulleted_list_item' | 'numbered_list_item',
): BlockWithChildren | null {
  // Clone the list item and remove block-level child elements to get the text content
  const clonedLi = li.clone();
  clonedLi.find('ul, ol, dl, p, div, blockquote, table, pre, h1, h2, h3, h4, h5, h6').remove();

  // Extract rich text with formatting from the remaining content
  const richText = extractRichTextFromElement(clonedLi);

  // If we have no text content, skip this list item
  if (richText.length === 0 || !richText.some((item) => item.type === 'text' && item.text.content.trim())) {
    return null;
  }

  const block: ConvertedNotionBlock = {
    object: 'block',
    has_children: false,
    type: itemType,
    [itemType]: {
      rich_text: richText,
      color: 'default',
    },
  };

  // Process children
  const children: BlockWithChildren[] = [];

  // Process nested lists
  const nestedLists = li.children('ol, ul');
  for (let j = 0; j < nestedLists.length; j++) {
    const nestedList = nestedLists.eq(j);
    const nestedTag = nestedList.prop('tagName')?.toLowerCase();
    const nestedItemType = nestedTag === 'ol' ? 'numbered_list_item' : 'bulleted_list_item';

    const nestedBlocks = convertNestedListToBlocksHierarchical($, nestedList, nestedItemType);
    children.push(...nestedBlocks);
  }

  // Process other nested elements (dl, p, div, etc.)
  const otherElements = li.children('dl, p, div, blockquote');
  for (let k = 0; k < otherElements.length; k++) {
    const element = otherElements.eq(k);
    const convertedBlocks = convertHtmlElementToNotionBlockHierarchical($, element);

    if (convertedBlocks) {
      if (Array.isArray(convertedBlocks)) {
        children.push(...convertedBlocks);
      } else {
        children.push(convertedBlocks);
      }
    }
  }

  return {
    block,
    children: children.length > 0 ? children : undefined,
  };
}

/**
 * Converts description list (dl) elements to hierarchical blocks
 */
function convertDescriptionListToBlocksHierarchical(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
): BlockWithChildren[] {
  const blocks: BlockWithChildren[] = [];

  const children = element.children('dt, dd');

  for (let i = 0; i < children.length; i++) {
    const child = children.eq(i);
    const tagName = child.prop('tagName')?.toLowerCase();

    if (tagName === 'dt') {
      // Description term - treat as heading_3
      const termBlock = createDescriptionTermBlock(child);
      if (termBlock) {
        blocks.push({ block: termBlock });
      }
    } else if (tagName === 'dd') {
      // Description definition - process its content including nested lists
      const definitionBlocks = convertDescriptionDefinitionToBlocksHierarchical($, child);
      if (definitionBlocks) {
        if (Array.isArray(definitionBlocks)) {
          blocks.push(...definitionBlocks);
        } else {
          blocks.push(definitionBlocks);
        }
      }
    }
  }

  return blocks;
}

/**
 * Converts description definition (dd) elements to hierarchical blocks
 */
function convertDescriptionDefinitionToBlocksHierarchical(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<Element>,
): BlockWithChildren | BlockWithChildren[] {
  const blocks: BlockWithChildren[] = [];

  // Get the immediate text content (excluding nested elements)
  const clonedElement = element.clone();
  clonedElement.find('ol, ul, dl').remove();
  const immediateText = clonedElement.text().trim();

  // If there's immediate text content, create a paragraph block for it
  if (immediateText) {
    const textElement = clonedElement;
    const textBlock = createParagraphBlock(textElement);
    blocks.push({ block: textBlock });
  }

  // Process nested lists and other elements
  const nestedElements = element.children('ol, ul, dl, p, div, blockquote');
  for (let i = 0; i < nestedElements.length; i++) {
    const nestedElement = nestedElements.eq(i);
    const nestedBlocks = convertHtmlElementToNotionBlockHierarchical($, nestedElement);

    if (nestedBlocks) {
      if (Array.isArray(nestedBlocks)) {
        blocks.push(...nestedBlocks);
      } else {
        blocks.push(nestedBlocks);
      }
    }
  }

  if (blocks.length === 1) {
    return blocks[0];
  } else if (blocks.length === 0) {
    const fallbackBlock = createParagraphBlock(element);
    return { block: fallbackBlock };
  }

  return blocks;
}
