import {
  ArrayKeyedByOptions,
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_ARRAY_KEYED_BY,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildContactsJsonTableSpec, buildOpportunitiesJsonTableSpec } from '../gohighlevel-json-schema';
import { GoHighLevelCustomFieldDefinition } from '../gohighlevel-types';

const CONTACTS_ID: EntityId = { wsId: 'contacts', remoteId: ['contacts'] };
const OPPORTUNITIES_ID: EntityId = { wsId: 'opportunities', remoteId: ['opportunities'] };

function contactsProperties(defs: GoHighLevelCustomFieldDefinition[] = []) {
  const spec = buildContactsJsonTableSpec(CONTACTS_ID, defs);
  const schema = spec.schema as unknown as { properties: Record<string, Record<string, unknown>> };
  return { spec, properties: schema.properties };
}

function opportunitiesProperties(defs: GoHighLevelCustomFieldDefinition[] = []) {
  const spec = buildOpportunitiesJsonTableSpec(OPPORTUNITIES_ID, defs);
  const schema = spec.schema as unknown as { properties: Record<string, Record<string, unknown>> };
  return { spec, properties: schema.properties };
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
    const { spec } = contactsProperties(defs);
    const banner = spec.defaultView?.cols.find(
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
    expect(flattenViewCols(spec.defaultView).some((col) => col.path === 'customFields')).toBe(false);
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
    const { spec } = opportunitiesProperties(defs);
    const banner = spec.defaultView?.cols.find(
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
    const { properties, spec } = contactsProperties([]);
    const customFields = properties.customFields as { type?: string; [key: string]: unknown };
    expect(customFields.type).toBe('array');
    const keyedBy = customFields[X_SCRATCH_ARRAY_KEYED_BY] as ArrayKeyedByOptions;
    expect(keyedBy.columns).toEqual([]);
    expect(spec.defaultView?.cols.some((col) => (col as TableViewBannerGroup).kind === 'banner-group')).toBe(false);
  });
});
