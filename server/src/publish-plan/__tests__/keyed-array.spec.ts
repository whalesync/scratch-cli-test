import {
  ArrayKeyedByOptions,
  buildKeyedArrayColumnPath,
  coerceFilterValue,
  diffKeyedArrayElements,
  findKeyedArrayElement,
  getArrayKeyedByOptions,
  parseFilterSegment,
  X_SCRATCH_ARRAY_KEYED_BY,
} from '@spinner/shared-types';

describe('keyed-array primitive', () => {
  describe('parseFilterSegment', () => {
    it('parses a filter segment into field + rawValue', () => {
      expect(parseFilterSegment('[custom_field_definition_id=700123]')).toEqual({
        field: 'custom_field_definition_id',
        rawValue: '700123',
      });
    });

    it('parses a string (non-numeric) key value', () => {
      expect(parseFilterSegment('[shortKey=contact_source]')).toEqual({
        field: 'shortKey',
        rawValue: 'contact_source',
      });
    });

    it('parses an empty value', () => {
      expect(parseFilterSegment('[k=]')).toEqual({ field: 'k', rawValue: '' });
    });

    it('returns null for a plain object key', () => {
      expect(parseFilterSegment('custom_fields')).toBeNull();
      expect(parseFilterSegment('value')).toBeNull();
    });

    it('rejects segments whose field or value contains a delimiter/reserved char', () => {
      expect(parseFilterSegment('[a.b=1]')).toBeNull(); // '.' would break split()
      expect(parseFilterSegment('[a=b]c')).toBeNull();
      expect(parseFilterSegment('[a=b=c]')).toBeNull();
    });
  });

  describe('coerceFilterValue', () => {
    it('coerces all-digit values to numbers', () => {
      expect(coerceFilterValue('700123')).toBe(700123);
      expect(coerceFilterValue('-5')).toBe(-5);
    });

    it('leaves non-numeric values as strings', () => {
      expect(coerceFilterValue('contact_source')).toBe('contact_source');
      expect(coerceFilterValue('12.5')).toBe('12.5'); // not all-digits → stays string
      expect(coerceFilterValue('')).toBe('');
    });
  });

  describe('buildKeyedArrayColumnPath', () => {
    it('builds a path with a value sub-path', () => {
      expect(buildKeyedArrayColumnPath('custom_fields', 'custom_field_definition_id', 700123, 'value')).toBe(
        'custom_fields.[custom_field_definition_id=700123].value',
      );
    });

    it('builds a path addressing the whole element when no value sub-path', () => {
      expect(buildKeyedArrayColumnPath('custom_fields', 'custom_field_definition_id', 700123)).toBe(
        'custom_fields.[custom_field_definition_id=700123]',
      );
    });
  });

  describe('findKeyedArrayElement', () => {
    const array = [
      { custom_field_definition_id: 700123, value: 'Enterprise' },
      { custom_field_definition_id: 700124, value: '2026-03-01' },
    ];

    it('matches numerically-keyed elements stringwise', () => {
      expect(findKeyedArrayElement(array, 'custom_field_definition_id', '700124')).toEqual({
        custom_field_definition_id: 700124,
        value: '2026-03-01',
      });
    });

    it('returns undefined when no element matches', () => {
      expect(findKeyedArrayElement(array, 'custom_field_definition_id', '999')).toBeUndefined();
    });
  });

  describe('diffKeyedArrayElements', () => {
    const keyField = 'custom_field_definition_id';
    const main = [
      { custom_field_definition_id: 700123, value: 'Enterprise' },
      { custom_field_definition_id: 700124, value: '2026-03-01' },
    ];

    it('returns only the changed element (sparse)', () => {
      const dirty = [
        { custom_field_definition_id: 700123, value: 'SMB' },
        { custom_field_definition_id: 700124, value: '2026-03-01' },
      ];
      expect(diffKeyedArrayElements(main, dirty, keyField)).toEqual([
        { custom_field_definition_id: 700123, value: 'SMB' },
      ]);
    });

    it('returns [] when nothing changed', () => {
      expect(diffKeyedArrayElements(main, main, keyField)).toEqual([]);
    });

    it('returns a newly-added element', () => {
      const dirty = [...main, { custom_field_definition_id: 700125, value: 'new' }];
      expect(diffKeyedArrayElements(main, dirty, keyField)).toEqual([
        { custom_field_definition_id: 700125, value: 'new' },
      ]);
    });

    it('treats a null main array as all-elements-changed', () => {
      const dirty = [{ custom_field_definition_id: 700123, value: 'X' }];
      expect(diffKeyedArrayElements(undefined, dirty, keyField)).toEqual(dirty);
    });

    it('returns [] for a non-array dirty value', () => {
      expect(diffKeyedArrayElements(main, null, keyField)).toEqual([]);
    });
  });

  describe('getArrayKeyedByOptions', () => {
    const options: ArrayKeyedByOptions = {
      keyField: 'custom_field_definition_id',
      valuePath: 'value',
      columns: [{ key: 700123, name: 'Tier' }],
    };

    it('reads the annotation off a direct array property', () => {
      expect(getArrayKeyedByOptions({ type: 'array', [X_SCRATCH_ARRAY_KEYED_BY]: options })).toEqual(options);
    });

    it('reads the annotation off an anyOf member (optional/nullable pattern)', () => {
      const propSchema = {
        anyOf: [{ type: 'array', [X_SCRATCH_ARRAY_KEYED_BY]: options }, { type: 'null' }],
      };
      expect(getArrayKeyedByOptions(propSchema)).toEqual(options);
    });

    it('returns undefined for an unannotated property', () => {
      expect(getArrayKeyedByOptions({ type: 'array' })).toBeUndefined();
      expect(getArrayKeyedByOptions(undefined)).toBeUndefined();
    });
  });
});
