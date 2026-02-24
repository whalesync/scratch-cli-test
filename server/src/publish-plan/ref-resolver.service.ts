import { Injectable } from '@nestjs/common';
import { ParsedContent } from 'src/utils/objects';
import { FileIndexService } from './file-index.service';
import { parsePath } from './utils';

@Injectable()
export class RefResolverService {
  constructor(private readonly fileIndexService: FileIndexService) {}

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
   * Bulk resolve pseudo-references for an entire batch of operations to avoid N+1 queries.
   */
  async resolveBatchPseudoRefs(
    workbookId: string,
    unresolvedContents: ParsedContent[],
  ): Promise<Record<string, unknown>[]> {
    const refs: { folderPath: string; filename: string }[] = [];
    for (const content of unresolvedContents) {
      this.extractPseudoRefs(content, refs);
    }

    // Deduplicate refs
    const uniqueRefs = Array.from(new Map(refs.map((ref) => [`${ref.folderPath}:${ref.filename}`, ref])).values());

    const refMap = await this.fileIndexService.getRecordIds(workbookId, uniqueRefs);

    return unresolvedContents.map((content) => this.applyPseudoRefsSync(content, refMap) as ParsedContent);
  }
}
