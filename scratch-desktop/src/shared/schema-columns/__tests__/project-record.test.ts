import { describe, expect, it } from 'vitest';
import { buildColumnDefinitions } from '../build-column-definitions';
import { projectRecordToNormalizedRow } from '../project-record';
import { loadFixture } from './load-fixture';

describe('projectRecordToNormalizedRow — airtable record', () => {
  const columns = buildColumnDefinitions(loadFixture('airtable-semiprecious-stones.schema.json'));
  const record = {
    id: 'recAbc123',
    fields: {
      Stone: 'Amethyst',
      Hardness: 7,
      Value: 40,
      Details: 'Purple variety of quartz',
      'Primary Minerals': ['Quartz', 'Feldspar'],
      'Read Only Autonumber': 42,
      'Birth Stone': ['recLink1'],
      'Name (from Birth Stone)': ['February'],
      'Lookup Column': 'some rollup',
    },
    createdTime: '2026-01-01T00:00:00.000Z',
  };

  const row = projectRecordToNormalizedRow(record, columns, 'recAbc123.json');

  it('sets __filename', () => {
    expect(row.__filename).toBe('recAbc123.json');
  });

  it('resolves raw values by dot-path, referencing original objects', () => {
    expect(row.raw['id']).toBe('recAbc123');
    expect(row.raw['fields.Stone']).toBe('Amethyst');
    expect(row.raw['fields.Hardness']).toBe(7);
    // Referential equality — projection must not clone.
    expect(row.raw['fields.Primary Minerals']).toBe(record.fields['Primary Minerals']);
  });

  it('formats scalar display values as strings', () => {
    expect(row.display['fields.Stone']).toBe('Amethyst');
    expect(row.display['fields.Hardness']).toBe('7');
    expect(row.display['createdTime']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('formats array fields as compact JSON', () => {
    expect(row.display['fields.Primary Minerals']).toBe('["Quartz","Feldspar"]');
    expect(row.display['fields.Birth Stone']).toBe('["recLink1"]');
  });

  it('returns empty string display for missing paths', () => {
    const sparseRecord = { id: 'recSparse', fields: {}, createdTime: '' };
    const sparseRow = projectRecordToNormalizedRow(sparseRecord, columns, 'sparse.json');
    expect(sparseRow.raw['fields.Stone']).toBeUndefined();
    expect(sparseRow.display['fields.Stone']).toBe('');
    expect(sparseRow.display['fields.Primary Minerals']).toBe('');
  });

  it('ignores keys that are not in the schema', () => {
    const withExtras = {
      ...record,
      fields: { ...record.fields, 'Unmapped Field': 'hidden value' },
      unknownTopLevel: 'also hidden',
    };
    const extraRow = projectRecordToNormalizedRow(withExtras, columns, 'extras.json');
    expect(Object.keys(extraRow.raw)).not.toContain('unknownTopLevel');
    expect(Object.keys(extraRow.raw)).not.toContain('fields.Unmapped Field');
  });

  it('does not mutate the source record', () => {
    const snapshot = structuredClone(record);
    projectRecordToNormalizedRow(record, columns, 'snapshot.json');
    expect(record).toEqual(snapshot);
  });
});
