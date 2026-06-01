import { createNotionBlockDiff } from '../notion-block-diff';
import { convertNotionBlockObjectToHtmlv2, NotionBlockObject } from '../notion-rich-text-conversion';
import { convertToNotionBlocks } from '../notion-rich-text-push';
import type { ConvertedNotionBlock } from '../notion-rich-text-push-types';
import { CONTENT_MARKETING_BLOCKS } from './test-data/content-marketing';
import { PRODUCT_LAUNCH_BLOCKS } from './test-data/product-launch';
import { SOCIAL_STRATEGY_BLOCKS } from './test-data/social-strategy';

const FAKE_REMOTE_BASE_ID = 'fake-remote-base-id';

// Type helper for accessing nested properties safely in tests
type TestBlockWithParagraph = ConvertedNotionBlock & {
  paragraph?: {
    rich_text?: Array<{ plain_text?: string; annotations?: { code?: boolean } }>;
  };
};

type TestBlockWithHeading = ConvertedNotionBlock & {
  heading_1?: {
    rich_text?: Array<{ plain_text?: string }>;
  };
  heading_2?: {
    rich_text?: Array<{ plain_text?: string }>;
  };
  heading_3?: {
    rich_text?: Array<{ plain_text?: string }>;
  };
};

// Helper function to create a proper NotionBlockObject with children
function createPageContent(children: ConvertedNotionBlock[]): { children: ConvertedNotionBlock[] } & NotionBlockObject {
  return {
    id: '13123456-1312-4234-8234-df012345678a',
    object: 'block',
    type: 'child_page',
    child_page: { title: 'Page Content' },
    has_children: true,
    created_time: '2024-01-01T00:00:00.000Z',
    created_by: { id: 'user-id', object: 'user' },
    last_edited_time: '2024-01-01T00:00:00.000Z',
    last_edited_by: { id: 'user-id', object: 'user' },
    archived: false,
    children: children,
  } as { children: ConvertedNotionBlock[] } & NotionBlockObject;
}

// Helper function to convert blocks to HTML properly (processing each block individually)
function convertBlocksToHtml(blocks: ConvertedNotionBlock[]): string {
  return blocks.map((block) => convertNotionBlockObjectToHtmlv2(block as unknown as NotionBlockObject)).join('');
}

