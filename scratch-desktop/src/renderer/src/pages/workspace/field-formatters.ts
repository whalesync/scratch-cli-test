/**
 * Shared display-time formatters for field values, keyed by column property type.
 * Used by both the grid view and the detail/focused-field views so formatting
 * stays consistent everywhere a field value is shown to the user.
 */

/** Format a numeric string with locale grouping (e.g. commas). Returns the original string if not a valid number. */
function formatNumber(text: string): string {
  if (text === '') return text;
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  return n.toLocaleString();
}

/** Format a date string with second-level precision. Returns the original string if not a valid date. */
function formatDate(text: string): string {
  if (text === '') return text;
  const d = new Date(text);
  if (isNaN(d.getTime())) return text;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Apply display-time formatting to a field value string based on the column's property type.
 * This is purely cosmetic — the underlying value is unchanged.
 */
export function formatFieldDisplay(value: string, fieldType: string | undefined): string {
  if (!fieldType) return value;
  switch (fieldType) {
    case 'number':
      return formatNumber(value);
    case 'date':
      return formatDate(value);
    default:
      return value;
  }
}

/**
 * Format a cell value for display, handling checkbox fields as plain text ("true" / "false")
 * and delegating everything else to `formatFieldDisplay`.
 */
export function formatCellText(value: string, fieldType: string | undefined): string {
  if (fieldType === 'checkbox') {
    return value === 'true' ? 'true' : 'false';
  }
  return formatFieldDisplay(value, fieldType);
}
