import {
  ArrayKeyedByOptions,
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_ARRAY_KEYED_BY,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_CUSTOM_FIELD,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import { EntityId } from '../../../types';
import {
  buildContactsJsonTableSpec,
  buildCustomObjectDefaultView,
  buildCustomObjectJsonTableSpec,
  buildOpportunitiesJsonTableSpec,
  buildStandardEntityDefaultView,
} from '../gohighlevel-json-schema';
import { GoHighLevelCustomFieldDefinition, GoHighLevelObjectField } from '../gohighlevel-types';

const CONTACTS_ID: EntityId = { wsId: 'contacts', remoteId: ['contacts'] };
const OPPORTUNITIES_ID: EntityId = { wsId: 'opportunities', remoteId: ['opportunities'] };

// The default view is now a pure function of the spec (MR2): schema-gen no longer
// stores it, so rebuild it from the spec via the exported builder.
function contactsProperties(defs: GoHighLevelCustomFieldDefinition[] = []) {
  const spec = buildContactsJsonTableSpec(CONTACTS_ID, defs);
  const schema = spec.schema as unknown as { properties: Record<string, Record<string, unknown>> };
  return { spec, properties: schema.properties, view: buildStandardEntityDefaultView(spec) };
}

function opportunitiesProperties(defs: GoHighLevelCustomFieldDefinition[] = []) {
  const spec = buildOpportunitiesJsonTableSpec(OPPORTUNITIES_ID, defs);
  const schema = spec.schema as unknown as { properties: Record<string, Record<string, unknown>> };
  return { spec, properties: schema.properties, view: buildStandardEntityDefaultView(spec) };
}

/** Flatten a default view's columns (banner groups inlined) for path lookups. */
function flattenViewCols(view: TableView | undefined): TableViewCol[] {
  const cols: TableViewCol[] = [];
  for (const entry of view?.cols ?? []) {
    if ((entry as TableViewBannerGroup).kind === 'banner-group') {
      cols.push(...(entry as TableViewBannerGroup).cols);
    } else {
      cols.push(entry as TableViewCol);
    }
  }
  return cols;
}

describe('buildContactsJsonTableSpec — verbatim customFields array', () => {
  it('exposes customFields as a verbatim array keyed by id with valuePath `value`', () => {
    const defs: GoHighLevelCustomFieldDefinition[] = [
      { id: 'cf_tier', name: 'Tier', dataType: 'TEXT', fieldKey: 'contact.tier' },
    ];
    const { properties } = contactsProperties(defs);
    const customFields = properties.customFields as { type?: string; [key: string]: unknown };
    // Stored verbatim as an array — never reshaped to an object on disk.
    expect(customFields.type).toBe('array');
    // The old reshaped keyed object must be gone.
    expect(properties.custom_fields).toBeUndefined();

    const keyedBy = customFields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    expect(keyedBy.keyField).toBe('id');
    expect(keyedBy.valuePath).toBe('value');
    expect(keyedBy.columns).toContainEqual({ key: 'cf_tier', name: 'Tier', type: 'string' });
  });

  it('lays custom-field columns out under a "Custom Fields" banner with the filtered path', () => {
    const defs: GoHighLevelCustomFieldDefinition[] = [
      { id: 'cf_tier', name: 'Tier', dataType: 'TEXT', fieldKey: 'contact.tier' },
    ];
    const { view } = contactsProperties(defs);
    const banner = view.cols.find(
      (col): col is TableViewBannerGroup => (col as TableViewBannerGroup).kind === 'banner-group',
    );
    expect(banner?.name).toBe('Custom Fields');
    expect(banner?.cols).toContainEqual({
      kind: 'col',
      path: 'customFields.[id=cf_tier].value',
      name: 'Tier',
      type: 'string',
    });
    // The verbatim array key itself is not emitted as a flat column.
    expect(flattenViewCols(view).some((col) => col.path === 'customFields')).toBe(false);
  });

  it('adds a definition-id legend for agents at the schema root (verbatim path)', () => {
    const defs: GoHighLevelCustomFieldDefinition[] = [
      {
        id: 'cf_tier',
        name: 'Tier',
        dataType: 'SINGLE_OPTIONS',
        fieldKey: 'contact.tier',
        picklistOptions: ['A', 'B'],
      },
    ];
    const { spec } = contactsProperties(defs);
    const instructions = (spec.schema as unknown as Record<string, unknown>)[X_SCRATCH_AGENT_INSTRUCTIONS] as string;
    expect(instructions).toContain('customFields.[id=<id>].value');
    expect(instructions).toContain('id: cf_tier');
    expect(instructions).toContain('Tier');
    expect(instructions).toContain('options: A | B');
  });
});

describe('buildOpportunitiesJsonTableSpec — verbatim customFields array', () => {
  it('exposes customFields keyed by id with valuePath `fieldValue` (read-key asymmetry)', () => {
    const defs: GoHighLevelCustomFieldDefinition[] = [
      { id: 'cf_amt', name: 'Deal Size', dataType: 'MONETORY', fieldKey: 'opportunity.deal_size' },
    ];
    const { properties } = opportunitiesProperties(defs);
    const customFields = properties.customFields as { type?: string; [key: string]: unknown };
    expect(customFields.type).toBe('array');
    expect(properties.custom_fields).toBeUndefined();

    const keyedBy = customFields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    expect(keyedBy.keyField).toBe('id');
    expect(keyedBy.valuePath).toBe('fieldValue');
    expect(keyedBy.columns).toContainEqual({ key: 'cf_amt', name: 'Deal Size', type: 'number' });
  });

  it('lays custom-field columns out under a "Custom Fields" banner with the fieldValue path', () => {
    const defs: GoHighLevelCustomFieldDefinition[] = [
      { id: 'cf_amt', name: 'Deal Size', dataType: 'MONETORY', fieldKey: 'opportunity.deal_size' },
    ];
    const { view } = opportunitiesProperties(defs);
    const banner = view.cols.find(
      (col): col is TableViewBannerGroup => (col as TableViewBannerGroup).kind === 'banner-group',
    );
    expect(banner?.name).toBe('Custom Fields');
    expect(banner?.cols).toContainEqual({
      kind: 'col',
      path: 'customFields.[id=cf_amt].fieldValue',
      name: 'Deal Size',
      type: 'number',
    });
  });
});

describe('buildContactsJsonTableSpec — no custom fields', () => {
  it('still exposes an (empty-column) verbatim array and no banner group', () => {
    const { properties, view } = contactsProperties([]);
    const customFields = properties.customFields as { type?: string; [key: string]: unknown };
    expect(customFields.type).toBe('array');
    const keyedBy = customFields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    expect(keyedBy.columns).toEqual([]);
    expect(view.cols.some((col) => (col as TableViewBannerGroup).kind === 'banner-group')).toBe(false);
  });
});

describe('buildCustomObjectJsonTableSpec — custom-object default view (MR2 spec→view)', () => {
  const OBJECT_ID: EntityId = { wsId: 'custom_objects_pet', remoteId: ['custom_objects.pet'] };
  const OBJECT_DEFINITION = { key: 'custom_objects.pet', labels: { singular: 'Pet', plural: 'Pets' } };
  const FIELDS: GoHighLevelObjectField[] = [
    // A built-in standard object field (renders flat).
    { fieldKey: 'custom_objects.pet.name', name: 'Name', dataType: 'TEXT', standard: true },
    // A user-defined custom field (grouped under the banner).
    { fieldKey: 'custom_objects.pet.adopted_on', name: 'Adopted On', dataType: 'DATE', standard: false },
    { fieldKey: 'custom_objects.pet.weight', name: 'Weight', dataType: 'NUMERICAL', standard: false },
  ];

  it('records the raw dataType and custom/standard provenance on each field sub-schema', () => {
    const spec = buildCustomObjectJsonTableSpec(OBJECT_ID, OBJECT_DEFINITION, FIELDS);
    const propsBag = (
      spec.schema as unknown as { properties: { properties: { properties: Record<string, Record<string, unknown>> } } }
    ).properties.properties.properties;

    // Standard field: dataType recorded, NOT flagged custom.
    expect(propsBag.name[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('TEXT');
    expect(propsBag.name[X_SCRATCH_CUSTOM_FIELD]).toBeUndefined();
    // Custom DATE field: dataType recorded (so the view can recover the date hint,
    // which the permissive union would otherwise lose), and flagged custom.
    expect(propsBag.adopted_on[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('DATE');
    expect(propsBag.adopted_on[X_SCRATCH_CUSTOM_FIELD]).toBe(true);
  });

  it('splits standard vs custom fields and recovers the DATE column type from the schema', () => {
    const spec = buildCustomObjectJsonTableSpec(OBJECT_ID, OBJECT_DEFINITION, FIELDS);
    const view = buildCustomObjectDefaultView(spec);

    // Standard field renders flat (right after id).
    expect(view.cols[0]).toMatchObject({ kind: 'col', path: 'id', readonly: true });
    expect(view.cols[1]).toMatchObject({ kind: 'col', path: 'properties.name', name: 'Name', type: 'string' });

    // Custom fields gather under the banner; the DATE hint survives to the column.
    const banner = view.cols.find(
      (col): col is TableViewBannerGroup => (col as TableViewBannerGroup).kind === 'banner-group',
    );
    expect(banner?.name).toBe('Custom Fields');
    expect(banner?.cols).toContainEqual({
      kind: 'col',
      path: 'properties.adopted_on',
      name: 'Adopted On',
      type: 'date',
    });
    expect(banner?.cols).toContainEqual({ kind: 'col', path: 'properties.weight', name: 'Weight', type: 'number' });
  });
});
