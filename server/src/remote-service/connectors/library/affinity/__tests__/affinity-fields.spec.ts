import { X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import {
  affinityFieldColumnPath,
  affinityFieldValueTypeFromSchemasById,
  buildAffinityFieldsArrayKeyedByOptions,
  buildAffinityFieldSchemasById,
  FIELD_KEY_FIELD,
  FIELDS_KEY,
  getAffinityFieldSchemasById,
  isReadOnlyAffinityField,
  tablePropertyTypeForAffinityValueType,
  X_SCRATCH_AFFINITY_FIELDS_BY_ID,
} from '../affinity-fields';
import { AffinityFieldMetadata } from '../affinity-types';

function makeField(overrides: Partial<AffinityFieldMetadata> & { id: string }): AffinityFieldMetadata {
  return {
    id: overrides.id,
    name: overrides.name ?? `Field ${overrides.id}`,
    type: overrides.type ?? 'list',
    enrichmentSource: overrides.enrichmentSource ?? null,
    valueType: overrides.valueType ?? 'text',
  };
}

describe('constants', () => {
  it('keys the fields array by its stable id', () => {
    expect(FIELDS_KEY).toBe('fields');
    expect(FIELD_KEY_FIELD).toBe('id');
  });
});

describe('isReadOnlyAffinityField', () => {
  it('treats enriched and relationship-intelligence categories as read-only', () => {
    expect(isReadOnlyAffinityField('enriched', 'text')).toBe(true);
    expect(isReadOnlyAffinityField('relationship-intelligence', 'interaction')).toBe(true);
  });

  it('treats interaction and formula-number value types as read-only even in writable categories', () => {
    expect(isReadOnlyAffinityField('list', 'interaction')).toBe(true);
    expect(isReadOnlyAffinityField('global', 'formula-number')).toBe(true);
  });

  it('treats list/global fields with writable value types as writable', () => {
    expect(isReadOnlyAffinityField('list', 'text')).toBe(false);
    expect(isReadOnlyAffinityField('global', 'dropdown')).toBe(false);
  });
});

describe('tablePropertyTypeForAffinityValueType', () => {
  it('maps primitive value types to column type hints', () => {
    expect(tablePropertyTypeForAffinityValueType('text')).toBe('string');
    expect(tablePropertyTypeForAffinityValueType('filterable-text')).toBe('string');
    expect(tablePropertyTypeForAffinityValueType('number')).toBe('number');
    expect(tablePropertyTypeForAffinityValueType('formula-number')).toBe('number');
    expect(tablePropertyTypeForAffinityValueType('datetime')).toBe('date');
  });

  it('falls back to object for structured / unknown / missing value types', () => {
    expect(tablePropertyTypeForAffinityValueType('dropdown')).toBe('object');
    expect(tablePropertyTypeForAffinityValueType('location')).toBe('object');
    expect(tablePropertyTypeForAffinityValueType('person-multi')).toBe('object');
    expect(tablePropertyTypeForAffinityValueType(undefined)).toBe('object');
  });
});

describe('affinityFieldColumnPath', () => {
  it('builds the filtered editable path for a field — the whole element, no valuePath', () => {
    expect(affinityFieldColumnPath('field-1234')).toBe('fields.[id=field-1234]');
    expect(affinityFieldColumnPath('affinity-data-location')).toBe('fields.[id=affinity-data-location]');
  });
});

describe('buildAffinityFieldsArrayKeyedByOptions', () => {
  const definitions: AffinityFieldMetadata[] = [
    makeField({ id: 'field-1', name: 'Stage', valueType: 'dropdown', type: 'list' }),
    makeField({ id: 'affinity-data-growth', name: 'Growth', valueType: 'number', type: 'enriched' }),
  ];

  it('emits keyField id, NO valuePath, and one column per definition', () => {
    const options = buildAffinityFieldsArrayKeyedByOptions(definitions);
    expect(options.keyField).toBe('id');
    // The whole element is the value — there is no valuePath.
    expect(options.valuePath).toBeUndefined();
    expect(options.columns).toEqual([
      { key: 'field-1', name: 'Stage', type: 'object', readonly: undefined },
      // enriched → read-only
      { key: 'affinity-data-growth', name: 'Growth', type: 'number', readonly: true },
    ]);
  });

  it('emits no columns for a table with no fields', () => {
    expect(buildAffinityFieldsArrayKeyedByOptions([]).columns).toEqual([]);
  });
});

describe('buildAffinityFieldSchemasById', () => {
  it('records each field id → its valueType and read-only bit', () => {
    const map = buildAffinityFieldSchemasById([
      makeField({ id: 'field-1', valueType: 'ranked-dropdown', type: 'list' }),
      makeField({ id: 'enriched-1', valueType: 'number', type: 'enriched' }),
    ]);
    expect(map['field-1']).toEqual({ [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'ranked-dropdown' });
    expect(map['enriched-1']).toEqual({ [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'number', [X_SCRATCH_READONLY]: true });
  });
});

describe('getAffinityFieldSchemasById / affinityFieldValueTypeFromSchemasById', () => {
  const byId = { 'field-1': { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'dropdown' } };

  it('reads the map off the array property annotation (direct and inside anyOf)', () => {
    expect(getAffinityFieldSchemasById({ [X_SCRATCH_AFFINITY_FIELDS_BY_ID]: byId })).toEqual(byId);
    expect(
      getAffinityFieldSchemasById({ anyOf: [{ [X_SCRATCH_AFFINITY_FIELDS_BY_ID]: byId }, { type: 'null' }] }),
    ).toEqual(byId);
    expect(getAffinityFieldSchemasById({ type: 'array' })).toBeUndefined();
    expect(getAffinityFieldSchemasById(undefined)).toBeUndefined();
  });

  it('recovers a field id → valueType', () => {
    expect(affinityFieldValueTypeFromSchemasById(byId, 'field-1')).toBe('dropdown');
    expect(affinityFieldValueTypeFromSchemasById(byId, 'missing')).toBeUndefined();
    expect(affinityFieldValueTypeFromSchemasById(undefined, 'field-1')).toBeUndefined();
  });
});
