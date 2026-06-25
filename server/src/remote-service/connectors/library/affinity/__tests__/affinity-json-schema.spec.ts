/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import {
  buildAffinityCompaniesTableSpec,
  buildAffinityEntityFilesTableSpec,
  buildAffinityJsonTableSpec,
  buildAffinityNotesTableSpec,
  buildAffinityOpportunitiesTableSpec,
  buildAffinityPersonsTableSpec,
} from '../affinity-json-schema';
import { AffinityFieldMetadata, AffinityList, AffinityValueType } from '../affinity-types';

// Minimal mock client — only the field-metadata methods are called by the
// schema builders. Each test sets the per-call return value via the mock.
const mockListListFields = jest.fn();
const mockListPersonFields = jest.fn();
const mockListCompanyFields = jest.fn();

const mockClient = {
  listListFields: mockListListFields,
  listPersonFields: mockListPersonFields,
  listCompanyFields: mockListCompanyFields,
} as never;

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(
  overrides: Partial<AffinityFieldMetadata> & { id: string; valueType: AffinityValueType },
): AffinityFieldMetadata {
  return {
    id: overrides.id,
    name: overrides.name ?? `Field ${overrides.id}`,
    type: overrides.type ?? 'list',
    enrichmentSource: overrides.enrichmentSource ?? null,
    valueType: overrides.valueType,
  };
}

function makeList(overrides: Partial<AffinityList> & { id: number }): AffinityList {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Test List',
    type: overrides.type ?? 'company',
    isPublic: overrides.isPublic ?? false,
    ownerId: overrides.ownerId ?? 1,
    creatorId: overrides.creatorId ?? 1,
  };
}

// ---------------------------------------------------------------------------
// buildAffinityJsonTableSpec — list path
// ---------------------------------------------------------------------------

describe('buildAffinityJsonTableSpec (list-entries)', () => {
  const entityId = { wsId: 'list_500', remoteId: ['500'] };

  it('builds the spec metadata with the right top-level fields', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(
      entityId,
      makeList({ id: 500, name: 'Vendors', type: 'company' }),
      mockClient,
    );

    expect(spec.name).toBe('Vendors');
    expect(spec.slug).toBe('list_500');
    expect(spec.idPath).toBe('id');
    // Lists are nested under "Lists/" in both the picker AND the workbook
    // tree — see CONNECTOR_GUIDE.md "Fixed vs. user-defined tables".
    expect(spec.basePath).toEqual(['Lists']);
    expect(spec.basePath).not.toEqual([]);
    expect(spec.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('uses entity.firstName as the title for person lists (lastName is nullable)', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500, type: 'person' }), mockClient);

    expect(spec.titlePath).toEqual('entity.firstName');
  });

  it('uses entity.name as the title for company lists', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500, type: 'company' }), mockClient);

    expect(spec.titlePath).toEqual('entity.name');
  });

  it('uses entity.name as the title for opportunity lists', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500, type: 'opportunity' }), mockClient);

    expect(spec.titlePath).toEqual('entity.name');
  });

  it('mounts list-entry top-level fields with correct readonly flags', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const props = (spec.schema as any).properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('type');
    expect(props).toHaveProperty('listId');
    expect(props).toHaveProperty('createdAt');
    expect(props).toHaveProperty('creatorId');
    expect(props).toHaveProperty('entity');

    // Entry-level fields are all read-only (Affinity manages them).
    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.type[X_SCRATCH_READONLY]).toBe(true);
    expect(props.listId[X_SCRATCH_READONLY]).toBe(true);
    expect(props.createdAt[X_SCRATCH_READONLY]).toBe(true);
    expect(props.creatorId[X_SCRATCH_READONLY]).toBe(true);
  });

  it('mounts entity properties under entity for company lists', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500, type: 'company' }), mockClient);
    const entityProps = (spec.schema as any).properties.entity.properties;

    expect(entityProps).toHaveProperty('id');
    expect(entityProps).toHaveProperty('name');
    expect(entityProps).toHaveProperty('domain');
    expect(entityProps).toHaveProperty('domains');
    expect(entityProps).toHaveProperty('isGlobal');
    expect(entityProps).toHaveProperty('fields');
    // Affinity-assigned ids are read-only.
    expect(entityProps.id[X_SCRATCH_READONLY]).toBe(true);
    expect(entityProps.isGlobal[X_SCRATCH_READONLY]).toBe(true);
  });

  it('mounts entity properties under entity for person lists', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500, type: 'person' }), mockClient);
    const entityProps = (spec.schema as any).properties.entity.properties;

    expect(entityProps).toHaveProperty('firstName');
    expect(entityProps).toHaveProperty('lastName');
    expect(entityProps).toHaveProperty('primaryEmailAddress');
    expect(entityProps).toHaveProperty('emailAddresses');
  });

  it('mounts entity properties under entity for opportunity lists', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500, type: 'opportunity' }), mockClient);
    const entityProps = (spec.schema as any).properties.entity.properties;

    expect(entityProps).toHaveProperty('id');
    expect(entityProps).toHaveProperty('name');
    expect(entityProps).toHaveProperty('listId');
    expect(entityProps).toHaveProperty('fields');
    expect(entityProps.listId[X_SCRATCH_READONLY]).toBe(true);
  });

  it('keys field metadata under entity.fields by remote field id', async () => {
    mockListListFields.mockResolvedValue([
      makeField({ id: 'field-1001-stage', valueType: 'dropdown' }),
      makeField({ id: 'field-1001-amount', valueType: 'number' }),
    ]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const fieldsProps = (spec.schema as any).properties.entity.properties.fields.properties;

    expect(fieldsProps).toHaveProperty('field-1001-stage');
    expect(fieldsProps).toHaveProperty('field-1001-amount');
    expect(mockListListFields).toHaveBeenCalledWith(500);
  });

  it('annotates each field with REMOTE_FIELD_ID and CONNECTOR_DATA_TYPE', async () => {
    mockListListFields.mockResolvedValue([makeField({ id: 'field-stage', name: 'Stage', valueType: 'dropdown' })]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const field = (spec.schema as any).properties.entity.properties.fields.properties['field-stage'];

    expect(field[X_SCRATCH_REMOTE_FIELD_ID]).toBe('field-stage');
    expect(field[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('dropdown');
    // The TypeBox object's `description` carries the human-readable name.
    expect(field.description).toBe('Stage');
  });

  it('rejects unknown additional fields on the entity.fields object', async () => {
    mockListListFields.mockResolvedValue([makeField({ id: 'field-known', valueType: 'text' })]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const fieldsObj = (spec.schema as any).properties.entity.properties.fields;

    // additionalProperties: false means a future Affinity field that wasn't in
    // the metadata fetch won't validate — forces a schema refresh.
    expect(fieldsObj.additionalProperties).toBe(false);
  });

  it('produces a $id of the form affinity/list-{id}', async () => {
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 9999, name: 'X' }), mockClient);

    expect((spec.schema as any).$id).toBe('affinity/list-9999');
    expect((spec.schema as any).title).toBe('X');
  });
});

