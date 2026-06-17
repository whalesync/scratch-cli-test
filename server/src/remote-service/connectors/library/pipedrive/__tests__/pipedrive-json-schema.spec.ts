/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { PipedriveApiClient } from '../pipedrive-api-client';
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps text to String | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'text' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps double to Number | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'double' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps date to String(format: date) | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'date' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const stringType = schema!.anyOf?.find((s: { type?: string }) => s.type === 'string');
    expect(stringType?.format).toBe('date');
  });

  it('maps phone to array with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'phone' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('array');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('phone');
  });

  it('maps monetary to object with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'monetary' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('object');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('monetary');
  });

  it('maps address to object with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'address' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('object');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('address');
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('array');
  });

  it('maps org to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'org' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'organizations' });
  });

  it('maps people to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'people' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'persons' });
  });

  it('maps deal to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'deal' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'deals' });
  });

  it('maps stage to Number | Null with FOREIGN_KEY_OPTIONS to stages', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'stage' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'stages' });
  });

  it('maps user to Number | Null with READONLY_FLAG', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'user' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_READONLY]).toBe(true);
  });

  it('maps varchar_auto to String | Null with READONLY_FLAG', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'varchar_auto' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_READONLY]).toBe(true);
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
    const spec = await buildPipedriveJsonTableSpec(entityId, 'deals', mockClient as unknown as PipedriveApiClient);

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
    const spec = await buildPipedriveJsonTableSpec(entityId, 'persons', mockClient as unknown as PipedriveApiClient);

    expect(spec.schema.properties.id[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.add_time[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.update_time[X_SCRATCH_READONLY]).toBe(true);
  });

  it('marks activity person_id/org_id read-only (v2 read-only relations set via participants) — DEV-10453', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'subject', field_name: 'Subject', field_type: 'varchar', is_custom_field: false }),
      makeField({ field_code: 'person_id', field_name: 'Person', field_type: 'people', is_custom_field: false }),
      makeField({ field_code: 'org_id', field_name: 'Organization', field_type: 'org', is_custom_field: false }),
    ]);

    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'activities', remoteId: ['activities'] },
      'activities',
      mockClient as unknown as PipedriveApiClient,
    );

    expect(spec.schema.properties.person_id[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.org_id[X_SCRATCH_READONLY]).toBe(true);
    // A writable system field stays writable.
    expect(spec.schema.properties.subject[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('omits custom_fields property when there are no custom fields', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int', is_custom_field: false }),
      makeField({ field_code: 'name', field_name: 'Name', field_type: 'varchar', is_custom_field: false }),
    ]);

    const entityId = { wsId: 'organizations', remoteId: ['organizations'] };
    const spec = await buildPipedriveJsonTableSpec(
      entityId,
      'organizations',
      mockClient as unknown as PipedriveApiClient,
    );

    expect(spec.schema.properties).not.toHaveProperty('custom_fields');
  });

  describe('leads (v1: static system fields + flat custom fields)', () => {
    it('uses the static lead system schema and places custom fields flat (top-level, not nested)', async () => {
      // Leads share deals' custom fields; the Fields endpoint returns both deal
      // system fields (ignored for leads) and custom fields (kept, placed flat).
      mockClient.getFields.mockResolvedValue([
        makeField({ field_code: 'stage_id', field_name: 'Stage', field_type: 'stage', is_custom_field: false }),
        makeField({
          field_code: 'deadbeefhash',
          field_name: 'My Custom',
          field_type: 'varchar',
          is_custom_field: true,
        }),
      ]);

      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'leads', remoteId: ['leads'] },
        'leads',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(spec.name).toBe('Leads');
      expect(spec.titleColumnRemoteId).toEqual(['title']);
      // Static lead system fields are present...
      expect(spec.schema.properties).toHaveProperty('title');
      expect(spec.schema.properties).toHaveProperty('value');
      expect(spec.schema.properties).toHaveProperty('person_id');
      // ...the deal-only dynamic system field is NOT pulled in...
      expect(spec.schema.properties).not.toHaveProperty('stage_id');
      // ...the custom field is flat at the top level (no custom_fields wrapper)...
      expect(spec.schema.properties).not.toHaveProperty('custom_fields');
      expect(spec.schema.properties).toHaveProperty('deadbeefhash');
    });

    it('marks the lead id and update_time read-only and annotates update_time as last-modified', async () => {
      mockClient.getFields.mockResolvedValue([]);
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'leads', remoteId: ['leads'] },
        'leads',
        mockClient as unknown as PipedriveApiClient,
      );
      expect(spec.schema.properties.id[X_SCRATCH_READONLY]).toBe(true);
      expect(spec.schema.properties.update_time[X_SCRATCH_READONLY]).toBe(true);
      expect(spec.schema.properties.update_time['x-scratch-last-modified-field']).toBe(true);
    });
  });

  describe('notes (v1: fully static, no Fields endpoint, no title)', () => {
    it('builds the static note schema without calling getFields and without a title column', async () => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'notes', remoteId: ['notes'] },
        'notes',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(mockClient.getFields).not.toHaveBeenCalled();
      expect(spec.name).toBe('Notes');
      expect(spec.titleColumnRemoteId).toBeUndefined();
      expect(spec.schema.properties).toHaveProperty('content');
      expect(spec.schema.properties).toHaveProperty('deal_id');
      expect(spec.schema.properties).not.toHaveProperty('custom_fields');
      // The server-hydrated stub objects are read-only.
      expect(spec.schema.properties.person[X_SCRATCH_READONLY]).toBe(true);
    });
  });

  describe('deals foreign keys to pipeline config', () => {
    it('wires deals.pipeline_id (a plain double) and stage_id as foreign keys', async () => {
      mockClient.getFields.mockResolvedValue([
        makeField({ field_code: 'id', field_name: 'ID', field_type: 'int' }),
        makeField({ field_code: 'pipeline_id', field_name: 'Pipeline', field_type: 'double' }),
        makeField({ field_code: 'stage_id', field_name: 'Stage', field_type: 'stage' }),
      ]);

      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'deals', remoteId: ['deals'] },
        'deals',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(spec.schema.properties.pipeline_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'pipelines' });
      expect(spec.schema.properties.stage_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'stages' });
    });
  });

  describe('pipelines / stages (v2 config: static, no custom fields, not incremental)', () => {
    it('builds a static pipelines schema (no getFields, name title, no last-modified annotation)', async () => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'pipelines', remoteId: ['pipelines'] },
        'pipelines',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(mockClient.getFields).not.toHaveBeenCalled();
      expect(spec.name).toBe('Pipelines');
      expect(spec.titleColumnRemoteId).toEqual(['name']);
      expect(spec.schema.properties).toHaveProperty('name');
      expect(spec.schema.properties).not.toHaveProperty('custom_fields');
      expect(spec.schema.properties.update_time[X_SCRATCH_READONLY]).toBe(true);
      // update_time is intentionally NOT a last-modified field — the pipelines
      // endpoint rejects updated_since, so incremental pulls are unsupported.
      expect(spec.schema.properties.update_time['x-scratch-last-modified-field']).toBeUndefined();
    });

    it('builds a static stages schema with pipeline_id as a foreign key to pipelines', async () => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'stages', remoteId: ['stages'] },
        'stages',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(spec.name).toBe('Stages');
      expect(spec.schema.properties.pipeline_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'pipelines' });
      expect(spec.schema.properties.update_time['x-scratch-last-modified-field']).toBeUndefined();
    });
  });
});
