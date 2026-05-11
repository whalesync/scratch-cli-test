import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildWordPressDefaultView } from '../wordpress-default-view';
import { WordPressDataType } from '../wordpress-types';

/** Build a minimal rendered object schema (title, content, excerpt pattern). */
function rendered(dataType: WordPressDataType = WordPressDataType.RENDERED, rawReadonly = false) {
  const s = Type.Object({
    raw: Type.String({ [X_SCRATCH_READONLY]: rawReadonly ? true : undefined }),
    rendered: Type.String({ [X_SCRATCH_READONLY]: true }),
  });
  s[X_SCRATCH_CONNECTOR_DATA_TYPE] = dataType;
  return s;
}

function field(dataType: WordPressDataType, opts: { readonly?: boolean; format?: string } = {}) {
  const s = Type.String(opts.format ? { format: opts.format } : {});
  s[X_SCRATCH_CONNECTOR_DATA_TYPE] = dataType;
  if (opts.readonly) s[X_SCRATCH_READONLY] = true;
  return s;
}

function intField(dataType: WordPressDataType = WordPressDataType.INTEGER, opts: { readonly?: boolean } = {}) {
  const s = Type.Integer();
  s[X_SCRATCH_CONNECTOR_DATA_TYPE] = dataType;
  if (opts.readonly) s[X_SCRATCH_READONLY] = true;
  return s;
}

/** A schema resembling a real WordPress posts endpoint. */
function buildPostsSchema() {
  return Type.Object({
    title: rendered(WordPressDataType.RENDERED_INLINE),
    id: intField(WordPressDataType.INTEGER, { readonly: true }),
    slug: field(WordPressDataType.STRING),
    excerpt: rendered(),
    date: Type.Optional(field(WordPressDataType.DATETIME, { format: 'date-time' })),
    date_gmt: Type.Optional(field(WordPressDataType.DATETIME, { format: 'date-time' })),
    author: intField(WordPressDataType.INTEGER),
    status: field(WordPressDataType.ENUM),
    content: rendered(),
    featured_media: intField(WordPressDataType.INTEGER),
    link: field(WordPressDataType.URI, { readonly: true, format: 'uri' }),
    modified: field(WordPressDataType.DATETIME, { readonly: true, format: 'date-time' }),
    modified_gmt: field(WordPressDataType.DATETIME, { readonly: true, format: 'date-time' }),
    type: field(WordPressDataType.STRING, { readonly: true }),
    guid: rendered(WordPressDataType.RENDERED, true),
    format: field(WordPressDataType.ENUM),
    sticky: (() => {
      const s = Type.Boolean();
      s[X_SCRATCH_CONNECTOR_DATA_TYPE] = WordPressDataType.BOOLEAN;
      return s;
    })(),
    password: field(WordPressDataType.STRING),
    comment_status: field(WordPressDataType.ENUM),
    ping_status: field(WordPressDataType.ENUM),
    template: field(WordPressDataType.STRING),
    categories: (() => {
      const s = Type.Array(Type.Integer());
      s[X_SCRATCH_CONNECTOR_DATA_TYPE] = WordPressDataType.ARRAY;
      return s;
    })(),
    tags: (() => {
      const s = Type.Array(Type.Integer());
      s[X_SCRATCH_CONNECTOR_DATA_TYPE] = WordPressDataType.ARRAY;
      return s;
    })(),
    meta: (() => {
      const s = Type.Object({});
      s[X_SCRATCH_CONNECTOR_DATA_TYPE] = WordPressDataType.OBJECT;
      return s;
    })(),
    generated_slug: field(WordPressDataType.STRING, { readonly: true }),
    permalink_template: field(WordPressDataType.STRING, { readonly: true }),
    class_list: (() => {
      const s = Type.Array(Type.String());
      s[X_SCRATCH_CONNECTOR_DATA_TYPE] = WordPressDataType.ARRAY;
      s[X_SCRATCH_READONLY] = true;
      return s;
    })(),
    acf: Type.Optional(
      Type.Object({
        hero_image: field(WordPressDataType.URI, { format: 'uri' }),
        text_field: field(WordPressDataType.STRING),
      }),
    ),
  });
}

