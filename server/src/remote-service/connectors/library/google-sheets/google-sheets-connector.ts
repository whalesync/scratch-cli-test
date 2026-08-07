import {
  connectorMetadata,
  ConnectorSettingDefinition,
  CreateFieldResult,
  createScratchRowId,
  CreateTableResult,
  SchemaCreationCapabilities,
  TableDiscoveryMode,
  TableView,
} from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
} from '../../error';
import { sanitizeForTableWsId } from '../../ids';
import { NormalizedCreateFieldsPlan, NormalizedCreateTablePlan } from '../../schema-creation.types';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  CreateDestination,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  readRecordIdAsString,
  TablePreview,
} from '../../types';
import { GoogleSheetsApiClient } from './google-sheets-api-client';
import {
  buildGoogleSheetsColumn,
  GOOGLE_SHEETS_NEW_SHEET_ROW_COUNT,
  GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES,
  GoogleSheetsColumnPlan,
  orderFieldsForCreateTable,
} from './google-sheets-create-schema';
import { buildGoogleSheetsDefaultView } from './google-sheets-default-view';
import { mapHeadersToFieldKeys, slugifyHeaderToFieldKey } from './google-sheets-headers';
import {
  analyzeScratchIdColumnState,
  buildPoisonedSheetError,
  buildScratchIdColumnSetupRequests,
  columnIndexOfColumnMetadata,
  hasSheetSetupMarker,
} from './google-sheets-id-column';
import { buildGoogleSheetsJsonTableSpec } from './google-sheets-json-schema';
import {
  GoogleSheetsBatchUpdateRequest,
  GoogleSheetsCellValue,
  GoogleSheetsColumnDescriptor,
  GoogleSheetsError,
  GoogleSheetsSheetDescription,
  GoogleSheetsTableAddress,
  SCRATCH_FK_TARGET_METADATA_KEY,
  SCRATCH_ID_COLUMN_METADATA_KEY,
  SCRATCH_ID_COLUMN_PROTECTION_DESCRIPTION,
  SCRATCH_ID_RECORD_KEY,
  SCRATCH_SHEET_SETUP_METADATA_KEY,
} from './google-sheets-types';
import {
  GOOGLE_SHEETS_SPREADSHEET_URL_INPUT_PATTERN,
  parseSpreadsheetIdFromUrlOrId,
  spreadsheetIdsFromConnectorAccountExtras,
} from './google-sheets-url-parsing';

/**
 * Connector for Google Sheets.
 *
 * Model mapping: a SPREADSHEET is the "base"; each SHEET (tab) is a table,
 * addressed by its stable numeric `sheetId` (gid) so tab renames never break a
 * folder: `remoteId = [spreadsheetId, String(sheetId)]`. Row 1 is the header
 * row; a field's key is the slugified header. Rows have no native identity, so
 * Scratch manages a "Scratch ID" column (always column A) holding a `scr_…` id
 * per row — that id is the record's remote id (see google-sheets-id-column.ts).
 *
 * OAuth scope is `spreadsheets` only (no Drive), so the connector cannot browse
 * the user's spreadsheets: the user hands us spreadsheet URLs at connect time
 * (stored verbatim in extras, managed via Edit Connection), and table discovery
 * is LIST-mode over those spreadsheets' tabs plus spreadsheets already known
 * from this connection's existing folders. Live Export can still CREATE
 * spreadsheets (`spreadsheets.create` needs no Drive scope).
 *
 * Reads are lossless (UNFORMATTED_VALUE + SERIAL_NUMBER: typed values, dates as
 * serial numbers); writes are always RAW (typed values, no locale parsing, no
 * formula interpretation).
 */

/**
 * Rows per pull page. The loop pages the WHOLE grid (rowCount includes trailing
 * empty rows), so a bigger page keeps request counts low against the 60 req/min
 * quota; cells are small, so even a wide 5000-row page stays a modest payload.
 */
const GOOGLE_SHEETS_ROW_PAGE_SIZE = 5000;

/** Sample data rows inspected for per-column format/validation at schema time. */
const SCHEMA_SAMPLE_ROW_COUNT = 5;

/** The pseudo create-destination that means "create a brand-new spreadsheet". */
const NEW_SPREADSHEET_DESTINATION_ID = 'scratch-new-spreadsheet';
const NEW_SPREADSHEET_DESTINATION_NAME = 'New spreadsheet (created by Scratch)';
const NEW_SPREADSHEET_DEFAULT_TITLE = 'Scratch Export';

/**
 * Cap on how many known spreadsheets the discovery/list paths fetch titles for
 * in one call — each costs one API request under a 1 req/s limiter, so an
 * unbounded fan-out would stall the picker and eat the 60/min quota.
 */
const MAX_KNOWN_SPREADSHEETS_LISTED = 20;

/**
 * Deliberately EMPTY: sheet pulls never checkpoint a resume cursor. The only
 * possible cursor is a positional row index, and row positions shift under
 * concurrent human edits — a resumed pull starting mid-grid after rows were
 * deleted above the checkpoint would silently skip unpulled rows, and the
 * whole-pull duplicate-id guard can't see across a resume boundary. Restarting
 * from row 1 is cheap (a full scan is a handful of batched reads) and always
 * correct; idempotent commits absorb the re-read.
 */
type GoogleSheetsPullProgress = JsonSafeObject;

/** The `remoteId` layout every Google Sheets `EntityId` uses: `[spreadsheetId, sheetId]`. */
function parseGoogleSheetsTableAddress(id: EntityId): GoogleSheetsTableAddress {
  const [spreadsheetId, sheetIdText] = id.remoteId;
  const sheetId = Number(sheetIdText);
  if (!spreadsheetId || sheetIdText === undefined || !Number.isInteger(sheetId)) {
    throw new GoogleSheetsError(
      `Invalid Google Sheets table id: expected [spreadsheetId, sheetId], got [${id.remoteId.join(', ')}]`,
    );
  }
  return { spreadsheetId, sheetId };
}

// URL/id parsing lives in google-sheets-url-parsing.ts (also used by the OAuth
// connect form's spreadsheet-URL field); re-exported here for existing importers.
export { parseSpreadsheetIdFromUrlOrId };

/** Stable per-table wsId: survives renames of both the spreadsheet and the tab. */
function buildTableWsId(spreadsheetId: string, sheetId: number): string {
  return sanitizeForTableWsId(`gs_${spreadsheetId.slice(-8)}_${sheetId}`);
}

/**
 * Connect-form field for the spreadsheet URLs. The spreadsheets-only OAuth
 * scope can't browse Drive, so the spreadsheets a connection works with are
 * exactly the ones the user points it at — collecting the URLs here, at auth
 * time, seeds that list durably (`ConnectorAccount.extras.spreadsheetIds`)
 * instead of forcing the user to discover the paste-a-URL trick in the table
 * picker. REQUIRED (at least one row) on the connect form; the server-side
 * callback stays lenient so flows that bypass the form (Whalesync-initiated
 * Live Export) still connect without URLs. The key MUST match
 * `oauthInitiateOptionsSchema.googleSheetsSpreadsheetUrls` — the connect modal
 * newline-joins the rows and copies the value onto the OAuth-initiate options
 * by key.
 */
