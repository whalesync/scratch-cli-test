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

  // Copper returns blank fields as null, and the CLI's enforce_schema validator
  // rejects a `required` field whose value is null. TypeBox marks every
  // non-Optional property required by default, so the only field we may require
  // is the always-present `id` — otherwise verbatim records fail validation.
  it.each<CopperEntityType>(['people', 'companies', 'opportunities', 'leads', 'tasks', 'projects'])(
    'requires only `id` so null-valued blank fields pass enforce_schema (%s)',
    (entityType) => {
      const { spec } = specProperties(entityType);
      const schema = spec.schema as unknown as { required?: string[] };
      expect(schema.required).toEqual(['id']);
    },
  );

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

  it('exposes custom_fields as a keyed object (one sub-property per definition) on every entity', () => {
    const defs: CopperCustomFieldDefinition[] = [{ id: 9001, name: 'Industry', data_type: 'Dropdown' }];
    for (const entityType of [
      'people',
      'companies',
      'opportunities',
      'leads',
      'tasks',
      'projects',
    ] as CopperEntityType[]) {
      const { properties } = specProperties(entityType, defs);
      const customFields = properties.custom_fields as { type?: string; properties?: Record<string, unknown> };
      expect(customFields.type).toBe('object');
      // The definition becomes a `cf_<id>` sub-property → its own editable column.
      expect(customFields.properties?.['cf_9001']).toBeDefined();
    }
  });

  it('types custom-field sub-properties from data_type and marks Connect/computed read-only', () => {
    const defs: CopperCustomFieldDefinition[] = [
      { id: 1, name: 'Score', data_type: 'Float' },
      { id: 2, name: 'Active', data_type: 'Checkbox' },
      { id: 3, name: 'Linked', data_type: 'Connect' },
      { id: 4, name: 'Computed', data_type: 'Float', is_computed: true },
    ];
    const { properties } = specProperties('people', defs);
    const subProps = (properties.custom_fields as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(JSON.stringify(subProps['cf_1'])).toContain('"type":"number"');
    expect(JSON.stringify(subProps['cf_2'])).toContain('"type":"boolean"');
    // Connect and is_computed fields are read-only (never sent on write).
    expect(subProps['cf_3']?.[X_SCRATCH_READONLY]).toBe(true);
    expect(subProps['cf_4']?.[X_SCRATCH_READONLY]).toBe(true);
    expect(subProps['cf_1']?.[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('adds a cf_<id>->name/type legend for agents at the schema root', () => {
    const defs: CopperCustomFieldDefinition[] = [
      { id: 9001, name: 'Industry', data_type: 'Dropdown', available_options: [{ id: 1, name: 'SaaS' }] },
      { id: 9002, name: 'Renewal Date', data_type: 'Date' },
    ];
    const { spec } = specProperties('people', defs);
    const instructions = (spec.schema as unknown as Record<string, unknown>)[X_SCRATCH_AGENT_INSTRUCTIONS] as string;
    expect(instructions).toContain('custom_fields key: cf_9001');
    expect(instructions).toContain('Industry');
    expect(instructions).toContain('options: SaaS');
    expect(instructions).toContain('custom_fields key: cf_9002');
  });

  it('models leads email as a single object, not an array', () => {
    const { properties } = specProperties('leads');
    // Union of object + null — not an array type.
    expect((properties.email as { type?: string }).type).not.toBe('array');
  });
});
