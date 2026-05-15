import {
  AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS,
  buildAirtableModifiedSinceFormula,
  combineAirtableFormulas,
} from '../airtable-incremental';

describe('buildAirtableModifiedSinceFormula', () => {
  it('applies the clock-skew overlap to the watermark', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    const expected = new Date(since.getTime() - AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
    expect(buildAirtableModifiedSinceFormula('Last Modified Time', since)).toBe(
      `IS_AFTER({Last Modified Time}, '${expected}')`,
    );
  });

  it('escapes closing braces and backslashes in field names', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    const formula = buildAirtableModifiedSinceFormula('Tricky\\}Field', since);
    expect(formula).toContain('{Tricky\\\\\\}Field}');
  });
});

describe('combineAirtableFormulas', () => {
  it('returns the additional formula when there is no user filter', () => {
    expect(combineAirtableFormulas(undefined, 'IS_AFTER({X}, "2026")')).toBe('IS_AFTER({X}, "2026")');
  });

  it('returns the additional formula when the user filter is blank', () => {
    expect(combineAirtableFormulas('   ', 'IS_AFTER({X}, "2026")')).toBe('IS_AFTER({X}, "2026")');
  });

  it('returns the user filter when there is no additional formula', () => {
    expect(combineAirtableFormulas("{Status} = 'Active'", undefined)).toBe("{Status} = 'Active'");
  });

  it('AND-combines both when present', () => {
    expect(combineAirtableFormulas("{Status} = 'Active'", 'IS_AFTER({X}, "2026")')).toBe(
      'AND({Status} = \'Active\', IS_AFTER({X}, "2026"))',
    );
  });

  it('returns undefined when both are empty', () => {
    expect(combineAirtableFormulas(undefined, undefined)).toBeUndefined();
  });
});
