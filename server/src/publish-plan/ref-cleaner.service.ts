import { Injectable } from '@nestjs/common';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';

import { ParsedContent, Schema } from 'src/utils/objects';

@Injectable()
export class RefCleanerService {
  /**
   * Rewrite FK field values via a connector-aware mapping. For each FK in
   * the schema, look up the literal scalar value (or each element of an
   * array-valued FK) in `mapFor(linkedTableId)` and replace if the lookup
   * returns a hit. Values without a hit are left untouched.
   *
   * Returns a deep copy of `content` with the rewrites applied. Used by the
   * publish job to relink FK fields on records being recreated from a
   * previously-published delete — see `RecreatedIdMapService`.
   */
  rewriteForeignKeyValues(
    content: ParsedContent,
    schema: Schema | null,
    mapFor: (linkedTableId: string) => Map<string, string> | undefined,
  ): ParsedContent {
    if (!content || !schema) return content;

    const result = structuredClone(content);
    const fkPaths = this.extractForeignKeyPaths(schema);

    for (const fk of fkPaths) {
      const remap = mapFor(fk.targetRemoteTableId);
      if (!remap || remap.size === 0) continue;
      this.rewriteAtNodes(result, fk.path, (value) => {
        if (typeof value !== 'string' && typeof value !== 'number') return value;
        const key = String(value);
        const replacement = remap.get(key);
        return replacement === undefined ? value : replacement;
      });
    }

    return result;
  }

  /**
   * Nullify every FK field declared in the schema, regardless of value.
   * Returns a deep copy of content where each `x-scratch-foreign-key` path
   * is set to null (or, for array-shaped FKs, filtered to empty).
   *
   * Used by plan-build's "pass4" for revert ops: the CREATE/EDIT payload
   * gets emitted without FK fields so the connector doesn't fail an FK
   * constraint when a co-reverted parent's new id hasn't been assigned yet.
   * The stripped FK values are recovered into a BACKFILL op that runs after
   * the create phase, when RecreatedIdMap has every (prior → new) row from
   * this publish's recreates.
   */
  nullifyAllForeignKeyFields(content: ParsedContent, schema: Schema | null): ParsedContent {
    if (!content || !schema) return content;

    const result = structuredClone(content);
    const fkPaths = this.extractForeignKeyPaths(schema);

    for (const fk of fkPaths) {
      this.stripAtNodes(result, fk.path, () => true);
    }

    return result;
  }

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
   * Strip only the pseudo-refs (`@/` references) whose exact string is in
   * `unresolvableRefStrings`, leaving every other (resolvable) ref untouched.
   * Same schema-aware, element-dropping behavior as {@link stripPseudoRefs} — a
   * co-pending Notion `relation[].id` link collapses the WHOLE element so the field
   * converges to `relation: []`, never `[{ id: null }]` (DEV-10942). Used by the
   * publish backfill phase to drop a relation whose target record never landed while
   * keeping every resolvable link (DEV-10954). A no-op when the set is empty.
   */
  stripSpecificPseudoRefs(
    content: ParsedContent,
    schema: Schema | null,
    unresolvableRefStrings: Set<string>,
  ): ParsedContent {
    if (!content || !schema || unresolvableRefStrings.size === 0) return content;

    const result = structuredClone(content);
    const fkPaths = this.extractForeignKeyPaths(schema);

    for (const fk of fkPaths) {
      this.stripAtNodes(
        result,
        fk.path,
        (value) =>
          (typeof value === 'string' || typeof value === 'number') && unresolvableRefStrings.has(String(value)),
      );
    }

    return result;
  }

  /**
   * Strip all `@asset/` pseudo-refs from content. Schema-agnostic: walks all string values
   * recursively. Arrays have matching elements filtered out; scalar strings are set to null.
   */
  stripAssetPseudoRefs(content: ParsedContent): ParsedContent {
    if (!content) return content;
    return this.walkAndStripAssetRefs(structuredClone(content)) as ParsedContent;
  }

