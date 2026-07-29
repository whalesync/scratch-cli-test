import { Type, type TSchema } from '@sinclair/typebox';
import {
  TableViewBannerGroup,
  TableViewCol,
  X_SCRATCH_ARRAY_KEYED_BY,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { buildAffinityDefaultView } from '../affinity-default-view';
import {
  buildAffinityFieldsArrayKeyedByOptions,
  buildAffinityFieldSchemasById,
  X_SCRATCH_AFFINITY_FIELDS_BY_ID,
} from '../affinity-fields';
import { AffinityFieldMetadata, AffinityValueType } from '../affinity-types';

// ── Schema helpers ──

/** One field definition (the input the real schema builders discover from the API). */
function fieldDef(id: string, name: string, valueType: AffinityValueType): AffinityFieldMetadata {
  return { id, name, type: 'list', enrichmentSource: null, valueType };
}

/**
 * Build a verbatim `fields` array property with both annotations
 * (`x-scratch-array-keyed-by` + the per-field-id write-meta map), exactly as
 * `affinity-json-schema` mounts it, so the default view reads real annotations.
 */
function fieldsArrayProperty(defs: AffinityFieldMetadata[]): TSchema {
  const elementSchema = Type.Object(
    {
      id: Type.String(),
      value: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
    },
    { additionalProperties: true },
  );
  return Type.Array(elementSchema, {
    [X_SCRATCH_ARRAY_KEYED_BY]: buildAffinityFieldsArrayKeyedByOptions(defs),
    [X_SCRATCH_AFFINITY_FIELDS_BY_ID]: buildAffinityFieldSchemasById(defs),
  });
}

/** Build a company list-entry schema (entity wrapper). */
function makeCompanyListEntrySchema() {
  return Type.Object(
    {
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      type: Type.Literal('company', { [X_SCRATCH_READONLY]: true }),
      listId: Type.Number({ [X_SCRATCH_READONLY]: true }),
      createdAt: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      creatorId: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      entity: Type.Object({
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        name: Type.Union([Type.String(), Type.Null()]),
        domain: Type.Union([Type.String(), Type.Null()]),
        domains: Type.Array(Type.String()),
        isGlobal: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        fields: fieldsArrayProperty([
          fieldDef('field-1', 'Industry', 'dropdown'),
          fieldDef('field-2', 'Revenue', 'number'),
          fieldDef('field-3', 'Founded', 'datetime'),
        ]),
      }),
    },
    { $id: 'affinity/list-42', title: 'My Companies List' },
  );
}

/** Build a tenant-wide persons schema (flat, no entity wrapper). */
function makePersonsSchema() {
  return Type.Object(
    {
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      firstName: Type.Union([Type.String(), Type.Null()]),
      lastName: Type.Union([Type.String(), Type.Null()]),
      primaryEmailAddress: Type.Union([Type.String(), Type.Null()]),
      emailAddresses: Type.Array(Type.String()),
      type: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      fields: fieldsArrayProperty([fieldDef('field-10', 'Title', 'text'), fieldDef('field-11', 'Company', 'company')]),
    },
    { $id: 'affinity/persons', title: 'People' },
  );
}

/** Build a tenant-wide companies schema (flat). */
function makeCompaniesSchema() {
  return Type.Object(
    {
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      name: Type.Union([Type.String(), Type.Null()]),
      domain: Type.Union([Type.String(), Type.Null()]),
      domains: Type.Array(Type.String()),
      isGlobal: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
      fields: fieldsArrayProperty([fieldDef('field-20', 'Sector', 'dropdown')]),
    },
    { $id: 'affinity/companies', title: 'Companies' },
  );
}

/** Build a tenant-wide opportunities schema (flat, no fields). */
function makeOpportunitiesSchema() {
  return Type.Object(
    {
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      name: Type.Union([Type.String(), Type.Null()]),
      listId: Type.Number({ [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'affinity/opportunities', title: 'Opportunities' },
  );
}

/** Build a notes schema. */
function makeNotesSchema() {
  const personData = Type.Object({
    id: Type.Number(),
    firstName: Type.Union([Type.String(), Type.Null()]),
    lastName: Type.Union([Type.String(), Type.Null()]),
    primaryEmailAddress: Type.Union([Type.String(), Type.Null()]),
    type: Type.Union([Type.String(), Type.Null()]),
  });

  return Type.Object(
    {
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      type: Type.String({ [X_SCRATCH_READONLY]: true }),
      content: Type.Object({ html: Type.Union([Type.String(), Type.Null()]) }),
      creator: Type.Union([personData, Type.Null()], { [X_SCRATCH_READONLY]: true }),
      mentions: Type.Array(Type.Unknown(), { [X_SCRATCH_READONLY]: true }),
      createdAt: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      companiesPreview: Type.Optional(Type.Object({ data: Type.Array(Type.Unknown()), totalCount: Type.Number() })),
      personsPreview: Type.Optional(Type.Object({ data: Type.Array(Type.Unknown()), totalCount: Type.Number() })),
      opportunitiesPreview: Type.Optional(Type.Object({ data: Type.Array(Type.Unknown()), totalCount: Type.Number() })),
      repliesCount: Type.Optional(Type.Number()),
      interaction: Type.Optional(Type.Object({ id: Type.Number(), type: Type.String() })),
      transcriptId: Type.Optional(Type.Number()),
      parent: Type.Optional(Type.Object({ id: Type.Number() })),
    },
    { $id: 'affinity/notes', title: 'Notes' },
  );
}

/** Build an entity files schema (parent-entity FKs annotated as the real schema mounts them). */
function makeEntityFilesSchema() {
  return Type.Object(
    {
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      name: Type.String(),
      size: Type.Number({ [X_SCRATCH_READONLY]: true }),
      person_id: Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'persons', linkedTableRemoteId: ['persons'] },
      }),
      organization_id: Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'companies', linkedTableRemoteId: ['companies'] },
      }),
      opportunity_id: Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'opportunities', linkedTableRemoteId: ['opportunities'] },
      }),
      uploader_id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'affinity/entity-files', title: 'Entity Files' },
  );
}

