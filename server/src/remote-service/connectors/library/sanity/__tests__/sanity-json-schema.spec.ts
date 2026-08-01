import { TObject } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { flattenChangedFieldsToSanityAttributePaths } from '../sanity-connector';
import { parseDeployedSchemaEnrichmentsByTypeName } from '../sanity-deployed-schema';
import { buildSanityJsonTableSpec, collectReferenceFieldSampleRefIds } from '../sanity-json-schema';
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
    wordCount: 342,
    featured: true,
    author: { _type: 'reference', _ref: 'author-ada' },
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
  {
    _id: 'post-second',
    _type: 'post',
    _rev: 'rev2',
    _createdAt: '2026-07-03T12:00:00Z',
    _updatedAt: '2026-07-04T12:00:00Z',
    title: 'Second Post',
    slug: { _type: 'slug', current: 'second-post' },
    wordCount: 120,
    featured: false,
  },
];

describe('buildSanityJsonTableSpec', () => {
  it('builds a spec with inferred user fields and annotated system fields', () => {
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: SAMPLE_POST_DOCUMENTS,
    });

    expect(spec.idPath).toBe('_id');
    expect(spec.titlePath).toBe('title');
    expect(spec.slugPath).toBe('slug.current');
    expect(spec.basePath).toEqual(['production']);
    expect(spec.name).toBe('post');

    const schemaProperties = (spec.schema as TObject).properties;
    expect(Object.keys(schemaProperties)).toEqual(
      expect.arrayContaining(['_id', '_type', '_rev', '_createdAt', '_updatedAt', 'title', 'slug', 'wordCount']),
    );

    expect(schemaProperties['_id'][X_SCRATCH_READONLY]).toBe(true);
    expect(schemaProperties['_rev'][X_SCRATCH_READONLY]).toBe(true);
    expect(schemaProperties['_createdAt'][X_SCRATCH_READONLY]).toBe(true);
    expect(schemaProperties['_updatedAt'][X_SCRATCH_READONLY]).toBe(true);
    expect(schemaProperties['_updatedAt'][X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
    expect(schemaProperties['_type'][X_SCRATCH_WRITE_ONCE]).toBe(true);
    expect(schemaProperties['_type'][X_SCRATCH_READONLY]).toBeUndefined();
    expect(schemaProperties['title'][X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('annotates Portable Text fields with the native type and suggested transformer', () => {
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: SAMPLE_POST_DOCUMENTS,
    });
    const schemaProperties = (spec.schema as TObject).properties;
    expect(schemaProperties['body'][X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('portableText');
    expect(schemaProperties['body'][X_SCRATCH_SUGGESTED_TRANSFORMER]).toEqual({ type: 'portable_text_to_html' });
    // Arrays that are NOT arrays-of-blocks (e.g. reference arrays) stay unannotated.
    expect(schemaProperties['slug'][X_SCRATCH_SUGGESTED_TRANSFORMER]).toBeUndefined();
  });

  it('detects Portable Text whose members mix blocks with custom object types (code, image)', () => {
    const documentsWithMixedMemberBody: SanityDocument[] = [
      {
        _id: 'post-mixed',
        _type: 'post',
        body: [
          {
            _type: 'block',
            _key: 'b1',
            style: 'normal',
            markDefs: [],
            children: [{ _type: 'span', _key: 's1', text: 'Intro.', marks: [] }],
          },
          { _type: 'code', _key: 'cb', language: 'javascript', code: 'const x = 1;' },
          { _type: 'image', _key: 'img', asset: { _type: 'reference', _ref: 'image-abc-100x100-png' } },
        ],
      },
      // A document whose body was cleared to [] must not defeat detection.
      { _id: 'post-cleared', _type: 'post', body: [] },
    ];
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: documentsWithMixedMemberBody,
    });
    const schemaProperties = (spec.schema as TObject).properties;
    expect(schemaProperties['body'][X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('portableText');
    expect(schemaProperties['body'][X_SCRATCH_SUGGESTED_TRANSFORMER]).toEqual({ type: 'portable_text_to_html' });
  });

  it('annotates bare calendar-date sampled values as `date` (distinct from `datetime`)', () => {
    const documentsWithDateOnlyField: SanityDocument[] = [
      { _id: 'post-a', _type: 'post', eventDate: '2026-06-15', publishedAt: '2026-06-15T12:34:56.789Z' },
      { _id: 'post-b', _type: 'post', eventDate: '2026-07-01' },
    ];
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: documentsWithDateOnlyField,
    });
    const schemaProperties = (spec.schema as TObject).properties;
    expect(schemaProperties['eventDate'][X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('date');
    expect(schemaProperties['publishedAt'][X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('datetime');
  });

  it('does NOT annotate an array of references (typed objects but no block members) as Portable Text', () => {
    const documentsWithReferenceArray: SanityDocument[] = [
      {
        _id: 'post-refs',
        _type: 'post',
        related: [
          { _type: 'reference', _ref: 'post-hello', _key: 'r1' },
          { _type: 'reference', _ref: 'post-second', _key: 'r2' },
        ],
      },
    ];
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: documentsWithReferenceArray,
    });
    const schemaProperties = (spec.schema as TObject).properties;
    expect(schemaProperties['related'][X_SCRATCH_CONNECTOR_DATA_TYPE]).toBeUndefined();
  });

  it('only requires the service-guaranteed system fields, never sampled user fields', () => {
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: SAMPLE_POST_DOCUMENTS,
    });
    // `title` appears on every sampled document, but the store is schemaless — the next
    // document may legally omit it, so it must not be declared required.
    expect((spec.schema as TObject).required ?? []).toEqual(expect.arrayContaining(['_id', '_type']));
    expect((spec.schema as TObject).required ?? []).not.toContain('title');
  });

  it('still produces the system fields for a type with no documents to sample', () => {
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: [],
    });
    const schemaProperties = (spec.schema as TObject).properties;
    expect(Object.keys(schemaProperties)).toEqual(
      expect.arrayContaining(['_id', '_type', '_rev', '_createdAt', '_updatedAt']),
    );
    expect(spec.titlePath).toBeUndefined();
    expect(spec.slugPath).toBeUndefined();
  });
});

