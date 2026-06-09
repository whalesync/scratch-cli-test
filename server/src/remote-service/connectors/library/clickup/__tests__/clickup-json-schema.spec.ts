import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildClickUpJsonTableSpec } from '../clickup-json-schema';
import { ClickUpCustomFieldDefinition } from '../clickup-types';

function specProperties(listName = 'Project 1', defs: ClickUpCustomFieldDefinition[] = []) {
  const id: EntityId = { wsId: 'list1', remoteId: ['list1'] };
  const spec = buildClickUpJsonTableSpec(id, listName, defs);
  const schema = spec.schema as unknown as { properties: Record<string, Record<string, unknown>> };
  return { spec, properties: schema.properties };
}

describe('buildClickUpJsonTableSpec', () => {
  it('sets id path, title/main-content columns, and name', () => {
    const { spec } = specProperties('My List');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['name']);
    expect(spec.mainContentColumnRemoteId).toEqual(['description']);
    expect(spec.name).toBe('My List');
  });

  it('marks system / computed fields read-only', () => {
    const { properties } = specProperties();
    for (const field of [
      'id',
      'date_created',
      'date_updated',
      'creator',
      'url',
      'list',
      'assignees',
      'tags',
      'watchers',
      'parent',
      'text_content',
    ]) {
      expect(properties[field]?.[X_SCRATCH_READONLY]).toBe(true);
    }
  });

  it('leaves the editable core fields writable', () => {
    const { properties } = specProperties();
    for (const field of [
      'name',
      'description',
      'status',
      'priority',
      'due_date',
      'start_date',
      'points',
      'time_estimate',
      'custom_fields',
    ]) {
      expect(properties[field]?.[X_SCRATCH_READONLY]).toBeUndefined();
    }
  });

  it('models custom_fields as a verbatim array', () => {
    const { properties } = specProperties();
    expect((properties.custom_fields as { type?: string }).type).toBe('array');
  });

  it('adds an id->name/type legend for agents when custom field definitions exist', () => {
    const defs: ClickUpCustomFieldDefinition[] = [
      { id: 'cf1', name: 'Industry', type: 'drop_down' },
      { id: 'cf2', name: 'Renewal Date', type: 'date' },
    ];
    const { properties } = specProperties('Project 1', defs);
    const instructions = properties.custom_fields?.[X_SCRATCH_AGENT_INSTRUCTIONS];
    expect(instructions).toContain('cf1=Industry (drop_down)');
    expect(instructions).toContain('cf2=Renewal Date (date)');
  });

  it('omits the legend when there are no custom fields', () => {
    const { properties } = specProperties('Project 1', []);
    expect(properties.custom_fields?.[X_SCRATCH_AGENT_INSTRUCTIONS]).toBeUndefined();
  });
});
