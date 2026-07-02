import { describe, expect, it } from 'vitest';
import { getByPath, setByPath } from '../project-record';

describe('getByPath', () => {
  const record = {
    id: 'recAbc123',
    fields: {
      Stone: 'Amethyst',
      Hardness: 7,
      'Primary Minerals': ['Quartz', 'Feldspar'],
    },
    createdTime: '2026-01-01T00:00:00.000Z',
  };

  it('resolves top-level keys', () => {
    expect(getByPath(record, 'id')).toBe('recAbc123');
    expect(getByPath(record, 'createdTime')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('resolves nested dot-path keys', () => {
    expect(getByPath(record, 'fields.Stone')).toBe('Amethyst');
    expect(getByPath(record, 'fields.Hardness')).toBe(7);
  });

  it('returns arrays as leaf values (no index traversal)', () => {
    expect(getByPath(record, 'fields.Primary Minerals')).toBe(record.fields['Primary Minerals']);
  });

  it('returns undefined for missing paths', () => {
    expect(getByPath(record, 'fields.Missing')).toBeUndefined();
    expect(getByPath(record, 'nonexistent.deep.path')).toBeUndefined();
  });

  it('returns undefined when traversing through a non-object', () => {
    expect(getByPath(record, 'id.something')).toBeUndefined();
    expect(getByPath(record, 'fields.Stone.nested')).toBeUndefined();
  });

  // Keyed-array filter segments — address a verbatim array element by a key field
  // (Copper `custom_fields.[custom_field_definition_id=700123].value`).
  describe('keyed-array filter segments', () => {
    const copperRecord = {
      id: 401,
      custom_fields: [
        { custom_field_definition_id: 700123, value: 'Enterprise' },
        { custom_field_definition_id: 700124, value: '2026-03-01' },
      ],
    };

    it('reads an array element value by its key field (numeric key matched stringwise)', () => {
      expect(getByPath(copperRecord, 'custom_fields.[custom_field_definition_id=700123].value')).toBe('Enterprise');
      expect(getByPath(copperRecord, 'custom_fields.[custom_field_definition_id=700124].value')).toBe('2026-03-01');
    });

    it('reads the whole element when no value sub-path is given', () => {
      expect(getByPath(copperRecord, 'custom_fields.[custom_field_definition_id=700124]')).toEqual({
        custom_field_definition_id: 700124,
        value: '2026-03-01',
      });
    });

    it('returns undefined for a key not present in the array', () => {
      expect(getByPath(copperRecord, 'custom_fields.[custom_field_definition_id=999].value')).toBeUndefined();
    });

    it('returns undefined when the filtered segment is applied to a non-array', () => {
      expect(
        getByPath({ custom_fields: { not: 'an array' } }, 'custom_fields.[custom_field_definition_id=1].value'),
      ).toBeUndefined();
    });
  });
});

describe('setByPath', () => {
  it('sets a top-level key immutably', () => {
    const record = { id: 1, name: 'Acme' };
    const next = setByPath(record, 'name', 'Acme Corp');
    expect(next).toEqual({ id: 1, name: 'Acme Corp' });
    expect(record.name).toBe('Acme'); // original untouched
  });

  it('sets a nested object path, creating missing objects', () => {
    expect(setByPath({}, 'fields.Stone', 'Amethyst')).toEqual({ fields: { Stone: 'Amethyst' } });
  });

  describe('keyed-array filter segments', () => {
    const copperRecord = {
      id: 401,
      custom_fields: [
        { custom_field_definition_id: 700123, value: 'Enterprise' },
        { custom_field_definition_id: 700124, value: '2026-03-01' },
      ],
    };

    it('updates the matching element in place, leaving siblings untouched', () => {
      const next = setByPath(copperRecord, 'custom_fields.[custom_field_definition_id=700123].value', 'SMB');
      expect(next.custom_fields).toEqual([
        { custom_field_definition_id: 700123, value: 'SMB' },
        { custom_field_definition_id: 700124, value: '2026-03-01' },
      ]);
      // Original untouched (immutability) and it stays a verbatim array.
      expect(Array.isArray(next.custom_fields)).toBe(true);
      expect(copperRecord.custom_fields[0].value).toBe('Enterprise');
    });

    it('appends a new element (with the coerced numeric key) when the key is absent', () => {
      const next = setByPath(copperRecord, 'custom_fields.[custom_field_definition_id=700125].value', 'new');
      expect(next.custom_fields).toContainEqual({ custom_field_definition_id: 700125, value: 'new' });
      expect((next.custom_fields as unknown[]).length).toBe(3);
    });

    it('creates the array when the property is missing', () => {
      const next = setByPath({ id: 1 }, 'custom_fields.[custom_field_definition_id=700123].value', 'X');
      expect(next.custom_fields).toEqual([{ custom_field_definition_id: 700123, value: 'X' }]);
    });

    it('keeps a non-numeric (string) key as a string on create (GoHighLevel short-keys)', () => {
      const next = setByPath({}, 'customFields.[shortKey=contact_source].value', 'web');
      expect(next.customFields).toEqual([{ shortKey: 'contact_source', value: 'web' }]);
    });
  });
});