  private walkAndStripAssetRefs(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.startsWith('@asset/') ? null : value;
    }
    if (Array.isArray(value)) {
      return value.filter((item) => !(typeof item === 'string' && item.startsWith('@asset/')));
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.walkAndStripAssetRefs(val);
      }
      return result;
    }
    return value;
  }

  // Memoized per schema OBJECT (WeakMap identity), never per `$id`: a schema's
  // `$id` (e.g. `postgres/<schema>.<table>`) is stable across schema CHANGES,
  // so an id-keyed process-lifetime cache goes stale the moment a sync setup
  // adds FK columns to an existing table — plan-build then reuses the old
  // (FK-less) path list, skips pseudo-ref stripping, and edits fail with
  // "Cannot resolve pseudo-ref". Callers hold one schema instance per folder
  // per plan build (SchemaHelperService per-build caches), so identity keying
  // keeps the walk O(folders) per build while a fresh git read of an updated
  // schema always recomputes.
  private fkPathsCacheBySchemaObject = new WeakMap<Schema, Array<{ path: string[]; targetRemoteTableId: string }>>();

  /**
   * Traverses the schema to find all paths that are marked as foreign keys.
   *
   * Reads `linkedTableId` and nothing else, matching every other consumer of the annotation
   * (`schema-helpers.ts`'s whitelist copy into `SchemaField`, `scratch-git-2`'s Rust indexer).
   * A schema stored before 2026-07-22 may still carry the retired Notion-only `map` key; it is
   * ignored here, which is exactly the state a re-pull converges to.
   */
  extractForeignKeyPaths(schema: Schema): Array<{ path: string[]; targetRemoteTableId: string }> {
    const cached = this.fkPathsCacheBySchemaObject.get(schema);
    if (cached) {
      return cached;
    }

    const results: Array<{ path: string[]; targetRemoteTableId: string }> = [];

    const walk = (schemaNode: Record<string, unknown>, currentPath: string[]) => {
      if (!schemaNode || typeof schemaNode !== 'object') return;

      // Check for x-scratch-foreign-key
      const foreignKey = schemaNode[X_SCRATCH_FOREIGN_KEY_OPTIONS];

      if (foreignKey && typeof foreignKey === 'object' && !Array.isArray(foreignKey)) {
        const linkedTableId = (foreignKey as Record<string, unknown>).linkedTableId;
        if (typeof linkedTableId === 'string') {
          results.push({ path: currentPath, targetRemoteTableId: linkedTableId });
        }
      }

      // Recurse
      if (schemaNode.properties && typeof schemaNode.properties === 'object') {
        for (const [key, prop] of Object.entries(schemaNode.properties as Record<string, unknown>)) {
          if (prop && typeof prop === 'object') {
            walk(prop as Record<string, unknown>, [...currentPath, key]);
          }
        }
      }

      if (schemaNode.items) {
        if (Array.isArray(schemaNode.items)) {
          // tuple validation not supported for now in this simple walker
        } else if (typeof schemaNode.items === 'object') {
          walk(schemaNode.items as Record<string, unknown>, [...currentPath, '[]']);
        }
      }

      // Handle oneOf, anyOf, allOf (common in Webflow schemas)
      // These do NOT increase the data path depth.
      const combinators = ['oneOf', 'anyOf', 'allOf'] as const;
      for (const comb of combinators) {
        const combValue = schemaNode[comb];
        if (Array.isArray(combValue)) {
          for (const subSchema of combValue) {
            if (subSchema && typeof subSchema === 'object') {
              walk(subSchema as Record<string, unknown>, currentPath);
            }
          }
        }
      }
    };

    walk(schema, []);

    this.fkPathsCacheBySchemaObject.set(schema, results);

    return results;
  }

  // Helper to traverse and strip at specific path using a predicate
  private stripAtNodes(
    root: Record<string, unknown> | unknown[],
    path: string[],
    shouldStrip: (value: unknown) => boolean,
  ): void {
    if (!root) return;
    if (path.length === 0) return;

    const [head, ...tail] = path;

    if (head === '[]') {
      if (Array.isArray(root)) {
        const indexesToRemoveDescending: number[] = [];
        for (let i = 0; i < root.length; i++) {
          if (tail.length === 0) {
            root[i] = this.checkAndStrip(root[i], shouldStrip);
          } else if (root[i] && typeof root[i] === 'object') {
            // When the FK ref sits on a scalar LEAF inside each repeating element — e.g. a
            // Notion relation's `relation[].id`, where a co-pending link is
            // `{ id: '@/…pseudo-ref' }` — nulling the leaf alone would leave a husk the
            // service rejects on write (`{ id: null }`). Drop the WHOLE element instead, so
            // a stripped link converges to the service's own "no link" shape
            // (`relation: []`, never `[{ id: null }]`) — DEV-10942. Elements whose leaf
            // doesn't match — or whose tail isn't a plain-key path to a scalar — recurse
            // exactly as before.
            const leafValue = this.scalarLeafAtPlainKeyPath(root[i] as Record<string, unknown>, tail);
            if (leafValue !== undefined && shouldStrip(leafValue)) {
              indexesToRemoveDescending.unshift(i);
            } else {
              this.stripAtNodes(root[i] as Record<string, unknown>, tail, shouldStrip);
            }
          }
        }
        for (const indexToRemove of indexesToRemoveDescending) {
          root.splice(indexToRemove, 1);
        }
      }
    } else {
      const obj = root as Record<string, unknown>;
      if (obj[head] !== undefined) {
        if (tail.length === 0) {
          obj[head] = this.checkAndStrip(obj[head], shouldStrip);
        } else if (obj[head] && typeof obj[head] === 'object') {
          this.stripAtNodes(obj[head] as Record<string, unknown>, tail, shouldStrip);
        }
      }
    }
  }

  private checkAndStrip(value: unknown, shouldStrip: (value: unknown) => boolean): unknown {
    if (Array.isArray(value)) {
      return value.filter((item) => !shouldStrip(item));
    } else {
      return shouldStrip(value) ? null : value;
    }
  }

  /**
   * The scalar value at a plain-key path inside a repeating element, or undefined when the
   * path traverses another `[]`, a segment is missing, or the terminal isn't a string/number.
   * Strip predicates only ever match scalar ref values, so a non-scalar leaf simply falls
   * back to the normal recursion in {@link stripAtNodes}.
   */
  private scalarLeafAtPlainKeyPath(element: Record<string, unknown>, path: string[]): unknown {
    let node: unknown = element;
    for (const segment of path) {
      if (segment === '[]') return undefined;
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return typeof node === 'string' || typeof node === 'number' ? node : undefined;
  }

  /**
   * Mirror of `stripAtNodes` that REWRITES the value at each terminal node
   * via `transform(value)` instead of nulling/filtering. Array-valued FKs
   * have `transform` applied element-wise.
   */
  private rewriteAtNodes(
    root: Record<string, unknown> | unknown[],
    path: string[],
    transform: (value: unknown) => unknown,
  ): void {
    if (!root) return;
    if (path.length === 0) return;

    const [head, ...tail] = path;

    if (head === '[]') {
      if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
          if (tail.length === 0) {
            root[i] = this.checkAndRewrite(root[i], transform);
          } else if (root[i] && typeof root[i] === 'object') {
            this.rewriteAtNodes(root[i] as Record<string, unknown>, tail, transform);
          }
        }
      }
    } else {
      const obj = root as Record<string, unknown>;
      if (obj[head] !== undefined) {
        if (tail.length === 0) {
          obj[head] = this.checkAndRewrite(obj[head], transform);
        } else if (obj[head] && typeof obj[head] === 'object') {
          this.rewriteAtNodes(obj[head] as Record<string, unknown>, tail, transform);
        }
      }
    }
  }

  private checkAndRewrite(value: unknown, transform: (value: unknown) => unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => transform(item));
    }
    return transform(value);
  }
}
