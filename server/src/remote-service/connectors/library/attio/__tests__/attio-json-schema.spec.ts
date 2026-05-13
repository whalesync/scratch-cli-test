/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import { TransformerTypes, VirtualFieldDef, X_SCRATCH_VIRTUAL_FIELDS } from '@spinner/shared-types';
import { buildAttioListTableSpec, buildAttioObjectTableSpec } from '../attio-json-schema';
import { AttioAttribute } from '../attio-types';

function makeAttribute(
  overrides: Partial<AttioAttribute> & { api_slug: string; type: AttioAttribute['type'] },
): AttioAttribute {
  return {
    id: { workspace_id: 'ws', object_id: 'obj', attribute_id: 'attr' },
    title: overrides.api_slug,
    description: null,
    is_system_attribute: false,
    is_archived: false,
    is_required: false,
    is_unique: false,
    is_multiselect: false,
    default_value: null,
    config: null,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mockEntityId = { wsId: 'test', remoteId: 'test-remote' };

const mockClient = {
  listObjectAttributes: jest.fn(),
  listListAttributes: jest.fn(),
} as any;

describe('attio-json-schema virtual fields', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should add virtual fields to text attributes with $[0].value', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'name', type: 'text', title: 'Name' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.name[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf).toHaveLength(1);
    expect(vf[0]).toEqual({
      displayLabel: 'Name',
      type: 'string',
      suggestedTransformer: {
        type: TransformerTypes.JSONPath,
        options: { expression: '$[0].value', arrayHandling: 'first' },
      },
    });
  });

  it('should add virtual fields to domain attributes with $[0].domain', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'domains', type: 'domain', title: 'Domains' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.domains[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].domain', arrayHandling: 'first' },
    });
  });

  it('should add virtual fields to select attributes with $[0].option.title', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'industry', type: 'select', title: 'Industry' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.industry[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].option.title', arrayHandling: 'first' },
    });
  });

  it('should add virtual fields to status attributes with $[0].status.title', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'stage', type: 'status', title: 'Stage' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.stage[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].status.title', arrayHandling: 'first' },
    });
  });

  it('should add virtual fields to email-address attributes', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'email_addresses', type: 'email-address', title: 'Email Addresses' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.email_addresses[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].email_address', arrayHandling: 'first' },
    });
  });

  it('should add virtual fields to record-reference attributes', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'company', type: 'record-reference', title: 'Company' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.company[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].target_record_id', arrayHandling: 'first' },
    });
  });

  it('should add virtual fields to number attributes', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'employee_count', type: 'number', title: 'Employee Count' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.employee_count[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].type).toBe('number');
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].value', arrayHandling: 'first' },
    });
  });

  it('should add virtual fields to checkbox attributes with boolean type', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'is_active', type: 'checkbox', title: 'Is Active' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.is_active[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].type).toBe('boolean');
  });

  it('should not add virtual fields to interaction attributes', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'last_interaction', type: 'interaction', title: 'Last Interaction' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.last_interaction[X_SCRATCH_VIRTUAL_FIELDS];
    expect(vf).toBeUndefined();
  });

  it('should skip archived attributes', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'old_field', type: 'text', is_archived: true }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    expect(spec.schema.properties.values.properties.old_field).toBeUndefined();
  });

  it('should add virtual fields to list entry attributes', async () => {
    mockClient.listListAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'stage', type: 'status', title: 'Stage' }),
    ]);
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', mockClient);
    const vf = spec.schema.properties.entry_values.properties.stage[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf).toBeDefined();
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].status.title', arrayHandling: 'first' },
    });
  });
});
