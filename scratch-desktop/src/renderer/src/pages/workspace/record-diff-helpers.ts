import { getByPath } from '../../../../shared/schema-columns';

/**
 * Shared, connector-agnostic helpers for reasoning about a record's three-state
 * diff (published / approved / local). Extracted from RecordDetailView so the new
 * RecordChangesDrawer can reuse the exact same predicates and types — keeping a
 * single source of truth for "what counts as an unapproved change". Lives in a
 * plain `.ts` module (not a `.tsx` that exports a component) so it can export
 * these freely without tripping `react-refresh/only-export-components`.
 */

export interface DiffRecordColumn {
  id: string;
  displayName: string;
  attributes: { readOnly: boolean; writeOnce?: boolean; required: boolean; nested: boolean };
}

export interface DiffRecordData {
  row: {
    __rowStatus:
      | 'added'
      | 'addedUnpublished'
      | 'modified'
      | 'unpublished'
      | 'deleted'
      | 'deletedUnpublished'
      | 'unchanged'
      | 'invalidJson';
    __changedFields: string[];
    __fromFields: Record<string, unknown>;
    __unpublishedFields: string[];
    __masterFields: Record<string, unknown>;
    __filename: string;
    __parseError?: string;
    __raw: Record<string, unknown>;
  };
  columns: DiffRecordColumn[];
  workingData: Record<string, unknown> | null;
  dirtyData: Record<string, unknown> | null;
  masterData: Record<string, unknown> | null;
  displayData: Record<string, unknown> | null;
}

export type DiffRow = DiffRecordData['row'];

export type DiffRowStatus = DiffRow['__rowStatus'];

/**
 * True when the row has changes the user has not yet approved — a newly added or
 * removed record awaiting review, an unparseable file, or any record with at least
 * one unreviewed field edit. This is the single predicate that defines which rows
 * open the review drawer and which records the drawer steps through.
 */
export function rowHasUnreviewedChanges(
  row:
    | {
        __rowStatus?: DiffRowStatus;
        __changedFields?: string[];
        [key: string]: unknown;
      }
    | null
    | undefined,
): boolean {
  if (!row) return false;
  return (
    row.__rowStatus === 'added' ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'invalidJson' ||
    (row.__changedFields?.length ?? 0) > 0
  );
}

export function getRecordName(row: Record<string, unknown>, titleColumnId: string | null): string {
  if (titleColumnId) {
    const raw = (row as { __raw?: Record<string, unknown> }).__raw;
    const val = raw ? getByPath(raw, titleColumnId) : undefined;
    if (typeof val === 'string' && val !== '') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  }
  // Fallback to filename
  const filename = row.__filename;
  if (typeof filename === 'string') return filename.replace(/\.json$/, '');
  return '';
}

export function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Structural value equality for diffing (deep-equal via stable JSON for objects/arrays). */
export function diffValuesEqual(a: unknown, b: unknown): boolean {
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

/** Recompute a record's row status after a single-field accept mutates its changed/unpublished sets. */
export function deriveRowStatusAfterEdit(row: DiffRow): DiffRowStatus {
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

/**
 * Writes a `.`-delimited field path into a nested object, creating intermediate plain objects as
 * needed. Mirrors setNestedValue in src/main/local-files.ts so optimistic updates to displayData
 * match what readDiffRecordData would see on disk.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const existing = cursor[key];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    } else {
      cursor = existing as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * Apply an accepted single-field edit to an open record's three-state diff in memory: drop the
 * field from the unreviewed set, recompute whether it's now unpublished (differs from published),
 * re-derive the row status, and update the display value — so the drawer / detail view reflect the
 * accept before the async refetch lands. Shared by `RecordDetailView` and `RecordReviewDrawer`.
 */
export function applyAcceptedFieldChangeToOpenRecordData(
  prev: DiffRecordData,
  fieldName: string,
  nextValue: unknown,
): DiffRecordData {
  const prevRow = prev.row;

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

  const nextRow: DiffRow = {
    ...prevRow,
    [fieldName]: nextValue,
    __changedFields: prevRow.__changedFields.filter((f) => f !== fieldName),
    __fromFields: nextFromFields,
    __unpublishedFields: nextUnpublishedFields,
  };
  nextRow.__rowStatus = deriveRowStatusAfterEdit(nextRow);

  const nextDisplayData = prev.displayData ? { ...prev.displayData } : {};
  setNestedValue(nextDisplayData, fieldName, nextValue);

  return { ...prev, row: nextRow, displayData: nextDisplayData };
}
