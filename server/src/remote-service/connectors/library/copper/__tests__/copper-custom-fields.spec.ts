import {
  buildCopperCustomFieldsArrayKeyedByOptions,
  copperCustomFieldColumnPath,
  isReadonlyCopperCustomField,
  tablePropertyTypeForCopperCustomFieldDataType,
} from '../copper-custom-fields';
import { CopperCustomFieldDefinition } from '../copper-types';

describe('isReadonlyCopperCustomField', () => {
  it('marks computed and Connect fields read-only', () => {
    expect(isReadonlyCopperCustomField({ id: 1, name: 'Score', data_type: 'Float', is_computed: true })).toBe(true);
    expect(isReadonlyCopperCustomField({ id: 2, name: 'Linked', data_type: 'Connect' })).toBe(true);
  });

  it('leaves ordinary fields writable', () => {
    expect(isReadonlyCopperCustomField({ id: 3, name: 'Tier', data_type: 'String' })).toBe(false);
  });
});

describe('tablePropertyTypeForCopperCustomFieldDataType', () => {
  it('maps data types to column type hints', () => {
    expect(tablePropertyTypeForCopperCustomFieldDataType('Checkbox')).toBe('checkbox');
    expect(tablePropertyTypeForCopperCustomFieldDataType('Currency')).toBe('number');
    expect(tablePropertyTypeForCopperCustomFieldDataType('URL')).toBe('url');
    expect(tablePropertyTypeForCopperCustomFieldDataType('MultiSelect')).toBe('object');
    expect(tablePropertyTypeForCopperCustomFieldDataType('Dropdown')).toBe('string');
  });
});

describe('copperCustomFieldColumnPath', () => {
  it('builds the filtered editable path for a custom field', () => {
    expect(copperCustomFieldColumnPath(700123)).toBe('custom_fields.[custom_field_definition_id=700123].value');
  });
});

describe('buildCopperCustomFieldsArrayKeyedByOptions', () => {
  const definitions: CopperCustomFieldDefinition[] = [
    { id: 700123, name: 'Tier', data_type: 'String' },
    { id: 700124, name: 'Score', data_type: 'Float', is_computed: true },
  ];

  it('emits keyField, valuePath and one column per definition', () => {
    expect(buildCopperCustomFieldsArrayKeyedByOptions(definitions)).toEqual({
      keyField: 'custom_field_definition_id',
      valuePath: 'value',
      columns: [
        { key: 700123, name: 'Tier', type: 'string', readonly: undefined },
        { key: 700124, name: 'Score', type: 'number', readonly: true },
      ],
    });
  });

  it('emits no columns for an account with no custom fields', () => {
    expect(buildCopperCustomFieldsArrayKeyedByOptions([]).columns).toEqual([]);
  });
});
