import { getByPath, setByPath } from '../../../../shared/schema-columns';
import type { ColumnDefinition } from '../../types/local-files';
import type { InvalidJsonFileListEntry } from './InvalidJsonFilesModal';

/**
 * The diff-grid row/result data model and the optimistic-update helpers that keep an
 * in-memory `DiffGridResult` consistent after a single field edit is accepted. Extracted
 * from `FolderDataGrid` (unchanged behavior) so the new `ReviewTableGrid` renders the same
 * rows and applies the same optimistic updates — the two grids share one definition of the
 * data contract and of "what a row/summary looks like after an accepted edit". Lives in a
 * plain `.ts` module (no component export) per `react-refresh/only-export-components`.
 */

// ── Types ──

export type RowStatus =
  | 'added'
  | 'addedUnpublished'
  | 'modified'
  | 'unpublished'
  | 'deleted'
  | 'deletedUnpublished'
  | 'unchanged'
  | 'invalidJson'
  // DEV-11059: an existing (already-pulled) record whose published `refs/heads/main`
  // baseline failed to resolve, so we cannot compute a diff. Handled like `invalidJson`
  // (a row-level "can't diff — needs attention" state), NEVER as an `added` create.
  | 'baselineUnavailable';

export interface DiffRow {
  [key: string]: unknown;
  __rowStatus: RowStatus;
  __changedFields: string[];
  __fromFields: Record<string, unknown>;
  __unpublishedFields: string[];
  __masterFields: Record<string, unknown>;
  __filename: string;
  __parseError?: string;
  /** DEV-11059: message for a `baselineUnavailable` row (why the published baseline couldn't be loaded). */
  __baselineError?: string;
  /** DEV-10048: per-field connector rejection messages from a prior failed publish. */
  __failedFields?: Record<string, string>;
  /** DEV-10048: record-level connector rejection message from a prior failed publish. */
  __failedError?: string;
  __raw: Record<string, unknown>;
}

export interface CellValidationEntry {
  field_path: string;
  validator_kind: string;
  level: string;
  message?: string | null;
  description?: string | null;
  fixable: boolean;
}

export interface DiffGridResult {
  rows: DiffRow[];
  columns: ColumnDefinition[];
  total: number;
  summary: {
    total: number;
    added: number;
    addedApproved: number;
    modified: number;
    unpublished: number;
    deleted: number;
    deletedApproved: number;
    invalidJson: number;
  };
  filterCounts: { unreviewed: number; unpublished: number; pending: number; errors: number };
  focusColumnIds: { unreviewed: string[]; unpublished: string[]; errors: string[] };
  invalidJsonFiles: InvalidJsonFileListEntry[];
  /**
   * Human-readable names for foreign-key (reference) cells (DEV-10530): column id
   * -> raw referenced id -> the linked record's display name. A column appears
   * only when its reference target resolves to a folder in this workspace; an id
   * appears only when its linked record was found. Missing entries render the raw id.
   */
  referenceLabels?: Record<string, Record<string, string>>;
  staleCount: number;
  validationByCell: Record<string, CellValidationEntry[]>;
  totalErrorCount: number;
  totalProblemsStaleCount: number;
}

// ── Optimistic-update helpers ──

function diffValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function deriveRowStatusAfterEdit(row: DiffRow): RowStatus {
  if (
    row.__rowStatus === 'added' ||
    row.__rowStatus === 'addedUnpublished' ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'deletedUnpublished' ||
    row.__rowStatus === 'invalidJson' ||
    row.__rowStatus === 'baselineUnavailable'
  ) {
    return row.__rowStatus;
  }
  if (row.__changedFields.length > 0) {
    return 'modified';
  }
  if (row.__unpublishedFields.length > 0) {
    return 'unpublished';
  }
  return 'unchanged';
}

function recomputeSummaryCount(prev: DiffRow, next: DiffRow, status: RowStatus, count: number): number {
  const wasStatus = prev.__rowStatus === status;
  const isStatus = next.__rowStatus === status;
  if (wasStatus === isStatus) return count;
  return count + (isStatus ? 1 : -1);
}

function recomputeFilterCount(prevHad: boolean, nextHas: boolean, count: number): number {
  if (prevHad === nextHas) return count;
  return count + (nextHas ? 1 : -1);
}

