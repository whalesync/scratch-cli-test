/**
 * Types and constants for the Google Sheets connector.
 *
 * API shapes are hand-written subsets of the Sheets v4 REST resources we
 * actually touch (https://developers.google.com/sheets/api/reference/rest) —
 * no SDK dependency; requests go through the shared axios factory.
 */

// ── Scratch ID column protocol constants ─────────────────────────────────────

/** Header text of the managed ID column (always column A). */
export const SCRATCH_ID_COLUMN_HEADER = 'Scratch ID';

/**
 * The record key (and `idPath`) the ID column maps to. Fixed — not derived by
 * slugifying the header — so the record shape survives any cosmetic header edit.
 */
export const SCRATCH_ID_RECORD_KEY = 'scratch_id';

/**
 * Developer-metadata key marking the ID column itself (attached to the COLUMNS
 * dimension range, so it travels with the column through reorders). Value is
 * `SCRATCH_ID_COLUMN_HEADER`.
 */
export const SCRATCH_ID_COLUMN_METADATA_KEY = 'scratch-id-column';

/**
 * Developer-metadata key marking "Scratch has set this sheet up" (attached to
 * the SHEET, so it survives the ID column being deleted). Its presence is what
 * distinguishes "first contact — create the ID column" from "the user deleted
 * the ID column — fail loudly". Value is the setup version (currently '1').
 */
export const SCRATCH_SHEET_SETUP_METADATA_KEY = 'scratch-sheet-setup';

/** Current value written for {@link SCRATCH_SHEET_SETUP_METADATA_KEY}. */
export const SCRATCH_SHEET_SETUP_METADATA_VALUE = '1';

/**
 * Developer-metadata key marking a foreign-key column created by Live Export
 * (attached to the column's COLUMNS dimension range). Value is
 * `<spreadsheetId>/<sheetId>` of the linked table, parsed back at schema time
 * into the `x-scratch-foreign-key` annotation.
 */
export const SCRATCH_FK_TARGET_METADATA_KEY = 'scratch-fk-target';

/** Note placed on the ID column's header cell (the closest API-settable thing to a native comment). */
export const SCRATCH_ID_COLUMN_NOTE =
  'This column is managed by Scratch (scratch.md). It gives every row a permanent ID so edits sync to the right row.\n\n' +
  'Please don’t edit, reorder, or delete this column — deleting it disconnects the sheet from Scratch. ' +
  'Leave it as the first column, and leave row 1 as the header row.';

/** Description shown by Google's "protected range" warning dialog for the ID column. */
export const SCRATCH_ID_COLUMN_PROTECTION_DESCRIPTION =
  'Managed by Scratch — the Scratch ID identifies each row for syncing. Please don’t change it.';

// ── Error type ───────────────────────────────────────────────────────────────

export class GoogleSheetsError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'GoogleSheetsError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

// ── Sheets v4 API subset ─────────────────────────────────────────────────────

/** A cell value as the values endpoints return/accept it (UNFORMATTED_VALUE render). */
export type GoogleSheetsCellValue = string | number | boolean | null;

export interface GoogleSheetsGridProperties {
  rowCount?: number;
  columnCount?: number;
  frozenRowCount?: number;
}

export interface GoogleSheetsSheetProperties {
  sheetId: number;
  title: string;
  gridProperties?: GoogleSheetsGridProperties;
}

export interface GoogleSheetsNumberFormat {
  type?:
    | 'TEXT'
    | 'NUMBER'
    | 'PERCENT'
    | 'CURRENCY'
    | 'DATE'
    | 'TIME'
    | 'DATE_TIME'
    | 'SCIENTIFIC'
    | 'NUMBER_FORMAT_TYPE_UNSPECIFIED';
  pattern?: string;
}

export interface GoogleSheetsDataValidationRule {
  condition?: {
    type?: string;
    values?: { userEnteredValue?: string }[];
  };
  strict?: boolean;
  showCustomUi?: boolean;
}

