import { Client } from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { NotionBlockOperation } from './notion-block-diff';
import { ConvertedNotionBlock } from './notion-rich-text-push-types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Production-ready executor for NotionBlockDiff operations
 * Handles proper API formatting and temporary ID resolution
 */
export class NotionBlockDiffExecutor {
  constructor(private readonly client: Client) {}

  private resolveBlockId(blockId: string, idMappings: Map<string, string>): string {
    if (blockId.startsWith('temp.')) {
      const actualId = idMappings.get(blockId);
      if (!actualId) {
        throw new Error(`No mapping found for temporary ID: ${blockId}`);
      }
      return actualId;
    }
    return blockId;
  }

  /**
   * Properly prepares a ConvertedNotionBlock for the Notion API
   * - Removes temporary IDs from blocks
   * - Removes metadata fields (has_children, object, id, archived)
   * - For create operations: includes children up to 2 levels deep (Notion API limitation)
   * - For update operations: removes children (they're handled separately)
   * - Ensures block type property is properly defined
   */
  private prepareBlockForApi(block: ConvertedNotionBlock): Record<string, unknown> {
    // Create a clean copy of the block, preserving all type-specific properties
    const blockForApi = { ...block };

    // Remove metadata fields that shouldn't be sent to API
    delete (blockForApi as Record<string, unknown>).has_children;
    delete (blockForApi as Record<string, unknown>).object;
    delete (blockForApi as Record<string, unknown>).archived;

    // Remove temporary IDs - let Notion assign real ones
    if (block.id && block.id.startsWith('temp.')) {
      // Don't include ID for blocks with temporary IDs
      delete (blockForApi as Record<string, unknown>).id;
    } else if (block.id) {
      // Keep real IDs for updates
      blockForApi.id = block.id;
    } else {
      delete (blockForApi as Record<string, unknown>).id;
    }

    // For the blocks.children.append API, we need to handle children differently:
    // - Top-level blocks should NOT have a children property
    // - Children are passed separately in the API call
    // - Only nested children (2+ levels deep) should have children properties

    // Handle children property for API calls
    if (block.children && block.children.length > 0) {
      // Set has_children to true to indicate this block should support children
      (blockForApi as Record<string, unknown>).has_children = true;

      // Remove children content - it will be added via separate update_children operations
      // But keep the has_children flag so Notion knows this block is intended to have children
      delete (blockForApi as Record<string, unknown>).children;
    } else {
      // No children expected
      (blockForApi as Record<string, unknown>).has_children = false;
      delete (blockForApi as Record<string, unknown>).children;
    }

    return blockForApi;
  }

  /**
   * Executes a create operation with automatic batching for large block sets
   * Notion API has a limit of 100 blocks per create request
   */
  private async executeCreateOperation(
    operation: NotionBlockOperation & { type: 'create' },
    pageId: string,
    idMappings: Map<string, string>,
  ): Promise<void> {
    const BATCH_SIZE = 100; // Notion API limit
    const totalBlocks = operation.block.length;

    if (totalBlocks <= BATCH_SIZE) {
      // Single batch - use original logic
      await this.executeSingleCreateBatch(operation.block, pageId, operation.after, idMappings);
      return;
    }

    let afterBlockId = operation.after;

    for (let i = 0; i < totalBlocks; i += BATCH_SIZE) {
      const batchBlocks = operation.block.slice(i, i + BATCH_SIZE);
      const isLastBatch = i + BATCH_SIZE >= totalBlocks;

      const createdBlocks = await this.executeSingleCreateBatch(batchBlocks, pageId, afterBlockId, idMappings);

      // Update afterBlockId to the last created block's ID for the next batch
      if (!isLastBatch && createdBlocks.length > 0) {
        const lastCreatedBlock = createdBlocks[createdBlocks.length - 1];
        if (lastCreatedBlock.id) {
          afterBlockId = lastCreatedBlock.id;
        }
      }
    }
  }

