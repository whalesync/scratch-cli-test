import type { TablePropertyType, TableView, TableViewCol } from '@spinner/shared-types';
import { useMemo } from 'react';
import { flattenTableViewColumns } from '../../../../../shared/schema-columns';
import type { DiffGridResult } from '../diff-grid-types';
import { isColumnReadonly, resolveEffectivePath, resolveEffectiveType } from '../grid-cell-diff-state';

/**
 * The column metadata `RecordDetailView` (and the By-type group model) needs, derived from the
 * folder's `TableView` and the current diff grid. A verbatim lift of `FolderDataGrid`'s column
 * memos so `FolderReviewSurface` can house the same deep-edit overlay flag-on without touching the
 * legacy grid (which keeps its own copies until the Phase 8 deletion). Everything here is display
 * metadata; nothing reshapes a record's own data (Connector Prime Directive).
 */
export interface ReviewDetailColumnMetadata {
  /** Flattened view columns (banner groups expanded), in view order. */
  flatViewColumns: TableViewCol[];
  /** The first view column's path — the record's title column (null when the view has no columns). */
  titleColumnId: string | null;
  /** Field display order for `RecordDetailView`: all non-hidden view columns, in view order. */
  columnOrder: string[];
  /** column path → display label (falls back to the raw field name at the call site when absent). */
  columnLabels: Map<string, string>;
  /** column path → description text, sourced from the diff grid's column definitions. */
  columnDescriptions: Map<string, string>;
  /** column path → resolved property type (e.g. 'checkbox', 'number'), subfield-aware. */
  columnTypes: Map<string, TablePropertyType>;
  /** Set of read-only field paths, per the view (subfield-aware). */
  readonlyFields: Set<string>;
  /** column path → subfield-aware effective path; sparse (only non-identity entries are stored). */
  columnEffectivePaths: Map<string, string>;
  /** column path → banner-group name, for grouped columns only. */
  columnGroups: Map<string, string>;
  /** Every view column path (visible + hidden). */
  allColumnPaths: Set<string>;
}

export function useReviewDetailColumnMetadata(
  tableView: TableView | null,
  diffData: DiffGridResult | null,
): ReviewDetailColumnMetadata {
  const flatViewColumns = useMemo<TableViewCol[]>(
    () => (tableView ? flattenTableViewColumns(tableView) : []),
    [tableView],
  );

  const titleColumnId = useMemo(() => flatViewColumns[0]?.path ?? null, [flatViewColumns]);

  const columnOrder = useMemo(
    () => flatViewColumns.filter((col) => !col.hidden).map((col) => col.path),
    [flatViewColumns],
  );

  const columnLabels = useMemo(() => {
    const labelByColumnPath = new Map<string, string>();
    for (const col of flatViewColumns) {
      if (col.name) labelByColumnPath.set(col.path, col.name);
    }
    return labelByColumnPath;
  }, [flatViewColumns]);

  const columnTypes = useMemo(() => {
    const typeByColumnPath = new Map<string, TablePropertyType>();
    for (const col of flatViewColumns) {
      const resolvedType = resolveEffectiveType(col);
      if (resolvedType) typeByColumnPath.set(col.path, resolvedType);
    }
    return typeByColumnPath;
  }, [flatViewColumns]);

  const readonlyFields = useMemo(() => {
    const readonlyColumnPaths = new Set<string>();
    for (const col of flatViewColumns) {
      if (isColumnReadonly(col)) readonlyColumnPaths.add(col.path);
    }
    return readonlyColumnPaths;
  }, [flatViewColumns]);

  const columnEffectivePaths = useMemo(() => {
    const effectivePathByColumnPath = new Map<string, string>();
    for (const col of flatViewColumns) {
      const effectivePath = resolveEffectivePath(col.path, col);
      if (effectivePath !== col.path) effectivePathByColumnPath.set(col.path, effectivePath);
    }
    return effectivePathByColumnPath;
  }, [flatViewColumns]);

  const columnGroups = useMemo(() => {
    const groupNameByColumnPath = new Map<string, string>();
    for (const item of tableView?.cols ?? []) {
      if (item.kind === 'banner-group') {
        for (const col of item.cols) groupNameByColumnPath.set(col.path, item.name);
      }
    }
    return groupNameByColumnPath;
  }, [tableView]);

  const allColumnPaths = useMemo(() => new Set(flatViewColumns.map((col) => col.path)), [flatViewColumns]);

  const columnDescriptions = useMemo(() => {
    const descriptionByColumnPath = new Map<string, string>();
    for (const col of diffData?.columns ?? []) {
      if (typeof col.description === 'string' && col.description.length > 0) {
        descriptionByColumnPath.set(col.id, col.description);
      }
    }
    return descriptionByColumnPath;
  }, [diffData?.columns]);

  return {
    flatViewColumns,
    titleColumnId,
    columnOrder,
    columnLabels,
    columnDescriptions,
    columnTypes,
    readonlyFields,
    columnEffectivePaths,
    columnGroups,
    allColumnPaths,
  };
}
