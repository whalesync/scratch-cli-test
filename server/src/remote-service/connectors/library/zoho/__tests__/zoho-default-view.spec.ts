import { TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildZohoDefaultView } from '../zoho-default-view';
import { buildZohoJsonTableSpec } from '../zoho-json-schema';
import { ZohoFieldMetadata } from '../zoho-types';

function makeField(overrides: Partial<ZohoFieldMetadata> & { api_name: string; data_type: string }): ZohoFieldMetadata {
  return { field_label: overrides.api_name, json_type: 'string', ...overrides };
}

const ID: EntityId = { wsId: 'Leads', remoteId: ['Leads'] };

/** Find a flat column at the top level of the view (not inside a banner group). */
function flatCol(view: { cols: (TableViewCol | TableViewBannerGroup)[] }, path: string): TableViewCol | undefined {
  return view.cols.find((c): c is TableViewCol => c.kind === 'col' && c.path === path);
}

function bannerGroup(
  view: { cols: (TableViewCol | TableViewBannerGroup)[] },
  name: string,
): TableViewBannerGroup | undefined {
  return view.cols.find((c): c is TableViewBannerGroup => c.kind === 'banner-group' && c.name === name);
}

describe('buildZohoDefaultView', () => {
  it('puts the record id first as a read-only column', () => {
    const fields = [makeField({ api_name: 'Last_Name', data_type: 'text' })];
    const spec = buildZohoJsonTableSpec(ID, 'Leads', 'Leads', fields);
    const view = spec.defaultView;
    expect(view).toBeDefined();
    if (!view) return;
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'id', readonly: true });
  });

  it('renders standard fields flat and groups custom fields under a "Custom Fields" banner', () => {
    const fields = [
      makeField({ api_name: 'Last_Name', data_type: 'text', custom_field: false }),
      makeField({ api_name: 'Email', data_type: 'email', custom_field: false }),
      makeField({ api_name: 'Favorite_Color', field_label: 'Favorite Color', data_type: 'text', custom_field: true }),
      makeField({
        api_name: 'Loyalty_Points',
        field_label: 'Loyalty Points',
        data_type: 'integer',
        custom_field: true,
      }),
    ];
    const spec = buildZohoJsonTableSpec(ID, 'Leads', 'Leads', fields);
    const view = spec.defaultView;
    if (!view) throw new Error('expected a default view');

    // Standard fields are flat columns.
    expect(flatCol(view, 'Last_Name')).toBeDefined();
    expect(flatCol(view, 'Email')).toBeDefined();
    // Custom fields are NOT flat — they live in the banner group.
    expect(flatCol(view, 'Favorite_Color')).toBeUndefined();
    expect(flatCol(view, 'Loyalty_Points')).toBeUndefined();

    const group = bannerGroup(view, 'Custom Fields');
    expect(group).toBeDefined();
    if (!group) return;
    expect(group.cols.map((c) => c.path)).toEqual(['Favorite_Color', 'Loyalty_Points']);
    // Column labels come from the Zoho field_label.
    expect(group.cols.find((c) => c.path === 'Favorite_Color')?.name).toBe('Favorite Color');
  });

  it('omits the Custom Fields banner when there are no custom fields', () => {
    const fields = [
      makeField({ api_name: 'Last_Name', data_type: 'text', custom_field: false }),
      makeField({ api_name: 'Company', data_type: 'text' }), // custom_field undefined → standard
    ];
    const spec = buildZohoJsonTableSpec(ID, 'Leads', 'Leads', fields);
    const view = spec.defaultView;
    if (!view) throw new Error('expected a default view');
    expect(bannerGroup(view, 'Custom Fields')).toBeUndefined();
    expect(view.cols.every((c) => c.kind === 'col')).toBe(true);
  });

  it('propagates x-scratch-readonly from the schema onto the column', () => {
    const fields = [
      makeField({ api_name: 'Last_Name', data_type: 'text' }),
      // Modified_Time is read-only via operation_type; a formula is computed-readonly.
      makeField({
        api_name: 'Modified_Time',
        data_type: 'datetime',
        operation_type: { api_update: false },
      }),
      makeField({ api_name: 'Score', data_type: 'formula', json_type: 'double' }),
    ];
    const spec = buildZohoJsonTableSpec(ID, 'Leads', 'Leads', fields);
    const view = spec.defaultView;
    if (!view) throw new Error('expected a default view');
    expect(flatCol(view, 'Last_Name')?.readonly).toBe(false);
    expect(flatCol(view, 'Modified_Time')?.readonly).toBe(true);
    expect(flatCol(view, 'Score')?.readonly).toBe(true);
  });

  it('maps data types to column type hints', () => {
    const fields = [
      makeField({ api_name: 'Email_Opt_Out', data_type: 'boolean' }),
      makeField({ api_name: 'Annual_Revenue', data_type: 'currency' }),
      makeField({ api_name: 'Created_Time', data_type: 'datetime' }),
      makeField({ api_name: 'Website', data_type: 'website' }),
      makeField({ api_name: 'Account_Name', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }),
    ];
    const spec = buildZohoJsonTableSpec(ID, 'Leads', 'Leads', fields);
    const view = spec.defaultView;
    if (!view) throw new Error('expected a default view');
    expect(flatCol(view, 'Email_Opt_Out')?.type).toBe('checkbox');
    expect(flatCol(view, 'Annual_Revenue')?.type).toBe('number');
    expect(flatCol(view, 'Created_Time')?.type).toBe('date');
    expect(flatCol(view, 'Website')?.type).toBe('url');
    expect(flatCol(view, 'Account_Name')?.type).toBe('object');
  });

  it('skips fields that did not make it into the schema (defensive)', () => {
    const fields = [makeField({ api_name: 'Last_Name', data_type: 'text' })];
    // A field present in metadata but absent from the schema properties must not crash.
    const view = buildZohoDefaultView([...fields, makeField({ api_name: 'Phantom', data_type: 'text' })], {
      id: {} as never,
      Last_Name: {} as never,
    });
    expect(flatCol(view, 'Phantom')).toBeUndefined();
    expect(flatCol(view, 'Last_Name')).toBeDefined();
  });
});
