import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { ParsedContent, Schema } from '../../utils/objects';
import { RefCleanerService } from '../ref-cleaner.service';

/**
 * Build a minimal record-shaped schema with the FK fields described by
 * `fkFields`. Mirrors the shape `extractForeignKeyPaths` walks: top-level
 * `properties.<field>` annotated with the FK options object.
 */
function buildSchemaWithFks(fkFields: Record<string, { linkedTableId: string; array?: boolean }>): Schema {
  const properties: Record<string, ReturnType<typeof Type.Number>> = {};
  for (const [name, cfg] of Object.entries(fkFields)) {
    const fieldSchema = cfg.array
      ? (Type.Array(Type.Number(), {
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: cfg.linkedTableId },
        }) as unknown as ReturnType<typeof Type.Number>)
      : Type.Number({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: cfg.linkedTableId } });
    properties[name] = fieldSchema;
  }
  return Type.Object({
    id: Type.Number(),
    ...properties,
  }) as unknown as Schema;
}

describe('RefCleanerService.nullifyAllForeignKeyFields', () => {
  const svc = new RefCleanerService();

  it('returns content unchanged when schema is null', () => {
    // Defensive — caller is responsible for passing a schema, but missing
    // schema must not blow up plan-build's strip pipeline.
    const content: ParsedContent = { id: 1, authorId: 5 };
    const result = svc.nullifyAllForeignKeyFields(content, null);
    expect(result).toEqual({ id: 1, authorId: 5 });
  });

  it('returns content unchanged when the schema has no FK fields', () => {
    // No `x-scratch-foreign-key` annotations → no FKs to strip → identity.
    const schema = buildSchemaWithFks({});
    const content: ParsedContent = { id: 1, name: 'X' };
    const result = svc.nullifyAllForeignKeyFields(content, schema);
    expect(result).toEqual({ id: 1, name: 'X' });
  });

  it('nullifies every scalar FK field', () => {
    // The core of pass4 for revert-edits: literal FK ids on the dirty
    // branch get nulled out so the CREATE/EDIT payload does not carry a
    // stale parent id. The values are recovered in the backfill op.
    const schema = buildSchemaWithFks({
      authorId: { linkedTableId: 'authors' },
      categoryId: { linkedTableId: 'categories' },
    });
    const content: ParsedContent = { id: 1, name: 'Post', authorId: 5, categoryId: 7 };

    const result = svc.nullifyAllForeignKeyFields(content, schema);

    expect(result).toEqual({ id: 1, name: 'Post', authorId: null, categoryId: null });
  });

  it('leaves non-FK scalar fields alone', () => {
    // The strip must touch ONLY the FK fields. Sibling scalar values that
    // happen to look like ids (or anything else) stay intact.
    const schema = buildSchemaWithFks({ authorId: { linkedTableId: 'authors' } });
    const content: ParsedContent = { id: 1, name: 'Post', authorId: 5, otherInt: 42, otherStr: 'hello' };

    const result = svc.nullifyAllForeignKeyFields(content, schema);

    expect(result).toEqual({ id: 1, name: 'Post', authorId: null, otherInt: 42, otherStr: 'hello' });
  });

  it('does not mutate the input content (returns a deep clone)', () => {
    // Plan-build relies on pass3 and pass4 being separate objects so it can
    // diff them. A mutating implementation would silently equalize them.
    const schema = buildSchemaWithFks({ authorId: { linkedTableId: 'authors' } });
    const content: ParsedContent = { id: 1, authorId: 5 };

    const result = svc.nullifyAllForeignKeyFields(content, schema);

    expect(content.authorId).toBe(5);
    expect((result as Record<string, unknown>).authorId).toBeNull();
  });

  it('handles array-valued FKs by filtering elements', () => {
    // FKs encoded as an array (e.g. multi-select reference fields) should
    // come out as an empty array, not a single null — matches how
    // stripDeletedRecordRefs handles array shapes today.
    const schema = buildSchemaWithFks({ tagIds: { linkedTableId: 'tags', array: true } });
    const content: ParsedContent = { id: 1, tagIds: [10, 20, 30] };

    const result = svc.nullifyAllForeignKeyFields(content, schema);

    expect((result as Record<string, unknown>).tagIds).toEqual([]);
  });
});

