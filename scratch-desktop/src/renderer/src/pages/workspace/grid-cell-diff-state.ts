import { GridCellKind, type EditableGridCell } from '@glideapps/glide-data-grid';
import type { TablePropertyType, TableViewCol } from '@spinner/shared-types';
import { classifyFieldChange, type FieldChangeClassification } from '../../../../shared/field-change-classification';
import { getByPath } from '../../../../shared/schema-columns';
import type { DiffRow } from './diff-grid-types';
import { resolveCellFailedError } from './failed-fields';
import type { FieldValueDiffKind } from './field-value-types';
import { toDisplayString } from './record-diff-helpers';

/**
 * The single, connector-agnostic definition of "is this cell changed, and what is its
 * before-value" — plus the cell-editability predicates and the value/kind formatters both
 * grids' cell renderers need. Extracted verbatim from `FolderDataGrid` (zero behavior
 * change) so `ReviewTableGrid` classifies cells identically; the two grids must never differ
 * in what counts as a change. Plain `.ts` module (no component export) per
 * `react-refresh/only-export-components`.
 */

export interface CellDiffState {
  diffKind: FieldValueDiffKind;
  fromValue: string;
  /** Populated only when diffKind !== null. */
  classification: FieldChangeClassification | null;
  /**
   * DEV-10048: the connector's rejection message when a prior publish failed for
   * this field (or record-level error on a failed record). Drives the per-field
   * "failed to publish" warning. Undefined when the field has no failed-publish detail.
   */
  failedError?: string;
}

export function getCellDiffState(row: DiffRow, fieldName: string, viewCol: TableViewCol | undefined): CellDiffState {
  // Row-level statuses (added, deleted, invalidJson) are styled at the row level — don't
  // overlay per-cell diff colours on top. Exception: an approved create ('addedUnpublished')
  // with edited fields should still show per-cell diffs for those edits.
  if (
    row.__rowStatus === 'added' ||
    (row.__rowStatus === 'addedUnpublished' && row.__changedFields.length === 0) ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'deletedUnpublished' ||
    row.__rowStatus === 'invalidJson'
  ) {
    return { diffKind: null, fromValue: '', classification: null };
  }
  // __changedFields / __unpublishedFields contain leaf-level paths (e.g. "title.raw").
  // When the column has a selected subfield, check the effective path too.
  const effectivePath = resolveEffectivePath(fieldName, viewCol);
  const isUnreviewed =
    row.__changedFields.includes(fieldName) ||
    (effectivePath !== fieldName && row.__changedFields.includes(effectivePath));
  const isUnpublished =
    !isUnreviewed &&
    (row.__unpublishedFields.includes(fieldName) ||
      (effectivePath !== fieldName && row.__unpublishedFields.includes(effectivePath)));
  // Use the path that actually appears in the diff arrays for value lookups.
  const diffKey = row.__changedFields.includes(effectivePath)
    ? effectivePath
    : row.__unpublishedFields.includes(effectivePath)
      ? effectivePath
      : fieldName;
  // DEV-10048: a prior publish rejected this record. A per-field message (from
  // failed-patches.json's fieldErrors) takes precedence; otherwise the record-level
  // error applies to whichever field the user is re-editing on this failed record.
  const failedError = resolveCellFailedError({
    failedFields: row.__failedFields,
    recordError: row.__failedError,
    effectivePath,
    fieldName,
    hasDiff: isUnreviewed || isUnpublished,
  });
  if (isUnreviewed) {
    const rawFrom = row.__fromFields[diffKey];
    return {
      diffKind: 'unreviewed',
      fromValue: toDisplayString(rawFrom),
      classification: classifyFieldChange(rawFrom, getByPath(row.__raw, effectivePath), viewCol),
      failedError,
    };
  }
  if (isUnpublished) {
    const rawFrom = row.__masterFields[diffKey];
    return {
      diffKind: 'unpublished',
      fromValue: toDisplayString(rawFrom),
      classification: classifyFieldChange(rawFrom, getByPath(row.__raw, effectivePath), viewCol),
      failedError,
    };
  }
  return { diffKind: null, fromValue: '', classification: null, failedError };
}

