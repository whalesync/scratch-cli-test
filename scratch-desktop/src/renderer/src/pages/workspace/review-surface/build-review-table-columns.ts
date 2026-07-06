import type { GridColumn } from '@glideapps/glide-data-grid';
import type { TableView, TableViewCol } from '@spinner/shared-types';
import {
  createFallbackTableViewFromColumnDefinitions,
  flattenTableViewColumns,
} from '../../../../../shared/schema-columns';
import type { DiffGridResult } from '../diff-grid-types';
import { resolveEffectivePath, resolveEffectiveType } from '../grid-cell-diff-state';

/**
 * Pure column-model builder for `ReviewTableGrid`: turns a `TableView` (+ the diff data and the
 * user's persisted column widths) into glide `GridColumn[]` and the label/effective-path maps
 * the drawer consumes. Reuses `resolveEffective*` from `grid-cell-diff-state` so both grids
 * agree on a column's effective path/type. No React — plain `.ts`.
 */

export const STATUS_COL_ID = '__status';
/** Holds the first-column change-type dot + optional validation-warning icon. */
export const STATUS_COL_WIDTH = 50;
/**
 * A column whose cells render an inline `del → ins` diff needs extra room (del + ins is wider
 * than a single value); widen its default width by this factor. An explicit user resize wins.
 */
export const DIFF_COLUMN_WIDTH_MULTIPLIER = 1.6;

/**
 * Upper bound a user can drag a column to. Glide's own default (500px) is too cramped for wide
 * content like Webflow HTML fields; raise it while keeping a sane ceiling against runaway drags.
 */
export const MAX_RESIZABLE_COLUMN_WIDTH = 2000;

/** Glide grid accent — the yellow highlight design tokens (same as the v1 grid). */
export const GRID_THEME = {
  accentColor: '#D4C800', // highlight border
  accentFg: '#000000', // highlight text
  accentLight: '#FEFB8A', // highlight fill
};

const STATUS_COLUMN: GridColumn = {
  id: STATUS_COL_ID,
  title: '',
  width: STATUS_COL_WIDTH,
  hasMenu: false,
  themeOverride: { borderColor: 'transparent' },
};

export interface ReviewTableColumnModel {
  columns: GridColumn[];
  columnLabels: Map<string, string>;
  columnEffectivePaths: Map<string, string>;
  /** path -> the flattened `TableViewCol`, for the grid's cell diff-state / effective-path lookups. */
  viewColMap: Map<string, TableViewCol>;
  titleColumnId: string | null;
}

/**
 * Build the review grid's columns. The first column is always the status pill column; the rest
 * come from the view's non-hidden columns, further narrowed to `visibleColumnIds` when the column
 * picker (or the "just changed columns" default) has a selection — `null` shows every non-hidden
 * column. The title column is always kept (it anchors the frozen first data column). Columns that
 * carry a diff (per `focusColumnIds` or any row's changed/unpublished fields, matched on the
 * effective path) are widened; a user's persisted `columnWidths[path]` always overrides the width.
 */
export function buildReviewTableColumns(
  tableView: TableView | null,
  diffData: DiffGridResult,
  columnWidths: Record<string, number>,
  visibleColumnIds: string[] | null,
): ReviewTableColumnModel {
  let flatCols = tableView ? flattenTableViewColumns(tableView) : [];
  if (flatCols.length === 0) {
    // No view on disk (or an empty one): synthesize columns from the diff's column definitions.
    flatCols = flattenTableViewColumns(createFallbackTableViewFromColumnDefinitions(diffData.columns));
  }
  const titleColumnId = flatCols[0]?.path ?? null;
  const nonHiddenCols = flatCols.filter((col) => !col.hidden);
  const visibleCols =
    visibleColumnIds === null
      ? nonHiddenCols
      : (() => {
          const visibleColumnIdSet = new Set(visibleColumnIds);
          return nonHiddenCols.filter((col) => col.path === titleColumnId || visibleColumnIdSet.has(col.path));
        })();

  const columnLabels = new Map<string, string>();
  const columnEffectivePaths = new Map<string, string>();
  const viewColMap = new Map<string, TableViewCol>();
  for (const col of visibleCols) {
    columnLabels.set(col.path, col.name ?? col.path);
    columnEffectivePaths.set(col.path, resolveEffectivePath(col.path, col));
    viewColMap.set(col.path, col);
  }

  // The set of leaf paths carrying an unreviewed/unpublished diff, unioned from the server's
  // focus hints and every loaded row's changed/unpublished fields.
  const diffCarryingFieldPaths = new Set<string>([
    ...diffData.focusColumnIds.unreviewed,
    ...diffData.focusColumnIds.unpublished,
  ]);
  for (const row of diffData.rows) {
    for (const field of row.__changedFields) diffCarryingFieldPaths.add(field);
    for (const field of row.__unpublishedFields) diffCarryingFieldPaths.add(field);
  }
  const diffCarryingColumnIdSet = new Set<string>();
  for (const col of visibleCols) {
    if (diffCarryingFieldPaths.has(col.path) || diffCarryingFieldPaths.has(resolveEffectivePath(col.path, col))) {
      diffCarryingColumnIdSet.add(col.path);
    }
  }

  const dataColumns: GridColumn[] = visibleCols.map((col) => {
    const displayName = col.name ?? col.path;
    const isTitle = col.path === titleColumnId;
    const baseWidth = Math.max(120, Math.min(250, displayName.length * 9 + 40));
    const typedWidth = isTitle
      ? baseWidth * 2
      : resolveEffectiveType(col) === 'date'
        ? Math.round(baseWidth * 1.3) + 30
        : baseWidth;
    const defaultWidth = diffCarryingColumnIdSet.has(col.path)
      ? Math.round(typedWidth * DIFF_COLUMN_WIDTH_MULTIPLIER)
      : typedWidth;
    return {
      id: col.path,
      title: displayName,
      width: columnWidths[col.path] ?? defaultWidth,
      hasMenu: false,
    };
  });

  return { columns: [STATUS_COLUMN, ...dataColumns], columnLabels, columnEffectivePaths, viewColMap, titleColumnId };
}
