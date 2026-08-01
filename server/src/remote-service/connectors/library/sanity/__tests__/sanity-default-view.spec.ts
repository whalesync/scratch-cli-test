import { TableView, TableViewCol } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildSanityDefaultView } from '../sanity-default-view';
import { parseDeployedSchemaEnrichmentsByTypeName } from '../sanity-deployed-schema';
import { buildSanityJsonTableSpec } from '../sanity-json-schema';
import { SanityDocument } from '../sanity-types';
import { DEPLOYED_SCHEMA_DOCUMENT_FIXTURE } from './deployed-schema.fixture';

const POST_TABLE_ENTITY_ID: EntityId = { wsId: 'production_post', remoteId: ['proj123', 'production', 'post'] };

const SAMPLE_POST_DOCUMENTS: SanityDocument[] = [
  {
    _id: 'post-hello',
    _type: 'post',
    _rev: 'rev1',
    _createdAt: '2026-07-01T12:00:00Z',
    _updatedAt: '2026-07-02T12:00:00Z',
    title: 'Hello Sanity',
    slug: { _type: 'slug', current: 'hello-sanity' },
    publishedAt: '2026-07-01T12:00:00Z',
    wordCount: 342,
    featured: true,
    author: { _type: 'reference', _ref: 'author-ada' },
    // Alphabetical sub-key order, as the Content Lake really returns document keys.
    seo: { metaDescription: 'First post', metaTitle: 'Hello' },
    location: { _type: 'geopoint', lat: 51.5074, lng: -0.1278 },
    body: [
      {
        _type: 'block',
        _key: 'b1',
        style: 'normal',
        markDefs: [],
        children: [{ _type: 'span', _key: 's1', text: 'First paragraph.', marks: [] }],
      },
    ],
  },
];

function buildViewFromSampledDocuments() {
  const spec = buildSanityJsonTableSpec({
    id: POST_TABLE_ENTITY_ID,
    typeName: 'post',
    datasetName: 'production',
    sampledDocuments: SAMPLE_POST_DOCUMENTS,
    referenceFieldTargetTypeNames: new Map([['author', 'author']]),
  });
  return buildSanityDefaultView(spec);
}

function colByPath(view: ReturnType<typeof buildViewFromSampledDocuments>, path: string): TableViewCol {
  const col = view.cols.find((c): c is TableViewCol => c.kind === 'col' && c.path === path);
  if (!col) throw new Error(`No column for path ${path}`);
  return col;
}

