import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildWebflowDefaultView } from '../webflow-default-view';

/** Helper: build a fieldData property with optional annotations. */
function field(type: ReturnType<typeof Type.String>, opts: { readonly?: boolean; connectorDataType?: string } = {}) {
  if (opts.connectorDataType) (type as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = opts.connectorDataType;
  if (opts.readonly) (type as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
  return type;
}

function makeCollectionItemSchema() {
  return Type.Object({
    id: Type.String(),
    cmsLocaleId: Type.Optional(Type.String()),
    lastPublished: Type.Optional(Type.String({ format: 'date-time' })),
    lastUpdated: Type.Optional(Type.String({ format: 'date-time' })),
    createdOn: Type.Optional(Type.String({ format: 'date-time' })),
    isArchived: Type.Optional(Type.Boolean()),
    isDraft: Type.Optional(Type.Boolean()),
    fieldData: Type.Object({
      name: field(Type.String(), { connectorDataType: 'PlainText' }),
      slug: field(Type.String(), { connectorDataType: 'PlainText' }),
      heroImage: Type.Optional(
        field(Type.Object({ url: Type.String({ format: 'uri' }), alt: Type.Optional(Type.String()) })),
      ),
      rating: Type.Optional(field(Type.Number(), { connectorDataType: 'Number' })),
      published: Type.Optional(field(Type.Boolean(), { connectorDataType: 'Switch' })),
      websiteUrl: Type.Optional(field(Type.String({ format: 'uri' }), { connectorDataType: 'Link' })),
      publishDate: Type.Optional(field(Type.String({ format: 'date-time' }), { connectorDataType: 'DateTime' })),
      tags: Type.Optional(field(Type.Array(Type.String()), { connectorDataType: 'MultiReference' })),
      readonlyField: Type.Optional(field(Type.String(), { readonly: true })),
    }),
  });
}

function makeAssetsSchema() {
  return Type.Object({
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    displayName: Type.String(),
    hostedUrl: Type.Optional(Type.String({ format: 'uri' })),
    originalFileName: Type.Optional(Type.String()),
    contentType: Type.Optional(Type.String()),
    size: Type.Optional(Type.Number()),
    altText: Type.Optional(Type.String()),
    siteId: Type.Optional(Type.String({ [X_SCRATCH_READONLY]: true })),
    createdOn: Type.Optional(Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true })),
    lastUpdated: Type.Optional(Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true })),
  });
}

describe('buildWebflowDefaultView — collection_items', () => {
  const schema = makeCollectionItemSchema();
  const view = buildWebflowDefaultView(schema, 'collection_items');

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should expand fieldData properties with fieldData.<name> paths', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    expect(paths).toContain('fieldData.name');
    expect(paths).toContain('fieldData.slug');
    expect(paths).toContain('fieldData.heroImage');
    expect(paths).toContain('fieldData.rating');
  });

  it('should place name first, then id, then slug', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    expect(paths[0]).toBe('fieldData.name');
    expect(paths[1]).toBe('id');
    expect(paths[2]).toBe('fieldData.slug');
  });

  it('should order remaining priority fields after name/id/slug', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const slugIdx = paths.indexOf('fieldData.slug');
    const lastPublishedIdx = paths.indexOf('lastPublished');
    const lastUpdatedIdx = paths.indexOf('lastUpdated');
    const createdOnIdx = paths.indexOf('createdOn');

    expect(slugIdx).toBeLessThan(lastPublishedIdx);
    expect(lastPublishedIdx).toBeLessThan(lastUpdatedIdx);
    expect(lastUpdatedIdx).toBeLessThan(createdOnIdx);
  });

  describe('hidden fields', () => {
    it('should hide cmsLocaleId', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'cmsLocaleId') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should NOT hide isArchived', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'isArchived') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should NOT hide isDraft', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'isDraft') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should not hide fieldData columns', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.name') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    it('should map date-time format to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.publishDate') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map uri format to url type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.websiteUrl') as TableViewCol;
      expect(col.type).toBe('url');
    });

    it('should map Boolean to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.published') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map Number to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.rating') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map Array to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.tags') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map Object to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.heroImage') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map date-time fixed fields to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'lastUpdated') as TableViewCol;
      expect(col.type).toBe('date');
    });
  });

  describe('readonly', () => {
    it('should mark readonly fieldData fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.readonlyField') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark writable fieldData fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.name') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });

    it('should mark id as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark lastPublished as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'lastPublished') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark lastUpdated as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'lastUpdated') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark createdOn as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'createdOn') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark isArchived as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'isArchived') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  describe('name formatting', () => {
    it('should format camelCase as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'lastUpdated') as TableViewCol;
      expect(col.name).toBe('Last Updated');
    });

    it('should format fieldData field names', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.heroImage') as TableViewCol;
      expect(col.name).toBe('Hero Image');
    });

    it('should capitalize single-word names', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fieldData.name') as TableViewCol;
      expect(col.name).toBe('Name');
    });
  });

  it('should handle an empty fieldData schema', () => {
    const emptySchema = Type.Object({
      id: Type.String(),
      fieldData: Type.Object({}),
    });
    const emptyView = buildWebflowDefaultView(emptySchema, 'collection_items');
    expect(emptyView.cols.length).toBe(1); // just id
  });
});

describe('buildWebflowDefaultView — assets', () => {
  const schema = makeAssetsSchema();
  const view = buildWebflowDefaultView(schema, 'assets');

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should order fields by asset priority', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const displayNameIdx = paths.indexOf('displayName');
    const idIdx = paths.indexOf('id');
    const hostedUrlIdx = paths.indexOf('hostedUrl');
    const sizeIdx = paths.indexOf('size');
    const lastUpdatedIdx = paths.indexOf('lastUpdated');

    expect(displayNameIdx).toBeLessThan(idIdx);
    expect(idIdx).toBeLessThan(hostedUrlIdx);
    expect(hostedUrlIdx).toBeLessThan(sizeIdx);
    expect(sizeIdx).toBeLessThan(lastUpdatedIdx);
  });

  describe('hidden fields', () => {
    it('should hide siteId', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'siteId') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should not hide displayName', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'displayName') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    it('should map hostedUrl to url type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'hostedUrl') as TableViewCol;
      expect(col.type).toBe('url');
    });

    it('should map size to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'size') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map createdOn to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'createdOn') as TableViewCol;
      expect(col.type).toBe('date');
    });
  });

  describe('readonly', () => {
    it('should mark readonly asset fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should propagate readonly from siteId', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'siteId') as TableViewCol;
      expect(col.readonly).toBe(true);
    });
  });

  it('should handle an empty schema', () => {
    const emptySchema = Type.Object({});
    const emptyView = buildWebflowDefaultView(emptySchema, 'assets');
    expect(emptyView.cols).toHaveLength(0);
  });
});
