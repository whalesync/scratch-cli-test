import {
  customFieldColumnKey,
  parseCustomFieldColumnKey,
  reshapeCustomFieldsArrayToObject,
  reshapeCustomFieldsObjectToArray,
} from '../copper-custom-fields';

describe('custom-field column keys', () => {
  it('round-trips a definition id through the column key', () => {
    expect(customFieldColumnKey(700123)).toBe('cf_700123');
    expect(parseCustomFieldColumnKey('cf_700123')).toBe(700123);
  });

  it('rejects keys that are not cf_<integer>', () => {
    expect(parseCustomFieldColumnKey('name')).toBeNull();
    expect(parseCustomFieldColumnKey('cf_')).toBeNull();
    expect(parseCustomFieldColumnKey('cf_abc')).toBeNull();
    expect(parseCustomFieldColumnKey('cf_12.5')).toBeNull();
  });
});

describe('reshapeCustomFieldsArrayToObject', () => {
  it('keys the verbatim array by cf_<definitionId>', () => {
    const record = {
      id: 1,
      name: 'Acme',
      custom_fields: [
        { custom_field_definition_id: 700123, value: 'SaaS' },
        { custom_field_definition_id: 700124, value: 42 },
      ],
    };
    const out = reshapeCustomFieldsArrayToObject(record);
    expect(out.custom_fields).toEqual({ cf_700123: 'SaaS', cf_700124: 42 });
    // Other fields untouched.
    expect(out.id).toBe(1);
    expect(out.name).toBe('Acme');
  });

  it('coerces a missing value to null and skips malformed entries', () => {
    const record = {
      custom_fields: [
        { custom_field_definition_id: 1 }, // no value → null
        { custom_field_definition_id: 'x', value: 'bad' }, // non-numeric id → skipped
        null, // skipped
        'garbage', // skipped
      ],
    };
    expect(reshapeCustomFieldsArrayToObject(record).custom_fields).toEqual({ cf_1: null });
  });

  it('leaves a record without a custom_fields array unchanged', () => {
    expect(reshapeCustomFieldsArrayToObject({ id: 1 })).toEqual({ id: 1 });
    expect(reshapeCustomFieldsArrayToObject({ id: 1, custom_fields: null })).toEqual({ id: 1, custom_fields: null });
  });
});

describe('reshapeCustomFieldsObjectToArray', () => {
  it('rebuilds the [{custom_field_definition_id, value}] array', () => {
    const record = { id: 1, custom_fields: { cf_700123: 'SaaS', cf_700124: 42 } };
    expect(reshapeCustomFieldsObjectToArray(record).custom_fields).toEqual([
      { custom_field_definition_id: 700123, value: 'SaaS' },
      { custom_field_definition_id: 700124, value: 42 },
    ]);
  });

  it('skips keys that are not cf_<id>', () => {
    const record = { custom_fields: { cf_1: 'a', stray: 'b' } };
    expect(reshapeCustomFieldsObjectToArray(record).custom_fields).toEqual([
      { custom_field_definition_id: 1, value: 'a' },
    ]);
  });

  it('leaves a record whose custom_fields is not a plain object unchanged', () => {
    expect(reshapeCustomFieldsObjectToArray({ id: 1 })).toEqual({ id: 1 });
    expect(reshapeCustomFieldsObjectToArray({ custom_fields: [{ a: 1 }] }).custom_fields).toEqual([{ a: 1 }]);
  });
});

describe('round-trip (pull → publish)', () => {
  it('preserves values through array → object → array', () => {
    const fromApi = [
      { custom_field_definition_id: 1, value: 'text' },
      { custom_field_definition_id: 2, value: ['a', 'b'] },
      { custom_field_definition_id: 3, value: null },
    ];
    const keyed = reshapeCustomFieldsArrayToObject({ custom_fields: fromApi });
    const backToArray = reshapeCustomFieldsObjectToArray(keyed).custom_fields;
    expect(backToArray).toEqual(fromApi);
  });
});
