import { AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  GoogleSheetsBatchUpdateRequest,
  GoogleSheetsBatchUpdateResponse,
  GoogleSheetsCellValue,
  GoogleSheetsDataFilter,
  GoogleSheetsDeveloperMetadata,
  GoogleSheetsError,
  GoogleSheetsMatchedValueRange,
  GoogleSheetsSpreadsheet,
} from './google-sheets-types';

const SHEETS_API_BASE_URL = 'https://sheets.googleapis.com/v4';

/**
 * Sheets API per-user quotas are 60 read + 60 write requests/min. The proactive
 * limiter (registration `rateLimiterSpec { points: 1, duration: 1 }`) holds us
 * to that ceiling burst-free; this reactive half absorbs 429s from anything else
 * hitting the same user quota (another Scratch connection, the user's own apps).
 * Google returns Retry-After only sometimes; its per-minute window makes a
 * cooldown near the window the safe default.
 */
const GOOGLE_SHEETS_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) =>
    (isAxiosError(error) && error.response?.status === 429) ||
    (error instanceof GoogleSheetsError && error.statusCode === 429),
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
  defaultCooldownS: 20,
};

/**
 * Quote a sheet title for A1 notation (single quotes, internal quotes doubled).
 * Only `values.append` still needs A1 — every other call addresses ranges by
 * `sheetId` through DataFilter/GridRange, immune to renames and quoting.
 */
export function quoteSheetTitleForA1(sheetTitle: string): string {
  return `'${sheetTitle.replace(/'/g, "''")}'`;
}

/** Map a cell value to the batchUpdate ExtendedValue shape (`null` = clear the cell). */
function toExtendedValue(
  value: GoogleSheetsCellValue | null,
): { stringValue?: string; numberValue?: number; boolValue?: boolean } | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return { numberValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return { stringValue: value };
}

/** Lossless read options: raw typed values, date/time cells as serial numbers. */
const LOSSLESS_READ_OPTIONS = {
  valueRenderOption: 'UNFORMATTED_VALUE',
  dateTimeRenderOption: 'SERIAL_NUMBER',
} as const;

/**
 * Low-level client for the Google Sheets v4 REST API, authenticated with the
 * connection's OAuth access token. Scope is `spreadsheets` only — no Drive
 * calls anywhere in this client (none would be authorized).
 */
export class GoogleSheetsApiClient {
  private readonly httpClient: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    this.httpClient = createApiClient({
      baseURL: SHEETS_API_BASE_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, GOOGLE_SHEETS_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, GOOGLE_SHEETS_RETRY_OPTS);
  }

  /**
   * Validate the access token without touching any user data (the connection
   * may not know a spreadsheet yet, and we have no Drive scope to list with).
   * POSTs the token in the body so it never appears in a logged URL.
   */
  async validateAccessToken(accessToken: string): Promise<void> {
    // Deliberately a bare fetch (not this.httpClient): different host, and the
    // URL-override/logging interceptors are for connector API traffic. Still
    // rides the shared retry so a transient 429/blip never fails a health check.
    await this.withRetry(async () => {
      const response = await fetch('https://oauth2.googleapis.com/tokeninfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: accessToken }),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new GoogleSheetsError(`Google rejected the access token: ${errorBody}`, response.status);
      }
    });
  }

  /**
   * Fetch spreadsheet + sheet structure, optionally with grid data for ranges
   * (addressed by sheetId via DataFilters — no A1). `fields` keeps payloads
   * small; always include what you read.
   */
  async getSpreadsheetByDataFilter(
    spreadsheetId: string,
    body: { dataFilters?: GoogleSheetsDataFilter[]; includeGridData?: boolean },
    fields: string,
  ): Promise<GoogleSheetsSpreadsheet> {
    const response = await this.withRetry(() =>
      this.httpClient.post<GoogleSheetsSpreadsheet>(
        `/spreadsheets/${encodeURIComponent(spreadsheetId)}:getByDataFilter`,
        body,
        { params: { fields } },
      ),
    );
    return response.data;
  }

  /** Fetch spreadsheet structure only (no grid data) — used by list/search/lookup flows. */
  async getSpreadsheetStructure(spreadsheetId: string): Promise<GoogleSheetsSpreadsheet> {
    const response = await this.withRetry(() =>
      this.httpClient.get<GoogleSheetsSpreadsheet>(`/spreadsheets/${encodeURIComponent(spreadsheetId)}`, {
        params: { fields: 'spreadsheetId,properties(title),spreadsheetUrl,sheets(properties)' },
      }),
    );
    return response.data;
  }

  /** Create a brand-new spreadsheet (allowed by the `spreadsheets` scope; lands in the user's My Drive root). */
  async createSpreadsheet(title: string): Promise<GoogleSheetsSpreadsheet> {
    const response = await this.withRetry(() =>
      this.httpClient.post<GoogleSheetsSpreadsheet>('/spreadsheets', { properties: { title } }),
    );
    return response.data;
  }

