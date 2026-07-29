import { TSchema } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, type ForeignKeyOptionSchema } from '@spinner/shared-types';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { inferLogicalFieldType } from 'src/schema-builder/schema-builder-plan-generator';
import { extractSchemaFields } from 'src/utils/schema-helpers';
import { EntityId } from '../../../types';
import postsSchemaResponse from '../__fixtures__/posts-schema-response.json';
import { WORDPRESS_NO_LINK_FOREIGN_KEY_VALUE, WORDPRESS_STATIC_FOREIGN_KEY_COLUMN_IDS } from '../wordpress-constants';
import { buildWordPressDefaultView } from '../wordpress-default-view';
import { buildWordPressJsonTableSpec } from '../wordpress-json-schema';
import { buildHierarchicalParentForeignKey, buildTaxonomyForeignKeys } from '../wordpress-schema-parser';
import {
  WordPressEndpointOptionsResponse,
  WordPressGetTaxonomiesApiResponse,
  WordPressGetTypesApiResponse,
} from '../wordpress-types';

/**
 * What a WordPress table looks like to the LIVE EXPORT layer — the create-schema plan and
 * the FK-resolution step — rather than to the record validator (that's
 * `wordpress-json-schema.spec.ts`). These lock the export defects found by
 * `/test-live-export WORDPRESS NOTION,AIRTABLE,SUPABASE`:
 *
 *   DEV-11091  datetimes exported into date-ONLY destination columns (time-of-day lost)
 *   DEV-11093  `featured_media` exported as a bare number, not a link to Media
 *   DEV-11094  `parent` exported as a bare number, so the page/category hierarchy is lost
 *
 * …plus the media-type declaration on rich text, which is groundwork for DEV-11046
 * (picking a representation per field) rather than a behavior change of its own.
 *
 * Every assertion below is about the exported SCHEMA/VIEW. The record on disk stays
 * byte-for-byte what WordPress returned (Connector Prime Directive).
 */

/** WordPress's own metadata for the two collections it hands out: one flat, one hierarchical. */
const TYPES_RESPONSE: WordPressGetTypesApiResponse = {
  post: { name: 'Posts', rest_base: 'posts', slug: 'post', hierarchical: false },
  page: { name: 'Pages', rest_base: 'pages', slug: 'page', hierarchical: true },
  attachment: { name: 'Media', rest_base: 'media', slug: 'attachment', hierarchical: false },
};

const TAXONOMIES_RESPONSE: WordPressGetTaxonomiesApiResponse = {
  category: { name: 'Categories', slug: 'category', rest_base: 'categories', hierarchical: true, types: ['post'] },
  post_tag: { name: 'Tags', slug: 'post_tag', rest_base: 'tags', hierarchical: false, types: ['post'] },
};

/**
 * Build a spec the way `WordPressConnector.fetchJsonTableSpec` does — static FKs, the
 * dynamically-discovered taxonomy FKs, and the self-referential `parent` FK a hierarchical
 * collection gets. `optionsOverrides` patches the fixture's OPTIONS properties, which is how
 * a hierarchical collection (which WordPress gives a `parent` field) is modelled.
 */
function buildSpecAsConnectorWould(
  tableId: string,
  optionsOverrides: Record<string, unknown> = {},
): ReturnType<typeof buildWordPressJsonTableSpec> {
  const fixture = postsSchemaResponse as unknown as WordPressEndpointOptionsResponse;
  const optionsResponse = {
    ...fixture,
    schema: { ...fixture.schema, properties: { ...fixture.schema.properties, ...optionsOverrides } },
  } as WordPressEndpointOptionsResponse;

  const foreignKeyColumnIds = [
    ...WORDPRESS_STATIC_FOREIGN_KEY_COLUMN_IDS,
    ...buildTaxonomyForeignKeys(TAXONOMIES_RESPONSE),
    ...buildHierarchicalParentForeignKey(tableId, TYPES_RESPONSE, TAXONOMIES_RESPONSE),
  ];
  return buildWordPressJsonTableSpec(
    { wsId: tableId, remoteId: [tableId] } as EntityId,
    optionsResponse,
    foreignKeyColumnIds,
  );
}

/** WordPress's OPTIONS entry for the `parent` field on a hierarchical collection. */
const PARENT_OPTIONS_FIELD = {
  description: 'The ID for the parent of the post.',
  type: 'integer',
  context: ['view', 'edit'],
};

const POSTS_SPEC = buildSpecAsConnectorWould('posts');
const PAGES_SPEC = buildSpecAsConnectorWould('pages', { parent: PARENT_OPTIONS_FIELD });

/** The create-field type the schema-builder would give the destination field at `path`. */
function createFieldTypeFor(spec: ReturnType<typeof buildWordPressJsonTableSpec>, path: string) {
  const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: buildWordPressDefaultView(spec.schema),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  });
  const field = schemaFields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`No plan field at ${path}`);
  return inferLogicalFieldType(field, viewTypeByPath[path], 'WordPress');
}

/** The `x-scratch-foreign-key` annotation on a top-level schema property, asserting it exists. */
function foreignKeyAnnotationAt(
  spec: ReturnType<typeof buildWordPressJsonTableSpec>,
  fieldId: string,
): ForeignKeyOptionSchema {
  const properties = (spec.schema as TSchema & { properties: Record<string, TSchema> }).properties;
  const annotation = properties[fieldId]?.[X_SCRATCH_FOREIGN_KEY_OPTIONS] as ForeignKeyOptionSchema | undefined;
  if (!annotation) throw new Error(`No foreign-key annotation on "${fieldId}"`);
  return annotation;
}

