import {
  getMiddleCenterBias,
  GridCellKind,
  type GridCell,
  type Rectangle,
  type Theme,
} from '@glideapps/glide-data-grid';
import type { FieldChangeClassification } from '../../../../shared/field-change-classification';
import type { FieldValueDiffKind } from './field-value-types';

/**
 * Canvas drawing for experimental "Unified Diffs" in FolderDataGrid. Kept separate
 * from UnifiedDiffMode.tsx so that file can export only the toggle component (Fast Refresh).
 */

/** Default glide row height is 34; doubled for the unified diff layout. */
export const UNIFIED_DIFF_ROW_HEIGHT = 68;

const FIRST_LINE_MAX_CHARS = 80;
const REMOVED_COLOR = '#dc2626';

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function truncateFirstLine(text: string): string {
  const newlineIdx = text.indexOf('\n');
  const firstLine = newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
  const trimmed = firstLine.trim();
  if (trimmed.length > FIRST_LINE_MAX_CHARS) {
    return `${trimmed.slice(0, FIRST_LINE_MAX_CHARS)}…`;
  }
  return trimmed;
}

function readCellDisplayText(cell: GridCell): string {
  if ('displayData' in cell && typeof cell.displayData === 'string') {
    return cell.displayData;
  }
  if (cell.kind === GridCellKind.Boolean && typeof cell.data === 'boolean') {
    return cell.data ? 'true' : 'false';
  }
  if ('data' in cell) {
    const data: unknown = cell.data;
    if (typeof data === 'string') return data;
    if (typeof data === 'number' || typeof data === 'boolean') return String(data);
  }
  return '';
}

interface DrawUnifiedDiffCellArgs {
  ctx: CanvasRenderingContext2D;
  cell: GridCell;
  theme: Theme;
  rect: Rectangle;
}

interface DrawUnifiedDiffCellOptions {
  diffKind: FieldValueDiffKind;
  fromValue: string;
  /**
   * For diff cells: the formatted "after" value, computed by the caller using the same
   * conversion as `fromValue` (typically `toDisplayString(rawValue)` without a
   * propertyType, so dates/etc. render as raw strings — matching the popover).
   * Ignored for non-diff cells, which fall back to `cell.displayData`.
   */
  toValue?: string;
  classification: FieldChangeClassification | null;
}

export function drawUnifiedDiffCell(args: DrawUnifiedDiffCellArgs, options: DrawUnifiedDiffCellOptions): void {
  const { ctx, cell, rect, theme } = args;
  const { diffKind, fromValue, toValue, classification } = options;

  const padX = theme.cellHorizontalPadding ?? 8;
  const startX = rect.x + padX + 0.5;
  const fontFull = `${theme.baseFontStyle} ${theme.fontFamily}`;
  const halfHeight = rect.height / 2;
  const topCenterY = rect.y + halfHeight / 2;
  const bottomCenterY = rect.y + halfHeight + halfHeight / 2;

  ctx.save();
  ctx.font = fontFull;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Clip so over-long text never bleeds into adjacent cells.
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();

  const bias = getMiddleCenterBias(ctx, fontFull);

  if (diffKind === 'unreviewed') {
    const afterText = toValue ?? readCellDisplayText(cell);
    const truncate = classification?.fieldSize === 'M' || classification?.fieldSize === 'L';
    const fromText = truncate ? truncateFirstLine(fromValue) : fromValue;
    const toText = truncate ? truncateFirstLine(afterText) : afterText;

    // Top half: before value (red, strikethrough)
    ctx.fillStyle = REMOVED_COLOR;
    ctx.fillText(fromText, startX, topCenterY + bias);
    const fromWidth = Math.min(ctx.measureText(fromText).width, rect.width - padX * 2);
    ctx.strokeStyle = REMOVED_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, topCenterY + bias);
    ctx.lineTo(startX + fromWidth, topCenterY + bias);
    ctx.stroke();

    // Bottom half: after value (in the needs-review stroke color)
    const toColor = getCssVar('--modified-needs-review-stroke') || theme.textDark;
    ctx.fillStyle = toColor;
    ctx.fillText(toText, startX, bottomCenterY + bias);
  } else {
    // No needs-review change — render the current value in the bottom half only.
    // Approved (unpublished) cells fall through here so they aren't shown as a diff.
    // Use the cell's pre-formatted displayData so the rendering matches the normal
    // grid layout (e.g. dates show as "Jan 15, 2024", not as ISO strings).
    ctx.fillStyle = theme.textDark;
    ctx.fillText(readCellDisplayText(cell), startX, bottomCenterY + bias);
  }

  ctx.restore();
}
