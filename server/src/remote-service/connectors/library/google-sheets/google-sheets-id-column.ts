import {
  GoogleSheetsBatchUpdateRequest,
  GoogleSheetsDeveloperMetadata,
  GoogleSheetsError,
  SCRATCH_ID_COLUMN_HEADER,
  SCRATCH_ID_COLUMN_METADATA_KEY,
  SCRATCH_ID_COLUMN_NOTE,
  SCRATCH_ID_COLUMN_PROTECTION_DESCRIPTION,
  SCRATCH_SHEET_SETUP_METADATA_KEY,
  SCRATCH_SHEET_SETUP_METADATA_VALUE,
  ScratchIdColumnState,
} from './google-sheets-types';

/**
 * The Scratch ID column protocol.
 *
 * Column A of a connected sheet is the managed "Scratch ID" column: it holds the
 * `scr_…` id that is each row's remote id. The column is identified two ways —
 * column-dimension developer metadata (primary; travels with the column through
 * reorders) and the exact header text (fallback; also the user's recovery path).
 * A separate SHEET-level marker records "Scratch set this sheet up", which is
 * what lets us distinguish first contact (create the column) from a user having
 * deleted the column (fail loudly, never silently re-id the sheet's rows).
 */

/** Grid formatting shared by the whole ID column (light gray, text-typed, clipped). */
const ID_COLUMN_CELL_FORMAT = {
  numberFormat: { type: 'TEXT' },
  backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
  wrapStrategy: 'CLIP',
};

/** The header cell gets a slightly darker "system column" look on top. */
const ID_COLUMN_HEADER_FORMAT = {
  ...ID_COLUMN_CELL_FORMAT,
  backgroundColor: { red: 0.85, green: 0.85, blue: 0.87 },
  textFormat: { bold: true, foregroundColor: { red: 0.35, green: 0.35, blue: 0.35 } },
};

/**
 * The sheetId of SHEET-located metadata. Google elides proto3 defaults from
 * JSON, so gid 0 — the default first tab, the single most common sheet users
 * connect — arrives with `location.sheetId` ABSENT; reading it naively makes
 * every marker on a gid-0 sheet invisible. `locationType` disambiguates
 * (`'SHEET'` is never elided — the proto default is UNSPECIFIED), so an absent
 * sheetId on a SHEET location definitively means 0.
 */
function sheetIdOfSheetLocatedMetadata(metadata: GoogleSheetsDeveloperMetadata): number | undefined {
  if (metadata.location?.locationType !== 'SHEET') return undefined;
  return metadata.location.sheetId ?? 0;
}

/** The sheetId of COLUMNS-dimension metadata (same gid-0 elision rule as above). */
function sheetIdOfColumnLocatedMetadata(metadata: GoogleSheetsDeveloperMetadata): number | undefined {
  const dimensionRange = metadata.location?.dimensionRange;
  if (!dimensionRange || dimensionRange.dimension !== 'COLUMNS') return undefined;
  return dimensionRange.sheetId ?? 0;
}

/** Whether the SHEET-level "Scratch set this sheet up" marker is present. */
export function hasSheetSetupMarker(
  developerMetadataForSheet: GoogleSheetsDeveloperMetadata[],
  sheetId: number,
): boolean {
  return developerMetadataForSheet.some(
    (metadata) =>
      metadata.metadataKey === SCRATCH_SHEET_SETUP_METADATA_KEY && sheetIdOfSheetLocatedMetadata(metadata) === sheetId,
  );
}

/**
 * The 0-based column index of COLUMNS-dimension metadata on the given sheet, or
 * undefined when the metadata isn't a column marker on that sheet. Handles both
 * proto3 elisions: an absent `dimensionRange.sheetId` means gid 0, and an
 * absent `startIndex` means column 0.
 */
export function columnIndexOfColumnMetadata(
  metadata: GoogleSheetsDeveloperMetadata,
  sheetId: number,
): number | undefined {
  if (sheetIdOfColumnLocatedMetadata(metadata) !== sheetId) return undefined;
  return metadata.location?.dimensionRange?.startIndex ?? 0;
}

/**
 * Decide the state of column A from the sheet's developer metadata and header
 * row. `headerRowValues[0]` is the A1 cell text ('' when empty).
 */
export function analyzeScratchIdColumnState(
  developerMetadataForSheet: GoogleSheetsDeveloperMetadata[],
  headerRowValues: (string | undefined)[],
  sheetId: number,
): ScratchIdColumnState {
  const sheetSetupMarkerPresent = hasSheetSetupMarker(developerMetadataForSheet, sheetId);
  const idColumnIndexFromMetadata = developerMetadataForSheet
    .filter((metadata) => metadata.metadataKey === SCRATCH_ID_COLUMN_METADATA_KEY)
    .map((metadata) => columnIndexOfColumnMetadata(metadata, sheetId))
    .find((columnIndex) => columnIndex !== undefined);
  const headerA1Text = (headerRowValues[0] ?? '').trim();

  if (idColumnIndexFromMetadata === 0) {
    // The metadata is authoritative; a renamed header is cosmetic (we never
    // rewrite user content outside setup, so it stays as the user typed it).
    return { kind: 'valid', needsMetadataStamp: false };
  }
  if (idColumnIndexFromMetadata !== undefined && idColumnIndexFromMetadata > 0) {
    return { kind: 'moved', currentColumnIndex: idColumnIndexFromMetadata };
  }

  // No column metadata. The exact header text still identifies the column —
  // this is the recovery path (user re-inserted a blank "Scratch ID" column
  // after deleting the managed one) and the copied-sheet path (metadata is
  // DOCUMENT-scoped and doesn't survive a copy) — re-stamp and re-style it.
  if (headerA1Text === SCRATCH_ID_COLUMN_HEADER) {
    return { kind: 'valid', needsMetadataStamp: true };
  }

  return sheetSetupMarkerPresent ? { kind: 'deleted' } : { kind: 'never-set-up' };
}

