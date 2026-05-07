import { describe, expect, it } from 'vitest';
import { getByPath } from '../project-record';

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
});