// ---------------------------------------------------------------------------
// buildAffinityPersonsTableSpec — tenant-wide People
// ---------------------------------------------------------------------------

describe('buildAffinityPersonsTableSpec', () => {
  const entityId = { wsId: 'persons', remoteId: ['persons'] };

  it('builds tenant-people spec with the right metadata', async () => {
    mockListPersonFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityPersonsTableSpec(entityId, mockClient);

    expect(spec.name).toBe('People');
    expect(spec.slug).toBe('persons');
    expect(spec.idPath).toBe('id');
    // Tenant tables live at the workbook root — no Lists/ wrapper.
    expect(spec.basePath).toEqual([]);
    // FLAT title field — no `entity.` prefix because tenant records have no
    // entity wrapper. firstName chosen because lastName is nullable.
    expect(spec.titlePath).toEqual('firstName');
    expect(spec.titlePath).not.toEqual('entity.firstName');
  });

  it('mounts entity-shape properties at the TOP LEVEL (no entity wrapper)', async () => {
    mockListPersonFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityPersonsTableSpec(entityId, mockClient);
    const props = (spec.schema as any).properties;

    // These properties are at the top level for tenant records, NOT under .entity
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('firstName');
    expect(props).toHaveProperty('lastName');
    expect(props).toHaveProperty('primaryEmailAddress');
    expect(props).toHaveProperty('emailAddresses');
    expect(props).toHaveProperty('type');
    expect(props).toHaveProperty('fields');
    // Crucially: NO `entity` property. Tenant records are flat.
    expect(props).not.toHaveProperty('entity');
  });

  it('keys tenant-person fields by remote field id at the TOP-LEVEL .fields', async () => {
    mockListPersonFields.mockResolvedValue([
      makeField({ id: 'affinity-data-current-organization', valueType: 'company', type: 'enriched' }),
    ]);

    const spec = await buildAffinityPersonsTableSpec(entityId, mockClient);
    const fieldsProps = (spec.schema as any).properties.fields.properties;

    expect(fieldsProps).toHaveProperty('affinity-data-current-organization');
    expect(mockListPersonFields).toHaveBeenCalled();
  });

  it('uses the affinity/persons $id', async () => {
    mockListPersonFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityPersonsTableSpec(entityId, mockClient);

    expect((spec.schema as any).$id).toBe('affinity/persons');
    expect((spec.schema as any).title).toBe('People');
  });
});