describe('RefCleanerService.rewriteForeignKeyValues', () => {
  const svc = new RefCleanerService();

  it('rewrites a scalar FK literal when the per-table remap has a hit', () => {
    // The core of backfill-phase resolution: an FK literal whose value
    // matches a (prior → new) row in RecreatedIdMap gets rewritten to the
    // new id. Caller (dispatchUpdateBatch) supplies `mapFor` per
    // linkedTableId so different FK targets consult different remaps.
    const schema = buildSchemaWithFks({ authorId: { linkedTableId: 'authors' } });
    const content: ParsedContent = { id: 1, authorId: 5 };
    const authorRemap = new Map([['5', '105']]);

    const result = svc.rewriteForeignKeyValues(content, schema, (linkedTableId) =>
      linkedTableId === 'authors' ? authorRemap : undefined,
    );

    expect((result as Record<string, unknown>).authorId).toBe('105');
  });

  it('leaves the FK literal alone when its value is not in the remap', () => {
    // Live FK (parent was never recreated). The remap is empty for that
    // value → no rewrite → the literal flows through to the connector.
    const schema = buildSchemaWithFks({ authorId: { linkedTableId: 'authors' } });
    const content: ParsedContent = { id: 1, authorId: 5 };
    const authorRemap = new Map([['999', '1999']]); // no entry for `5`

    const result = svc.rewriteForeignKeyValues(content, schema, () => authorRemap);

    expect((result as Record<string, unknown>).authorId).toBe(5);
  });

  it('uses canonical string equality (number ↔ string remap keys)', () => {
    // The remap stores ids as strings; the content's literal can be a JS
    // number (Postgres autoincrement) or string (SaaS-style id). Lookup
    // must canonicalize via String() to match either.
    const schema = buildSchemaWithFks({ authorId: { linkedTableId: 'authors' } });
    const contentNumber: ParsedContent = { id: 1, authorId: 5 };
    const contentString: ParsedContent = { id: 1, authorId: '5' };
    const remap = new Map([['5', '105']]);

    const fromNumber = svc.rewriteForeignKeyValues(contentNumber, schema, () => remap);
    const fromString = svc.rewriteForeignKeyValues(contentString, schema, () => remap);

    expect((fromNumber as Record<string, unknown>).authorId).toBe('105');
    expect((fromString as Record<string, unknown>).authorId).toBe('105');
  });

  it('skips FK fields whose linkedTableId has no remap returned by mapFor', () => {
    // `mapFor(linkedTableId)` returns undefined when the caller couldn't
    // resolve the FK target's folder (no DataFolder match, or no remap
    // entries at all for that folder). The rewrite is a no-op for that
    // FK; sibling FKs with a remap still get rewritten.
    const schema = buildSchemaWithFks({
      authorId: { linkedTableId: 'authors' },
      categoryId: { linkedTableId: 'categories' },
    });
    const content: ParsedContent = { id: 1, authorId: 5, categoryId: 7 };
    const authorRemap = new Map([['5', '105']]);

    const result = svc.rewriteForeignKeyValues(content, schema, (linkedTableId) =>
      linkedTableId === 'authors' ? authorRemap : undefined,
    );

    expect((result as Record<string, unknown>).authorId).toBe('105');
    expect((result as Record<string, unknown>).categoryId).toBe(7);
  });

  it('rewrites every element of an array-valued FK independently', () => {
    // Multi-select FK: each element looked up separately; matches get the
    // new id, misses stay as the original literal.
    const schema = buildSchemaWithFks({ tagIds: { linkedTableId: 'tags', array: true } });
    const content: ParsedContent = { id: 1, tagIds: [10, 20, 30] };
    const tagRemap = new Map([
      ['10', '110'],
      ['30', '330'],
    ]);

    const result = svc.rewriteForeignKeyValues(content, schema, () => tagRemap);

    expect((result as Record<string, unknown>).tagIds).toEqual(['110', 20, '330']);
  });

  it('returns content unchanged when schema is null', () => {
    const content: ParsedContent = { id: 1, authorId: 5 };
    const result = svc.rewriteForeignKeyValues(content, null, () => new Map());
    expect(result).toEqual({ id: 1, authorId: 5 });
  });
});

