import type { SchemaField } from 'src/utils/schema-helpers';
import {
  generateCreatePlanFromSources,
  inferLogicalFieldType,
  PlanGeneratorSource,
} from '../schema-builder-plan-generator';

const field = (overrides: Partial<SchemaField> & { path: string }): SchemaField => ({
  type: 'string',
  ...overrides,
});

describe('inferLogicalFieldType', () => {
  it('maps primitives from the JSON-Schema type', () => {
    expect(inferLogicalFieldType(field({ path: 'b', type: 'boolean' }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'boolean' },
    });
    expect(inferLogicalFieldType(field({ path: 'i', type: 'integer' }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'number', format: 'integer' },
    });
    expect(inferLogicalFieldType(field({ path: 'n', type: 'number' })).fieldType).toEqual({ kind: 'number' });
    expect(inferLogicalFieldType(field({ path: 's', type: 'string' })).fieldType).toEqual({ kind: 'text' });
  });

  it('downgrades structurally complex (object/array) fields to text', () => {
    expect(inferLogicalFieldType(field({ path: 'o', type: 'object' }))).toMatchObject({
      status: 'downgraded',
      fieldType: { kind: 'text' },
    });
    expect(inferLogicalFieldType(field({ path: 'a', type: 'array' }))).toMatchObject({
      status: 'downgraded',
      fieldType: { kind: 'text' },
    });
  });

  it('keeps read-only fields at their real type instead of downgrading to text', () => {
    // This tool copies a table for a sync, so a read-only source field becomes an
    // editable destination column of the SAME logical type (e.g. a read-only
    // last_edited_time stays a date), not a text field.
    expect(inferLogicalFieldType(field({ path: 'rn', type: 'number', readonly: true }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'number' },
    });
    expect(inferLogicalFieldType(field({ path: 'rd', type: 'string', readonly: true }), 'date')).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'date' },
    });
    expect(inferLogicalFieldType(field({ path: 'rs', type: 'string', readonly: true }))).toMatchObject({
      status: 'mapped',
      fieldType: { kind: 'text' },
    });
  });

  it('prefers a TablePropertyType view hint when present', () => {
    expect(inferLogicalFieldType(field({ path: 'd', type: 'string' }), 'date').fieldType).toEqual({ kind: 'date' });
    expect(inferLogicalFieldType(field({ path: 'u', type: 'string' }), 'url').fieldType).toEqual({ kind: 'url' });
    expect(inferLogicalFieldType(field({ path: 'rt', type: 'string' }), 'richtext').fieldType).toEqual({
      kind: 'longText',
    });
    expect(inferLogicalFieldType(field({ path: 'c', type: 'string' }), 'checkbox').fieldType).toEqual({
      kind: 'boolean',
    });
  });
});

