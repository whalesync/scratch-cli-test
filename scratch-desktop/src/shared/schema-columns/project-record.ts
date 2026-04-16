import { formatCellForGrid } from './format-cell';
import type { ColumnDefinition, NormalizedRecordRow } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks a dot-separated column id against a record JSON, returning the raw value or `undefined`
 * when any segment is missing or non-object. Arrays are leaves; we never index into them.
 */
function getByPath(source: Record<string, unknown>, id: string): unknown {
  const segments = id.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Projects a raw record file content into a normalized row keyed by column id, with both the
 * untouched raw value (for IPC/save paths) and a pre-formatted display string (for the grid).
 */
export function projectRecordToNormalizedRow(
  fileContent: Record<string, unknown>,
  columns: ColumnDefinition[],
  filename: string,
): NormalizedRecordRow {
  const raw: Record<string, unknown> = {};
  const display: Record<string, string> = {};

  for (const column of columns) {
    const value = getByPath(fileContent, column.id);
    raw[column.id] = value;
    display[column.id] = formatCellForGrid(value);
  }

  return { __filename: filename, raw, display };
}