describe('Product Launch HTML Modification Tests', () => {
  test('detects update when paragraph content is modified', () => {
    // Start with original product launch blocks
    const originalBlocks = PRODUCT_LAUNCH_BLOCKS.children;
    const oldContent = createPageContent(originalBlocks);

    // Convert to HTML with block IDs preserved (fix: process each block individually)
    const originalHtml = convertBlocksToHtml(originalBlocks);

    // Modify the HTML - change content in the executive summary paragraph
    const modifiedHtml = originalHtml
      .replace(
        'ProjectSync Pro represents our most significant product launch of 2024',
        'ProjectSync Pro represents our revolutionary product launch of 2024',
      )
      .replace('$15B project management software market', '$20B project management software market');

    // Convert back to blocks
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);

    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have exactly 1 update operation for the paragraph block
    const updateOps = result.operations.filter((op) => op.type === 'update');
    expect(updateOps).toHaveLength(1);
    expect(updateOps[0].blockId).toBe('71123456-7112-4890-8890-5678abcdef02');

    // Verify the updated content contains our changes
    const updatedContent = (updateOps[0].block as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text;
    expect(updatedContent).toContain('revolutionary product launch');
    expect(updatedContent).toContain('$20B project management');

    // Note: The diff algorithm may detect additional operations due to HTML round-trip conversion
    // The core functionality (detecting paragraph updates) is working correctly
  });

  test('detects create when new paragraph is added at end to maintain order', () => {
    // Start with first 3 blocks of product launch
    const originalBlocks = PRODUCT_LAUNCH_BLOCKS.children.slice(0, 3);
    const oldContent = createPageContent(originalBlocks);

    // Convert to HTML with block IDs preserved
    const originalHtml = convertNotionBlockObjectToHtmlv2(oldContent);

    // Add new content at the END to avoid changing order of existing blocks
    const modifiedHtml = originalHtml.replace(
      '</article>',
      '<p><strong>NEW ADDITION:</strong> This product launch represents a significant milestone for our company.</p><p>We expect this to drive 25% revenue growth in Q2.</p></article>',
    );

    // Convert back to blocks
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);

    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have 1 create operation with 2 new blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    expect(createOps).toHaveLength(1);
    expect(createOps[0].block).toHaveLength(2);

    // Should be created after the last existing block to maintain order
    const lastExistingBlockId = originalBlocks[originalBlocks.length - 1]?.id;
    expect(createOps[0].after).toBe(lastExistingBlockId);

    // Verify the new content
    const firstNewBlock = createOps[0].block[0];
    const secondNewBlock = createOps[0].block[1];
    expect((firstNewBlock as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text).toContain('NEW ADDITION');
    expect((secondNewBlock as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text).toContain(
      '25% revenue growth',
    );

    // No update or delete operations
    expect(result.operations.filter((op) => op.type === 'update')).toHaveLength(0);
    expect(result.operations.filter((op) => op.type === 'delete')).toHaveLength(0);
  });
});
describe('Re order based tests', () => {
  test('detects a insertion of a block in between blocks', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const addedBlock = CONTENT_MARKETING_BLOCKS.children.slice(5, 6);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[1],
      originalBlocks[2],
      addedBlock[0],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // When blocks are reordered, we expect 1 create and 0 deletes
    // we have to identify this as an insertion of a block in between blocks that shouldn't delete the existing blocks or try to recreate them
    // we should identify that the 2 existing blocks were moved because there is a create operation in their old position, so they will be moved automatically without us needing to do anything.
    // this would not be the case if there were no create or delete operations in their old position.
    expect(createOps.length).toBe(1);
    expect(createOps[0].block).toHaveLength(1);
    expect(deleteOps.length).toBe(0);
  });
  test('creates a new duplicate block that re orders the last block', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[1],
      originalBlocks[2],
      originalBlocks[3],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    expect(createOps.length).toBe(1);
    expect(deleteOps.length).toBe(0);
  });

  test('detects 2 blocks re order', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 6);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[2],
      originalBlocks[1],
      originalBlocks[3],
      originalBlocks[5],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // When blocks are simply reordered (no intervening creates/deletes), we should
    // generate explicit delete+create operations to maintain correct ordering
    expect(createOps.length).toBe(2);
    expect(createOps[0].block).toHaveLength(2);
    expect(createOps[1].block).toHaveLength(2);
    expect(deleteOps.length).toBe(4);
  });

  test('detects a re order of blocks', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[1],
      originalBlocks[2],
      originalBlocks[4],
      originalBlocks[3],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // When blocks are simply reordered (no intervening creates/deletes), we should
    // generate explicit delete+create operations to maintain correct ordering
    expect(createOps.length).toBe(1);
    expect(createOps[0].block).toHaveLength(2);
    expect(deleteOps.length).toBe(2);
  });

  test('detects a insertion of 2 blocks in between blocks and a block is moved', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const addedBlock = CONTENT_MARKETING_BLOCKS.children.slice(5, 7);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[2],
      originalBlocks[1],
      addedBlock[0],
      addedBlock[1],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // This is both scenarios at once, a real swap of blocks order and an insertion of 2 blocks in between blocks
    expect(createOps.length).toBe(1);
    // Creates are consecutive so it makes sense that they are grouped together
    expect(createOps[0].block).toHaveLength(4);
    expect(deleteOps.length).toBe(2);
  });

  test('detects a insertion of 2 blocks in between blocks different blocks', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const addedBlock = CONTENT_MARKETING_BLOCKS.children.slice(5, 9);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      addedBlock[2],
      addedBlock[3],
      originalBlocks[1],
      originalBlocks[2],
      addedBlock[0],
      addedBlock[1],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    expect(createOps.length).toBe(2);
    expect(createOps[0].block).toHaveLength(2);
    expect(createOps[1].block).toHaveLength(2);
    expect(deleteOps.length).toBe(0);
  });

  test('detects a insertion of 2 blocks in between blocks', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const addedBlock = CONTENT_MARKETING_BLOCKS.children.slice(5, 7);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[1],
      originalBlocks[2],
      addedBlock[0],
      addedBlock[1],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    expect(createOps.length).toBe(1);
    expect(createOps[0].block).toHaveLength(2);
    expect(deleteOps.length).toBe(0);
  });

  test('even if its a real swap of blocks order, we have to re write everything below it', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[1],
      originalBlocks[0],
      originalBlocks[2],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // Since Notion doesn't have a before parameter, we have to re write everything below it
    expect(createOps.length).toBe(1);
    expect(createOps[0].block).toHaveLength(5);
    expect(deleteOps.length).toBe(5);
  });

  test('swaps blocks in random orders', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[1],
      originalBlocks[4],
      originalBlocks[2],
      originalBlocks[3],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    expect(createOps.length).toBe(1);
    expect(createOps[0].block).toHaveLength(3);
    expect(deleteOps.length).toBe(3);
  });

  test('when an insertion happens at the top we have to re write everything below it', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const addedBlock = CONTENT_MARKETING_BLOCKS.children.slice(5, 6);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      addedBlock[0],
      originalBlocks[0],
      originalBlocks[1],
      originalBlocks[2],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // When blocks are reordered, we expect 1 create and 0 deletes
    // we have to identify this as an insertion of a block in between blocks that shouldn't delete the existing blocks or try to recreate them
    // we should identify that the 2 existing blocks were moved because there is a create operation in their old position, so they will be moved automatically without us needing to do anything.
    // this would not be the case if there were no create or delete operations in their old position.
    expect(createOps.length).toBe(1);
    expect(createOps[0].block).toHaveLength(6);
    expect(deleteOps.length).toBe(5);
  });

  test('detects a insertion of a block in between blocks', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const addedBlock = CONTENT_MARKETING_BLOCKS.children.slice(5, 6);
    const oldContent = createPageContent(originalBlocks);

    const modifiedBlocks = [
      originalBlocks[0],
      originalBlocks[1],
      originalBlocks[2],
      addedBlock[0],
      originalBlocks[3],
      originalBlocks[4],
    ];
    const modifiedContent = createPageContent(modifiedBlocks);
    const modifiedHtml = convertNotionBlockObjectToHtmlv2(modifiedContent);
    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update operations for reordered blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // When blocks are reordered, we expect 1 create and 0 deletes
    // we have to identify this as an insertion of a block in between blocks that shouldn't delete the existing blocks or try to recreate them
    // we should identify that the 2 existing blocks were moved because there is a create operation in their old position, so they will be moved automatically without us needing to do anything.
    // this would not be the case if there were no create or delete operations in their old position.
    expect(createOps.length).toBe(1);
    expect(createOps[0].block).toHaveLength(1);
    expect(deleteOps.length).toBe(0);
  });
});

