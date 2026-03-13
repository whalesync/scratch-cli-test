/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { CONNECTOR_DATA_TYPE, FOREIGN_KEY_OPTIONS, READONLY_FLAG } from '../../../json-schema';
import { buildPipedriveJsonTableSpec, pipedriveFieldToJsonSchema } from '../pipedrive-json-schema';
import { PipedriveField } from '../pipedrive-types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
}));

function makeField(overrides: Partial<PipedriveField> & { field_type: string }): PipedriveField {
  return {
    field_name: overrides.field_name ?? 'Test Field',
    field_code: overrides.field_code ?? 'test_field',
    field_type: overrides.field_type,
    is_custom_field: overrides.is_custom_field ?? false,
    options: overrides.options ?? null,
    subfields: overrides.subfields ?? null,
  };
}

describe('pipedriveFieldToJsonSchema', () => {
  it('maps varchar to String | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'varchar' }));
    expect(schema).toBeDefined();
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps text to String | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'text' }));
    expect(schema).toBeDefined();
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps double to Number | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'double' }));
    expect(schema).toBeDefined();
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps date to String(format: date) | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'date' }));
    expect(schema).toBeDefined();
    const stringType = schema!.anyOf?.find((s: { type?: string }) => s.type === 'string');
    expect(stringType?.format).toBe('date');
  });

  it('maps phone to array with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'phone' }));
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('array');
    expect(schema![CONNECTOR_DATA_TYPE]).toBe('phone');
  });

  it('maps monetary to object with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'monetary' }));
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('object');
    expect(schema![CONNECTOR_DATA_TYPE]).toBe('monetary');
  });

  it('maps address to object with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'address' }));
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('object');
    expect(schema![CONNECTOR_DATA_TYPE]).toBe('address');
  });

  it('maps enum with options to Union of Literals', () => {
    const schema = pipedriveFieldToJsonSchema(
      makeField({
        field_type: 'enum',
        options: [
          { id: 1, label: 'Option A' },
          { id: 2, label: 'Option B' },
        ],
      }),
    );
    expect(schema).toBeDefined();
    // Union of [Literal(1), Literal(2), Null]
    expect(schema!.anyOf).toHaveLength(3);
  });

  it('maps set with options to Array of Union of Literals', () => {
    const schema = pipedriveFieldToJsonSchema(
      makeField({
        field_type: 'set',
        options: [
          { id: 10, label: 'Tag A' },
          { id: 20, label: 'Tag B' },
        ],
      }),
    );
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('array');
  });

  it('maps org to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'org' }));
    expect(schema).toBeDefined();
    expect(schema![FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'organizations' });
  });

  it('maps people to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'people' }));
    expect(schema).toBeDefined();
    expect(schema![FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'persons' });
  });

  it('maps deal to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'deal' }));
    expect(schema).toBeDefined();
    expect(schema![FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'deals' });
  });

  it('maps user to Number | Null with READONLY_FLAG', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'user' }));
    expect(schema).toBeDefined();
    expect(schema![READONLY_FLAG]).toBe(true);
  });

  it('maps varchar_auto to String | Null with READONLY_FLAG', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'varchar_auto' }));
    expect(schema).toBeDefined();
    expect(schema![READONLY_FLAG]).toBe(true);
  });
});

describe('buildPipedriveJsonTableSpec', () => {
  const mockClient = {
    getFields: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds spec with system and custom fields', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int', is_custom_field: false }),
      makeField({ field_code: 'title', field_name: 'Title', field_type: 'varchar', is_custom_field: false }),
      makeField({ field_code: 'add_time', field_name: 'Created', field_type: 'date', is_custom_field: false }),
      makeField({
        field_code: 'abc123hash',
        field_name: 'My Custom',
        field_type: 'varchar',
        is_custom_field: true,
      }),
    ]);

    const entityId = { wsId: 'deals', remoteId: ['deals'] };
    const spec = await buildPipedriveJsonTableSpec(entityId, 'deals', mockClient as any);

    expect(spec.name).toBe('Deals');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['title']);
    expect(spec.schema.properties).toHaveProperty('id');
    expect(spec.schema.properties).toHaveProperty('title');
    expect(spec.schema.properties).toHaveProperty('custom_fields');
    expect(spec.schema.properties.custom_fields.properties).toHaveProperty('abc123hash');
  });

  it('marks id, add_time, update_time as read-only', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int', is_custom_field: false }),
      makeField({ field_code: 'add_time', field_name: 'Created', field_type: 'date', is_custom_field: false }),
      makeField({ field_code: 'update_time', field_name: 'Updated', field_type: 'date', is_custom_field: false }),
    ]);

    const entityId = { wsId: 'persons', remoteId: ['persons'] };
    const spec = await buildPipedriveJsonTableSpec(entityId, 'persons', mockClient as any);

    expect(spec.schema.properties.id[READONLY_FLAG]).toBe(true);
    expect(spec.schema.properties.add_time[READONLY_FLAG]).toBe(true);
    expect(spec.schema.properties.update_time[READONLY_FLAG]).toBe(true);
  });

  it('omits custom_fields property when there are no custom fields', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int', is_custom_field: false }),
      makeField({ field_code: 'name', field_name: 'Name', field_type: 'varchar', is_custom_field: false }),
    ]);

    const entityId = { wsId: 'organizations', remoteId: ['organizations'] };
    const spec = await buildPipedriveJsonTableSpec(entityId, 'organizations', mockClient as any);

    expect(spec.schema.properties).not.toHaveProperty('custom_fields');
  });
});