describe('buildWordPressDefaultView', () => {
  const schema = buildPostsSchema();
  const view = buildWordPressDefaultView(schema);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should place priority fields first in the expected order', () => {
    const paths = view.cols.map((c) => (c.kind === 'col' ? c.path : `group:${c.name}`));
    const titleIdx = paths.indexOf('title');
    const idIdx = paths.indexOf('id');
    const slugIdx = paths.indexOf('slug');
    const excerptIdx = paths.indexOf('excerpt');
    const dateIdx = paths.indexOf('date');
    const authorIdx = paths.indexOf('author');
    const statusIdx = paths.indexOf('status');
    const contentIdx = paths.indexOf('content');

    expect(titleIdx).toBe(0);
    expect(idIdx).toBeLessThan(slugIdx);
    expect(slugIdx).toBeLessThan(excerptIdx);
    expect(excerptIdx).toBeLessThan(dateIdx);
    expect(dateIdx).toBeLessThan(authorIdx);
    expect(authorIdx).toBeLessThan(statusIdx);
    expect(statusIdx).toBeLessThan(contentIdx);
  });

  it('should have subfields on rendered object columns (title, content, excerpt)', () => {
    const title = view.cols.find((c) => c.kind === 'col' && c.path === 'title');
    expect(title).toBeDefined();
    expect(title!.kind === 'col' && title!.subfields?.length).toBe(2);
    expect(title!.kind === 'col' && title!.selectedSubfield).toBe(0);

    const content = view.cols.find((c) => c.kind === 'col' && c.path === 'content');
    expect(content).toBeDefined();
    expect(content!.kind === 'col' && content!.subfields?.length).toBe(2);

    const excerpt = view.cols.find((c) => c.kind === 'col' && c.path === 'excerpt');
    expect(excerpt).toBeDefined();
    expect(excerpt!.kind === 'col' && excerpt!.subfields?.length).toBe(2);
  });

  it('should mark the ID column as readonly', () => {
    const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.kind === 'col' && idCol!.readonly).toBe(true);
  });

  it('should hide less important fields by default', () => {
    const dateGmt = view.cols.find((c) => c.kind === 'col' && c.path === 'date_gmt');
    expect(dateGmt).toBeDefined();
    expect(dateGmt!.kind === 'col' && dateGmt!.hidden).toBe(true);

    const modified = view.cols.find((c) => c.kind === 'col' && c.path === 'modified');
    expect(modified!.kind === 'col' && modified!.hidden).toBe(true);

    const guid = view.cols.find((c) => c.kind === 'col' && c.path === 'guid');
    expect(guid!.kind === 'col' && guid!.hidden).toBe(true);
  });

  it('should place date_gmt after date', () => {
    const paths = view.cols.map((c) => (c.kind === 'col' ? c.path : ''));
    const dateIdx = paths.indexOf('date');
    const dateGmtIdx = paths.indexOf('date_gmt');
    expect(dateGmtIdx).toBeGreaterThan(dateIdx);
  });

  it('should expand ACF fields as top-level columns with acf.prefix paths', () => {
    const acfCols = view.cols.filter((c) => c.kind === 'col' && c.path.startsWith('acf.'));
    expect(acfCols.length).toBe(2);
    expect(acfCols.map((c) => (c as { path: string }).path)).toContain('acf.hero_image');
    expect(acfCols.map((c) => (c as { path: string }).path)).toContain('acf.text_field');
  });

  it('should not include a top-level "acf" column', () => {
    const acfRoot = view.cols.find((c) => c.kind === 'col' && c.path === 'acf');
    expect(acfRoot).toBeUndefined();
  });

  it('should map types correctly', () => {
    const link = view.cols.find((c) => c.kind === 'col' && c.path === 'link');
    expect(link!.kind === 'col' && link!.type).toBe('url');

    const date = view.cols.find((c) => c.kind === 'col' && c.path === 'date');
    expect(date!.kind === 'col' && date!.type).toBe('date');

    const author = view.cols.find((c) => c.kind === 'col' && c.path === 'author');
    expect(author!.kind === 'col' && author!.type).toBe('number');

    const status = view.cols.find((c) => c.kind === 'col' && c.path === 'status');
    expect(status!.kind === 'col' && status!.type).toBe('string');
  });

  it('should use "string" type for inline rendered objects (title) and "richtext" for block rendered objects (content)', () => {
    const title = view.cols.find((c) => c.kind === 'col' && c.path === 'title');
    expect(title!.kind === 'col' && title!.type).toBe('string');
    // Title raw subfield should be 'string'
    expect(title!.kind === 'col' && title!.subfields![0].type).toBe('string');

    const content = view.cols.find((c) => c.kind === 'col' && c.path === 'content');
    expect(content!.kind === 'col' && content!.type).toBe('richtext');
    // Content raw subfield should be 'richtext'
    expect(content!.kind === 'col' && content!.subfields![0].type).toBe('richtext');
  });

  it('should propagate readonly from schema to raw subfield', () => {
    // guid has rawReadonly=true, so its raw subfield should be readonly
    const guid = view.cols.find((c) => c.kind === 'col' && c.path === 'guid') as TableViewCol;
    expect(guid).toBeDefined();
    expect(guid.subfields).toBeDefined();
    expect(guid.subfields![0].readonly).toBe(true);
    expect(guid.subfields![1].readonly).toBe(true); // rendered is always readonly

    // title has rawReadonly=false, so its raw subfield should not be readonly
    const title = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
    expect(title.subfields![0].readonly).toBeUndefined();
  });

  it('should handle a minimal schema gracefully', () => {
    const minimal = Type.Object({
      id: intField(WordPressDataType.INTEGER, { readonly: true }),
      title: rendered(WordPressDataType.RENDERED_INLINE),
    });
    const minimalView = buildWordPressDefaultView(minimal);
    expect(minimalView.cols.length).toBe(2);
    expect(minimalView.cols[0].kind === 'col' && minimalView.cols[0].path).toBe('title');
  });

  it('should handle an empty schema gracefully', () => {
    const empty = Type.Object({});
    const emptyView = buildWordPressDefaultView(empty);
    expect(emptyView.cols).toEqual([]);
  });

  it('should not produce any banner groups (no groups for WordPress)', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups.length).toBe(0);
  });
});
