import { Injectable } from '@nestjs/common';
import { chunk } from 'lodash';
import { ParsedContent, Schema } from 'src/utils/objects';
import { DbService } from '../db/db.service';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { RefCleanerService } from './ref-cleaner.service';
import { SchemaHelperService } from './schema-helper.service';
import { parsePath } from './utils';

export interface ExtractedRef {
  sourceFilePath: string;
  targetRemoteTableId?: string;
  targetRemoteId?: string;
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
  extractReferences(sourceFilePath: string, content: ParsedContent, schema?: Schema): ExtractedRef[] {
    const refs: ExtractedRef[] = [];

    if (schema) {
      const fkPaths = this.refCleanerService.extractForeignKeyPaths(schema);

      for (const fk of fkPaths) {
        const nodes = this.getNodesByPath(content, fk.path);

        for (const node of nodes) {
          const ids = this.extractIds(node);
          for (const id of ids) {
            refs.push({
              sourceFilePath,
              targetRemoteId: id,
              targetRemoteTableId: fk.targetRemoteTableId,
            });
          }
        }
      }
    }

    // Deduplicate
    const uniqueRefs = new Map<string, ExtractedRef>();
    for (const ref of refs) {
      const key = `${ref.targetRemoteTableId || ''}|${ref.targetRemoteId || ''}`;
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
  getNodesByPath(root: ParsedContent, path: string[]): unknown[] {
    if (!root) return [];
    if (path.length === 0) return [root];

    let current: unknown[] = [root];

    for (const segment of path) {
      const next: unknown[] = [];
      for (const node of current) {
        if (!node || typeof node !== 'object') continue;

        if (segment === '[]') {
          if (Array.isArray(node)) {
            next.push(...(node as unknown[]));
          }
        } else {
          const obj = node as Record<string, unknown>;
          if (obj[segment] !== undefined) {
            next.push(obj[segment]);
          }
        }
      }
      current = next;
    }

    return current;
  }

  /**
   * Extracts the referenced record ids out of a foreign-key node: the scalar itself, or every
   * scalar in an array of them. A structured node yields nothing — connectors whose link value is
   * an envelope annotate the id LEAF (Notion's `relation[].id`), so the annotated path is always
   * the scalar by the time the walk reaches it.
   */
  private extractIds(value: unknown): string[] {
    if (!value) return [];

    const items = Array.isArray(value) ? value : [value];
    const ids: string[] = [];

    for (const item of items) {
      if (typeof item === 'string' || typeof item === 'number') {
        ids.push(String(item));
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
    files: Array<{ path: string; content: ParsedContent }>,
    schema?: Schema,
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
    const schemaCache = new Map<string, BaseJsonTableSpec | null>();

    for (const file of files) {
      let fileSchema = schema;
      if (!fileSchema) {
        const { folderPath } = parsePath(file.path);
        fileSchema = (await this.schemaService.getJsonSchema(workbookId, folderPath, schemaCache)) ?? undefined;
      }

      const refs = this.extractReferences(file.path, file.content, fileSchema);
      allRefs.push(...refs);
    }

    if (allRefs.length === 0) return;

    // 3. Insert in chunks to avoid the bind-parameter limit (32,767 max)
    const recordsToInsert = allRefs.map((ref) => ({
      workbookId,
      branch,
      sourceFilePath: ref.sourceFilePath,
      targetRemoteTableId: ref.targetRemoteTableId,
      targetRemoteId: ref.targetRemoteId,
    }));

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
    targets: Array<{ remoteTableId?: string; recordId?: string }>,
    branches: string[] = ['main', 'dirty'],
    onProgress?: (step: string) => Promise<void>,
  ): Promise<{ sourceFilePath: string; branch: string }[]> {
    const recordIdTargets = targets.filter((t) => t.recordId && t.remoteTableId);
    if (recordIdTargets.length === 0) {
      return [];
    }

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

    const chunks = chunk(recordIdTargets, 2000);
    for (let i = 0; i < chunks.length; i++) {
      await onProgress?.(
        `Finding inbound references by record ID (${Math.min((i + 1) * 2000, recordIdTargets.length)}/${recordIdTargets.length})`,
      );
      const chunkResults = await this.db.client.fileReference.findMany({
        where: {
          workbookId,
          branch: { in: branches },
          OR: chunks[i].map((t) => ({
            targetRemoteTableId: t.remoteTableId,
            targetRemoteId: t.recordId,
          })),
        },
        select: { sourceFilePath: true, branch: true },
      });
      addResults(chunkResults);
    }

    return results;
  }

  async deleteForWorkbook(workbookId: string): Promise<void> {
    await this.db.client.fileReference.deleteMany({
      where: { workbookId },
    });
  }

  /**
   * Delete refs whose source file lives under a SINGLE folder being deleted —
   * including files stored deeper than the folder's own path (Shopify-GID artifacts)
   * — while preserving refs owned by a live child DataFolder nested inside it (e.g.
   * a Webflow secondary-locale folder). Mirrors the longest-prefix ownership rule
   * used for FileIndex, but expressed on `sourceFilePath` (a full file path).
   *
   * FileReference has no `connectorAccountId`, so it cannot distinguish two
   * connections that share an identical folder path (folder paths carry no
   * connection prefix — see `buildConnectorFolderPath`). In that rare case the
   * sibling connection's refs under the same path are also removed and rebuilt on
   * its next pull/publish — the accepted trade-off of the DEV-10885 no-column
   * decision.
   *
   * All folder paths are WITHOUT a leading slash.
   */
  async deleteForFolderExcludingLiveChildren(
    workbookId: string,
    deletedFolderPath: string,
    liveChildFolderPaths: string[],
  ): Promise<void> {
    const subtreePrefix = deletedFolderPath.endsWith('/') ? deletedFolderPath : `${deletedFolderPath}/`;
    await this.db.client.fileReference.deleteMany({
      where: {
        workbookId,
        sourceFilePath: { startsWith: subtreePrefix },
        // Exclude every live child folder's own subtree so its refs survive.
        ...(liveChildFolderPaths.length > 0
          ? {
              AND: liveChildFolderPaths.map((childFolderPath) => ({
                NOT: {
                  sourceFilePath: {
                    startsWith: childFolderPath.endsWith('/') ? childFolderPath : `${childFolderPath}/`,
                  },
                },
              })),
            }
          : {}),
      },
    });
  }
}
