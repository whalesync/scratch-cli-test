import type { RichTextItemResponse } from '@notionhq/client';

/**
 * Rich text item that includes both request fields and response-only fields for round-trip compatibility
 * This matches the Notion API structure for rich text items
 */
export type RichTextItemWithResponseFields = RichTextItemResponse;
/**
 * ConvertedNotionBlock with IDs
 * This are the old blocks that always have IDs
 */
export interface ConvertedNotionBlockWithIds {
  id: string;
  object: 'block';
  has_children: boolean;
  type: string;
  children?: ConvertedNotionBlockWithIds[]; // For recursive diff operations only
  [key: string]: unknown; // For type-specific properties like 'paragraph', 'heading_1', etc.
}

/**
 * Base block structure for our converted blocks
 * Note: For Notion page creation API, blocks should NOT include children at root level
 * - Table blocks: children go inside table.children property (exception)
 * - Toggle blocks: not supported (ignored)
 * - Most other blocks: no children property needed
 * - children: Optional for recursive diff operations (not sent to Notion API)
 */
export interface ConvertedNotionBlock {
  id?: string;
  object: 'block';
  has_children: boolean;
  type: string;
  children?: ConvertedNotionBlock[]; // For recursive diff operations only
  [key: string]: unknown; // For type-specific properties like 'paragraph', 'heading_1', etc.
}
