import { type DataSourceObjectResponse } from '@notionhq/client';
import { Type } from '@sinclair/typebox';
import { TableView, X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { buildNotionJsonTableSpec } from 'src/remote-service/connectors/library/notion/notion-json-schema';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';
import { selectPlanFieldsFromTableView } from '../schema-builder-field-selection';

/** The name the plan generator would derive for a field (display label, else last path segment). */
function planFieldName(field: SchemaField): string {
  return field.displayLabel ?? field.path.split('.').pop() ?? field.path;
}

describe('selectPlanFieldsFromTableView', () => {
  // ── Notion regression: real generated schema + curated default view ──────────
  // Plan generation drives off the curated view (not the raw flattener), which used
  // to emit several columns all named "object"/"id" by recursing into Notion's
  // `created_by: { object, id }` / `last_edited_by`. These tests pin that the
  // view-driven selection stays free of those collisions; DEV-10412 additionally
  // marks the fixed user objects read-only, so the flattener keeps them whole too.
  describe('Notion (real builders)', () => {
    function buildNotionSpec(
      properties: Record<string, { id: string; type: string; relation?: { database_id: string } }>,
    ) {
      const dataSource = {
        object: 'data_source',
        id: 'ds_123',
        title: [{ plain_text: 'My DB' }],
        properties: Object.fromEntries(Object.entries(properties).map(([name, def]) => [name, { name, ...def }])),
      } as unknown as DataSourceObjectResponse;
      return buildNotionJsonTableSpec({ wsId: 'db', remoteId: ['db_123', 'ds_123'] }, dataSource);
    }

    const spec = buildNotionSpec({
      Name: { id: 'title', type: 'title' },
      Status: { id: 'p_status', type: 'status' },
      Assignee: { id: 'p_people', type: 'people' },
      Linked: { id: 'p_rel', type: 'relation', relation: { database_id: 'db_linked' } },
    });
    const view = spec.defaultView;
    if (!view) throw new Error('expected the Notion spec to carry a default view');

    const result = selectPlanFieldsFromTableView({ schema: spec.schema, view });

    it('keeps created_by / last_edited_by whole in the raw flattener now they are readonly (DEV-10412)', () => {
      // Marking the fixed user objects X_SCRATCH_READONLY makes the flattener treat
      // them as single leaves instead of exploding them into duplicate `object` /
      // `id` sub-fields (the original plan-generation collision).
      const rawPaths = extractSchemaFields(spec.schema).map((f) => f.path);
      expect(rawPaths).toContain('created_by');
      expect(rawPaths).toContain('last_edited_by');
      expect(rawPaths).not.toContain('created_by.object');
      expect(rawPaths).not.toContain('created_by.id');
      expect(rawPaths).not.toContain('last_edited_by.object');
      expect(rawPaths).not.toContain('last_edited_by.id');
    });

    it('produces no duplicate field names', () => {
      const names = result.schemaFields.map(planFieldName);
      const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
      expect(duplicates).toEqual([]);
    });

    it('collapses Notion user objects to one column each — no stray "object"/"id" columns', () => {
      const names = result.schemaFields.map(planFieldName);
      expect(names.filter((n) => n.toLowerCase() === 'object')).toHaveLength(0);
      // created_by / last_edited_by survive as single, uniquely-named text columns.
      expect(names).toContain('Created By');
      expect(names).toContain('Last Edited By');
    });

    it('drops columns the connector marks hidden (object, parent, archive flags)', () => {
      const paths = result.schemaFields.map((f) => f.path);
      expect(paths).not.toContain('object');
      expect(paths).not.toContain('parent');
      expect(paths).not.toContain('is_archived');
    });

    it('anchors the title column to the envelope path so primary-field matching still works', () => {
      // titlePath is ['properties','Name'] → the derived field must use
      // that envelope path (not the drilled `properties.Name.title`).
      expect(spec.titlePath).toEqual('properties.Name');
      expect(result.schemaFields.some((f) => f.path === 'properties.Name')).toBe(true);
    });

    it('preserves the relation foreign key via the deepest-ancestor join', () => {
      const linked = result.schemaFields.find((f) => f.path === 'properties.Linked');
      expect(linked?.foreignKey).toEqual({ linkedTableId: 'db_linked' });
    });

    it('carries the view TablePropertyType hint per derived path', () => {
      expect(result.viewTypeByPath['properties.Name']).toBe('richtext');
      expect(result.viewTypeByPath['url']).toBe('url');
      expect(result.viewTypeByPath['created_time']).toBe('date');
    });
  });

  // ── Connector-agnostic join behaviour (hand-built inputs) ────────────────────
  describe('join behaviour', () => {
    it('re-anchors a drilled column path to the deepest annotated ancestor and keeps its FK', () => {
      const schema = Type.Object({
        rel: Type.Object(
          { id: Type.String(), type: Type.String(), relation: Type.Array(Type.Object({ id: Type.String() })) },
          { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'tbl_target', map: 'id' } },
        ),
        plain: Type.String(),
      });
      const view: TableView = {
        name: 'Default',
        cols: [
          { kind: 'col', name: 'Relation', path: 'rel.relation', type: 'object' },
          { kind: 'col', name: 'Plain', path: 'plain', type: 'string' },
        ],
      };

      const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({ schema, view });

      const relation = schemaFields.find((f) => f.displayLabel === 'Relation');
      expect(relation?.path).toBe('rel');
      expect(relation?.foreignKey).toEqual({ linkedTableId: 'tbl_target' });
      expect(viewTypeByPath['rel']).toBe('object');
      expect(schemaFields.map((f) => f.path)).toEqual(['rel', 'plain']);
    });

    it('dedupes multiple columns that resolve to the same backing field (first wins)', () => {
      const schema = Type.Object({
        rel: Type.Object(
          { id: Type.String(), relation: Type.Array(Type.Object({ id: Type.String() })) },
          { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'tbl_target', map: 'id' } },
        ),
      });
      const view: TableView = {
        name: 'Default',
        cols: [
          { kind: 'col', name: 'First', path: 'rel.relation' },
          { kind: 'col', name: 'Second', path: 'rel.id' },
        ],
      };

      const { schemaFields } = selectPlanFieldsFromTableView({ schema, view });
      expect(schemaFields).toHaveLength(1);
      expect(schemaFields[0].displayLabel).toBe('First');
    });

    it('falls back to the column path and unknown type when no schema field backs it', () => {
      const schema = Type.Object({ name: Type.String() });
      const view: TableView = {
        name: 'Default',
        cols: [{ kind: 'col', name: 'Computed', path: 'derived.value' }],
      };

      const { schemaFields } = selectPlanFieldsFromTableView({ schema, view });
      expect(schemaFields).toEqual([{ path: 'derived.value', type: 'unknown', displayLabel: 'Computed' }]);
    });
  });

  // ── Visibility / banner groups ───────────────────────────────────────────────
  describe('visibility', () => {
    it('flattens banner groups and drops hidden columns and hidden groups', () => {
      const schema = Type.Object({
        name: Type.String(),
        secret: Type.String(),
        seoTitle: Type.String(),
        seoDesc: Type.String(),
        legacy: Type.String(),
      });
      const view: TableView = {
        name: 'Default',
        cols: [
          { kind: 'col', name: 'Name', path: 'name', type: 'string' },
          { kind: 'col', name: 'Secret', path: 'secret', type: 'string', hidden: true },
          {
            kind: 'banner-group',
            name: 'SEO',
            cols: [
              { kind: 'col', name: 'SEO Title', path: 'seoTitle', type: 'string' },
              { kind: 'col', name: 'SEO Desc', path: 'seoDesc', type: 'string', hidden: true },
            ],
          },
          {
            kind: 'banner-group',
            name: 'Legacy',
            hidden: true,
            cols: [{ kind: 'col', name: 'Legacy', path: 'legacy', type: 'string' }],
          },
        ],
      };

      const { schemaFields } = selectPlanFieldsFromTableView({ schema, view });
      expect(schemaFields.map((f) => f.displayLabel)).toEqual(['Name', 'SEO Title']);
    });
  });
});
