import {
  buildGoHighLevelCustomFieldsArrayKeyedByOptions,
  goHighLevelCustomFieldColumnPath,
  tablePropertyTypeForGoHighLevelDataType,
} from '../gohighlevel-custom-fields';
import { GoHighLevelCustomFieldDefinition } from '../gohighlevel-types';

describe('tablePropertyTypeForGoHighLevelDataType', () => {
  it('maps data types to column type hints (case-insensitive)', () => {
    expect(tablePropertyTypeForGoHighLevelDataType('NUMERICAL')).toBe('number');
    expect(tablePropertyTypeForGoHighLevelDataType('float')).toBe('number');
    expect(tablePropertyTypeForGoHighLevelDataType('MONETORY')).toBe('number');
    expect(tablePropertyTypeForGoHighLevelDataType('DATE')).toBe('date');
    expect(tablePropertyTypeForGoHighLevelDataType('CHECKBOX')).toBe('object');
    expect(tablePropertyTypeForGoHighLevelDataType('MULTIPLE_OPTIONS')).toBe('object');
    expect(tablePropertyTypeForGoHighLevelDataType('TEXT')).toBe('string');
    expect(tablePropertyTypeForGoHighLevelDataType(undefined)).toBe('string');
  });
});

describe('goHighLevelCustomFieldColumnPath', () => {
  it('builds the filtered editable path for a contact custom field (value)', () => {
    expect(goHighLevelCustomFieldColumnPath('abc123', 'value')).toBe('customFields.[id=abc123].value');
  });

  it('builds the filtered editable path for an opportunity custom field (fieldValue)', () => {
    expect(goHighLevelCustomFieldColumnPath('abc123', 'fieldValue')).toBe('customFields.[id=abc123].fieldValue');
  });
});

describe('buildGoHighLevelCustomFieldsArrayKeyedByOptions', () => {
  const definitions: GoHighLevelCustomFieldDefinition[] = [
    { id: 'def_text', name: 'Tier', dataType: 'TEXT', fieldKey: 'contact.tier' },
    { id: 'def_num', name: 'Score', dataType: 'NUMERICAL', fieldKey: 'contact.score' },
  ];

  it('emits keyField `id`, the contact valuePath `value`, and one column per definition', () => {
    expect(buildGoHighLevelCustomFieldsArrayKeyedByOptions(definitions, 'value')).toEqual({
      keyField: 'id',
      valuePath: 'value',
      columns: [
        { key: 'def_text', name: 'Tier', type: 'string' },
        { key: 'def_num', name: 'Score', type: 'number' },
      ],
    });
  });

  it('emits the opportunity valuePath `fieldValue`', () => {
    expect(buildGoHighLevelCustomFieldsArrayKeyedByOptions(definitions, 'fieldValue').valuePath).toBe('fieldValue');
  });

  it('falls back to the id for a nameless definition and carries no readonly (GHL has no read-only signal)', () => {
    const options = buildGoHighLevelCustomFieldsArrayKeyedByOptions([{ id: 'def_x', dataType: 'TEXT' }], 'value');
    expect(options.columns).toEqual([{ key: 'def_x', name: 'def_x', type: 'string' }]);
    expect(options.columns[0].readonly).toBeUndefined();
  });

  it('emits no columns for a location with no custom fields', () => {
    expect(buildGoHighLevelCustomFieldsArrayKeyedByOptions([], 'value').columns).toEqual([]);
  });
});