describe('generateCreatePlanFromSources', () => {
  const authors: PlanGeneratorSource = {
    ref: 'authors',
    dataFolderId: 'authors',
    tableName: 'Authors',
    remoteTableIds: ['tblAuthors'],
    primaryFieldPath: 'name',
    schemaFields: [field({ path: 'name', type: 'string' })],
  };
  const posts: PlanGeneratorSource = {
    ref: 'posts',
    dataFolderId: 'posts',
    tableName: 'Posts',
    remoteTableIds: ['tblPosts'],
    idFieldPath: 'id',
    primaryFieldPath: 'title',
    schemaFields: [
      field({ path: 'id', type: 'string' }),
      field({ path: 'title', type: 'string' }),
      field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblAuthors' } }),
    ],
  };

  it('renames a field that collides with a destination reserved name (Postgres auto "id")', () => {
    const colors: PlanGeneratorSource = {
      ref: 'colors',
      dataFolderId: 'colors',
      tableName: 'Colors',
      remoteTableIds: ['tblColors'],
      primaryFieldPath: 'name',
      // "ID" folds to the reserved "id"; without the rename it is dropped at create (the Postgres
      // connector rejects it) and then unresolvable at apply. Case-insensitive.
      schemaFields: [field({ path: 'name', type: 'string' }), field({ path: 'ID', type: 'string' })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [colors],
      destinationConnectorAccountId: 'destConn',
      destinationReservedFieldNames: ['id'],
    });

    const table = tables.find((t) => t.ref === 'colors');
    expect(table?.fields.map((f) => f.name)).toContain('ID 2');
    expect(table?.fields.map((f) => f.name)).not.toContain('ID');
    const idNote = notes.find((n) => n.sourceFieldPath === 'ID');
    expect(idNote?.fieldName).toBe('ID 2');
    expect(idNote?.renamedFromName).toBe('ID');
    expect(idNote?.message).toContain('reserved by the destination');
  });

  it('resolves a foreignKey to a sibling source as an in-plan ref', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [authors, posts],
      destinationConnectorAccountId: 'destConn',
    });

    const postsTable = tables.find((table) => table.ref === 'posts');
    expect(postsTable).toBeDefined();
    // id column is skipped; title + author remain, plus the injected source-record-id
    // field (generic name here since this source has no connectorService).
    expect(postsTable?.fields.map((f) => f.name)).toEqual(['title', 'author', 'source_record_id']);
    const authorField = postsTable?.fields.find((f) => f.name === 'author');
    expect(authorField?.fieldType).toEqual({ kind: 'foreignKey', target: { ref: 'authors' } });

    const titleField = postsTable?.fields.find((f) => f.name === 'title');
    expect(titleField?.isPrimary).toBe(true);

    const authorNote = notes.find((note) => note.sourceFieldPath === 'author');
    expect(authorNote).toMatchObject({ status: 'mapped', mappedKind: 'foreignKey' });
  });

  it('emits an unresolvable foreignKey as needs_target with a pending target (not dropped)', () => {
    const orphan: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      idFieldPath: 'id',
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblMissing' } })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [orphan],
      destinationConnectorAccountId: 'destConn',
    });

    // The FK is kept as an available field carrying a pending target (alongside the
    // injected source-record-id), not silently omitted.
    expect(tables[0].fields.map((f) => f.name)).toEqual(['author', 'source_record_id']);
    expect(tables[0].fields.find((f) => f.name === 'author')?.fieldType).toEqual({
      kind: 'foreignKey',
      target: { unresolvedLinkedTableId: 'tblMissing' },
    });
    expect(notes.find((note) => note.sourceFieldPath === 'author')).toMatchObject({
      status: 'needs_target',
      mappedKind: 'foreignKey',
      sourceLinkedTableId: 'tblMissing',
    });
  });

  it('resolves a foreignKey via linkedTableMappings to an existing remote table', () => {
    const orphan: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblExternal' } })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [orphan],
      destinationConnectorAccountId: 'destConn',
      linkedTableMappings: [{ sourceLinkedTableId: 'tblExternal', destinationRemoteTableId: ['destTbl'] }],
    });

    expect(tables[0].fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { existingRemoteTableId: ['destTbl'] },
    });
  });
});