describe('reference field detection and FK annotation', () => {
  const POST_WITH_REFS: SanityDocument[] = [
    {
      _id: 'post-1',
      _type: 'post',
      author: { _type: 'reference', _ref: 'author-ada' },
      categories: [
        { _type: 'reference', _ref: 'category-tech', _key: 'k1' },
        { _type: 'reference', _ref: 'category-history', _key: 'k2' },
      ],
    },
  ];

  it('collects sample ref ids per field with single-vs-multi cardinality', () => {
    const collected = collectReferenceFieldSampleRefIds(POST_WITH_REFS);
    expect(collected.get('author')).toEqual({ sampleRefIds: ['author-ada'], isSingleValued: true });
    expect(collected.get('categories')).toEqual({
      sampleRefIds: ['category-tech', 'category-history'],
      isSingleValued: false,
    });
    expect(collected.has('slug')).toBe(false);
  });

  it('annotates the _ref leaf with resolved FK targets, for single and array references', () => {
    const spec = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: POST_WITH_REFS,
      referenceFieldTargetTypeNames: new Map([
        ['author', 'author'],
        ['categories', 'category'],
      ]),
    });
    const schemaProperties = (spec.schema as TObject).properties;

    const authorRefLeaf = (schemaProperties['author'].properties as Record<string, unknown>)['_ref'] as Record<
      string,
      unknown
    >;
    expect(authorRefLeaf['x-scratch-foreign-key']).toEqual({
      linkedTableId: 'author',
      linkedTableRemoteId: ['proj123', 'production', 'author'],
      isSingleValued: true,
    });

    const categoriesMemberRefLeaf = (
      (schemaProperties['categories'].items as Record<string, unknown>).properties as Record<string, unknown>
    )['_ref'] as Record<string, unknown>;
    expect(categoriesMemberRefLeaf['x-scratch-foreign-key']).toEqual({
      linkedTableId: 'category',
      linkedTableRemoteId: ['proj123', 'production', 'category'],
      isSingleValued: false,
    });
  });
});

