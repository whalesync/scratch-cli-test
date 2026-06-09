import { TObject } from '@sinclair/typebox';
import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { buildWebflowJsonTableSpec } from '../webflow-json-schema';
import { Collection, FieldType, Site } from '../webflow-types';

const site = { id: 'site-1', displayName: 'My Site', shortName: 'mysite' } as Site;
const collection = {
  id: 'col-1',
  displayName: 'Blog Posts',
  slug: 'blog-posts',
  fields: [{ id: 'f1', type: FieldType.PlainText, slug: 'name', displayName: 'Name', isRequired: true }],
} as Collection;

const spec = buildWebflowJsonTableSpec({ wsId: 'col-1ws', remoteId: ['site-1', 'col-1'] }, site, collection);
const props = (spec.schema as TObject).properties as Record<string, Record<string, unknown>>;

describe('buildWebflowJsonTableSpec — incremental last-modified annotation', () => {
  it('annotates the item `lastUpdated` field as the last-modified field (incremental filters on it)', () => {
    expect(props.lastUpdated[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
  });

  it('does NOT annotate `createdOn` or `lastPublished` (only the modified-at field is the watermark source)', () => {
    expect(props.createdOn[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
    expect(props.lastPublished[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });
});
