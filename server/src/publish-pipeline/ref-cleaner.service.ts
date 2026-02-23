import { Injectable } from '@nestjs/common';

import { ParsedContent, Schema } from 'src/utils/objects';

@Injectable()
export class RefCleanerService {
  /**
   * Strip references whose values match any of the given deleted record IDs.
   * Returns a deep copy of content with matching refs replaced by null.
   */
  stripDeletedRecordRefs(content: ParsedContent, schema: Schema | null, idsToStrip: Set<string>): ParsedContent {
    if (!content || !schema || idsToStrip.size === 0) return content;

    const result = structuredClone(content);
    const fkPaths = this.extractForeignKeyPaths(schema);

    for (const fk of fkPaths) {
      this.stripAtNodes(
        result,
        fk.path,
        (value) => (typeof value === 'string' || typeof value === 'number') && idsToStrip.has(String(value)),
      );
    }

    return result;
  }

  /**
   * Strip all pseudo-refs (`@/` references) unconditionally.
   * Returns a deep copy of content with `@/` refs replaced by null.
   */
  stripPseudoRefs(content: ParsedContent, schema: Schema | null): ParsedContent {
    if (!content || !schema) return content;

    const result = structuredClone(content);
    const fkPaths = this.extractForeignKeyPaths(schema);

    for (const fk of fkPaths) {
      this.stripAtNodes(
        result,
        fk.path,
        (value) => (typeof value === 'string' || typeof value === 'number') && String(value).startsWith('@/'),
      );
    }

    return result;
  }

  /**
   * Traverses the schema to find all paths that are marked as foreign keys.
   */
  extractForeignKeyPaths(schema: Schema): Array<{ path: string[]; targetFolderId: string; map?: string }> {
    const results: Array<{ path: string[]; targetFolderId: string; map?: string }> = [];

    const walk = (schemaNode: any, currentPath: string[]) => {
      if (!schemaNode || typeof schemaNode !== 'object') return;

      // Check for x-scratch-foreign-key
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const foreignKey = schemaNode['x-scratch-foreign-key'];

      if (foreignKey) {
        let linkedTableId: string | undefined;
        let map: string | undefined;

        if (typeof foreignKey === 'string') {
          linkedTableId = foreignKey;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        } else if (typeof foreignKey === 'object' && foreignKey.linkedTableId) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          linkedTableId = foreignKey.linkedTableId;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          map = foreignKey.map;
        }

        if (linkedTableId) {
          results.push({
            path: currentPath,
            targetFolderId: linkedTableId,
            map: map,
          });
        }
      }

      // Recurse
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (schemaNode.properties) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        for (const [key, prop] of Object.entries(schemaNode.properties)) {
          walk(prop, [...currentPath, key]);
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (schemaNode.items) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (Array.isArray(schemaNode.items)) {
          // tuple validation not supported for now in this simple walker
        } else {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          walk(schemaNode.items, [...currentPath, '[]']);
        }
      }

      // Handle oneOf, anyOf, allOf (common in Webflow schemas)
      // These do NOT increase the data path depth.
      const combinators = ['oneOf', 'anyOf', 'allOf'];
      for (const comb of combinators) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (Array.isArray(schemaNode[comb])) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          for (const subSchema of schemaNode[comb]) {
            walk(subSchema, currentPath);
          }
        }
      }
    };

    walk(schema, []);
    return results;
  }

  // Helper to traverse and strip at specific path using a predicate
  private stripAtNodes(root: any, path: string[], shouldStrip: (value: any) => boolean): void {
    if (!root) return;
    if (path.length === 0) return;

    const [head, ...tail] = path;

    if (head === '[]') {
      if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
          if (tail.length === 0) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            root[i] = this.checkAndStrip(root[i], shouldStrip);
          } else {
            this.stripAtNodes(root[i], tail, shouldStrip);
          }
        }
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (root[head] !== undefined) {
        if (tail.length === 0) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          root[head] = this.checkAndStrip(root[head], shouldStrip);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          this.stripAtNodes(root[head], tail, shouldStrip);
        }
      }
    }
  }

  private checkAndStrip(value: any, shouldStrip: (value: any) => boolean): any {
    if (Array.isArray(value)) {
      return value.filter((item) => !shouldStrip(item));
    } else {
      return shouldStrip(value) ? null : value;
    }
  }
}
