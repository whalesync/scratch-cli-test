import { Injectable } from '@nestjs/common';
import { FileIndexService } from './file-index.service';
import { parsePath } from './utils';

@Injectable()
export class RefResolverService {
  constructor(private readonly fileIndexService: FileIndexService) {}

  /**
   * Extract all pseudo-references from an object recursively.
   */
  private extractPseudoRefs(
    obj: unknown,
    refs: { folderPath: string; filename: string }[] = [],
  ): { folderPath: string; filename: string }[] {
    if (typeof obj === 'string' && obj.startsWith('@/')) {
      const targetPath = obj.substring(2);
      refs.push(parsePath(targetPath));
    } else if (Array.isArray(obj)) {
      for (const item of obj) {
        this.extractPseudoRefs(item, refs);
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const value of Object.values(obj)) {
        this.extractPseudoRefs(value, refs);
      }
    }
    return refs;
  }

  /**
   * Apply resolved pseudo-references to an object synchronously.
   */
  private applyPseudoRefsSync(obj: unknown, refMap: Map<string, string>): unknown {
    if (typeof obj === 'string' && obj.startsWith('@/')) {
      const targetPath = obj.substring(2);
      const { folderPath, filename } = parsePath(targetPath);
      const recordId = refMap.get(`${folderPath}:${filename}`);
      if (!recordId) {
        throw new Error(
          `Cannot resolve pseudo-ref "${obj}": no record ID found in FileIndex for folder="${folderPath}" file="${filename}"`,
        );
      }
      return recordId;
    } else if (Array.isArray(obj)) {
      return obj.map((item) => this.applyPseudoRefsSync(item, refMap));
    } else if (typeof obj === 'object' && obj !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.applyPseudoRefsSync(value, refMap);
      }
      return result;
    }
    return obj;
  }

  /**
   * Bulk resolve pseudo-references for an entire batch of operations to avoid N+1 queries.
   */
  async resolveBatchPseudoRefs(
    workbookId: string,
    operations: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const refs: { folderPath: string; filename: string }[] = [];
    for (const op of operations) {
      this.extractPseudoRefs(op, refs);
    }

    // Deduplicate refs
    const uniqueRefs = Array.from(new Map(refs.map((ref) => [`${ref.folderPath}:${ref.filename}`, ref])).values());

    const refMap = await this.fileIndexService.getRecordIds(workbookId, uniqueRefs);

    return operations.map((op) => this.applyPseudoRefsSync(op, refMap) as Record<string, unknown>);
  }
}