describe('buildSanityDefaultView', () => {
  it('leads with the title field, then slug; system fields last and hidden', () => {
    const view = buildViewFromSampledDocuments();
    const paths = view.cols.filter((c): c is TableViewCol => c.kind === 'col').map((c) => c.path);
    expect(paths[0]).toBe('title');
    expect(paths[1]).toBe('slug');
    expect(paths.slice(-5)).toEqual(['_id', '_type', '_rev', '_createdAt', '_updatedAt']);
    for (const systemPath of ['_id', '_type', '_rev', '_createdAt', '_updatedAt']) {
      expect(colByPath(view, systemPath).hidden).toBe(true);
    }
    expect(colByPath(view, 'title').hidden).toBeUndefined();
  });

  it('renders Portable Text as a read-only flattened preview with richtext logical type', () => {
    const view = buildViewFromSampledDocuments();
    const bodyCol = colByPath(view, 'body');
    expect(bodyCol.type).toBe('string');
    expect(bodyCol.logicalType).toBe('richtext');
    expect(bodyCol.readonly).toBe(true);
    expect(bodyCol.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].children[*].text', arrayHandling: 'join_matches_space' },
    });
  });

  it('collapses slug and reference fields to their meaningful leaves', () => {
    const view = buildViewFromSampledDocuments();
    const slugCol = colByPath(view, 'slug');
    expect(slugCol.subfields).toEqual([{ name: 'Current', relativePath: 'current', type: 'string' }]);
    expect(slugCol.selectedSubfield).toBe(0);
    const authorCol = colByPath(view, 'author');
    expect(authorCol.subfields).toEqual([{ name: 'Ref', relativePath: '_ref', type: 'string' }]);
    expect(authorCol.selectedSubfield).toBe(0);
  });

  it('copies the resolved foreign key onto reference columns', () => {
    const view = buildViewFromSampledDocuments();
    expect(colByPath(view, 'author').foreignKey).toEqual({
      linkedTableId: 'author',
      linkedTableRemoteId: ['proj123', 'production', 'author'],
      isSingleValued: true,
    });
  });

  it('expands plain user objects into banner groups with dotted-path child columns', () => {
    const view = buildViewFromSampledDocuments();
    const seoGroup = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'Seo');
    if (!seoGroup || seoGroup.kind !== 'banner-group') throw new Error('No Seo banner group');
    // Without a deployed schema the children follow the inferred (alphabetical) key
    // order — the authored metaTitle-first order needs the deployed-schema enrichment.
    expect(seoGroup.cols.map((c) => ({ path: c.path, name: c.name }))).toEqual([
      { path: 'seo.metaDescription', name: 'Meta Description' },
      { path: 'seo.metaTitle', name: 'Meta Title' },
    ]);
    // Sanity-typed object values (carrying a `_type` marker) are NOT expanded:
    // geopoint stays a single object column, references keep their `_ref` subfield.
    expect(colByPath(view, 'location').type).toBe('object');
    expect(view.cols.find((c) => c.kind === 'banner-group' && c.name === 'Location')).toBeUndefined();
  });

  describe('with a deployed Studio schema', () => {
    function buildViewWithDeployedSchemaEnrichment(): TableView {
      const deployedTypeEnrichment = parseDeployedSchemaEnrichmentsByTypeName([DEPLOYED_SCHEMA_DOCUMENT_FIXTURE]).get(
        'post',
      );
      expect(deployedTypeEnrichment).toBeDefined();
      const spec = buildSanityJsonTableSpec({
        id: POST_TABLE_ENTITY_ID,
        typeName: 'post',
        datasetName: 'production',
        sampledDocuments: SAMPLE_POST_DOCUMENTS,
        referenceFieldTargetTypeNames: deployedTypeEnrichment?.referenceTargetTypeNamesByFieldName,
        deployedTypeEnrichment,
      });
      return buildSanityDefaultView(spec);
    }

    it('orders columns by the authored field order, beating the alphabetical sample order', () => {
      const view = buildViewWithDeployedSchemaEnrichment();
      const topLevelNamesInOrder = view.cols.map((c) => (c.kind === 'col' ? c.path : `group:${c.name}`));
      expect(topLevelNamesInOrder).toEqual([
        'title', // title field always first
        'slug', // slug always second
        'publishedAt', // …then the AUTHORED order: publishedAt, wordCount, featured, author…
        'wordCount',
        'featured',
        'author',
        'group:SEO settings',
        'body',
        'location', // sampled-only field (not in the deployed schema) follows the authored ones
        '_id', // system fields still last
        '_type',
        '_rev',
        '_createdAt',
        '_updatedAt',
      ]);
    });

    it('names columns from declared titles, falling back to humanized field names', () => {
      const view = buildViewWithDeployedSchemaEnrichment();
      expect(colByPath(view, 'title').name).toBe('Post title');
      expect(colByPath(view, 'publishedAt').name).toBe('Published at');
      expect(colByPath(view, 'featured').name).toBe('Featured?');
      expect(colByPath(view, 'wordCount').name).toBe('Word count'); // authored casing, not "Word Count"
      // No declared title for these — humanization fallback (location isn't in the
      // deployed post type at all; system fields never are).
      expect(colByPath(view, 'location').name).toBe('Location');
      expect(colByPath(view, '_updatedAt').name).toBe('Updated At');
    });

    it('orders and names seo banner-group children per the deployed schema', () => {
      const view = buildViewWithDeployedSchemaEnrichment();
      const seoGroup = view.cols.find((c) => c.kind === 'banner-group');
      if (!seoGroup || seoGroup.kind !== 'banner-group') throw new Error('No seo banner group');
      expect(seoGroup.name).toBe('SEO settings');
      // Authored order metaTitle → metaDescription (alphabetical would invert them); their
      // declared titles equal the humanization, which Sanity omits — fallback still shows them.
      expect(seoGroup.cols.map((c) => ({ path: c.path, name: c.name }))).toEqual([
        { path: 'seo.metaTitle', name: 'Meta Title' },
        { path: 'seo.metaDescription', name: 'Meta Description' },
      ]);
    });

    it('carries the FK resolved from the deployed `to:` target onto the reference column', () => {
      const view = buildViewWithDeployedSchemaEnrichment();
      expect(colByPath(view, 'author').foreignKey).toEqual({
        linkedTableId: 'author',
        linkedTableRemoteId: ['proj123', 'production', 'author'],
        isSingleValued: true,
      });
    });
  });

  it('maps inferred types and system-field annotations onto columns', () => {
    const view = buildViewFromSampledDocuments();
    expect(colByPath(view, 'wordCount').type).toBe('number');
    expect(colByPath(view, 'featured').type).toBe('checkbox');
    expect(colByPath(view, 'publishedAt').type).toBe('date');
    // Time-bearing: the export layer must create a datetime destination column, not a
    // date-only one that drops the time-of-day (Live Export audit 2026-08-01).
    expect(colByPath(view, 'publishedAt').logicalType).toBe('datetime');
    expect(colByPath(view, '_id').readonly).toBe(true);
    expect(colByPath(view, '_type').writeOnce).toBe(true);
    expect(colByPath(view, 'wordCount').name).toBe('Word Count');
    expect(colByPath(view, '_updatedAt').name).toBe('Updated At');
  });
});
