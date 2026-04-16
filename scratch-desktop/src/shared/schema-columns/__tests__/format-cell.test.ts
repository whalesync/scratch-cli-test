import { describe, expect, it } from 'vitest';
import { formatCellForGrid } from '../format-cell';

describe('formatCellForGrid', () => {
  it('renders undefined and null as empty strings', () => {
    expect(formatCellForGrid(undefined)).toBe('');
    expect(formatCellForGrid(null)).toBe('');
  });

  it('renders booleans as true/false', () => {
    expect(formatCellForGrid(true)).toBe('true');
    expect(formatCellForGrid(false)).toBe('false');
  });

  it('renders scalar strings and numbers verbatim', () => {
    expect(formatCellForGrid('hello')).toBe('hello');
    expect(formatCellForGrid(42)).toBe('42');
    expect(formatCellForGrid(3.14)).toBe('3.14');
  });

  it('compact-stringifies arrays', () => {
    expect(formatCellForGrid(['a', 'b'])).toBe('["a","b"]');
  });

  it('compact-stringifies objects', () => {
    expect(formatCellForGrid({ k: 1 })).toBe('{"k":1}');
  });

  it('returns [unserializable] for circular objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatCellForGrid(circular)).toBe('[unserializable]');
  });
});
