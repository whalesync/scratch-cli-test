/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable } from '@nestjs/common';
import { chunk } from 'lodash';
import { DbService } from '../db/db.service';
import { RefCleanerService } from './ref-cleaner.service';
import { SchemaHelperService } from './schema-helper.service';
import { parsePath } from './utils';

export interface ExtractedRef {
  sourceFilePath: string;
  targetFolderPath: string;
  targetFileName?: string;
  targetFileRecordId?: string;
  targetFolderId?: string;
}

@Injectable()
export class FileReferenceService {
  constructor(
    private readonly db: DbService,
    private readonly refCleanerService: RefCleanerService,
    private readonly schemaService: SchemaHelperService,
  ) {}

  /**
   * Extract references from a JSON object.
   * - Finds x-scratch-foreign-key references in schema/content.
   */
  extractReferences(sourceFilePath: string, content: any, schema?: any): ExtractedRef[] {
    const refs: ExtractedRef[] = [];

    // Pass 2: Use schema paths to find x-scratch-foreign-key refs
    if (schema) {
      const fkPaths = this.refCleanerService.extractForeignKeyPaths(schema);

      for (const fk of fkPaths) {
        // Get all nodes at this path (handles arrays)
        const nodes = this.getNodesByPath(content, fk.path);

        for (const node of nodes) {
          const ids = this.extractIds(node, fk.map);
          for (const id of ids) {
            refs.push({
              sourceFilePath,
              targetFolderPath: '', // will be resolved later
              targetFileRecordId: id,
              targetFolderId: fk.targetFolderId,
            });
          }
        }
      }
    }

    // Deduplicate
    const uniqueRefs = new Map<string, ExtractedRef>();
    for (const ref of refs) {
      const key = `${ref.targetFolderId || ref.targetFolderPath}|${ref.targetFileName || ''}|${ref.targetFileRecordId || ''}`;
      if (!uniqueRefs.has(key)) {
        uniqueRefs.set(key, ref);
      }
    }

    return Array.from(uniqueRefs.values());
  }

  /**
   * Retrieves all values at a given path from the content object.
   * Handles '[]' in the path by mapping over arrays.
   */
  getNodesByPath(root: any, path: string[]): any[] {
    if (!root) return [];
    if (path.length === 0) return [root];

    let current = [root];

    for (const segment of path) {
      const next: any[] = [];
      for (const node of current) {
        if (!node) continue;

        if (segment === '[]') {
          if (Array.isArray(node)) {
            next.push(...node);
          }
        } else {
          if (node[segment] !== undefined) {
            next.push(node[segment]);
          }
        }
      }
      current = next;
    }

    return current;
  }

  /**
   * Extracts IDs from a value.
   * - If value is array, process each item.
   * - If map is provided, looks for property `map` in object/item.
   * - Else uses value directly.
   */
  private extractIds(value: any, map?: string): string[] {
    if (!value) return [];

    // Normalize to array
    const items = Array.isArray(value) ? value : [value];
    const ids: string[] = [];

    for (const item of items) {
      if (!item) continue;

      if (map) {
        // expect object with key `map`
        if (typeof item === 'object' && item !== null && item[map] !== undefined) {
          const val = item[map];
          if (typeof val === 'string' || typeof val === 'number') ids.push(String(val));
        }
      } else {
        // use item directly if string or number
        if (typeof item === 'string' || typeof item === 'number') {
          ids.push(String(item));
        }
      }
    }
    return ids;
  }

