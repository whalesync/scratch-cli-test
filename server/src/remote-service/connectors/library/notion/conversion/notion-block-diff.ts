import * as _ from 'lodash';
import { ConvertedNotionBlock, ConvertedNotionBlockWithIds } from './notion-rich-text-push-types';

/** Safely access the type-specific value object from a block (e.g., block.paragraph, block.heading_1). */
function getBlockValue(block: ConvertedNotionBlock | ConvertedNotionBlockWithIds): Record<string, unknown> | undefined {
  return block[block.type] as Record<string, unknown> | undefined;
}

interface RichTextItem {
  plain_text?: string;
  text?: { content?: string };
}

/**
 * Different types of operations that can be performed on Notion blocks
 */
export type NotionBlockOperation =
  | { type: 'create'; block: ConvertedNotionBlock[]; after?: string; creationOrder?: number }
  | { type: 'update'; blockId: string; block: ConvertedNotionBlock }
  | { type: 'delete'; blockId: string }
  | { type: 'update_children'; blockId: string; childOperations: NotionBlockOperation[]; parentOrder?: string };

/**
 * Result of the block diff analysis containing operations to perform
 */
export interface NotionBlockDiffResult {
  operations: NotionBlockOperation[];
  idMappings?: [string, string][];
}

/**
 * Processes a list of blocks and returns both a map and set of IDs in one pass
 * Blocks without IDs are tracked separately
 */
function processBlocks(blocks: ConvertedNotionBlock[]): {
  blockMap: Map<string, ConvertedNotionBlock>;
  blockIds: Set<string>;
  blocksWithoutIds: ConvertedNotionBlock[];
} {
  const blockMap = new Map<string, ConvertedNotionBlock>();
  const blockIds = new Set<string>();
  const blocksWithoutIds: ConvertedNotionBlock[] = [];

  for (const block of blocks) {
    if (block?.id) {
      blockMap.set(block.id, block);
      blockIds.add(block.id);
    } else {
      blocksWithoutIds.push(block);
    }
  }

  return { blockMap, blockIds, blocksWithoutIds };
}

/**
 * Processes a list of blocks and returns both a map and set of IDs in one pass
 * Blocks without IDs are tracked separately
 */
function processOldBlocks(blocks: ConvertedNotionBlockWithIds[]): {
  blockMap: Map<string, ConvertedNotionBlockWithIds>;
  blockIds: Set<string>;
  blocksWithoutIds: ConvertedNotionBlockWithIds[];
} {
  const blockMap = new Map<string, ConvertedNotionBlockWithIds>();
  const blockIds = new Set<string>();
  const blocksWithoutIds: ConvertedNotionBlockWithIds[] = [];

  for (const block of blocks) {
    if (block?.id) {
      blockMap.set(block.id, block);
      blockIds.add(block.id);
    } else {
      blocksWithoutIds.push(block);
    }
  }

  return { blockMap, blockIds, blocksWithoutIds };
}

/**
 * Detects if there are insertions at the top level that require rewriting everything.
 * This is needed because Notion API only supports "after" parameter, not "before",
 * so inserting at position 0 requires deleting and recreating all blocks.
 */
