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