describe('WordPress datetimes keep their time-of-day (DEV-11091)', () => {
  // WordPress returns "2026-07-28T20:20:00" — a wall-clock time with NO UTC offset. The
  // connector can't claim RFC 3339 `date-time` (the validator would warn on every record),
  // but dropping `format` entirely made Airtable/Supabase build date-ONLY columns that
  // silently truncated the time on every run.
  it('creates a real timestamp column for the exported publish date, not a date-only one', () => {
    // `date` is the only datetime the default View shows; `date_gmt`/`modified`/`modified_gmt`
    // are hidden columns and so never reach the plan. They still carry the annotation below,
    // so un-hiding one exports it correctly too.
    expect(createFieldTypeFor(POSTS_SPEC, 'date')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'date', includesTime: true },
    });
  });

  it.each(['date', 'date_gmt', 'modified', 'modified_gmt'])(
    'annotates %s with a time-bearing format that asserts nothing',
    (path) => {
      const fieldsByPath = new Map(extractSchemaFields(POSTS_SPEC.schema).map((field) => [field.path, field]));
      // NOT 'date-time': WordPress's offset-less value would fail that keyword on every record.
      expect(fieldsByPath.get(path)?.format).toBe('date-time-local');
    },
  );

  it('leaves a non-date string with no format at all', () => {
    const fieldsByPath = new Map(extractSchemaFields(POSTS_SPEC.schema).map((field) => [field.path, field]));
    // `link` is declared `format: 'uri'` by WordPress but can hold unencoded Unicode, so the
    // connector still drops it — only datetimes get a format.
    expect(fieldsByPath.get('link')?.format).toBeUndefined();
    expect(fieldsByPath.get('slug')?.format).toBeUndefined();
  });
});

describe('featured_media links to the Media table (DEV-11093)', () => {
  it('is a foreign key to media, not a number', () => {
    expect(foreignKeyAnnotationAt(POSTS_SPEC, 'featured_media')).toEqual({
      linkedTableId: 'media',
      linkedTableRemoteId: ['media'],
      isSingleValued: true,
      valuesMeaningNoLink: [WORDPRESS_NO_LINK_FOREIGN_KEY_VALUE],
    });
  });

  it('reaches the plan generator as a foreign key', () => {
    const featuredMedia = extractSchemaFields(POSTS_SPEC.schema).find((field) => field.path === 'featured_media');
    expect(featuredMedia?.foreignKey?.linkedTableId).toBe('media');
  });
});

describe('parent is a self-referential link on hierarchical collections (DEV-11094)', () => {
  it('points a hierarchical post type back at its own table', () => {
    expect(foreignKeyAnnotationAt(PAGES_SPEC, 'parent')).toEqual({
      linkedTableId: 'pages',
      linkedTableRemoteId: ['pages'],
      isSingleValued: true,
      valuesMeaningNoLink: [WORDPRESS_NO_LINK_FOREIGN_KEY_VALUE],
    });
  });

  it.each([
    ['a hierarchical post type', 'pages'],
    ['a hierarchical taxonomy', 'categories'],
  ])('declares the parent FK for %s', (_label, tableId) => {
    expect(buildHierarchicalParentForeignKey(tableId, TYPES_RESPONSE, TAXONOMIES_RESPONSE)).toEqual([
      { remoteColumnId: 'parent', foreignKeyRemoteTableId: tableId },
    ]);
  });

  it.each([
    ['a flat post type', 'posts'],
    ['a flat taxonomy', 'tags'],
    ['an unknown collection', 'some_plugin_thing'],
  ])('declares nothing for %s', (_label, tableId) => {
    expect(buildHierarchicalParentForeignKey(tableId, TYPES_RESPONSE, TAXONOMIES_RESPONSE)).toEqual([]);
  });
});

describe('foreign-key cardinality follows the shape WordPress declares', () => {
  it.each([
    ['author', true],
    ['featured_media', true],
    ['categories', false],
    ['tags', false],
  ])('marks %s isSingleValued=%s', (fieldId, expected) => {
    expect(foreignKeyAnnotationAt(POSTS_SPEC, fieldId).isSingleValued).toBe(expected);
  });
});

describe('rich text declares that it is markup (groundwork for DEV-11046)', () => {
  function rawSubfieldSchema(fieldId: string): TSchema {
    const properties = (POSTS_SPEC.schema as TSchema & { properties: Record<string, TSchema> }).properties;
    const rendered = properties[fieldId] as TSchema & { properties: Record<string, TSchema> };
    return rendered.properties.raw;
  }

  it.each(['content', 'excerpt'])('declares text/html on the exported raw half of %s', (fieldId) => {
    // `raw` is the half the default View selects, so it is the half that gets exported —
    // yet only `rendered` used to say it held HTML.
    expect(rawSubfieldSchema(fieldId).contentMediaType).toBe('text/html');
  });

  it('leaves the inline title alone — its raw half is a plain string, not a document', () => {
    expect(rawSubfieldSchema('title').contentMediaType).toBeUndefined();
  });

  it('still exports the value verbatim, as a long-text column', () => {
    expect(createFieldTypeFor(POSTS_SPEC, 'content.raw')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'longText' },
    });
  });
});
