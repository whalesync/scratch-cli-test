import { setByPath } from '../../../../shared/schema-columns';
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
  | 'invalidJson';

export interface DiffRow {
  [key: string]: unknown;
  __rowStatus: RowStatus;
  __changedFields: string[];
  __fromFields: Record<string, unknown>;
  __unpublishedFields: string[];
  __masterFields: Record<string, unknown>;
  __filename: string;
  __parseError?: string;
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
  filterCounts: { unreviewed: number; unpublished: number; errors: number };
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
    row.__rowStatus === 'invalidJson'
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
    prevRow.__changedFields.length > 0;
  const nextHasUnreviewed =
    nextRow.__rowStatus === 'added' ||
    nextRow.__rowStatus === 'deleted' ||
    nextRow.__rowStatus === 'invalidJson' ||
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
