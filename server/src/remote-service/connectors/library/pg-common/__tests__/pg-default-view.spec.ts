import { Type } from '@sinclair/typebox';
import {
  PostgresColumnType,
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { buildPgDefaultView } from '../pg-default-view';

function col(pgType: PostgresColumnType, opts: { readonly?: boolean } = {}) {
  const s = (() => {
    switch (pgType) {
      case PostgresColumnType.NUMERIC:
        return Type.Number();
      case PostgresColumnType.BOOLEAN:
        return Type.Boolean();
      case PostgresColumnType.TIMESTAMP:
        return Type.String({ format: 'date-time' });
      case PostgresColumnType.JSONB:
        return Type.Unknown();
      case PostgresColumnType.TEXT_ARRAY:
        return Type.Array(Type.String());
      case PostgresColumnType.NUMERIC_ARRAY:
        return Type.Array(Type.Number());
      case PostgresColumnType.BOOLEAN_ARRAY:
        return Type.Array(Type.Boolean());
      default:
        return Type.String();
    }
  })();
  (s as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = pgType;
  if (opts.readonly) (s as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
  return s;
}

/** Mimic how the real connector builds nullable columns: mapPgType returns a Union, then the annotation is spread onto it. */
function nullable(pgType: PostgresColumnType, opts: { readonly?: boolean } = {}) {
  const inner = (() => {
    switch (pgType) {
      case PostgresColumnType.NUMERIC:
        return Type.Number();
      case PostgresColumnType.BOOLEAN:
        return Type.Boolean();
      case PostgresColumnType.TIMESTAMP:
        return Type.String({ format: 'date-time' });
      case PostgresColumnType.JSONB:
        return Type.Unknown();
      default:
        return Type.String();
    }
  })();
  const union = Type.Union([inner, Type.Null()]);
  (union as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = pgType;
  if (opts.readonly) (union as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
  return Type.Optional(union);
}

describe('buildPgDefaultView', () => {
  function buildPostsTable() {
    return Type.Object({
      id: col(PostgresColumnType.NUMERIC, { readonly: true }),
      title: Type.Optional(col(PostgresColumnType.TEXT)),
      slug: Type.Optional(col(PostgresColumnType.TEXT)),
      body: Type.Optional(col(PostgresColumnType.TEXT)),
      status: Type.Optional(col(PostgresColumnType.TEXT)),
      published: Type.Optional(col(PostgresColumnType.BOOLEAN)),
      view_count: nullable(PostgresColumnType.NUMERIC),
      metadata: nullable(PostgresColumnType.JSONB),
      tags: Type.Optional(col(PostgresColumnType.TEXT_ARRAY)),
      created_at: Type.Optional(col(PostgresColumnType.TIMESTAMP, { readonly: true })),
      updated_at: Type.Optional(col(PostgresColumnType.TIMESTAMP, { readonly: true })),
    });
  }

  const schema = buildPostsTable();
  const view = buildPgDefaultView(schema);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should place conventional columns first in priority order', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const idIdx = paths.indexOf('id');
    const titleIdx = paths.indexOf('title');
    const slugIdx = paths.indexOf('slug');
    const statusIdx = paths.indexOf('status');
    const createdAtIdx = paths.indexOf('created_at');
    const updatedAtIdx = paths.indexOf('updated_at');

    // Priority order: id, title, slug, status, created_at, updated_at
    expect(idIdx).toBe(0);
    expect(titleIdx).toBeLessThan(slugIdx);
    expect(slugIdx).toBeLessThan(statusIdx);
    expect(statusIdx).toBeLessThan(createdAtIdx);
    expect(createdAtIdx).toBeLessThan(updatedAtIdx);
  });

  it('should keep non-priority columns in their original schema order', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const updatedAtIdx = paths.indexOf('updated_at'); // last priority field
    const bodyIdx = paths.indexOf('body');
    const publishedIdx = paths.indexOf('published');
    const viewCountIdx = paths.indexOf('view_count');

    // Non-priority fields come after priority, in original order
    expect(bodyIdx).toBeGreaterThan(updatedAtIdx);
    expect(publishedIdx).toBeGreaterThan(bodyIdx);
    expect(viewCountIdx).toBeGreaterThan(publishedIdx);
  });

  it('should propagate readonly from schema', () => {
    const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
    expect(idCol.readonly).toBe(true);

    const createdCol = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
    expect(createdCol.readonly).toBe(true);

    const titleCol = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
    expect(titleCol.readonly).toBeUndefined();
  });

  it('should map numeric type to number', () => {
    const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
    expect(idCol.type).toBe('number');
  });

  it('should map boolean type to checkbox', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'published') as TableViewCol;
    expect(col.type).toBe('checkbox');
  });

  it('should map timestamp type to date', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
    expect(col.type).toBe('date');
  });

  it('should map jsonb type to object', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'metadata') as TableViewCol;
    expect(col.type).toBe('object');
  });

  it('should map array types to object', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'tags') as TableViewCol;
    expect(col.type).toBe('object');
  });

  it('should not set type for text columns (string is default)', () => {
    const titleCol = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
    expect(titleCol.type).toBeUndefined();
  });

  it('should format snake_case column names as Title Case', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
    expect(col.name).toBe('Created At');

    const vcCol = view.cols.find((c) => c.kind === 'col' && c.path === 'view_count') as TableViewCol;
    expect(vcCol.name).toBe('View Count');
  });

  it('should handle an empty schema gracefully', () => {
    const empty = Type.Object({});
    const emptyView = buildPgDefaultView(empty);
    expect(emptyView.cols).toEqual([]);
  });

  it('should not hide any fields by default', () => {
    const hiddenCols = view.cols.filter((c) => c.kind === 'col' && c.hidden === true);
    expect(hiddenCols).toHaveLength(0);
  });

  it('should not produce any banner groups', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });

  it('should work with tables that have no priority columns', () => {
    const customSchema = Type.Object({
      foo: col(PostgresColumnType.TEXT),
      bar: col(PostgresColumnType.NUMERIC),
      baz: col(PostgresColumnType.BOOLEAN),
    });
    const customView = buildPgDefaultView(customSchema);
    const paths = customView.cols.map((c) => (c as TableViewCol).path);
    // Should preserve original order
    expect(paths).toEqual(['foo', 'bar', 'baz']);
  });
});