describe('generateCreatePlanFromSources — injected source-record-id field', () => {
  const sourceWith = (overrides: Partial<PlanGeneratorSource>): PlanGeneratorSource => ({
    ref: 'posts',
    dataFolderId: 'posts',
    tableName: 'Posts',
    remoteTableIds: ['tblPosts'],
    idFieldPath: 'id',
    schemaFields: [field({ path: 'id', type: 'string' }), field({ path: 'title', type: 'string' })],
    ...overrides,
  });

  it('injects a text field named for the source connector service, marked isSourceRecordId', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES' })],
      destinationConnectorAccountId: 'destConn',
    });

    const injected = tables[0].fields.find((f) => f.name === 'postgres_record_id');
    expect(injected).toEqual({
      name: 'postgres_record_id',
      fieldType: { kind: 'text' },
      description: 'Remote id of the source record this row was synced from.',
      isSourceRecordId: true,
    });
    // It is bookkeeping-only — never the DB-level required flag, never primary.
    expect(injected?.required).toBeUndefined();
    expect(injected?.isPrimary).toBeUndefined();
  });

  it('disambiguates with a _source_ infix when source and destination are the same service', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES' })],
      destinationConnectorAccountId: 'destConn',
      destinationConnectorService: 'POSTGRES',
    });
    expect(tables[0].fields.some((f) => f.name === 'postgres_source_record_id' && f.isSourceRecordId)).toBe(true);
    expect(tables[0].fields.some((f) => f.name === 'postgres_record_id')).toBe(false);
  });

  it('keeps the plain name when source and destination services differ', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES' })],
      destinationConnectorAccountId: 'destConn',
      destinationConnectorService: 'AIRTABLE',
    });
    expect(tables[0].fields.some((f) => f.name === 'postgres_record_id' && f.isSourceRecordId)).toBe(true);
  });

  it('falls back to a generic name when the source has no connector service', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWith({})],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables[0].fields.some((f) => f.name === 'source_record_id' && f.isSourceRecordId)).toBe(true);
  });

  it('does not inject when a same-named field already exists on the source (case-insensitive)', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        sourceWith({
          connectorService: 'POSTGRES',
          schemaFields: [field({ path: 'id', type: 'string' }), field({ path: 'Postgres_Record_Id', type: 'string' })],
        }),
      ],
      destinationConnectorAccountId: 'destConn',
    });
    const matching = tables[0].fields.filter((f) => f.name.toLowerCase() === 'postgres_record_id');
    expect(matching).toHaveLength(1);
    // The pre-existing source field is left as-is — not relabelled as the source id.
    expect(matching[0].isSourceRecordId).toBeUndefined();
  });

  it('emits a mapped note feeding the injected field from the source remote-id path', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES', idFieldPath: 'id.record_id' })],
      destinationConnectorAccountId: 'destConn',
    });
    const injected = tables[0].fields.find((f) => f.isSourceRecordId);
    expect(injected?.name).toBe('postgres_record_id');
    // The note pairs the source's idPath path with the injected field name,
    // so the client/sync knows where to source this column's value from.
    expect(notes.find((note) => note.fieldName === 'postgres_record_id')).toEqual({
      sourceDataFolderId: 'posts',
      sourceFieldPath: 'id.record_id',
      fieldName: 'postgres_record_id',
      status: 'mapped',
      mappedKind: 'text',
    });
  });

  it('does not inject (or emit a note) when the source has no remote-id path', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [sourceWith({ connectorService: 'POSTGRES', idFieldPath: undefined })],
      destinationConnectorAccountId: 'destConn',
    });
    // No source identity to preserve -> no point creating the field.
    expect(tables[0].fields.some((f) => f.isSourceRecordId)).toBe(false);
    expect(tables[0].fields.some((f) => f.name === 'postgres_record_id')).toBe(false);
    expect(notes.some((note) => note.fieldName === 'postgres_record_id')).toBe(false);
  });

  it('does not inject into an add-fields plan for an existing destination table', () => {
    const { tables, fieldPlans } = generateCreatePlanFromSources({
      sources: [
        sourceWith({
          connectorService: 'POSTGRES',
          existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], existingFields: [] },
        }),
      ],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables).toHaveLength(0);
    expect(fieldPlans[0].fields.some((f) => f.isSourceRecordId)).toBe(false);
  });
});

