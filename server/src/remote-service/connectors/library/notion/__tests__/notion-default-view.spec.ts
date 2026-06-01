import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildNotionDefaultView } from '../notion-default-view';

function prop(notionType: string, opts: { readonly?: boolean } = {}) {
  const s = Type.Unknown();
  (s as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = notionType;
  if (opts.readonly) (s as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
  return Type.Optional(s);
}

function titleProp() {
  const s = Type.Array(Type.Object({ type: Type.String(), plain_text: Type.String() }));
  (s as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = 'title';
  return Type.Optional(s);
}

function makeSchema() {
  return Type.Object({
    object: Type.Literal('page'),
    id: Type.String(),
    created_time: Type.String({ format: 'date-time' }),
    last_edited_time: Type.String({ format: 'date-time' }),
    created_by: Type.Object({ object: Type.Literal('user'), id: Type.String() }),
    last_edited_by: Type.Object({ object: Type.Literal('user'), id: Type.String() }),
    cover: Type.Optional(Type.Union([Type.Null()])),
    icon: Type.Optional(Type.Union([Type.Null()])),
    parent: Type.Object({ type: Type.Literal('database_id'), database_id: Type.String() }),
    archived: Type.Boolean(),
    in_trash: Type.Optional(Type.Boolean()),
    page_content: Type.Optional(Type.Array(Type.Unknown())),
    properties: Type.Object({
      Name: titleProp(),
      Status: prop('status'),
      Tags: prop('multi_select'),
      'Due Date': prop('date'),
      Assignee: prop('people'),
      Notes: prop('rich_text'),
      Score: prop('number'),
      Done: prop('checkbox'),
      Website: prop('url'),
      Formula: prop('formula', { readonly: true }),
      'Created By Prop': prop('created_by', { readonly: true }),
    }),
    url: Type.String({ format: 'uri' }),
    public_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
}

describe('buildNotionDefaultView', () => {
  const schema = makeSchema();
  const view = buildNotionDefaultView(schema);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should place the title property first', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    expect(paths[0]).toBe('properties.Name');
  });

  it('should place property columns before fixed fields', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const namePropIdx = paths.indexOf('properties.Name');
    const idIdx = paths.indexOf('id');
    expect(namePropIdx).toBeLessThan(idIdx);
  });

  it('should use property names as column names', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Due Date') as TableViewCol;
    expect(col.name).toBe('Due Date');
  });

  describe('hidden fields', () => {
    it('should hide the "object" field', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'object') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide parent', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'parent') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide in_trash', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'in_trash') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide public_url', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'public_url') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should not hide property columns', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Name') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('subfields on fixed fields', () => {
    it('should add id subfield to created_by', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_by') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('id');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add id subfield to last_edited_by', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'last_edited_by') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('id');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add database_id subfield to parent', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'parent') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('database_id');
      expect(col.selectedSubfield).toBe(0);
    });
  });

  describe('subfields on property columns', () => {
    it('should not add subfields to title arrays (array indexing not supported)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Name') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });

    it('should add name subfield to status properties', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Status') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('name');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add start subfield to date properties', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Due Date') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('start');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].type).toBe('date');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add id subfield to created_by property type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Created By Prop') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('id');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should not add subfields to simple types', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Score') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    it('should map number to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Score') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map checkbox to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Done') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map url to url type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Website') as TableViewCol;
      expect(col.type).toBe('url');
    });

    it('should map date-time fixed fields to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_time') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map uri fixed fields to url type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'url') as TableViewCol;
      expect(col.type).toBe('url');
    });
  });

  describe('readonly', () => {
    it('should mark readonly properties', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Formula') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark writable properties as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.Name') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  it('should handle an empty properties schema', () => {
    const emptySchema = Type.Object({
      object: Type.Literal('page'),
      id: Type.String(),
      properties: Type.Object({}),
    });
    const emptyView = buildNotionDefaultView(emptySchema);
    // Should have fixed fields only
    expect(emptyView.cols.length).toBe(2); // object and id
  });

  it('should not produce any banner groups', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});
