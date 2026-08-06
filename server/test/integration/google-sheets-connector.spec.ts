/**
 * Google Sheets connector live API integration test.
 *
 * Strategy: everything runs inside a THROWAWAY SHEET (tab) that the suite creates
 * in the configured test spreadsheet via the connector's own `createTable` — so
 * the suite is hermetic (no user data touched) and exercises the Live Export
 * create path, the Scratch ID column protocol, CRUD round-trips, the pull-time
 * id backfill, and the poisoned-sheet detection + header-recovery path, in order.
 * Key reads are verified INDEPENDENTLY via direct axios calls against the Sheets
 * REST API (never trusting only the connector's own return values). The sheet is
 * deleted on teardown.
 *
 * Requires in .env.integration (or the environment):
 *   - GOOGLE_SHEETS_CLIENT_ID + GOOGLE_SHEETS_CLIENT_SECRET +
 *     GOOGLE_SHEETS_REFRESH_TOKEN — the suite mints a fresh access token at
 *     startup via Google's token endpoint (access tokens expire hourly).
 *   - GOOGLE_SHEETS_TEST_SPREADSHEET_URL — a spreadsheet (URL or bare id) the
 *     authorized Google account can edit; the suite only ever touches sheets it
 *     creates inside it.
 * Not wired into CI (OAuth-only); self-skips when creds are absent. Run by hand:
 *
 *   cd server && yarn test:integration -- google-sheets-connector
 */

// Break the circular import chain: connector.ts → display-names.ts → all
// connectors → connector.ts (same shim the other live connector tests use).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import axios from 'axios';
import { GoogleSheetsApiClient } from 'src/remote-service/connectors/library/google-sheets/google-sheets-api-client';
import {
  GoogleSheetsConnector,
  parseSpreadsheetIdFromUrlOrId,
} from 'src/remote-service/connectors/library/google-sheets/google-sheets-connector';
import {
  SCRATCH_ID_COLUMN_HEADER,
  SCRATCH_ID_RECORD_KEY,
} from 'src/remote-service/connectors/library/google-sheets/google-sheets-types';
import { BaseJsonTableSpec, ConnectorFile, EntityId, readRecordIdAsString } from 'src/remote-service/connectors/types';

jest.setTimeout(180_000);

const CLIENT_ID = process.env.GOOGLE_SHEETS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_SHEETS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_SHEETS_REFRESH_TOKEN;
const TEST_SPREADSHEET_URL = process.env.GOOGLE_SHEETS_TEST_SPREADSHEET_URL;

const hasLiveCreds = Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN && TEST_SPREADSHEET_URL);
const describeIfCreds = hasLiveCreds ? describe : describe.skip;

/** The throwaway sheet's title — per-run so crashed leftovers are identifiable. */
const TEST_SHEET_TITLE = `Scratch IT ${Date.now()}`;

async function mintAccessToken(): Promise<string> {
  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      client_id: CLIENT_ID!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      client_secret: CLIENT_SECRET!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      refresh_token: REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return (response.data as { access_token: string }).access_token;
}

