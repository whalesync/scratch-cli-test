import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildCopperJsonTableSpec } from '../copper-json-schema';
import { CopperCustomFieldDefinition, CopperEntityType } from '../copper-types';

function specProperties(entityType: CopperEntityType, defs: CopperCustomFieldDefinition[] = []) {
  const id: EntityId = { wsId: entityType, remoteId: [entityType] };
  const spec = buildCopperJsonTableSpec(id, entityType, defs);
  const schema = spec.schema as unknown as { properties: Record<string, Record<string, unknown>> };
  return { spec, properties: schema.properties };
}

describe('buildCopperJsonTableSpec', () => {
  it('sets id path, title column, and name from entity config', () => {
    const { spec } = specProperties('people');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['name']);
    expect(spec.name).toBe('People');
  });

  it('marks system fields read-only', () => {
    const { properties } = specProperties('people');
    for (const field of ['id', 'date_created', 'date_modified', 'date_last_contacted', 'interaction_count']) {
      expect(properties[field]?.[X_SCRATCH_READONLY]).toBe(true);
    }
    // Writable fields are not read-only.
    expect(properties.name?.[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('marks People company_id read-only (set via Related Items — R8)', () => {
    const { properties } = specProperties('people');
    expect(properties.company_id?.[X_SCRATCH_READONLY]).toBe(true);
    expect(properties.company_id?.[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'companies' });
  });

  it('annotates cross-entity foreign keys on opportunities', () => {
    const { properties } = specProperties('opportunities');
    expect(properties.company_id?.[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'companies' });
    expect(properties.primary_contact_id?.[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'people' });
  });

  it('includes a verbatim custom_fields array on every entity', () => {
    for (const entityType of [
      'people',
      'companies',
      'opportunities',
      'leads',
      'tasks',
      'projects',
    ] as CopperEntityType[]) {
      const { properties } = specProperties(entityType);
      expect(properties.custom_fields).toBeDefined();
      expect((properties.custom_fields as { type?: string }).type).toBe('array');
    }
  });

  it('adds an id->name legend for agents when custom field definitions exist', () => {
    const defs: CopperCustomFieldDefinition[] = [
      { id: 9001, name: 'Industry', data_type: 'Dropdown' },
      { id: 9002, name: 'Renewal Date', data_type: 'Date' },
    ];
    const { properties } = specProperties('people', defs);
    const instructions = properties.custom_fields?.[X_SCRATCH_AGENT_INSTRUCTIONS];
    expect(instructions).toContain('9001=Industry (Dropdown)');
    expect(instructions).toContain('9002=Renewal Date (Date)');
  });

  it('models leads email as a single object, not an array', () => {
    const { properties } = specProperties('leads');
    // Union of object + null — not an array type.
    expect((properties.email as { type?: string }).type).not.toBe('array');
  });
});
