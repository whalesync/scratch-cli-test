import { type DataSourceObjectResponse } from '@notionhq/client';
import { Type } from '@sinclair/typebox';
import { TableView, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { HubspotApiClient } from 'src/remote-service/connectors/library/hubspot/hubspot-api-client';
import { buildHubspotDefaultView } from 'src/remote-service/connectors/library/hubspot/hubspot-default-view';
import { buildHubspotJsonTableSpec } from 'src/remote-service/connectors/library/hubspot/hubspot-json-schema';
import { HubspotProperty } from 'src/remote-service/connectors/library/hubspot/hubspot-types';
import { buildNotionDefaultView } from 'src/remote-service/connectors/library/notion/notion-default-view';
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
    // The view is now a pure function of the spec (MR2) — rebuild it from the schema.
    const view = buildNotionDefaultView(spec.schema);

    const result = selectPlanFieldsFromTableView({ schema: spec.schema, view, titlePath: spec.titlePath });

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

  // ── HubSpot regression: per-type association FK columns must each survive ─────
  // The default view emits one column per association type (Associated Companies,
  // Associated Contacts, …). These all live under the `associations` container, so
  // if that container reads as a single value leaf they re-anchor to one backing
  // field and the plan collapses them to ONE. The container carries no x-scratch
  // metadata (readonly sits on each per-type object) precisely so the flattener
  // expands it and every association column keeps a distinct backing field.
  describe('HubSpot associations (real builders)', () => {
    function fakeClient(properties: HubspotProperty[]): HubspotApiClient {
      return { getProperties: () => Promise.resolve(properties) } as unknown as HubspotApiClient;
    }
    function property(name: string): HubspotProperty {
      return { name, label: name, type: 'string', fieldType: 'text', description: '', hidden: false };
    }

    it('keeps every per-type association column as its own plan field (not collapsed to one)', async () => {
      // Deals associate with companies, contacts, deals, notes, tasks, tickets.
      const { spec } = await buildHubspotJsonTableSpec(
        { wsId: 'deals', remoteId: ['deals'] },
        'deals',
        fakeClient([property('dealname')]),
      );
      // The view is now a pure function of the spec (MR2) — rebuild it from the schema.
      const view = buildHubspotDefaultView(spec.schema);

      const { schemaFields } = selectPlanFieldsFromTableView({ schema: spec.schema, view });
      const associationLabels = schemaFields
        .filter((f) => f.path.startsWith('associations.'))
        .map((f) => f.displayLabel);

      expect(associationLabels).toEqual(
        expect.arrayContaining([
          'Associated Companies',
          'Associated Contacts',
          'Associated Deals',
          'Associated Notes',
          'Associated Tasks',
          'Associated Tickets',
        ]),
      );
      // And they are distinct (no collapse): one field per association type.
      expect(new Set(associationLabels).size).toBe(associationLabels.length);
      expect(associationLabels.length).toBeGreaterThanOrEqual(6);
    });

    it('carries each association column FK from the view declaration (not downgraded to text)', async () => {
      // The FK annotation lives on `associations.<type>.results[].id`, below the
      // column's path, so the schema join can't recover it; the connector declares
      // the target on the view column instead. Each association field must surface a
      // foreignKey targeting the association type embedded in its path, so the plan
      // generator treats it as a foreignKey field rather than plain text.
      const { spec } = await buildHubspotJsonTableSpec(
        { wsId: 'deals', remoteId: ['deals'] },
        'deals',
        fakeClient([property('dealname')]),
      );
      // The view is now a pure function of the spec (MR2) — rebuild it from the schema.
      const view = buildHubspotDefaultView(spec.schema);

      const { schemaFields } = selectPlanFieldsFromTableView({ schema: spec.schema, view });
      const associationFields = schemaFields.filter((f) => f.path.startsWith('associations.'));

      expect(associationFields.length).toBeGreaterThanOrEqual(6);
      for (const field of associationFields) {
        const associationType = field.path.split('.')[1];
        expect(field.foreignKey).toEqual({ linkedTableId: associationType });
      }
    });
  });

  // ── Connector-agnostic join behaviour (hand-built inputs) ────────────────────
  describe('join behaviour', () => {
    it('re-anchors a drilled column path to the deepest annotated ancestor and keeps its FK', () => {
      const schema = Type.Object({
        rel: Type.Object(
          { id: Type.String(), type: Type.String(), relation: Type.Array(Type.Object({ id: Type.String() })) },
          { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'tbl_target' } },
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
          { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'tbl_target' } },
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

    it('keeps sibling columns distinct when their only common ancestor is a non-FK container', () => {
      // A readonly container bag the flattener exposes as a single leaf (e.g.
      // HubSpot `associations`). Columns drill one level in; the container owns no
      // FK and is not the title/id path, so it must NOT absorb them into one field.
      const schema = Type.Object({
        associations: Type.Object(
          {
            companies: Type.Object({ results: Type.Array(Type.Object({ id: Type.String() })) }),
            contacts: Type.Object({ results: Type.Array(Type.Object({ id: Type.String() })) }),
          },
          { [X_SCRATCH_READONLY]: true },
        ),
      });
      const view: TableView = {
        name: 'Default',
        cols: [
          { kind: 'col', name: 'Associated Companies', path: 'associations.companies.results' },
          { kind: 'col', name: 'Associated Contacts', path: 'associations.contacts.results' },
        ],
      };

      const { schemaFields } = selectPlanFieldsFromTableView({ schema, view });
      expect(schemaFields.map((f) => f.displayLabel)).toEqual(['Associated Companies', 'Associated Contacts']);
      expect(schemaFields.map((f) => f.path)).toEqual([
        'associations.companies.results',
        'associations.contacts.results',
      ]);
      // The view columns declare no FK target and the array-element ids carry no
      // annotation, so no foreignKey is invented for them.
      expect(schemaFields.every((f) => f.foreignKey === undefined)).toBe(true);
    });

    it('adopts an explicit FK target declared on a synthesized view column', () => {
      // A connector synthesizes a flattened link column whose FK annotation lives
      // BELOW the column path (HubSpot associations: the FK is on `results[].id`). It
      // declares the target on the view column; selection adopts it even though no
      // backing schema node along the column path carries one.
      const schema = Type.Object({
        associations: Type.Object(
          { contacts: Type.Object({ results: Type.Array(Type.Object({ id: Type.String(), type: Type.String() })) }) },
          { [X_SCRATCH_READONLY]: true },
        ),
      });
      const view: TableView = {
        name: 'Default',
        cols: [
          {
            kind: 'col',
            name: 'Associated Contacts',
            path: 'associations.contacts.results',
            foreignKey: { linkedTableId: 'contacts' },
          },
        ],
      };

      const { schemaFields } = selectPlanFieldsFromTableView({ schema, view });
      expect(schemaFields).toHaveLength(1);
      expect(schemaFields[0].path).toBe('associations.contacts.results');
      expect(schemaFields[0].foreignKey).toEqual({ linkedTableId: 'contacts' });
    });

    it('re-anchors a drilled title column onto the title path so primary matching lines up', () => {
      const schema = Type.Object({
        title: Type.Object({ plain: Type.String() }, { [X_SCRATCH_READONLY]: true }),
      });
      const view: TableView = {
        name: 'Default',
        cols: [{ kind: 'col', name: 'Title', path: 'title.plain' }],
      };

      // Without titlePath the container is not a re-anchor target → keeps own path.
      const ungated = selectPlanFieldsFromTableView({ schema, view });
      expect(ungated.schemaFields[0].path).toBe('title.plain');

      // With titlePath the drilled column re-anchors onto the envelope.
      const gated = selectPlanFieldsFromTableView({ schema, view, titlePath: 'title' });
      expect(gated.schemaFields[0].path).toBe('title');
    });

    it("prefers a column's semantic logicalType over its render type for viewTypeByPath", () => {
      // A display-transformer column (e.g. Attio) renders as text (`type:'string'`)
      // but declares its true semantic type as `logicalType`; the plan generator must
      // build the destination field from THAT, not text (DEV-11040).
      const schema = Type.Object({
        values: Type.Object({ amount: Type.Array(Type.Object({})), label: Type.Array(Type.Object({})) }),
      });
      const view: TableView = {
        name: 'Default',
        cols: [
          { kind: 'col', name: 'Amount', path: 'values.amount', type: 'string', logicalType: 'number' },
          { kind: 'col', name: 'Label', path: 'values.label', type: 'string' },
        ],
      };

      const { viewTypeByPath } = selectPlanFieldsFromTableView({ schema, view });
      expect(viewTypeByPath['values.amount']).toBe('number'); // logicalType wins
      expect(viewTypeByPath['values.label']).toBe('string'); // falls back to render type
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

  // ── Subfield selection: a column that renders a chosen subfield maps the source
  //    to that subfield's leaf (Shopify count/money objects) so the export is the
  //    scalar the view shows, not the whole object (which fails an object→scalar
  //    sync transform — "Cannot convert object to number"). ──────────────────────
  describe('subfield-selected columns', () => {
    // A Shopify Blogs `articlesCount` — a `{count, precision}` count object marked
    // read-only on its outer envelope, exactly like the generated schema.
    const schema = Type.Object({
      title: Type.String(),
      articlesCount: Type.Optional(
        Type.Union([
          Type.Object({
            count: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            precision: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ]),
      ),
    });
    schema.properties.articlesCount[X_SCRATCH_READONLY] = true;

    const countCol = {
      kind: 'col' as const,
      name: 'Articles Count',
      path: 'articlesCount',
      type: 'number' as const,
      subfields: [
        { relativePath: 'count', name: 'Count', type: 'number' as const },
        { relativePath: 'precision', name: 'Precision', type: 'string' as const },
      ],
    };

    it('maps the source to the selected subfield leaf path, typed by the subfield', () => {
      const view: TableView = {
        name: 'Default',
        cols: [
          { kind: 'col', name: 'Title', path: 'title', type: 'string' },
          { ...countCol, selectedSubfield: 0 },
        ],
      };

      const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({ schema, view });

      const paths = schemaFields.map((f) => f.path);
      expect(paths).toContain('articlesCount.count');
      expect(paths).not.toContain('articlesCount');
      const countField = schemaFields.find((f) => f.path === 'articlesCount.count');
      expect(countField?.displayLabel).toBe('Articles Count');
      // The view type drives the created column kind → a `number` column, and the
      // source path plucks the scalar, so no object→number conversion is needed.
      expect(viewTypeByPath['articlesCount.count']).toBe('number');
    });

    it('keeps the whole object when no subfield is selected (root)', () => {
      const view: TableView = { name: 'Default', cols: [countCol] };

      const { schemaFields } = selectPlanFieldsFromTableView({ schema, view });

      const paths = schemaFields.map((f) => f.path);
      expect(paths).toContain('articlesCount');
      expect(paths).not.toContain('articlesCount.count');
    });

    // A Stripe invoice `parent` — the subscription link sits TWO nullable-union levels below the
    // column (`parent.subscription_details.subscription`, DEV-11154). The composed subfield path
    // must join back to the schema field that carries the foreign key, so the plan proposes a
    // relation column rather than text.
    it('keeps the foreign key of a subfield two levels below the column', () => {
      const invoiceSchema = Type.Object({
        parent: Type.Optional(
          Type.Union(
            [
              Type.Object({
                type: Type.String(),
                subscription_details: Type.Optional(
                  Type.Union([
                    Type.Object({
                      subscription: Type.Optional(
                        Type.Union([Type.String(), Type.Null()], {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'subscriptions',
                            linkedTableRemoteId: ['subscriptions'],
                          },
                        }),
                      ),
                    }),
                    Type.Null(),
                  ]),
                ),
              }),
              Type.Null(),
            ],
            { [X_SCRATCH_READONLY]: true },
          ),
        ),
      });
      const view: TableView = {
        name: 'Default',
        cols: [
          {
            kind: 'col',
            name: 'Parent',
            path: 'parent',
            type: 'object',
            readonly: true,
            subfields: [
              {
                relativePath: 'subscription_details.subscription',
                name: 'Subscription',
                type: 'string',
                readonly: true,
              },
            ],
            selectedSubfield: 0,
          },
        ],
      };

      const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({ schema: invoiceSchema, view });

      const subscriptionField = schemaFields.find((f) => f.path === 'parent.subscription_details.subscription');
      expect(subscriptionField?.foreignKey?.linkedTableId).toBe('subscriptions');
      expect(subscriptionField?.displayLabel).toBe('Parent');
      expect(subscriptionField?.readonly).toBe(true);
      expect(viewTypeByPath['parent.subscription_details.subscription']).toBe('string');
    });
  });
});