  /**
   * Update references for a batch of files.
   * 1. Remove existing refs for these files.
   * 2. Extract new refs.
   * 3. Bulk insert.
   */
  async updateRefsForFiles(
    workbookId: string,
    branch: string,
    files: Array<{ path: string; content: any }>,
    schema?: any,
  ): Promise<void> {
    // 1. Remove existing refs (batched to avoid bind variable limit)
    const filePaths = files.map((f) => f.path);
    const DELETE_BATCH_SIZE = 10000;
    for (let i = 0; i < filePaths.length; i += DELETE_BATCH_SIZE) {
      await this.db.client.fileReference.deleteMany({
        where: {
          workbookId,
          branch,
          sourceFilePath: { in: filePaths.slice(i, i + DELETE_BATCH_SIZE) },
        },
      });
    }

    // 2. Extract new refs
    const allRefs: ExtractedRef[] = [];
    const schemaCache = new Map<string, any>();

    for (const file of files) {
      let fileSchema = schema;
      if (!fileSchema) {
        // Determine folder path
        const { folderPath } = parsePath(file.path);
        fileSchema = await this.schemaService.getJsonSchema(workbookId, folderPath, schemaCache);
      }

      const refs = this.extractReferences(file.path, file.content, fileSchema);
      allRefs.push(...refs);
    }

    if (allRefs.length === 0) return;

    // 2b. Resolve targetFolderIds to targetFolderPath
    const folderIdsToResolve = new Set(allRefs.filter((r) => r.targetFolderId).map((r) => r.targetFolderId as string));

    const folderIdToNameMap = new Map<string, string>();
    if (folderIdsToResolve.size > 0) {
      const folders = await this.db.client.dataFolder.findMany({
        where: { id: { in: Array.from(folderIdsToResolve) } },
        select: { id: true, path: true },
      });
      for (const folder of folders) {
        folderIdToNameMap.set(folder.id, folder.path || '');
      }
    }

    // 3. Insert in chunks to avoid Postgres parameter limits (65,535 max)
    const recordsToInsert = allRefs.map((ref) => {
      let folderPath = ref.targetFolderPath;
      if (ref.targetFolderId && folderIdToNameMap.has(ref.targetFolderId)) {
        folderPath = folderIdToNameMap.get(ref.targetFolderId)!;
      }

      return {
        workbookId,
        branch,
        sourceFilePath: ref.sourceFilePath,
        targetFolderPath: folderPath,
        targetFileName: ref.targetFileName,
        targetFileRecordId: ref.targetFileRecordId,
      };
    });

    const chunks = chunk(recordsToInsert, 2000);
    for (const c of chunks) {
      await this.db.client.fileReference.createMany({
        data: c,
      });
    }
  }

  /**
   * Find files that reference the given targets.
   * Used for resolving dependencies (e.g., delete phase).
   */
  async findRefsToFiles(
    workbookId: string,
    targets: Array<{ folderPath: string; fileName?: string; recordId?: string }>,
    branches: string[] = ['main', 'dirty'],
    onProgress?: (step: string) => Promise<void>,
  ): Promise<
    {
      sourceFilePath: string;
      branch: string;
    }[]
  > {
    if (targets.length === 0) {
      return [];
    }

    // Split into two flat queries instead of nested ORs per target.
    // A single IN clause on an indexed column is far faster than thousands of nested OR conditions.
    const results: { sourceFilePath: string; branch: string }[] = [];
    const seen = new Set<string>();

    const addResults = (rows: { sourceFilePath: string; branch: string }[]) => {
      for (const r of rows) {
        const key = `${r.sourceFilePath}|${r.branch}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(r);
        }
      }
    };

    // Query 1: Match by recordId using a flat IN clause (hits targetFileRecordId index)
    const recordIds = targets.map((t) => t.recordId).filter((id): id is string => !!id);
    if (recordIds.length > 0) {
      const recordIdChunks = chunk(recordIds, 10000);
      for (let i = 0; i < recordIdChunks.length; i++) {
        await onProgress?.(
          `Finding inbound references by record ID (${Math.min((i + 1) * 10000, recordIds.length)}/${recordIds.length})`,
        );
        const chunkResults = await this.db.client.fileReference.findMany({
          where: {
            workbookId,
            branch: { in: branches },
            targetFileRecordId: { in: recordIdChunks[i] },
          },
          select: { sourceFilePath: true, branch: true },
        });
        addResults(chunkResults);
      }
    }

    // Query 2: Match by (folderPath, fileName) pairs using flat OR conditions
    const fileNameTargets = targets.filter((t) => t.fileName && t.folderPath);
    if (fileNameTargets.length > 0) {
      const fileNameChunks = chunk(fileNameTargets, 2000);
      for (let i = 0; i < fileNameChunks.length; i++) {
        await onProgress?.(
          `Finding inbound references by file name (${Math.min((i + 1) * 2000, fileNameTargets.length)}/${fileNameTargets.length})`,
        );
        const chunkResults = await this.db.client.fileReference.findMany({
          where: {
            workbookId,
            branch: { in: branches },
            OR: fileNameChunks[i].map((t) => ({
              targetFolderPath: t.folderPath,
              targetFileName: t.fileName,
            })),
          },
          select: { sourceFilePath: true, branch: true },
        });
        addResults(chunkResults);
      }
    }

    return results;
  }

  /**
   * Strip references that point to any of the paths in the set.
   * Returns a deep copy of content with matching refs replaced by null.
   */
  /**
   * Strip references that point to any of the paths in the set or are unresolvable pseudo-refs.
   * Returns a deep copy of content with matching refs replaced by null.
   */

  async deleteForWorkbook(workbookId: string): Promise<void> {
    await this.db.client.fileReference.deleteMany({
      where: { workbookId },
    });
  }
}