const GOOGLE_SHEETS_SPREADSHEET_URL_FIELD: ConnectorSettingDefinition = {
  key: 'googleSheetsSpreadsheetUrls',
  type: 'string-list',
  label: 'Spreadsheet URLs',
  required: true,
  placeholder: 'https://docs.google.com/spreadsheets/d/…',
  description:
    'Open up a Google Sheet and copy the URL from the address bar. You can add more later. ' +
    'Ensure they can be accessed by the account you authorize with. ' +
    'Each sheet needs a header row: the labels in row 1 become its column names in Scratch.',
  itemPattern: GOOGLE_SHEETS_SPREADSHEET_URL_INPUT_PATTERN,
  itemPatternDescription:
    "This doesn't look like a Google Sheets URL — it should start with https://docs.google.com/spreadsheets/",
  // Rows persist verbatim in extras.spreadsheetUrls, which also makes the field
  // editable after connect (Edit Connection prefills + rewrites it generically).
  extrasKey: 'spreadsheetUrls',
  // A Live Export destination always creates a brand-new spreadsheet and never reads
  // existing data, so the URL list is pointless there — hide it in create-only clients
  // (the destination side). Scratch and the Live Export source side still render it.
  hideForCreateOnly: true,
};

/**
 * The "human definition of blank" (Ryder, 2026-08-05): a cell only counts as
 * record data when a person would call it content. NOT content: empty cells
 * (null/undefined), '' and whitespace-only strings, `false` (how a visually
 * blank checkbox-validated cell reads over the API), and the number 0 (a row
 * of bare zeros with no label is formatting residue, not a record).
 */
export function cellValueCountsAsRecordData(cellValue: GoogleSheetsCellValue | undefined): boolean {
  if (cellValue === null || cellValue === undefined) return false;
  if (typeof cellValue === 'string') return cellValue.trim() !== '';
  if (cellValue === false) return false;
  if (cellValue === 0) return false;
  return true;
}

/**
 * Whether a raw grid row deserves to become a record: at least one HEADERED
 * data column holds human-visible content (cellValueCountsAsRecordData).
 * Values in headerless columns are invisible to the schema and don't confer
 * record-hood; neither does the Scratch ID column — callers give id-bearing
 * rows record-hood separately, since an id means the row already had identity.
 */
export function rowCountsAsGoogleSheetsRecord(
  row: GoogleSheetsCellValue[],
  dataColumns: readonly GoogleSheetsColumnDescriptor[],
): boolean {
  return dataColumns.some((column) => cellValueCountsAsRecordData(row[column.columnIndex]));
}

export class GoogleSheetsConnector extends Connector<string, GoogleSheetsPullProgress> {
  readonly service = Service.GOOGLE_SHEETS;
  static readonly displayName = 'Google Sheets';
  static readonly metadata = connectorMetadata({
    displayName: 'Google Sheets',
    table: 'sheet',
    tables: 'sheets',
    record: 'row',
    records: 'rows',
    base: 'spreadsheet',
    bases: 'spreadsheets',
    logo: 'https://static.scratch.md/connector-icons/google-sheets.svg',
    visible: true,
    supportsSchemaCreation: true,
    incrementalPull: false,
    incrementalPullInstructions: 'Google Sheets has no per-row modified time, so every pull re-reads the whole sheet.',
    // LIST-mode picker: the sheets of every known spreadsheet, grouped under
    // the spreadsheet title via parentPath. URLs are collected at connect time
    // (and managed in Edit Connection) — the picker itself never asks for one,
    // so this copy only covers the empty state (a connection with no reachable
    // spreadsheets).
    tableSearchInstructions:
      'No spreadsheets connected. Edit the connection to add spreadsheet URLs — ' +
      'open the spreadsheet in Google Sheets and copy the link from the address bar.',
    defaultAuthMethod: 'oauth',
    oauth: { label: 'Google Account' },
    credentialFields: {
      oauth: [GOOGLE_SHEETS_SPREADSHEET_URL_FIELD],
    },
  });

  private readonly client: GoogleSheetsApiClient;
  private readonly accessToken: string;
  private readonly connectorAccountId?: string;
  private readonly listFolderTableIdsForAccount?: (connectorAccountId: string) => Promise<string[][]>;
  /** Spreadsheet ids from the connect form (ConnectorAccount.extras.spreadsheetIds). */
  private readonly spreadsheetIdsFromConnectExtras: string[];
  /**
   * Memo for the "new spreadsheet" create-destination sentinel: the first
   * createTable in a materialize batch creates the spreadsheet, and every
   * sibling table in the same batch (same connector instance) reuses it.
   */
  private createdSpreadsheetIdForNewDestination?: string;
  /**
   * The blank default sheet ("Sheet1") that `spreadsheets.create` seeds into a
   * spreadsheet we spun up for a "new spreadsheet" batch. Set right after that
   * create; cleared once the first created table's setup batch deletes it (a
   * spreadsheet must always keep ≥1 sheet, so the delete waits for a real sheet).
   */
  private blankDefaultSheetIdToDeleteFromNewSpreadsheet?: number;
  /**
   * Per-instance memo of sheet descriptions (a connector instance lives for one
   * job/request). A pull's spec-fetch + row-scan, and every batch of one
   * publish, would otherwise re-issue the same 2 describe requests against a
   * 60 req/min quota. Invalidated by the operations that mutate sheet structure.
   */
  private readonly sheetDescriptionMemoByAddressKey = new Map<string, GoogleSheetsSheetDescription>();

  constructor(
    accessToken: string,
    opts?: {
      rateLimiter?: RateLimiter;
      connectorAccountId?: string;
      listFolderTableIds?: (connectorAccountId: string) => Promise<string[][]>;
      spreadsheetIdsFromConnectExtras?: string[];
    },
  ) {
    super();
    this.accessToken = accessToken;
    this.client = new GoogleSheetsApiClient(accessToken, { rateLimiter: opts?.rateLimiter });
    this.connectorAccountId = opts?.connectorAccountId;
    this.listFolderTableIdsForAccount = opts?.listFolderTableIds;
    this.spreadsheetIdsFromConnectExtras = opts?.spreadsheetIdsFromConnectExtras ?? [];
  }

  /** Validate the token without touching user data (no Drive scope to list with). */
  async testConnection(): Promise<void> {
    await this.client.validateAccessToken(this.accessToken);
  }

  override async getApiQuota(): Promise<{ dashboardUrl: string }> {
    return Promise.resolve({ dashboardUrl: 'https://console.cloud.google.com/apis/api/sheets.googleapis.com/quotas' });
  }

  // ── Table discovery ────────────────────────────────────────────────────────

  /**
   * LIST mode: the picker lists every known spreadsheet's tabs, grouped under
   * the spreadsheet title (parentPath). Known = the URL rows collected at
   * connect time / managed in Edit Connection (extras) ∪ spreadsheets already
   * linked through folders. No search box: URLs are frontloaded, so there is
   * nothing to search — the scope can't browse Drive anyway.
   */
  override get tableDiscoveryMode(): TableDiscoveryMode {
    return TableDiscoveryMode.LIST;
  }

  async listTables(): Promise<TablePreview[]> {
    const { tables } = await this.searchTables('');
    return tables;
  }