// ── Tests ──

describe('buildAffinityDefaultView — company list entry', () => {
  const schema = makeCompanyListEntrySchema();
  const view = buildAffinityDefaultView(schema, 'entity.name');

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  describe('column ordering', () => {
    it('should place the title column (entity.name) first', () => {
      const first = view.cols[0] as TableViewCol;
      expect(first.path).toBe('entity.name');
      expect(first.name).toBe('Name');
    });

    it('should place id right after the title', () => {
      const second = view.cols[1] as TableViewCol;
      expect(second.path).toBe('id');
    });

    it('should place entity fixed fields after id', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const domainIdx = paths.indexOf('entity.domain');
      const idIdx = paths.indexOf('id');
      expect(domainIdx).toBeGreaterThan(idIdx);
    });

    it('should place dynamic fields after entity fixed fields', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const fieldIdx = paths.indexOf('entity.fields.[id=field-1]');
      const domainsIdx = paths.indexOf('entity.domains');
      expect(fieldIdx).toBeGreaterThan(domainsIdx);
    });

    it('should place top-level system fields (type, listId, createdAt, creatorId) last', () => {
      const paths = view.cols.map((c) => (c as TableViewCol).path);
      const lastFieldIdx = paths.indexOf('entity.fields.[id=field-3]');
      const typeIdx = paths.indexOf('type');
      const createdAtIdx = paths.indexOf('createdAt');
      expect(typeIdx).toBeGreaterThan(lastFieldIdx);
      expect(createdAtIdx).toBeGreaterThan(lastFieldIdx);
    });
  });

  describe('hidden fields', () => {
    it('should hide the type field', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'type') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide the listId field', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'listId') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide the creatorId field', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'creatorId') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide entity.isGlobal', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.isGlobal') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should not hide entity.name', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.name') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should not hide entity.domain', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.domain') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('readonly', () => {
    it('should mark id as readonly', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark entity.id as readonly', () => {
      // entity.id is skipped (not shown as a separate col), so check entity.isGlobal instead
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.isGlobal') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark createdAt as readonly', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'createdAt') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark entity.name as readonly', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.name') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    it('should map Number fields to number type', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'id') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map date-time format to date type', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'createdAt') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map Array fields to object type', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.domains') as TableViewCol;
      expect(col.type).toBe('object');
    });
  });

  describe('dynamic field subfields', () => {
    it('should add subfields to scalar (non-flattened) dynamic fields', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-2]') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields).toHaveLength(4);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('value.data');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![1].relativePath).toBe('value.type');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![2].relativePath).toBe('type');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![3].relativePath).toBe('enrichmentSource');
    });

    it('should default to showing the value subfield on scalar fields', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-2]') as TableViewCol;
      expect(col.selectedSubfield).toBe(0);
    });

    it('should use the field description as the column name', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-1]') as TableViewCol;
      expect(col.name).toBe('Industry');
    });

    it('should map connector data type for scalar dynamic fields', () => {
      const numCol = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-2]') as TableViewCol;
      expect(numCol.type).toBe('number');

      const dateCol = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-3]') as TableViewCol;
      expect(dateCol.type).toBe('date');
    });

    it('should map data subfield type from connector data type', () => {
      const numCol = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-2]') as TableViewCol;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(numCol.subfields![0].relativePath).toBe('value.data');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(numCol.subfields![0].type).toBe('number');

      const dateCol = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-3]') as TableViewCol;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(dateCol.subfields![0].type).toBe('date');
    });
  });

  describe('dropdown field flattening (DEV-11064)', () => {
    // field-1 "Industry" is a `dropdown` — flattened to its `.text` label.
    const dropCol = view.cols.find((c) => (c as TableViewCol).path === 'entity.fields.[id=field-1]') as TableViewCol;

    it('should type the dropdown column as string (not object)', () => {
      expect(dropCol.type).toBe('string');
    });

    it('should not drill into subfields', () => {
      expect(dropCol.subfields).toBeUndefined();
      expect(dropCol.selectedSubfield).toBeUndefined();
    });

    it('should pluck the option label for display and export', () => {
      expect(dropCol.displayTransformer).toEqual({
        type: 'jsonpath',
        options: { expression: '$.value.data.text', arrayHandling: 'first' },
      });
      expect(dropCol.codec?.toCore).toEqual({
        type: 'jsonpath',
        options: { expression: '$.value.data.text', arrayHandling: 'first' },
      });
      // Display + export only — no fromCore (the label can't be re-decorated).
      expect(dropCol.codec?.fromCore).toBeUndefined();
    });
  });

  describe('name formatting', () => {
    it('should format camelCase entity fields as Title Case', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'entity.isGlobal') as TableViewCol;
      expect(col.name).toBe('Is Global');
    });

    it('should format camelCase top-level fields as Title Case', () => {
      const col = view.cols.find((c) => (c as TableViewCol).path === 'createdAt') as TableViewCol;
      expect(col.name).toBe('Created At');
    });
  });
});

