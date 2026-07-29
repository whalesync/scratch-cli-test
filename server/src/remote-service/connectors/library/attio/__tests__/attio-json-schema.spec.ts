/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import {
  TransformerTypes,
  VirtualFieldDef,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_VIRTUAL_FIELDS,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { buildAttioListTableSpec, buildAttioObjectTableSpec, buildAttioTasksTableSpec } from '../attio-json-schema';
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

const mockEntityId = { wsId: 'test', remoteId: ['test-remote'] };

const mockClient = {
  listObjectAttributes: jest.fn(),
  listListAttributes: jest.fn(),
  // Drives object-id → slug resolution for record-reference foreign keys.
  // Default: empty (no resolution); FK tests override per-case.
  listObjects: jest.fn().mockResolvedValue([]),
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

  it('extracts the interacted_at timestamp from interaction attributes (DEV-11052)', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'last_interaction', type: 'interaction', title: 'Last Interaction' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    const vf = spec.schema.properties.values.properties.last_interaction[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].type).toBe('string');
    expect(vf[0].suggestedTransformer.options).toMatchObject({ expression: '$[0].interacted_at' });
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
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', [], mockClient);
    const vf = spec.schema.properties.entry_values.properties.stage[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf).toBeDefined();
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].status.title', arrayHandling: 'first' },
    });
  });
});

describe('attio-json-schema read-only propagation (is_writable)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks a non-writable attribute (is_writable=false) read-only', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      // Mirrors Attio's computed fields (record_id, created_at, *_interaction):
      // is_system_attribute true AND is_writable false.
      makeAttribute({ api_slug: 'last_interaction', type: 'timestamp', is_system_attribute: true, is_writable: false }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    expect(spec.schema.properties.values.properties.last_interaction[X_SCRATCH_READONLY]).toBe(true);
  });

  it('does NOT mark a writable system field read-only (the is_system_attribute trap)', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      // name/description/domains on Attio: is_system_attribute true but writable.
      // Keying off is_system_attribute would wrongly lock these — it must not.
      makeAttribute({ api_slug: 'name', type: 'text', is_system_attribute: true, is_writable: true }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    expect(spec.schema.properties.values.properties.name[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('leaves an attribute with no is_writable flag writable (absent !== false)', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([makeAttribute({ api_slug: 'custom_text', type: 'text' })]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'companies', mockClient);
    expect(spec.schema.properties.values.properties.custom_text[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('propagates is_writable=false on list-scoped attributes too', async () => {
    mockClient.listListAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'computed_on_list', type: 'timestamp', is_writable: false }),
      makeAttribute({ api_slug: 'sector', type: 'select', is_writable: true }),
    ]);
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', [], mockClient);
    expect(spec.schema.properties.entry_values.properties.computed_on_list[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.entry_values.properties.sector[X_SCRATCH_READONLY]).toBeUndefined();
  });
});

describe('attio-json-schema foreign keys', () => {
  const companiesObject = {
    id: { workspace_id: 'ws', object_id: 'obj-companies' },
    api_slug: 'companies',
    singular_noun: 'Company',
    plural_noun: 'Companies',
    created_at: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.listObjects.mockResolvedValue([companiesObject]);
  });

  it('declares a foreign key on a single-target record-reference (→ target object table)', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({
        api_slug: 'company',
        type: 'record-reference',
        config: { record_reference: { allowed_object_ids: ['obj-companies'] } },
      }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'people', mockClient);
    expect(spec.schema.properties.values.properties.company[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'companies',
      // Matches the companies object's remoteId `[api_slug]` from listTables (raw slug).
      linkedTableRemoteId: ['companies'],
    });
  });

  it('declares a foreign key on an actor-reference (→ workspace members table)', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([makeAttribute({ api_slug: 'owner', type: 'actor-reference' })]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'deals', mockClient);
    // The FK target is the Members table's remoteId ('members'), NOT its wsId
    // ('workspace_members') — that's what the create-plan generator matches a source
    // folder's tableId against, so keying off wsId left it permanently unresolvable
    // (DEV-11052).
    expect(spec.schema.properties.values.properties.owner[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'members',
      // The Members table's full remoteId (`['members']`) from listTables.
      linkedTableRemoteId: ['members'],
    });
  });

  it('does NOT declare a foreign key on a multi-target record-reference (deferred)', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({
        api_slug: 'related',
        type: 'record-reference',
        config: { record_reference: { allowed_object_ids: ['obj-companies', 'obj-people'] } },
      }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'people', mockClient);
    expect(spec.schema.properties.values.properties.related[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
  });

  it('does NOT declare a foreign key when the target object id is unknown', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({
        api_slug: 'company',
        type: 'record-reference',
        config: { record_reference: { allowed_object_ids: ['obj-not-in-map'] } },
      }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'people', mockClient);
    expect(spec.schema.properties.values.properties.company[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
  });
});

describe('attio-json-schema list-entry parent fields (write-once)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks parent_record_id / parent_object write-once, not read-only, so an entry can be created but not re-parented', async () => {
    mockClient.listListAttributes.mockResolvedValue([makeAttribute({ api_slug: 'stage', type: 'status' })]);
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', [], mockClient);
    expect(spec.schema.properties.parent_record_id[X_SCRATCH_WRITE_ONCE]).toBe(true);
    expect(spec.schema.properties.parent_object[X_SCRATCH_WRITE_ONCE]).toBe(true);
    // Write-once is distinct from read-only: these must stay editable on a new entry.
    expect(spec.schema.properties.parent_record_id[X_SCRATCH_READONLY]).toBeUndefined();
    expect(spec.schema.properties.parent_object[X_SCRATCH_READONLY]).toBeUndefined();
    // The id triple and created_at stay read-only.
    expect(spec.schema.properties.id[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.created_at[X_SCRATCH_READONLY]).toBe(true);
  });
});