describeIfCreds('GoogleSheetsConnector — live API', () => {
  let accessToken: string;
  let connector: GoogleSheetsConnector;
  let directClient: GoogleSheetsApiClient;
  let spreadsheetId: string;
  let testSheetId: number;
  let tableEntityId: EntityId;
  let tableSpec: BaseJsonTableSpec;
  const createdRecords: ConnectorFile[] = [];

  /** Read a whole range independently of the connector (raw axios, A1 notation). */
  async function readRangeDirect(rangeA1: string): Promise<unknown[][]> {
    const response = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rangeA1)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' },
      },
    );
    return (response.data as { values?: unknown[][] }).values ?? [];
  }

  async function pullAllRecords(): Promise<ConnectorFile[]> {
    const pulledRecords: ConnectorFile[] = [];
    await connector.pullRecordFiles(
      tableSpec,
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files }) => {
        pulledRecords.push(...files);
      },
      {},
      {},
    );
    return pulledRecords;
  }

  beforeAll(async () => {
    accessToken = await mintAccessToken();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsedSpreadsheetId = parseSpreadsheetIdFromUrlOrId(TEST_SPREADSHEET_URL!);
    if (!parsedSpreadsheetId) throw new Error('GOOGLE_SHEETS_TEST_SPREADSHEET_URL is not a spreadsheet URL/id');
    spreadsheetId = parsedSpreadsheetId;
    connector = new GoogleSheetsConnector(accessToken);
    directClient = new GoogleSheetsApiClient(accessToken);
  });

  afterAll(async () => {
    if (testSheetId !== undefined) {
      await directClient.batchUpdateSpreadsheet(spreadsheetId, [{ deleteSheet: { sheetId: testSheetId } }]);
    }
  });

  it('testConnection resolves for a valid token and rejects an invalid one', async () => {
    await expect(connector.testConnection()).resolves.toBeUndefined();
    await expect(new GoogleSheetsConnector('invalid-token').testConnection()).rejects.toThrow();
  });

  it('searchTables lists the spreadsheet tabs from a pasted URL', async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { tables } = await connector.searchTables(TEST_SPREADSHEET_URL!);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0].id.remoteId[0]).toBe(spreadsheetId);
  });

  it('createTable creates a sheet with the ID column and one column per field kind', async () => {
    const result = await connector.createTable({
      ref: 'it-table',
      name: TEST_SHEET_TITLE,
      remoteParentId: [spreadsheetId],
      deferredFkFields: [],
      fields: [
        { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
        { name: 'Count', fieldType: { kind: 'number', precision: 0 } },
        { name: 'Active', fieldType: { kind: 'boolean' } },
        { name: 'Launched At', fieldType: { kind: 'date', includesTime: true } },
        {
          name: 'Status',
          fieldType: { kind: 'select', options: [{ name: 'Open' }, { name: 'Closed' }] },
        },
      ],
    });

    expect(result.status).toBe('created');
    expect(result.remoteTableId?.[0]).toBe(spreadsheetId);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    testSheetId = Number(result.remoteTableId![1]);
    tableEntityId = { wsId: 'it_sheet', remoteId: [spreadsheetId, String(testSheetId)] };

    // Independent verification: the header row is Scratch ID + fields, primary first.
    const headerRow = (await readRangeDirect(`'${TEST_SHEET_TITLE}'!1:1`))[0];
    expect(headerRow).toEqual([SCRATCH_ID_COLUMN_HEADER, 'Title', 'Count', 'Active', 'Launched At', 'Status']);
  });

  it('fetchJsonTableSpec builds the schema from the created sheet', async () => {
    tableSpec = await connector.fetchJsonTableSpec(tableEntityId);
    const properties = (tableSpec.schema as unknown as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual([
      SCRATCH_ID_RECORD_KEY,
      'title',
      'count',
      'active',
      'launched_at',
      'status',
    ]);
    expect(String(tableSpec.idPath)).toBe(SCRATCH_ID_RECORD_KEY);
    expect(String(tableSpec.titlePath)).toBe('title');
  });

  it('createRecords appends rows with pre-assigned scr_ ids (atomic append)', async () => {
    const created = await connector.createRecords(tableSpec, [
      // 45870.5 = 2025-08-01T12:00:00 as a spreadsheet serial.
      { title: 'First row', count: 3, active: true, launched_at: 45870.5, status: 'Open' },
      { title: 'Second row', count: 7, active: false, launched_at: null, status: 'Closed' },
    ]);
    createdRecords.push(...created);
    expect(created).toHaveLength(2);
    for (const record of created) {
      expect(readRecordIdAsString(record, tableSpec.idPath)).toMatch(/^scr_/);
    }

    // Independent verification: both rows landed with ids in column A and typed values.
    const dataRows = await readRangeDirect(`'${TEST_SHEET_TITLE}'!A2:F3`);
    expect(dataRows).toHaveLength(2);
    expect(String(dataRows[0][0])).toMatch(/^scr_/);
    expect(dataRows[0][1]).toBe('First row');
    expect(dataRows[0][2]).toBe(3);
    expect(dataRows[0][3]).toBe(true);
    expect(dataRows[0][4]).toBe(45870.5);
  });

  it('pullRecordFiles round-trips the created rows verbatim', async () => {
    const pulledRecords = await pullAllRecords();
    expect(pulledRecords).toHaveLength(2);
    const firstRecord = pulledRecords.find((record) => record.title === 'First row');
    expect(firstRecord).toMatchObject({ count: 3, active: true, launched_at: 45870.5, status: 'Open' });
    expect(firstRecord?.[SCRATCH_ID_RECORD_KEY]).toBe(readRecordIdAsString(createdRecords[0], tableSpec.idPath));
  });

  it('updateRecords writes only the changed cells', async () => {
    const [firstRecord] = createdRecords;
    await connector.updateRecords(tableSpec, [{ ...firstRecord, count: 4 }], [{ count: 4 }]);

    const dataRows = await readRangeDirect(`'${TEST_SHEET_TITLE}'!A2:F3`);
    expect(dataRows[0][2]).toBe(4);
    // Untouched cell survived.
    expect(dataRows[0][1]).toBe('First row');
  });

  it('backfills a scr_ id for a row a human added by hand', async () => {
    // Simulate a human typing a new row (no id) directly into the sheet.
    await directClient.appendRows(spreadsheetId, TEST_SHEET_TITLE, [['', 'Hand-typed row', 1, false, '', 'Open']]);

    const pulledRecords = await pullAllRecords();
    const handTypedRecord = pulledRecords.find((record) => record.title === 'Hand-typed row');
    expect(handTypedRecord).toBeDefined();
    const backfilledId = handTypedRecord?.[SCRATCH_ID_RECORD_KEY] as string;
    expect(backfilledId).toMatch(/^scr_/);

    // Independent verification: the id was written back INTO the sheet.
    const idColumn = await readRangeDirect(`'${TEST_SHEET_TITLE}'!A2:A10`);
    expect(idColumn.flat()).toContain(backfilledId);
  });

  it('deleteRecords removes rows and is idempotent for already-gone ids', async () => {
    const [, secondRecord] = createdRecords;
    await connector.deleteRecords(tableSpec, [secondRecord]);
    // Deleting again is a no-op, not an error.
    await connector.deleteRecords(tableSpec, [secondRecord]);

    const pulledRecords = await pullAllRecords();
    expect(pulledRecords.find((record) => record.title === 'Second row')).toBeUndefined();
    expect(pulledRecords.find((record) => record.title === 'First row')).toBeDefined();
  });

  it('detects a deleted ID column as a poisoned sheet, and re-adopts after the header recovery', async () => {
    // The user deletes the managed column…
    await directClient.batchUpdateSpreadsheet(spreadsheetId, [
      {
        deleteDimension: {
          range: { sheetId: testSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        },
      },
    ]);
    await expect(connector.fetchJsonTableSpec(tableEntityId)).rejects.toThrow(/deleted/);

    // …then follows the recovery recipe: a blank first column headed "Scratch ID".
    await directClient.batchUpdateSpreadsheet(spreadsheetId, [
      {
        insertDimension: {
          range: { sheetId: testSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          inheritFromBefore: false,
        },
      },
      {
        updateCells: {
          start: { sheetId: testSheetId, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: [{ userEnteredValue: { stringValue: SCRATCH_ID_COLUMN_HEADER } }] }],
          fields: 'userEnteredValue',
        },
      },
    ]);

    tableSpec = await connector.fetchJsonTableSpec(tableEntityId);
    const pulledRecords = await pullAllRecords();
    // Rows survived and were re-id'd by the backfill (fresh ids — records re-sync as new).
    const survivingRecord = pulledRecords.find((record) => record.title === 'First row');
    expect(survivingRecord).toBeDefined();
    expect(String(survivingRecord?.[SCRATCH_ID_RECORD_KEY])).toMatch(/^scr_/);
  });
});