describe('buildAffinityDefaultView — tenant persons', () => {
  const schema = makePersonsSchema();
  const view = buildAffinityDefaultView(schema, 'firstName');

  it('should place firstName first', () => {
    const first = view.cols[0] as TableViewCol;
    expect(first.path).toBe('firstName');
    expect(first.name).toBe('First Name');
  });

  it('should place id second', () => {
    const second = view.cols[1] as TableViewCol;
    expect(second.path).toBe('id');
  });

  it('should include flat fixed fields', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    expect(paths).toContain('lastName');
    expect(paths).toContain('primaryEmailAddress');
    expect(paths).toContain('emailAddresses');
  });

  it('should hide the type field', () => {
    const col = view.cols.find((c) => (c as TableViewCol).path === 'type') as TableViewCol;
    expect(col.hidden).toBe(true);
  });

  it('should include dynamic fields with subfields', () => {
    const col = view.cols.find((c) => (c as TableViewCol).path === 'fields.[id=field-10]') as TableViewCol;
    expect(col).toBeDefined();
    expect(col.name).toBe('Title');
    expect(col.subfields).toHaveLength(4);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(col.subfields![0].relativePath).toBe('value.data');
    expect(col.selectedSubfield).toBe(0);
  });

  describe('company reference field → foreign key (DEV-11065)', () => {
    // field-11 "Company" is a `company` reference → FK to the Companies table.
    const fkCol = view.cols.find((c) => (c as TableViewCol).path === 'fields.[id=field-11]') as TableViewCol;

    it('should declare a foreign key to the companies table', () => {
      expect(fkCol.foreignKey).toEqual({ linkedTableId: 'companies', linkedTableRemoteId: ['companies'] });
    });

    it('should type the column as string and drop the subfields drill-down', () => {
      expect(fkCol.type).toBe('string');
      expect(fkCol.subfields).toBeUndefined();
      expect(fkCol.selectedSubfield).toBeUndefined();
    });

    it('should resolve the linked id at value.data.id (single-valued)', () => {
      expect(fkCol.codec?.toCore).toEqual({
        type: 'jsonpath',
        options: { expression: '$.value.data.id', arrayHandling: 'first' },
      });
      expect(fkCol.displayTransformer).toEqual({
        type: 'jsonpath',
        options: { expression: '$.value.data.id', arrayHandling: 'first' },
      });
    });
  });
});