function detectTopLevelInsertion(
  newBlocks: ConvertedNotionBlock[],
  oldProcessed: { blockMap: Map<string, ConvertedNotionBlockWithIds>; blockIds: Set<string> },
): boolean {
  if (newBlocks.length === 0 || oldProcessed.blockIds.size === 0) {
    return false;
  }

  // Check if the first block is new (not in old content) - true insertion at top
  const firstNewBlock = newBlocks[0];
  if (!firstNewBlock?.id || !oldProcessed.blockIds.has(firstNewBlock.id)) {
    // Additional validation: make sure this is actually a new block, not just a block
    // that lost its ID during HTML conversion but is actually an existing block

    // Handle hierarchical/temporary IDs (e.g., "temp.1", "existing.1")
    // These indicate new blocks that were assigned temporary IDs
    if (firstNewBlock?.id && (firstNewBlock.id.startsWith('temp.') || firstNewBlock.id.startsWith('existing.'))) {
      // This is a temporary ID assigned to a new block, so it's a true insertion
      return true;
    }

    // If the block has no ID but could potentially match an existing block by content,
    // this might be a reorder scenario where IDs were lost, not a true insertion
    if (!firstNewBlock?.id) {
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Gets the key properties to compare for a specific block type
 * This allows for more efficient, targeted comparisons
 */
function getKeyPropertiesForBlockType(blockType: string): string[] {
  switch (blockType) {
    // Text-based blocks - compare rich_text and color
    // Note: has_children is excluded since it's derived from children existence
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'quote':
    case 'toggle':
    case 'template':
      return [blockType, 'type'];

    // To-do blocks - also compare checked status
    case 'to_do':
      return ['to_do', 'type'];

    // Code blocks - compare rich_text, language, and caption
    case 'code':
      return ['code', 'type'];

    // Media blocks - compare URL and caption
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
    case 'file':
      return [blockType, 'type'];

    // Embed/bookmark blocks - compare URL and caption
    case 'embed':
    case 'bookmark':
      return [blockType, 'type'];

    // Callout blocks - compare rich_text, icon, and color
    case 'callout':
      return ['callout', 'type'];

    // Table blocks - compare has_column_header, has_row_header
    case 'table':
      return ['table', 'type'];

    // Table row blocks - compare cells
    case 'table_row':
      return ['table_row', 'type'];

    // Simple blocks with no content
    case 'divider':
    case 'breadcrumb':
      return ['type'];

    // Table of contents - compare color
    case 'table_of_contents':
      return ['table_of_contents', 'type'];

    // Link to page - compare page_id or database_id
    case 'link_to_page':
      return ['link_to_page', 'type'];

    // Equation - compare expression
    case 'equation':
      return ['equation', 'type'];

    // Synced blocks - compare synced_from
    case 'synced_block':
      return ['synced_block', 'type'];

    // For unknown or unsupported types, fall back to excluding only metadata
    default:
      return ['type', blockType];
  }
}

/**
 * Performs a targeted comparison of two blocks based on their type
 * Only compares properties that are relevant for the specific block type
 * IMPORTANT: Excludes children from comparison - children changes are handled via update_children operations
 */
function areBlocksEquivalentByTypeKeys(block1: ConvertedNotionBlock, block2: ConvertedNotionBlock): boolean {
  // For content comparison, we'll use our content extraction function
  // This is more reliable than trying to compare nested properties
  const content1 = extractBlockContent(block1);
  const content2 = extractBlockContent(block2);

  if (content1 !== content2) {
    return false; // Different content - NOT equivalent
  }

  // Compare other structural properties, but explicitly exclude children-related properties
  const keyProperties = getKeyPropertiesForBlockType(block1.type);

  for (const property of keyProperties) {
    // Skip children and has_children properties as they are handled separately
    if (property === 'children' || property === 'has_children') {
      continue;
    }

    const value1 = (block1 as unknown as Record<string, unknown>)[property];
    const value2 = (block2 as unknown as Record<string, unknown>)[property];
    if (property === 'image') {
      // Images have a type property that we should not compare.
      // lets special case this for images.
      if (typeof value1 === 'object' && value1 !== null) delete (value1 as Record<string, unknown>)['type'];
      if (typeof value2 === 'object' && value2 !== null) delete (value2 as Record<string, unknown>)['type'];
    }
    if (!_.isEqual(value1, value2)) {
      return false; // Different - NOT equivalent
    }
  }

  // Note: We explicitly don't compare children here because children are handled separately
  // via update_children operations. Only the parent block's own content matters here.

  return true; // Same - ARE equivalent
}

/**
 * Compares two NotionBlockObjects to determine if they are different
 * Uses type-specific comparison for better performance and accuracy
 * Optimized with early returns and targeted property checking
 */
function areBlocksEquivalent(block1: ConvertedNotionBlock, block2: ConvertedNotionBlock): boolean {
  // Early return for same reference
  if (block1 === block2) {
    return false;
  }

  // Quick checks for obvious differences before expensive deep comparison
  if (block1.type !== block2.type) {
    return true;
  }

  if (block1.object !== block2.object) {
    return true;
  }

  // Use type-specific comparison for better performance
  return areBlocksEquivalentByTypeKeys(block1, block2);
}

/**
 * Helper function to extract text content from a block for comparison
 */
export function extractBlockContent(block: ConvertedNotionBlock): string {
  const val = getBlockValue(block);

  // Extract text from a rich_text array. Supports both plain_text (API) and text.content (test data).
  const extractRichText = (richText: unknown): string => {
    if (!Array.isArray(richText)) return '';
    return (richText as RichTextItem[]).map((rt) => rt.plain_text || rt.text?.content || '').join('');
  };

  // Extract caption text from a media block's caption array
  const extractCaption = (caption: unknown): string => {
    if (!Array.isArray(caption)) return '';
    return (caption as RichTextItem[]).map((rt) => rt.plain_text || '').join('');
  };

  // Extract URL from a media block value (external or file)
  const extractMediaUrl = (v: Record<string, unknown> | undefined): string => {
    const ext = v?.external as Record<string, unknown> | undefined;
    const file = v?.file as Record<string, unknown> | undefined;
    return (ext?.url as string) || (file?.url as string) || '';
  };

  switch (block.type) {
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'quote':
    case 'callout':
    case 'to_do':
    case 'toggle':
    case 'code':
      return extractRichText(val?.rich_text);
    case 'image': {
      const imageUrl = extractMediaUrl(val);
      const imageCaption = extractCaption(val?.caption);
      return imageUrl ? `image:${imageUrl}` : imageCaption;
    }
    case 'video':
      return extractCaption(val?.caption) || `video:${extractMediaUrl(val)}`;
    case 'audio':
      return extractCaption(val?.caption) || `audio:${extractMediaUrl(val)}`;
    case 'file':
      return extractCaption(val?.caption) || `file:${extractMediaUrl(val)}`;
    case 'pdf':
      return extractCaption(val?.caption) || `pdf:${extractMediaUrl(val)}`;
    case 'bookmark':
      return `bookmark:${(val?.url as string) || ''}`;
    case 'embed':
      return `embed:${(val?.url as string) || ''}`;
    case 'divider':
      return 'divider';
    case 'table_of_contents':
      return 'table_of_contents';
    case 'breadcrumb':
      return 'breadcrumb';
    case 'table':
      return `table:${(val?.table_width as number) || 0}x${(block.children as unknown[] | undefined)?.length || 0}`;
    case 'table_row': {
      const cells = val?.cells;
      if (!Array.isArray(cells)) return '';
      return (cells as unknown[][]).map((cell) => extractRichText(cell)).join('|');
    }
    case 'column_list':
      return 'column_list';
    case 'column':
      return 'column';
    case 'link_to_page':
      return `link_to_page:${(val?.page_id as string) || (val?.database_id as string) || ''}`;
    case 'equation':
      return (val?.expression as string) || '';
    case 'synced_block': {
      const syncedFrom = val?.synced_from as Record<string, unknown> | undefined;
      return `synced_block:${(syncedFrom?.block_id as string) || 'original'}`;
    }
    default:
      // For unknown types, try to extract common properties
      if (block['rich_text'] !== undefined) {
        return extractRichText(block['rich_text']);
      }
      return JSON.stringify(block);
  }
}

/**
 * Calculate content similarity percentage between two blocks
 */
function calculateContentSimilarity(block1: ConvertedNotionBlock, block2: ConvertedNotionBlock): number {
  const content1 = extractBlockContent(block1);
  const content2 = extractBlockContent(block2);

  if (content1 === content2) {
    return 100;
  }

  if (content1.length === 0 && content2.length === 0) {
    return 100;
  }

  if (content1.length === 0 || content2.length === 0) {
    return 0;
  }

  // For very short content differences, be more lenient
  const maxLength = Math.max(content1.length, content2.length);
  if (maxLength <= 50) {
    // Split into words and compare
    const words1 = content1.toLowerCase().split(/\s+/);
    const words2 = content2.toLowerCase().split(/\s+/);

    const allWords = new Set([...words1, ...words2]);
    const commonWords = words1.filter((word) => words2.includes(word));

    const wordSimilarity = (commonWords.length / allWords.size) * 100;

    // Also consider character-level similarity
    let matches = 0;
    const minLength = Math.min(content1.length, content2.length);
    for (let i = 0; i < minLength; i++) {
      if (content1.toLowerCase()[i] === content2.toLowerCase()[i]) {
        matches++;
      }
    }
    const charSimilarity = (matches / maxLength) * 100;

    // Return the higher of word or character similarity
    return Math.max(wordSimilarity, charSimilarity);
  }

  // For longer content, use the original algorithm
  const longer = content1.length > content2.length ? content1 : content2;
  const shorter = content1.length > content2.length ? content2 : content1;

  if (longer.length === 0) {
    return 100;
  }

  // Check if shorter is contained in longer
  if (longer.includes(shorter)) {
    return (shorter.length / longer.length) * 100;
  }

  // Calculate character-level similarity
  let matches = 0;
  const minLength = Math.min(content1.length, content2.length);

  for (let i = 0; i < minLength; i++) {
    if (content1[i] === content2[i]) {
      matches++;
    }
  }

  return (matches / Math.max(content1.length, content2.length)) * 100;
}

/**
 * Determines if this is likely a true top-level insertion (new block at position 0)
 * vs. a complex reordering scenario that happens to have first block without ID.
 *
 * For a true top-level insertion:
 * - First new block should be new content (no matching old block)
 * - Remaining new blocks should match old blocks in sequence (content-wise)
 * - Should not be a complex reordering with swaps and insertions
 */
function isLikelyTopLevelInsertion(
  oldBlocks: ConvertedNotionBlockWithIds[],
  newBlocks: ConvertedNotionBlock[],
): boolean {
  // Need at least one old block and at least two new blocks (insertion + existing)
  if (oldBlocks.length === 0 || newBlocks.length < 2) {
    return false;
  }

  // Check if blocks starting from position 1 in newBlocks have similar content
  // to blocks starting from position 0 in oldBlocks (indicating a shift)
  let matchCount = 0;
  const maxChecks = Math.min(oldBlocks.length, newBlocks.length - 1);

  for (let i = 0; i < maxChecks; i++) {
    const oldBlock = oldBlocks[i];
    const newBlock = newBlocks[i + 1]; // +1 because we're checking if position 0 is inserted

    // Simple content similarity check
    const oldContent = extractBlockContent(oldBlock);
    const newContent = extractBlockContent(newBlock);

    if (oldContent === newContent || calculateContentSimilarity(oldBlock, newBlock) >= 80) {
      matchCount++;
    }
  }

  // If most blocks match when shifted by 1 position, it's likely a top insertion
  const matchRatio = matchCount / maxChecks;
  return matchRatio >= 0.8; // 80% of blocks should match when shifted
}

/**
 * Assigns IDs to new blocks based on matching with old blocks
 * Strategy:
 * 1. First pass: Try position-based matching for exact content matches (preserves order)
 * 2. Second pass: Content-based matching for remaining blocks (handles insertions/moves)
 * 3. For blocks with slight content changes, use similarity matching for updates
 */
export function assignIdsToNewBlocks(
  oldBlocks: ConvertedNotionBlockWithIds[],
  newBlocks: ConvertedNotionBlock[],
): ConvertedNotionBlock[] {
  const result: ConvertedNotionBlock[] = [];
  const usedOldBlocks = new Set<string>();

  // Detect potential top-level insertion: first new block has no ID but old blocks exist
  // and subsequent blocks' content matches original blocks (indicating a shift, not reorder)
  const hasTopLevelInsertion =
    oldBlocks.length > 0 &&
    newBlocks.length > oldBlocks.length &&
    newBlocks.length > 0 &&
    (!newBlocks[0].id || !isValidNotionId(newBlocks[0].id)) &&
    // Additional validation: check if this is truly a top insertion vs. complex reordering
    isLikelyTopLevelInsertion(oldBlocks, newBlocks);

  // First pass: Position-based matching for content and updates
  for (let i = 0; i < newBlocks.length; i++) {
    const newBlock = { ...newBlocks[i] };

    // Preserve hierarchical IDs that were already assigned for top-level insertion detection
    const hasHierarchicalId = newBlock.id && (newBlock.id.startsWith('temp.') || newBlock.id.startsWith('existing.'));

    // When we have a top-level insertion, shift the matching by 1 position
    const oldIndex = hasTopLevelInsertion ? i - 1 : i;

    // Strategy 1: Try exact match by position (order-sensitive, with potential offset)
    if (oldIndex >= 0 && oldIndex < oldBlocks.length && !hasHierarchicalId) {
      const oldBlock = oldBlocks[oldIndex];

      // Only assign IDs if types match - different types should be treated as delete + create
      if (oldBlock.type === newBlock.type && oldBlock.id && !usedOldBlocks.has(oldBlock.id)) {
        // Check if content is exactly the same
        const oldContent = extractBlockContent(oldBlock);
        const newContent = extractBlockContent(newBlock);

        if (oldContent === newContent) {
          newBlock.id = oldBlock.id;
          usedOldBlocks.add(oldBlock.id);

          // RECURSIVELY assign IDs to children if both old and new blocks have children
          if (oldBlock.children && newBlock.children) {
            newBlock.children = assignIdsToNewBlocks(oldBlock.children, newBlock.children);
          }
        } else {
          // Strategy 2: Try partial match with same type and position for content updates
          const similarity = calculateContentSimilarity(oldBlock, newBlock);

          if (similarity >= 15 && !hasHierarchicalId) {
            newBlock.id = oldBlock.id;
            usedOldBlocks.add(oldBlock.id);

            // RECURSIVELY assign IDs to children if both old and new blocks have children
            if (oldBlock.children && newBlock.children) {
              newBlock.children = assignIdsToNewBlocks(oldBlock.children, newBlock.children);
            }
          }
        }
      }
    }

    result.push(newBlock);
  }

  // Second pass: Content-based matching for unmatched blocks (handles middle insertions)
  for (let newIndex = 0; newIndex < result.length; newIndex++) {
    const newBlock = result[newIndex];

    // Skip if this block already has an ID that was assigned (i.e., already matched)
    if (newBlock.id && usedOldBlocks.has(newBlock.id)) {
      continue;
    }

    // Skip if this block has a hierarchical ID that should be preserved
    const hasHierarchicalId = newBlock.id && (newBlock.id.startsWith('temp.') || newBlock.id.startsWith('existing.'));
    if (hasHierarchicalId) {
      continue;
    }

    const newContent = extractBlockContent(newBlock);

    // Search through all old blocks for exact content matches
    for (let oldIndex = 0; oldIndex < oldBlocks.length; oldIndex++) {
      const oldBlock = oldBlocks[oldIndex];

      // Skip if this old block is already used or types don't match
      if (!oldBlock.id || usedOldBlocks.has(oldBlock.id) || oldBlock.type !== newBlock.type) {
        continue;
      }

      const oldContent = extractBlockContent(oldBlock);

      // Check for exact content match
      if (oldContent === newContent) {
        // For simple insertion scenarios (like middle insertion), allow content-based matching
        // Check if this looks like a simple insertion rather than complex reordering
        const isLikelySimpleInsertion = isSimpleInsertionScenario(newIndex, oldIndex, result, oldBlocks, usedOldBlocks);

        if (isLikelySimpleInsertion) {
          newBlock.id = oldBlock.id;
          usedOldBlocks.add(oldBlock.id);

          // RECURSIVELY assign IDs to children if both old and new blocks have children
          if (oldBlock.children && newBlock.children) {
            newBlock.children = assignIdsToNewBlocks(oldBlock.children, newBlock.children);
          }

          break; // Found a match, no need to continue searching for this block
        }
      }
    }
  }

  return result;
}

/**
 * Determines if this is an insertion scenario by checking what's between old and new positions
 * Key logic: If blocks between old and new positions are new blocks (creates), it's an insertion.
 * If blocks between old and new positions are existing blocks, it's a swap/reorder.
 */
function isSimpleInsertionScenario(
  newPosition: number,
  oldPosition: number,
  newBlocks: ConvertedNotionBlock[],
  oldBlocks: ConvertedNotionBlockWithIds[],
  usedOldBlocks: Set<string>,
): boolean {
  // If we have fewer or equal new blocks than old blocks, this can't be an insertion scenario
  if (newBlocks.length <= oldBlocks.length) {
    return false;
  }

  // Get the content of the current block we're trying to match
  const currentNewBlock = newBlocks[newPosition];
  const currentContent = extractBlockContent(currentNewBlock);

  // Check if this specific block participates in a relative order swap
  // Build a map of content to positions for blocks that haven't been used yet
  const contentToOldPosition = new Map<string, number>();
  const contentToNewPosition = new Map<string, number>();

  for (let i = 0; i < oldBlocks.length; i++) {
    const oldBlock = oldBlocks[i];
    if (oldBlock.id && !usedOldBlocks.has(oldBlock.id)) {
      const content = extractBlockContent(oldBlock);
      contentToOldPosition.set(content, i);
    }
  }

  for (let i = 0; i < newBlocks.length; i++) {
    const newBlock = newBlocks[i];
    const content = extractBlockContent(newBlock);
    if (contentToOldPosition.has(content)) {
      contentToNewPosition.set(content, i);
    }
  }

  // Check if the current block swaps relative order with any other existing block
  for (const [otherContent, otherOldPos] of contentToOldPosition.entries()) {
    if (otherContent === currentContent) {
      continue;
    } // Skip self

    const otherNewPos = contentToNewPosition.get(otherContent);
    if (otherNewPos === undefined) {
      continue;
    } // Other block not in new sequence

    const currentOldPos = oldPosition;
    const currentNewPos = newPosition;

    // Check if relative order is swapped between current block and other block
    const oldRelativeOrder = currentOldPos < otherOldPos;
    const newRelativeOrder = currentNewPos < otherNewPos;

    if (oldRelativeOrder !== newRelativeOrder) {
      // Current block participates in a swap with another block
      return false;
    }
  }

  // If we get here, current block doesn't participate in any swaps - allow ID assignment
  return true;
}

/**
 * Recursively processes children blocks and generates child operations
 * just a wrapper to createNotionBlockDiff for children operations
 */
function processChildrenRecursively(
  oldBlock: ConvertedNotionBlockWithIds | undefined,
  newBlock: ConvertedNotionBlock,
  remoteBaseId: string,
): NotionBlockOperation[] {
  const childOperations: NotionBlockOperation[] = [];

  // If the new block has children, process them
  if (newBlock.children && newBlock.children.length > 0) {
    const oldChildren = oldBlock?.children || [];

    // ID assignment will be handled by createNotionBlockDiffForChildren

    // Get operations for children by comparing old and new children directly
    // Force ID assignment for children to enable proper top-level insertion detection
    const childDiffResult = assignIdsAndReturnOperations(oldChildren, newBlock.children, remoteBaseId, true);

    childOperations.push(...childDiffResult.operations);
  } else if (oldBlock?.children && oldBlock.children.length > 0) {
    // If old block had children but new block doesn't, delete all children
    for (const child of oldBlock.children) {
      if (child.id) {
        childOperations.push({ type: 'delete', blockId: child.id });

        // Recursively delete grandchildren
        if (child.children && child.children.length > 0) {
          const grandchildDeleteOps = processChildrenRecursively(child, { ...child, children: [] }, remoteBaseId);
          childOperations.push(...grandchildDeleteOps);
        }
      }
    }
  }

  return childOperations;
}

/**
 * Assigns hierarchical matrix-based temporary IDs to blocks for tracking during creation
 * Examples: "temp.1", "temp.1.2", "temp.1.2.3" for parent.child.grandchild relationships
 * This is important because we need to keep track of blocks and IDs and hierarchical relationships to handle create operations correctly.
 */
function assignHierarchicalIds(
  blocks: ConvertedNotionBlock[],
  parentPath = '',
  idMappings: Map<string, string> = new Map(),
): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockPath = parentPath ? `${parentPath}.${i + 1}` : `${i + 1}`;

    // If block doesn't have a real Notion ID, assign a hierarchical temporary ID
    if (!block.id || !isValidNotionId(block.id)) {
      const tempId = `temp.${blockPath}`;
      block.id = tempId;
      // Pre-populate ID mappings for temporary IDs
      idMappings.set(tempId, tempId);
    }

    // Recursively assign hierarchical IDs to children
    if (block.children && block.children.length > 0) {
      assignHierarchicalIds(block.children, blockPath, idMappings);
    }
  }
}

/**
 * Checks if an ID looks like a valid Notion ID (UUID format with dashes)
 */
function isValidNotionId(id: string): boolean {
  // Notion IDs are UUIDs in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

export function assignIdsAndReturnOperations(
  oldPageContent: ConvertedNotionBlockWithIds[] | undefined,
  newPageContent: ConvertedNotionBlock[],
  remoteBaseId: string,
  forceIdAssignment = false,
): NotionBlockDiffResult {
  const idMappings = new Map<string, string>();

  // NEW: First try to assign IDs via content matching if we have existing content
  let processedNewPageContent = newPageContent;
  const hasExistingContent =
    oldPageContent &&
    oldPageContent.length > 0 &&
    oldPageContent.some((block) => block.id && isValidNotionId(block.id));

  if (hasExistingContent) {
    // First pass: assign IDs to matching blocks via content matching
    processedNewPageContent = assignIdsToNewBlocks(oldPageContent, newPageContent);
  }

  // Determine if we should assign hierarchical IDs to remaining blocks without IDs
  const hasNewBlocksWithoutIds = processedNewPageContent.some((block) => !block.id || !isValidNotionId(block.id));
  const shouldAssignIds = !hasExistingContent || (forceIdAssignment && hasNewBlocksWithoutIds);

  if (shouldAssignIds) {
    // Assign hierarchical matrix-based temporary IDs to new blocks for creation tracking
    // Only assign to blocks that still don't have valid IDs after content matching
    assignHierarchicalIds(processedNewPageContent, '', idMappings);
  }

  const result = createNotionBlockDiffCore(oldPageContent, processedNewPageContent, remoteBaseId);

  // Include ID mappings in result if any were created
  if (idMappings.size > 0) {
    result.idMappings = Array.from(idMappings.entries());
  }

  return result;
}

function createNotionBlockDiffCore(
  oldPageContent: ConvertedNotionBlockWithIds[] | undefined,
  newPageContent: ConvertedNotionBlock[],
  remoteBaseId: string,
): NotionBlockDiffResult {
  const hasExistingBlocks = oldPageContent && oldPageContent.length > 0;
  // If there are no existing blocks, we create all new blocks and process their children
  if (!hasExistingBlocks) {
    const operations: NotionBlockOperation[] = [];
    const idMappings = new Map<string, string>();

    operations.push({ type: 'create', block: newPageContent, creationOrder: 0 });

    // Process children for newly created blocks
    for (const block of newPageContent) {
      if (block.children && block.children.length > 0 && block.id) {
        const childOperations = processChildrenRecursively(undefined, block, remoteBaseId);
        if (childOperations.length > 0) {
          operations.push({
            type: 'update_children',
            blockId: block.id,
            childOperations,
            parentOrder: block.id?.startsWith('temp.') ? block.id.replace('temp.', '') : undefined,
          });
        }
      }
    }

    return { operations, idMappings: Array.from(idMappings.entries()) };
  }

  const convertedBlocks = oldPageContent;

  const operations: NotionBlockOperation[] = [];

  // Note: ID assignment is now handled in assignIdsAndReturnOperations before this function is called
  const blocksWithIds = newPageContent;

  // Process both old and new blocks in single passes
  const oldProcessed = processOldBlocks(convertedBlocks);
  const newProcessed = processBlocks(blocksWithIds);

  // If this is a top level insertion drop work and just re write everything.
  // Notion doesn't have a before parameter, so we have to re write everything to get the correct order.
  const hasTopLevelInsertion = detectTopLevelInsertion(blocksWithIds, oldProcessed);

  if (hasTopLevelInsertion) {
    // When inserting at the top, Notion API limitation requires us to delete all existing blocks
    // and recreate the entire structure since there's no "before" parameter, only "after"
    const operations: NotionBlockOperation[] = [];

    // Delete all existing blocks
    for (const blockId of oldProcessed.blockIds) {
      operations.push({ type: 'delete', blockId });
    }

    // Create all new blocks
    operations.push({ type: 'create', block: blocksWithIds, creationOrder: 0 });

    // Process children for newly created blocks
    for (const block of blocksWithIds) {
      if (block.children && block.children.length > 0 && block.id) {
        const childOperations = processChildrenRecursively(undefined, block, remoteBaseId);
        if (childOperations.length > 0) {
          operations.push({
            type: 'update_children',
            blockId: block.id,
            childOperations,
            parentOrder: block.id?.startsWith('temp.') ? block.id.replace('temp.', '') : undefined,
          });
        }
      }
    }

    return { operations };
  }

  // Process blocks in order to maintain position context and enable efficient batching
  let lastExistingBlockId: string | undefined = undefined;
  let pendingCreates: ConvertedNotionBlock[] = [];
  let creationOrderCounter = 0;

  const deletePendingCreates = (): void => {
    if (pendingCreates.length > 0) {
      operations.push({
        type: 'create',
        block: [...pendingCreates],
        after: lastExistingBlockId,
        creationOrder: creationOrderCounter++,
      });
      pendingCreates = [];
    }
  };

  for (const newBlock of blocksWithIds) {
    if (newBlock?.id && oldProcessed.blockMap.has(newBlock.id)) {
      const oldBlock = oldProcessed.blockMap.get(newBlock.id)!;

      // If block types are different, we need to delete the old block and create a new one
      // Notion API doesn't support changing block types via update
      if (oldBlock.type !== newBlock.type) {
        operations.push({ type: 'delete', blockId: newBlock.id });
        // Treat this as a new block to be created (remove the ID so it gets a new one)
        const newBlockForCreation = { ...newBlock };
        delete newBlockForCreation.id;
        pendingCreates.push(newBlockForCreation);
        // Don't update lastExistingBlockId since this block will be deleted
      } else {
        // Block exists and type hasn't changed - flush pending creates first
        deletePendingCreates();

        if (!areBlocksEquivalent(oldBlock, newBlock)) {
          operations.push({ type: 'update', blockId: newBlock.id, block: newBlock });
        }
        // No operation needed if blocks are the same

        // Process children recursively for this block
        const childOperations = processChildrenRecursively(oldBlock, newBlock, remoteBaseId);
        if (childOperations.length > 0) {
          operations.push({
            type: 'update_children',
            blockId: newBlock.id,
            childOperations,
            parentOrder: newBlock.id?.startsWith('temp.') ? newBlock.id.replace('temp.', '') : undefined,
          });
        }

        // Update the last existing block ID for future creates
        lastExistingBlockId = newBlock.id;
      }
    } else {
      // Block doesn't exist in old content or has no ID - add to pending creates
      pendingCreates.push(newBlock);
    }
  }

  // Delete remaining pending creates
  deletePendingCreates();

  // Process deleted blocks (exist in old but not in new)
  for (const blockId of oldProcessed.blockIds) {
    if (!newProcessed.blockIds.has(blockId)) {
      operations.push({ type: 'delete', blockId });
    }
  }

  return { operations };
}

/**
 * Converts Notion API block objects to ConvertedNotionBlock format (preserving IDs)
 */
function convertNotionObjectToConvertedBlock(blocks: Record<string, unknown>[]): ConvertedNotionBlockWithIds[] {
  const convertedBlocks: ConvertedNotionBlockWithIds[] = [];
  for (const block of blocks) {
    const blockType = block.type as string;
    const convertedBlock: ConvertedNotionBlockWithIds = {
      id: block.id as string,
      object: block.object as 'block',
      type: blockType,
      has_children: block.has_children as boolean,
      archived: block.archived as boolean | undefined,
      [blockType]: { ...(block[blockType] as Record<string, unknown>) },
    };

    // Recursively convert children if they exist
    const children = block.children as Record<string, unknown>[] | undefined;
    if (children && children.length > 0) {
      convertedBlock.children = convertNotionObjectToConvertedBlock(children);
    }
    convertedBlocks.push(convertedBlock);
  }

  return convertedBlocks;
}

/**
 * Main function to create a block diff from old and new page content
 * @param oldPageContent - The old page content (blocks from Notion API)
 * @param newPageContent - The new page content (ConvertedNotionBlocks)
 * @param pageId - The page ID (used for logging)
 * @returns NotionBlockDiffResult containing the operations to perform
 */
export function createNotionBlockDiff(
  oldPageContent: { children: Record<string, unknown>[] },
  newPageContent: ConvertedNotionBlock[],
  pageId: string,
): NotionBlockDiffResult {
  let convertedOldBlocks: ConvertedNotionBlockWithIds[] | undefined;

  if (oldPageContent && oldPageContent?.children && oldPageContent?.children?.length > 0) {
    // Convert Notion API blocks to ConvertedNotionBlocks while preserving IDs
    convertedOldBlocks = convertNotionObjectToConvertedBlock(oldPageContent?.children);
  }

  return assignIdsAndReturnOperations(convertedOldBlocks, newPageContent, pageId);
}
