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

  it('resolves a foreignKey to a sibling source as an in-plan ref', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [authors, posts],
      destinationConnectorAccountId: 'destConn',
    });

    const postsTable = tables.find((table) => table.ref === 'posts');
    expect(postsTable).toBeDefined();
    // id column is skipped; title + author remain.
    expect(postsTable?.fields.map((f) => f.name)).toEqual(['title', 'author']);
    const authorField = postsTable?.fields.find((f) => f.name === 'author');
    expect(authorField?.fieldType).toEqual({ kind: 'foreignKey', target: { ref: 'authors' } });

    const titleField = postsTable?.fields.find((f) => f.name === 'title');
    expect(titleField?.isPrimary).toBe(true);

    const authorNote = notes.find((note) => note.sourceFieldPath === 'author');
    expect(authorNote).toMatchObject({ status: 'mapped', mappedKind: 'foreignKey' });
  });

  it('flags an unresolvable foreignKey as unsupported and omits the field', () => {
    const orphan: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblMissing' } })],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [orphan],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables[0].fields).toHaveLength(0);
    expect(notes.find((note) => note.sourceFieldPath === 'author')).toMatchObject({ status: 'unsupported' });
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

  const authorsIntoExisting = (fieldNames: string[]): PlanGeneratorSource => ({
    ...authorsSource,
    existingDestination: { dataFolderId: 'destAuthors', remoteTableId: ['tblDestAuthors'], fieldNames },
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
    // id is skipped (destination owns it); 'name' already exists; bio + age remain.
    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['bio', 'age']);
    expect(notes.find((note) => note.fieldName === 'name')).toMatchObject({ status: 'exists' });
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
    // Every source field surfaced as an 'exists' note — nothing dropped silently.
    expect(notes.filter((note) => note.status === 'exists')).toHaveLength(3);
  });

  it('downgrades a sibling-ref foreignKey to unsupported when adding to an existing table', () => {
    const postsIntoExisting: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblAuthors' } })],
      existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], fieldNames: [] },
    };
    // authorsSource registers tblAuthors as a sibling, so the FK would otherwise resolve to { ref }.
    const { tables, fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [authorsSource, postsIntoExisting],
      destinationConnectorAccountId: 'destConn',
    });

    // Mixed: authors is a new table, posts is an add-fields plan.
    expect(tables.map((table) => table.ref)).toEqual(['authors']);
    const postsPlan = fieldPlans.find((plan) => plan.sourceDataFolderId === 'posts');
    expect(postsPlan?.fields).toHaveLength(0);
    expect(notes.find((note) => note.sourceFieldPath === 'author')).toMatchObject({ status: 'unsupported' });
  });

  it('keeps a linkedTableMappings foreignKey as existingRemoteTableId in a fieldPlan', () => {
    const postsIntoExisting: PlanGeneratorSource = {
      ref: 'posts',
      dataFolderId: 'posts',
      tableName: 'Posts',
      remoteTableIds: ['tblPosts'],
      schemaFields: [field({ path: 'author', type: 'string', foreignKey: { linkedTableId: 'tblExternal' } })],
      existingDestination: { dataFolderId: 'destPosts', remoteTableId: ['tblDestPosts'], fieldNames: [] },
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
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Email' }),
        field({ path: 'b', type: 'string', displayLabel: 'Email' }),
      ],
    };
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });

    expect(tables[0].fields.map((f) => f.name)).toEqual(['Email', 'Email 2']);
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
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Name' }),
        field({ path: 'b', type: 'string', displayLabel: 'name' }),
      ],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables[0].fields.map((f) => f.name)).toEqual(['Name', 'name 2']);
  });

  it('dedupes field names independently per table (same name across tables is fine)', () => {
    const t1: PlanGeneratorSource = {
      ref: 't1',
      dataFolderId: 't1',
      tableName: 'T1',
      remoteTableIds: ['tbl1'],
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: 'Name' })],
    };
    const t2: PlanGeneratorSource = {
      ref: 't2',
      dataFolderId: 't2',
      tableName: 'T2',
      remoteTableIds: ['tbl2'],
      schemaFields: [field({ path: 'a', type: 'string', displayLabel: 'Name' })],
    };
    const { tables } = generateCreatePlanFromSources({
      sources: [t1, t2],
      destinationConnectorAccountId: 'destConn',
    });
    expect(tables.find((t) => t.ref === 't1')?.fields.map((f) => f.name)).toEqual(['Name']);
    expect(tables.find((t) => t.ref === 't2')?.fields.map((f) => f.name)).toEqual(['Name']);
  });

  it('suffixes a duplicate NEW field while still skipping one that matches an existing destination field', () => {
    const source: PlanGeneratorSource = {
      ref: 'contacts',
      dataFolderId: 'contacts',
      tableName: 'Contacts',
      remoteTableIds: ['tblContacts'],
      schemaFields: [
        field({ path: 'a', type: 'string', displayLabel: 'Name' }), // already on destination → skipped
        field({ path: 'b', type: 'string', displayLabel: 'Color' }), // new → Color
        field({ path: 'c', type: 'string', displayLabel: 'Color' }), // duplicate new → Color 2
      ],
      existingDestination: { dataFolderId: 'destContacts', remoteTableId: ['tblDest'], fieldNames: ['Name'] },
    };
    const { fieldPlans, notes } = generateCreatePlanFromSources({
      sources: [source],
      destinationConnectorAccountId: 'destConn',
    });

    expect(fieldPlans[0].fields.map((f) => f.name)).toEqual(['Color', 'Color 2']);
    expect(notes.find((note) => note.sourceFieldPath === 'a')).toMatchObject({ status: 'exists' });
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
      existingDestination: { dataFolderId: 'destContacts', remoteTableId: ['tblDest'], fieldNames: ['Color 2'] },
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
