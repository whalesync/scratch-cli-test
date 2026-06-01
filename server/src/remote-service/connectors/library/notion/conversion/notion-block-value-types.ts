/**
 * Type definitions for Notion block values used in markdown conversion.
 * These are simplified versions of the official Notion API types,
 * containing only the fields we need for conversion.
 */

import { type RichTextItemResponse } from '@notionhq/client';

export interface NotionColor {
  color?: string;
}

export interface ParagraphBlockValue extends NotionColor {
  rich_text: RichTextItemResponse[];
}

export interface HeadingBlockValue extends NotionColor {
  rich_text: RichTextItemResponse[];
  is_toggleable?: boolean;
}

export interface ListItemBlockValue extends NotionColor {
  rich_text: RichTextItemResponse[];
}

export interface TodoBlockValue extends NotionColor {
  rich_text: RichTextItemResponse[];
  checked: boolean;
}

export interface QuoteBlockValue extends NotionColor {
  rich_text: RichTextItemResponse[];
}

export interface CodeBlockValue {
  rich_text: RichTextItemResponse[];
  language: string;
  caption?: RichTextItemResponse[];
}

export interface CalloutBlockValue extends NotionColor {
  rich_text: RichTextItemResponse[];
  icon?: {
    type: 'emoji' | 'external' | 'file';
    emoji?: string;
  };
}

export interface ToggleBlockValue extends NotionColor {
  rich_text: RichTextItemResponse[];
}

export interface TableBlockValue {
  table_width: number;
  has_column_header: boolean;
  has_row_header: boolean;
}

export interface TableRowBlockValue {
  cells: RichTextItemResponse[][];
}

export interface MediaBlockValue {
  type: 'external' | 'file';
  external?: { url: string };
  file?: { url: string };
  caption?: RichTextItemResponse[];
}

export interface BookmarkBlockValue {
  url: string;
  caption?: RichTextItemResponse[];
}

export interface EmbedBlockValue {
  url: string;
  caption?: RichTextItemResponse[];
}

export interface ChildPageBlockValue {
  title: string;
}

// Dividers have no properties
export type DividerBlockValue = Record<string, never>;

// Column lists are just containers
export type ColumnListBlockValue = Record<string, never>;

// Columns are just containers
export type ColumnBlockValue = Record<string, never>;