export interface GoogleSheetsCellData {
  formattedValue?: string;
  effectiveFormat?: { numberFormat?: GoogleSheetsNumberFormat };
  dataValidation?: GoogleSheetsDataValidationRule;
}

export interface GoogleSheetsGridData {
  startRow?: number;
  startColumn?: number;
  rowData?: { values?: GoogleSheetsCellData[] }[];
}

export interface GoogleSheetsProtectedRange {
  /** Assigned by Google at creation; the handle for update/delete requests. */
  protectedRangeId?: number;
  description?: string;
}

export interface GoogleSheetsSheet {
  properties?: GoogleSheetsSheetProperties;
  data?: GoogleSheetsGridData[];
  protectedRanges?: GoogleSheetsProtectedRange[];
}

export interface GoogleSheetsSpreadsheet {
  spreadsheetId?: string;
  properties?: { title?: string };
  spreadsheetUrl?: string;
  sheets?: GoogleSheetsSheet[];
}

export interface GoogleSheetsGridRange {
  sheetId: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

export interface GoogleSheetsDataFilter {
  gridRange?: GoogleSheetsGridRange;
  developerMetadataLookup?: GoogleSheetsDeveloperMetadataLookup;
}

export interface GoogleSheetsDeveloperMetadataLookup {
  metadataKey?: string;
  locationMatchingStrategy?: 'EXACT_LOCATION' | 'INTERSECTING_LOCATION';
  metadataLocation?: { sheetId?: number; spreadsheet?: boolean };
}

export interface GoogleSheetsDimensionRange {
  /**
   * NOTE: Google omits proto3 defaults from response JSON — an ABSENT `sheetId`
   * means gid 0 and an absent `startIndex` means index 0. Always read them via
   * the helpers in google-sheets-id-column.ts (or `?? 0`); requests we build
   * always set `sheetId` explicitly.
   */
  sheetId?: number;
  dimension: 'ROWS' | 'COLUMNS';
  startIndex?: number;
  endIndex?: number;
}

export interface GoogleSheetsDeveloperMetadata {
  metadataKey?: string;
  metadataValue?: string;
  visibility?: 'DOCUMENT' | 'PROJECT';
  location?: {
    locationType?: 'ROW' | 'COLUMN' | 'SHEET' | 'SPREADSHEET';
    /** Absent means gid 0 for SHEET locations (proto3 default elision). */
    sheetId?: number;
    dimensionRange?: GoogleSheetsDimensionRange;
  };
}

export interface GoogleSheetsValueRange {
  range?: string;
  majorDimension?: 'ROWS' | 'COLUMNS';
  values?: GoogleSheetsCellValue[][];
}

/** One matched range from values.batchGetByDataFilter. */
export interface GoogleSheetsMatchedValueRange {
  valueRange?: GoogleSheetsValueRange;
  dataFilters?: GoogleSheetsDataFilter[];
}

/**
 * A spreadsheets.batchUpdate request. The real API type is a large oneof; this
 * subset covers the requests the connector issues, each key optional so a
 * request object carries exactly one.
 */
export interface GoogleSheetsBatchUpdateRequest {
  addSheet?: { properties: Partial<GoogleSheetsSheetProperties> };
  deleteSheet?: { sheetId: number };
  insertDimension?: { range: GoogleSheetsDimensionRange; inheritFromBefore?: boolean };
  appendDimension?: { sheetId: number; dimension: 'ROWS' | 'COLUMNS'; length: number };
  deleteDimension?: { range: GoogleSheetsDimensionRange };
  updateSheetProperties?: { properties: Partial<GoogleSheetsSheetProperties>; fields: string };
  repeatCell?: {
    range: GoogleSheetsGridRange;
    cell: { userEnteredFormat?: Record<string, unknown>; dataValidation?: GoogleSheetsDataValidationRule | null };
    fields: string;
  };
  updateCells?: {
    range?: GoogleSheetsGridRange;
    start?: { sheetId: number; rowIndex: number; columnIndex: number };
    rows: {
      values: {
        userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean } | null;
        userEnteredFormat?: Record<string, unknown>;
        note?: string;
        dataValidation?: GoogleSheetsDataValidationRule | null;
      }[];
    }[];
    fields: string;
  };
  addProtectedRange?: {
    protectedRange: {
      range: GoogleSheetsGridRange;
      description?: string;
      warningOnly?: boolean;
    };
  };
  createDeveloperMetadata?: { developerMetadata: GoogleSheetsDeveloperMetadata };
}

