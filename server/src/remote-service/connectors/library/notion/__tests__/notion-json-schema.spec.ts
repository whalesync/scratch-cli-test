import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { NotionDataSourceObjectResponse } from '../notion-data-source-types';
import { buildNotionJsonTableSpec } from '../notion-json-schema';

function buildDataSource(): NotionDataSourceObjectResponse {
  return {
    object: 'data_source',
    id: 'ds_123',
    title: [{ plain_text: 'My DB' }],
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title' },
    },
  } as unknown as NotionDataSourceObjectResponse;
}

describe('buildNotionJsonTableSpec last-modified annotation', () => {
  function topLevelProps(): Record<string, Record<string, unknown>> {
    const spec = buildNotionJsonTableSpec({ wsId: 'db', remoteId: ['db_123', 'ds_123'] }, buildDataSource());
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it('annotates the top-level last_edited_time with x-scratch-last-modified-field=true', () => {
    expect(topLevelProps().last_edited_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
  });

  it('does not annotate the created_time system field', () => {
    expect(topLevelProps().created_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });
});
