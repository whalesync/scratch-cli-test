import { TSchema } from '@sinclair/typebox';
import { ForeignKeyOptionSchema, X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { linkedTableIdCandidateTokensForRemoteTableId } from '../../../../../../schema-builder/foreign-key-linked-table-id';
import { BaseJsonTableSpec } from '../../../../types';
import { buildWixBlogJsonTableSpec } from '../wix-blog-json-schema';
import { WixBlogSchemaParser } from '../wix-blog-schema-parser';
import { WIX_BLOG_TABLE_REMOTE_IDS, wixBlogEntityId, wixBlogTableKeyFromEntityId } from '../wix-blog-tables';

const parser = new WixBlogSchemaParser();

/** Every `{ path, options }` foreign key declared on a table's schema, including nested objects. */
function collectForeignKeys(spec: BaseJsonTableSpec): { path: string; options: ForeignKeyOptionSchema }[] {
  const found: { path: string; options: ForeignKeyOptionSchema }[] = [];
  const walk = (node: TSchema | undefined, path: string): void => {
    if (!node || typeof node !== 'object') return;
    const annotation = (node as Record<string, unknown>)[X_SCRATCH_FOREIGN_KEY_OPTIONS];
    if (annotation) found.push({ path, options: annotation as ForeignKeyOptionSchema });
    const properties = (node as TSchema & { properties?: Record<string, TSchema> }).properties;
    for (const [key, child] of Object.entries(properties ?? {})) {
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(spec.schema, '');
  return found;
}

describe('Wix Blog tables', () => {
  it('exposes Blog Posts plus the three reference tables its foreign keys point at', () => {
    const previews = parser.parseTablePreviews();
    expect(previews.map((p) => p.displayName)).toEqual(['Blog Posts', 'Categories', 'Tags', 'Members']);
    expect(previews.map((p) => p.id.remoteId)).toEqual([
      ['wix-blog'],
      ['wix-blog-categories'],
      ['wix-blog-tags'],
      ['wix-members'],
    ]);
  });

  it('marks the reference tables read-only and Blog Posts writable', () => {
    const previews = parser.parseTablePreviews();
    const [posts, ...referenceTables] = previews;

    expect(posts.disabledCreates).toBeUndefined();
    expect(posts.disabledUpdates).toBeUndefined();
    expect(posts.disabledDeletes).toBeUndefined();

    for (const table of referenceTables) {
      expect(table).toMatchObject({ disabledCreates: true, disabledUpdates: true, disabledDeletes: true });
    }
  });

  it('round-trips every table id back to its key', () => {
    for (const key of Object.keys(WIX_BLOG_TABLE_REMOTE_IDS) as (keyof typeof WIX_BLOG_TABLE_REMOTE_IDS)[]) {
      expect(wixBlogTableKeyFromEntityId(wixBlogEntityId(key))).toBe(key);
    }
  });

  /**
   * The regression that made EVERY Wix foreign key permanently `needs_target` (DEV-11116): the schema
   * annotated `linkedTableId` with the sanitized `wsId` (`wix_blog`) while foreign-key resolution
   * matches against the tokens derived from the target folder's REMOTE id (`wix-blog`). They can never
   * be equal, because `sanitizeForTableWsId` maps `-` to `_`.
   *
   * This asserts the real resolution rule against the real listed tables, so any future table whose
   * remote id and annotation drift apart fails here instead of silently dropping a column from every
   * export.
   */
  it('declares every foreign key so it resolves against a listed table', () => {
    const listedTables = parser.parseTablePreviews();
    const foreignKeys = listedTables.flatMap((preview) =>
      collectForeignKeys(buildWixBlogJsonTableSpec(preview.id)).map((fk) => ({ ...fk, from: preview.displayName })),
    );

    // Guard against this test silently passing because the annotations were removed.
    expect(foreignKeys.map((fk) => fk.path).sort()).toEqual([
      'categoryIds',
      'memberId',
      'mostRecentContributorId',
      'relatedPostIds',
      'tagIds',
    ]);

    for (const { path, options, from } of foreignKeys) {
      const target = listedTables.find((preview) =>
        linkedTableIdCandidateTokensForRemoteTableId(preview.id.remoteId).includes(options.linkedTableId),
      );
      expect(target).toBeDefined();
      // The remote-id hint must agree with the table it resolved to.
      expect(options.linkedTableRemoteId).toEqual(target?.id.remoteId);
      expect(`${from}.${path} -> ${options.linkedTableId}`).toBe(`${from}.${path} -> ${target?.id.remoteId[0]}`);
    }
  });

  it('points the self-referencing relatedPostIds at the Blog Posts table', () => {
    const postsSpec = buildWixBlogJsonTableSpec(wixBlogEntityId('posts'));
    const related = collectForeignKeys(postsSpec).find((fk) => fk.path === 'relatedPostIds');

    expect(related?.options.linkedTableId).toBe('wix-blog');
    expect(linkedTableIdCandidateTokensForRemoteTableId(postsSpec.id.remoteId)).toContain(
      related?.options.linkedTableId,
    );
  });

  it('treats an unrecognized table id as Blog Posts so pre-existing folders keep resolving', () => {
    const spec = buildWixBlogJsonTableSpec({ wsId: 'wix_blog_legacy', remoteId: ['wix-blog-legacy'] });
    expect(spec.name).toBe('Blog Posts');
    expect(spec.titlePath).toBe('title');
  });
});

/** The declared properties of a table's schema. `TSchema` doesn't carry `properties` on its own. */
function schemaProperties(table: Parameters<typeof wixBlogEntityId>[0]): Record<string, TSchema> {
  const schema = buildWixBlogJsonTableSpec(wixBlogEntityId(table)).schema as TSchema & {
    properties?: Record<string, TSchema>;
  };
  return schema.properties ?? {};
}

describe('Wix Blog schemas', () => {
  it('does not declare fields the DraftPost API never returns', () => {
    const properties = Object.keys(schemaProperties('posts'));

    // Each of these produced a permanently-empty column on every destination (DEV-11117).
    expect(properties).not.toContain('wordCount');
    expect(properties).not.toContain('lastPublishedDate');
    expect(properties).not.toContain('slug');
    expect(properties).not.toContain('url');
    expect(properties).not.toContain('heroImage');
    expect(properties).not.toContain('translationId');
  });

  it('declares the timestamps and slugs Wix actually returns', () => {
    const properties = schemaProperties('posts');

    // Previously undeclared, so unexportable — an exported post had no created/updated date at all
    // (DEV-11118).
    expect(properties['editedDate']).toBeDefined();
    expect(properties['_createdDate']).toBeDefined();
    expect(properties['slugs']).toBeDefined();
    expect(properties['hasUnpublishedChanges']).toBeDefined();
    expect(properties['editedDate']).toMatchObject({ format: 'date-time', 'x-scratch-last-modified-field': true });
  });

  it('builds a distinct spec per reference table', () => {
    expect(buildWixBlogJsonTableSpec(wixBlogEntityId('categories'))).toMatchObject({
      name: 'Categories',
      titlePath: 'label',
    });
    expect(buildWixBlogJsonTableSpec(wixBlogEntityId('tags'))).toMatchObject({ name: 'Tags', titlePath: 'label' });
    expect(buildWixBlogJsonTableSpec(wixBlogEntityId('members'))).toMatchObject({
      name: 'Members',
      titlePath: 'profile.nickname',
    });
  });
});