function replaceRowInResult(result: DiffGridResult, prevRow: DiffRow, nextRow: DiffRow): DiffGridResult {
  const nextRows = result.rows.map((r) => (r.__filename === prevRow.__filename ? nextRow : r));

  const prevHadUnreviewed =
    prevRow.__rowStatus === 'added' ||
    prevRow.__rowStatus === 'deleted' ||
    prevRow.__rowStatus === 'invalidJson' ||
    prevRow.__rowStatus === 'baselineUnavailable' ||
    prevRow.__changedFields.length > 0;
  const nextHasUnreviewed =
    nextRow.__rowStatus === 'added' ||
    nextRow.__rowStatus === 'deleted' ||
    nextRow.__rowStatus === 'invalidJson' ||
    nextRow.__rowStatus === 'baselineUnavailable' ||
    nextRow.__changedFields.length > 0;
  const prevHadUnpublished =
    prevRow.__rowStatus === 'addedUnpublished' ||
    prevRow.__rowStatus === 'deletedUnpublished' ||
    prevRow.__unpublishedFields.length > 0;
  const nextHasUnpublished =
    nextRow.__rowStatus === 'addedUnpublished' ||
    nextRow.__rowStatus === 'deletedUnpublished' ||
    nextRow.__unpublishedFields.length > 0;

  const summary: DiffGridResult['summary'] = {
    total: result.summary.total,
    added: recomputeFilterCount(
      prevRow.__rowStatus === 'added' || prevRow.__rowStatus === 'addedUnpublished',
      nextRow.__rowStatus === 'added' || nextRow.__rowStatus === 'addedUnpublished',
      result.summary.added,
    ),
    addedApproved: recomputeSummaryCount(prevRow, nextRow, 'addedUnpublished', result.summary.addedApproved),
    modified: recomputeSummaryCount(prevRow, nextRow, 'modified', result.summary.modified),
    unpublished: recomputeSummaryCount(prevRow, nextRow, 'unpublished', result.summary.unpublished),
    deleted: recomputeFilterCount(
      prevRow.__rowStatus === 'deleted' || prevRow.__rowStatus === 'deletedUnpublished',
      nextRow.__rowStatus === 'deleted' || nextRow.__rowStatus === 'deletedUnpublished',
      result.summary.deleted,
    ),
    deletedApproved: recomputeSummaryCount(prevRow, nextRow, 'deletedUnpublished', result.summary.deletedApproved),
    invalidJson: recomputeSummaryCount(prevRow, nextRow, 'invalidJson', result.summary.invalidJson),
  };

  const filterCounts = {
    unreviewed: recomputeFilterCount(prevHadUnreviewed, nextHasUnreviewed, result.filterCounts.unreviewed),
    unpublished: recomputeFilterCount(prevHadUnpublished, nextHasUnpublished, result.filterCounts.unpublished),
    // Pending = needs-review OR approved; recompute from the union of both axes.
    pending: recomputeFilterCount(
      prevHadUnreviewed || prevHadUnpublished,
      nextHasUnreviewed || nextHasUnpublished,
      result.filterCounts.pending,
    ),
    errors: result.filterCounts.errors,
  };

  return { ...result, rows: nextRows, summary, filterCounts };
}

/**
 * Apply an accepted single-field edit to an in-memory `DiffGridResult`: clears the field
 * from the unreviewed set, recomputes whether it now matches the published master (moving it
 * in/out of the unpublished set), writes the value into `__raw`, and re-derives the row
 * status + summary/filter counts. Returns a new `DiffGridResult` (the previous one is left
 * untouched); returns the input unchanged when the filename isn't present.
 */
export function applyAcceptedFieldChangeToFolderDiffData(
  result: DiffGridResult,
  filename: string,
  fieldName: string,
  nextValue: unknown,
): DiffGridResult {
  const prevRow = result.rows.find((r) => r.__filename === filename);
  if (!prevRow) return result;

  const masterValue = prevRow.__masterFields[fieldName];
  const masterHadField = Object.prototype.hasOwnProperty.call(prevRow.__masterFields, fieldName);
  const nextFromFields = { ...prevRow.__fromFields };
  delete nextFromFields[fieldName];

  const wasUnpublished = prevRow.__unpublishedFields.includes(fieldName);
  const matchesMaster = masterHadField && diffValuesEqual(nextValue, masterValue);
  const nextUnpublishedFields = wasUnpublished
    ? matchesMaster
      ? prevRow.__unpublishedFields.filter((f) => f !== fieldName)
      : prevRow.__unpublishedFields
    : matchesMaster
      ? prevRow.__unpublishedFields
      : [...prevRow.__unpublishedFields, fieldName];

  const nextRaw = setByPath(prevRow.__raw, fieldName, nextValue);
  const nextRow: DiffRow = {
    ...prevRow,
    __raw: nextRaw,
    __changedFields: prevRow.__changedFields.filter((f) => f !== fieldName),
    __fromFields: nextFromFields,
    __unpublishedFields: nextUnpublishedFields,
  };
  nextRow.__rowStatus = deriveRowStatusAfterEdit(nextRow);

  return replaceRowInResult(result, prevRow, nextRow);
}

