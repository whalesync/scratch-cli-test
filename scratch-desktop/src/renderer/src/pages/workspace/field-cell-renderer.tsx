import { Box } from '@mantine/core';
import type { TableViewCol } from '@spinner/shared-types';
import { memo } from 'react';
import { formatCellText } from './field-formatters';
import { DIFF_TEXT_STYLE } from './field-value-types';

const TRUNCATED_MAX_CHARS = 50;

/** Collapse whitespace and cap length so the value fits on one line. */
function truncateOneLine(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > TRUNCATED_MAX_CHARS ? `${normalized.slice(0, TRUNCATED_MAX_CHARS)}...` : normalized;
}

interface FieldCellValueProps {
  value: string;
  column?: Pick<TableViewCol, 'readonly' | 'type'>;
  truncate?: boolean;
  /** When true, render with muted/readonly text color. */
  muted?: boolean;
}

export const FieldCellValue = memo(function FieldCellValue({
  value,
  column,
  truncate = false,
  muted = false,
}: FieldCellValueProps) {
  const fieldType = column?.type;
  const formatted = truncate ? truncateOneLine(value) : formatCellText(value, fieldType);
  const textColor = muted ? 'var(--fg-muted)' : 'var(--fg-primary)';

  if (!formatted) {
    return <Box style={{ padding: '8px 12px', ...DIFF_TEXT_STYLE, color: 'var(--fg-muted)' }}>{'\u2014'}</Box>;
  }

  return (
    <Box
      style={{
        padding: '8px 12px',
        ...DIFF_TEXT_STYLE,
        color: textColor,
        ...(truncate ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
      }}
    >
      {formatted}
    </Box>
  );
});
