import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { findLastModifiedFieldName } from '../../../types';
import { buildMocoJsonTableSpec } from '../moco-json-schema';
import { MocoEntityType } from '../moco-types';

const ENTITY_TYPES: MocoEntityType[] = ['companies', 'contacts', 'projects'];

describe('buildMocoJsonTableSpec last-modified annotation', () => {
  function topLevelProps(entityType: MocoEntityType): Record<string, Record<string, unknown>> {
    const spec = buildMocoJsonTableSpec({ wsId: entityType, remoteId: [entityType] }, entityType);
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it.each(ENTITY_TYPES)('annotates updated_at with x-scratch-last-modified-field=true for %s', (entityType) => {
    expect(topLevelProps(entityType).updated_at[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
  });

  it.each(ENTITY_TYPES)('does not annotate the created_at system field for %s', (entityType) => {
    expect(topLevelProps(entityType).created_at[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it.each(ENTITY_TYPES)('findLastModifiedFieldName resolves updated_at (flat top-level shape) for %s', (entityType) => {
    const spec = buildMocoJsonTableSpec({ wsId: entityType, remoteId: [entityType] }, entityType);
    expect(findLastModifiedFieldName(spec)).toBe('updated_at');
  });
});
