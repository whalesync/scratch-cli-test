import { FormatRegistry, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT } from '@spinner/shared-types';
import postsSchemaResponse from '../__fixtures__/posts-schema-response.json';
import { buildWordPressDefaultView } from '../wordpress-default-view';
import { buildWordPressJsonTableSpec } from '../wordpress-json-schema';
import { WordPressEndpointOptionsResponse } from '../wordpress-types';

/**
 * These tests assert that the generated schema accepts the VERBATIM shapes
 * WordPress actually returns — so the CLI `enforce_schema` validator stops
 * emitting false-positive type errors — while still rejecting genuinely wrong
 * data.
 *
 * Caveats vs. the Rust validator: TypeBox `Value` treats an unregistered `format`
 * as a failure ("Unknown format"), so we register the formats WordPress uses as
 * permissive (always-pass) — real RFC-3339/URI semantics are enforced by the Rust
 * crate, not here. That list includes `date-time-local`, which the schema now puts on
 * WordPress's offset-less datetimes: always-pass is exactly how the Rust crate treats
 * a `format` it doesn't recognize, which is the whole point of the token and is locked
 * by `local_date_time_format_asserts_nothing` in `scratch-git-2`'s `builtin.rs`.
 * The Rust validator also skips `required` and empty strings, whereas `Value` enforces
 * `required`; the passing records below therefore supply every nested-required field.
 */
for (const format of ['date-time', 'uri', 'email', JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT]) {
  if (!FormatRegistry.Has(format)) {
    FormatRegistry.Set(format, () => true);
  }
}

function buildPostsSpec() {
  return buildWordPressJsonTableSpec(
    { wsId: 'posts', remoteId: ['posts'] },
    postsSchemaResponse as unknown as WordPressEndpointOptionsResponse,
    [],
  );
}

const POSTS_SPEC = buildPostsSpec();

/** Validate a record against the generated post schema; return readable error rows. */
function schemaErrorsFor(record: unknown): { path: string; message: string }[] {
  return [...Value.Errors(POSTS_SPEC.schema, record)].map((error) => ({ path: error.path, message: error.message }));
}

/** All ACF fields from the fixture, set to `null` (the verbatim "unset" shape). */
const ALL_ACF_FIELDS_NULL = {
  hero_image_field: null,
  image_field: null,
  number_field: null,
  taxonomy_field: null,
  post_field: null,
  range_field: null,
  file_field: null,
  oembed_field: null,
  relationship_field: null,
  user_field: null,
  text_field: null,
};

/**
 * A minimal-but-VERBATIM post record using only fixture fields. Rendered objects
 * supply raw+rendered; `meta` supplies the fixture's required sub-fields; dates use
 * WordPress's offset-less local-time format.
 */
function postRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    title: { raw: 'Hello', rendered: 'Hello' },
    content: { raw: 'Body', rendered: '<p>Body</p>', protected: false },
    excerpt: { raw: '', rendered: '', protected: false },
    date: '2026-05-07T04:49:29',
    date_gmt: '2026-05-07T04:49:29',
    modified: '2026-05-07T04:49:29',
    modified_gmt: '2026-05-07T04:49:29',
    status: 'publish',
    author: 1,
    featured_media: 0,
    categories: [3, 4],
    tags: [],
    meta: { _acf_changed: false, nf_dc_page: '', footnotes: '' },
    acf: { ...ALL_ACF_FIELDS_NULL },
    ...overrides,
  };
}