describe('deployed-schema enrichment of the table schema', () => {
  // The Content Lake returns document keys alphabetically, so the sampled documents
  // present the fields in alphabetical order — the order inference alone would keep.
  const SAMPLED_POST_WITH_ALPHABETICAL_KEYS: SanityDocument[] = [
    {
      _id: 'post-1',
      _type: 'post',
      author: { _type: 'reference', _ref: 'author-ada' },
      categories: [{ _type: 'reference', _ref: 'category-tech', _key: 'k1' }],
      featured: true,
      // A legacy field old documents carry but the deployed schema no longer declares.
      legacySubtitle: 'An old subtitle',
      publishedAt: '2026-07-01T12:00:00Z',
      rating: 4.5,
      seo: { metaDescription: 'desc', metaTitle: 'Hello' },
      slug: { _type: 'slug', current: 'post-1' },
      title: 'Hello',
      wordCount: 342,
    },
  ];

  function buildEnrichedPostSpec() {
    const deployedTypeEnrichment = parseDeployedSchemaEnrichmentsByTypeName([DEPLOYED_SCHEMA_DOCUMENT_FIXTURE]).get(
      'post',
    );
    expect(deployedTypeEnrichment).toBeDefined();
    return buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: SAMPLED_POST_WITH_ALPHABETICAL_KEYS,
      // What the connector passes: deployed `to:` targets, no sampling lookup needed.
      referenceFieldTargetTypeNames: deployedTypeEnrichment?.referenceTargetTypeNamesByFieldName,
      deployedTypeEnrichment,
    });
  }

  it('orders properties by the authored field order, with legacy and system fields kept after', () => {
    const spec = buildEnrichedPostSpec();
    const propertyNames = Object.keys((spec.schema as TObject).properties);
    // Authored order first (only fields that actually exist in the inferred schema)…
    expect(propertyNames.slice(0, 9)).toEqual([
      'title',
      'slug',
      'publishedAt',
      'wordCount',
      'rating',
      'featured',
      'author',
      'categories',
      'seo',
    ]);
    // …then everything the deployed schema doesn't mention, still present: the legacy
    // inferred-only field and the system fields never disappear.
    expect(propertyNames).toContain('legacySubtitle');
    expect(propertyNames).toEqual(expect.arrayContaining(['_id', '_type', '_rev', '_createdAt', '_updatedAt']));
    expect(propertyNames.indexOf('legacySubtitle')).toBeGreaterThan(propertyNames.indexOf('seo'));
  });

  it('stamps declared titles as the non-enforced `title` keyword; untitled fields stay bare', () => {
    const spec = buildEnrichedPostSpec();
    const schemaProperties = (spec.schema as TObject).properties;
    expect(schemaProperties['title'].title).toBe('Post title');
    expect(schemaProperties['publishedAt'].title).toBe('Published at');
    expect(schemaProperties['seo'].title).toBe('SEO settings');
    // Sanity omitted these titles (default humanization) — no keyword stamped.
    expect(schemaProperties['rating'].title).toBeUndefined();
    expect(schemaProperties['legacySubtitle'].title).toBeUndefined();
    // Enrichment must not tighten validation: required stays the system-fields-only set.
    expect((spec.schema as TObject).required ?? []).toEqual(expect.arrayContaining(['_id', '_type']));
    expect((spec.schema as TObject).required ?? []).not.toContain('title');
  });

  it('orders nested-object sub-properties by the authored order (seo: metaTitle before metaDescription)', () => {
    const spec = buildEnrichedPostSpec();
    const seoSubProperties = (spec.schema as TObject).properties['seo'].properties as Record<string, unknown>;
    expect(Object.keys(seoSubProperties)).toEqual(['metaTitle', 'metaDescription']);
  });

  it('annotates FKs from the deployed `to:` targets without any sampling lookup', () => {
    const spec = buildEnrichedPostSpec();
    const schemaProperties = (spec.schema as TObject).properties;
    const authorRefLeaf = (schemaProperties['author'].properties as Record<string, unknown>)['_ref'] as Record<
      string,
      unknown
    >;
    expect(authorRefLeaf['x-scratch-foreign-key']).toEqual({
      linkedTableId: 'author',
      linkedTableRemoteId: ['proj123', 'production', 'author'],
      isSingleValued: true,
    });
    const categoriesMemberRefLeaf = (
      (schemaProperties['categories'].items as Record<string, unknown>).properties as Record<string, unknown>
    )['_ref'] as Record<string, unknown>;
    expect(categoriesMemberRefLeaf['x-scratch-foreign-key']).toEqual({
      linkedTableId: 'category',
      linkedTableRemoteId: ['proj123', 'production', 'category'],
      isSingleValued: false,
    });
  });

  it('changes nothing when no deployed schema exists (inference-only baseline)', () => {
    const specWithoutEnrichment = buildSanityJsonTableSpec({
      id: POST_TABLE_ENTITY_ID,
      typeName: 'post',
      datasetName: 'production',
      sampledDocuments: SAMPLED_POST_WITH_ALPHABETICAL_KEYS,
    });
    const schemaProperties = (specWithoutEnrichment.schema as TObject).properties;
    // Sampled (alphabetical) key order is preserved, and no title keywords appear.
    expect(Object.keys(schemaProperties).filter((name) => !name.startsWith('_'))).toEqual([
      'author',
      'categories',
      'featured',
      'legacySubtitle',
      'publishedAt',
      'rating',
      'seo',
      'slug',
      'title',
      'wordCount',
    ]);
    for (const fieldSchema of Object.values(schemaProperties)) {
      expect(fieldSchema.title).toBeUndefined();
    }
  });
});