  override async searchTables(searchTerm: string): Promise<{ tables: TablePreview[]; hasMore: boolean }> {
    const pastedSpreadsheetId = parseSpreadsheetIdFromUrlOrId(searchTerm);
    if (pastedSpreadsheetId) {
      // A long unspaced search term can look like a bare spreadsheet id; when
      // Google doesn't know it (404) or we can't reach it (403), treat it as an
      // ordinary search miss rather than erroring the whole picker.
      try {
        return { tables: await this.tablePreviewsForSpreadsheet(pastedSpreadsheetId), hasMore: false };
      } catch (error) {
        if (!isAxiosError(error) || (error.response?.status !== 404 && error.response?.status !== 403)) {
          throw error;
        }
      }
    }

    // No Drive scope = no browsing; the searchable universe is the spreadsheets
    // this connection already knows (the metadata's tableSearchInstructions
    // teach the paste-a-URL affordance when this comes back empty).
    const knownSpreadsheetIds = await this.listKnownSpreadsheetIds();
    if (knownSpreadsheetIds.length === 0) {
      return { tables: [], hasMore: false };
    }

    const previewsPerSpreadsheet = await Promise.all(
      knownSpreadsheetIds.map(async (spreadsheetId) => {
        try {
          return await this.tablePreviewsForSpreadsheet(spreadsheetId);
        } catch (error) {
          // A spreadsheet this connection can no longer reach (revoked/deleted)
          // shouldn't take down the whole picker.
          WSLogger.warn({
            source: 'GoogleSheetsConnector',
            message: `Skipping unreachable spreadsheet ${spreadsheetId} while listing tables`,
            error,
          });
          return [];
        }
      }),
    );

    const lowerCaseSearchTerm = searchTerm.trim().toLowerCase();
    const allTables = previewsPerSpreadsheet.flat();
    const tables =
      lowerCaseSearchTerm === ''
        ? allTables
        : allTables.filter(
            (table) =>
              table.displayName.toLowerCase().includes(lowerCaseSearchTerm) ||
              (table.parentPath ?? '').toLowerCase().includes(lowerCaseSearchTerm),
          );
    return { tables, hasMore: false };
  }

  private async tablePreviewsForSpreadsheet(spreadsheetId: string): Promise<TablePreview[]> {
    const spreadsheet = await this.client.getSpreadsheetStructure(spreadsheetId);
    const spreadsheetTitle = spreadsheet.properties?.title ?? spreadsheetId;
    return (spreadsheet.sheets ?? [])
      .map((sheet) => sheet.properties)
      .filter((properties): properties is NonNullable<typeof properties> => properties !== undefined)
      .map((properties) => ({
        id: {
          wsId: buildTableWsId(spreadsheetId, properties.sheetId),
          remoteId: [spreadsheetId, String(properties.sheetId)],
        },
        displayName: properties.title,
        parentPath: spreadsheetTitle,
      }));
  }

