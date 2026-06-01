import { type RichTextItemResponse } from '@notionhq/client';
import { MarkdownErrors } from '../../../markdown-errors';
import { MarkdownToNotionConverter } from './markdown-to-notion-converter';
import {
  BookmarkBlockValue,
  CalloutBlockValue,
  ChildPageBlockValue,
  CodeBlockValue,
  EmbedBlockValue,
  HeadingBlockValue,
  ListItemBlockValue,
  MediaBlockValue,
  ParagraphBlockValue,
  QuoteBlockValue,
  TableBlockValue,
  TableRowBlockValue,
  TodoBlockValue,
  ToggleBlockValue,
} from './notion-block-value-types';
import { ConvertedNotionBlock } from './notion-rich-text-push-types';

/**
 * NotionMarkdownConverter handles bidirectional conversion between Notion rich text blocks and Markdown.
 *
 * This class provides direct conversion without going through HTML as an intermediate format,
 * preserving more fidelity than the previous chained converter approach.
 */
export class NotionMarkdownConverter {
  /**
   * Converts an array of Notion blocks to Markdown format.
   *
   * @param blocks - Array of Notion block objects (with nested children)
   * @returns Markdown string representation of the blocks
   */
  notionToMarkdown(blocks: ConvertedNotionBlock[]): string {
    const parts: string[] = [];

    for (const block of blocks) {
      const markdown = this.convertBlockToMarkdown(block);
      if (markdown) {
        parts.push(markdown);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Converts a single Notion block to Markdown.
   */
  private convertBlockToMarkdown(block: ConvertedNotionBlock, indent = ''): string {
    const type = block.type;
    const value = block[type];

    switch (type) {
      case 'paragraph':
        return this.convertParagraph(value as ParagraphBlockValue, indent);

      case 'heading_1':
        return this.convertHeading(value as HeadingBlockValue, 1);

      case 'heading_2':
        return this.convertHeading(value as HeadingBlockValue, 2);

      case 'heading_3':
        return this.convertHeading(value as HeadingBlockValue, 3);

      case 'bulleted_list_item':
        return this.convertListItem(block, 'bulleted', indent);

      case 'numbered_list_item':
        return this.convertListItem(block, 'numbered', indent);

      case 'to_do':
        return this.convertTodo(value as TodoBlockValue, block, indent);

      case 'quote':
        return this.convertQuote(value as QuoteBlockValue);

      case 'code':
        return this.convertCode(value as CodeBlockValue);

      case 'divider':
        return '---';

      case 'callout':
        return this.convertCallout(value as CalloutBlockValue);

      case 'toggle':
        return this.convertToggle(value as ToggleBlockValue, block);

      case 'table':
        return this.convertTable(block);

      case 'image':
        return this.convertImage(value as MediaBlockValue);

      case 'video':
        return this.convertVideo(value as MediaBlockValue);

      case 'audio':
        return this.convertAudio(value as MediaBlockValue);

      case 'bookmark':
      case 'link_preview':
        return this.convertBookmark(value as BookmarkBlockValue);

      case 'embed':
        return this.convertEmbed(value as EmbedBlockValue);

      case 'child_page':
        return this.convertChildPage(value as ChildPageBlockValue);

      case 'column_list':
        return this.convertColumnList(block);

      case 'column':
        return this.convertColumn(block);

      default:
        // Unsupported block type - add data loss warning
        return MarkdownErrors.dataLossError(`Unsupported Notion block type: ${type}`);
    }
  }

  private convertParagraph(value: ParagraphBlockValue, indent: string): string {
    const text = this.convertRichText(value.rich_text || []);
    // Empty paragraphs shouldn't produce output
    if (!text.trim()) {
      return '';
    }
    return indent + text;
  }

  private convertHeading(value: HeadingBlockValue, level: number): string {
    const text = this.convertRichText(value.rich_text || []);
    const prefix = '#'.repeat(level);
    return `${prefix} ${text}`;
  }

  private convertListItem(block: ConvertedNotionBlock, type: 'bulleted' | 'numbered', indent: string): string {
    const listType = type === 'bulleted' ? 'bulleted_list_item' : 'numbered_list_item';
    const value = block[listType] as ListItemBlockValue;
    const text = this.convertRichText(value.rich_text || []);

    const bullet = type === 'bulleted' ? '*' : '1.';
    const result = [`${indent}${bullet} ${text}`];

    // Handle nested children
    if (block.has_children && block.children) {
      const childIndent = indent + '  ';
      for (const child of block.children) {
        const childMarkdown = this.convertBlockToMarkdown(child, childIndent);
        if (childMarkdown) {
          result.push(childMarkdown);
        }
      }
    }

    return result.join('\n');
  }

  private convertTodo(value: TodoBlockValue, block: ConvertedNotionBlock, indent: string): string {
    const text = this.convertRichText(value.rich_text || []);
    const checked = value.checked ? 'x' : ' ';
    const result = [`${indent}- [${checked}] ${text}`];

    // Handle nested children
    if (block.has_children && block.children) {
      const childIndent = indent + '  ';
      for (const child of block.children) {
        const childMarkdown = this.convertBlockToMarkdown(child, childIndent);
        if (childMarkdown) {
          result.push(childMarkdown);
        }
      }
    }

    return result.join('\n');
  }

  private convertQuote(value: QuoteBlockValue): string {
    const text = this.convertRichText(value.rich_text || []);
    return `> ${text}`;
  }

  private convertCode(value: CodeBlockValue): string {
    const text = this.convertRichText(value.rich_text || []);
    const language = value.language || '';
    return `\`\`\`${language}\n${text}\n\`\`\``;
  }

  private convertCallout(value: CalloutBlockValue): string {
    // Callouts don't have a native markdown equivalent, so use HTML
    const text = this.convertRichText(value.rich_text || []);
    return `<!-- Notion callout block -->\n<div style="padding: 16px; background-color: #f1f1f1; border-radius: 4px;">\n\n${text}\n\n</div>`;
  }

  private convertToggle(value: ToggleBlockValue, block: ConvertedNotionBlock): string {
    // Toggles don't have a native markdown equivalent, use HTML details/summary
    const text = this.convertRichText(value.rich_text || []);
    const parts = [`<!-- Notion toggle block -->`, `<details>`, `<summary>${text}</summary>`, ``];

    // Handle nested children
    if (block.has_children && block.children) {
      for (const child of block.children) {
        const childMarkdown = this.convertBlockToMarkdown(child, '');
        if (childMarkdown) {
          parts.push(childMarkdown);
        }
      }
    }

    parts.push('</details>');
    return parts.join('\n');
  }

  private convertTable(block: ConvertedNotionBlock): string {
    const tableValue = block.table as TableBlockValue | undefined;
    const hasColumnHeader = tableValue?.has_column_header || false;

    if (!block.children || block.children.length === 0) {
      return MarkdownErrors.dataLossError('Empty Notion table block');
    }

    const rows: string[][] = [];

    // Process each row
    for (const child of block.children) {
      if (child.type === 'table_row') {
        const tableRow = child.table_row as TableRowBlockValue | undefined;
        const cells = tableRow?.cells || [];
        const rowData: string[] = [];

        for (const cell of cells) {
          const cellText = this.convertRichText(cell);
          // Escape pipe characters in cells
          rowData.push(cellText.replace(/\|/g, '\\|'));
        }

        rows.push(rowData);
      }
    }

    if (rows.length === 0) {
      return MarkdownErrors.dataLossError('Notion table with no valid rows');
    }

    // Build markdown table
    const lines: string[] = [];

    // Add header row
    if (hasColumnHeader && rows.length > 0) {
      const headerRow = rows[0];
      lines.push(`| ${headerRow.join(' | ')} |`);
      // Add separator row
      lines.push(`| ${headerRow.map(() => '---').join(' | ')} |`);
      // Add data rows
      for (let i = 1; i < rows.length; i++) {
        lines.push(`| ${rows[i].join(' | ')} |`);
      }
    } else {
      // No header, treat all as data rows
      for (const row of rows) {
        lines.push(`| ${row.join(' | ')} |`);
      }
    }

    return lines.join('\n');
  }

  private convertImage(value: MediaBlockValue): string {
    let url = '';
    if (value.type === 'external') {
      url = value.external?.url || '';
    } else if (value.type === 'file') {
      url = value.file?.url || '';
    }

    const caption = this.convertRichText(value.caption || []);
    // Use caption as alt text, or empty string if no caption (don't default to 'image')
    const altText = caption || '';

    return `![${altText}](${url})`;
  }

  private convertVideo(value: MediaBlockValue): string {
    let url = '';
    if (value.type === 'external') {
      url = value.external?.url || '';
    } else if (value.type === 'file') {
      url = value.file?.url || '';
    }

    // For videos, use HTML since markdown doesn't have native video support
    return `<!-- Notion video block -->\n<video controls src="${url}"></video>`;
  }

  private convertAudio(value: MediaBlockValue): string {
    let url = '';
    if (value.type === 'external') {
      url = value.external?.url || '';
    } else if (value.type === 'file') {
      url = value.file?.url || '';
    }

    // For audio, use HTML since markdown doesn't have native audio support
    return `<!-- Notion audio block -->\n<audio controls src="${url}"></audio>`;
  }

  private convertBookmark(value: BookmarkBlockValue): string {
    const url = value.url || '';
    return `[${url}](${url})`;
  }

  private convertEmbed(value: EmbedBlockValue): string {
    const url = value.url || '';
    // Use HTML iframe for embeds
    return `<!-- Notion embed block -->\n<iframe src="${url}" width="100%" height="400"></iframe>`;
  }

  private convertChildPage(value: ChildPageBlockValue): string {
    // Child pages can't really be represented in markdown, add a note
    const title = value.title || 'Untitled';
    return MarkdownErrors.dataLossError(`Notion child page: ${title}`);
  }

  private convertColumnList(block: ConvertedNotionBlock): string {
    // Column lists are containers for side-by-side columns
    // In markdown, we'll render them as a table for better structure
    if (!block.children || block.children.length === 0) {
      return '';
    }

    const columns = block.children.filter((child) => child.type === 'column');
    if (columns.length === 0) {
      return '';
    }

    // Convert each column's children to markdown
    const columnContents: string[] = [];
    for (const column of columns) {
      const parts: string[] = [];
      if (column.children) {
        for (const child of column.children) {
          const markdown = this.convertBlockToMarkdown(child, '');
          if (markdown) {
            parts.push(markdown);
          }
        }
      }
      columnContents.push(parts.join('\n\n'));
    }

    // Create a markdown table with columns
    const lines: string[] = [];
    lines.push(`<!-- Notion column_list block -->`);
    lines.push(`| ${columnContents.map((_, i) => `Column ${i + 1}`).join(' | ')} |`);
    lines.push(`| ${columnContents.map(() => '---').join(' | ')} |`);
    lines.push(`| ${columnContents.map((content) => content.replace(/\n/g, '<br>')).join(' | ')} |`);

    return lines.join('\n');
  }

  private convertColumn(block: ConvertedNotionBlock): string {
    // Columns are typically children of column_list and should be handled there
    // If we encounter a standalone column, just render its children
    if (!block.children || block.children.length === 0) {
      return '';
    }

    const parts: string[] = [];
    for (const child of block.children) {
      const markdown = this.convertBlockToMarkdown(child, '');
      if (markdown) {
        parts.push(markdown);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Converts Notion rich text array to markdown string with inline formatting.
   */
  private convertRichText(richText: RichTextItemResponse[]): string {
    if (!richText || richText.length === 0) {
      return '';
    }

    const parts: string[] = [];

    for (const item of richText) {
      if (item.type !== 'text') {
        // For non-text items (equations, mentions), use plain text
        parts.push(item.plain_text || '');
        continue;
      }

      let text = item.text?.content || item.plain_text || '';
      const annotations = item.annotations || {};

      // Apply formatting in specific order to handle nested formatting
      if (annotations.code) {
        text = `\`${text}\``;
      }

      if (annotations.bold) {
        text = `**${text}**`;
      }

      if (annotations.italic) {
        text = `*${text}*`;
      }

      if (annotations.strikethrough) {
        text = `~~${text}~~`;
      }

      if (annotations.underline) {
        // Markdown doesn't have underline, use HTML
        text = `<u>${text}</u>`;
      }

      // Handle links
      if (item.text?.link?.url) {
        text = `[${text}](${item.text.link.url})`;
      }

      parts.push(text);
    }

    return parts.join('');
  }

  /**
   * Converts Markdown text to an array of Notion blocks.
   *
   * @param markdown - Markdown string to convert
   * @returns Array of Notion block objects ready to be pushed to Notion API
   */
  markdownToNotion(markdown: string): ConvertedNotionBlock[] {
    // Use direct markdown-to-notion converter (no HTML intermediary)
    const converter = new MarkdownToNotionConverter();
    const notionBlocks = converter.convert(markdown);
    return notionBlocks;
  }
}
