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

  it('downgrades complex and read-only fields to text', () => {
    expect(inferLogicalFieldType(field({ path: 'o', type: 'object' }))).toMatchObject({
      status: 'downgraded',
      fieldType: { kind: 'text' },
    });
    expect(inferLogicalFieldType(field({ path: 'r', type: 'string', readonly: true }))).toMatchObject({
      status: 'downgraded',
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
    const { tables, notes } = generateCreatePlanFromSources({ sources: [authors, posts] });

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
    const { tables, notes } = generateCreatePlanFromSources({ sources: [orphan] });

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
      linkedTableMappings: [{ sourceLinkedTableId: 'tblExternal', destinationRemoteTableId: ['destTbl'] }],
    });

    expect(tables[0].fields[0].fieldType).toEqual({
      kind: 'foreignKey',
      target: { existingRemoteTableId: ['destTbl'] },
    });
  });
});
