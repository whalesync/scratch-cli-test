import { mapHeadersToFieldKeys, slugifyHeaderToFieldKey } from '../google-sheets-headers';
import { GoogleSheetsError } from '../google-sheets-types';

describe('slugifyHeaderToFieldKey', () => {
  it('lowercases and collapses non-alphanumerics to single underscores', () => {
    expect(slugifyHeaderToFieldKey('First Name')).toBe('first_name');
    expect(slugifyHeaderToFieldKey('  Amount ($ USD)  ')).toBe('amount_usd');
    expect(slugifyHeaderToFieldKey('Email/Address')).toBe('email_address');
    expect(slugifyHeaderToFieldKey('Q1—2026 Revenue')).toBe('q1_2026_revenue');
  });

  it('keeps digits and leading-digit slugs', () => {
    expect(slugifyHeaderToFieldKey('2026 Plan')).toBe('2026_plan');
  });

  it('returns empty string for headers with no alphanumeric content', () => {
    expect(slugifyHeaderToFieldKey('—')).toBe('');
    expect(slugifyHeaderToFieldKey('   ')).toBe('');
  });
});

describe('mapHeadersToFieldKeys', () => {
  it('maps headed columns in grid order with the given index offset', () => {
    const mapped = mapHeadersToFieldKeys(['Name', 'Email Address', 'Age'], 1);
    expect(mapped).toEqual([
      { header: 'Name', slug: 'name', columnIndex: 1 },
      { header: 'Email Address', slug: 'email_address', columnIndex: 2 },
      { header: 'Age', slug: 'age', columnIndex: 3 },
    ]);
  });

  it('skips empty and whitespace-only headers (their columns are ignored)', () => {
    const mapped = mapHeadersToFieldKeys(['Name', '', '  ', undefined, 'Notes'], 1);
    expect(mapped).toEqual([
      { header: 'Name', slug: 'name', columnIndex: 1 },
      { header: 'Notes', slug: 'notes', columnIndex: 5 },
    ]);
  });

  it('throws a user-facing error when two different headers slugify identically', () => {
    expect(() => mapHeadersToFieldKeys(['First Name', 'First-Name'], 1)).toThrow(GoogleSheetsError);
    expect(() => mapHeadersToFieldKeys(['First Name', 'First-Name'], 1)).toThrow(/first_name/);
  });

  it('throws a user-facing error on exact duplicate headers', () => {
    expect(() => mapHeadersToFieldKeys(['Name', 'Name'], 1)).toThrow(/appears more than once/);
  });

  it('rejects data columns whose header slugifies to the reserved scratch_id key', () => {
    // A stray "Scratch ID" data column (e.g. recovery column inserted in the
    // wrong position) would otherwise silently overwrite every record's remote id.
    expect(() => mapHeadersToFieldKeys(['Name', 'Scratch ID'], 1)).toThrow(/reserved/);
    expect(() => mapHeadersToFieldKeys(['scratch-id'], 1)).toThrow(/reserved/);
  });
});
