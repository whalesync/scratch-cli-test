import { parseDeployedSchemaEnrichmentsByTypeName } from '../sanity-deployed-schema';
import { SanityDeployedSchemaDocument } from '../sanity-types';
import { DEPLOYED_SCHEMA_DOCUMENT_FIXTURE } from './deployed-schema.fixture';

describe('parseDeployedSchemaEnrichmentsByTypeName', () => {
  it('parses every document type out of the JSON-string schema payload', () => {
    const enrichments = parseDeployedSchemaEnrichmentsByTypeName([DEPLOYED_SCHEMA_DOCUMENT_FIXTURE]);
    expect([...enrichments.keys()].sort()).toEqual(['author', 'category', 'post']);
  });

  it('captures the authored (non-alphabetical) field order per type', () => {
    const enrichments = parseDeployedSchemaEnrichmentsByTypeName([DEPLOYED_SCHEMA_DOCUMENT_FIXTURE]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(enrichments.get('author')!.orderedFieldNames).toEqual([
      'name',
      'role',
      'active',
      'joinedAt',
      'email',
      'website',
      'slug',
      'address',
      'location',
    ]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(enrichments.get('post')!.orderedFieldNames).toEqual([
      'title',
      'slug',
      'publishedAt',
      'wordCount',
      'rating',
      'featured',
      'tags',
      'author',
      'categories',
      'relatedContent',
      'seo',
      'body',
    ]);
  });

  it('captures declared titles and tolerates Sanity omitting default-humanization titles', () => {
    const enrichments = parseDeployedSchemaEnrichmentsByTypeName([DEPLOYED_SCHEMA_DOCUMENT_FIXTURE]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const authorTitles = enrichments.get('author')!.fieldTitlesByName;
    expect(authorTitles.get('name')).toBe('Full name');
    expect(authorTitles.get('active')).toBe('Currently active');
    // "Role" equals the default humanization of `role` — Sanity omitted it from the payload.
    expect(authorTitles.has('role')).toBe(false);
  });

  it('resolves single-target reference fields (direct and array-member); multi-target stays out', () => {
    const enrichments = parseDeployedSchemaEnrichmentsByTypeName([DEPLOYED_SCHEMA_DOCUMENT_FIXTURE]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const postReferenceTargets = enrichments.get('post')!.referenceTargetTypeNamesByFieldName;
    expect(postReferenceTargets.get('author')).toBe('author');
    expect(postReferenceTargets.get('categories')).toBe('category');
    expect(postReferenceTargets.has('relatedContent')).toBe(false); // to: [author, category]
    expect(postReferenceTargets.has('tags')).toBe(false); // array of strings, not references
  });

  it('captures nested-object sub-field order and titles', () => {
    const enrichments = parseDeployedSchemaEnrichmentsByTypeName([DEPLOYED_SCHEMA_DOCUMENT_FIXTURE]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const seoEnrichment = enrichments.get('post')!.objectFieldEnrichmentsByFieldName.get('seo');
    expect(seoEnrichment?.orderedSubFieldNames).toEqual(['metaTitle', 'metaDescription']);
    expect(seoEnrichment?.subFieldTitlesByName.size).toBe(0); // both titles equal the humanization → omitted
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const addressEnrichment = enrichments.get('author')!.objectFieldEnrichmentsByFieldName.get('address');
    expect(addressEnrichment?.orderedSubFieldNames).toEqual(['street', 'city']);
  });

  it('prefers the default workspace and lets the first declaring workspace win', () => {
    const otherWorkspaceDocument: SanityDeployedSchemaDocument = {
      _id: '_.schemas.aaa-other',
      _type: 'system.schema',
      workspace: { name: 'aaa-other' },
      schema: JSON.stringify([
        { name: 'post', type: 'document', fields: [{ name: 'onlyInOtherWorkspace', type: 'string' }] },
        { name: 'extraType', type: 'document', fields: [{ name: 'x', type: 'string' }] },
      ]),
    };
    // The other workspace sorts first by _id, but `default` still wins for shared types.
    const enrichments = parseDeployedSchemaEnrichmentsByTypeName([
      otherWorkspaceDocument,
      DEPLOYED_SCHEMA_DOCUMENT_FIXTURE,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(enrichments.get('post')!.orderedFieldNames[0]).toBe('title');
    // Types only the other workspace declares still contribute.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(enrichments.get('extraType')!.orderedFieldNames).toEqual(['x']);
  });

  it('tolerates already-parsed array payloads, and skips malformed payloads without throwing', () => {
    const alreadyParsedPayloadDocument: SanityDeployedSchemaDocument = {
      _id: '_.schemas.default',
      _type: 'system.schema',
      workspace: { name: 'default' },
      schema: [{ name: 'note', type: 'document', fields: [{ name: 'text', type: 'string' }] }],
    };
    expect(parseDeployedSchemaEnrichmentsByTypeName([alreadyParsedPayloadDocument]).get('note')).toBeDefined();

    const malformedDocuments: SanityDeployedSchemaDocument[] = [
      { _id: '_.schemas.a', _type: 'system.schema', schema: 'not json {{' },
      { _id: '_.schemas.b', _type: 'system.schema', schema: '{"an":"object, not an array"}' },
      { _id: '_.schemas.c', _type: 'system.schema' }, // no schema payload at all
    ];
    expect(parseDeployedSchemaEnrichmentsByTypeName(malformedDocuments).size).toBe(0);
    expect(parseDeployedSchemaEnrichmentsByTypeName([]).size).toBe(0);
  });
});
