/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import {
  ArrayKeyedByOptions,
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_ARRAY_KEYED_BY,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { X_SCRATCH_AFFINITY_FIELDS_BY_ID } from '../affinity-fields';
import {
  buildAffinityCompaniesTableSpec,
  buildAffinityEntityFilesTableSpec,
  buildAffinityJsonTableSpec,
  buildAffinityNotesTableSpec,
  buildAffinityOpportunitiesTableSpec,
  buildAffinityPersonsTableSpec,
  valueSchemaForType,
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

  it('exposes entity.fields as a verbatim array with an x-scratch-array-keyed-by column per field (no valuePath)', async () => {
    mockListListFields.mockResolvedValue([
      makeField({ id: 'field-1001-stage', valueType: 'dropdown' }),
      makeField({ id: 'field-1001-amount', valueType: 'number' }),
    ]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const fields = (spec.schema as any).properties.entity.properties.fields;

    // Stored verbatim as an array — never reshaped to an object keyed by id.
    expect(fields.type).toBe('array');
    const keyedBy = fields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    expect(keyedBy.keyField).toBe('id');
    // The whole element is the value — no valuePath.
    expect(keyedBy.valuePath).toBeUndefined();
    expect(keyedBy.columns.map((c) => c.key)).toEqual(['field-1001-stage', 'field-1001-amount']);
    expect(mockListListFields).toHaveBeenCalledWith(500);
  });

  it('carries each field name/type via the keyed-by column and the valueType via the fields-by-id map', async () => {
    mockListListFields.mockResolvedValue([makeField({ id: 'field-stage', name: 'Stage', valueType: 'dropdown' })]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const fields = (spec.schema as any).properties.entity.properties.fields;

    const keyedBy = fields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    const stageColumn = keyedBy.columns.find((c) => c.key === 'field-stage');
    expect(stageColumn?.name).toBe('Stage');
    expect(stageColumn?.type).toBe('string'); // dropdown → string column hint (flattened to its .text label, DEV-11064)

    // The exact Affinity valueType (needed by the write layer + location
    // detection) lives in the per-field-id write-meta map on the array property.
    const fieldsById = fields[X_SCRATCH_AFFINITY_FIELDS_BY_ID];
    expect(fieldsById['field-stage'][X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('dropdown');
  });

  it('stores fields verbatim: the element schema tolerates extra keys (no reshape, no forced refresh)', async () => {
    mockListListFields.mockResolvedValue([makeField({ id: 'field-known', valueType: 'text' })]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const fields = (spec.schema as any).properties.entity.properties.fields;

    // A verbatim array element permits additional properties — a future Affinity
    // field the metadata fetch didn't cover is still stored (it just has no
    // column until the next schema refresh), never rejected.
    expect(fields.items.additionalProperties).toBe(true);
  });

  it('adds an agent legend describing the fields array at the schema root', async () => {
    mockListListFields.mockResolvedValue([
      makeField({ id: 'field-stage', name: 'Stage', valueType: 'dropdown', type: 'list' }),
    ]);

    const spec = await buildAffinityJsonTableSpec(entityId, makeList({ id: 500 }), mockClient);
    const instructions = (spec.schema as any)[X_SCRATCH_AGENT_INSTRUCTIONS] as string;

    expect(instructions).toContain('entity.fields.[id=<id>]');
    expect(instructions).toContain('id: field-stage');
    expect(instructions).toContain('Stage');
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

  it('exposes tenant-person fields as a verbatim keyed array at the TOP-LEVEL .fields', async () => {
    mockListPersonFields.mockResolvedValue([
      makeField({ id: 'affinity-data-current-organization', valueType: 'company', type: 'enriched' }),
    ]);

    const spec = await buildAffinityPersonsTableSpec(entityId, mockClient);
    const fields = (spec.schema as any).properties.fields;

    expect(fields.type).toBe('array');
    const keyedBy = fields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    expect(keyedBy.keyField).toBe('id');
    expect(keyedBy.columns.map((c) => c.key)).toContain('affinity-data-current-organization');
    // enriched fields are read-only.
    expect(keyedBy.columns.find((c) => c.key === 'affinity-data-current-organization')?.readonly).toBe(true);
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

  it('exposes tenant-company fields as a verbatim keyed array', async () => {
    mockListCompanyFields.mockResolvedValue([
      makeField({ id: 'affinity-data-industry', valueType: 'filterable-text-multi', type: 'enriched' }),
    ]);

    const spec = await buildAffinityCompaniesTableSpec(entityId, mockClient);
    const fields = (spec.schema as any).properties.fields;

    expect(fields.type).toBe('array');
    const keyedBy = fields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    expect(keyedBy.columns.map((c) => c.key)).toContain('affinity-data-industry');
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

    expect(props.person_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'persons',
      linkedTableRemoteId: ['persons'],
    });
    expect(props.organization_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'companies',
      linkedTableRemoteId: ['companies'],
    });
    expect(props.opportunity_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'opportunities',
      linkedTableRemoteId: ['opportunities'],
    });
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

describe('valueSchemaForType coverage', () => {
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

  it.each(VALUE_TYPES_TO_TEST)(
    'produces a structured `{ type, data }` schema (never Unknown) for "%s"',
    (valueType) => {
      const schema = valueSchemaForType(valueType) as any;
      // Every known valueType maps to a `{ type, data }` object. If we hit the
      // `default: Type.Unknown()` branch it would be an empty schema with no
      // `type`/`properties` — a visible regression if Affinity adds a type.
      expect(schema.type).toBe('object');
      expect(schema.properties?.type).toBeDefined();
      expect(schema.properties?.data).toBeDefined();
    },
  );
});