  /**
   * Spreadsheet ids this connection already knows: the URL(s) pasted on the
   * connect form (extras — the durable seed) unioned with ids derived from its
   * folders' table ids (covers spreadsheets added later via the picker's
   * paste-a-URL path).
   */
  private async listKnownSpreadsheetIds(): Promise<string[]> {
    const spreadsheetIds = new Set<string>(this.spreadsheetIdsFromConnectExtras);
    if (this.connectorAccountId && this.listFolderTableIdsForAccount) {
      const folderTableIds = await this.listFolderTableIdsForAccount(this.connectorAccountId);
      for (const tableId of folderTableIds) {
        if (tableId.length >= 1 && tableId[0]) spreadsheetIds.add(tableId[0]);
      }
    }
    return [...spreadsheetIds].slice(0, MAX_KNOWN_SPREADSHEETS_LISTED);
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const address = parseGoogleSheetsTableAddress(id);
    // A spec fetch STARTS an operation chain (folder create, pull, schema
    // refresh) — always re-describe so structural changes and the poisoned-ID
    // column check are seen, then let the chain's later steps reuse the memo.
    this.invalidateSheetDescriptionMemo(address);
    const description = await this.describeSheet(address);
    return buildGoogleSheetsJsonTableSpec({ id, description });
  }

  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildGoogleSheetsDefaultView(spec);
  }

  /**
   * The workhorse behind spec fetch, pull, and publish: fetch the sheet's
   * structure + a small grid sample + its developer metadata, enforce the
   * Scratch ID column protocol (create on first contact, adopt on header match,
   * FAIL on deleted/moved), and return headers/columns/rowCount. Memoized per
   * instance — see sheetDescriptionMemoByAddressKey.
   *
   * First contact mutates the sheet (insert + style + mark the ID column) and
   * then re-describes it — one extra round trip, only ever once per sheet.
   */
  private async describeSheet(address: GoogleSheetsTableAddress): Promise<GoogleSheetsSheetDescription> {
    const memoKey = `${address.spreadsheetId}/${address.sheetId}`;
    const memoizedDescription = this.sheetDescriptionMemoByAddressKey.get(memoKey);
    if (memoizedDescription) return memoizedDescription;
    const description = await this.describeSheetUncached(address);
    this.sheetDescriptionMemoByAddressKey.set(memoKey, description);
    return description;
  }

  private invalidateSheetDescriptionMemo(address: GoogleSheetsTableAddress): void {
    this.sheetDescriptionMemoByAddressKey.delete(`${address.spreadsheetId}/${address.sheetId}`);
  }

  private async describeSheetUncached(
    address: GoogleSheetsTableAddress,
    options?: { isRetryAfterSetup?: boolean },
  ): Promise<GoogleSheetsSheetDescription> {
    const { spreadsheetId, sheetId } = address;

    const spreadsheet = await this.client.getSpreadsheetByDataFilter(
      spreadsheetId,
      {
        dataFilters: [{ gridRange: { sheetId, startRowIndex: 0, endRowIndex: 1 + SCHEMA_SAMPLE_ROW_COUNT } }],
        includeGridData: true,
      },
      'properties(title),sheets(properties(sheetId,title,gridProperties),protectedRanges(protectedRangeId,description),data(startRow,startColumn,rowData(values(formattedValue,effectiveFormat(numberFormat),dataValidation))))',
    );

    const sheet = (spreadsheet.sheets ?? []).find((candidate) => candidate.properties?.sheetId === sheetId);
    const sheetProperties = sheet?.properties;
    if (!sheet || !sheetProperties) {
      throw new GoogleSheetsError(
        `The sheet (tab) for this folder no longer exists in the spreadsheet — it may have been deleted.`,
        404,
      );
    }

    const developerMetadata = await this.client.searchDeveloperMetadata(spreadsheetId, sheetId, [
      SCRATCH_SHEET_SETUP_METADATA_KEY,
      SCRATCH_ID_COLUMN_METADATA_KEY,
      SCRATCH_FK_TARGET_METADATA_KEY,
    ]);

    const gridRows = sheet.data?.[0]?.rowData ?? [];
    const headerRowCells = gridRows[0]?.values ?? [];
    const headerRowTexts = headerRowCells.map((cell) => cell.formattedValue);

    // The ID column's protection, recognized by its description — the live
    // handle for any repair, and the "don't add a duplicate" signal for the
    // adoption path (protections survive a spreadsheet copy).
    const scratchProtectedRangeId = (sheet.protectedRanges ?? []).find(
      (protectedRange) => protectedRange.description === SCRATCH_ID_COLUMN_PROTECTION_DESCRIPTION,
    )?.protectedRangeId;

    const idColumnState = analyzeScratchIdColumnState(developerMetadata, headerRowTexts, sheetId);

    if (idColumnState.kind === 'deleted' || idColumnState.kind === 'moved') {
      throw buildPoisonedSheetError(sheetProperties.title, idColumnState);
    }

    if (idColumnState.kind === 'never-set-up') {
      if (options?.isRetryAfterSetup) {
        throw new GoogleSheetsError(
          `Setting up the Scratch ID column in "${sheetProperties.title}" did not stick — please retry.`,
        );
      }
      await this.client.batchUpdateSpreadsheet(
        spreadsheetId,
        buildScratchIdColumnSetupRequests({
          sheetId,
          includeInsertColumn: true,
          includeSheetSetupMarker: true,
          includeProtectedRange: scratchProtectedRangeId === undefined,
          frozenRowCount: sheetProperties.gridProperties?.frozenRowCount ?? 0,
        }),
      );
      // Columns shifted right — re-describe rather than juggling indexes.
      return this.describeSheetUncached(address, { isRetryAfterSetup: true });
    }

    // 'valid' — re-stamp/re-style when the column was identified only by its
    // header text (recovery after deletion, or a copied spreadsheet whose
    // metadata didn't survive). No index shift, so no re-describe needed.
    if (idColumnState.needsMetadataStamp) {
      await this.client.batchUpdateSpreadsheet(
        spreadsheetId,
        buildScratchIdColumnSetupRequests({
          sheetId,
          includeInsertColumn: false,
          includeSheetSetupMarker: !hasSheetSetupMarker(developerMetadata, sheetId),
          includeProtectedRange: scratchProtectedRangeId === undefined,
          frozenRowCount: sheetProperties.gridProperties?.frozenRowCount ?? 0,
        }),
      );
    }

    // Column descriptors for headed data columns (grid columns 1+).
    const foreignKeyTargetByColumnIndex = new Map<number, [string, string]>();
    for (const metadata of developerMetadata) {
      if (metadata.metadataKey !== SCRATCH_FK_TARGET_METADATA_KEY) continue;
      // Handles Google's proto3 elision of sheetId 0 / startIndex 0.
      const fkColumnIndex = columnIndexOfColumnMetadata(metadata, sheetId);
      if (fkColumnIndex === undefined) continue;
      const [targetSpreadsheetId, targetSheetId] = (metadata.metadataValue ?? '').split('/');
      if (!targetSpreadsheetId || !targetSheetId) continue;
      foreignKeyTargetByColumnIndex.set(fkColumnIndex, [targetSpreadsheetId, targetSheetId]);
    }

    const mappedHeaders = mapHeadersToFieldKeys(headerRowTexts.slice(1), 1);
    const sampleRows = gridRows.slice(1);
    const columns: GoogleSheetsColumnDescriptor[] = mappedHeaders.map(({ header, slug, columnIndex }) => {
      const sampleCells = sampleRows.map((row) => row.values?.[columnIndex]).filter((cell) => cell !== undefined);
      return {
        slug,
        header,
        columnIndex,
        numberFormat: sampleCells.find((cell) => cell.effectiveFormat?.numberFormat?.type)?.effectiveFormat
          ?.numberFormat,
        dataValidation: sampleCells.find((cell) => cell.dataValidation?.condition?.type)?.dataValidation,
        foreignKeyTarget: foreignKeyTargetByColumnIndex.get(columnIndex),
      };
    });

    // The rightmost grid column observed occupied (header row or sampled data
    // rows) — where createFields may safely place new columns.
    const observedColumnWidth = Math.max(
      1,
      headerRowTexts.length,
      ...gridRows.map((row) => row.values?.length ?? 0),
      ...columns.map((column) => column.columnIndex + 1),
    );

    return {
      spreadsheetId,
      spreadsheetTitle: spreadsheet.properties?.title ?? spreadsheetId,
      sheetId,
      sheetTitle: sheetProperties.title,
      rowCount: sheetProperties.gridProperties?.rowCount ?? 0,
      columnCount: sheetProperties.gridProperties?.columnCount ?? observedColumnWidth,
      observedColumnWidth,
      ...(scratchProtectedRangeId !== undefined ? { scratchProtectedRangeId } : {}),
      columns,
    };
  }

  // ── Pull ──────────────────────────────────────────────────────────────────

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: GoogleSheetsPullProgress }) => Promise<void>,
    // No resume cursor by design — see GoogleSheetsPullProgress. Pulls are
    // always full scans (Sheets has no modified-since concept).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _progress: GoogleSheetsPullProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const address = parseGoogleSheetsTableAddress(tableSpec.id);
    const description = await this.describeSheet(address);
    const lastColumnIndexExclusive = Math.max(1, ...description.columns.map((column) => column.columnIndex + 1));

    // Row 0 is the header row; data starts at grid row 1.
    let startRowIndex = 1;
    const seenRowNumberByScratchId = new Map<string, number>();

    while (startRowIndex < description.rowCount) {
      const endRowIndex = Math.min(startRowIndex + GOOGLE_SHEETS_ROW_PAGE_SIZE, description.rowCount);
      const matchedRanges = await this.client.batchGetValuesByDataFilter(address.spreadsheetId, [
        {
          gridRange: {
            sheetId: address.sheetId,
            startRowIndex,
            endRowIndex,
            startColumnIndex: 0,
            endColumnIndex: lastColumnIndexExclusive,
          },
        },
      ]);
      const pageRows = matchedRanges[0]?.valueRange?.values ?? [];

      const { files, missingIdCellWrites } = this.buildRecordsFromRows(
        description,
        pageRows,
        startRowIndex,
        seenRowNumberByScratchId,
      );

      // Backfill freshly-minted ids IMMEDIATELY — before handing records on —
      // so the observe→stamp window (during which a concurrent row reorder
      // could mis-assign ids) stays as small as one API round trip. Writes are
      // sparse: only the blank cells, never a full-column rewrite.
      if (missingIdCellWrites.length > 0) {
        await this.client.batchUpdateValuesByDataFilter(
          address.spreadsheetId,
          missingIdCellWrites.map(({ rowIndex, scratchId }) => ({
            dataFilter: {
              gridRange: {
                sheetId: address.sheetId,
                startRowIndex: rowIndex,
                endRowIndex: rowIndex + 1,
                startColumnIndex: 0,
                endColumnIndex: 1,
              },
            },
            values: [[scratchId]],
          })),
        );
      }

      startRowIndex = endRowIndex;
      if (files.length > 0) {
        await callback({ files });
      }
    }

    return {};
  }

  /**
   * Turn a page of raw rows into record files. "Blank" rows are skipped (see
   * rowCountsAsGoogleSheetsRecord); rows with data but a blank ID cell get a
   * fresh `scr_…` id (returned in `missingIdCellWrites` for the sparse
   * backfill). Duplicate ids — rows the user duplicated INCLUDING the ID cell —
   * fail the pull with both row numbers named: syncing would silently
   * cross-wire two rows' data.
   */
  private buildRecordsFromRows(
    description: GoogleSheetsSheetDescription,
    pageRows: GoogleSheetsCellValue[][],
    pageStartRowIndex: number,
    seenRowNumberByScratchId: Map<string, number>,
  ): { files: ConnectorFile[]; missingIdCellWrites: { rowIndex: number; scratchId: string }[] } {
    const files: ConnectorFile[] = [];
    const missingIdCellWrites: { rowIndex: number; scratchId: string }[] = [];

    pageRows.forEach((row, rowOffset) => {
      const rowIndex = pageStartRowIndex + rowOffset;
      // Coercion must match readIdColumnRowMap, or a non-string ID cell pulls
      // under an id that updates/deletes can never find.
      const scratchIdCellText = String(row[0] ?? '').trim();

      // A row without a Scratch ID must EARN record-hood with human-visible
      // content in a headered column; a row that already carries an id has
      // identity — skipping it would read as a remote deletion, so its
      // blankness is treated as data state, not garbage.
      if (scratchIdCellText === '' && !rowCountsAsGoogleSheetsRecord(row, description.columns)) return;

      let scratchId = scratchIdCellText;
      if (scratchId === '') {
        scratchId = createScratchRowId();
        missingIdCellWrites.push({ rowIndex, scratchId });
      }

      const existingRowNumber = seenRowNumberByScratchId.get(scratchId);
      if (existingRowNumber !== undefined) {
        // 1-based row numbers, as the user sees them in Sheets.
        throw new GoogleSheetsError(
          `Rows ${existingRowNumber + 1} and ${rowIndex + 1} of "${description.sheetTitle}" have the same ` +
            `Scratch ID ("${scratchId}") — this usually means a row was duplicated including its ID cell. ` +
            'Clear the ID cell of the duplicate row (Scratch will assign it a fresh ID on the next pull), then retry.',
          409,
        );
      }
      seenRowNumberByScratchId.set(scratchId, rowIndex);

      const file: ConnectorFile = { [SCRATCH_ID_RECORD_KEY]: scratchId };
      for (const column of description.columns) {
        const cellValue = row[column.columnIndex];
        // Empty cells arrive as '' or as absent (ragged rows) depending on
        // position — normalize both to null so the record shape is stable.
        file[column.slug] = cellValue === undefined || cellValue === '' ? null : cellValue;
      }
      files.push(file);
    });

    return { files, missingIdCellWrites };
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const requestedIds = new Set(ids);
    if (requestedIds.size === 0) return;
    // No random access by id — scan pages and filter (ids not found are
    // silently skipped per the contract). Reuses the pull machinery via a
    // wrapping callback, so backfill/duplicate handling stays identical.
    await this.pullRecordFiles(
      tableSpec,
      async ({ files }) => {
        const matchingFiles = files.filter((file) => {
          const scratchId = readRecordIdAsString(file, tableSpec.idPath);
          return scratchId !== null && requestedIds.has(scratchId);
        });
        if (matchingFiles.length > 0) {
          await callback({ files: matchingFiles });
        }
      },
      {},
      {},
    );
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  getBatchSize(operation: 'create' | 'update' | 'delete'): number {
    // One API call per batch regardless of size; these bound payloads and keep
    // the id-scan→write race window (updates/deletes) small.
    switch (operation) {
      case 'create':
        return 100;
      case 'update':
        return 25;
      case 'delete':
        return 100;
    }
  }

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const address = parseGoogleSheetsTableAddress(tableSpec.id);
    const description = await this.describeSheet(address);
    const lastColumnIndexExclusive = Math.max(1, ...description.columns.map((column) => column.columnIndex + 1));

    const filesWithIds: ConnectorFile[] = files.map((file) => {
      const existingId = readRecordIdAsString(file, tableSpec.idPath);
      return existingId ? { ...file } : { ...file, [SCRATCH_ID_RECORD_KEY]: createScratchRowId() };
    });

    const rows = filesWithIds.map((file) => {
      // `null` cells are SKIPPED by the append — they stay truly empty, so
      // column validation (checkboxes) and formats render on them.
      const row: (GoogleSheetsCellValue | null)[] = new Array<GoogleSheetsCellValue | null>(
        lastColumnIndexExclusive,
      ).fill(null);
      row[0] = readRecordIdAsString(file, tableSpec.idPath) ?? '';
      this.assertNoUnmappableKeys(file, description);
      for (const column of description.columns) {
        row[column.columnIndex] = toCellValue(file[column.slug], column.slug);
      }
      return row;
    });

    // One atomic append: rows are allocated and written together, so a crash
    // can never leave a half-written record (ids ride in the same call).
    await this.client.appendRows(address.spreadsheetId, description.sheetTitle, rows);
    return filesWithIds;
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const address = parseGoogleSheetsTableAddress(tableSpec.id);
    const description = await this.describeSheet(address);
    const columnBySlug = new Map(description.columns.map((column) => [column.slug, column]));
    const rowIndexByScratchId = await this.readIdColumnRowMap(address, description);

    const cellWrites: { rowIndex: number; columnIndex: number; value: GoogleSheetsCellValue | null }[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const scratchId = readRecordIdAsString(file, tableSpec.idPath);
      if (!scratchId) {
        throw new GoogleSheetsError('Cannot update a row that has no Scratch ID.');
      }
      const rowIndex = rowIndexByScratchId.get(scratchId);
      if (rowIndex === undefined) {
        throw new GoogleSheetsError(
          `Row ${scratchId} no longer exists in "${description.sheetTitle}" — it may have been deleted in Google Sheets. ` +
            'Pull the sheet to sync the deletion.',
          404,
        );
      }

      // Prefer the sparse diff; fall back to the full record only when absent.
      const changedFieldsForFile = changedFields?.[fileIndex] ?? stripScratchId(file);
      for (const [fieldKey, value] of Object.entries(changedFieldsForFile)) {
        if (fieldKey === SCRATCH_ID_RECORD_KEY) {
          // The id IS the row's identity — never rewrite it. An unchanged echo
          // is skipped; an actual EDIT is surfaced, never silently dropped
          // (Sheets would happily accept the write, so this error is the only
          // signal the user gets).
          if (value === scratchId) continue;
          throw new GoogleSheetsError(
            `The Scratch ID of a row cannot be edited (attempted to change "${scratchId}"). ` +
              'It identifies the row for syncing — undo the edit to this field.',
            400,
          );
        }
        const column = columnBySlug.get(fieldKey);
        if (!column) {
          throw new GoogleSheetsError(
            `The field "${fieldKey}" has no matching column in "${description.sheetTitle}" — its column may have ` +
              'been renamed or deleted in Google Sheets. Pull the sheet to refresh the schema, then re-apply the edit.',
            409,
          );
        }
        cellWrites.push({ rowIndex, columnIndex: column.columnIndex, value: toCellValue(value, fieldKey) });
      }
    }

    // Typed updateCells writes: booleans/numbers land as native values (so
    // checkbox/number columns render properly) and null CLEARS the cell — the
    // values API's only "empty" spelling ('' under RAW) stores an empty string.
    await this.client.updateCellValues(address.spreadsheetId, address.sheetId, cellWrites);

    // No read-back (each one is another request against a 60/min quota); the
    // sent payload is the placeholder return per the base-class contract.
    return files;
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const address = parseGoogleSheetsTableAddress(tableSpec.id);
    const description = await this.describeSheet(address);
    const rowIndexByScratchId = await this.readIdColumnRowMap(address, description);

    const rowIndexesToDelete: number[] = [];
    for (const file of files) {
      const scratchId = readRecordIdAsString(file, tableSpec.idPath);
      // No id → never published; unknown id → already gone. Both are no-ops.
      if (!scratchId) continue;
      const rowIndex = rowIndexByScratchId.get(scratchId);
      if (rowIndex === undefined) continue;
      rowIndexesToDelete.push(rowIndex);
    }
    if (rowIndexesToDelete.length === 0) return;

    // One atomic batchUpdate, deleting bottom-up so earlier deletions never
    // shift the indexes of later ones.
    const deleteRequests: GoogleSheetsBatchUpdateRequest[] = rowIndexesToDelete
      .sort((a, b) => b - a)
      .map((rowIndex) => ({
        deleteDimension: {
          range: { sheetId: address.sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      }));
    await this.client.batchUpdateSpreadsheet(address.spreadsheetId, deleteRequests);
  }

  /**
   * Scan the ID column and map each scratch id to its current 0-based row
   * index. Refreshed immediately before every update/delete batch — row
   * positions are only ever trusted for the duration of one back-to-back
   * scan→write pair (no conditional writes exist in this API).
   */
  private async readIdColumnRowMap(
    address: GoogleSheetsTableAddress,
    description: GoogleSheetsSheetDescription,
  ): Promise<Map<string, number>> {
    const matchedRanges = await this.client.batchGetValuesByDataFilter(address.spreadsheetId, [
      {
        gridRange: { sheetId: address.sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      },
    ]);
    const idColumnRows = matchedRanges[0]?.valueRange?.values ?? [];

    const rowIndexByScratchId = new Map<string, number>();
    idColumnRows.forEach((row, rowOffset) => {
      // Same coercion as the pull path (a numeric-typed ID cell must map the
      // same id string the pull produced, or updates/deletes can't find it).
      const scratchId = String(row[0] ?? '').trim();
      if (scratchId === '') return;
      const rowIndex = 1 + rowOffset;
      const existingRowIndex = rowIndexByScratchId.get(scratchId);
      if (existingRowIndex !== undefined) {
        throw new GoogleSheetsError(
          `Rows ${existingRowIndex + 1} and ${rowIndex + 1} of "${description.sheetTitle}" have the same ` +
            `Scratch ID ("${scratchId}") — writing would hit the wrong row. Clear the duplicate ID cell, then retry.`,
          409,
        );
      }
      rowIndexByScratchId.set(scratchId, rowIndex);
    });
    return rowIndexByScratchId;
  }

  /** Fail (loudly, before writing anything) when a record carries keys the sheet has no column for. */
  private assertNoUnmappableKeys(file: ConnectorFile, description: GoogleSheetsSheetDescription): void {
    const knownKeys = new Set<string>([SCRATCH_ID_RECORD_KEY, ...description.columns.map((column) => column.slug)]);
    const unmappableKeys = Object.entries(file)
      .filter(([key, value]) => !knownKeys.has(key) && value !== null && value !== undefined)
      .map(([key]) => key);
    if (unmappableKeys.length > 0) {
      throw new GoogleSheetsError(
        `This record has fields with no matching column in the sheet: ${unmappableKeys.join(', ')}. ` +
          'Their columns may have been renamed or deleted in Google Sheets. Pull the sheet to refresh the schema.',
        409,
      );
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.titlePath);
  }

  // ── Create schema (Live Export destination) ───────────────────────────────

  override supportsSchemaCreation(): boolean {
    return true;
  }

  override getSchemaCreationCapabilities(): SchemaCreationCapabilities {
    return GOOGLE_SHEETS_SCHEMA_CREATION_CAPABILITIES;
  }

  override async listCreateDestinations(): Promise<CreateDestination[]> {
    const knownSpreadsheetIds = await this.listKnownSpreadsheetIds();
    const knownDestinations = await Promise.all(
      knownSpreadsheetIds.map(async (spreadsheetId): Promise<CreateDestination | null> => {
        try {
          const spreadsheet = await this.client.getSpreadsheetStructure(spreadsheetId);
          return { id: spreadsheetId, name: spreadsheet.properties?.title ?? spreadsheetId, created: true };
        } catch {
          return null;
        }
      }),
    );
    return [
      // The only destination that does not exist yet: `created: false` is what
      // tells a UI to render "will be created" without knowing this sentinel id.
      { id: NEW_SPREADSHEET_DESTINATION_ID, name: NEW_SPREADSHEET_DESTINATION_NAME, created: false },
      ...knownDestinations.filter((destination): destination is CreateDestination => destination !== null),
    ];
  }

  override async searchCreateDestinations(
    searchTerm: string,
  ): Promise<{ destinations: CreateDestination[]; hasMore: boolean }> {
    // The search box accepts a pasted spreadsheet URL — the only way to reach a
    // spreadsheet the connection doesn't already know (no Drive browsing). A
    // long unspaced term can false-positive as a bare id; a 404/403 from Google
    // is an ordinary search miss, not an error.
    const pastedSpreadsheetId = parseSpreadsheetIdFromUrlOrId(searchTerm);
    if (pastedSpreadsheetId) {
      try {
        const spreadsheet = await this.client.getSpreadsheetStructure(pastedSpreadsheetId);
        return {
          destinations: [
            { id: pastedSpreadsheetId, name: spreadsheet.properties?.title ?? pastedSpreadsheetId, created: true },
          ],
          hasMore: false,
        };
      } catch (error) {
        if (!isAxiosError(error) || (error.response?.status !== 404 && error.response?.status !== 403)) {
          throw error;
        }
      }
    }
    const allDestinations = await this.listCreateDestinations();
    const lowerCaseSearchTerm = searchTerm.trim().toLowerCase();
    return {
      destinations:
        lowerCaseSearchTerm === ''
          ? allDestinations
          : allDestinations.filter((destination) => destination.name.toLowerCase().includes(lowerCaseSearchTerm)),
      hasMore: false,
    };
  }

  override async lookupCreateDestination(destinationId: string): Promise<CreateDestination | null> {
    if (destinationId === NEW_SPREADSHEET_DESTINATION_ID) {
      return { id: NEW_SPREADSHEET_DESTINATION_ID, name: NEW_SPREADSHEET_DESTINATION_NAME, created: false };
    }
    try {
      const spreadsheet = await this.client.getSpreadsheetStructure(destinationId);
      return { id: destinationId, name: spreadsheet.properties?.title ?? destinationId, created: true };
    } catch (error) {
      // 404 (deleted) and 403 (access revoked / different account) are the
      // definitive "stale selection" answers; anything else is transient and throws.
      if (isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 403)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * A create destination is a spreadsheet, which Drive addresses directly. The
   * "new spreadsheet" sentinel has no URL — nothing exists to link to until
   * materialize provisions it.
   *
   * A destination id can be text the user PASTED into the search box (see
   * {@link searchCreateDestinations}), so it goes through the same parser rather
   * than being interpolated raw; unparseable input yields no link.
   */
  override buildCreateDestinationRemoteWebUrl(destinationId: string): string | undefined {
    if (destinationId === NEW_SPREADSHEET_DESTINATION_ID) return undefined;
    const spreadsheetId = parseSpreadsheetIdFromUrlOrId(destinationId);
    return spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : undefined;
  }

  override async createTable(plan: NormalizedCreateTablePlan): Promise<CreateTableResult> {
    const spreadsheetId = await this.resolveCreateParentSpreadsheetId(plan.remoteParentId, plan.newParentName);

    // Order (primary first → column B), then map each field to its column plan.
    // Slugs must be unique up front — two headers that slugify identically
    // would wedge the new table (every later spec fetch throws the collision
    // error), so the later duplicate fails HERE instead of being created.
    const orderedFields = orderFieldsForCreateTable(plan.fields);
    const fieldResults: CreateFieldResult[] = [];
    const columnPlans: GoogleSheetsColumnPlan[] = [];
    const claimedSlugs = new Set<string>([SCRATCH_ID_RECORD_KEY]);
    for (const fieldSpec of orderedFields) {
      const slug = slugifyHeaderToFieldKey(fieldSpec.name);
      if (slug === '' || claimedSlugs.has(slug)) {
        fieldResults.push({
          name: fieldSpec.name,
          status: 'failed',
          error:
            slug === ''
              ? `"${fieldSpec.name}" contains no letters or digits, so it can't become a column header.`
              : `"${fieldSpec.name}" collides with another field mapping to the same key "${slug}" — rename one of them.`,
        });
        continue;
      }
      const built = buildGoogleSheetsColumn(fieldSpec);
      if ('skip' in built) {
        fieldResults.push({ name: fieldSpec.name, status: 'skipped', error: built.skip });
      } else {
        claimedSlugs.add(slug);
        columnPlans.push(built.column);
        // The header text IS the column's remote identifier (the slug is our
        // derived record key); apply's created-field resolution matches on it.
        fieldResults.push({ name: fieldSpec.name, status: 'created', remoteFieldId: fieldSpec.name });
      }
    }

    const addSheetResponse = await this.client.batchUpdateSpreadsheet(spreadsheetId, [
      {
        addSheet: {
          properties: {
            title: plan.name,
            gridProperties: {
              rowCount: GOOGLE_SHEETS_NEW_SHEET_ROW_COUNT,
              // +1 for the Scratch ID column, +1 spare so appendDimension isn't
              // needed for the first added field.
              columnCount: columnPlans.length + 2,
            },
          },
        },
      },
    ]);
    const newSheetProperties = addSheetResponse.replies?.[0]?.addSheet?.properties;
    if (!newSheetProperties) {
      throw new GoogleSheetsError(`Google did not return the new sheet's id for "${plan.name}".`);
    }
    const sheetId = newSheetProperties.sheetId;

    // One batchUpdate finishes the table: ID column protocol on the fresh
    // (empty) column A, then each field column's header/format/validation.
    const setupRequests: GoogleSheetsBatchUpdateRequest[] = buildScratchIdColumnSetupRequests({
      sheetId,
      includeInsertColumn: false,
      includeSheetSetupMarker: true,
      // A brand-new sheet has no protections yet.
      includeProtectedRange: true,
      frozenRowCount: 0,
    });
    columnPlans.forEach((columnPlan, planIndex) => {
      setupRequests.push(...this.buildFieldColumnRequests(sheetId, 1 + planIndex, columnPlan));
    });
    // Now that this real sheet exists, it is safe to drop the blank default tab
    // of a spreadsheet we just created (no-op for existing spreadsheets / after
    // the first created table). Bundled into the setup batch so it costs no extra
    // request.
    setupRequests.push(...this.takeBlankDefaultSheetDeletionRequests(spreadsheetId));
    await this.client.batchUpdateSpreadsheet(spreadsheetId, setupRequests);
    this.invalidateSheetDescriptionMemo({ spreadsheetId, sheetId });

    return {
      ref: plan.ref,
      name: newSheetProperties.title ?? plan.name,
      status: 'created',
      remoteTableId: [spreadsheetId, String(sheetId)],
      // Report the spreadsheet we actually landed in. When the plan named the
      // "new spreadsheet" sentinel this is the one we just provisioned, and the
      // caller pins it so a later create adds tabs here rather than spinning up
      // a second spreadsheet.
      remoteParentId: [spreadsheetId],
      fields: fieldResults,
    };
  }

  override async createFields(plan: NormalizedCreateFieldsPlan): Promise<CreateFieldResult[]> {
    const address = parseGoogleSheetsTableAddress({ wsId: plan.remoteTableId[0], remoteId: plan.remoteTableId });
    const description = await this.describeSheet(address);

    // Place new columns after the last OBSERVED-occupied column, not just the
    // last schema-visible one — a column the schema can't see (an empty or
    // symbols-only header over real data) must never be overwritten.
    const existingSlugs = new Set<string>([SCRATCH_ID_RECORD_KEY, ...description.columns.map((column) => column.slug)]);
    const nextColumnIndex = description.observedColumnWidth;

    const fieldResults: CreateFieldResult[] = [];
    const requests: GoogleSheetsBatchUpdateRequest[] = [];
    let createdCount = 0;
    for (const fieldSpec of plan.fields) {
      const slug = slugifyHeaderToFieldKey(fieldSpec.name);
      if (slug === '') {
        fieldResults.push({
          name: fieldSpec.name,
          status: 'failed',
          error: `"${fieldSpec.name}" contains no letters or digits, so it can't become a column header.`,
        });
        continue;
      }
      if (existingSlugs.has(slug)) {
        fieldResults.push({
          name: fieldSpec.name,
          status: 'failed',
          error: `A column named "${fieldSpec.name}" (field key "${slug}") already exists in this sheet.`,
        });
        continue;
      }
      const built = buildGoogleSheetsColumn(fieldSpec);
      if ('skip' in built) {
        fieldResults.push({ name: fieldSpec.name, status: 'skipped', error: built.skip });
        continue;
      }
      existingSlugs.add(slug);
      requests.push(...this.buildFieldColumnRequests(address.sheetId, nextColumnIndex + createdCount, built.column));
      // Header text = the column's remote id (see createTable).
      fieldResults.push({ name: fieldSpec.name, status: 'created', remoteFieldId: fieldSpec.name });
      createdCount += 1;
    }

    if (createdCount > 0) {
      // Grow the grid when the new columns don't fit in the current width.
      const requiredColumnCount = nextColumnIndex + createdCount;
      const growRequests: GoogleSheetsBatchUpdateRequest[] =
        requiredColumnCount > description.columnCount
          ? [
              {
                appendDimension: {
                  sheetId: address.sheetId,
                  dimension: 'COLUMNS',
                  length: requiredColumnCount - description.columnCount,
                },
              },
            ]
          : [];
      await this.client.batchUpdateSpreadsheet(address.spreadsheetId, [...growRequests, ...requests]);
      this.invalidateSheetDescriptionMemo(address);
    }

    return fieldResults;
  }

  /** Header cell + data-row format/validation + FK marker for one field column. */
  private buildFieldColumnRequests(
    sheetId: number,
    columnIndex: number,
    columnPlan: GoogleSheetsColumnPlan,
  ): GoogleSheetsBatchUpdateRequest[] {
    const requests: GoogleSheetsBatchUpdateRequest[] = [];

    requests.push({
      updateCells: {
        start: { sheetId, rowIndex: 0, columnIndex },
        rows: [
          {
            values: [
              {
                userEnteredValue: { stringValue: columnPlan.header },
                userEnteredFormat: { textFormat: { bold: true } },
                ...(columnPlan.headerNote !== undefined ? { note: columnPlan.headerNote } : {}),
              },
            ],
          },
        ],
        fields: `userEnteredValue,userEnteredFormat.textFormat${columnPlan.headerNote !== undefined ? ',note' : ''}`,
      },
    });

    if (columnPlan.numberFormat || columnPlan.dataValidation) {
      const cellFields: string[] = [];
      const cell: { userEnteredFormat?: Record<string, unknown>; dataValidation?: typeof columnPlan.dataValidation } =
        {};
      if (columnPlan.numberFormat) {
        cell.userEnteredFormat = { numberFormat: columnPlan.numberFormat };
        cellFields.push('userEnteredFormat.numberFormat');
      }
      if (columnPlan.dataValidation) {
        cell.dataValidation = columnPlan.dataValidation;
        cellFields.push('dataValidation');
      }
      requests.push({
        repeatCell: {
          // Data rows only — the header keeps its own look.
          range: { sheetId, startRowIndex: 1, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
          cell,
          fields: cellFields.join(','),
        },
      });
    }

    if (columnPlan.foreignKeyTargetMetadataValue !== undefined) {
      requests.push({
        createDeveloperMetadata: {
          developerMetadata: {
            metadataKey: SCRATCH_FK_TARGET_METADATA_KEY,
            metadataValue: columnPlan.foreignKeyTargetMetadataValue,
            visibility: 'DOCUMENT',
            location: {
              dimensionRange: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 },
            },
          },
        },
      });
    }

    return requests;
  }

  /** Resolve the createTable parent: an existing spreadsheet id, or the "new spreadsheet" sentinel. */
  private async resolveCreateParentSpreadsheetId(
    remoteParentId: string[] | undefined,
    newSpreadsheetTitle: string | undefined,
  ): Promise<string> {
    const parentId = remoteParentId?.[0];
    if (parentId && parentId !== NEW_SPREADSHEET_DESTINATION_ID) {
      const pastedSpreadsheetId = parseSpreadsheetIdFromUrlOrId(parentId);
      return pastedSpreadsheetId ?? parentId;
    }
    // "New spreadsheet" (or no parent chosen): create one — memoized so every
    // table in the same materialize batch lands in the same spreadsheet.
    if (!this.createdSpreadsheetIdForNewDestination) {
      const title = newSpreadsheetTitle ?? NEW_SPREADSHEET_DEFAULT_TITLE;
      const spreadsheet = await this.client.createSpreadsheet(title);
      if (!spreadsheet.spreadsheetId) {
        throw new GoogleSheetsError('Google did not return an id for the newly created spreadsheet.');
      }
      this.createdSpreadsheetIdForNewDestination = spreadsheet.spreadsheetId;
      // `spreadsheets.create` always seeds one empty default sheet ("Sheet1").
      // Every table we add becomes its OWN sheet, so that default tab would be
      // left blank and unused — remember its id so the first created table can
      // delete it (a spreadsheet must always keep ≥1 sheet, so we can only drop
      // it once a real sheet exists). Proto3 elides the default gid 0, so read
      // it as `?? 0`.
      this.blankDefaultSheetIdToDeleteFromNewSpreadsheet = spreadsheet.sheets?.[0]?.properties?.sheetId ?? 0;
      WSLogger.info({
        source: 'GoogleSheetsConnector',
        message: `Created spreadsheet ${spreadsheet.spreadsheetId} for Live Export ("${title}")`,
      });
    }
    return this.createdSpreadsheetIdForNewDestination;
  }

  /**
   * A `deleteSheet` request for the blank default tab of the spreadsheet we just
   * created for this "new spreadsheet" batch, or `[]` if there is nothing pending
   * (an existing spreadsheet, or the default tab was already deleted by an earlier
   * table in the batch). Clears the pending id so the delete happens exactly once.
   * Must only be appended to a batchUpdate that ALSO adds a real sheet, so the
   * spreadsheet never momentarily drops to zero sheets.
   */
  private takeBlankDefaultSheetDeletionRequests(spreadsheetId: string): GoogleSheetsBatchUpdateRequest[] {
    if (spreadsheetId !== this.createdSpreadsheetIdForNewDestination) return [];
    const blankDefaultSheetId = this.blankDefaultSheetIdToDeleteFromNewSpreadsheet;
    if (blankDefaultSheetId === undefined) return [];
    this.blankDefaultSheetIdToDeleteFromNewSpreadsheet = undefined;
    return [{ deleteSheet: { sheetId: blankDefaultSheetId } }];
  }

  // ── Errors ────────────────────────────────────────────────────────────────

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof GoogleSheetsError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { status: error.statusCode, responseData: error.responseData },
      };
    }
    if (isAxiosError(error)) {
      const commonDetails = extractCommonDetailsFromAxiosError(this, error);
      if (commonDetails) return commonDetails;
      // Google error bodies are `{ error: { message, status } }`.
      const googleMessage = extractErrorMessageFromAxiosError(this.service, error, ['error.message']);
      return {
        userFriendlyMessage: `Google Sheets: ${googleMessage}`,
        description: error.message,
        additionalContext: { status: error.response?.status },
      };
    }
    return this.fallbackErrorDetails(error);
  }
}

/**
 * Convert a record field value to a cell value. Cells hold exactly one scalar:
 * null/undefined mean "empty" (appends skip the cell; updates clear it);
 * lists/objects can't be stored and fail loudly rather than being stringified
 * behind the user's back.
 */
function toCellValue(value: unknown, fieldKey: string): GoogleSheetsCellValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new GoogleSheetsError(
    `The field "${fieldKey}" holds a ${Array.isArray(value) ? 'list' : 'nested object'}, but a Google Sheets cell ` +
      'can only store a single text, number, or boolean value.',
    400,
  );
}