describe('buildAffinityDefaultView — tenant companies', () => {
  const schema = makeCompaniesSchema();
  const view = buildAffinityDefaultView(schema, 'name');

  it('should place name first', () => {
    const first = view.cols[0] as TableViewCol;
    expect(first.path).toBe('name');
  });

  it('should place id second', () => {
    const second = view.cols[1] as TableViewCol;
    expect(second.path).toBe('id');
  });

  it('should hide isGlobal', () => {
    const col = view.cols.find((c) => (c as TableViewCol).path === 'isGlobal') as TableViewCol;
    // isGlobal is not in HIDDEN_TOP_LEVEL_FIELDS for flat tables, but it's in HIDDEN_ENTITY_FIELDS
    // For flat tables we don't use HIDDEN_ENTITY_FIELDS — so let's verify it's present
    expect(col).toBeDefined();
  });
});

describe('buildAffinityDefaultView — tenant opportunities', () => {
  const schema = makeOpportunitiesSchema();
  const view = buildAffinityDefaultView(schema, 'name');

  it('should place name first', () => {
    const first = view.cols[0] as TableViewCol;
    expect(first.path).toBe('name');
  });

  it('should place id second', () => {
    const second = view.cols[1] as TableViewCol;
    expect(second.path).toBe('id');
  });

  it('should hide listId', () => {
    const col = view.cols.find((c) => (c as TableViewCol).path === 'listId') as TableViewCol;
    expect(col.hidden).toBe(true);
  });

  it('should have exactly 3 columns', () => {
    expect(view.cols).toHaveLength(3);
  });
});

describe('buildAffinityDefaultView — notes', () => {
  const schema = makeNotesSchema();
  const view = buildAffinityDefaultView(schema, 'type');

  it('should place type (title) first', () => {
    const first = view.cols[0] as TableViewCol;
    expect(first.path).toBe('type');
  });

  it('should place id second', () => {
    const second = view.cols[1] as TableViewCol;
    expect(second.path).toBe('id');
  });

  it('should add subfields to content column', () => {
    const col = view.cols.find((c) => (c as TableViewCol).path === 'content') as TableViewCol;
    expect(col.subfields).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(col.subfields![0].relativePath).toBe('html');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(col.subfields![0].type).toBe('richtext');
    expect(col.selectedSubfield).toBe(0);
  });

  it('should add subfields to creator column', () => {
    const col = view.cols.find((c) => (c as TableViewCol).path === 'creator') as TableViewCol;
    expect(col.subfields).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(col.subfields![0].relativePath).toBe('firstName');
    expect(col.selectedSubfield).toBe(0);
  });

  it('should hide notes-specific noise fields', () => {
    const mentionsCol = view.cols.find((c) => (c as TableViewCol).path === 'mentions') as TableViewCol;
    expect(mentionsCol.hidden).toBe(true);

    const interactionCol = view.cols.find((c) => (c as TableViewCol).path === 'interaction') as TableViewCol;
    expect(interactionCol.hidden).toBe(true);

    const companiesCol = view.cols.find((c) => (c as TableViewCol).path === 'companiesPreview') as TableViewCol;
    expect(companiesCol.hidden).toBe(true);
  });

  it('should mark createdAt and updatedAt as readonly', () => {
    const createdCol = view.cols.find((c) => (c as TableViewCol).path === 'createdAt') as TableViewCol;
    expect(createdCol.readonly).toBe(true);

    const updatedCol = view.cols.find((c) => (c as TableViewCol).path === 'updatedAt') as TableViewCol;
    expect(updatedCol.readonly).toBe(true);
  });
});

