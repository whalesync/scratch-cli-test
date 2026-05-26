import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { findLastModifiedFieldName } from '../../../types';
import postsSchemaResponse from '../__fixtures__/posts-schema-response.json';
import { buildWordPressJsonTableSpec } from '../wordpress-json-schema';
import { WordPressEndpointOptionsResponse } from '../wordpress-types';

/**
 * A taxonomy collection (category/tag/term) — no `modified` column, so it must
 * NOT be annotated and `findLastModifiedFieldName` must resolve to undefined
 * (the connector then reports no incremental support and the job demotes the
 * folder to a full scan).
 */
const TAXONOMY_OPTIONS = {
  schema: {
    properties: {
      id: { type: 'integer' },
      count: { type: 'integer' },
      description: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string' },
      taxonomy: { type: 'string' },
    },
  },
} as unknown as WordPressEndpointOptionsResponse;

describe('buildWordPressJsonTableSpec last-modified annotation', () => {
  function props(spec: { schema: unknown }): Record<string, Record<string, unknown>> {
    return (spec.schema as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it('annotates `modified` with x-scratch-last-modified-field=true on a post-type collection', () => {
    const spec = buildWordPressJsonTableSpec(
      { wsId: 'posts', remoteId: ['posts'] },
      postsSchemaResponse as unknown as WordPressEndpointOptionsResponse,
      [],
    );
    expect(props(spec).modified[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
    expect(findLastModifiedFieldName(spec)).toBe('modified');
  });

  it('does not annotate `modified_gmt` (we filter on `modified` and let WordPress map it)', () => {
    const spec = buildWordPressJsonTableSpec(
      { wsId: 'posts', remoteId: ['posts'] },
      postsSchemaResponse as unknown as WordPressEndpointOptionsResponse,
      [],
    );
    expect(props(spec).modified_gmt?.[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it('does not annotate anything on a taxonomy collection (no `modified` column)', () => {
    const spec = buildWordPressJsonTableSpec({ wsId: 'categories', remoteId: ['categories'] }, TAXONOMY_OPTIONS, []);
    expect(props(spec).modified).toBeUndefined();
    expect(findLastModifiedFieldName(spec)).toBeUndefined();
  });

  it('tags rendered subfields on rendered-object columns with contentMediaType: text/html', () => {
    const spec = buildWordPressJsonTableSpec(
      { wsId: 'posts', remoteId: ['posts'] },
      postsSchemaResponse as unknown as WordPressEndpointOptionsResponse,
      [],
    );
    const content = props(spec).content as unknown as { properties: { rendered: { contentMediaType?: string } } };
    expect(content.properties.rendered.contentMediaType).toBe('text/html');
  });
});
