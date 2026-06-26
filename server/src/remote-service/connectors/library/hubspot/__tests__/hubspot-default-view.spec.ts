import { Type, type TSchema } from '@sinclair/typebox';
import {
  TableViewBannerGroup,
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { buildHubspotDefaultView } from '../hubspot-default-view';

/** Build a HubSpot property schema (String | Null union with annotations). */
function prop(connectorDataType: string, opts: { readonly?: boolean; label?: string } = {}) {
  const annotations: Record<string, unknown> = {
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: connectorDataType,
  };
  if (opts.readonly) annotations[X_SCRATCH_READONLY] = true;
  // The schema builder stores HubSpot's property label as `description`; the
  // default view uses it as the column's display name.
  if (opts.label) annotations.description = opts.label;
  return Type.Union([Type.String(), Type.Null()], annotations);
}

function makeSchema() {
  return Type.Object({
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    properties: Type.Object({
      phone: prop('hubspot/string_phonenumber'),
      annual_revenue: prop('hubspot/number'),
      email: prop('hubspot/string'),
      firstname: prop('hubspot/string'),
      is_active: prop('hubspot/bool_booleancheckbox'),
      lastname: prop('hubspot/string'),
      createdate: prop('hubspot/datetime'),
      lastmodifieddate: prop('hubspot/datetime'),
      hs_object_id: prop('hubspot/number', { readonly: true }),
      hs_analytics_num_visits: prop('hubspot/number', { readonly: true }),
      hs_email_domain: prop('hubspot/string', { readonly: true }),
      hs_lead_status: prop('hubspot/string'),
      hs_predictivecontactscore: prop('hubspot/number', { readonly: true }),
      followercount: prop('hubspot/number'),
      // Intentionally out of canonical order (and address2 last) to exercise sorting.
      address: prop('hubspot/string'),
      city: prop('hubspot/string'),
      state: prop('hubspot/string'),
      country: prop('hubspot/string'),
      zip: prop('hubspot/string'),
      address2: prop('hubspot/string'),
    }),
    createdAt: Type.String({ [X_SCRATCH_READONLY]: true }),
    updatedAt: Type.String({ [X_SCRATCH_READONLY]: true }),
    archived: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
    associations: Type.Optional(
      Type.Object(
        { companies: Type.Optional(Type.Object({ results: Type.Array(Type.Unknown()) })) },
        { [X_SCRATCH_READONLY]: true },
      ),
    ),
  });
}

describe('buildHubspotDefaultView', () => {
  const schema = makeSchema();
  // contacts-style object: hs_ namespace is analytics noise, hidden by default.
  const view = buildHubspotDefaultView(schema, {
    titleFieldPath: 'properties.email',
    priorityFields: ['firstname', 'lastname'],
    hideHubspotManagedProperties: true,
  });

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  describe('column ordering', () => {
    it('should place title (email) first', () => {
      const first = view.cols[0] as TableViewCol;
      expect(first.path).toBe('properties.email');
    });

    it('should place id right after title', () => {
      const second = view.cols[1] as TableViewCol;
      expect(second.path).toBe('id');
    });

    it('should place priority fields (firstname, lastname) after id', () => {
      const third = view.cols[2] as TableViewCol;
      const fourth = view.cols[3] as TableViewCol;
      expect(third.path).toBe('properties.firstname');
      expect(fourth.path).toBe('properties.lastname');
    });

    it('should place Address banner group after priority fields', () => {
      const addressGroupIdx = view.cols.findIndex((c) => c.kind === 'banner-group' && c.name === 'Address');
      // Should come after email(0), id(1), firstname(2), lastname(3)
      expect(addressGroupIdx).toBe(4);
    });

    it('should place remaining fixed fields after all properties', () => {
      const allCols = view.cols;
      const createdAtIdx = allCols.findIndex((c) => c.kind === 'col' && c.path === 'createdAt');
      const updatedAtIdx = allCols.findIndex((c) => c.kind === 'col' && c.path === 'updatedAt');
      const archivedIdx = allCols.findIndex((c) => c.kind === 'col' && c.path === 'archived');
      expect(createdAtIdx).toBeLessThan(updatedAtIdx);
      expect(updatedAtIdx).toBeLessThan(archivedIdx);
      // All should be after properties
      const lastPropertyIdx = allCols.findIndex((c) => c.kind === 'col' && c.path === 'properties.is_active');
      expect(lastPropertyIdx).toBeLessThan(createdAtIdx);
    });
  });

  it('should humanize the property key when no HubSpot label is present', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.email') as TableViewCol;
    expect(col.name).toBe('Email');
  });

  describe('hidden fields', () => {
    it('should not emit a single opaque associations object column', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'associations');
      expect(col).toBeUndefined();
    });

    it('should not hide useful property columns', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.email') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should not hide id', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should hide hs_ analytics/tracking properties', () => {
      const allCols = view.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
      const col = allCols.find((c) => c.path === 'properties.hs_analytics_num_visits') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should keep hs_object_id visible', () => {
      const allCols = view.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
      const col = allCols.find((c) => c.path === 'properties.hs_object_id') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should keep hs_email_domain visible', () => {
      const allCols = view.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
      const col = allCols.find((c) => c.path === 'properties.hs_email_domain') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should keep hs_lead_status visible', () => {
      const allCols = view.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
      const col = allCols.find((c) => c.path === 'properties.hs_lead_status') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should hide non-hs_ noise properties like followercount', () => {
      const allCols = view.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
      const col = allCols.find((c) => c.path === 'properties.followercount') as TableViewCol;
      expect(col.hidden).toBe(true);
    });
  });

  describe('display names', () => {
    function viewWithLabels() {
      const schemaWithLabels = Type.Object({
        id: Type.String({ [X_SCRATCH_READONLY]: true }),
        properties: Type.Object({
          hs_call_title: prop('hubspot/string', { label: 'Call title' }),
          firstname: prop('hubspot/string', { label: 'First Name' }),
          // No label → falls back to the humanized key.
          hs_unlabeled_field: prop('hubspot/string'),
        }),
        createdAt: Type.String({ [X_SCRATCH_READONLY]: true }),
        updatedAt: Type.String({ [X_SCRATCH_READONLY]: true }),
        archived: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
      });
      return buildHubspotDefaultView(schemaWithLabels, { titleFieldPath: 'properties.hs_call_title' });
    }

    const labeledView = viewWithLabels();
    const nameByPath = (path: string) =>
      (labeledView.cols.find((c) => c.kind === 'col' && c.path === path) as TableViewCol | undefined)?.name;

    it('uses the HubSpot-provided label as the column name', () => {
      expect(nameByPath('properties.hs_call_title')).toBe('Call title');
      expect(nameByPath('properties.firstname')).toBe('First Name');
    });

    it('humanizes the key (stripping hs_ prefix) when no label is present', () => {
      expect(nameByPath('properties.hs_unlabeled_field')).toBe('Unlabeled field');
    });
  });

  describe('association foreign-key columns', () => {
    function assocSchema(types: string[]) {
      const associationProps: Record<string, TSchema> = {};
      for (const t of types) {
        associationProps[t] = Type.Optional(Type.Object({ results: Type.Array(Type.Unknown()) }));
      }
      return Type.Object({
        id: Type.String({ [X_SCRATCH_READONLY]: true }),
        properties: Type.Object({ name: prop('hubspot/string') }),
        createdAt: Type.String({ [X_SCRATCH_READONLY]: true }),
        updatedAt: Type.String({ [X_SCRATCH_READONLY]: true }),
        archived: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        associations: Type.Optional(Type.Object(associationProps, { [X_SCRATCH_READONLY]: true })),
      });
    }

    it('renders a single related type as a standalone "Associated X" column (no group)', () => {
      const v = buildHubspotDefaultView(assocSchema(['contacts']), { titleFieldPath: 'properties.name' });
      expect(v.cols.find((c) => c.kind === 'banner-group' && c.name === 'Associations')).toBeUndefined();

      const col = v.cols.find((c) => c.kind === 'col' && c.path === 'associations.contacts.results') as TableViewCol;
      expect(col).toBeDefined();
      expect(col.name).toBe('Associated Contacts');
      expect(col.readonly).toBe(true);
      expect(col.hidden).toBeUndefined();
      expect(col.displayTransformer).toEqual({
        type: 'jsonpath',
        options: { expression: '$[*].id', arrayHandling: 'join_comma' },
      });
    });

    it('groups multiple related types under an "Associations" banner, named for each target', () => {
      const v = buildHubspotDefaultView(assocSchema(['companies', 'contacts', 'deals', '0-421']), {
        titleFieldPath: 'properties.name',
      });
      const group = v.cols.find((c) => c.kind === 'banner-group' && c.name === 'Associations') as TableViewBannerGroup;
      expect(group).toBeDefined();

      const byPath = (path: string) => group.cols.find((c) => c.path === path);
      // Grouped columns keep the "Associated" prefix; 0-421 resolves to its table name.
      expect(byPath('associations.companies.results')?.name).toBe('Associated Companies');
      expect(byPath('associations.contacts.results')?.name).toBe('Associated Contacts');
      expect(byPath('associations.deals.results')?.name).toBe('Associated Deals');
      expect(byPath('associations.0-421.results')?.name).toBe('Associated Appointments');
      // Every grouped column is a readonly FK column with the id-flattening transformer.
      for (const col of group.cols) {
        expect(col.readonly).toBe(true);
        expect(col.displayTransformer).toEqual({
          type: 'jsonpath',
          options: { expression: '$[*].id', arrayHandling: 'join_comma' },
        });
      }
      // No standalone association columns leak out alongside the group.
      expect(v.cols.some((c) => c.kind === 'col' && c.path.startsWith('associations.'))).toBe(false);
    });

    it('emits no association columns when the object has no associations', () => {
      const v = buildHubspotDefaultView(assocSchema([]), { titleFieldPath: 'properties.name' });
      expect(v.cols.some((c) => c.kind === 'banner-group' && c.name === 'Associations')).toBe(false);
      expect(v.cols.some((c) => c.kind === 'col' && c.path.startsWith('associations'))).toBe(false);
    });
  });

  describe('address banner group', () => {
    it('should create an Address banner group', () => {
      const group = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'Address') as TableViewBannerGroup;
      expect(group).toBeDefined();
    });

    it('should contain address, address2, city, state, zip, country', () => {
      const group = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'Address') as TableViewBannerGroup;
      const paths = group.cols.map((c) => c.path);
      expect(paths).toContain('properties.address');
      expect(paths).toContain('properties.address2');
      expect(paths).toContain('properties.city');
      expect(paths).toContain('properties.state');
      expect(paths).toContain('properties.country');
      expect(paths).toContain('properties.zip');
    });

    it('should order banner columns canonically (street → street 2 → city → state → zip → country)', () => {
      const group = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'Address') as TableViewBannerGroup;
      const paths = group.cols.map((c) => c.path);
      expect(paths).toEqual([
        'properties.address',
        'properties.address2',
        'properties.city',
        'properties.state',
        'properties.zip',
        'properties.country',
      ]);
    });

    it('should not include address fields as top-level cols', () => {
      const topLevelPaths = view.cols.filter((c): c is TableViewCol => c.kind === 'col').map((c) => c.path);
      expect(topLevelPaths).not.toContain('properties.address');
      expect(topLevelPaths).not.toContain('properties.city');
    });
  });

  describe('name formatting', () => {
    it('should format camelCase fixed fields as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'createdAt') as TableViewCol;
      expect(col.name).toBe('Created At');
    });

    it('should format single-word fixed fields as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'archived') as TableViewCol;
      expect(col.name).toBe('Archived');
    });
  });

  describe('type mapping', () => {
    it('should map hubspot/number to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.annual_revenue') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map hubspot/bool_booleancheckbox to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.is_active') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map Boolean Kind fixed field to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'archived') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should leave unmapped connector types as undefined', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.email') as TableViewCol;
      expect(col.type).toBeUndefined();
    });

    it('should map hs_object_id to string type even though HubSpot types it as number', () => {
      // hs_object_id is an opaque ID; the grid would otherwise format it with thousands separators.
      const allCols = view.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
      const col = allCols.find((c) => c.path === 'properties.hs_object_id') as TableViewCol;
      expect(col.type).toBe('string');
    });
  });

  describe('readonly', () => {
    it('should mark schema-annotated readonly properties', () => {
      const allCols = view.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
      const col = allCols.find((c) => c.path === 'properties.hs_object_id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark createdate as readonly (always-readonly)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.createdate') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark lastmodifieddate as readonly (always-readonly)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.lastmodifieddate') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark id as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark createdAt as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'createdAt') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark updatedAt as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'updatedAt') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark archived as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'archived') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark writable properties as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.email') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  it('should handle an empty properties schema', () => {
    const emptySchema = Type.Object({
      id: Type.String(),
      properties: Type.Object({}),
      createdAt: Type.String(),
      updatedAt: Type.String(),
      archived: Type.Boolean(),
    });
    const emptyView = buildHubspotDefaultView(emptySchema);
    expect(emptyView.cols.length).toBe(4); // id, createdAt, updatedAt, archived
  });

  it('should handle a schema with no properties field at all', () => {
    const noPropsSchema = Type.Object({
      id: Type.String(),
    });
    const noPropsView = buildHubspotDefaultView(noPropsSchema);
    expect(noPropsView.cols.length).toBe(1); // just id
  });

  it('should not create address group when no address fields exist', () => {
    const noAddressSchema = Type.Object({
      id: Type.String(),
      properties: Type.Object({
        email: prop('hubspot/string'),
        firstname: prop('hubspot/string'),
      }),
    });
    const noAddressView = buildHubspotDefaultView(noAddressSchema, { titleFieldPath: 'properties.email' });
    const groups = noAddressView.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});

/**
 * Activity/engagement and commerce objects (calls, meetings, notes, tasks,
 * quotes, …) keep their entire primary payload under hs_-prefixed properties, so
 * they are built WITHOUT `hideHubspotManagedProperties`. Regression coverage for
 * the bug where every hs_ property — including the object's own title — was
 * hidden, collapsing these tables to a handful of generic fields.
 */
describe('buildHubspotDefaultView — activity object (hs_ content shown)', () => {
  function makeCallsSchema() {
    return Type.Object({
      id: Type.String({ [X_SCRATCH_READONLY]: true }),
      properties: Type.Object({
        hs_call_title: prop('hubspot/string'),
        hs_call_body: prop('hubspot/string'),
        hs_call_duration: prop('hubspot/number'),
        hs_timestamp: prop('hubspot/datetime'),
        hubspot_owner_id: prop('hubspot/string'),
        // Internal plumbing — hidden on every object type.
        hs_created_by_user_id: prop('hubspot/number', { readonly: true }),
        hs_all_owner_ids: prop('hubspot/string', { readonly: true }),
        hs_object_source_label: prop('hubspot/string', { readonly: true }),
        hs_object_id: prop('hubspot/number', { readonly: true }),
      }),
      createdAt: Type.String({ [X_SCRATCH_READONLY]: true }),
      updatedAt: Type.String({ [X_SCRATCH_READONLY]: true }),
      archived: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
    });
  }

  const callsView = buildHubspotDefaultView(makeCallsSchema(), { titleFieldPath: 'properties.hs_call_title' });
  const callsCols = callsView.cols.flatMap((c) => (c.kind === 'banner-group' ? c.cols : [c]));
  const colByPath = (path: string) => callsCols.find((c) => c.path === path);

  it('shows the hs_ title field (regression: was hidden)', () => {
    expect(colByPath('properties.hs_call_title')?.hidden).toBeUndefined();
  });

  it('shows hs_ content fields (body, duration, timestamp)', () => {
    expect(colByPath('properties.hs_call_body')?.hidden).toBeUndefined();
    expect(colByPath('properties.hs_call_duration')?.hidden).toBeUndefined();
    expect(colByPath('properties.hs_timestamp')?.hidden).toBeUndefined();
  });

  it('still hides internal hs_ system plumbing', () => {
    expect(colByPath('properties.hs_created_by_user_id')?.hidden).toBe(true);
    expect(colByPath('properties.hs_all_owner_ids')?.hidden).toBe(true);
    expect(colByPath('properties.hs_object_source_label')?.hidden).toBe(true);
  });

  it('keeps hs_object_id visible (allowlisted)', () => {
    expect(colByPath('properties.hs_object_id')?.hidden).toBeUndefined();
  });

  it('places the title first even though it is hs_-prefixed', () => {
    expect((callsView.cols[0] as TableViewCol).path).toBe('properties.hs_call_title');
  });
});