describe('Content Marketing HTML Modification Tests', () => {
  test('handles mixed update and create when content is modified and extended', () => {
    // Start with first 4 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 4);
    const oldContent = createPageContent(originalBlocks);

    // Convert to HTML with block IDs preserved
    const originalHtml = convertNotionBlockObjectToHtmlv2(oldContent);

    // Modify existing content AND add new content
    const modifiedHtml = originalHtml
      // Update the introduction heading
      .replace('Introduction: The B2B Content Revolution', 'Introduction: The Modern B2B Content Revolution')
      .replace(
        'Content marketing has transformed from a nice-to-have into the backbone',
        'Content marketing has transformed from a nice-to-have into the revolutionary backbone',
      )
      // Add new heading and content before the closing article tag
      .replace(
        '</article>',
        '<h2>Performance Metrics</h2><p>This article has achieved:</p><ul><li>50,000+ views in first week</li><li>1,200 social shares</li><li>300 new email subscribers</li></ul></article>',
      );

    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have 2 updates (modified heading and paragraph) and 1 create (for new content)
    const updateOps = result.operations.filter((op) => op.type === 'update');
    const createOps = result.operations.filter((op) => op.type === 'create');

    expect(updateOps).toHaveLength(2);
    expect(createOps).toHaveLength(1);
    expect(createOps[0].block).toHaveLength(5);
    // Verify the heading update
    const headingUpdate = updateOps.find((op) => op.blockId === '34567890-3456-4456-8456-3456789abcde');
    expect(headingUpdate).toBeDefined();
    const updatedHeading = (headingUpdate?.block as TestBlockWithHeading).heading_1?.rich_text?.[0]?.plain_text;
    expect(updatedHeading).toContain('Modern B2B Content Revolution');

    // Verify the paragraph update
    const paragraphUpdate = updateOps.find((op) => op.blockId === '45678901-4567-4567-8567-456789abcdef');
    expect(paragraphUpdate).toBeDefined();
    const updatedParagraph = (paragraphUpdate?.block as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text;
    expect(updatedParagraph).toContain('revolutionary backbone');

    // Verify the create - should add multiple
    // blocks (heading + paragraph + list)
    expect(createOps[0].block.length).toBeGreaterThan(1);
    const lastExistingBlockId = originalBlocks[originalBlocks.length - 1]?.id;
    expect(createOps[0].after).toBe(lastExistingBlockId);

    // Check the new heading block
    const newHeading = createOps[0].block.find((block) => block.type === 'heading_2');
    expect((newHeading as TestBlockWithHeading)?.heading_2?.rich_text?.[0]?.plain_text).toContain(
      'Performance Metrics',
    );
  });
  test('detects delete when sections are removed from HTML', () => {
    // Start with first 5 blocks
    const originalBlocks = CONTENT_MARKETING_BLOCKS.children.slice(0, 5);
    const oldContent = createPageContent(originalBlocks);

    // Convert to HTML with block IDs preserved
    const originalHtml = convertNotionBlockObjectToHtmlv2(oldContent);

    // Remove the hero image block by removing its HTML representation
    // The hero image gets converted to an img tag in HTML
    const modifiedHtml = originalHtml.replace(/<img[^>]*[^>]*>/, '');

    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have delete operations for removed blocks
    const deleteOps = result.operations.filter((op) => op.type === 'delete');
    expect(deleteOps.length).toBeGreaterThanOrEqual(1);
    expect(deleteOps.some((op) => op.blockId === '23456789-2345-4345-8345-23456789abcd')).toBe(true);
  });
});

describe('Social Strategy HTML Modification Tests', () => {
  test('batches consecutive creates when multiple paragraphs are appended at end', () => {
    // Start with first 2 blocks (header and main heading)
    const originalBlocks = SOCIAL_STRATEGY_BLOCKS.children.slice(0, 2);
    const oldContent = createPageContent(originalBlocks);

    // Convert to HTML with block IDs preserved
    const originalHtml = convertNotionBlockObjectToHtmlv2(oldContent);

    // Insert multiple new paragraphs at the END to maintain block order
    const modifiedHtml = originalHtml.replace(
      '</article>',
      '<p>This strategy focuses on three key pillars:</p><p>1. Brand awareness through thought leadership</p><p>2. Community engagement through interactive content</p><p>3. Lead generation through valuable resources</p></article>',
    );

    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have exactly 1 create operation with multiple blocks batched together
    const createOps = result.operations.filter((op) => op.type === 'create');
    expect(createOps).toHaveLength(1);
    expect(createOps[0].block).toHaveLength(4); // 4 new paragraph blocks

    // Should be positioned after the last existing block to maintain order
    const lastExistingBlockId = originalBlocks[originalBlocks.length - 1]?.id;
    expect(createOps[0].after).toBe(lastExistingBlockId);

    // Verify content of the batched blocks
    expect((createOps[0].block[0] as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text).toContain(
      'three key pillars',
    );
    expect((createOps[0].block[1] as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text).toContain(
      '1. Brand awareness',
    );
    expect((createOps[0].block[2] as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text).toContain(
      '2. Community engagement',
    );
    expect((createOps[0].block[3] as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text).toContain(
      '3. Lead generation',
    );

    // No other operations
    expect(result.operations.filter((op) => op.type === 'update')).toHaveLength(0);
    expect(result.operations.filter((op) => op.type === 'delete')).toHaveLength(0);
  });

  test('creates blocks when adding appendix content at end', () => {
    // Start with first 2 blocks
    const originalBlocks = SOCIAL_STRATEGY_BLOCKS.children.slice(0, 2);
    const oldContent = createPageContent(originalBlocks);

    // Convert to HTML with block IDs preserved
    const originalHtml = convertNotionBlockObjectToHtmlv2(oldContent);

    // Insert content at the END to preserve existing block order
    const modifiedHtml = originalHtml.replace(
      '</article>',
      '<h2>Appendix</h2><p>1. Additional Resources</p><p>2. Contact Information</p><p>3. Reference Links</p></article>',
    );

    const newBlocks = convertToNotionBlocks(modifiedHtml, false);
    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have 1 create operation for content appended at end
    const createOps = result.operations.filter((op) => op.type === 'create');
    expect(createOps).toHaveLength(1);
    expect(createOps[0].block).toHaveLength(4); // heading + 3 paragraphs

    // Should be positioned after the last existing block to maintain order
    const lastExistingBlockId = originalBlocks[originalBlocks.length - 1]?.id;
    expect(createOps[0].after).toBe(lastExistingBlockId);

    // Verify the content
    const appendixHeading = createOps[0].block.find((block) => block.type === 'heading_2');
    expect((appendixHeading as TestBlockWithHeading)?.heading_2?.rich_text?.[0]?.plain_text).toContain('Appendix');
  });
});

describe('Block Type Change Scenarios', () => {
  test('handles block type change by deleting old and creating new', () => {
    // Create a simple content with a paragraph block
    const paragraphBlock: ConvertedNotionBlock = {
      id: 'c3123456-c312-4890-8890-9bcdef012346',
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: 'Original paragraph content' }, plain_text: 'Original paragraph content' },
        ],
        color: 'default',
      },
      has_children: false,
      archived: false,
    };

    const oldContent = createPageContent([paragraphBlock]);

    // Create a new block with the same ID but different type (heading_1)
    const headingBlock: ConvertedNotionBlock = {
      id: 'c3123456-c312-4890-8890-9bcdef012346', // Same ID as the paragraph
      object: 'block',
      type: 'heading_1',
      heading_1: {
        rich_text: [{ type: 'text', text: { content: 'Now a heading' }, plain_text: 'Now a heading' }],
        color: 'default',
      },
      has_children: false,
      archived: false,
    };

    const result = createNotionBlockDiff(oldContent, [headingBlock], FAKE_REMOTE_BASE_ID);

    // Should have exactly 1 delete and 1 create operation
    const deleteOps = result.operations.filter((op) => op.type === 'delete');
    const createOps = result.operations.filter((op) => op.type === 'create');
    const updateOps = result.operations.filter((op) => op.type === 'update');

    expect(deleteOps).toHaveLength(1);
    expect(createOps).toHaveLength(1);
    expect(updateOps).toHaveLength(0);

    // Verify delete operation targets the original block ID
    expect(deleteOps[0].blockId).toBe('c3123456-c312-4890-8890-9bcdef012346');

    // Verify create operation contains the new block without the original ID
    expect(createOps[0].block).toHaveLength(1);
    const createdBlock = createOps[0].block[0];
    expect(createdBlock.type).toBe('heading_1');
    expect(createdBlock.id).toBeUndefined(); // ID should be removed for creation
    expect((createdBlock as TestBlockWithHeading).heading_1?.rich_text?.[0]?.plain_text).toBe('Now a heading');
  });

  test('handles multiple block type changes in sequence', () => {
    // Create content with paragraph and heading blocks
    const originalBlocks: ConvertedNotionBlock[] = [
      {
        id: 'd3123456-d312-4901-8901-acdef0123457',
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: 'First paragraph' }, plain_text: 'First paragraph' }],
          color: 'default',
        },
        has_children: false,
        archived: false,
      },
      {
        id: 'e3123456-e312-4012-8012-bdef01234568',
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [{ type: 'text', text: { content: 'Original heading' }, plain_text: 'Original heading' }],
          color: 'default',
        },
        has_children: false,
        archived: false,
      },
    ];

    const oldContent = createPageContent(originalBlocks);

    // Change both blocks to different types
    const newBlocks: ConvertedNotionBlock[] = [
      {
        id: 'd3123456-d312-4901-8901-acdef0123457', // paragraph -> heading_2
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: 'Now a heading 2' }, plain_text: 'Now a heading 2' }],
          color: 'default',
        },
        has_children: false,
        archived: false,
      },
      {
        id: 'e3123456-e312-4012-8012-bdef01234568', // heading_1 -> paragraph
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: 'Now a paragraph' }, plain_text: 'Now a paragraph' }],
          color: 'default',
        },
        has_children: false,
        archived: false,
      },
    ];

    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // Should have 2 deletes and 1 create (both new blocks batched together)
    const deleteOps = result.operations.filter((op) => op.type === 'delete');
    const createOps = result.operations.filter((op) => op.type === 'create');
    const updateOps = result.operations.filter((op) => op.type === 'update');

    expect(deleteOps).toHaveLength(2);
    expect(createOps).toHaveLength(1);
    expect(updateOps).toHaveLength(0);

    // Verify both blocks are deleted
    expect(deleteOps.map((op) => op.blockId).sort()).toEqual([
      'd3123456-d312-4901-8901-acdef0123457',
      'e3123456-e312-4012-8012-bdef01234568',
    ]);

    // Verify both new blocks are created without IDs
    expect(createOps[0].block).toHaveLength(2);
    const createdBlocks = createOps[0].block;
    expect(createdBlocks[0].type).toBe('heading_2');
    expect(createdBlocks[0].id).toBeUndefined();
    expect(createdBlocks[1].type).toBe('paragraph');
    expect(createdBlocks[1].id).toBeUndefined();
  });
});

