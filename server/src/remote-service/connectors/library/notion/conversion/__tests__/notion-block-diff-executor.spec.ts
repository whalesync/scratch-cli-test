import { Client } from '@notionhq/client';
import { NotionBlockOperation } from '../notion-block-diff';
import { NotionBlockDiffExecutor } from '../notion-block-diff-executor';
import { ConvertedNotionBlock } from '../notion-rich-text-push-types';

describe('NotionBlockDiffExecutor', () => {
  let executor: NotionBlockDiffExecutor;
  let mockClient: jest.Mocked<Pick<Client, 'blocks'>>;
  const testPageId = 'test-page-id-123';

  beforeEach(() => {
    // Create a mock Notion client with proper types
    mockClient = {
      blocks: {
        children: {
          append: jest.fn() as jest.MockedFunction<Client['blocks']['children']['append']>,
          list: jest.fn() as jest.MockedFunction<Client['blocks']['children']['list']>,
        },
        // `meetingNotes.query` was added to the v5 SDK's `blocks` shape for the
        // 2026-03-11 meeting-notes API. The executor never touches it, but the
        // `Pick<Client, 'blocks'>` mock must satisfy the full subtree.
        meetingNotes: {
          query: jest.fn() as jest.MockedFunction<Client['blocks']['meetingNotes']['query']>,
        },
        retrieve: jest.fn() as jest.MockedFunction<Client['blocks']['retrieve']>,
        update: jest.fn() as jest.MockedFunction<Client['blocks']['update']>,
        delete: jest.fn() as jest.MockedFunction<Client['blocks']['delete']>,
      },
    };
    executor = new NotionBlockDiffExecutor(mockClient as unknown as Client);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Create Operations - ID Management', () => {
    describe('ID mapping during block creation', () => {
      it('should map temporary IDs to real IDs after creation', async () => {
        const idMappings = new Map<string, string>();

        const blocksToCreate: ConvertedNotionBlock[] = [
          {
            id: 'temp.new-block-1',
            type: 'paragraph',
            object: 'block',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'First block' }, plain_text: 'First block' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
          {
            id: 'temp.new-block-2',
            type: 'paragraph',
            object: 'block',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'Second block' }, plain_text: 'Second block' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
        ];

        const createOperation: NotionBlockOperation = {
          type: 'create',
          block: blocksToCreate,
        };

        // Mock the API response with real IDs assigned by Notion
        (mockClient.blocks.children.append as jest.Mock).mockResolvedValue({
          results: [
            {
              id: 'real-notion-id-1',
              type: 'paragraph',
              paragraph: { rich_text: [] },
            },
            {
              id: 'real-notion-id-2',
              type: 'paragraph',
              paragraph: { rich_text: [] },
            },
          ],
        });

        await executor.executeOperations(testPageId, [createOperation], idMappings);

        // Verify that temporary IDs were mapped to real IDs
        expect(idMappings.get('temp.new-block-1')).toBe('real-notion-id-1');
        expect(idMappings.get('temp.new-block-2')).toBe('real-notion-id-2');
        expect(idMappings.size).toBe(2);
      });

      it('should map nested children IDs recursively', async () => {
        const idMappings = new Map<string, string>();

        const blocksToCreate: ConvertedNotionBlock[] = [
          {
            id: 'temp.parent-block',
            type: 'paragraph',
            object: 'block',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'Parent' }, plain_text: 'Parent' }],
              color: 'default',
            },
            has_children: true,
            archived: false,
            children: [
              {
                id: 'temp.child-block-1',
                type: 'paragraph',
                object: 'block',
                paragraph: {
                  rich_text: [{ type: 'text', text: { content: 'Child 1' }, plain_text: 'Child 1' }],
                  color: 'default',
                },
                has_children: false,
                archived: false,
              },
              {
                id: 'temp.child-block-2',
                type: 'paragraph',
                object: 'block',
                paragraph: {
                  rich_text: [{ type: 'text', text: { content: 'Child 2' }, plain_text: 'Child 2' }],
                  color: 'default',
                },
                has_children: false,
                archived: false,
              },
            ],
          },
        ];

        const createOperation: NotionBlockOperation = {
          type: 'create',
          block: blocksToCreate,
        };

        // Mock API response with nested structure
        (mockClient.blocks.children.append as jest.Mock).mockResolvedValue({
          results: [
            {
              id: 'real-parent-id',
              type: 'paragraph',
              has_children: true,
              children: [
                { id: 'real-child-id-1', type: 'paragraph' },
                { id: 'real-child-id-2', type: 'paragraph' },
              ],
            },
          ],
        });

        await executor.executeOperations(testPageId, [createOperation], idMappings);

        // Verify parent and children IDs were mapped
        expect(idMappings.get('temp.parent-block')).toBe('real-parent-id');
        expect(idMappings.get('temp.child-block-1')).toBe('real-child-id-1');
        expect(idMappings.get('temp.child-block-2')).toBe('real-child-id-2');
        expect(idMappings.size).toBe(3);
      });
    });

    describe('ID resolution in after parameter', () => {
      it('should resolve temporary ID in after parameter', async () => {
        const idMappings = new Map<string, string>([['temp.previous-block', 'real-previous-id']]);

        const blocksToCreate: ConvertedNotionBlock[] = [
          {
            id: 'temp.new-block',
            type: 'paragraph',
            object: 'block',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'New block' }, plain_text: 'New block' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
        ];

        const createOperation: NotionBlockOperation = {
          type: 'create',
          block: blocksToCreate,
          after: 'temp.previous-block',
        };

        (mockClient.blocks.children.append as jest.Mock).mockResolvedValue({
          results: [{ id: 'real-new-id', type: 'paragraph' }],
        });

        await executor.executeOperations(testPageId, [createOperation], idMappings);

        // Verify the resolved after ID was used in the API call
        expect(mockClient.blocks.children.append).toHaveBeenCalledWith(
          expect.objectContaining({
            block_id: testPageId,
            after: 'real-previous-id',
          }),
        );
      });
    });

    describe('Batched block creation with ID management', () => {
      it('should handle batching and maintain ID mappings across batches', async () => {
        const idMappings = new Map<string, string>();

        // Create 150 blocks to trigger batching (batch size is 100)
        const blocksToCreate: ConvertedNotionBlock[] = Array.from({ length: 150 }, (_, i) => ({
          id: `temp.block-${i}`,
          type: 'paragraph',
          object: 'block',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: `Block ${i}` }, plain_text: `Block ${i}` }],
            color: 'default',
          },
          has_children: false,
          archived: false,
        }));

        const createOperation: NotionBlockOperation = {
          type: 'create',
          block: blocksToCreate,
        };

        let callCount = 0;
        (mockClient.blocks.children.append as jest.Mock).mockImplementation(() => {
          callCount++;
          const batchStart = (callCount - 1) * 100;
          const batchSize = Math.min(100, 150 - batchStart);

          return Promise.resolve({
            results: Array.from({ length: batchSize }, (_, i) => ({
              id: `real-id-${batchStart + i}`,
              type: 'paragraph',
            })),
          });
        });

        await executor.executeOperations(testPageId, [createOperation], idMappings);

        // Verify that the operation was split into 2 batches
        expect(mockClient.blocks.children.append).toHaveBeenCalledTimes(2);

        // Verify all IDs were mapped correctly
        expect(idMappings.size).toBe(150);
        for (let i = 0; i < 150; i++) {
          expect(idMappings.get(`temp.block-${i}`)).toBe(`real-id-${i}`);
        }
      });

      it('should chain batches using the last created block ID as after parameter', async () => {
        const idMappings = new Map<string, string>();

        // Create 150 blocks to trigger batching
        const blocksToCreate: ConvertedNotionBlock[] = Array.from({ length: 150 }, (_, i) => ({
          id: `temp.block-${i}`,
          type: 'paragraph',
          object: 'block',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: `Block ${i}` }, plain_text: `Block ${i}` }],
            color: 'default',
          },
          has_children: false,
          archived: false,
        }));

        const createOperation: NotionBlockOperation = {
          type: 'create',
          block: blocksToCreate,
        };

        let callCount = 0;
        (mockClient.blocks.children.append as jest.Mock).mockImplementation(() => {
          callCount++;
          const batchStart = (callCount - 1) * 100;
          const batchSize = Math.min(100, 150 - batchStart);

          return Promise.resolve({
            results: Array.from({ length: batchSize }, (_, i) => ({
              id: `real-id-${batchStart + i}`,
              type: 'paragraph',
            })),
          });
        });

        await executor.executeOperations(testPageId, [createOperation], idMappings);

        // Check that the second batch used the last block from the first batch as 'after'
        const appendMock = mockClient.blocks.children.append as jest.Mock;
        const secondBatchCall = appendMock.mock.calls[1] as unknown[];
        expect(secondBatchCall[0]).toEqual(
          expect.objectContaining({
            after: 'real-id-99', // Last block from first batch
          }),
        );
      });
    });
  });

  describe('Update Children Operations', () => {
    it('should resolve parent block ID in update_children operations', async () => {
      const idMappings = new Map<string, string>([['temp.parent-block', 'real-parent-id']]);

      const childCreateOp: NotionBlockOperation = {
        type: 'create',
        block: [
          {
            id: 'temp.child-block',
            type: 'paragraph',
            object: 'block',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'Child' }, plain_text: 'Child' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
        ],
      };

      const updateChildrenOp: NotionBlockOperation = {
        type: 'update_children',
        blockId: 'temp.parent-block',
        childOperations: [childCreateOp],
      };

      (mockClient.blocks.children.append as jest.Mock).mockResolvedValue({
        results: [{ id: 'real-child-id', type: 'paragraph' }],
      });

      await executor.executeOperations(testPageId, [updateChildrenOp], idMappings);

      // Verify the child operation used the resolved parent ID as the block_id
      expect(mockClient.blocks.children.append).toHaveBeenCalledWith(
        expect.objectContaining({
          block_id: 'real-parent-id',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          children: expect.any(Array),
        }),
      );
    });

    it('should map child block IDs after creation in update_children operations', async () => {
      const idMappings = new Map<string, string>([['temp.parent-block', 'real-parent-id']]);

      const childCreateOp: NotionBlockOperation = {
        type: 'create',
        block: [
          {
            id: 'temp.child-1',
            type: 'paragraph',
            object: 'block',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'Child 1' }, plain_text: 'Child 1' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
          {
            id: 'temp.child-2',
            type: 'paragraph',
            object: 'block',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'Child 2' }, plain_text: 'Child 2' }],
              color: 'default',
            },
            has_children: false,
            archived: false,
          },
        ],
      };

      const updateChildrenOp: NotionBlockOperation = {
        type: 'update_children',
        blockId: 'temp.parent-block',
        childOperations: [childCreateOp],
      };

      (mockClient.blocks.children.append as jest.Mock).mockResolvedValue({
        results: [
          { id: 'real-child-id-1', type: 'paragraph' },
          { id: 'real-child-id-2', type: 'paragraph' },
        ],
      });

      await executor.executeOperations(testPageId, [updateChildrenOp], idMappings);

      // Verify child IDs were mapped correctly
      expect(idMappings.get('temp.child-1')).toBe('real-child-id-1');
      expect(idMappings.get('temp.child-2')).toBe('real-child-id-2');
      expect(idMappings.size).toBe(3); // parent + 2 children
    });
  });
});
