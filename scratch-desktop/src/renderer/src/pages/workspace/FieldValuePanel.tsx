import { Box, Group, Stack } from '@mantine/core';
import type { TableViewCol } from '@spinner/shared-types';
import { Eye } from 'lucide-react';
import { memo } from 'react';
import { FieldReviewActions, ReviewActionIcon } from './diff-renderers';
import { FieldCellValue } from './field-cell-renderer';
import {
  DIFF_REMOVED_BG,
  DIFF_REMOVED_FG,
  getAddedBg,
  type FieldValueDiffKind,
  type FieldValueDisplayMode,
} from './field-value-types';

// Re-export types for backward compatibility with FolderDataGrid / unified-diff-cell imports.
export type { FieldValueDiffKind, FieldValueDiffViewMode, FieldValueDisplayMode } from './field-value-types';

interface FieldValuePanelProps {
  value: string;
  fromValue?: string;
  diffKind: FieldValueDiffKind;
  displayMode?: FieldValueDisplayMode;
  onClick?: () => void;
  onApprove?: () => void;
  onUndo?: () => void;
  /** When set, render a "View" action above Approve (used to open the record detail view). */
  onView?: () => void;
  /** Column view metadata (readonly state, property type) from the view definition. */
  column?: Pick<TableViewCol, 'readonly' | 'type'>;
  /** When true, before/after values render on a single line, truncated to TRUNCATED_MAX_CHARS. */
  truncate?: boolean;
}

const TRUNCATED_MAX_CHARS = 50;
const MAX_CONTENT_HEIGHT = 'calc(1.5em * 5 + 12px)';

/** Collapse whitespace and cap length so the value fits on one line of the popover. */
function truncateOneLine(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > TRUNCATED_MAX_CHARS ? `${normalized.slice(0, TRUNCATED_MAX_CHARS)}...` : normalized;
}

export const FieldValuePanel = memo(function FieldValuePanel({
  value,
  fromValue = '',
  diffKind,
  displayMode = diffKind === 'unreviewed' ? 'diff' : 'current',
  onClick,
  onApprove,
  onUndo,
  onView,
  column,
  truncate = false,
}: FieldValuePanelProps) {
  const hasActions = Boolean(onApprove || onUndo || onView);
  const actionCount = (onApprove ? 1 : 0) + (onUndo ? 1 : 0) + (onView ? 1 : 0);
  const renderedFromValue = truncate ? truncateOneLine(fromValue) : fromValue;
  const renderedValue = truncate ? truncateOneLine(value) : value;
  const lineWrapStyle: React.CSSProperties = truncate
    ? { whiteSpace: 'nowrap', overflow: 'hidden' }
    : { whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

  return (
    <Group align="stretch" gap={8} wrap="nowrap">
      <Box
        style={{ flex: 1, minWidth: 0 }}
        onClick={onClick}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick();
                }
              }
            : undefined
        }
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
      >
        <Box
          style={{
            backgroundColor: 'var(--bg-base)',
            borderRadius: 0,
            overflow: 'hidden',
            cursor: onClick ? 'text' : 'default',
          }}
        >
          {displayMode === 'diff' ? (
            <Box style={truncate ? undefined : { maxHeight: MAX_CONTENT_HEIGHT, overflowY: 'auto' }}>
              <Box
                style={{
                  padding: '6px 12px 2px',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  lineHeight: 1.5,
                  ...(truncate ? { overflow: 'hidden' } : {}),
                }}
              >
                <span
                  style={{
                    ...lineWrapStyle,
                    color: DIFF_REMOVED_FG,
                    textDecoration: 'line-through',
                    backgroundColor: DIFF_REMOVED_BG,
                    boxDecorationBreak: 'clone',
                    WebkitBoxDecorationBreak: 'clone',
                    padding: '0 2px',
                  }}
                >
                  {renderedFromValue}
                </span>
              </Box>
              <Box
                style={{
                  padding: '2px 12px 8px',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  lineHeight: 1.5,
                  ...(truncate ? { overflow: 'hidden' } : {}),
                }}
              >
                <span
                  style={{
                    ...lineWrapStyle,
                    backgroundColor: getAddedBg(diffKind),
                    color: 'var(--modified-needs-review-stroke)',
                    boxDecorationBreak: 'clone',
                    WebkitBoxDecorationBreak: 'clone',
                    padding: '0 2px',
                  }}
                >
                  {renderedValue}
                </span>
              </Box>
            </Box>
          ) : (
            <FieldCellValue value={value} column={column} truncate={truncate} muted={column?.readonly ?? false} />
          )}
        </Box>
      </Box>

      {hasActions && (
        <Stack
          gap={6}
          align="flex-end"
          justify={actionCount > 1 ? 'flex-start' : 'center'}
          style={{ flexShrink: 0, padding: '2px 4px 2px 0' }}
        >
          <FieldReviewActions diffKind={diffKind} onApprove={onApprove} onUndo={onUndo} />
          {onView && <ReviewActionIcon label="View change" onClick={onView} tone="secondary" icon={Eye} />}
        </Stack>
      )}
    </Group>
  );
});
