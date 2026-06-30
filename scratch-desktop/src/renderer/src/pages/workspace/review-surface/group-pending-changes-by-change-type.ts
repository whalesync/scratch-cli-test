/**
 * Change-type grouping selector — Phase 0 foundation for review surface v2 (DEV-10617).
 *
 * A pure function that buckets the pending changes in a folder's already-loaded
 * diff rows into `{ field-modified (per column), created, deleted }` with counts.
 * It is the single data backbone the Phase 2 By-type view and the Phase 5 filter
 * chips both consume — no server call, no IPC; it runs over data the renderer
 * already holds (`DiffGridResult.rows` / `.columns` in `FolderDataGrid`).
 *
 * SCOPE — page-agnostic, not whole-folder. The selector is correct over whatever
 * rows it is handed. In `FolderDataGrid` today `diffData.rows` is only the
 * CURRENT PAGE (a `PAGE_SIZE` window), so calling it over `diffData.rows` yields
 * PAGE-scoped counts, not whole-folder counts. Computing whole-folder per-type
 * counts (loading the full changed set, or reusing a server-side aggregate) is a
 * Phase 2 decision; this function deliberately does not reach for more data. The
 * returned `scannedRowCount` lets a caller assert the scope it ran over.
 *
 * REVIEW STATE — unreviewed only (for now). This version counts only UNREVIEWED
 * changes (the ones that still need review): per-column field edits from
 * `__changedFields`, plus row-level `added` / `deleted` / `invalidJson`. The
 * approved-but-unpublished state (`__unpublishedFields`, the `*Unpublished` row
 * statuses) is intentionally ignored. Adding an `approvedCount` later is additive
 * — extend `PendingChangeRow` with `__unpublishedFields` and add the count fields
 * — and does not reshape the existing output.
 */

/**
 * The diff-row status union. This mirrors the `RowStatus` declared inline (and
 * un-exported) in `FolderDataGrid.tsx`; keep the two in sync. It is duplicated
 * here deliberately so this selector has no dependency on the grid component —
 * a `DiffRow` satisfies {@link PendingChangeRow} structurally, so callers pass
 * `diffData.rows` directly without any export/refactor of the grid's types.
 */
export type ChangeRowStatus =
  | 'added'
  | 'addedUnpublished'
  | 'modified'
  | 'unpublished'
  | 'deleted'
  | 'deletedUnpublished'
  | 'unchanged'
  | 'invalidJson';

/**
 * The structural subset of `FolderDataGrid`'s `DiffRow` that this selector reads.
 * `DiffRow[]` satisfies `readonly PendingChangeRow[]` via structural typing.
 */
export interface PendingChangeRow {
  __rowStatus: ChangeRowStatus;
  /** Leaf dot-path field keys where the working copy differs from the approved version (unreviewed edits). */
  __changedFields: string[];
  __filename: string;
}

/**
 * The structural subset of `ColumnDefinition` (`shared/schema-columns/types.ts`)
 * used for per-column bucketing and display enrichment. A `ColumnDefinition`
 * satisfies this structurally.
 */
export interface PendingChangeColumn {
  id: string;
  displayName: string;
}

/** One per-column "field-modified" bucket. */
export interface ColumnFieldChangeGroup {
  /** The column's id (a leaf dot-path), matched against rows' `__changedFields`. */
  columnId: string;
  /** The column's human label, copied from the matched column. */
  columnDisplayName: string;
  /** How many unreviewed field edits target this column across the scanned rows (per field-occurrence). */
  unreviewedFieldEditCount: number;
}

/** The full grouping result. */
export interface PendingChangeTypeGrouping {
  /**
   * Per-column field-modified buckets, in the input `columns` order (so it
   * mirrors the grid). Only columns with at least one unreviewed edit appear.
   */
  fieldModifiedByColumn: ColumnFieldChangeGroup[];
  /** Rows that are unreviewed creations (`__rowStatus === 'added'`). */
  createdRecordCount: number;
  /** Rows that are unreviewed deletions (`__rowStatus === 'deleted'`). */
  deletedRecordCount: number;
  /** Rows that could not be parsed (`__rowStatus === 'invalidJson'`); they have no field-level detail. */
  invalidJsonRecordCount: number;
  /**
   * Changed-field keys that matched no known column, de-duplicated. Surfaced
   * rather than silently dropped (a changed field with no column is a normal
   * transient during a pull, when working edits run ahead of a re-pulled
   * schema) so a caller can log/telemeter it. Empty in the happy path.
   */
  unmatchedFieldKeys: string[];
  /** Total rows scanned (`=== rows.length`); lets a caller assert the scope it computed over. */
  scannedRowCount: number;
}

/**
 * Bucket a folder's already-loaded diff rows by change type. Pure: no I/O, does
 * not mutate its inputs. See the module doc-comment for scope and review-state
 * semantics.
 */
export function groupPendingChangesByChangeType(
  rows: readonly PendingChangeRow[],
  columns: readonly PendingChangeColumn[],
): PendingChangeTypeGrouping {
  const columnById = new Map<string, PendingChangeColumn>();
  for (const column of columns) {
    columnById.set(column.id, column);
  }

  const unreviewedFieldEditCountByColumnId = new Map<string, number>();
  const unmatchedFieldKeySet = new Set<string>();
  let createdRecordCount = 0;
  let deletedRecordCount = 0;
  let invalidJsonRecordCount = 0;

  for (const row of rows) {
    // Row-level change type, driven by status. Other statuses (modified,
    // unchanged, and every approved-but-unpublished status) contribute no
    // row-level counter in this unreviewed-only version.
    switch (row.__rowStatus) {
      case 'added':
        createdRecordCount += 1;
        break;
      case 'deleted':
        deletedRecordCount += 1;
        break;
      case 'invalidJson':
        invalidJsonRecordCount += 1;
        break;
      default:
        break;
    }

    // Per-column field edits, regardless of status. `__changedFields` holds the
    // unreviewed edits for any row (e.g. an `addedUnpublished` record carrying
    // fresh local edits contributes here while its creation stays approved and
    // so is NOT counted as a new `created` record).
    for (const changedFieldKey of row.__changedFields) {
      if (columnById.has(changedFieldKey)) {
        unreviewedFieldEditCountByColumnId.set(
          changedFieldKey,
          (unreviewedFieldEditCountByColumnId.get(changedFieldKey) ?? 0) + 1,
        );
      } else {
        unmatchedFieldKeySet.add(changedFieldKey);
      }
    }
  }

  // Emit per-column buckets in input-column order (grid-matching, stable), only
  // for columns that accumulated at least one edit.
  const fieldModifiedByColumn: ColumnFieldChangeGroup[] = [];
  for (const column of columns) {
    const unreviewedFieldEditCount = unreviewedFieldEditCountByColumnId.get(column.id) ?? 0;
    if (unreviewedFieldEditCount > 0) {
      fieldModifiedByColumn.push({
        columnId: column.id,
        columnDisplayName: column.displayName,
        unreviewedFieldEditCount,
      });
    }
  }

  return {
    fieldModifiedByColumn,
    createdRecordCount,
    deletedRecordCount,
    invalidJsonRecordCount,
    unmatchedFieldKeys: Array.from(unmatchedFieldKeySet),
    scannedRowCount: rows.length,
  };
}