// ---------------------------------------------------------------------------
// buildAffinityCompaniesTableSpec — tenant-wide Companies
// ---------------------------------------------------------------------------

describe('buildAffinityCompaniesTableSpec', () => {
  const entityId = { wsId: 'companies', remoteId: ['companies'] };

  it('builds tenant-companies spec with the right metadata', async () => {
    mockListCompanyFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityCompaniesTableSpec(entityId, mockClient);

    expect(spec.name).toBe('Companies');
    expect(spec.slug).toBe('companies');
    expect(spec.idPath).toBe('id');
    expect(spec.basePath).toEqual([]);
    expect(spec.titlePath).toEqual('name');
    expect(spec.titlePath).not.toEqual('entity.name');
  });

  it('mounts company properties at the top level (no entity wrapper)', async () => {
    mockListCompanyFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityCompaniesTableSpec(entityId, mockClient);
    const props = (spec.schema as any).properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('domain');
    expect(props).toHaveProperty('domains');
    expect(props).toHaveProperty('isGlobal');
    expect(props).toHaveProperty('fields');
    expect(props).not.toHaveProperty('entity');

    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.isGlobal[X_SCRATCH_READONLY]).toBe(true);
  });

  it('keys tenant-company fields by remote field id', async () => {
    mockListCompanyFields.mockResolvedValue([
      makeField({ id: 'affinity-data-industry', valueType: 'filterable-text-multi', type: 'enriched' }),
    ]);

    const spec = await buildAffinityCompaniesTableSpec(entityId, mockClient);
    const fieldsProps = (spec.schema as any).properties.fields.properties;

    expect(fieldsProps).toHaveProperty('affinity-data-industry');
  });

  it('uses the affinity/companies $id', async () => {
    mockListCompanyFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const spec = await buildAffinityCompaniesTableSpec(entityId, mockClient);

    expect((spec.schema as any).$id).toBe('affinity/companies');
  });
});

// ---------------------------------------------------------------------------
// buildAffinityOpportunitiesTableSpec — fixed three-column schema, no API call
// ---------------------------------------------------------------------------

describe('buildAffinityOpportunitiesTableSpec', () => {
  const entityId = { wsId: 'opportunities', remoteId: ['opportunities'] };

  it('builds a fixed three-column spec without any API calls', () => {
    const spec = buildAffinityOpportunitiesTableSpec(entityId);

    expect(spec.name).toBe('Opportunities');
    expect(spec.idPath).toBe('id');
    expect(spec.titlePath).toEqual('name');
    expect(spec.basePath).toEqual([]);
    // None of the field-metadata mocks should have been touched — opportunities
    // have no /fields endpoint.
    expect(mockListListFields).not.toHaveBeenCalled();
    expect(mockListPersonFields).not.toHaveBeenCalled();
    expect(mockListCompanyFields).not.toHaveBeenCalled();
  });

  it('mounts exactly id / name / listId — no fields, no entity wrapper', () => {
    const spec = buildAffinityOpportunitiesTableSpec(entityId);
    const props = (spec.schema as any).properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('listId');
    expect(Object.keys(props).sort()).toEqual(['id', 'listId', 'name']);
    expect(props).not.toHaveProperty('fields');
    expect(props).not.toHaveProperty('entity');
  });

  it('marks id and listId as readonly', () => {
    const spec = buildAffinityOpportunitiesTableSpec(entityId);
    const props = (spec.schema as any).properties;

    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.listId[X_SCRATCH_READONLY]).toBe(true);
  });

  it('uses the affinity/opportunities $id', () => {
    const spec = buildAffinityOpportunitiesTableSpec(entityId);

    expect((spec.schema as any).$id).toBe('affinity/opportunities');
    expect((spec.schema as any).title).toBe('Opportunities');
  });
});

// ---------------------------------------------------------------------------
// buildAffinityNotesTableSpec — fixed schema, no API call
// ---------------------------------------------------------------------------

