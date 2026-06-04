import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { findLastModifiedFieldName } from '../../../types';
import { PipedriveApiClient } from '../pipedrive-api-client';
import { buildPipedriveJsonTableSpec } from '../pipedrive-json-schema';
import { PipedriveEntityType, PipedriveField } from '../pipedrive-types';

// Mock display-names to break the circular import chain (same as the existing
// pipedrive-json-schema spec).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
}));

function makeField(overrides: Partial<PipedriveField> & { field_code: string; field_type: string }): PipedriveField {
  return {
    field_name: overrides.field_name ?? overrides.field_code,
    field_code: overrides.field_code,
    field_type: overrides.field_type,
    is_custom_field: overrides.is_custom_field ?? false,
    options: overrides.options ?? null,
    subfields: overrides.subfields ?? null,
  };
}

const ENTITY_TYPES: PipedriveEntityType[] = ['deals', 'persons', 'organizations'];

describe('buildPipedriveJsonTableSpec last-modified annotation', () => {
  const mockClient = { getFields: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_type: 'int' }),
      makeField({ field_code: 'title', field_type: 'varchar' }),
      makeField({ field_code: 'add_time', field_type: 'date' }),
      makeField({ field_code: 'update_time', field_type: 'date' }),
    ]);
  });

  async function topLevelProps(entityType: PipedriveEntityType): Promise<Record<string, Record<string, unknown>>> {
    const spec = await buildPipedriveJsonTableSpec(
      { wsId: entityType, remoteId: [entityType] },
      entityType,
      mockClient as unknown as PipedriveApiClient,
    );
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it.each(ENTITY_TYPES)('annotates update_time with x-scratch-last-modified-field=true for %s', async (entityType) => {
    const props = await topLevelProps(entityType);
    expect(props.update_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
  });

  it.each(ENTITY_TYPES)('does not annotate the add_time system field for %s', async (entityType) => {
    const props = await topLevelProps(entityType);
    expect(props.add_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it.each(ENTITY_TYPES)('does not annotate the id system field for %s', async (entityType) => {
    const props = await topLevelProps(entityType);
    expect(props.id[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it.each(ENTITY_TYPES)(
    'findLastModifiedFieldName resolves update_time (flat top-level shape) for %s',
    async (entityType) => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: entityType, remoteId: [entityType] },
        entityType,
        mockClient as unknown as PipedriveApiClient,
      );
      expect(findLastModifiedFieldName(spec)).toBe('update_time');
    },
  );
});