describe('RefCleanerService.extractForeignKeyPaths caching', () => {
  const svc = new RefCleanerService();

  it('recomputes FK paths for an updated schema object that reuses the same $id', () => {
    // Regression: destination-table schemas keep a stable `$id` (e.g.
    // `postgres/hubspot_test.Contacts 3`) across schema CHANGES. Sync setup
    // adds FK columns to an existing table's schema, so a cache keyed by
    // `$id` alone returns the pre-update (FK-less) path list — plan-build
    // then skips pseudo-ref stripping and edits fail in the edit phase with
    // "Cannot resolve pseudo-ref". The memo must be per schema OBJECT, so a
    // freshly-read updated schema always recomputes.
    const schemaWithoutFks = buildSchemaWithFks({});
    schemaWithoutFks.$id = 'postgres/hubspot_test.Contacts 3';
    expect(svc.extractForeignKeyPaths(schemaWithoutFks)).toEqual([]);

    const updatedSchemaWithFks = buildSchemaWithFks({ 'Associated Companies': { linkedTableId: 'Companies 3' } });
    updatedSchemaWithFks.$id = 'postgres/hubspot_test.Contacts 3';

    const pathsAfterUpdate = svc.extractForeignKeyPaths(updatedSchemaWithFks);
    expect(pathsAfterUpdate).toEqual([{ path: ['Associated Companies'], targetRemoteTableId: 'Companies 3' }]);
  });

  it('returns the memoized result for repeated calls with the same schema object', () => {
    const schema = buildSchemaWithFks({ authorId: { linkedTableId: 'authors' } });
    const firstCallResult = svc.extractForeignKeyPaths(schema);
    const secondCallResult = svc.extractForeignKeyPaths(schema);
    expect(secondCallResult).toBe(firstCallResult);
  });
});

/**
 * The Notion-relation shape (DEV-10942): the FK value is not a flat id array but ids nested
 * inside an envelope — `properties.X = { type: 'relation', relation: [{ id }], has_more }` —
 * with the FK options annotated BOTH on the envelope (like every property) and on the inner
 * `relation[].id` leaf (so the cleaner can reach refs the envelope path can't see). Stripping
 * must drop the whole `{ id }` element, never leave `{ id: null }` (Notion rejects it).
 */
