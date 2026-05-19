import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { findLastModifiedFieldName } from '../../../types';
import { ALL_ENTITY_TYPES } from '../graphql';
import { buildLinearJsonTableSpec } from '../linear-json-schema';

describe('buildLinearJsonTableSpec last-modified annotation', () => {
  function topLevelProps(entityType: string): Record<string, Record<string, unknown>> {
    const spec = buildLinearJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it.each([...ALL_ENTITY_TYPES])(
    'annotates the universal updatedAt system field with x-scratch-last-modified-field=true for %s',
    (entityType) => {
      expect(topLevelProps(entityType).updatedAt[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
    },
  );

  it.each([...ALL_ENTITY_TYPES])('does not annotate the createdAt system field for %s', (entityType) => {
    expect(topLevelProps(entityType).createdAt[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it.each([...ALL_ENTITY_TYPES])('findLastModifiedFieldName resolves updatedAt for %s', (entityType) => {
    const spec = buildLinearJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
    expect(findLastModifiedFieldName(spec)).toBe('updatedAt');
  });
});
