import { describe, expect, it } from 'vitest';
import { createFallbackTableView, createFallbackTableViewFromColumnDefinitions } from './create-fallback-view';
import type { ColumnDefinition } from './types';

function makeSchema(
  properties: Record<string, unknown>,
  opts?: { titlePath?: unknown; titleColumnRemoteId?: unknown },
): Record<string, unknown> {
  return {
    schema: { type: 'object', properties },
    ...opts,
  };
}

describe('createFallbackTableView', () => {
  it('returns a TableView with name "Generated"', () => {
    const view = createFallbackTableView(makeSchema({ name: { type: 'string', title: 'Name' } }));
    expect(view.name).toBe('Generated');
  });

  it('places the title column first when titlePath is set', () => {
    const view = createFallbackTableView(
      makeSchema(
        {
          id: { type: 'string', title: 'ID' },
          name: { type: 'string', title: 'Name' },
          email: { type: 'string', title: 'Email' },
        },
        { titlePath: 'name' },
      ),
    );
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'name', name: 'Name' });
    expect(view.cols.map((c) => ('path' in c ? c.path : ''))).toEqual(['name', 'id', 'email']);
  });

  it('reads the legacy titleColumnRemoteId segment array (DEV-10092 compat)', () => {
    const view = createFallbackTableView(
      makeSchema(
        {
          id: { type: 'string', title: 'ID' },
          name: { type: 'string', title: 'Name' },
          email: { type: 'string', title: 'Email' },
        },
        // schema.json committed before the rename: a segment array under the old key.
        { titleColumnRemoteId: ['name'] },
      ),
    );
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'name', name: 'Name' });
  });

  it('falls back to first column as title when titlePath is missing', () => {
    const view = createFallbackTableView(
      makeSchema({
        id: { type: 'string', title: 'ID' },
        name: { type: 'string', title: 'Name' },
      }),
    );
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'id', name: 'ID' });
  });

  it("falls back to first column when titlePath doesn't match any column", () => {
    const view = createFallbackTableView(
      makeSchema(
        {
          id: { type: 'string', title: 'ID' },
          name: { type: 'string', title: 'Name' },
        },
        { titlePath: 'nonexistent' },
      ),
    );
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'id', name: 'ID' });
  });

  it('each col has correct kind, name, path, type, and readonly', () => {
    const view = createFallbackTableView(
      makeSchema({
        title: { type: 'string', title: 'Title', 'x-scratch-readonly': true },
        count: { type: 'number', title: 'Count' },
      }),
    );
    expect(view.cols).toHaveLength(2);
    expect(view.cols[0]).toMatchObject({
      kind: 'col',
      name: 'Title',
      path: 'title',
      type: 'string',
      readonly: true,
    });
    expect(view.cols[1]).toMatchObject({
      kind: 'col',
      name: 'Count',
      path: 'count',
      type: 'number',
      readonly: undefined,
    });
  });

  it('maps dataType/format to TablePropertyType correctly', () => {
    const view = createFallbackTableView(
      makeSchema({
        created: { type: 'string', format: 'date-time', title: 'Created' },
        birthDate: { type: 'string', format: 'date', title: 'Birth Date' },
        website: { type: 'string', format: 'uri', title: 'Website' },
        link: { type: 'string', format: 'url', title: 'Link' },
        plain: { type: 'string', title: 'Plain' },
        count: { type: 'number', title: 'Count' },
        age: { type: 'integer', title: 'Age' },
        active: { type: 'boolean', title: 'Active' },
        meta: { type: 'object', title: 'Meta', 'x-scratch-readonly': true },
        tags: { type: 'array', title: 'Tags' },
      }),
    );

    const typeByPath = new Map(
      view.cols.map((c) => ('path' in c ? ([c.path, c.type] as const) : (['', undefined] as const))),
    );
    expect(typeByPath.get('created')).toBe('date');
    expect(typeByPath.get('birthDate')).toBe('date');
    expect(typeByPath.get('website')).toBe('url');
    expect(typeByPath.get('link')).toBe('url');
    expect(typeByPath.get('plain')).toBe('string');
    expect(typeByPath.get('count')).toBe('number');
    expect(typeByPath.get('age')).toBe('number');
    expect(typeByPath.get('active')).toBe('checkbox');
    expect(typeByPath.get('meta')).toBe('object');
    expect(typeByPath.get('tags')).toBeUndefined();
  });

  it('all columns default to hidden: false', () => {
    const view = createFallbackTableView(
      makeSchema({
        a: { type: 'string', title: 'A' },
        b: { type: 'number', title: 'B' },
      }),
    );
    for (const col of view.cols) {
      if ('hidden' in col) {
        expect(col.hidden).toBe(false);
      }
    }
  });

  it('returns { name: "Generated", cols: [] } for empty/malformed schema', () => {
    expect(createFallbackTableView({})).toEqual({ name: 'Generated', cols: [] });
    expect(createFallbackTableView({ schema: 'not an object' })).toEqual({ name: 'Generated', cols: [] });
    expect(createFallbackTableView({ schema: { type: 'object', properties: {} } })).toEqual({
      name: 'Generated',
      cols: [],
    });
  });

  it('handles nested property columns (dot-separated paths from container expansion)', () => {
    const view = createFallbackTableView(
      makeSchema({
        address: {
          type: 'object',
          properties: {
            street: { type: 'string', title: 'Street' },
            city: { type: 'string', title: 'City' },
          },
        },
      }),
    );
    expect(view.cols).toHaveLength(2);
    expect(view.cols[0]).toMatchObject({ path: 'address.street', name: 'Street' });
    expect(view.cols[1]).toMatchObject({ path: 'address.city', name: 'City' });
  });
});

