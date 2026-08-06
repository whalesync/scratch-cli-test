import {
  GOOGLE_SHEETS_SPREADSHEET_URL_INPUT_PATTERN,
  parseSpreadsheetIdFromUrlOrId,
  splitGoogleSheetsSpreadsheetUrlInput,
  spreadsheetIdsFromConnectorAccountExtras,
} from '../google-sheets-url-parsing';

describe('splitGoogleSheetsSpreadsheetUrlInput', () => {
  it('returns [] for undefined or empty input', () => {
    expect(splitGoogleSheetsSpreadsheetUrlInput(undefined)).toEqual([]);
    expect(splitGoogleSheetsSpreadsheetUrlInput('')).toEqual([]);
    expect(splitGoogleSheetsSpreadsheetUrlInput('   \n ')).toEqual([]);
  });

  it('keeps a single pasted URL verbatim', () => {
    expect(
      splitGoogleSheetsSpreadsheetUrlInput('https://docs.google.com/spreadsheets/d/1AbCdEf99999/edit#gid=0'),
    ).toEqual(['https://docs.google.com/spreadsheets/d/1AbCdEf99999/edit#gid=0']);
  });

  it('splits on commas, spaces, and newlines, and accepts bare ids', () => {
    const bareSpreadsheetId = '1AbC_dEf-123456789012345678901234567';
    expect(
      splitGoogleSheetsSpreadsheetUrlInput(
        `https://docs.google.com/spreadsheets/d/1FirstSheet99/edit, ${bareSpreadsheetId}\nhttps://docs.google.com/spreadsheets/u/1/d/1ThirdSheet99/edit#gid=7`,
      ),
    ).toEqual([
      'https://docs.google.com/spreadsheets/d/1FirstSheet99/edit',
      bareSpreadsheetId,
      'https://docs.google.com/spreadsheets/u/1/d/1ThirdSheet99/edit#gid=7',
    ]);
  });

  it('dedupes repeated spreadsheets pasted as different URL forms (first row wins)', () => {
    expect(
      splitGoogleSheetsSpreadsheetUrlInput(
        'https://docs.google.com/spreadsheets/d/1SameSheet99/edit#gid=0 https://docs.google.com/spreadsheets/d/1SameSheet99/edit#gid=42',
      ),
    ).toEqual(['https://docs.google.com/spreadsheets/d/1SameSheet99/edit#gid=0']);
  });

  it('silently drops tokens that are neither a Sheets URL nor a plausible bare id', () => {
    expect(splitGoogleSheetsSpreadsheetUrlInput('my spreadsheet, https://example.com/not-sheets')).toEqual([]);
    expect(
      splitGoogleSheetsSpreadsheetUrlInput('please connect https://docs.google.com/spreadsheets/d/1RealSheet99/edit'),
    ).toEqual(['https://docs.google.com/spreadsheets/d/1RealSheet99/edit']);
  });
});

describe('GOOGLE_SHEETS_SPREADSHEET_URL_INPUT_PATTERN (connect-form per-row validation)', () => {
  const rowPattern = new RegExp(GOOGLE_SHEETS_SPREADSHEET_URL_INPUT_PATTERN);

  it('accepts address-bar URL shapes', () => {
    expect(rowPattern.test('https://docs.google.com/spreadsheets/d/1AbCdEf99999/edit#gid=0')).toBe(true);
    expect(rowPattern.test('https://docs.google.com/spreadsheets/u/1/d/1AbCdEf99999/edit')).toBe(true);
    expect(rowPattern.test('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678901234567')).toBe(true);
  });

  it('rejects bare ids, other Google products, and junk', () => {
    expect(rowPattern.test('1AbC_dEf-123456789012345678901234567')).toBe(false);
    expect(rowPattern.test('https://docs.google.com/document/d/1AbCdEf99999/edit')).toBe(false);
    expect(rowPattern.test('http://docs.google.com/spreadsheets/d/1AbCdEf99999')).toBe(false);
    expect(rowPattern.test('my spreadsheet')).toBe(false);
  });

  it('every URL the pattern accepts also parses to an id (form rows survive the id deriver)', () => {
    const acceptedUrls = [
      'https://docs.google.com/spreadsheets/d/1AbCdEf99999/edit#gid=0',
      'https://docs.google.com/spreadsheets/u/1/d/1AbCdEf99999/edit',
    ];
    for (const url of acceptedUrls) {
      expect(rowPattern.test(url)).toBe(true);
      expect(parseSpreadsheetIdFromUrlOrId(url)).toBe('1AbCdEf99999');
    }
    // The connect modal newline-joins the rows on the OAuth wire; the splitter
    // must recover them (deduped by id).
    expect(splitGoogleSheetsSpreadsheetUrlInput(acceptedUrls.join('\n'))).toEqual([acceptedUrls[0]]);
  });
});

describe('spreadsheetIdsFromConnectorAccountExtras', () => {
  it('derives deduped ids from the verbatim URL rows in well-formed extras', () => {
    expect(
      spreadsheetIdsFromConnectorAccountExtras({
        spreadsheetUrls: [
          'https://docs.google.com/spreadsheets/d/1AbCdEf99999/edit#gid=0',
          '1Bare_Id-123456789012345678901234567',
          'https://docs.google.com/spreadsheets/d/1AbCdEf99999/edit#gid=42', // dup by id
          'junk row', // unparseable → dropped
        ],
      }),
    ).toEqual(['1AbCdEf99999', '1Bare_Id-123456789012345678901234567']);
  });

  it('returns [] for null, foreign, or malformed extras shapes', () => {
    expect(spreadsheetIdsFromConnectorAccountExtras(null)).toEqual([]);
    expect(spreadsheetIdsFromConnectorAccountExtras(undefined)).toEqual([]);
    expect(spreadsheetIdsFromConnectorAccountExtras({})).toEqual([]);
    expect(spreadsheetIdsFromConnectorAccountExtras({ realmId: 'quickbooks' })).toEqual([]);
    expect(spreadsheetIdsFromConnectorAccountExtras({ spreadsheetUrls: 'not-an-array' })).toEqual([]);
    expect(spreadsheetIdsFromConnectorAccountExtras({ spreadsheetUrls: [42] })).toEqual([]);
    // The pre-verbatim extras shape (ids under `spreadsheetIds`) is foreign now.
    expect(spreadsheetIdsFromConnectorAccountExtras({ spreadsheetIds: ['1AbCdEf99999'] })).toEqual([]);
  });
});

// The single-value parser has its own suite in google-sheets-connector.spec.ts
// (it moved modules but is re-exported); one smoke check that the move kept it
// importable from the new home.
describe('parseSpreadsheetIdFromUrlOrId (moved module)', () => {
  it('still parses a URL and rejects ordinary words', () => {
    expect(parseSpreadsheetIdFromUrlOrId('https://docs.google.com/spreadsheets/d/1AbCdEf99999/edit')).toBe(
      '1AbCdEf99999',
    );
    expect(parseSpreadsheetIdFromUrlOrId('orders')).toBeNull();
  });
});