describe('attio-json-schema list-entry hydrated parent record (DEV-11055)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.listListAttributes.mockResolvedValue([makeAttribute({ api_slug: 'stage', type: 'status' })]);
  });

  it('embeds the parent object attributes as an optional, fully read-only parent_record subtree', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'name', type: 'text', is_writable: true }),
      makeAttribute({ api_slug: 'domains', type: 'domain', is_writable: true }),
    ]);
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', ['companies'], mockClient);
    expect(mockClient.listObjectAttributes).toHaveBeenCalledWith('companies');

    const parentRecord = spec.schema.properties.parent_record;
    expect(parentRecord).toBeDefined();
    // Whole subtree read-only: edits to parent fields belong on the parent object table.
    expect(parentRecord[X_SCRATCH_READONLY]).toBe(true);
    // Every parent attribute is forced read-only even when Attio says writable.
    expect(parentRecord.properties.values.properties.name[X_SCRATCH_READONLY]).toBe(true);
    expect(parentRecord.properties.values.properties.domains[X_SCRATCH_READONLY]).toBe(true);
    // Optional — hydration can miss when the parent was deleted mid-pull.
    expect(spec.schema.required).not.toContain('parent_record');
    // Entry-scoped attributes are untouched.
    expect(spec.schema.properties.entry_values.properties.stage).toBeDefined();
  });

  it('keeps virtual fields / connector data types on parent attributes so they flatten like object columns', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([makeAttribute({ api_slug: 'name', type: 'text' })]);
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', ['companies'], mockClient);
    const nameSchema = spec.schema.properties.parent_record.properties.values.properties.name;
    const vf = nameSchema[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[];
    expect(vf[0].suggestedTransformer).toEqual({
      type: TransformerTypes.JSONPath,
      options: { expression: '$[0].value', arrayHandling: 'first' },
    });
  });

  it('titles entries by the parent name attribute when the parent object has one', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([makeAttribute({ api_slug: 'name', type: 'personal-name' })]);
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', ['people'], mockClient);
    expect(spec.titlePath).toBe('parent_record.values.name');
  });

  it('falls back to the parent_record_id title when the parent object has no name attribute', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([makeAttribute({ api_slug: 'sku', type: 'text' })]);
    const spec = await buildAttioListTableSpec(mockEntityId, 'pipeline-1', 'Sales Pipeline', ['products'], mockClient);
    expect(spec.titlePath).toBe('parent_record_id');
  });

  it('declares no parent_record subtree for a multi-parent list (no single attribute set to describe)', async () => {
    const spec = await buildAttioListTableSpec(
      mockEntityId,
      'multi-list',
      'Multi List',
      ['companies', 'people'],
      mockClient,
    );
    expect(mockClient.listObjectAttributes).not.toHaveBeenCalled();
    expect(spec.schema.properties.parent_record).toBeUndefined();
    expect(spec.titlePath).toBe('parent_record_id');
  });
});

describe('attio-json-schema custom object title attribute (DEV-11055)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the name attribute as titlePath when the object has one', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'sku', type: 'text' }),
      makeAttribute({ api_slug: 'name', type: 'text' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'products', mockClient);
    expect(spec.titlePath).toBe('values.name');
  });

  it('falls back to the first text-like attribute for a custom object without a name attribute', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'priority', type: 'number' }),
      makeAttribute({ api_slug: 'title', type: 'text' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'tickets', mockClient);
    expect(spec.titlePath).toBe('values.title');
  });

  it('ignores an archived name attribute when picking the title', async () => {
    mockClient.listObjectAttributes.mockResolvedValue([
      makeAttribute({ api_slug: 'name', type: 'text', is_archived: true }),
      makeAttribute({ api_slug: 'label', type: 'text' }),
    ]);
    const spec = await buildAttioObjectTableSpec(mockEntityId, 'tickets', mockClient);
    expect(spec.titlePath).toBe('values.label');
  });
});

describe('attio-json-schema tasks content (write-once)', () => {
  it('marks content_plaintext write-once (settable on create, immutable after) and not read-only', () => {
    const spec = buildAttioTasksTableSpec(mockEntityId);
    expect(spec.schema.properties.content_plaintext[X_SCRATCH_WRITE_ONCE]).toBe(true);
    expect(spec.schema.properties.content_plaintext[X_SCRATCH_READONLY]).toBeUndefined();
    // System-set fields stay read-only.
    expect(spec.schema.properties.id[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.created_at[X_SCRATCH_READONLY]).toBe(true);
  });
});

describe('attio-json-schema tasks assignees foreign key (DEV-11052)', () => {
  it('declares assignees as a multi-valued FK onto the Members table', () => {
    const spec = buildAttioTasksTableSpec(mockEntityId);
    // Points at the Members remoteId ('members'), same target as object actor-references.
    expect(spec.schema.properties.assignees[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'members',
      linkedTableRemoteId: ['members'],
      isSingleValued: false,
    });
  });

  it('does NOT declare a foreign key on linked_records (multi-target)', () => {
    const spec = buildAttioTasksTableSpec(mockEntityId);
    expect(spec.schema.properties.linked_records[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
  });
});