describe('flattenChangedFieldsToSanityAttributePaths', () => {
  it('flattens nested plain objects into dot attribute paths', () => {
    expect(
      flattenChangedFieldsToSanityAttributePaths({
        title: 'New title',
        slug: { current: 'new-title' },
        seo: { meta: { description: 'x' } },
      }),
    ).toEqual({
      title: 'New title',
      'slug.current': 'new-title',
      'seo.meta.description': 'x',
    });
  });

  it('sets arrays and null wholesale instead of recursing into them', () => {
    expect(
      flattenChangedFieldsToSanityAttributePaths({
        categories: [{ _type: 'reference', _ref: 'category-tech', _key: 'k1' }],
        subtitle: null,
      }),
    ).toEqual({
      categories: [{ _type: 'reference', _ref: 'category-tech', _key: 'k1' }],
      subtitle: null,
    });
  });

  it('sets a parent object wholesale when a nested key cannot be a patch path segment', () => {
    expect(flattenChangedFieldsToSanityAttributePaths({ extras: { 'weird key!': 1 } })).toEqual({
      extras: { 'weird key!': 1 },
    });
  });

  it('wholesale-sets the FULL subtree (not the sparse diff) when unsafe keys stop recursion, so siblings survive', () => {
    // The adversarial-review scenario (2026-08-01): a sparse diff touching only
    // `address["zip-code"]` must not wipe the untouched street/city siblings.
    const fullRecordContent = {
      _id: 'author-x',
      address: { street: '12 Test Way', city: 'Testville', 'zip-code': '90210' },
    };
    expect(flattenChangedFieldsToSanityAttributePaths({ address: { 'zip-code': '90210' } }, fullRecordContent)).toEqual(
      {
        address: { street: '12 Test Way', city: 'Testville', 'zip-code': '90210' },
      },
    );
  });

  it('still recurses into safe-keyed objects (per-leaf paths) when the full record is provided', () => {
    const fullRecordContent = { _id: 'a', seo: { metaTitle: 'New', metaDescription: 'Old desc' } };
    expect(flattenChangedFieldsToSanityAttributePaths({ seo: { metaTitle: 'New' } }, fullRecordContent)).toEqual({
      'seo.metaTitle': 'New',
    });
  });
});
