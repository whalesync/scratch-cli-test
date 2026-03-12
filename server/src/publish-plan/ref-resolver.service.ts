import { Injectable } from '@nestjs/common';
import { DbService } from 'src/db/db.service';
import { ParsedContent } from 'src/utils/objects';
import { FileIndexService } from './file-index.service';
import { parsePath } from './utils';

@Injectable()
export class RefResolverService {
  constructor(
    private readonly fileIndexService: FileIndexService,
    private readonly db: DbService,
  ) {}

  /**
   * Extract all pseudo-references from an object recursively.
   */
  private extractPseudoRefs(
    content: unknown,
    refs: { folderPath: string; filename: string }[] = [],
  ): { folderPath: string; filename: string }[] {
    if (typeof content === 'string' && content.startsWith('@/')) {
      const targetPath = content.substring(2);
      refs.push(parsePath(targetPath));
    } else if (Array.isArray(content)) {
      for (const item of content) {
        this.extractPseudoRefs(item, refs);
      }
    } else if (typeof content === 'object' && content !== null) {
      for (const value of Object.values(content)) {
        this.extractPseudoRefs(value, refs);
      }
    }
    return refs;
  }

  /**
   * Apply resolved pseudo-references to an object synchronously.
   */
  private applyPseudoRefsSync(content: unknown, refMap: Map<string, string>): unknown {
    if (typeof content === 'string' && content.startsWith('@/')) {
      const targetPath = content.substring(2);
      const { folderPath, filename } = parsePath(targetPath);
      const recordId = refMap.get(`${folderPath}:${filename}`);
      if (!recordId) {
        throw new Error(
          `Cannot resolve pseudo-ref "${content}": no record ID found in FileIndex for folder="${folderPath}" file="${filename}"`,
        );
      }
      return recordId;
    } else if (Array.isArray(content)) {
      return content.map((item) => this.applyPseudoRefsSync(item, refMap));
    } else if (typeof content === 'object' && content !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(content)) {
        result[key] = this.applyPseudoRefsSync(value, refMap);
      }
      return result;
    }
    return content;
  }

  /**
   * Extract all `@asset/<assetDbId>` references from an object recursively.
   */
  private extractAssetRefs(content: unknown, refs: Set<string>): void {
    if (typeof content === 'string' && content.startsWith('@asset/')) {
      refs.add(content.substring(7));
    } else if (Array.isArray(content)) {
      for (const item of content) {
        this.extractAssetRefs(item, refs);
      }
    } else if (typeof content === 'object' && content !== null) {
      for (const value of Object.values(content)) {
        this.extractAssetRefs(value, refs);
      }
    }
  }

  /**
   * Replace `@asset/<assetDbId>` references with the resolved `remoteAssetId`.
   */
  private applyAssetRefs(content: unknown, assetRefMap: Map<string, string>): unknown {
    if (typeof content === 'string' && content.startsWith('@asset/')) {
      const assetId = content.substring(7);
      const remoteAssetId = assetRefMap.get(assetId);
      if (!remoteAssetId) {
        throw new Error(`Cannot resolve asset pseudo-ref "${content}": no Asset found with id="${assetId}"`);
      }
      return remoteAssetId;
    } else if (Array.isArray(content)) {
      return content.map((item) => this.applyAssetRefs(item, assetRefMap));
    } else if (typeof content === 'object' && content !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(content)) {
        result[key] = this.applyAssetRefs(value, assetRefMap);
      }
      return result;
    }
    return content;
  }

  /**
   * Bulk resolve pseudo-references for an entire batch of operations to avoid N+1 queries.
   * Resolves both `@/` (file index) and `@asset/` (asset) pseudo-references.
   */
  async resolveBatchPseudoRefs(
    workbookId: string,
    unresolvedContents: ParsedContent[],
  ): Promise<Record<string, unknown>[]> {
    // 1. Resolve @/ pseudo-refs (file index lookups)
    const refs: { folderPath: string; filename: string }[] = [];
    for (const content of unresolvedContents) {
      this.extractPseudoRefs(content, refs);
    }

    const uniqueRefs = Array.from(new Map(refs.map((ref) => [`${ref.folderPath}:${ref.filename}`, ref])).values());
    const refMap = await this.fileIndexService.getRecordIds(workbookId, uniqueRefs);

    let resolved = unresolvedContents.map((content) => this.applyPseudoRefsSync(content, refMap) as ParsedContent);

    // 2. Resolve @asset/ pseudo-refs (asset DB id → remoteAssetId)
    const assetIds = new Set<string>();
    for (const content of resolved) {
      this.extractAssetRefs(content, assetIds);
    }

    if (assetIds.size > 0) {
      const assets = await this.db.client.asset.findMany({
        where: { id: { in: [...assetIds] } },
        select: { id: true, remoteAssetId: true },
      });
      const assetRefMap = new Map(assets.map((a) => [a.id, a.remoteAssetId]));

      resolved = resolved.map((content) => this.applyAssetRefs(content, assetRefMap) as ParsedContent);
    }

    return resolved;
  }
}