/** A copy of the record without its scratch_id key (for full-file update fallbacks). */
function stripScratchId(file: ConnectorFile): Record<string, unknown> {
  const fileWithoutScratchId = { ...file };
  delete fileWithoutScratchId[SCRATCH_ID_RECORD_KEY];
  return fileWithoutScratchId;
}

connectorRegistry.register({
  service: Service.GOOGLE_SHEETS,
  metadata: GoogleSheetsConnector.metadata,
  advancedSettings: [],
  // Sheets per-user quotas are 60 read + 60 write requests/min; 1/s holds both
  // ceilings burst-free.
  rateLimiterSpec: { points: 1, duration: 1 },
  supportedAuthMethods: ['oauth'],
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Google Sheets', Service.GOOGLE_SHEETS);
    }
    const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
    if (!accessToken) {
      throw new ConnectorInstantiationError('Missing access token for Google Sheets', Service.GOOGLE_SHEETS);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    return new GoogleSheetsConnector(accessToken, {
      rateLimiter,
      connectorAccountId: ctx.connectorAccount.id,
      listFolderTableIds: ctx.listFolderTableIds,
      spreadsheetIdsFromConnectExtras: spreadsheetIdsFromConnectorAccountExtras(ctx.connectorAccount.extras),
    });
  },
});
