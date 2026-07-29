import type { TableView, TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';
import { PipedriveApiClient } from '../pipedrive-api-client';
import { buildPipedriveDefaultView } from '../pipedrive-default-view';
import { buildPipedriveJsonTableSpec } from '../pipedrive-json-schema';
import { PipedriveField } from '../pipedrive-types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
}));

function makeField(overrides: Partial<PipedriveField> & { field_type: string }): PipedriveField {
  return {
    field_name: overrides.field_name ?? 'Test Field',
    field_code: overrides.field_code ?? 'test_field',
    field_type: overrides.field_type,
    is_custom_field: overrides.is_custom_field ?? false,
    options: overrides.options ?? null,
    subfields: overrides.subfields ?? null,
  };
}

const mockClient = { getFields: jest.fn() };

/** Build a REAL spec through the schema builder (mocked Fields endpoint), then the view from it. */
async function buildViewForDeals(fields: PipedriveField[]): Promise<TableView> {
  mockClient.getFields.mockResolvedValue(fields);
  const spec = await buildPipedriveJsonTableSpec(
    { wsId: 'deals', remoteId: ['deals'] },
    'deals',
    mockClient as unknown as PipedriveApiClient,
  );
  return buildPipedriveDefaultView(spec);
}

/** Flatten the view to all columns (visible AND hidden), expanding banner groups. */
function allColumns(view: TableView): TableViewCol[] {
  return view.cols.flatMap((entry) => (entry.kind === 'banner-group' ? entry.cols : [entry]));
}

