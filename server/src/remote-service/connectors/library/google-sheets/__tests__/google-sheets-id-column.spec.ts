import {
  analyzeScratchIdColumnState,
  buildPoisonedSheetError,
  buildScratchIdColumnSetupRequests,
  hasSheetSetupMarker,
} from '../google-sheets-id-column';
import {
  GoogleSheetsDeveloperMetadata,
  SCRATCH_ID_COLUMN_HEADER,
  SCRATCH_ID_COLUMN_METADATA_KEY,
  SCRATCH_SHEET_SETUP_METADATA_KEY,
} from '../google-sheets-types';

const SHEET_ID = 42;

function idColumnMetadataAt(startIndex: number): GoogleSheetsDeveloperMetadata {
  return {
    metadataKey: SCRATCH_ID_COLUMN_METADATA_KEY,
    metadataValue: SCRATCH_ID_COLUMN_HEADER,
    location: {
      locationType: 'COLUMN',
      dimensionRange:
        startIndex === 0
          ? // Google omits startIndex from the JSON when it is 0 — model that.
            { sheetId: SHEET_ID, dimension: 'COLUMNS', endIndex: 1 }
          : { sheetId: SHEET_ID, dimension: 'COLUMNS', startIndex, endIndex: startIndex + 1 },
    },
  };
}

const sheetSetupMarker: GoogleSheetsDeveloperMetadata = {
  metadataKey: SCRATCH_SHEET_SETUP_METADATA_KEY,
  metadataValue: '1',
  location: { locationType: 'SHEET', sheetId: SHEET_ID },
};

describe('analyzeScratchIdColumnState', () => {
  it('is valid when the column metadata sits at column 0 (even with a renamed header)', () => {
    const state = analyzeScratchIdColumnState(
      [sheetSetupMarker, idColumnMetadataAt(0)],
      ['Some Renamed Header', 'Name'],
      SHEET_ID,
    );
    expect(state).toEqual({ kind: 'valid', needsMetadataStamp: false });
  });

  it('adopts by exact header text when metadata is missing (recovery / copied sheet)', () => {
    const state = analyzeScratchIdColumnState([sheetSetupMarker], [SCRATCH_ID_COLUMN_HEADER, 'Name'], SHEET_ID);
    expect(state).toEqual({ kind: 'valid', needsMetadataStamp: true });
  });

  it('recognizes markers on gid 0, where Google elides sheetId from every location', () => {
    // Google omits proto3 defaults from JSON: on the default first tab (gid 0)
    // both the sheet marker's location.sheetId and the column marker's
    // dimensionRange.sheetId are ABSENT. They must still be recognized —
    // otherwise the poison detector never arms on the most common tab.
    const gid0SheetMarker: GoogleSheetsDeveloperMetadata = {
      metadataKey: SCRATCH_SHEET_SETUP_METADATA_KEY,
      metadataValue: '1',
      location: { locationType: 'SHEET' },
    };
    const gid0ColumnMarker: GoogleSheetsDeveloperMetadata = {
      metadataKey: SCRATCH_ID_COLUMN_METADATA_KEY,
      metadataValue: SCRATCH_ID_COLUMN_HEADER,
      location: { locationType: 'COLUMN', dimensionRange: { dimension: 'COLUMNS', endIndex: 1 } },
    };
    expect(hasSheetSetupMarker([gid0SheetMarker], 0)).toBe(true);
    expect(analyzeScratchIdColumnState([gid0SheetMarker, gid0ColumnMarker], ['Renamed', 'Name'], 0)).toEqual({
      kind: 'valid',
      needsMetadataStamp: false,
    });
    // Column marker gone on gid 0 → poison must still fire.
    expect(analyzeScratchIdColumnState([gid0SheetMarker], ['Name'], 0)).toEqual({ kind: 'deleted' });
    // A SPREADSHEET-scoped metadata entry (no sheetId at all) must NOT be
    // mistaken for a gid-0 sheet marker.
    const spreadsheetScopedMarker: GoogleSheetsDeveloperMetadata = {
      metadataKey: SCRATCH_SHEET_SETUP_METADATA_KEY,
      metadataValue: '1',
      location: { locationType: 'SPREADSHEET' },
    };
    expect(hasSheetSetupMarker([spreadsheetScopedMarker], 0)).toBe(false);
  });

  it('reports never-set-up for a sheet with no markers and no ID header', () => {
    expect(analyzeScratchIdColumnState([], ['Name', 'Email'], SHEET_ID)).toEqual({ kind: 'never-set-up' });
  });

  it('reports never-set-up for a completely empty sheet', () => {
    expect(analyzeScratchIdColumnState([], [], SHEET_ID)).toEqual({ kind: 'never-set-up' });
  });

  it('reports deleted when the sheet marker exists but the ID column is gone', () => {
    expect(analyzeScratchIdColumnState([sheetSetupMarker], ['Name', 'Email'], SHEET_ID)).toEqual({ kind: 'deleted' });
  });

  it('reports moved (with position) when the column metadata is not at column 0', () => {
    const state = analyzeScratchIdColumnState(
      [sheetSetupMarker, idColumnMetadataAt(3)],
      ['Name', 'Email', 'Age', SCRATCH_ID_COLUMN_HEADER],
      SHEET_ID,
    );
    expect(state).toEqual({ kind: 'moved', currentColumnIndex: 3 });
  });

  it('ignores metadata belonging to a different sheet', () => {
    const otherSheetMarker: GoogleSheetsDeveloperMetadata = {
      ...sheetSetupMarker,
      location: { locationType: 'SHEET', sheetId: 7 },
    };
    expect(analyzeScratchIdColumnState([otherSheetMarker], ['Name'], SHEET_ID)).toEqual({ kind: 'never-set-up' });
  });
});