describe('generateCreatePlanFromSources — existing destination table (add-fields diff)', () => {
  // A source whose destination table already exists yields an add-fields plan: the
  // source fields diffed against the destination's current fields, never a new table.
  const authorsSource: PlanGeneratorSource = {
    ref: 'authors',
    dataFolderId: 'authors',
    tableName: 'Authors',
    remoteTableIds: ['tblAuthors'],
    primaryFieldPath: 'name',
    idFieldPath: 'id',
    schemaFields: [
      field({ path: 'id', type: 'string' }),
      field({ path: 'name', type: 'string' }),
      field({ path: 'bio', type: 'string' }),
      field({ path: 'age', type: 'integer' }),
    ],
  };

  // Each existing destination field is given the kind of the same-named source
  // field, so a name match is a kind match → adoption (the re-add case).
  const authorsIntoExisting = (existingNames: string[]): PlanGeneratorSource => ({
    ...authorsSource,
    existingDestination: {
      dataFolderId: 'destAuthors',
      remoteTableId: ['tblDestAuthors'],
      existingFields: existingNames.map((name) => {
        const sourceField = authorsSource.schemaFields.find(
          (f) => (f.displayLabel ?? f.path.split('.').pop() ?? '').toLowerCase() === name.trim().toLowerCase(),
        );
        return {
          name,
          columnPath: name.trim().toLowerCase(),
          kind: sourceField ? inferLogicalFieldType(sourceField).fieldType.kind : 'text',
        };
      }),
    },
  });

  it('emits a fieldPlan (not a table) and drops fields the destination already has', () => {
    const { tables, fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['name'])],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables).toHaveLength(0);
    expect(fieldPlans).toHaveLength(1);
    expect(fieldPlans[0]).toMatchObject({
      sourceDataFolderId: 'authors',
      destinationDataFolderId: 'destAuthors',
      connectorAccountId: 'destConn',
      remoteTableId: ['tblDestAuthors'],
    });
    // id is skipped (destination owns it); 'name' already exists (adopted); bio + age remain.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['bio', 'age']);
    expect(notes.find((note) => note.fieldName === 'name')).toMatchObject({
      status: 'adopted',
      mappedKind: 'text',
      existingDestinationColumnId: 'name',
    });
  });

  it('matches existing field names case-insensitively', () => {
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['NAME', ' Bio '])],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['age']);
  });

  it('does not re-designate a primary field on an existing table', () => {
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting([])],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['name', 'bio', 'age']);
    expect(fieldPlans[0].fields.every((f) => f.isPrimary === undefined)).toBe(true);
  });

  it('still yields a fieldPlan with no fields when the destination already has everything', () => {
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['name', 'bio', 'age'])],
      destinationConnectorAccountId: 'destConn',
    });
    expect(fieldPlans).toHaveLength(1);
    expect(fieldPlans[0].fields).toHaveLength(0);
    // Every source field has a same-kind match on the destination → all adopted,
    // nothing dropped silently.
    expect(notes.filter((note) => note.status === 'adopted')).toHaveLength(3);
  });

  it('adopts an existing destination field of the same name and kind (maps to it, does not recreate)', () => {
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsIntoExisting(['bio'])],
      destinationConnectorAccountId: 'destConn',
    });
    // bio is adopted (text → text), so it's not in the create list; name + age are.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['name', 'age']);
    expect(notes.find((note) => note.fieldName === 'bio')).toMatchObject({
      status: 'adopted',
      mappedKind: 'text',
      existingDestinationColumnId: 'bio',
    });
  });

  it('does not adopt an existing field of the same name but a different kind — skips it instead', () => {
    // The destination "age" is text, but the source "age" is a number → can't adopt.
    const source: PlanGeneratorSource = {
      ...authorsSource,
      existingDestination: {
        dataFolderId: 'destAuthors',
        remoteTableId: ['tblDestAuthors'],
        existingFields: [{ name: 'age', columnPath: 'age', kind: 'text' }],
      },
    };
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });
    // age is neither created (name collision) nor adopted (kind mismatch) → exists.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['name', 'bio']);
    expect(notes.find((note) => note.fieldName === 'age')).toMatchObject({ status: 'exists' });
  });

  it('emits a sibling-ref foreignKey as needs_target when adding to an existing table', () => {
    const postsIntoExisting: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblAuthors' } })],
      existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], existingFields: [] },
    };
    // authorsSource registers tblAuthors as a sibling; a sibling { ref } can't be added
    // to an existing table via /schema/fields, so it's emitted with a pending target to
    // be bound to an existing remote table rather than dropped.
    const { tables, fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsSource, postsIntoExisting],
      destinationConnectorAccountId: 'destConn',
    });

    // Mixed: authors is a new table, posts is an add-fields plan.
    expect(tables.map((table) => table.ref)).toEqual(['authors']);
    const postsPlan = fieldPlans.find((plan) => plan.sourceDataFolderId === 'posts');
    expect(postsPlan?.fields).toHaveLength(1);
    expect(postsPlan?.fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { unresolvedLinkedTableId: 'tblAuthors' },
    });
    expect(notes.find((note) => note.sourceFieldPath === 'author')).toMatchObject({
      status: 'needs_target',
      sourceLinkedTableId: 'tblAuthors',
    });
  });

  it('keeps a linkedTableMappings foreignKey as existingRemoteTableId in a fieldPlan', () => {
    const postsIntoExisting: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblExternal' } })],
      existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], existingFields: [] },
    };
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [postsIntoExisting],
      destinationConnectorAccountId: 'destConn',
      linkedTableMappings: [{ sourceLinkedTableId: 'tblExternal', destinationRemoteTableId: ['destTbl'] }],
    });

    expect(fieldPlans[0].fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { existingRemoteTableId: ['destTbl'] },
    });
  });
});