/** When a subfield is selected on a view column, returns the full dot-path to the subfield; otherwise the root colId. */
export function resolveEffectivePath(colId: string, viewCol: TableViewCol | undefined): string {
  if (viewCol?.selectedSubfield != null && viewCol.subfields?.[viewCol.selectedSubfield]) {
    return `${colId}.${viewCol.subfields[viewCol.selectedSubfield].relativePath}`;
  }
  return colId;
}

/** Returns true if the column (or the currently selected subfield) is readonly. */
export function isColumnReadonly(viewCol: TableViewCol | undefined): boolean {
  if (viewCol?.readonly) return true;
  if (viewCol?.selectedSubfield != null && viewCol.subfields?.[viewCol.selectedSubfield]) {
    return viewCol.subfields[viewCol.selectedSubfield].readonly === true;
  }
  return false;
}

/** Returns true if the column (or the active subfield) is write-once (editable only on new records). */
export function isColumnWriteOnce(viewCol: TableViewCol | undefined): boolean {
  if (viewCol?.writeOnce) return true;
  if (viewCol?.selectedSubfield != null && viewCol.subfields?.[viewCol.selectedSubfield]) {
    return viewCol.subfields[viewCol.selectedSubfield].writeOnce === true;
  }
  return false;
}

/** A row is "new" when it has no published master (created locally, not yet published). */
export function isNewRecordRow(row: DiffRow | undefined): boolean {
  return row?.__rowStatus === 'added' || row?.__rowStatus === 'addedUnpublished';
}

/**
 * Effective cell editability. A readonly column is never editable; a write-once
 * column is editable only while the record is new (no published master) and
 * locks once it exists remotely. See X_SCRATCH_WRITE_ONCE.
 */
export function isCellReadonly(viewCol: TableViewCol | undefined, row: DiffRow | undefined): boolean {
  return isColumnReadonly(viewCol) || (isColumnWriteOnce(viewCol) && !isNewRecordRow(row));
}

/** Returns the effective TablePropertyType, preferring the active subfield's type when one is selected. */
export function resolveEffectiveType(viewCol: TableViewCol | undefined): TablePropertyType | undefined {
  if (viewCol?.selectedSubfield != null && viewCol.subfields?.[viewCol.selectedSubfield]) {
    return viewCol.subfields[viewCol.selectedSubfield].type ?? viewCol.type;
  }
  return viewCol?.type;
}

/** Maps a value + optional declared property type to the glide cell kind used to render it. */
export function inferCellKind(value: unknown, propertyType?: TablePropertyType): GridCellKind {
  if (propertyType === 'checkbox') return GridCellKind.Boolean;
  if (propertyType === 'number') return GridCellKind.Number;
  if (propertyType === 'url') return GridCellKind.Uri;
  // Fall back to runtime type detection when view type is unset or generic
  if (propertyType == null || propertyType === 'string' || propertyType === 'object') {
    if (typeof value === 'boolean') return GridCellKind.Boolean;
    if (typeof value === 'number') return GridCellKind.Number;
  }
  return GridCellKind.Text;
}

/** Extracts the raw string a glide overlay editor committed, across the editable cell kinds. */
export function editableCellToString(cell: EditableGridCell): string {
  switch (cell.kind) {
    case GridCellKind.Text:
    case GridCellKind.Markdown:
    case GridCellKind.Uri:
      return cell.data;
    case GridCellKind.Number:
      return cell.data == null ? '' : String(cell.data);
    case GridCellKind.Boolean:
      return cell.data == null ? '' : String(cell.data);
    default:
      return '';
  }
}

/**
 * Format a foreign-key (reference) cell for display: swap each referenced id for
 * the linked record's name when known, joining multi-references with commas
 * (DEV-10530). `labels` maps a raw id string -> name; ids absent from it fall
 * back to the raw id. The raw value is still used for `data`/`copyData`, so
 * editing and copy operate on the verbatim id.
 */
export function formatReferenceDisplay(value: unknown, labels: Record<string, string>): string {
  const labelForId = (id: string): string => labels[id] ?? id;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return labelForId(entry);
        if (typeof entry === 'number') return labelForId(String(entry));
        return toDisplayString(entry);
      })
      .join(', ');
  }
  if (typeof value === 'string') return labelForId(value);
  if (typeof value === 'number') return labelForId(String(value));
  return toDisplayString(value);
}
