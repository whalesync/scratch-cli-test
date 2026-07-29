import { TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildZohoDefaultView } from '../zoho-default-view';
import { buildZohoJsonTableSpec } from '../zoho-json-schema';
import { ZohoFieldMetadata } from '../zoho-types';

function makeField(overrides: Partial<ZohoFieldMetadata> & { api_name: string; data_type: string }): ZohoFieldMetadata {
  return { field_label: overrides.api_name, json_type: 'string', ...overrides };
}

const ID: EntityId = { wsId: 'Leads', remoteId: ['Leads'] };

// The default view is now a pure function of the spec (MR2): schema-gen no longer
// stores it, so build the spec — the raw field metadata (including custom_field /
// data_type / field_label) flows into the schema's x-scratch-* annotations — then
// rebuild the view from that spec alone.
function viewFor(fields: ZohoFieldMetadata[]) {
  const spec = buildZohoJsonTableSpec(ID, 'Leads', 'Leads', fields);
  return buildZohoDefaultView(spec);
}

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
    const view = viewFor([makeField({ api_name: 'Last_Name', data_type: 'text' })]);
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'id', readonly: true });
  });

  it('renders standard fields flat and groups custom fields under a "Custom Fields" banner', () => {
    const view = viewFor([
      makeField({ api_name: 'Last_Name', data_type: 'text', custom_field: false }),
      makeField({ api_name: 'Email', data_type: 'email', custom_field: false }),
      makeField({ api_name: 'Favorite_Color', field_label: 'Favorite Color', data_type: 'text', custom_field: true }),
      makeField({
        api_name: 'Loyalty_Points',
        field_label: 'Loyalty Points',
        data_type: 'integer',
        custom_field: true,
      }),
    ]);

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
    const view = viewFor([
      makeField({ api_name: 'Last_Name', data_type: 'text', custom_field: false }),
      makeField({ api_name: 'Company', data_type: 'text' }), // custom_field undefined → standard
    ]);
    expect(bannerGroup(view, 'Custom Fields')).toBeUndefined();
    expect(view.cols.every((c) => c.kind === 'col')).toBe(true);
  });

  it('propagates x-scratch-readonly from the schema onto the column', () => {
    const view = viewFor([
      makeField({ api_name: 'Last_Name', data_type: 'text' }),
      // Modified_Time is read-only via operation_type; a formula is computed-readonly.
      makeField({
        api_name: 'Modified_Time',
        data_type: 'datetime',
        operation_type: { api_update: false },
      }),
      makeField({ api_name: 'Score', data_type: 'formula', json_type: 'double' }),
    ]);
    expect(flatCol(view, 'Last_Name')?.readonly).toBe(false);
    expect(flatCol(view, 'Modified_Time')?.readonly).toBe(true);
    expect(flatCol(view, 'Score')?.readonly).toBe(true);
  });

  it('maps data types to column type hints', () => {
    const view = viewFor([
      makeField({ api_name: 'Email_Opt_Out', data_type: 'boolean' }),
      makeField({ api_name: 'Annual_Revenue', data_type: 'currency' }),
      makeField({ api_name: 'Created_Time', data_type: 'datetime' }),
      makeField({ api_name: 'Website', data_type: 'website' }),
      makeField({ api_name: 'Account_Name', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }),
    ]);
    expect(flatCol(view, 'Email_Opt_Out')?.type).toBe('checkbox');
    expect(flatCol(view, 'Annual_Revenue')?.type).toBe('number');
    expect(flatCol(view, 'Created_Time')?.type).toBe('date');
    expect(flatCol(view, 'Website')?.type).toBe('url');
    expect(flatCol(view, 'Account_Name')?.type).toBe('object');
  });

  // DEV-11097: bigint is stored as a string to preserve precision beyond 2^53, so the
  // column must be a 'string' — not 'number', which drives a lossy numeric destination.
  it('declares bigint fields as string columns, not number (precision beyond 2^53)', () => {
    const view = viewFor([
      makeField({ api_name: 'Big_Counter', data_type: 'bigint' }),
      makeField({ api_name: 'Plain_Int', data_type: 'integer' }),
    ]);
    expect(flatCol(view, 'Big_Counter')?.type).toBe('string');
    // integer stays a number — only bigint moves to string.
    expect(flatCol(view, 'Plain_Int')?.type).toBe('number');
    // The record id is bigint and already string-typed.
    expect(flatCol(view, 'id')?.type).toBe('string');
  });

  // DEV-11096: a single lookup is stored verbatim as `{ id, name }` with an
  // x-scratch-foreign-key annotation; the view must point the column at `$.id` and
  // declare the foreign key so the shared FK id-extraction resolves the id array
  // instead of leaking the raw object into the sync transform (which aborts the run).
  it('declares a foreign key and an $.id displayTransformer for single lookups', () => {
    const view = viewFor([
      makeField({ api_name: 'Account_Name', data_type: 'lookup', lookup: { module: { api_name: 'Accounts' } } }),
      makeField({ api_name: 'Owner', data_type: 'ownerlookup' }),
      makeField({ api_name: 'Created_By', data_type: 'userlookup' }),
    ]);

    const accountCol = flatCol(view, 'Account_Name');
    expect(accountCol?.foreignKey).toEqual({
      linkedTableId: 'Accounts',
      linkedTableRemoteId: ['Accounts'],
      isSingleValued: true,
    });
    expect(accountCol?.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$.id', arrayHandling: 'array' },
    });

    // Owner/created-by lookups target the synthetic users table.
    expect(flatCol(view, 'Owner')?.foreignKey).toEqual({
      linkedTableId: 'users',
      linkedTableRemoteId: ['users'],
      isSingleValued: true,
    });
    expect(flatCol(view, 'Created_By')?.foreignKey).toEqual({
      linkedTableId: 'users',
      linkedTableRemoteId: ['users'],
      isSingleValued: true,
    });
  });

  it('leaves multi-valued and target-less lookups without a foreign key', () => {
    const view = viewFor([
      // Multi-valued lookup: stored verbatim with no FK annotation.
      makeField({ api_name: 'Contacts', data_type: 'multiselectlookup' }),
      // A single lookup whose target module is unknown gets no FK annotation either.
      makeField({ api_name: 'Orphan_Lookup', data_type: 'lookup' }),
    ]);
    expect(flatCol(view, 'Contacts')?.foreignKey).toBeUndefined();
    expect(flatCol(view, 'Contacts')?.displayTransformer).toBeUndefined();
    expect(flatCol(view, 'Orphan_Lookup')?.foreignKey).toBeUndefined();
    expect(flatCol(view, 'Orphan_Lookup')?.displayTransformer).toBeUndefined();
  });

  // DEV-11100: Zoho's `Tag` field is always an array of `{ name, id }` objects (its
  // metadata mislabels it `text`). The view must render it as an object column with a
  // displayTransformer that flattens to a comma-joined list of tag NAMES, so
  // string-typed destinations (Notion, Airtable) receive text instead of the raw
  // array they reject.
  it('gives Tag an object column with a $[*].name join_comma displayTransformer', () => {
    const view = viewFor([
      makeField({ api_name: 'Last_Name', data_type: 'text' }),
      makeField({ api_name: 'Tag', data_type: 'text' }),
    ]);
    const tagCol = flatCol(view, 'Tag');
    expect(tagCol?.type).toBe('object');
    expect(tagCol?.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].name', arrayHandling: 'join_comma' },
    });
    // A plain text field stays a string with no transformer.
    expect(flatCol(view, 'Last_Name')?.type).toBe('string');
    expect(flatCol(view, 'Last_Name')?.displayTransformer).toBeUndefined();
  });

  it('only emits columns for fields that made it into the schema', () => {
    // The view is derived purely from the schema's properties, so a name that was
    // never a schema field simply has no column — no crash, no phantom column.
    const view = viewFor([makeField({ api_name: 'Last_Name', data_type: 'text' })]);
    expect(flatCol(view, 'Last_Name')).toBeDefined();
    expect(flatCol(view, 'Phantom')).toBeUndefined();
  });
});
