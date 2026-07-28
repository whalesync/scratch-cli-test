import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, type TableView } from '@spinner/shared-types';
import { foreignKeyTargetKeyPath } from 'src/sync-draft/sync-draft.service';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';

/**
 * The seam where a connector's `targetKeyPath` declaration becomes the FK phase's runtime option
 * (DEV-11085). If this drops the value the feature silently disables itself: the resolver falls
 * back to matching remote ids and every non-id reference misses, which is the original bug.
 */
describe('foreignKeyTargetKeyPath', () => {
  function sourceContextFor(schema: ReturnType<typeof Type.Object>, view: TableView | null = null) {
    const fieldsByPath = new Map<string, SchemaField>(
      extractSchemaFields(schema).map((field) => [field.path, field] as [string, SchemaField]),
    );
    return { schema, fieldsByPath, view };
  }

  const SCHEMA_WITH_SLUG_KEYED_REFERENCE = Type.Object({
    tag: Type.String({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'col_tags', targetKeyPath: 'slug' } }),
    author: Type.String({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'col_authors' } }),
    title: Type.String(),
  });

  it('reads the declaration off the source schema', () => {
    expect(foreignKeyTargetKeyPath(sourceContextFor(SCHEMA_WITH_SLUG_KEYED_REFERENCE), 'tag')).toBe('slug');
  });

  it('is undefined for a foreign key that declares none — the remote-id default', () => {
    expect(foreignKeyTargetKeyPath(sourceContextFor(SCHEMA_WITH_SLUG_KEYED_REFERENCE), 'author')).toBeUndefined();
  });

  it('is undefined for a column that is not a foreign key at all', () => {
    expect(foreignKeyTargetKeyPath(sourceContextFor(SCHEMA_WITH_SLUG_KEYED_REFERENCE), 'title')).toBeUndefined();
  });

  it('is undefined for an unknown column', () => {
    expect(foreignKeyTargetKeyPath(sourceContextFor(SCHEMA_WITH_SLUG_KEYED_REFERENCE), 'nope')).toBeUndefined();
  });

  it('prefers the View for a SYNTHESIZED link column, whose annotation the schema join cannot reach', () => {
    const view: TableView = {
      name: 'Default',
      cols: [{ kind: 'col', path: 'synthesized', foreignKey: { linkedTableId: 'col_tags', targetKeyPath: 'handle' } }],
    };
    expect(foreignKeyTargetKeyPath(sourceContextFor(Type.Object({}), view), 'synthesized')).toBe('handle');
  });

  it('finds a View declaration nested inside a banner group', () => {
    const view: TableView = {
      name: 'Default',
      cols: [
        {
          kind: 'banner-group',
          name: 'Links',
          cols: [{ kind: 'col', path: 'grouped', foreignKey: { linkedTableId: 'col_tags', targetKeyPath: 'slug' } }],
        },
      ],
    };
    expect(foreignKeyTargetKeyPath(sourceContextFor(Type.Object({}), view), 'grouped')).toBe('slug');
  });

  it('falls back to the schema when the View column declares no key path', () => {
    const view: TableView = {
      name: 'Default',
      cols: [{ kind: 'col', path: 'tag', type: 'string' }],
    };
    expect(foreignKeyTargetKeyPath(sourceContextFor(SCHEMA_WITH_SLUG_KEYED_REFERENCE, view), 'tag')).toBe('slug');
  });
});