describe('buildAffinityNotesTableSpec', () => {
  const entityId = { wsId: 'notes', remoteId: ['notes'] };

  it('builds a fixed spec with the right metadata', () => {
    const spec = buildAffinityNotesTableSpec(entityId);

    expect(spec.name).toBe('Notes');
    expect(spec.idPath).toBe('id');
    expect(spec.basePath).toEqual([]);
    expect((spec.schema as any).$id).toBe('affinity/notes');
  });

  it('includes content, mentions, and the includes-populated preview fields', () => {
    const spec = buildAffinityNotesTableSpec(entityId);
    const props = (spec.schema as any).properties;

    expect(props).toHaveProperty('content');
    expect(props).toHaveProperty('mentions');
    expect(props).toHaveProperty('type');
    expect(props).toHaveProperty('companiesPreview');
    expect(props).toHaveProperty('personsPreview');
    expect(props).toHaveProperty('opportunitiesPreview');
    expect(props).toHaveProperty('repliesCount');
  });

  it('includes discriminated fields for interaction/ai-notetaker types', () => {
    const spec = buildAffinityNotesTableSpec(entityId);
    const props = (spec.schema as any).properties;

    expect(props).toHaveProperty('interaction');
    expect(props).toHaveProperty('transcriptId');
    expect(props).toHaveProperty('parent');
  });
});

// ---------------------------------------------------------------------------
// buildAffinityEntityFilesTableSpec — fixed schema, no API call (v1)
// ---------------------------------------------------------------------------

describe('buildAffinityEntityFilesTableSpec', () => {
  const entityId = { wsId: 'entity-files', remoteId: ['entity-files'] };

  it('builds a fixed spec with the right metadata', () => {
    const spec = buildAffinityEntityFilesTableSpec(entityId);

    expect(spec.name).toBe('Entity Files');
    expect(spec.idPath).toBe('id');
    expect(spec.titlePath).toEqual('name');
    // Entity Files are top-level (not under Interactions)
    expect(spec.basePath).toEqual([]);
    expect((spec.schema as any).$id).toBe('affinity/entity-files');
  });

  it('includes v1 snake_case fields for entity associations', () => {
    const spec = buildAffinityEntityFilesTableSpec(entityId);
    const props = (spec.schema as any).properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('size');
    expect(props).toHaveProperty('person_id');
    expect(props).toHaveProperty('organization_id');
    expect(props).toHaveProperty('opportunity_id');
    expect(props).toHaveProperty('uploader_id');
    expect(props).toHaveProperty('created_at');
  });

  it('marks id and association fields as readonly', () => {
    const spec = buildAffinityEntityFilesTableSpec(entityId);
    const props = (spec.schema as any).properties;

    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.size[X_SCRATCH_READONLY]).toBe(true);
    expect(props.uploader_id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.created_at[X_SCRATCH_READONLY]).toBe(true);
  });

  it('declares foreign keys on the parent-entity id fields → the right tenant tables', () => {
    const spec = buildAffinityEntityFilesTableSpec(entityId);
    const props = (spec.schema as any).properties;

    expect(props.person_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'persons' });
    expect(props.organization_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'companies' });
    expect(props.opportunity_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'opportunities' });
    // FK fields remain read-only (entity files have no v1 metadata-update endpoint).
    expect(props.person_id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.organization_id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.opportunity_id[X_SCRATCH_READONLY]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// valueSchemaForType coverage
//
// The valueSchemaForType switch covers ~17 valueTypes. A future Affinity API
// addition that introduces a new valueType would silently fall through to
// `Type.Unknown()` rather than producing a useful schema. These tests pin the
// current set of supported types so that's at least a visible regression.
// ---------------------------------------------------------------------------

describe('valueSchemaForType coverage (via list-entry field schemas)', () => {
  const entityId = { wsId: 'list_500', remoteId: ['500'] };
  const VALUE_TYPES_TO_TEST: AffinityValueType[] = [
    'text',
    'filterable-text',
    'filterable-text-multi',
    'number',
    'formula-number',
    'number-multi',
    'datetime',
    'dropdown',
    'ranked-dropdown',
    'company',
    'person',
    'location',
    'interaction',
    'dropdown-multi',
    'company-multi',
    'person-multi',
    'location-multi',
  ];

  it.each(VALUE_TYPES_TO_TEST)('produces a non-Unknown schema for valueType "%s"', async (valueType) => {
    mockListListFields.mockResolvedValue([
      makeField({ id: `field-${valueType}`, valueType, name: `Field ${valueType}` }),
    ]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const fieldSchema = (spec.schema as any).properties.entity.properties.fields.properties[`field-${valueType}`];
    const valueShape = fieldSchema.properties.value;

    // The field's `value` is `Union(valueSchema, Null)`. If we hit the
    // `default: Type.Unknown()` branch, the union would be `Union(Unknown, Null)`
    // which doesn't have an `anyOf` of two object schemas — it would be a
    // single permissive shape with no inner structure.
    expect(valueShape).toBeDefined();
    expect(valueShape.anyOf).toBeDefined();
    // The annotated CONNECTOR_DATA_TYPE on the field carries the original
    // valueType so downstream tooling can map it back to a transformer.
    expect(fieldSchema[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(valueType);
  });
});