describe('hasSheetSetupMarker', () => {
  it('detects the marker for the right sheet only', () => {
    expect(hasSheetSetupMarker([sheetSetupMarker], SHEET_ID)).toBe(true);
    expect(hasSheetSetupMarker([sheetSetupMarker], 7)).toBe(false);
    expect(hasSheetSetupMarker([], SHEET_ID)).toBe(false);
  });
});

describe('buildScratchIdColumnSetupRequests', () => {
  it('inserts a fresh column A on first contact, with full styling and both markers', () => {
    const requests = buildScratchIdColumnSetupRequests({
      sheetId: SHEET_ID,
      includeInsertColumn: true,
      includeSheetSetupMarker: true,
      includeProtectedRange: true,
      frozenRowCount: 0,
    });
    const requestKinds = requests.map((request) => Object.keys(request)[0]);
    expect(requestKinds).toEqual([
      'insertDimension',
      'repeatCell',
      'updateCells',
      'updateSheetProperties', // freeze header row
      'addProtectedRange',
      'createDeveloperMetadata', // column marker
      'createDeveloperMetadata', // sheet marker
    ]);
    expect(requests[0].insertDimension?.range).toEqual({
      sheetId: SHEET_ID,
      dimension: 'COLUMNS',
      startIndex: 0,
      endIndex: 1,
    });
    expect(requests[0].insertDimension?.inheritFromBefore).toBe(false);
  });

  it('skips the insert and the sheet marker when adopting an existing column', () => {
    const requests = buildScratchIdColumnSetupRequests({
      sheetId: SHEET_ID,
      includeInsertColumn: false,
      includeSheetSetupMarker: false,
      includeProtectedRange: true,
      frozenRowCount: 1,
    });
    const requestKinds = requests.map((request) => Object.keys(request)[0]);
    expect(requestKinds).not.toContain('insertDimension');
    expect(requestKinds).not.toContain('updateSheetProperties'); // already frozen
    expect(requestKinds.filter((kind) => kind === 'createDeveloperMetadata')).toHaveLength(1);
  });

  it('skips the protected range when one already exists (copied spreadsheets keep protections)', () => {
    const requests = buildScratchIdColumnSetupRequests({
      sheetId: SHEET_ID,
      includeInsertColumn: false,
      includeSheetSetupMarker: true,
      includeProtectedRange: false,
      frozenRowCount: 1,
    });
    expect(requests.some((request) => request.addProtectedRange)).toBe(false);
  });

  it('uses warning-only protection (never a hard block)', () => {
    const requests = buildScratchIdColumnSetupRequests({
      sheetId: SHEET_ID,
      includeInsertColumn: true,
      includeSheetSetupMarker: true,
      includeProtectedRange: true,
      frozenRowCount: 0,
    });
    const protection = requests.find((request) => request.addProtectedRange)?.addProtectedRange?.protectedRange;
    expect(protection?.warningOnly).toBe(true);
    expect(protection?.range).toEqual({ sheetId: SHEET_ID, startColumnIndex: 0, endColumnIndex: 1 });
  });

  it('writes the header title and note onto A1', () => {
    const requests = buildScratchIdColumnSetupRequests({
      sheetId: SHEET_ID,
      includeInsertColumn: true,
      includeSheetSetupMarker: true,
      includeProtectedRange: true,
      frozenRowCount: 0,
    });
    const headerUpdate = requests.find((request) => request.updateCells)?.updateCells;
    expect(headerUpdate?.start).toEqual({ sheetId: SHEET_ID, rowIndex: 0, columnIndex: 0 });
    const headerCell = headerUpdate?.rows[0].values[0];
    expect(headerCell?.userEnteredValue).toEqual({ stringValue: SCRATCH_ID_COLUMN_HEADER });
    expect(headerCell?.note).toContain('managed by Scratch');
  });
});

describe('buildPoisonedSheetError', () => {
  it('explains a deleted column and the header-based recovery recipe', () => {
    const error = buildPoisonedSheetError('Orders', { kind: 'deleted' });
    expect(error.message).toContain('deleted');
    expect(error.message).toContain(SCRATCH_ID_COLUMN_HEADER);
    expect(error.message).toContain('insert a blank first column');
  });

  it('tells the user to move the column back when it was only moved', () => {
    const error = buildPoisonedSheetError('Orders', { kind: 'moved' });
    expect(error.message).toContain('no longer the first column');
    expect(error.message).toContain('Move it back');
  });
});