export interface GoogleSheetsBatchUpdateResponse {
  spreadsheetId?: string;
  replies?: { addSheet?: { properties?: GoogleSheetsSheetProperties } }[];
}

// ── Connector-internal shapes ────────────────────────────────────────────────

/**
 * One data column of a sheet (everything to the right of the Scratch ID
 * column that has a non-empty header). `slug` is the field key in record
 * files; `columnIndex` is the 0-based grid index AT READ TIME — never
 * persisted, always re-derived live before a write.
 */
export interface GoogleSheetsColumnDescriptor {
  /** Slugified header — the record key and schema property name. */
  slug: string;
  /** The header cell's verbatim text. */
  header: string;
  /** 0-based grid column index at the time the header row was read. */
  columnIndex: number;
  /** Column value format, from the first data cell that declares one. */
  numberFormat?: GoogleSheetsNumberFormat;
  /** Column data validation, from the first data cell that declares one. */
  dataValidation?: GoogleSheetsDataValidationRule;
  /** Live Export FK target parsed from column developer metadata: [spreadsheetId, sheetId]. */
  foreignKeyTarget?: [string, string];
}

/**
 * Everything the connector needs to know about one sheet, gathered in two API
 * calls (grid sample + developer-metadata search) by `describeSheet`.
 */
export interface GoogleSheetsSheetDescription {
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetId: number;
  sheetTitle: string;
  /** Grid row count (INCLUDES trailing empty rows — Sheets grids default to 1000). */
  rowCount: number;
  /** Grid column count (includes trailing empty columns). */
  columnCount: number;
  /**
   * One past the rightmost grid column OBSERVED to be occupied — by a header
   * (sluggable or not) or by data in the sampled rows. New Live Export columns
   * are placed at/after this index so a column invisible to the schema (an
   * empty or symbols-only header over real data) is never overwritten.
   * A lower bound only: data starting below the sampled rows isn't seen.
   */
  observedColumnWidth: number;
  /**
   * The live id of the ID column's warning-only protected range (recognized by
   * its description), when present. Read fresh on every describe — never
   * persisted — so it's always the current handle for update/delete, and its
   * presence tells the adoption path not to add a duplicate protection (a
   * copied spreadsheet keeps the original's protected ranges).
   */
  scratchProtectedRangeId?: number;
  /** Data columns (excluding the ID column), in grid order. */
  columns: GoogleSheetsColumnDescriptor[];
}

/** Outcome of checking column A against the Scratch ID column protocol. */
export type ScratchIdColumnState =
  /** Column A is the managed ID column (metadata and/or header match). */
  | { kind: 'valid'; needsMetadataStamp: boolean }
  /** Sheet has never been set up — safe to create the column. */
  | { kind: 'never-set-up' }
  /** Sheet was set up but the ID column is gone — the folder is poisoned. */
  | { kind: 'deleted' }
  /** The ID column still exists but is no longer column A. */
  | { kind: 'moved'; currentColumnIndex: number };

/** Parsed `remoteId` of a Google Sheets table: `[spreadsheetId, sheetId]`. */
export interface GoogleSheetsTableAddress {
  spreadsheetId: string;
  sheetId: number;
}