  /**
   * Executes a single create batch (≤100 blocks)
   * Returns the created blocks for ID mapping
   */
  private async executeSingleCreateBatch(
    blocks: ConvertedNotionBlock[],
    pageId: string,
    after: string | undefined,
    idMappings: Map<string, string>,
  ): Promise<Array<{ id: string; [key: string]: unknown }>> {
    const blocksForApi = blocks.map((block) => this.prepareBlockForApi(block));
    const afterParam = after ? this.resolveBlockId(after, idMappings) : undefined;

    const response = await this.client.blocks.children.append({
      block_id: pageId,
      children: blocksForApi as unknown as BlockObjectRequest[],
      after: afterParam,
    });

    // Map temporary IDs to real Notion IDs (including nested children)
    const mapNestedIds = (originalBlock: ConvertedNotionBlock, createdBlock: Record<string, unknown>): void => {
      if (originalBlock.id && originalBlock.id.startsWith('temp.') && typeof createdBlock.id === 'string') {
        idMappings.set(originalBlock.id, createdBlock.id);
      }

      // Map children IDs recursively
      const createdChildren = Array.isArray(createdBlock.children) ? createdBlock.children : undefined;
      if (originalBlock.children && createdChildren) {
        for (let j = 0; j < originalBlock.children.length; j++) {
          const originalChild = originalBlock.children[j];
          const createdChild = createdChildren[j] as Record<string, unknown> | undefined;
          if (createdChild) {
            mapNestedIds(originalChild, createdChild);
          }
        }
      }
    };

    for (let i = 0; i < blocks.length; i++) {
      const originalBlock = blocks[i];
      const createdBlock = response.results[i];
      if (createdBlock) {
        mapNestedIds(originalBlock, createdBlock);
      }
    }

    // Return created blocks with their IDs for chaining
    return response.results as Array<{ id: string; [key: string]: unknown }>;
  }

  async executeOperations(
    pageId: string,
    operations: NotionBlockOperation[],
    idMappings: Map<string, string>,
  ): Promise<void> {
    for (const operation of operations) {
      await this.executeBlockOperation(operation, pageId, idMappings);
    }
  }

  private async executeBlockOperation(
    operation: NotionBlockOperation,
    pageId: string,
    idMappings: Map<string, string>,
  ): Promise<void> {
    return this.executeBlockOperationWithRetry(operation, pageId, idMappings, false);
  }

  private async executeBlockOperationWithRetry(
    operation: NotionBlockOperation,
    pageId: string,
    idMappings: Map<string, string>,
    hasRetried: boolean,
  ): Promise<void> {
    try {
      switch (operation.type) {
        case 'create': {
          await this.executeCreateOperation(operation, pageId, idMappings);
          break;
        }

        case 'update': {
          const blockIdToUpdate = this.resolveBlockId(operation.blockId, idMappings);

          const blockForUpdate = this.prepareBlockForApi(operation.block);
          await this.client.blocks.update({
            block_id: blockIdToUpdate,
            ...blockForUpdate,
          });
          break;
        }

        case 'delete': {
          const blockIdToDelete = this.resolveBlockId(operation.blockId, idMappings);

          await this.client.blocks.delete({
            block_id: blockIdToDelete,
          });
          break;
        }

        case 'update_children': {
          const parentBlockId = this.resolveBlockId(operation.blockId, idMappings);

          // Recursively execute child operations, using the parent block ID as the page context
          for (const childOp of operation.childOperations) {
            await this.executeBlockOperation(childOp, parentBlockId, idMappings);
          }
          break;
        }

        default: {
          const exhaustive: never = operation;
          throw new Error(`Unknown operation type: ${(exhaustive as NotionBlockOperation).type}`);
        }
      }
    } catch (error) {
      // Check if this is a 409 conflict error
      if (this.is409ConflictError(error) && !hasRetried) {
        // Sleep for a short duration to allow the conflict to resolve
        await sleep(500); // 500ms delay

        // Retry the operation once
        return this.executeBlockOperationWithRetry(operation, pageId, idMappings, true);
      }

      // If it's a 409 but we've already retried, or it's a different error, re-throw
      throw error;
    }
  }

  private is409ConflictError(error: unknown): boolean {
    // Check for Notion API conflict error
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      // Notion API errors have a status property
      if (err.status === 409 || err.code === 'conflict_error') {
        return true;
      }
      // Check error message
      if (typeof err.message === 'string' && (err.message.includes('409') || err.message.includes('conflict'))) {
        return true;
      }
    }
    return false;
  }
}