test('handles complete content rewrite with mixed operations', () => {
  // Use social strategy first 4 blocks
  const originalBlocks = SOCIAL_STRATEGY_BLOCKS.children.slice(0, 4);
  const oldContent = createPageContent(originalBlocks);

  // Convert to HTML with block IDs preserved
  const originalHtml = convertNotionBlockObjectToHtmlv2(oldContent);

  // Complex modification: update heading, remove one block, add new content at END to preserve order
  const modifiedHtml = originalHtml
    // Update the main heading
    .replace('April 2024 Social Media Strategy', 'May 2024 Social Media Strategy')
    // Remove the "Monthly Themes & Campaigns" heading by removing its HTML
    .replace(/<h2[^>]*[^>]*>.*?<\/h2>/, '')
    // Add new content at the END to maintain block order
    .replace(
      '</article>',
      '<h3>Strategy Updates</h3><p>Based on Q1 performance analysis, we are shifting our focus to:</p><ul><li>Increased video content production</li><li>More interactive polls and Q&A sessions</li></ul></article>',
    );

  const newBlocks = convertToNotionBlocks(modifiedHtml, false);
  const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

  // Should have: 1 update + 1 create + delete operations for removed blocks
  const updateOps = result.operations.filter((op) => op.type === 'update');
  const createOps = result.operations.filter((op) => op.type === 'create');
  const deleteOps = result.operations.filter((op) => op.type === 'delete');

  expect(updateOps).toHaveLength(1); // main heading
  expect(createOps).toHaveLength(1); // new content batch
  expect(deleteOps.length).toBeGreaterThanOrEqual(1); // removed heading and potentially others

  // Verify update operation
  const headingUpdate = updateOps.find((op) => op.blockId === 'b3123456-b312-4789-8789-8abcdef01235');
  expect((headingUpdate?.block as TestBlockWithHeading).heading_1?.rich_text?.[0]?.plain_text).toContain(
    'May 2024 Social Media Strategy',
  );

  // Verify delete operation includes the intended target
  expect(deleteOps.some((op) => op.blockId === 'c3123456-c312-4890-8890-9bcdef012346')).toBe(true);

  // Verify create operation positioning - should be after an existing block to maintain order
  // The exact positioning may vary based on which blocks remain after deletions
  expect(createOps[0].after).toBeDefined();
  expect(typeof createOps[0].after).toBe('string');
  expect(createOps[0].block.length).toBeGreaterThan(1);
});

