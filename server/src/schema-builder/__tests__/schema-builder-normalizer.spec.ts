import { CreateSchemaTablesDto, createSchemaTablesSchema } from '@spinner/shared-types';
import { normalizeCreateSchema } from '../schema-builder-normalizer';

function parse(body: unknown): CreateSchemaTablesDto {
  const parsed = createSchemaTablesSchema.safeParse(body);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

const baseTable = (ref: string, name: string, fields: unknown[]) => ({ ref, name, fields });
const fkRef = (name: string, ref: string) => ({ name, fieldType: { kind: 'foreignKey', target: { ref } } });

describe('normalizeCreateSchema', () => {
  it('orders a dependency before its dependent and keeps the cross-table FK', () => {
    const plan = normalizeCreateSchema(
      parse({
        connectorAccountId: 'c',
        tables: [
          baseTable('posts', 'Posts', [{ name: 'Title', fieldType: { kind: 'text' } }, fkRef('Author', 'authors')]),
          baseTable('authors', 'Authors', [{ name: 'Name', fieldType: { kind: 'text' } }]),
        ],
      }),
    );

    const order = plan.tablesInCreationOrder.map((table) => table.ref);
    expect(order.indexOf('authors')).toBeLessThan(order.indexOf('posts'));

    const posts = plan.tablesInCreationOrder.find((table) => table.ref === 'posts');
    expect(posts?.deferredFkFields).toHaveLength(0);
    expect(posts?.fields.some((field) => field.fieldType.kind === 'foreignKey')).toBe(true);
    expect(plan.tablesInCreationOrder.every((table) => table.deferredFkFields.length === 0)).toBe(true);
  });

  it('breaks a cycle by deferring exactly one foreignKey field', () => {
    const plan = normalizeCreateSchema(
      parse({
        connectorAccountId: 'c',
        tables: [
          baseTable('a', 'A', [{ name: 'x', fieldType: { kind: 'text' } }, fkRef('toB', 'b')]),
          baseTable('b', 'B', [{ name: 'y', fieldType: { kind: 'text' } }, fkRef('toA', 'a')]),
        ],
      }),
    );

    expect(plan.tablesInCreationOrder.map((table) => table.ref).sort()).toEqual(['a', 'b']);
    const deferredTotal = plan.tablesInCreationOrder.reduce((sum, table) => sum + table.deferredFkFields.length, 0);
    expect(deferredTotal).toBe(1);
  });

  it('defers a self-referential foreignKey', () => {
    const plan = normalizeCreateSchema(
      parse({
        connectorAccountId: 'c',
        tables: [baseTable('a', 'A', [{ name: 'x', fieldType: { kind: 'text' } }, fkRef('parent', 'a')])],
      }),
    );

    const a = plan.tablesInCreationOrder.find((table) => table.ref === 'a');
    expect(a?.deferredFkFields).toHaveLength(1);
    expect(a?.fields.some((field) => field.fieldType.kind === 'foreignKey')).toBe(false);
  });

  it('keeps a foreignKey to an already-existing remote table inline (no dependency)', () => {
    const plan = normalizeCreateSchema(
      parse({
        connectorAccountId: 'c',
        tables: [
          baseTable('a', 'A', [
            { name: 'x', fieldType: { kind: 'text' } },
            { name: 'ext', fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['tbl_remote'] } } },
          ]),
        ],
      }),
    );

    const a = plan.tablesInCreationOrder.find((table) => table.ref === 'a');
    expect(a?.deferredFkFields).toHaveLength(0);
    expect(a?.fields.some((field) => field.fieldType.kind === 'foreignKey')).toBe(true);
  });
});
