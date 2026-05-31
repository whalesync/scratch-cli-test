import { Type } from '@sinclair/typebox';
import {
  TableViewBannerGroup,
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { buildHubspotDefaultView } from '../hubspot-default-view';

/** Build a HubSpot property schema (String | Null union with annotations). */
function prop(connectorDataType: string, opts: { readonly?: boolean } = {}) {
  const annotations: Record<string, unknown> = {
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: connectorDataType,
  };
  if (opts.readonly) annotations[X_SCRATCH_READONLY] = true;
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
      address: prop('hubspot/string'),
      city: prop('hubspot/string'),
      state: prop('hubspot/string'),
      country: prop('hubspot/string'),
      zip: prop('hubspot/string'),
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
  const view = buildHubspotDefaultView(schema, 'properties.email', ['firstname', 'lastname']);

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

  it('should use property names as column names (kept as-is from HubSpot)', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'properties.email') as TableViewCol;
    expect(col.name).toBe('email');
  });

  describe('hidden fields', () => {
    it('should hide associations', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'associations') as TableViewCol;
      expect(col.hidden).toBe(true);
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

  describe('address banner group', () => {
    it('should create an Address banner group', () => {
      const group = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'Address') as TableViewBannerGroup;
      expect(group).toBeDefined();
    });

    it('should contain address, city, state, country, zip', () => {
      const group = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'Address') as TableViewBannerGroup;
      const paths = group.cols.map((c) => c.path);
      expect(paths).toContain('properties.address');
      expect(paths).toContain('properties.city');
      expect(paths).toContain('properties.state');
      expect(paths).toContain('properties.country');
      expect(paths).toContain('properties.zip');
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
    const emptyView = buildHubspotDefaultView(emptySchema, undefined);
    expect(emptyView.cols.length).toBe(4); // id, createdAt, updatedAt, archived
  });

  it('should handle a schema with no properties field at all', () => {
    const noPropsSchema = Type.Object({
      id: Type.String(),
    });
    const noPropsView = buildHubspotDefaultView(noPropsSchema, undefined);
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
    const noAddressView = buildHubspotDefaultView(noAddressSchema, 'properties.email');
    const groups = noAddressView.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});
