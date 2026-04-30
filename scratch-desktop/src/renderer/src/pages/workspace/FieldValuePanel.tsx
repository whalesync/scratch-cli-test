import { ActionIcon, Box, Group, Stack, Tooltip } from '@mantine/core';
import { Check, Eye, RotateCcw } from 'lucide-react';
import { memo } from 'react';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';

export type FieldValueDiffKind = 'unreviewed' | 'unpublished' | null;
export type FieldValueDisplayMode = 'diff' | 'current';

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
  /** When true, before/after values render on a single line, truncated to TRUNCATED_MAX_CHARS. */
  truncate?: boolean;
}

const TRUNCATED_MAX_CHARS = 50;

/** Collapse whitespace and cap length so the value fits on one line of the popover. */
function truncateOneLine(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > TRUNCATED_MAX_CHARS ? `${normalized.slice(0, TRUNCATED_MAX_CHARS)}...` : normalized;
}

const DIFF_WORKING_BG = 'var(--modified-needs-review-bg)';
const DIFF_UNPUBLISHED_BG = 'var(--modified-approved-bg)';
const DIFF_REMOVED_BG = '#fee2e2'; // red-100
const MAX_CONTENT_HEIGHT = 'calc(1.5em * 5 + 12px)';
const ACTION_BUTTON_SIZE = 24;

function IconActionButton({
  label,
  onClick,
  tone,
  icon,
}: {
  label: string;
  onClick: () => void;
  tone: 'approve' | 'undo' | 'secondary';
  icon: typeof Check;
}) {
  const styles =
    tone === 'approve'
      ? {
          backgroundColor: 'var(--mantine-color-green-1)',
          color: 'var(--mantine-color-green-8)',
          border: '1px solid var(--mantine-color-green-3)',
        }
      : tone === 'undo'
        ? {
            backgroundColor: 'var(--mantine-color-red-1)',
            color: 'var(--mantine-color-red-8)',
            border: '1px solid var(--mantine-color-red-3)',
          }
        : {
            backgroundColor: 'var(--bg-selected)',
            color: 'var(--fg-primary)',
            border: '1px solid var(--fg-divider)',
          };

  return (
    <Tooltip label={label} position="left" withArrow zIndex={10020}>
      <ActionIcon
        variant="transparent"
        size={ACTION_BUTTON_SIZE}
        radius={3}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        styles={{
          root: {
            ...styles,
            minWidth: ACTION_BUTTON_SIZE,
            minHeight: ACTION_BUTTON_SIZE,
            padding: 3,
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
            '&:hover': {
              filter: 'brightness(0.97)',
            },
          },
        }}
      >
        <span style={{ display: 'inline-flex', pointerEvents: 'none' }}>
          <StyledLucideIcon Icon={icon} size={14} strokeWidth={2.25} />
        </span>
      </ActionIcon>
    </Tooltip>
  );
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
                  fontSize: 12,
                  lineHeight: 1.45,
                  ...(truncate ? { overflow: 'hidden' } : {}),
                }}
              >
                <span
                  style={{
                    ...lineWrapStyle,
                    color: '#dc2626',
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
                    backgroundColor: diffKind === 'unreviewed' ? DIFF_WORKING_BG : DIFF_UNPUBLISHED_BG,
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
            <Box
              style={{
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: 13,
                lineHeight: 1.5,
                ...lineWrapStyle,
                color: 'var(--fg-primary)',
                ...(truncate ? {} : { maxHeight: MAX_CONTENT_HEIGHT, overflowY: 'auto' }),
              }}
            >
              {renderedValue}
            </Box>
          )}
        </Box>
      </Box>

      {hasActions && (
        <Stack
          gap={6}
          align="center"
          justify={actionCount === 1 ? 'center' : 'flex-start'}
          style={{ flexShrink: 0, width: ACTION_BUTTON_SIZE + 4, padding: '2px 0' }}
        >
          {onApprove && <IconActionButton label="Approve" onClick={onApprove} tone="approve" icon={Check} />}
          {onUndo && <IconActionButton label="Reject" onClick={onUndo} tone="undo" icon={RotateCcw} />}
          {onView && <IconActionButton label="View change" onClick={onView} tone="secondary" icon={Eye} />}
        </Stack>
      )}
    </Group>
  );
});
