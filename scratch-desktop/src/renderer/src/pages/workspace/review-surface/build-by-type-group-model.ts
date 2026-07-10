/**
 * By-type group MODEL builder — the membership-producing sibling of
 * {@link groupPendingChangesByChangeType} (the Phase 0 counts-only selector).
 *
 * Phase 2 of review surface v2 (DEV-10618). Where the Phase 0 selector answers
 * "how many unreviewed changes of each type are there", this builder answers
 * "WHICH records are in each change-type group, and what did each one change" —
 * everything the By-type grouped view needs to render its blocks and rows and to
 * scope the detail drawer's stepper to a group.
 *
 * It is pure and connector-agnostic: it reads only the already-loaded diff rows
 * (no IPC, no per-record fetch), so a group row's `from → to` redline comes
 * straight from the row's own `__fromFields` (the approved value) and `__raw`
 * (the working record) — the same two sources the grid and drawer already use.
 *
 * EFFECTIVE-PATH MATCHING (the load-bearing detail). The main process keys a
 * row's `__changedFields` / `__fromFields` by the view's flattened *effective
 * leaf path* — e.g. WordPress `title` drills to `title.raw`, Notion
 * `properties.Name` drills to `properties.Name.title` — NOT by the column's root
 * `id`. So a field group must match and read at the column's effective path
 * (`columnEffectivePaths.get(columnId) ?? columnId`), exactly as the grid's
 * cell-diff (`FolderDataGrid` `getCellDiffState`) and the drawer
 * (`RecordChangesDrawer`) already do. Matching on the raw `columnId` would
 * silently drop every subfield column's edits and render blank `from` values.
 */

import { getByPath } from '../../../../../shared/schema-columns';
import { getRecordName, toDisplayString } from '../record-diff-helpers';
import type { ChangeRowStatus } from './group-pending-changes-by-change-type';

/**
 * The structural subset of a loaded diff row this builder reads. A
 * `FolderDataGrid` `DiffRow` (i.e. `DiffRecordData['row']`) satisfies it via
 * structural typing, so callers pass `byTypeDiffData.rows` directly.
 */
export interface ByTypeSourceRow {
  // Index signature mirrors FolderDataGrid's `DiffRow`, so a `DiffRow` is assignable
  // here and a row is assignable to `Record<string, unknown>` (what `getRecordName` takes).
  [key: string]: unknown;
  __rowStatus: ChangeRowStatus;
  /** Unreviewed changed-field keys, as *effective leaf paths* (e.g. `title.raw`). */
  __changedFields: string[];
  /** Approved-side values keyed by the same effective leaf paths as `__changedFields`. */
  __fromFields: Record<string, unknown>;
  /** Approved-but-unpublished field keys (effective leaf paths), disjoint from `__changedFields` per record. */
  __unpublishedFields: string[];
  /** Published/master values keyed by effective leaf path — the "from" side for an approved field. */
  __masterFields: Record<string, unknown>;
  /** The full working record, read at an effective path to get the "to" value. */
  __raw: Record<string, unknown>;
  __filename: string;
}

/**
 * The structural subset of a `ColumnDefinition` used for per-column field groups.
 * A `ColumnDefinition` satisfies this structurally.
 */
export interface ByTypeSourceColumn {
  id: string;
  displayName: string;
}

/** Which kind of change a group represents. Drives the bulk-approve dispatch and the dot colour. */
export type ByTypeGroupKind = 'field' | 'created' | 'deleted' | 'invalidJson';

/** One renderable row inside a group block. */
export interface ByTypeGroupRowModel {
  /** Record filename (the drawer-scope key and the unit the row click opens). */
  filename: string;
  /** Human label for the record (title column value, falling back to filename). */
  recordName: string;
  /** Display of the approved-side value for this group's field; `''` for created/deleted/invalid. */
  fromDisplay: string;
  /** Display of the working-side value for this group's field; `''` for deleted/invalid. */
  toDisplay: string;
  /** The row's status, so the view can label created/deleted/invalid rows. */
  rowStatus: ChangeRowStatus;
  /**
   * True when this record's change to the group's field is already approved-but-unpublished
   * (working == approved, approved != published). Drives the green ✓ glyph and excludes the row
   * from the group's "Approve all N". Record-level created/deleted/invalid rows are always false.
   */
  approved: boolean;
}

/** One renderable group block (a modified column, or the New / Removed / Needs-attention bucket). */
export interface ByTypeGroupModel {
  kind: ByTypeGroupKind;
  /** The column id, present only for `kind === 'field'`. */
  columnId?: string;
  /** The effective leaf path passed to `accept-field` for a field group's bulk approve. */
  effectivePath?: string;
  /** Group header label (column display name, or "New" / "Removed" / "Needs attention"). */
  title: string;
  /** A CSS custom-property reference for the 8px header dot, e.g. `var(--modified-needs-review-stroke)`. */
  dotColorVar: string;
  /** Ordered filenames of the records in this group — the set the drawer steps through. */
  recordFilenames: string[];
  /** The renderable rows, same order as `recordFilenames`. */
  rows: ByTypeGroupRowModel[];
}

