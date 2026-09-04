import {
  areFieldValuesCanonicallyEqual,
  resolveFieldValueCanonicalizersForTable,
} from 'src/remote-service/connectors/field-value-canonicalization';
import { Service } from 'src/remote-service/connectors/service-constants';
import { googleSheetsWritableColumnCanonicalizer } from '../google-sheets-field-value-canonicalizer';
import { buildGoogleSheetsJsonTableSpec } from '../google-sheets-json-schema';
import {
  GoogleSheetsColumnDescriptor,
  GoogleSheetsSheetDescription,
  SCRATCH_ID_RECORD_KEY,
} from '../google-sheets-types';
// Registers the Google Sheets connector (and its canonicalizer hook) with the registry.
import '../google-sheets-connector';

function expectSame(pulled: unknown, written: unknown): void {
  expect(areFieldValuesCanonicallyEqual(googleSheetsWritableColumnCanonicalizer, pulled, written)).toBe(true);
}

function expectDifferent(pulled: unknown, written: unknown): void {
  expect(areFieldValuesCanonicallyEqual(googleSheetsWritableColumnCanonicalizer, pulled, written)).toBe(false);
}

describe('googleSheetsWritableColumnCanonicalizer', () => {
  it('treats every spelling of an empty cell as equal — absent, null, empty string, empty list', () => {
    expectSame(null, undefined);
    expectSame(null, '');
    expectSame(null, []);
    expectSame('', []);
    expectSame(undefined, []);
    expectSame('', undefined);
  });

  it('still sees a real value vs empty, and a real value change', () => {
    expectDifferent(null, 'a');
    expectDifferent('', 'a, b');
    expectDifferent([], ['a']);
    expectDifferent('a', 'b');
    expectDifferent(null, 0);
    expectDifferent(null, false);
    expectDifferent(false, true);
    expectDifferent(45870, 45871);
  });

  it('canonicalises every empty spelling to an empty list', () => {
    expect(googleSheetsWritableColumnCanonicalizer(undefined)).toEqual([]);
    expect(googleSheetsWritableColumnCanonicalizer(null)).toEqual([]);
    expect(googleSheetsWritableColumnCanonicalizer('')).toEqual([]);
    expect(googleSheetsWritableColumnCanonicalizer([])).toEqual([]);
  });

  it('passes non-empty scalars through unchanged (RAW write ≡ UNFORMATTED_VALUE read)', () => {
    expect(googleSheetsWritableColumnCanonicalizer('text')).toBe('text');
    expect(googleSheetsWritableColumnCanonicalizer(1.5)).toBe(1.5);
    expect(googleSheetsWritableColumnCanonicalizer(true)).toBe(true);
    expect(googleSheetsWritableColumnCanonicalizer(0)).toBe(0);
    expect(googleSheetsWritableColumnCanonicalizer(false)).toBe(false);
  });
});

describe('Google Sheets resolver on a real built table spec (registered — DEV-10556)', () => {
  const columns: GoogleSheetsColumnDescriptor[] = [
    { slug: 'name', header: 'Name', columnIndex: 1 },
    { slug: 'tags', header: 'Tags', columnIndex: 2, numberFormat: { type: 'TEXT' } },
    {
      slug: 'done',
      header: 'Done',
      columnIndex: 3,
      dataValidation: { condition: { type: 'BOOLEAN' }, strict: false },
    },
    { slug: 'when', header: 'When', columnIndex: 4, numberFormat: { type: 'DATE' } },
  ];
  const description: GoogleSheetsSheetDescription = {
    spreadsheetId: 'spreadsheet123',
    spreadsheetTitle: 'My Data',
    sheetId: 42,
    sheetTitle: 'Orders',
    rowCount: 100,
    columnCount: 26,
    observedColumnWidth: 5,
    columns,
  };
  const spec = buildGoogleSheetsJsonTableSpec({
    id: { wsId: 'gs_test_42', remoteId: ['spreadsheet123', '42'] },
    description,
  });

  it('is registered with the connector registry — every data column resolves, the managed id column does not', () => {
    const registered = resolveFieldValueCanonicalizersForTable(Service.GOOGLE_SHEETS, spec);
    expect([...registered.keys()].sort()).toEqual(['name', 'tags', 'done', 'when'].sort());
    expect(registered.has(SCRATCH_ID_RECORD_KEY)).toBe(false);

    const tags = registered.get('tags');
    if (!tags) throw new Error('expected a canonicalizer for tags');
    expect(areFieldValuesCanonicallyEqual(tags, null, '')).toBe(true);
    expect(areFieldValuesCanonicallyEqual(tags, null, [])).toBe(true);
    expect(areFieldValuesCanonicallyEqual(tags, 'a, b', 'a, b')).toBe(true);
    expect(areFieldValuesCanonicallyEqual(tags, 'a, b', 'a')).toBe(false);
  });
});