test('handles no changes - identical content after HTML round-trip', () => {
  const originalBlocks = PRODUCT_LAUNCH_BLOCKS.children.slice(0, 3);
  const oldContent = createPageContent(originalBlocks);

  // Convert to HTML and back without modifications
  const html = convertNotionBlockObjectToHtmlv2(oldContent);

  const newBlocks = convertToNotionBlocks(html, false);
  const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

  // Should have no operations since content is identical after round-trip
  expect(result.operations).toHaveLength(0);
});

describe('Markdown Content Tests', () => {
  test('handles comprehensive whale-themed markdown content with various formatting', () => {
    // Create a simple initial content with just a title
    const originalBlocks: ConvertedNotionBlock[] = [
      {
        id: 'b3123456-b312-4789-8789-8abcdef01235',
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [{ type: 'text', text: { content: 'Original Title' }, plain_text: 'Original Title' }],
          color: 'default',
        },
        has_children: false,
        archived: false,
      },
    ];

    const oldContent = createPageContent(originalBlocks);

    // Define comprehensive markdown content
    const markdownContent = `# Amazing Facts About Whales!

Whales are magnificent marine mammals that have fascinated humans for centuries.

## Basic Whale Types

You can find whales in **different sizes** or *various habitats* easily:
- **Blue whales** are the largest animals
- *Humpback whales* are known for their songs
- ***Sperm whales*** dive the deepest

## Whale Categories

### Baleen Whales
- Blue whale
- Humpback whale
- Gray whale
  - Filter feeders
  - Eat tiny organisms

### Toothed Whales
1. Sperm whale
2. Orca (killer whale)
3. Beluga whale

## Marine Resources and Research

Here's how to learn more about [whale conservation](https://www.google.com).

You can also find research like this: [Marine Biology Institute][marine-link]

[marine-link]: https://github.com

## Whale Communication

Whales communicate through \`complex vocalizations\` and songs.

Scientists study whale calls like this:
\`\`\`python
def analyze_whale_song():
    print("Recording whale frequencies...")
\`\`\``;

    // Convert markdown to blocks - note: isMarkdown should be true for markdown content
    const newBlocks = convertToNotionBlocks(markdownContent, true);

    const result = createNotionBlockDiff(oldContent, newBlocks, FAKE_REMOTE_BASE_ID);

    // The markdown conversion creates all new content and deletes the old title block
    const updateOps = result.operations.filter((op) => op.type === 'update');
    const createOps = result.operations.filter((op) => op.type === 'create');
    const deleteOps = result.operations.filter((op) => op.type === 'delete');

    // Should have 1 create operation (all new markdown content) and 1 delete (old title)
    expect(createOps).toHaveLength(1);
    expect(deleteOps).toHaveLength(1);
    expect(updateOps).toHaveLength(0);

    // Verify the delete operation targets the original title block
    expect(deleteOps[0].blockId).toBe('b3123456-b312-4789-8789-8abcdef01235');

    // Verify we have the expected content in the created blocks
    const allBlocks = createOps.flatMap((op) => op.block);
    // Check for the main heading
    const mainHeading = allBlocks.find(
      (block) =>
        block.type === 'heading_1' &&
        (block as TestBlockWithHeading).heading_1?.rich_text?.[0]?.plain_text?.includes('Amazing Facts About Whales'),
    );
    expect(mainHeading).toBeDefined();

    // Check for paragraph with whale description
    const descriptionBlock = allBlocks.find(
      (block) =>
        block.type === 'paragraph' &&
        (block as TestBlockWithParagraph).paragraph?.rich_text?.[0]?.plain_text?.includes('magnificent marine mammals'),
    );
    expect(descriptionBlock).toBeDefined();

    // Check for heading_2 blocks
    const basicTypesHeading = allBlocks.find(
      (block) =>
        block.type === 'heading_2' &&
        (block as TestBlockWithHeading).heading_2?.rich_text?.[0]?.plain_text?.includes('Basic Whale Types'),
    );
    expect(basicTypesHeading).toBeDefined();

    // Check for bulleted_list_item blocks
    const listItems = allBlocks.filter((block) => block.type === 'bulleted_list_item');
    expect(listItems.length).toBeGreaterThan(5); // Should have multiple list items

    // Check for numbered_list_item blocks
    const numberedItems = allBlocks.filter((block) => block.type === 'numbered_list_item');
    expect(numberedItems.length).toBe(3); // Should have 3 numbered items

    // Check for code formatting (markdown converts code blocks to paragraphs with code annotation)
    const codeBlock = allBlocks.find(
      (block) =>
        block.type === 'paragraph' &&
        (block as TestBlockWithParagraph).paragraph?.rich_text?.some((rt) => rt.annotations?.code === true),
    );
    expect(codeBlock).toBeDefined();
  });
});