const MODIFIED_DOT_COLOR_VAR = 'var(--modified-needs-review-stroke)';
const CREATED_DOT_COLOR_VAR = 'var(--create-needs-review-stroke)';
const DELETED_DOT_COLOR_VAR = 'var(--delete-needs-review-stroke)';
/** Invalid-JSON records need attention but aren't a create/modify/delete — use a neutral muted dot. */
const INVALID_JSON_DOT_COLOR_VAR = 'var(--fg-muted)';

/**
 * Build the ordered list of renderable change-type groups from a folder's loaded
 * diff rows. Group order matches the design: each modified column (in the input
 * `columns` order, grid-matching), then New (created), then Removed (deleted),
 * then Needs attention (invalid JSON). Only groups with at least one member are
 * emitted. Pure: no I/O, does not mutate its inputs.
 */
export function buildByTypeGroupModel(
  rows: readonly ByTypeSourceRow[],
  columns: readonly ByTypeSourceColumn[],
  columnEffectivePaths: ReadonlyMap<string, string>,
  titleColumnId: string | null,
): ByTypeGroupModel[] {
  const groups: ByTypeGroupModel[] = [];

  // Field groups, one per column, in input-column order. A row belongs iff this column's effective
  // path is among its unreviewed changes (`__changedFields`) OR its approved-but-unpublished changes
  // (`__unpublishedFields`) — the two sets are disjoint per record. The "to" side is always the
  // working value; the "from" side is the approved value for an unreviewed change (`__fromFields`)
  // or the published value for an approved one (`__masterFields`).
  for (const column of columns) {
    const effectivePath = columnEffectivePaths.get(column.id) ?? column.id;
    const memberRows: ByTypeGroupRowModel[] = [];
    for (const row of rows) {
      const isUnreviewed = row.__changedFields.includes(effectivePath);
      const isApproved = !isUnreviewed && row.__unpublishedFields.includes(effectivePath);
      if (!isUnreviewed && !isApproved) continue;
      memberRows.push({
        filename: row.__filename,
        recordName: getRecordName(row, titleColumnId),
        fromDisplay: toDisplayString(isApproved ? row.__masterFields[effectivePath] : row.__fromFields[effectivePath]),
        toDisplay: toDisplayString(getByPath(row.__raw, effectivePath)),
        rowStatus: row.__rowStatus,
        approved: isApproved,
      });
    }
    if (memberRows.length === 0) continue;
    groups.push({
      kind: 'field',
      columnId: column.id,
      effectivePath,
      title: column.displayName,
      dotColorVar: MODIFIED_DOT_COLOR_VAR,
      recordFilenames: memberRows.map((memberRow) => memberRow.filename),
      rows: memberRows,
    });
  }

  // Row-level groups, keyed by status. These are record-level changes with no
  // single field to diff, so their rows carry only a name.
  const createdRows = buildRecordLevelRows(rows, 'added', titleColumnId);
  if (createdRows.length > 0) {
    groups.push(buildRecordLevelGroup('created', 'New', CREATED_DOT_COLOR_VAR, createdRows));
  }

  const deletedRows = buildRecordLevelRows(rows, 'deleted', titleColumnId);
  if (deletedRows.length > 0) {
    groups.push(buildRecordLevelGroup('deleted', 'Removed', DELETED_DOT_COLOR_VAR, deletedRows));
  }

  const invalidJsonRows = buildRecordLevelRows(rows, 'invalidJson', titleColumnId);
  if (invalidJsonRows.length > 0) {
    groups.push(buildRecordLevelGroup('invalidJson', 'Needs attention', INVALID_JSON_DOT_COLOR_VAR, invalidJsonRows));
  }

  return groups;
}

/**
 * A stable identity for a group, used as a React key and as the in-flight key for
 * its bulk-approve button. Field groups are keyed by column id (one block per
 * column); the record-level groups are unique by kind.
 */
export function byTypeGroupKey(group: ByTypeGroupModel): string {
  return group.kind === 'field' ? `field:${group.columnId}` : group.kind;
}

function buildRecordLevelRows(
  rows: readonly ByTypeSourceRow[],
  status: ChangeRowStatus,
  titleColumnId: string | null,
): ByTypeGroupRowModel[] {
  const matchingRows: ByTypeGroupRowModel[] = [];
  for (const row of rows) {
    if (row.__rowStatus !== status) continue;
    matchingRows.push({
      filename: row.__filename,
      recordName: getRecordName(row, titleColumnId),
      fromDisplay: '',
      toDisplay: '',
      rowStatus: row.__rowStatus,
      // Record-level created/deleted/invalid rows are always unreviewed in this view (their
      // approved-but-unpublished counterparts aren't grouped here — see DEV-10687 scope note).
      approved: false,
    });
  }
  return matchingRows;
}

function buildRecordLevelGroup(
  kind: Exclude<ByTypeGroupKind, 'field'>,
  title: string,
  dotColorVar: string,
  rows: ByTypeGroupRowModel[],
): ByTypeGroupModel {
  return {
    kind,
    title,
    dotColorVar,
    recordFilenames: rows.map((row) => row.filename),
    rows,
  };
}
