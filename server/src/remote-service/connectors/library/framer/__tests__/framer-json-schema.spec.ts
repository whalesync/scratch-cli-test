import { Value } from '@sinclair/typebox/value';
import { X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildFramerDefaultView } from '../framer-default-view';
import { buildFramerJsonTableSpec, getFramerForeignKeyOptions, isFramerForeignKey } from '../framer-json-schema';
import { FramerCollectionMeta } from '../framer-types';

const COLLECTION: FramerCollectionMeta = {
  id: 'col_blog',
  name: 'Blog Posts',
  fields: [
    { id: 'fTitle', name: 'Title', type: 'string' },
    { id: 'fBody', name: 'Body', type: 'formattedText' },
    { id: 'fViews', name: 'Views', type: 'number' },
    { id: 'fFeatured', name: 'Featured', type: 'boolean' },
    { id: 'fDate', name: 'Published', type: 'date' },
    {
      id: 'fStatus',
      name: 'Status',
      type: 'enum',
      cases: [
        { id: 'c1', name: 'Draft' },
        { id: 'c2', name: 'Live' },
      ],
    },
    { id: 'fHero', name: 'Hero', type: 'image' },
    { id: 'fLink', name: 'Website', type: 'link' },
    { id: 'fAuthor', name: 'Author', type: 'collectionReference', collectionId: 'col_authors' },
    { id: 'fTags', name: 'Tags', type: 'multiCollectionReference', collectionId: 'col_tags' },
    { id: 'fUnknown', name: 'Future', type: 'unsupported' },
    { id: 'fDivider', name: 'Divider', type: 'divider' },
  ],
};

const ID: EntityId = { wsId: 'col_blog', remoteId: ['col_blog'] };

describe('buildFramerJsonTableSpec', () => {
  const spec = buildFramerJsonTableSpec(ID, COLLECTION);

  it('uses the slug for filenames and the id as the remote id', () => {
    expect(spec.idPath).toBe('id');
    expect(spec.slugPath).toBe('slug');
    // Project is singular per connection → collections sit at the top level.
    expect(spec.basePath).toEqual([]);
    expect(spec.name).toBe('Blog Posts');
  });

  it('picks the first text field as the title and the first formattedText as main content', () => {
    expect(spec.titlePath).toEqual('fieldData.fTitle.value');
    expect(spec.mainContentPath).toEqual('fieldData.fBody.value');
  });

  it('excludes layout-only (divider) fields from fieldData', () => {
    const fieldData = (spec.schema as unknown as { properties: { fieldData: { properties: Record<string, unknown> } } })
      .properties.fieldData.properties;
    expect(Object.keys(fieldData)).toEqual([
      'fTitle',
      'fBody',
      'fViews',
      'fFeatured',
      'fDate',
      'fStatus',
      'fHero',
      'fLink',
      'fAuthor',
      'fTags',
      'fUnknown',
    ]);
  });

  it('marks an unsupported field value read-only', () => {
    const fieldData = (
      spec.schema as unknown as {
        properties: { fieldData: { properties: Record<string, { properties: { value: Record<string, unknown> } }> } };
      }
    ).properties.fieldData.properties;
    expect(fieldData.fUnknown.properties.value[X_SCRATCH_READONLY]).toBe(true);
    expect(fieldData.fTitle.properties.value[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('marks ids read-only and slug/draft writable', () => {
    const props = (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.slug[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('annotates single + multi reference fields as foreign keys at the value leaf', () => {
    expect(isFramerForeignKey('fAuthor', spec)).toBe(true);
    expect(getFramerForeignKeyOptions('fAuthor', spec)).toEqual({ linkedTableId: 'col_authors' });
    expect(isFramerForeignKey('fTags', spec)).toBe(true);
    expect(getFramerForeignKeyOptions('fTags', spec)).toEqual({ linkedTableId: 'col_tags' });
    // A non-reference field is not a foreign key.
    expect(isFramerForeignKey('fTitle', spec)).toBe(false);
  });

  it('stamps the connector data type onto each field value', () => {
    const fieldData = (
      spec.schema as unknown as {
        properties: { fieldData: { properties: Record<string, { properties: { value: Record<string, unknown> } }> } };
      }
    ).properties.fieldData.properties;
    expect(fieldData.fTitle.properties.value[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('string');
    expect(fieldData.fStatus.properties.value[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('enum');
  });

  it('validates a verbatim pulled item against the generated schema', () => {
    const item = {
      id: 'item1',
      nodeId: 'item1',
      slug: 'hello-world',
      slugByLocale: {},
      draft: false,
      fieldData: {
        fTitle: { type: 'string', value: 'Hello', valueByLocale: {} },
        fBody: { type: 'formattedText', value: '<p>Hi</p>', valueByLocale: {} },
        fViews: { type: 'number', value: 42 },
        fFeatured: { type: 'boolean', value: true },
        fDate: { type: 'date', value: '2026-06-18' },
        fStatus: { type: 'enum', value: 'c2' },
        fHero: { type: 'image', value: { url: 'https://x/y.png', alt: null } },
        // An empty/cleared link must validate (Framer returns "" — no strict uri format).
        fLink: { type: 'link', value: '', valueByLocale: {} },
        fAuthor: { type: 'collectionReference', value: 'author1' },
        fTags: { type: 'multiCollectionReference', value: ['tag1', 'tag2'] },
        // An unset field omits `value` entirely.
        fUnknown: { type: 'unsupported' },
      },
    };
    const errors = [...Value.Errors(spec.schema, item)];
    expect(errors).toEqual([]);
  });

  it('builds a default view with the meta columns and one column per field value', () => {
    const view = buildFramerDefaultView(spec);
    expect(view?.name).toBe('Default');
    const paths = view?.cols.map((col) => ('path' in col ? col.path : undefined));
    expect(paths).toEqual([
      'slug',
      'draft',
      'fieldData.fTitle.value',
      'fieldData.fBody.value',
      'fieldData.fViews.value',
      'fieldData.fFeatured.value',
      'fieldData.fDate.value',
      'fieldData.fStatus.value',
      'fieldData.fHero.value',
      'fieldData.fLink.value',
      'fieldData.fAuthor.value',
      'fieldData.fTags.value',
      'fieldData.fUnknown.value',
      'id',
    ]);
  });
});