describe('generateCreatePlanFromSources — duplicate field names (DEV-10441)', () => {
  it('suffixes a duplicate field name within a table and records renamedFromName', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      idFieldPath: 'id',
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Email' }),
        field({ path: 'b', type: 'string', displayLabel: 'Email' }),
      ],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables[0].fields.map((f) => f.name)).toEqual(['Email', 'Email 2', 'source_record_id']);
    const renamedNote = notes.find((note) => note.sourceFieldPath === 'b');
    expect(renamedNote).toMatchObject({ fieldName: 'Email 2', renamedFromName: 'Email', status: 'mapped' });
    expect(renamedNote?.message).toContain('renamed from "Email"');
  });

  it('treats duplicate field names case-insensitively', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      idFieldPath: 'id',
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Name' }),
        field({ path: 'b', type: 'string', displayLabel: 'name' }),
      ],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables[0].fields.map((f) => f.name)).toEqual(['Name', 'name 2', 'source_record_id']);
  });

  it('dedupes field names independently per table (same name across tables is fine)', () => {
    const t1: PlanGeneratorSource = {
      ref: 't1',
      dataFolderId: 't1',
      tableName: 'T1',
      remoteTableIds: ['tbl1'],
      idFieldPath: 'id',
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: 'Name' })],
    };
    const t2: PlanGeneratorSource = {
      ref: 't2',
      dataFolderId: 't2',
      tableName: 'T2',
      remoteTableIds: ['tbl2'],
      idFieldPath: 'id',
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: 'Name' })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [t1, t2],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables.find((t) => t.ref === 't1')?.fields.map((f) => f.name)).toEqual(['Name', 'source_record_id']);
    expect(tables.find((t) => t.ref === 't2')?.fields.map((f) => f.name)).toEqual(['Name', 'source_record_id']);
  });

  it('suffixes a duplicate NEW field while still skipping one that matches an existing destination field', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Name' }), // already on destination → adopted
        field({ path: 'b', type: 'string', displayLabel: 'Color' }), // new → Color
        field({ path: 'c', type: 'string', displayLabel: 'Color' }), // duplicate new → Color 2
      ],
      existingDestination: {
        dataFolderId: 'destContacts',
        remoteTableId: ['tblDest'],
        existingFields: [{ name: 'Name', columnPath: 'Name', kind: 'text' }],
      },
    };
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });

    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['Color', 'Color 2']);
    expect(notes.find((note) => note.sourceFieldPath === 'a')).toMatchObject({ status: 'adopted' });
    expect(notes.find((note) => note.sourceFieldPath === 'c')).toMatchObject({
      fieldName: 'Color 2',
      renamedFromName: 'Color',
    });
  });

  it('suffixes around an existing destination field name when deduping new fields', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      schemaFields: [
        field({ path: 'b', type: 'string', displayLabel: 'Color' }),
        field({ path: 'c', type: 'string', displayLabel: 'Color' }),
      ],
      existingDestination: {
        dataFolderId: 'destContacts',
        remoteTableId: ['tblDest'],
        existingFields: [{ name: 'Color 2', columnPath: 'Color 2', kind: 'text' }],
      },
    };
    const { fieldPlans } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });
    // 'Color' is free; the duplicate skips the existing 'Color 2' and becomes 'Color 3'.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['Color', 'Color 3']);
  });
});