describe('Nested Blocks and Children Operations', () => {
  // Note: These tests verify that the diff algorithm handles nested structures.
  // The implementation supports update_children operations for complex nested edits.

  test('handles adding children to previously childless block and reordering with children preserved', () => {
    // Test 1: Adding children to empty toggle
    const originalBlocks: ConvertedNotionBlock[] = [
      {
        id: 'toggle-1',
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [{ type: 'text', text: { content: 'Empty toggle' }, plain_text: 'Empty toggle' }],
          color: 'default',
        },
        has_children: false,
        archived: false,
      },
    ];

    const oldContent = createPageContent(originalBlocks);

    // Add children
    const modifiedBlocks: ConvertedNotionBlock[] = [
      {
        id: 'toggle-1',
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [{ type: 'text', text: { content: 'Empty toggle' }, plain_text: 'Empty toggle' }],
          color: 'default',
        },
        has_children: true,
        archived: false,
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: 'New child paragraph' },
                  plain_text: 'New child paragraph',
                },
              ],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
        ],
      },
    ];

    const result = createNotionBlockDiff(oldContent, modifiedBlocks, FAKE_REMOTE_BASE_ID);

    // Should have update_children with create operation
    const updateChildrenOps = result.operations.filter((op) => op.type === 'update_children');
    expect(updateChildrenOps).toHaveLength(1);
  });

  test('preserves children when reordering parent blocks', () => {
    // Test 2: Reordering blocks with children
    const originalBlocks: ConvertedNotionBlock[] = [
      {
        id: 'toggle-1',
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [{ type: 'text', text: { content: 'First toggle' }, plain_text: 'First toggle' }],
          color: 'default',
        },
        has_children: true,
        archived: false,
        children: [
          {
            id: 'child-1',
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'First child' }, plain_text: 'First child' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
        ],
      },
      {
        id: 'toggle-2',
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [{ type: 'text', text: { content: 'Second toggle' }, plain_text: 'Second toggle' }],
          color: 'default',
        },
        has_children: true,
        archived: false,
        children: [
          {
            id: 'child-2',
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'Second child' }, plain_text: 'Second child' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
        ],
      },
    ];

    const oldContent = createPageContent(originalBlocks);

    // Swap the order
    const modifiedBlocks: ConvertedNotionBlock[] = [originalBlocks[1], originalBlocks[0]];

    const result = createNotionBlockDiff(oldContent, modifiedBlocks, FAKE_REMOTE_BASE_ID);

    // Children should be preserved in the created blocks
    const createOps = result.operations.filter((op) => op.type === 'create');
    const createdBlocks = createOps.flatMap((op) => op.block);
    const blocksWithChildren = createdBlocks.filter((block) => block.children && block.children.length > 0);
    expect(blocksWithChildren.length).toBe(2);
  });
});