describe('RefCleanerService — FK refs nested inside an envelope (Notion relation shape)', () => {
  const svc = new RefCleanerService();

  function buildNotionRelationSchema(options: { annotateEnvelope: boolean }): Schema {
    // Mirrors the real Notion shape (see notion-json-schema): the same map-less FK options
    // on the envelope and on the id leaf whose value IS the linked id.
    const fkOptions = { linkedTableId: 'categories-db' };
    return Type.Object({
      id: Type.String(),
      properties: Type.Object({
        Category: Type.Object(
          {
            type: Type.String(),
            relation: Type.Array(Type.Object({ id: Type.String({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions }) })),
            has_more: Type.Boolean(),
          },
          options.annotateEnvelope ? { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions } : {},
        ),
      }),
    }) as unknown as Schema;
  }

  function relationContent(ids: string[]): ParsedContent {
    return {
      id: 'page_1',
      properties: {
        Category: {
          type: 'relation',
          relation: ids.map((id) => ({ id })),
          has_more: false,
        },
      },
    };
  }

  it('stripPseudoRefs drops the co-pending {id: "@/…"} element and keeps resolved ids + envelope keys', () => {
    const schema = buildNotionRelationSchema({ annotateEnvelope: true });
    const content = relationContent(['@/Notion/categories/scratch_pending_publish_x.json', 'real-page-id']);

    const result = svc.stripPseudoRefs(content, schema) as Record<string, unknown>;

    expect(result).toEqual({
      id: 'page_1',
      properties: {
        Category: { type: 'relation', relation: [{ id: 'real-page-id' }], has_more: false },
      },
    });
  });

  it('stripDeletedRecordRefs drops elements whose id is a deleted record id', () => {
    const schema = buildNotionRelationSchema({ annotateEnvelope: true });
    const content = relationContent(['deleted-page-id', 'kept-page-id']);

    const result = svc.stripDeletedRecordRefs(content, schema, new Set(['deleted-page-id'])) as Record<string, unknown>;

    expect(result).toEqual({
      id: 'page_1',
      properties: {
        Category: { type: 'relation', relation: [{ id: 'kept-page-id' }], has_more: false },
      },
    });
  });

  it('nullifyAllForeignKeyFields empties the relation list (leaf-only annotation), preserving the envelope', () => {
    // With the annotation on the id leaf, pass4's "strip every FK" empties the repeating
    // elements — `relation: []`, the service's own "no links" shape — instead of leaving
    // `[{ id: null }]` husks.
    const schema = buildNotionRelationSchema({ annotateEnvelope: false });
    const content = relationContent(['page-a', 'page-b']);

    const result = svc.nullifyAllForeignKeyFields(content, schema) as Record<string, unknown>;

    expect(result).toEqual({
      id: 'page_1',
      properties: {
        Category: { type: 'relation', relation: [], has_more: false },
      },
    });
  });

  it('drops every element when all nested refs match (fully co-pending relation)', () => {
    const schema = buildNotionRelationSchema({ annotateEnvelope: true });
    const content = relationContent(['@/Notion/categories/a.json', '@/Notion/categories/b.json']);

    const result = svc.stripPseudoRefs(content, schema) as Record<string, unknown>;
    const properties = result.properties as Record<string, { relation: unknown[] }>;
    expect(properties.Category.relation).toEqual([]);
  });

  it('stripSpecificPseudoRefs drops ONLY the listed ref and keeps other pseudo-refs (DEV-10954)', () => {
    // Backfill scenario: one relation target failed to publish (its ref is unresolvable), a
    // second is still co-pending-but-resolvable, and a third already resolved. Only the
    // failed one is dropped; the resolvable pseudo-ref stays so resolveBatchPseudoRefs can
    // resolve it, and the real id is untouched.
    const schema = buildNotionRelationSchema({ annotateEnvelope: true });
    const failedRef = '@/Notion/categories/scratch_pending_publish_failed.json';
    const stillPendingRef = '@/Notion/categories/scratch_pending_publish_ok.json';
    const content = relationContent([failedRef, stillPendingRef, 'real-page-id']);

    const result = svc.stripSpecificPseudoRefs(content, schema, new Set([failedRef])) as Record<string, unknown>;

    expect(result).toEqual({
      id: 'page_1',
      properties: {
        Category: { type: 'relation', relation: [{ id: stillPendingRef }, { id: 'real-page-id' }], has_more: false },
      },
    });
  });

  it('stripSpecificPseudoRefs is a no-op when the unresolvable set is empty', () => {
    const schema = buildNotionRelationSchema({ annotateEnvelope: true });
    const content = relationContent(['@/Notion/categories/scratch_pending_publish_x.json', 'real-page-id']);

    const result = svc.stripSpecificPseudoRefs(content, schema, new Set()) as Record<string, unknown>;

    expect(result).toEqual(content);
  });
});