/**
 * The user-facing fatal error for a poisoned sheet (ID column deleted or moved).
 * Includes the recovery recipe — which works with zero special-case code: the
 * header-text adoption path re-recognizes the column, and the pull-time backfill
 * assigns fresh ids to its blank cells.
 */
export function buildPoisonedSheetError(sheetTitle: string, state: { kind: 'deleted' | 'moved' }): GoogleSheetsError {
  const whatHappened =
    state.kind === 'deleted'
      ? `The "${SCRATCH_ID_COLUMN_HEADER}" column has been deleted from the sheet "${sheetTitle}".`
      : `The "${SCRATCH_ID_COLUMN_HEADER}" column in the sheet "${sheetTitle}" is no longer the first column.`;
  const recovery =
    state.kind === 'moved'
      ? `Move it back so it is column A, then retry.`
      : `Scratch can no longer tell which row is which, so syncing is stopped to protect your data. ` +
        `To reconnect: insert a blank first column in the sheet and give it the header "${SCRATCH_ID_COLUMN_HEADER}" (exactly). ` +
        `Scratch will re-adopt it and assign fresh IDs on the next pull — existing records will re-sync as new ones.`;
  return new GoogleSheetsError(`${whatHappened} ${recovery}`, 409);
}

/**
 * Build the batchUpdate requests that create (or re-adopt) the ID column.
 *
 * @param includeInsertColumn true on first contact — physically insert a new
 *   column A (shifting user data right). False when adopting an existing column
 *   A (fresh Live-Export-created sheets, and the header-text recovery path).
 * @param frozenRowCount the sheet's current frozen row count (freeze row 1 only
 *   when nothing is frozen yet — never undo a bigger freeze the user set).
 */
export function buildScratchIdColumnSetupRequests(params: {
  sheetId: number;
  includeInsertColumn: boolean;
  includeSheetSetupMarker: boolean;
  /**
   * False when the ID column's protected range already exists (a copied
   * spreadsheet keeps the original's protections) — adding another would stack
   * duplicate warning dialogs on every edit.
   */
  includeProtectedRange: boolean;
  frozenRowCount: number;
}): GoogleSheetsBatchUpdateRequest[] {
  const { sheetId, includeInsertColumn, includeSheetSetupMarker, includeProtectedRange, frozenRowCount } = params;
  const requests: GoogleSheetsBatchUpdateRequest[] = [];

  if (includeInsertColumn) {
    requests.push({
      insertDimension: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        inheritFromBefore: false,
      },
    });
  }

  // Whole-column look: TEXT-typed, light gray, clipped; and clear any data
  // validation a previous column occupant left behind.
  requests.push({
    repeatCell: {
      range: { sheetId, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: ID_COLUMN_CELL_FORMAT, dataValidation: null },
      fields: 'userEnteredFormat(numberFormat,backgroundColor,wrapStrategy),dataValidation',
    },
  });

  // Header cell: title + note + the darker "system" styling.
  requests.push({
    updateCells: {
      start: { sheetId, rowIndex: 0, columnIndex: 0 },
      rows: [
        {
          values: [
            {
              userEnteredValue: { stringValue: SCRATCH_ID_COLUMN_HEADER },
              userEnteredFormat: ID_COLUMN_HEADER_FORMAT,
              note: SCRATCH_ID_COLUMN_NOTE,
            },
          ],
        },
      ],
      fields: 'userEnteredValue,userEnteredFormat(numberFormat,backgroundColor,wrapStrategy,textFormat),note',
    },
  });

  // Freeze the header row (only when nothing is frozen — never shrink a user's freeze).
  if (frozenRowCount < 1) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
  }

  // Warning-only protection: every editor gets Google's "you're editing a
  // protected range" dialog. (A hard block can't stop the file owner — we ACT
  // as the user — and would lock out collaborators, so warning-only is the
  // strongest deterrent that doesn't break anyone's legitimate workflow.)
  if (includeProtectedRange) {
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId, startColumnIndex: 0, endColumnIndex: 1 },
          description: SCRATCH_ID_COLUMN_PROTECTION_DESCRIPTION,
          warningOnly: true,
        },
      },
    });
  }

  // Identity markers: the column marker (travels with the column), and the
  // sheet marker (survives the column being deleted — the poison detector).
  requests.push({
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: SCRATCH_ID_COLUMN_METADATA_KEY,
        metadataValue: SCRATCH_ID_COLUMN_HEADER,
        visibility: 'DOCUMENT',
        location: { dimensionRange: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 } },
      },
    },
  });
  if (includeSheetSetupMarker) {
    requests.push({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: SCRATCH_SHEET_SETUP_METADATA_KEY,
          metadataValue: SCRATCH_SHEET_SETUP_METADATA_VALUE,
          visibility: 'DOCUMENT',
          location: { sheetId },
        },
      },
    });
  }

  return requests;
}