  /** Read cell values for gridRanges (losslessly: typed values, serial dates). */
  async batchGetValuesByDataFilter(
    spreadsheetId: string,
    dataFilters: GoogleSheetsDataFilter[],
  ): Promise<GoogleSheetsMatchedValueRange[]> {
    const response = await this.withRetry(() =>
      this.httpClient.post<{ valueRanges?: GoogleSheetsMatchedValueRange[] }>(
        `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGetByDataFilter`,
        { dataFilters, majorDimension: 'ROWS', ...LOSSLESS_READ_OPTIONS },
      ),
    );
    return response.data.valueRanges ?? [];
  }

  /**
   * Write cell values into gridRanges. Always RAW — values are stored exactly
   * as sent (typed JSON scalars), never re-parsed by locale rules and never
   * interpreted as formulas.
   */
  async batchUpdateValuesByDataFilter(
    spreadsheetId: string,
    data: { dataFilter: GoogleSheetsDataFilter; values: GoogleSheetsCellValue[][] }[],
  ): Promise<void> {
    if (data.length === 0) return;
    await this.withRetry(() =>
      this.httpClient.post(`/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdateByDataFilter`, {
        data: data.map((entry) => ({ ...entry, majorDimension: 'ROWS' })),
        valueInputOption: 'RAW',
      }),
    );
  }

  /**
   * Append rows after the last data row of a sheet. One call is atomic — the
   * API allocates the rows and writes every value together, so there are no
   * half-written records. RAW input.
   *
   * `OVERWRITE` (not `INSERT_ROWS`) is load-bearing: INSERT_ROWS creates brand
   * new rows that INHERIT the formatting of the row above them — on first
   * append that's the bold header, so every data row came out bold, date
   * columns lost their DATE_TIME format, and checkbox validation ended up on
   * the pushed-down empty rows instead of the data (all three seen live in the
   * Sanity audit). OVERWRITE writes into the existing pre-formatted empty rows,
   * so column formats/validation apply to the data; it never touches non-empty
   * cells (the append point is after the last data row) and the grid grows
   * automatically when the rows run out.
   *
   * A `null` cell is SKIPPED by the API — the cell stays truly empty (a
   * written `''` under RAW stores an empty STRING, which is enough to break
   * checkbox rendering on that cell).
   */
  async appendRows(spreadsheetId: string, sheetTitle: string, rows: (GoogleSheetsCellValue | null)[][]): Promise<void> {
    if (rows.length === 0) return;
    const range = `${quoteSheetTitleForA1(sheetTitle)}!A1`;
    await this.withRetry(() =>
      this.httpClient.post(
        `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
        { values: rows, majorDimension: 'ROWS' },
        { params: { valueInputOption: 'RAW', insertDataOption: 'OVERWRITE' } },
      ),
    );
  }

  /**
   * Write individual cells with TYPED values via `updateCells` (one atomic
   * spreadsheets.batchUpdate). Strings/numbers/booleans map to their native
   * ExtendedValue, and `null` CLEARS the cell outright — semantics the values
   * API can't express (its only "empty" spelling is `''`, which under RAW
   * stores an empty string that breaks checkbox rendering and pollutes cells).
   */
  async updateCellValues(
    spreadsheetId: string,
    sheetId: number,
    cellWrites: { rowIndex: number; columnIndex: number; value: GoogleSheetsCellValue | null }[],
  ): Promise<void> {
    if (cellWrites.length === 0) return;
    const requests: GoogleSheetsBatchUpdateRequest[] = cellWrites.map(({ rowIndex, columnIndex, value }) => ({
      updateCells: {
        start: { sheetId, rowIndex, columnIndex },
        rows: [{ values: [{ userEnteredValue: toExtendedValue(value) }] }],
        fields: 'userEnteredValue',
      },
    }));
    await this.batchUpdateSpreadsheet(spreadsheetId, requests);
  }

  /** Apply structural requests (add sheet, insert/delete dimensions, formats, metadata, …) atomically. */
  async batchUpdateSpreadsheet(
    spreadsheetId: string,
    requests: GoogleSheetsBatchUpdateRequest[],
  ): Promise<GoogleSheetsBatchUpdateResponse> {
    if (requests.length === 0) return {};
    const response = await this.withRetry(() =>
      this.httpClient.post<GoogleSheetsBatchUpdateResponse>(
        `/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        { requests },
      ),
    );
    return response.data;
  }

  /**
   * Search developer metadata by key(s), scoped to one sheet via
   * INTERSECTING_LOCATION (matches metadata on the sheet itself and on its
   * dimension ranges).
   */
  async searchDeveloperMetadata(
    spreadsheetId: string,
    sheetId: number,
    metadataKeys: string[],
  ): Promise<GoogleSheetsDeveloperMetadata[]> {
    const response = await this.withRetry(() =>
      this.httpClient.post<{
        matchedDeveloperMetadata?: { developerMetadata?: GoogleSheetsDeveloperMetadata }[];
      }>(`/spreadsheets/${encodeURIComponent(spreadsheetId)}/developerMetadata:search`, {
        dataFilters: metadataKeys.map((metadataKey) => ({
          developerMetadataLookup: {
            metadataKey,
            locationMatchingStrategy: 'INTERSECTING_LOCATION',
            metadataLocation: { sheetId },
          },
        })),
      }),
    );
    return (response.data.matchedDeveloperMetadata ?? [])
      .map((match) => match.developerMetadata)
      .filter((metadata): metadata is GoogleSheetsDeveloperMetadata => metadata !== undefined);
  }
}