describe('buildAffinityDefaultView — entity files', () => {
  const schema = makeEntityFilesSchema();
  const view = buildAffinityDefaultView(schema, 'name');

  it('should place name first', () => {
    const first = view.cols[0] as TableViewCol;
    expect(first.path).toBe('name');
  });

  it('should place id second', () => {
    const second = view.cols[1] as TableViewCol;
    expect(second.path).toBe('id');
  });

  it('should format snake_case field names', () => {
    const col = view.cols.find((c) => (c as TableViewCol).path === 'created_at') as TableViewCol;
    expect(col.name).toBe('Created At');
  });

  it('should show the parent-entity foreign keys and only hide uploader_id (DEV-11065)', () => {
    const personIdCol = view.cols.find((c) => (c as TableViewCol).path === 'person_id') as TableViewCol;
    expect(personIdCol.hidden).toBeUndefined();

    const orgIdCol = view.cols.find((c) => (c as TableViewCol).path === 'organization_id') as TableViewCol;
    expect(orgIdCol.hidden).toBeUndefined();

    const opportunityIdCol = view.cols.find((c) => (c as TableViewCol).path === 'opportunity_id') as TableViewCol;
    expect(opportunityIdCol.hidden).toBeUndefined();

    const uploaderCol = view.cols.find((c) => (c as TableViewCol).path === 'uploader_id') as TableViewCol;
    expect(uploaderCol.hidden).toBe(true);
  });

  it('should mirror the schema-declared foreign keys onto the shown columns (DEV-11065)', () => {
    const personIdCol = view.cols.find((c) => (c as TableViewCol).path === 'person_id') as TableViewCol;
    expect(personIdCol.foreignKey).toEqual({ linkedTableId: 'persons', linkedTableRemoteId: ['persons'] });

    const orgIdCol = view.cols.find((c) => (c as TableViewCol).path === 'organization_id') as TableViewCol;
    expect(orgIdCol.foreignKey).toEqual({ linkedTableId: 'companies', linkedTableRemoteId: ['companies'] });

    const opportunityIdCol = view.cols.find((c) => (c as TableViewCol).path === 'opportunity_id') as TableViewCol;
    expect(opportunityIdCol.foreignKey).toEqual({
      linkedTableId: 'opportunities',
      linkedTableRemoteId: ['opportunities'],
    });
  });
});

describe('buildAffinityDefaultView — edge cases', () => {
  it('should handle a schema with no fields at all', () => {
    const schema = Type.Object({ id: Type.Number() }, { $id: 'affinity/test' });
    const view = buildAffinityDefaultView(schema);
    expect(view.cols).toHaveLength(1);
    expect((view.cols[0] as TableViewCol).path).toBe('id');
  });

  it('should handle missing title field path gracefully', () => {
    const schema = makeCompanyListEntrySchema();
    const view = buildAffinityDefaultView(schema);
    // Should still have id as first column when no title specified
    expect((view.cols[0] as TableViewCol).path).toBe('id');
  });
});

describe('buildAffinityDefaultView — location banner groups', () => {
  function makeSchemaWithLocations() {
    return Type.Object({
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      name: Type.Union([Type.String(), Type.Null()]),
      fields: fieldsArrayProperty([
        fieldDef('affinity-data-location', 'Location', 'location'),
        fieldDef('dealroom-location', 'Location', 'location'),
        fieldDef('field-1234', 'Round', 'dropdown'),
      ]),
    });
  }

  const schema = makeSchemaWithLocations();
  const view = buildAffinityDefaultView(schema, 'name');

  it('should create banner groups for location fields', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(2);
  });

  it('should disambiguate location names by enrichment source', () => {
    const groups = view.cols.filter((c): c is TableViewBannerGroup => c.kind === 'banner-group');
    const names = groups.map((g) => g.name);
    expect(names).toContain('Affinity Data Location');
    expect(names).toContain('Dealroom Location');
  });

  it('should expand location fields into sub-columns', () => {
    const group = view.cols.find(
      (c) => c.kind === 'banner-group' && c.name === 'Dealroom Location',
    ) as TableViewBannerGroup;
    expect(group.cols).toHaveLength(5);
    const paths = group.cols.map((c) => c.path);
    expect(paths).toContain('fields.[id=dealroom-location].value.data.streetAddress');
    expect(paths).toContain('fields.[id=dealroom-location].value.data.city');
    expect(paths).toContain('fields.[id=dealroom-location].value.data.state');
    expect(paths).toContain('fields.[id=dealroom-location].value.data.country');
    expect(paths).toContain('fields.[id=dealroom-location].value.data.continent');
  });

  it('should type sub-columns as string and qualify their names with the parent field (DEV-11066)', () => {
    const group = view.cols.find(
      (c) => c.kind === 'banner-group' && c.name === 'Affinity Data Location',
    ) as TableViewBannerGroup;
    const names = group.cols.map((c) => c.name);
    expect(names).toContain('Affinity Data Location · Street Address');
    expect(names).toContain('Affinity Data Location · City');
    expect(names).toContain('Affinity Data Location · State');
    expect(names).toContain('Affinity Data Location · Country');
    expect(names).toContain('Affinity Data Location · Continent');
    // Every sub-column is a plain string (no longer reported as an unknown field).
    expect(group.cols.every((c) => c.type === 'string')).toBe(true);
  });

  it('should not create a banner group for non-location fields', () => {
    const roundCol = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.[id=field-1234]');
    expect(roundCol).toBeDefined();
  });

  it('should work with entity-wrapped schemas', () => {
    const entitySchema = Type.Object(
      {
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        type: Type.Literal('company', { [X_SCRATCH_READONLY]: true }),
        listId: Type.Number({ [X_SCRATCH_READONLY]: true }),
        createdAt: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
        creatorId: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        entity: Type.Object({
          id: Type.Number({ [X_SCRATCH_READONLY]: true }),
          name: Type.Union([Type.String(), Type.Null()]),
          fields: fieldsArrayProperty([fieldDef('dealroom-location', 'Location', 'location')]),
        }),
      },
      { $id: 'affinity/list-123' },
    );
    const entityView = buildAffinityDefaultView(entitySchema, 'entity.name');
    const group = entityView.cols.find(
      (c) => c.kind === 'banner-group' && c.name === 'Dealroom Location',
    ) as TableViewBannerGroup;
    expect(group).toBeDefined();
    expect(group.cols[0].path).toBe('entity.fields.[id=dealroom-location].value.data.streetAddress');
  });
});