// ── Whole-record optimistic-update helpers (DEV-10610) ──
//
// These flip a grid row's *review state* (status + changed/unpublished sets, and the recomputed
// summary/filter counts) after a whole-record accept/reject/discard, so the row's colour and the
// header counts update instantly — mirroring the field-level helper above. They deliberately do NOT
// rewrite field *values* in `__raw`: the caller re-reads the folder page from disk right after
// (an in-place `refreshGridDataInBackground` / `bumpReviewDataVersion` that keeps painting current
// rows), which reconciles the displayed values with the authoritative on-disk state. Each returns
// the input result unchanged when the filename isn't present or there is nothing to change.

/**
 * Apply a whole-record **accept** to an in-memory `DiffGridResult`: promote every unreviewed field
 * edit to approved (keeping each in the unpublished set unless it already matches the published
 * value), or flip a needs-review added/deleted row to its approved (`*Unpublished`) variant, then
 * re-derive the row status + summary/filter counts.
 */
export function applyAcceptedRecordChangeToFolderDiffData(result: DiffGridResult, filename: string): DiffGridResult {
  const prevRow = result.rows.find((r) => r.__filename === filename);
  if (!prevRow) return result;

  let nextRow: DiffRow;
  if (prevRow.__rowStatus === 'added') {
    nextRow = { ...prevRow, __rowStatus: 'addedUnpublished' };
  } else if (prevRow.__rowStatus === 'deleted') {
    nextRow = { ...prevRow, __rowStatus: 'deletedUnpublished' };
  } else {
    if (prevRow.__changedFields.length === 0) return result;
    const nextFromFields = { ...prevRow.__fromFields };
    const nextUnpublishedFields = [...prevRow.__unpublishedFields];
    for (const field of prevRow.__changedFields) {
      delete nextFromFields[field];
      const workingValue = getByPath(prevRow.__raw, field);
      const masterHadField = Object.prototype.hasOwnProperty.call(prevRow.__masterFields, field);
      const matchesMaster = masterHadField && diffValuesEqual(workingValue, prevRow.__masterFields[field]);
      if (!matchesMaster && !nextUnpublishedFields.includes(field)) nextUnpublishedFields.push(field);
    }
    nextRow = {
      ...prevRow,
      __changedFields: [],
      __fromFields: nextFromFields,
      __unpublishedFields: nextUnpublishedFields,
    };
    nextRow.__rowStatus = deriveRowStatusAfterEdit(nextRow);
  }

  return replaceRowInResult(result, prevRow, nextRow);
}

/**
 * Apply a whole-record **reject** to an in-memory `DiffGridResult`: drop every unreviewed field edit
 * (leaving already-approved edits in the unpublished set), or restore a needs-review deletion to
 * unchanged. Returns the input unchanged for a newly-added row — rejecting it removes the record, a
 * structural change the background refresh reconciles.
 */
export function applyRejectedRecordChangeToFolderDiffData(result: DiffGridResult, filename: string): DiffGridResult {
  const prevRow = result.rows.find((r) => r.__filename === filename);
  if (!prevRow) return result;

  let nextRow: DiffRow;
  if (prevRow.__rowStatus === 'added' || prevRow.__rowStatus === 'addedUnpublished') {
    return result;
  } else if (prevRow.__rowStatus === 'deleted') {
    nextRow = { ...prevRow, __rowStatus: 'unchanged', __changedFields: [], __fromFields: {} };
  } else {
    if (prevRow.__changedFields.length === 0) return result;
    const nextFromFields = { ...prevRow.__fromFields };
    for (const field of prevRow.__changedFields) delete nextFromFields[field];
    nextRow = { ...prevRow, __changedFields: [], __fromFields: nextFromFields };
    nextRow.__rowStatus = deriveRowStatusAfterEdit(nextRow);
  }

  return replaceRowInResult(result, prevRow, nextRow);
}

/**
 * Apply a whole-record **discard** to an in-memory `DiffGridResult`: reset both the unreviewed and
 * approved edits so the row returns to the published baseline (`unchanged`). Only valid for a
 * modified/unpublished row (discard is hidden for added/deleted); returns the input unchanged otherwise.
 */
export function applyDiscardedRecordChangeToFolderDiffData(result: DiffGridResult, filename: string): DiffGridResult {
  const prevRow = result.rows.find((r) => r.__filename === filename);
  if (!prevRow) return result;

  if (
    prevRow.__rowStatus === 'added' ||
    prevRow.__rowStatus === 'addedUnpublished' ||
    prevRow.__rowStatus === 'deleted' ||
    prevRow.__rowStatus === 'deletedUnpublished' ||
    prevRow.__rowStatus === 'invalidJson' ||
    prevRow.__rowStatus === 'baselineUnavailable'
  ) {
    return result;
  }

  const nextRow: DiffRow = {
    ...prevRow,
    __rowStatus: 'unchanged',
    __changedFields: [],
    __fromFields: {},
    __unpublishedFields: [],
  };

  return replaceRowInResult(result, prevRow, nextRow);
}
