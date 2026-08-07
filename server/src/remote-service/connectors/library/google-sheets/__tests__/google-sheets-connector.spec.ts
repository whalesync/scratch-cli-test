import { isScratchRowId } from '@spinner/shared-types';
import { GoogleSheetsApiClient } from '../google-sheets-api-client';
import {
  cellValueCountsAsRecordData,
  GoogleSheetsConnector,
  parseSpreadsheetIdFromUrlOrId,
  rowCountsAsGoogleSheetsRecord,
} from '../google-sheets-connector';
import {
  GoogleSheetsSpreadsheet,
  SCRATCH_ID_COLUMN_HEADER,
  SCRATCH_ID_COLUMN_METADATA_KEY,
  SCRATCH_ID_RECORD_KEY,
  SCRATCH_SHEET_SETUP_METADATA_KEY,
} from '../google-sheets-types';

/**
 * Connector-flow tests over a mocked API client: the Scratch ID backfill
 * protocol, duplicate-id detection, publish cell addressing, and the
 * first-contact setup / poisoned-sheet gates. No network anywhere.
 */

const SPREADSHEET_ID = 'spreadsheet123';
const SHEET_ID = 42;
const TABLE_SPEC_ID = { wsId: 'gs_test', remoteId: [SPREADSHEET_ID, String(SHEET_ID)] };

