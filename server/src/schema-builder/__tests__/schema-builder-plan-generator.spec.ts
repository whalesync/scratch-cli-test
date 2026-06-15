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