describe('generateCreatePlanFromSources — duplicate table names (DEV-10441)', () => {
  const makeSource = (ref: string, tableName: string): PlanGeneratorSource => ({
    ref,
    dataFolderId: ref,
    tableName,
    remoteTableIds: [`tbl_${ref}`],
    schemaFields: [field({ path: 'name', type: 'string' })],
  });

  it('suffixes a table name that duplicates another new table in the same plan', () => {
    const { tables, tableNotes } = generateCreatePlanFromSources({
      sources: [makeSource('a', 'Tasks'), makeSource('b', 'Tasks')],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables.map((t) => t.name)).toEqual(['Tasks', 'Tasks 2']);
    // refs are preserved despite the rename, so FK wiring is unaffected.
    expect(tables.map((t) => t.ref)).toEqual(['a', 'b']);
    expect(tableNotes).toHaveLength(1);
    expect(tableNotes[0]).toMatchObject({
      ref: 'b',
      tableName: 'Tasks 2',
      renamedFromName: 'Tasks',
      reason: 'duplicate_in_plan',
    });
  });

  it('suffixes a table name that conflicts with an existing destination table', () => {
    const { tables, tableNotes } = generateCreatePlanFromSources({
      sources: [makeSource('a', 'Tasks')],
      destinationConnectorAccountId: 'destConn',
      existingDestinationTableNames: ['tasks'], // case-insensitive
    });

    expect(tables.map((t) => t.name)).toEqual(['Tasks 2']);
    expect(tableNotes[0]).toMatchObject({
      tableName: 'Tasks 2',
      renamedFromName: 'Tasks',
      reason: 'conflicts_with_existing_table',
    });
  });

  it('emits no table note when no rename is needed', () => {
    const { tables, tableNotes } = generateCreatePlanFromSources({
      sources: [makeSource('a', 'Tasks'), makeSource('b', 'Notes')],
      destinationConnectorAccountId: 'destConn',
      existingDestinationTableNames: ['Other'],
    });

    expect(tables.map((t) => t.name)).toEqual(['Tasks', 'Notes']);
    expect(tableNotes).toEqual([]);
  });
});

describe('generateCreatePlanFromSources — fallback primary field', () => {
  // A source that designated NO title column (no primaryFieldPath), as happens
  // when a Postgres table's headline column isn't named name/title/etc.
  const sourceWithoutTitleColumn = (schemaFields: SchemaField[]): PlanGeneratorSource => ({
    ref: 'people',
    dataFolderId: 'people',
    tableName: 'People',
    remoteTableIds: ['tblPeople'],
    schemaFields,
  });

  const primaryFieldNames = (table: { fields: { name: string; isPrimary?: boolean }[] }): string[] =>
    table.fields.filter((f) => f.isPrimary).map((f) => f.name);

  it('promotes the highest-priority primary-sounding field when the destination requires one', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        sourceWithoutTitleColumn([
          field({ path: 'created_at', type: 'string' }),
          field({ path: 'bio', type: 'string' }),
          field({ path: 'full_name', type: 'string' }),
        ]),
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    // `full_name` (normalizes to a listed candidate) wins over the non-candidate
    // `created_at`/`bio`, even though it comes last in column order.
    expect(primaryFieldNames(tables[0])).toEqual(['full_name']);
  });

  it('falls back to the first eligible field in column order when no name matches', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        sourceWithoutTitleColumn([field({ path: 'bio', type: 'string' }), field({ path: 'website', type: 'string' })]),
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    expect(primaryFieldNames(tables[0])).toEqual(['bio']);
  });

  it('only considers fields of an allowed kind, overriding name priority', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [
        sourceWithoutTitleColumn([
          // Best name, but a number kind Notion can't use as its title.
          field({ path: 'title', type: 'number' }),
          field({ path: 'description', type: 'string' }),
        ]),
      ],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
      destinationPrimaryFieldKinds: ['text', 'longText'],
    });

    expect(primaryFieldNames(tables[0])).toEqual(['description']);
  });

  it('does not promote a primary when the destination does not require one', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [sourceWithoutTitleColumn([field({ path: 'full_name', type: 'string' })])],
      destinationConnectorAccountId: 'destConn',
    });

    expect(primaryFieldNames(tables[0])).toEqual([]);
  });

  it('keeps the source-designated primary and never marks a second', () => {
    const source: PlanGeneratorSource = {
      ref: 'people',
      dataFolderId: 'people',
      tableName: 'People',
      remoteTableIds: ['tblPeople'],
      primaryFieldPath: 'handle',
      schemaFields: [field({ path: 'handle', type: 'string' }), field({ path: 'name', type: 'string' })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      destinationRequiresPrimaryField: true,
    });

    // `handle` was the source's title column; `name` is NOT also promoted even
    // though it's a stronger candidate name.
    expect(primaryFieldNames(tables[0])).toEqual(['handle']);
  });

  it('leaves a degenerate table (only an id and a link) without a primary', () => {
    const source: PlanGeneratorSource = {
      ref: 'joins',
      dataFolderId: 'joins',
      tableName: 'Joins',
      remoteTableIds: ['tblJoins'],
      idFieldPath: 'id',
      schemaFields: [
        field({ path: 'id', type: 'string' }),
        field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblPeople' } }),
      ],
      connectorService: 'POSTGRES',
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
      // A foreignKey is allowed as a kind here, but it's still never primary-eligible.
      destinationRequiresPrimaryField: true,
      linkedTableMappings: [{ sourceLinkedTableId: 'tblPeople', destinationRemoteTableId: ['tblPeopleDest'] }],
    });

    // Only the link + injected source-record-id remain; neither is primary-eligible.
    expect(primaryFieldNames(tables[0])).toEqual([]);
  });
});