describe('buildWordPressJsonTableSpec — verbatim WordPress data validates (no false positives)', () => {
  it('accepts a fully-populated record with null ACF fields and offset-less dates', () => {
    expect(schemaErrorsFor(postRecord())).toEqual([]);
  });

  it('accepts acf: [] (PHP empty-associative-array quirk)', () => {
    expect(schemaErrorsFor(postRecord({ acf: [] }))).toEqual([]);
  });

  it('accepts meta: [] (PHP empty-associative-array quirk)', () => {
    expect(schemaErrorsFor(postRecord({ meta: [] }))).toEqual([]);
  });

  it('accepts null date / date_gmt (declared ["string","null"])', () => {
    expect(schemaErrorsFor(postRecord({ date: null, date_gmt: null }))).toEqual([]);
  });

  it('accepts an array value for a ["integer","array","null"] ACF field', () => {
    expect(schemaErrorsFor(postRecord({ acf: { ...ALL_ACF_FIELDS_NULL, taxonomy_field: [5, 6] } }))).toEqual([]);
  });

  it('accepts a scalar integer for a ["integer","array","null"] ACF field', () => {
    expect(schemaErrorsFor(postRecord({ acf: { ...ALL_ACF_FIELDS_NULL, post_field: 9 } }))).toEqual([]);
  });

  it('accepts "" for an ACF number field (ACF\'s empty-value sentinel, e.g. price/rating)', () => {
    expect(schemaErrorsFor(postRecord({ acf: { ...ALL_ACF_FIELDS_NULL, number_field: '' } }))).toEqual([]);
  });

  it('accepts a status value outside the declared enum (e.g. media "inherit")', () => {
    expect(schemaErrorsFor(postRecord({ status: 'inherit' }))).toEqual([]);
  });

  it('accepts null for a field WordPress declares non-nullable (author / media post)', () => {
    expect(schemaErrorsFor(postRecord({ author: null }))).toEqual([]);
  });

  it('accepts a non-RFC-3986 URI (unencoded Unicode) for a uri field — string formats are dropped', () => {
    expect(schemaErrorsFor(postRecord({ link: 'https://site.test/wp/файл-🎨-日本語.png' }))).toEqual([]);
  });
});

describe('buildWordPressJsonTableSpec — validation stays meaningful', () => {
  it('rejects a string where a non-null integer is expected (author)', () => {
    expect(schemaErrorsFor(postRecord({ author: 'not-a-number' })).length).toBeGreaterThan(0);
  });

  it('rejects a non-empty array in an object-typed field (meta) — only [] is tolerated', () => {
    expect(schemaErrorsFor(postRecord({ meta: [1, 2] })).length).toBeGreaterThan(0);
  });
});

describe('buildWordPressJsonTableSpec — schema shape', () => {
  function topLevelProperty(fieldId: string): TSchema {
    const properties = (POSTS_SPEC.schema as TSchema & { properties: Record<string, TSchema> }).properties;
    return properties[fieldId];
  }

  it('does not emit format:date-time on date fields (WordPress dates are offset-less local time)', () => {
    const dateMembers = (topLevelProperty('date') as TSchema & { anyOf?: Array<{ format?: string }> }).anyOf ?? [];
    expect(dateMembers.some((member) => member.format === 'date-time')).toBe(false);
  });

  it('emits status as a nullable string, not a strict enum (declared values are not exhaustive)', () => {
    const statusMembers = (topLevelProperty('status') as TSchema & { anyOf?: Array<{ type?: string; const?: string }> })
      .anyOf;
    expect(statusMembers).toBeDefined();
    expect(statusMembers?.every((member) => member.const === undefined)).toBe(true);
    expect(statusMembers?.some((member) => member.type === 'string')).toBe(true);
  });

  it('still expands ACF sub-field columns in the default view (union unwrap)', () => {
    // Schema-gen no longer sets `spec.defaultView`; the view is now generated on
    // demand from the spec's schema (via WordPressConnector.buildDefaultView).
    const cols = buildWordPressDefaultView(POSTS_SPEC.schema).cols;
    const paths = cols.flatMap((col) => ('path' in col && typeof col.path === 'string' ? [col.path] : []));
    expect(paths).toContain('acf.image_field');
    expect(paths).toContain('acf.taxonomy_field');
    expect(paths).toContain('acf.text_field');
  });
});