function findColumn(view: TableView, path: string): TableViewCol | undefined {
  return allColumns(view).find((col) => col.path === path);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildPipedriveDefaultView', () => {
  const CUSTOM_HASH = 'a'.repeat(40);

  it('types date and datetime fields as date columns (DEV-11033)', async () => {
    const view = await buildViewForDeals([
      makeField({ field_code: 'title', field_name: 'Title', field_type: 'varchar' }),
      makeField({ field_code: 'add_time', field_name: 'Add time', field_type: 'date' }),
      makeField({ field_code: 'expected_close_date', field_name: 'Expected close date', field_type: 'date' }),
    ]);

    // Both the datetime system field and the date-only field type 'date' — the plan generator
    // recovers time-of-day from the schema's own `format: 'date-time'` (includesTime).
    expect(findColumn(view, 'add_time')?.type).toBe('date');
    expect(findColumn(view, 'expected_close_date')?.type).toBe('date');
  });

  it('orders the title column first and the id column second', async () => {
    const view = await buildViewForDeals([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int' }),
      makeField({ field_code: 'add_time', field_name: 'Add time', field_type: 'date' }),
      makeField({ field_code: 'title', field_name: 'Title', field_type: 'varchar' }),
    ]);

    const topLevelPaths = view.cols.filter((entry) => entry.kind === 'col').map((entry) => entry.path);
    expect(topLevelPaths.slice(0, 2)).toEqual(['title', 'id']);
  });

  it('attaches a value_map codec exporting labels for an enum custom field (DEV-11034)', async () => {
    const view = await buildViewForDeals([
      makeField({
        field_code: CUSTOM_HASH,
        field_name: 'Deal Select',
        field_type: 'enum',
        is_custom_field: true,
        options: [
          { id: 33, label: 'Opt, B' },
          { id: 34, label: 'émoji 🚀 opt' },
        ],
      }),
    ]);

    const enumColumn = findColumn(view, `custom_fields.${CUSTOM_HASH}`);
    expect(enumColumn?.type).toBe('string');
    expect(enumColumn?.codec?.toCore).toEqual({
      type: 'value_map',
      options: { mapping: { '33': 'Opt, B', '34': 'émoji 🚀 opt' } },
    });
  });

  it('attaches an element-wise value_map codec for a set custom field (DEV-11034)', async () => {
    const view = await buildViewForDeals([
      makeField({
        field_code: CUSTOM_HASH,
        field_name: 'Deal Tags',
        field_type: 'set',
        is_custom_field: true,
        options: [
          { id: 36, label: 'Tag One' },
          { id: 37, label: 'Tag "Two"' },
        ],
      }),
    ]);

    const setColumn = findColumn(view, `custom_fields.${CUSTOM_HASH}`);
    expect(setColumn?.type).toBe('string');
    expect(setColumn?.codec?.toCore).toEqual({
      type: 'map_array',
      options: {
        elementTransformer: { type: 'value_map', options: { mapping: { '36': 'Tag One', '37': 'Tag "Two"' } } },
      },
    });
  });

  it('does NOT mistake the empty-date sentinel literals for select options', async () => {
    const view = await buildViewForDeals([
      makeField({ field_code: 'expected_close_date', field_name: 'Expected close date', field_type: 'date' }),
    ]);

    // The date union carries `const` members (the '0000-00-00' / '-0001-11-30' sentinels) but no
    // titles — it must stay a plain date column, not become a value_map select.
    const dateColumn = findColumn(view, 'expected_close_date');
    expect(dateColumn?.type).toBe('date');
    expect(dateColumn?.codec).toBeUndefined();
  });

  it('joins email/phone multi-value arrays via a $[*].value display transformer (DEV-11035)', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'name', field_name: 'Name', field_type: 'varchar' }),
      makeField({ field_code: 'emails', field_name: 'Emails', field_type: 'varchar' }),
      makeField({ field_code: 'phones', field_name: 'Phones', field_type: 'phone' }),
    ]);
    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'persons', remoteId: ['persons'] },
      'persons',
      mockClient as unknown as PipedriveApiClient,
    );
    const view = buildPipedriveDefaultView(spec);

    for (const path of ['emails', 'phones']) {
      const column = findColumn(view, path);
      expect(column?.type).toBe('string');
      expect(column?.displayTransformer).toEqual({
        type: 'jsonpath',
        options: { expression: '$[*].value', arrayHandling: 'join_comma' },
      });
    }
  });

  it('renders a CUSTOM phone field (a bare string) as a plain column with no array codec (DEV-11042)', async () => {
    // A Pipedrive v2 custom phone field stores a bare string ("+34 915 000 000"), NOT the system
    // multi-value array. It must not get the `$[*].value` join_comma jsonpath codec — that codec
    // JSON-parses the bare string, throws, and aborts the entire table's sync.
    const view = await buildViewForDeals([
      makeField({ field_code: 'title', field_name: 'Title', field_type: 'varchar' }),
      makeField({ field_code: CUSTOM_HASH, field_name: 'Address Phone', field_type: 'phone', is_custom_field: true }),
    ]);

    const phoneColumn = findColumn(view, `custom_fields.${CUSTOM_HASH}`);
    expect(phoneColumn?.type).toBe('string');
    expect(phoneColumn?.displayTransformer).toBeUndefined();
    expect(phoneColumn?.codec).toBeUndefined();
  });

  it('unpacks composite fields into named subfield columns and hides the raw container (DEV-11036)', async () => {
    const view = await buildViewForDeals([
      makeField({
        field_code: CUSTOM_HASH,
        field_name: 'Deal Dates',
        field_type: 'daterange',
        is_custom_field: true,
      }),
    ]);

    const valueColumn = findColumn(view, `custom_fields.${CUSTOM_HASH}.value`);
    const untilColumn = findColumn(view, `custom_fields.${CUSTOM_HASH}.until`);
    expect(valueColumn).toEqual(expect.objectContaining({ name: 'Deal Dates (Value)', type: 'date' }));
    expect(untilColumn).toEqual(expect.objectContaining({ name: 'Deal Dates (Until)', type: 'date' }));

    const containerColumn = findColumn(view, `custom_fields.${CUSTOM_HASH}`);
    expect(containerColumn?.hidden).toBe(true);
  });

  it('hides the custom_fields container and groups custom fields under a banner (DEV-11036)', async () => {
    const view = await buildViewForDeals([
      makeField({ field_code: 'title', field_name: 'Title', field_type: 'varchar' }),
      makeField({ field_code: CUSTOM_HASH, field_name: 'My Custom', field_type: 'varchar', is_custom_field: true }),
    ]);

    const bannerGroup = view.cols.find((entry): entry is TableViewBannerGroup => entry.kind === 'banner-group');
    expect(bannerGroup?.name).toBe('Custom Fields');
    expect(bannerGroup?.cols.map((col) => col.path)).toEqual([`custom_fields.${CUSTOM_HASH}`]);

    const containerColumn = view.cols.find((entry) => entry.kind === 'col' && entry.path === 'custom_fields');
    expect(containerColumn && containerColumn.kind === 'col' && containerColumn.hidden).toBe(true);
  });

  it("hides notes' server-hydrated stub columns (DEV-11036)", async () => {
    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'notes', remoteId: ['notes'] },
      'notes',
      mockClient as unknown as PipedriveApiClient,
    );
    const view = buildPipedriveDefaultView(spec);

    for (const stubPath of ['organization', 'person', 'deal', 'lead', 'user']) {
      expect(findColumn(view, stubPath)?.hidden).toBe(true);
    }
    // The FK columns the stubs duplicate stay visible.
    expect(findColumn(view, 'deal_id')?.hidden).toBeUndefined();
    expect(findColumn(view, 'content')?.hidden).toBeUndefined();
  });

  it('surfaces activity participants as a multi-value FK to persons, not a JSON blob (DEV-11051)', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'subject', field_name: 'Subject', field_type: 'varchar' }),
      // `participants` is overridden to the verbatim `[{person_id, primary}]` array shape by the
      // schema builder regardless of the metadata field_type.
      makeField({ field_code: 'participants', field_name: 'Participants', field_type: 'varchar' }),
    ]);
    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'activities', remoteId: ['activities'] },
      'activities',
      mockClient as unknown as PipedriveApiClient,
    );
    const view = buildPipedriveDefaultView(spec);

    const participantsColumn = findColumn(view, 'participants');
    // Rendered through the text cell so the display transformer runs, but declared as an FK so a
    // plan links it to persons — never a raw object/JSON blob.
    expect(participantsColumn?.type).toBe('string');
    expect(participantsColumn?.foreignKey).toEqual({ linkedTableId: 'persons', linkedTableRemoteId: ['persons'] });
    expect(participantsColumn?.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].person_id', arrayHandling: 'join_comma' },
    });
    // Editable: the codec collapses to/from the neutral list of person ids without reshaping the
    // on-disk `[{person_id, primary}]` array.
    expect(participantsColumn?.codec?.toCore).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].person_id', arrayHandling: 'array' },
    });
    expect(participantsColumn?.codec?.fromCore).toEqual({
      type: 'map_array',
      options: { elementTransformer: { type: 'wrap_object', options: { template: { person_id: '$value' } } } },
    });
    expect(participantsColumn?.readonly).toBeUndefined();
  });

  it('pins picture_id to a plain number column with no url subfield (avoids the DEV-11030 plan trap)', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'name', field_name: 'Name', field_type: 'varchar' }),
      makeField({ field_code: 'picture_id', field_name: 'Picture', field_type: 'picture' }),
    ]);
    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'persons', remoteId: ['persons'] },
      'persons',
      mockClient as unknown as PipedriveApiClient,
    );
    const view = buildPipedriveDefaultView(spec);

    expect(findColumn(view, 'picture_id')?.type).toBe('number');
    expect(findColumn(view, 'picture_id.url')).toBeUndefined();
  });

  it('types static-schema (leads/notes) timestamp fields as date columns so they export as timestamps (DEV-11043)', async () => {
    mockClient.getFields.mockResolvedValue([]);

    const leadsSpec = await buildPipedriveJsonTableSpec(
      { wsId: 'leads', remoteId: ['leads'] },
      'leads',
      mockClient as unknown as PipedriveApiClient,
    );
    const leadsView = buildPipedriveDefaultView(leadsSpec);
    // add_time/update_time/archive_time carry format: 'date-time'; expected_close_date is date-only.
    for (const path of ['add_time', 'update_time', 'archive_time', 'expected_close_date']) {
      expect(findColumn(leadsView, path)?.type).toBe('date');
    }

    const notesSpec = await buildPipedriveJsonTableSpec(
      { wsId: 'notes', remoteId: ['notes'] },
      'notes',
      mockClient as unknown as PipedriveApiClient,
    );
    const notesView = buildPipedriveDefaultView(notesSpec);
    for (const path of ['add_time', 'update_time']) {
      expect(findColumn(notesView, path)?.type).toBe('date');
    }
  });

  it("groups a lead's flat custom-field hash keys under the Custom Fields banner", async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({
        field_code: CUSTOM_HASH,
        field_name: 'Shared Deal Custom',
        field_type: 'varchar',
        is_custom_field: true,
      }),
    ]);
    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'leads', remoteId: ['leads'] },
      'leads',
      mockClient as unknown as PipedriveApiClient,
    );
    const view = buildPipedriveDefaultView(spec);

    const bannerGroup = view.cols.find((entry): entry is TableViewBannerGroup => entry.kind === 'banner-group');
    expect(bannerGroup?.cols.map((col) => col.path)).toEqual([CUSTOM_HASH]);

    // A lead's static system `value` is a `{amount, currency}` monetary composite: unpacked
    // subfields visible, container hidden.
    expect(findColumn(view, 'value.amount')?.type).toBe('number');
    expect(findColumn(view, 'value.currency')?.type).toBe('string');
    expect(findColumn(view, 'value')?.hidden).toBe(true);

    // label_ids (a plain string array) joins comma-separated instead of raw JSON text.
    expect(findColumn(view, 'label_ids')?.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*]', arrayHandling: 'join_comma' },
    });
  });
});