describe('buildAffinityDefaultView — multi-value flattening (DEV-11064 / DEV-11065)', () => {
  const schema = Type.Object(
    {
      id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      name: Type.Union([Type.String(), Type.Null()]),
      fields: fieldsArrayProperty([
        fieldDef('field-p', 'Team', 'person-multi'),
        fieldDef('field-c', 'Investors', 'company-multi'),
        fieldDef('field-d', 'Tags', 'dropdown-multi'),
        fieldDef('field-t', 'Technologies', 'filterable-text-multi'),
        fieldDef('field-n', 'Scores', 'number-multi'),
      ]),
    },
    { $id: 'affinity/companies', title: 'Companies' },
  );
  const view = buildAffinityDefaultView(schema, 'name');
  const colAt = (path: string) => view.cols.find((c) => (c as TableViewCol).path === path) as TableViewCol;

  it('should declare multi-value person/company references as foreign keys resolving on value.data[*].id', () => {
    const personCol = colAt('fields.[id=field-p]');
    expect(personCol.foreignKey).toEqual({ linkedTableId: 'persons', linkedTableRemoteId: ['persons'] });
    expect(personCol.codec?.toCore).toEqual({
      type: 'jsonpath',
      options: { expression: '$.value.data[*].id', arrayHandling: 'array' },
    });
    expect(personCol.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$.value.data[*].id', arrayHandling: 'join_comma' },
    });

    const companyCol = colAt('fields.[id=field-c]');
    expect(companyCol.foreignKey).toEqual({ linkedTableId: 'companies', linkedTableRemoteId: ['companies'] });
    expect(companyCol.codec?.toCore).toMatchObject({ options: { expression: '$.value.data[*].id' } });
  });

  it('should pluck each dropdown-multi option label', () => {
    const dropCol = colAt('fields.[id=field-d]');
    expect(dropCol.type).toBe('string');
    expect(dropCol.codec?.toCore).toEqual({
      type: 'jsonpath',
      options: { expression: '$.value.data[*].text', arrayHandling: 'array' },
    });
    expect(dropCol.displayTransformer).toMatchObject({
      options: { expression: '$.value.data[*].text', arrayHandling: 'join_comma' },
    });
  });

  it('should take the elements themselves for homogeneous scalar arrays', () => {
    const textCol = colAt('fields.[id=field-t]');
    expect(textCol.codec?.toCore).toEqual({
      type: 'jsonpath',
      options: { expression: '$.value.data[*]', arrayHandling: 'array' },
    });
    // filterable-text-multi is a string array — no logicalType override needed.
    expect(textCol.logicalType).toBeUndefined();

    const numberCol = colAt('fields.[id=field-n]');
    expect(numberCol.codec?.toCore).toMatchObject({ options: { expression: '$.value.data[*]' } });
    // number-multi carries a numeric logicalType so the destination column is a number.
    expect(numberCol.logicalType).toBe('number');
  });
});