/** A set-up sheet: ID column + Name + Age(number), 6 grid rows. */
function setUpSpreadsheetResponse(): GoogleSheetsSpreadsheet {
  return {
    properties: { title: 'My Data' },
    sheets: [
      {
        properties: {
          sheetId: SHEET_ID,
          title: 'Orders',
          gridProperties: { rowCount: 6, columnCount: 3, frozenRowCount: 1 },
        },
        data: [
          {
            rowData: [
              {
                values: [
                  { formattedValue: SCRATCH_ID_COLUMN_HEADER },
                  { formattedValue: 'Name' },
                  { formattedValue: 'Age' },
                ],
              },
              {
                values: [{}, {}, { effectiveFormat: { numberFormat: { type: 'NUMBER' } } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

const setUpDeveloperMetadata = [
  {
    metadataKey: SCRATCH_SHEET_SETUP_METADATA_KEY,
    metadataValue: '1',
    location: { locationType: 'SHEET' as const, sheetId: SHEET_ID },
  },
  {
    metadataKey: SCRATCH_ID_COLUMN_METADATA_KEY,
    metadataValue: SCRATCH_ID_COLUMN_HEADER,
    location: {
      locationType: 'COLUMN' as const,
      dimensionRange: { sheetId: SHEET_ID, dimension: 'COLUMNS' as const, endIndex: 1 },
    },
  },
];

function makeConnector(): GoogleSheetsConnector {
  return new GoogleSheetsConnector('test-access-token');
}

async function fetchSpec(connector: GoogleSheetsConnector) {
  return connector.fetchJsonTableSpec(TABLE_SPEC_ID);
}

describe('GoogleSheetsConnector', () => {
  let getSpreadsheetByDataFilterSpy: jest.SpyInstance;
  let searchDeveloperMetadataSpy: jest.SpyInstance;
  let batchGetValuesSpy: jest.SpyInstance;
  let batchUpdateValuesSpy: jest.SpyInstance;
  let batchUpdateSpreadsheetSpy: jest.SpyInstance;
  let updateCellValuesSpy: jest.SpyInstance;
  let appendRowsSpy: jest.SpyInstance;

  beforeEach(() => {
    getSpreadsheetByDataFilterSpy = jest
      .spyOn(GoogleSheetsApiClient.prototype, 'getSpreadsheetByDataFilter')
      .mockResolvedValue(setUpSpreadsheetResponse());
    searchDeveloperMetadataSpy = jest
      .spyOn(GoogleSheetsApiClient.prototype, 'searchDeveloperMetadata')
      .mockResolvedValue(setUpDeveloperMetadata);
    batchGetValuesSpy = jest.spyOn(GoogleSheetsApiClient.prototype, 'batchGetValuesByDataFilter').mockResolvedValue([]);
    batchUpdateValuesSpy = jest
      .spyOn(GoogleSheetsApiClient.prototype, 'batchUpdateValuesByDataFilter')
      .mockResolvedValue(undefined);
    batchUpdateSpreadsheetSpy = jest
      .spyOn(GoogleSheetsApiClient.prototype, 'batchUpdateSpreadsheet')
      .mockResolvedValue({});
    updateCellValuesSpy = jest.spyOn(GoogleSheetsApiClient.prototype, 'updateCellValues').mockResolvedValue(undefined);
    appendRowsSpy = jest.spyOn(GoogleSheetsApiClient.prototype, 'appendRows').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('fetchJsonTableSpec', () => {
    it('builds the schema without mutating an already-set-up sheet', async () => {
      const spec = await fetchSpec(makeConnector());
      const properties = (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(properties)).toEqual([SCRATCH_ID_RECORD_KEY, 'name', 'age']);
      expect(batchUpdateSpreadsheetSpy).not.toHaveBeenCalled();
    });

    it('sets up the ID column on first contact, then re-describes the sheet', async () => {
      // First describe: a virgin sheet (no metadata, no ID header)…
      getSpreadsheetByDataFilterSpy.mockResolvedValueOnce({
        properties: { title: 'My Data' },
        sheets: [
          {
            properties: { sheetId: SHEET_ID, title: 'Orders', gridProperties: { rowCount: 6, columnCount: 2 } },
            data: [{ rowData: [{ values: [{ formattedValue: 'Name' }, { formattedValue: 'Age' }] }] }],
          },
        ],
      });
      searchDeveloperMetadataSpy.mockResolvedValueOnce([]);
      // …the retry then sees the set-up sheet (the default mocks).

      const spec = await fetchSpec(makeConnector());

      expect(batchUpdateSpreadsheetSpy).toHaveBeenCalledTimes(1);
      const setupRequests = (batchUpdateSpreadsheetSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>[];
      expect(setupRequests[0]).toHaveProperty('insertDimension');
      const properties = (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(properties)).toEqual([SCRATCH_ID_RECORD_KEY, 'name', 'age']);
    });

    it('throws the poisoned-sheet error when the ID column was deleted', async () => {
      getSpreadsheetByDataFilterSpy.mockResolvedValue({
        properties: { title: 'My Data' },
        sheets: [
          {
            properties: { sheetId: SHEET_ID, title: 'Orders', gridProperties: { rowCount: 6, columnCount: 2 } },
            data: [{ rowData: [{ values: [{ formattedValue: 'Name' }, { formattedValue: 'Age' }] }] }],
          },
        ],
      });
      // Sheet marker present, column marker gone = the user deleted the column.
      searchDeveloperMetadataSpy.mockResolvedValue([setUpDeveloperMetadata[0]]);

      await expect(fetchSpec(makeConnector())).rejects.toThrow(/deleted/);
      expect(batchUpdateSpreadsheetSpy).not.toHaveBeenCalled();
    });
  });

  describe('pullRecordFiles', () => {
    it('emits records and immediately backfills missing ids with sparse writes', async () => {
      batchGetValuesSpy.mockResolvedValueOnce([
        {
          valueRange: {
            values: [
              ['scr_AAAAAAAAAA', 'Alice', 30],
              ['', 'Bob', 25], // missing id → backfilled
              [], // fully empty row → skipped
              ['scr_CCCCCCCCCC', '', ''],
            ],
          },
        },
      ]);
      const connector = makeConnector();
      const spec = await fetchSpec(connector);

      const pulledPages: Record<string, unknown>[][] = [];
      await connector.pullRecordFiles(
        spec,
        ({ files }) => {
          pulledPages.push(files);
          return Promise.resolve();
        },
        {},
        {},
      );

      expect(pulledPages).toHaveLength(1);
      const [records] = pulledPages;
      expect(records).toHaveLength(3);
      expect(records[0]).toEqual({ [SCRATCH_ID_RECORD_KEY]: 'scr_AAAAAAAAAA', name: 'Alice', age: 30 });
      // Bob got a freshly minted scr_ id…
      const bobId = records[1][SCRATCH_ID_RECORD_KEY] as string;
      expect(isScratchRowId(bobId)).toBe(true);
      // …written back sparsely, to exactly his ID cell (row index 2 = grid row 3).
      expect(batchUpdateValuesSpy).toHaveBeenCalledTimes(1);
      const backfillWrites = (batchUpdateValuesSpy.mock.calls[0] as unknown[])[1] as {
        dataFilter: { gridRange: Record<string, number> };
        values: unknown[][];
      }[];
      expect(backfillWrites).toHaveLength(1);
      expect(backfillWrites[0].dataFilter.gridRange).toMatchObject({
        startRowIndex: 2,
        endRowIndex: 3,
        startColumnIndex: 0,
        endColumnIndex: 1,
      });
      expect(backfillWrites[0].values).toEqual([[bobId]]);
      // Empty cells surface as null (row 4 has an id but blank fields).
      expect(records[2]).toEqual({ [SCRATCH_ID_RECORD_KEY]: 'scr_CCCCCCCCCC', name: null, age: null });
    });

    it('skips human-blank rows (whitespace / false / 0 / headerless-only) without minting ids', async () => {
      batchGetValuesSpy.mockResolvedValueOnce([
        {
          valueRange: {
            values: [
              ['', '   ', ''], // whitespace-only → skipped
              ['', false, 0], // blank checkbox + zero → skipped
              ['', 0, 0], // all zeros → skipped
              ['', '', '', 'stray'], // content only in a HEADERLESS column → skipped
              ['', 'Alice', 0], // real text → record
              ['', '', 25], // non-zero number → record
              ['scr_DDDDDDDDDD', '', ''], // blank but id-bearing → record (identity ≠ garbage)
            ],
          },
        },
      ]);
      const connector = makeConnector();
      const spec = await fetchSpec(connector);

      const pulledRecords: Record<string, unknown>[] = [];
      await connector.pullRecordFiles(
        spec,
        ({ files }) => {
          pulledRecords.push(...files);
          return Promise.resolve();
        },
        {},
        {},
      );

      expect(pulledRecords.map((record) => [record.name, record.age])).toEqual([
        ['Alice', 0],
        [null, 25],
        [null, null],
      ]);
      // Ids minted (and backfilled) ONLY for the two rows that earned record-hood.
      expect(batchUpdateValuesSpy).toHaveBeenCalledTimes(1);
      const backfillWrites = (batchUpdateValuesSpy.mock.calls[0] as unknown[])[1] as {
        dataFilter: { gridRange: { startRowIndex: number } };
      }[];
      // Alice is page row 5 (grid row index 5), the 25-row index 6.
      expect(backfillWrites.map((write) => write.dataFilter.gridRange.startRowIndex)).toEqual([5, 6]);
    });

    it('fails the pull when two rows carry the same Scratch ID', async () => {
      batchGetValuesSpy.mockResolvedValueOnce([
        {
          valueRange: {
            values: [
              ['scr_AAAAAAAAAA', 'Alice', 30],
              ['scr_AAAAAAAAAA', 'Alice copy', 30],
            ],
          },
        },
      ]);
      const connector = makeConnector();
      const spec = await fetchSpec(connector);
      await expect(connector.pullRecordFiles(spec, () => Promise.resolve(), {}, {})).rejects.toThrow(
        /same\s+Scratch ID/,
      );
    });
  });

  describe('createRecords', () => {
    it('assigns ids up front and appends full rows in column order', async () => {
      const connector = makeConnector();
      const spec = await fetchSpec(connector);
      const created = await connector.createRecords(spec, [{ name: 'Cara', age: 41 }]);

      expect(created).toHaveLength(1);
      const newId = created[0][SCRATCH_ID_RECORD_KEY] as string;
      expect(isScratchRowId(newId)).toBe(true);

      expect(appendRowsSpy).toHaveBeenCalledTimes(1);
      const [, sheetTitle, rows] = appendRowsSpy.mock.calls[0] as [string, string, unknown[][]];
      expect(sheetTitle).toBe('Orders');
      expect(rows).toEqual([[newId, 'Cara', 41]]);
    });

    it('refuses records carrying fields the sheet has no column for', async () => {
      const connector = makeConnector();
      const spec = await fetchSpec(connector);
      await expect(connector.createRecords(spec, [{ name: 'Cara', nonexistent: 'x' }])).rejects.toThrow(/nonexistent/);
    });
  });

  describe('updateRecords', () => {
    it('locates rows by id-column scan and writes only the changed cells', async () => {
      // The id-column scan (rows from grid row 1 down).
      batchGetValuesSpy.mockResolvedValueOnce([{ valueRange: { values: [['scr_AAAAAAAAAA'], ['scr_BBBBBBBBBB']] } }]);
      const connector = makeConnector();
      const spec = await fetchSpec(connector);

      await connector.updateRecords(
        spec,
        [{ [SCRATCH_ID_RECORD_KEY]: 'scr_BBBBBBBBBB', name: 'Bob', age: 26 }],
        [{ age: 26 }],
      );

      expect(updateCellValuesSpy).toHaveBeenCalledTimes(1);
      const cellWrites = (updateCellValuesSpy.mock.calls[0] as unknown[])[2] as {
        rowIndex: number;
        columnIndex: number;
        value: unknown;
      }[];
      // scr_B is the second data row → grid row index 2; age is column index 2 —
      // written as a TYPED value (number stays number).
      expect(cellWrites).toEqual([{ rowIndex: 2, columnIndex: 2, value: 26 }]);
    });

    it('throws when the row vanished from the sheet', async () => {
      batchGetValuesSpy.mockResolvedValueOnce([{ valueRange: { values: [['scr_AAAAAAAAAA']] } }]);
      const connector = makeConnector();
      const spec = await fetchSpec(connector);
      await expect(
        connector.updateRecords(spec, [{ [SCRATCH_ID_RECORD_KEY]: 'scr_GONEGONE99', name: 'X' }], [{ name: 'X' }]),
      ).rejects.toThrow(/no longer exists/);
    });
  });

  describe('deleteRecords', () => {
    it('deletes rows bottom-up in one atomic batch and skips already-gone ids', async () => {
      batchGetValuesSpy.mockResolvedValueOnce([
        { valueRange: { values: [['scr_AAAAAAAAAA'], ['scr_BBBBBBBBBB'], ['scr_CCCCCCCCCC']] } },
      ]);
      const connector = makeConnector();
      const spec = await fetchSpec(connector);

      await connector.deleteRecords(spec, [
        { [SCRATCH_ID_RECORD_KEY]: 'scr_AAAAAAAAAA' },
        { [SCRATCH_ID_RECORD_KEY]: 'scr_CCCCCCCCCC' },
        { [SCRATCH_ID_RECORD_KEY]: 'scr_GONEGONE99' }, // already gone → skipped
        { name: 'never published' }, // no id → skipped
      ]);

      expect(batchUpdateSpreadsheetSpy).toHaveBeenCalledTimes(1);
      const deleteRequests = (batchUpdateSpreadsheetSpy.mock.calls[0] as unknown[])[1] as {
        deleteDimension: { range: { startIndex: number } };
      }[];
      // scr_A is grid row 1, scr_C is grid row 3 — deleted bottom-up.
      expect(deleteRequests.map((request) => request.deleteDimension.range.startIndex)).toEqual([3, 1]);
    });
  });

  describe('createTable into a brand-new spreadsheet', () => {
    const NEW_SPREADSHEET_SENTINEL = 'scratch-new-spreadsheet';
    const CREATED_SPREADSHEET_ID = 'newSpreadsheet999';
    const CREATED_SHEET_ID = 7;

    function planForNewSpreadsheet(newParentName?: string) {
      return {
        remoteParentId: [NEW_SPREADSHEET_SENTINEL],
        newParentName,
        ref: 'ref-orders',
        name: 'Orders',
        fields: [{ name: 'Name', fieldType: { kind: 'text' as const } }],
        deferredFkFields: [],
      };
    }

    let createSpreadsheetSpy: jest.SpyInstance;

    beforeEach(() => {
      createSpreadsheetSpy = jest.spyOn(GoogleSheetsApiClient.prototype, 'createSpreadsheet').mockResolvedValue({
        spreadsheetId: CREATED_SPREADSHEET_ID,
        // `spreadsheets.create` seeds one blank default sheet; proto3 elides its gid 0.
        sheets: [{ properties: { title: 'Sheet1' } as never }],
      });
      // The addSheet batch returns the new sheet's id; the setup batch returns {}.
      batchUpdateSpreadsheetSpy
        .mockReset()
        .mockResolvedValueOnce({
          replies: [{ addSheet: { properties: { sheetId: CREATED_SHEET_ID, title: 'Orders' } } }],
        })
        .mockResolvedValue({});
    });

    it('titles the new spreadsheet from the caller-supplied source name', async () => {
      const connector = makeConnector();
      await connector.createTable(planForNewSpreadsheet('Airtable export'));
      expect(createSpreadsheetSpy).toHaveBeenCalledWith('Airtable export');
    });

    it('falls back to the default title when no name is supplied', async () => {
      const connector = makeConnector();
      await connector.createTable(planForNewSpreadsheet());
      expect(createSpreadsheetSpy).toHaveBeenCalledWith('Scratch Export');
    });

    it('deletes the blank default sheet in the first created table setup batch, once', async () => {
      const connector = makeConnector();
      await connector.createTable(planForNewSpreadsheet('Airtable export'));

      // Call 0 is addSheet; call 1 is the setup batch that also drops the default tab (gid 0).
      const setupRequests = (batchUpdateSpreadsheetSpy.mock.calls[1] as unknown[])[1] as Record<string, unknown>[];
      const deleteSheetRequests = setupRequests.filter((request) => 'deleteSheet' in request);
      expect(deleteSheetRequests).toEqual([{ deleteSheet: { sheetId: 0 } }]);

      // A second table in the same batch reuses the spreadsheet and does NOT delete again.
      batchUpdateSpreadsheetSpy
        .mockResolvedValueOnce({ replies: [{ addSheet: { properties: { sheetId: 8, title: 'Items' } } }] })
        .mockResolvedValue({});
      await connector.createTable({ ...planForNewSpreadsheet('Airtable export'), ref: 'ref-items', name: 'Items' });
      expect(createSpreadsheetSpy).toHaveBeenCalledTimes(1);
      const secondSetupRequests = (batchUpdateSpreadsheetSpy.mock.calls[3] as unknown[])[1] as Record<
        string,
        unknown
      >[];
      expect(secondSetupRequests.some((request) => 'deleteSheet' in request)).toBe(false);
    });
  });
});

describe('cellValueCountsAsRecordData (the human definition of blank)', () => {
  it('rejects the five blank kinds: empty string, whitespace, null, false, 0', () => {
    expect(cellValueCountsAsRecordData('')).toBe(false);
    expect(cellValueCountsAsRecordData('     ')).toBe(false);
    expect(cellValueCountsAsRecordData(null)).toBe(false);
    expect(cellValueCountsAsRecordData(undefined)).toBe(false);
    expect(cellValueCountsAsRecordData(false)).toBe(false);
    expect(cellValueCountsAsRecordData(0)).toBe(false);
  });

  it('accepts real content: text, non-zero numbers (incl. negative), true', () => {
    expect(cellValueCountsAsRecordData('Alice')).toBe(true);
    expect(cellValueCountsAsRecordData(' x ')).toBe(true);
    expect(cellValueCountsAsRecordData(0.01)).toBe(true);
    expect(cellValueCountsAsRecordData(-1)).toBe(true);
    expect(cellValueCountsAsRecordData(true)).toBe(true);
  });
});

describe('rowCountsAsGoogleSheetsRecord', () => {
  const dataColumns = [
    { slug: 'name', header: 'Name', columnIndex: 1 },
    { slug: 'age', header: 'Age', columnIndex: 2 },
  ];

  it('needs human-visible content in a HEADERED column', () => {
    expect(rowCountsAsGoogleSheetsRecord(['', 'Alice', 0], dataColumns)).toBe(true);
    expect(rowCountsAsGoogleSheetsRecord(['', '  ', 0], dataColumns)).toBe(false);
    expect(rowCountsAsGoogleSheetsRecord([], dataColumns)).toBe(false);
  });

  it('ignores the ID column and headerless columns', () => {
    // Content only at index 0 (ID column) and index 3 (no header) → not a record.
    expect(rowCountsAsGoogleSheetsRecord(['scr_XXXXXXXXXX', '', null, 'stray'], dataColumns)).toBe(false);
  });
});

describe('parseSpreadsheetIdFromUrlOrId', () => {
  it('parses ids out of pasted URLs', () => {
    expect(
      parseSpreadsheetIdFromUrlOrId(
        'https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678901234567/edit#gid=0',
      ),
    ).toBe('1AbC_dEf-123456789012345678901234567');
    expect(parseSpreadsheetIdFromUrlOrId('https://docs.google.com/spreadsheets/u/1/d/1AbCdEf99999/edit')).toBe(
      '1AbCdEf99999',
    );
  });

  it('accepts bare ids but not ordinary search words', () => {
    expect(parseSpreadsheetIdFromUrlOrId('1AbC_dEf-123456789012345678901234567')).toBe(
      '1AbC_dEf-123456789012345678901234567',
    );
    expect(parseSpreadsheetIdFromUrlOrId('orders')).toBeNull();
    expect(parseSpreadsheetIdFromUrlOrId('')).toBeNull();
  });
});