function makeColumn(id: string, overrides: Partial<ColumnDefinition> = {}): ColumnDefinition {
  return {
    id,
    displayName: id,
    dataType: 'unknown',
    attributes: { readOnly: false, writeOnce: false, required: false, nested: id.includes('.') },
    ...overrides,
  };
}

describe('createFallbackTableViewFromColumnDefinitions', () => {
  it('maps data-derived (schema-less) column definitions into a generated view', () => {
    // Mirrors the shape readDiffGridDataPage emits when a table has no schema file:
    // every flattened leaf path comes through with dataType 'unknown'. The grid renders
    // these columns so a schema-less table shows its data instead of blank pages (DEV-10419).
    const columns: ColumnDefinition[] = [makeColumn('id'), makeColumn('name'), makeColumn('fields.email')];

    const view = createFallbackTableViewFromColumnDefinitions(columns);

    expect(view.name).toBe('Generated');
    expect(view.cols).toEqual([
      {
        kind: 'col',
        name: 'id',
        path: 'id',
        type: undefined,
        readonly: undefined,
        writeOnce: undefined,
        hidden: false,
      },
      {
        kind: 'col',
        name: 'name',
        path: 'name',
        type: undefined,
        readonly: undefined,
        writeOnce: undefined,
        hidden: false,
      },
      {
        kind: 'col',
        name: 'fields.email',
        path: 'fields.email',
        type: undefined,
        readonly: undefined,
        writeOnce: undefined,
        hidden: false,
      },
    ]);
  });

  it('returns an empty generated view for no columns', () => {
    expect(createFallbackTableViewFromColumnDefinitions([])).toEqual({ name: 'Generated', cols: [] });
  });

  it('carries through resolved types and readonly/writeOnce attributes', () => {
    const columns: ColumnDefinition[] = [
      makeColumn('count', { dataType: 'integer' }),
      makeColumn('published', { dataType: 'boolean' }),
      makeColumn('createdAt', { dataType: 'string', format: 'date-time' }),
      makeColumn('rid', {
        dataType: 'string',
        attributes: { readOnly: true, writeOnce: false, required: false, nested: false },
      }),
    ];

    const view = createFallbackTableViewFromColumnDefinitions(columns);

    const byPath = (path: string) =>
      view.cols.find((c): c is Extract<typeof c, { kind: 'col' }> => c.kind === 'col' && c.path === path);
    expect(byPath('count')?.type).toBe('number');
    expect(byPath('published')?.type).toBe('checkbox');
    expect(byPath('createdAt')?.type).toBe('date');
    expect(byPath('rid')?.readonly).toBe(true);
  });
});
