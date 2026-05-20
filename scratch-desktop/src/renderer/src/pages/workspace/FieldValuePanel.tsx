import { ActionIcon, Box, Checkbox, Group, Stack, Tooltip } from '@mantine/core';
import type { TableViewCol } from '@spinner/shared-types';
import { diffWordsWithSpace } from 'diff';
import { Check, Columns2, Eye, Maximize2, RotateCcw, WrapText } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { formatFieldDisplay } from './field-formatters';

export type FieldValueDiffKind = 'unreviewed' | 'unpublished' | null;
export type FieldValueDisplayMode = 'diff' | 'current';
export type FieldValueDiffViewMode = 'side-by-side' | 'inline-words';

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
  /** When set, render an "Expand" action below Approve/Reject (used to focus this field). */
  onExpand?: () => void;
  /** Column view metadata (readonly state, property type) from the view definition. */
  column?: Pick<TableViewCol, 'readonly' | 'type'>;
  /** When true, before/after values render on a single line, truncated to TRUNCATED_MAX_CHARS. */
  truncate?: boolean;
  /** When true, the panel fills its parent's available vertical space instead of capping at MAX_CONTENT_HEIGHT. */
  expanded?: boolean;
  /**
   * When true, render the rich diff UI (toggle between side-by-side and inline-word views) instead of the
   * simple stacked old/new layout. Implied by `expanded`. Use this for non-expanded views (e.g. record-detail
   * rows for medium/large text fields) that should still offer the diff toggle.
   */
  richDiff?: boolean;
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
const DIFF_REMOVED_FG = '#dc2626'; // red-600
const MAX_CONTENT_HEIGHT = 'calc(1.5em * 5 + 12px)';
const ACTION_BUTTON_SIZE = 24;
const TOGGLE_BUTTON_SIZE = 20;

const DIFF_VIEW_MODE_STORAGE_KEY = 'scratch-desktop:field-value-diff-view-mode';
const DEFAULT_DIFF_VIEW_MODE: FieldValueDiffViewMode = 'inline-words';

function isDiffViewMode(value: unknown): value is FieldValueDiffViewMode {
  return value === 'side-by-side' || value === 'inline-words';
}

function readStoredDiffViewMode(): FieldValueDiffViewMode {
  if (typeof window === 'undefined') return DEFAULT_DIFF_VIEW_MODE;
  const stored = window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY);
  return isDiffViewMode(stored) ? stored : DEFAULT_DIFF_VIEW_MODE;
}

// Module-level pub/sub so a toggle in one panel propagates to all visible panels.
const diffViewModeSubscribers = new Set<(mode: FieldValueDiffViewMode) => void>();

function setSharedDiffViewMode(mode: FieldValueDiffViewMode) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
  }
  diffViewModeSubscribers.forEach((subscriber) => subscriber(mode));
}

function useDiffViewMode(): [FieldValueDiffViewMode, (mode: FieldValueDiffViewMode) => void] {
  const [mode, setMode] = useState<FieldValueDiffViewMode>(readStoredDiffViewMode);
  useEffect(() => {
    diffViewModeSubscribers.add(setMode);
    return () => {
      diffViewModeSubscribers.delete(setMode);
    };
  }, []);
  return [mode, setSharedDiffViewMode];
}

const DIFF_TEXT_STYLE: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

function getAddedBg(diffKind: FieldValueDiffKind): string {
  return diffKind === 'unreviewed' ? DIFF_WORKING_BG : DIFF_UNPUBLISHED_BG;
}

function SideBySideDiff({
  fromValue,
  value,
  diffKind,
}: {
  fromValue: string;
  value: string;
  diffKind: FieldValueDiffKind;
}) {
  return (
    <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr' }}>
      <Box style={{ padding: '8px 12px', minWidth: 0, ...DIFF_TEXT_STYLE }}>
        <span
          style={{
            color: DIFF_REMOVED_FG,
            textDecoration: 'line-through',
            backgroundColor: DIFF_REMOVED_BG,
            boxDecorationBreak: 'clone',
            WebkitBoxDecorationBreak: 'clone',
            padding: '0 2px',
          }}
        >
          {fromValue}
        </span>
      </Box>
      <Box style={{ backgroundColor: 'var(--fg-divider)' }} />
      <Box style={{ padding: '8px 12px', minWidth: 0, ...DIFF_TEXT_STYLE }}>
        <span
          style={{
            color: 'var(--modified-needs-review-stroke)',
            backgroundColor: getAddedBg(diffKind),
            boxDecorationBreak: 'clone',
            WebkitBoxDecorationBreak: 'clone',
            padding: '0 2px',
          }}
        >
          {value}
        </span>
      </Box>
    </Box>
  );
}

function InlineWordsDiff({
  fromValue,
  value,
  diffKind,
}: {
  fromValue: string;
  value: string;
  diffKind: FieldValueDiffKind;
}) {
  const changes = useMemo(() => diffWordsWithSpace(fromValue, value), [fromValue, value]);
  const addedBg = getAddedBg(diffKind);
  return (
    <Box style={{ padding: '8px 12px', color: 'var(--fg-primary)', ...DIFF_TEXT_STYLE }}>
      {changes.map((change, index) => {
        if (change.removed) {
          return (
            <span
              key={index}
              style={{
                color: DIFF_REMOVED_FG,
                textDecoration: 'line-through',
                backgroundColor: DIFF_REMOVED_BG,
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {change.value}
            </span>
          );
        }
        if (change.added) {
          return (
            <span
              key={index}
              style={{
                color: 'var(--modified-needs-review-stroke)',
                backgroundColor: addedBg,
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {change.value}
            </span>
          );
        }
        return <span key={index}>{change.value}</span>;
      })}
    </Box>
  );
}

function DiffViewToggle({
  mode,
  onChange,
}: {
  mode: FieldValueDiffViewMode;
  onChange: (mode: FieldValueDiffViewMode) => void;
}) {
  const next: FieldValueDiffViewMode = mode === 'side-by-side' ? 'inline-words' : 'side-by-side';
  const label = mode === 'side-by-side' ? 'Switch to inline word diff' : 'Switch to side-by-side diff';
  const Icon = mode === 'side-by-side' ? WrapText : Columns2;
  return (
    <Tooltip label={label} position="left" withArrow zIndex={10020}>
      <ActionIcon
        variant="subtle"
        size={TOGGLE_BUTTON_SIZE}
        radius={3}
        aria-label={label}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onChange(next);
        }}
      >
        <StyledLucideIcon Icon={Icon} size={14} strokeWidth={2.25} />
      </ActionIcon>
    </Tooltip>
  );
}

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
  onExpand,
  column,
  truncate = false,
  expanded = false,
  richDiff = false,
}: FieldValuePanelProps) {
  const [diffViewMode, setDiffViewMode] = useDiffViewMode();
  const readOnly = column?.readonly ?? false;
  const fieldType = column?.type;
  const hasActions = Boolean(onApprove || onUndo || onView || onExpand);
  const actionCount = (onApprove ? 1 : 0) + (onUndo ? 1 : 0) + (onView ? 1 : 0) + (onExpand ? 1 : 0);
  const renderedFromValue = truncate ? truncateOneLine(fromValue) : formatFieldDisplay(fromValue, fieldType);
  const renderedValue = truncate ? truncateOneLine(value) : formatFieldDisplay(value, fieldType);
  const lineWrapStyle: React.CSSProperties = truncate
    ? { whiteSpace: 'nowrap', overflow: 'hidden' }
    : { whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
  const useFullHeight = expanded && !truncate;
  const showRichDiff = !truncate && (useFullHeight || richDiff);

  return (
    <Group align="stretch" gap={8} wrap="nowrap" style={useFullHeight ? { flex: 1, minHeight: 0 } : undefined}>
      <Box
        style={{
          flex: 1,
          minWidth: 0,
          ...(useFullHeight ? { display: 'flex', flexDirection: 'column' } : {}),
        }}
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
            ...(useFullHeight ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } : {}),
          }}
        >
          {displayMode === 'diff' ? (
            showRichDiff ? (
              <Box
                style={useFullHeight ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } : undefined}
              >
                <Box
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    padding: '4px 6px 0',
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <DiffViewToggle mode={diffViewMode} onChange={setDiffViewMode} />
                </Box>
                <Box
                  style={
                    useFullHeight
                      ? { flex: 1, minHeight: 0, overflowY: 'auto' }
                      : { maxHeight: MAX_CONTENT_HEIGHT, overflowY: 'auto' }
                  }
                >
                  {diffViewMode === 'side-by-side' ? (
                    <SideBySideDiff fromValue={fromValue} value={value} diffKind={diffKind} />
                  ) : (
                    <InlineWordsDiff fromValue={fromValue} value={value} diffKind={diffKind} />
                  )}
                </Box>
              </Box>
            ) : (
              <Box style={truncate ? undefined : { maxHeight: MAX_CONTENT_HEIGHT, overflowY: 'auto' }}>
                <Box
                  style={{
                    padding: '6px 12px 2px',
                    fontFamily: 'monospace',
                    fontSize: truncate ? 12 : 13,
                    lineHeight: truncate ? 1.45 : 1.5,
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
            )
          ) : fieldType === 'checkbox' ? (
            <Box
              style={{
                padding: '8px 12px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Checkbox
                checked={value === 'true'}
                readOnly
                tabIndex={-1}
                size="xs"
                styles={{
                  input: {
                    cursor: onClick ? 'pointer' : 'default',
                    pointerEvents: 'none',
                    backgroundColor: value === 'true' ? 'var(--mantine-color-gray-3)' : undefined,
                    borderColor: 'var(--mantine-color-gray-3)',
                    '--checkbox-icon-color': 'white',
                  },
                }}
              />
            </Box>
          ) : (
            <Box
              style={{
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: 13,
                lineHeight: 1.5,
                ...lineWrapStyle,
                color: readOnly ? 'var(--fg-muted)' : 'var(--fg-primary)',
                ...(truncate
                  ? {}
                  : useFullHeight
                    ? { flex: 1, minHeight: 0, overflowY: 'auto' }
                    : { maxHeight: MAX_CONTENT_HEIGHT, overflowY: 'auto' }),
              }}
            >
              {renderedValue || <span style={{ color: 'var(--fg-muted)' }}>{'\u2014'}</span>}
            </Box>
          )}
        </Box>
      </Box>

      {hasActions && (
        <Stack
          gap={6}
          align="center"
          justify={useFullHeight || actionCount > 1 ? 'flex-start' : 'center'}
          style={{ flexShrink: 0, width: ACTION_BUTTON_SIZE + 4, padding: '2px 0' }}
        >
          {onApprove && <IconActionButton label="Approve" onClick={onApprove} tone="approve" icon={Check} />}
          {onUndo && <IconActionButton label="Reject" onClick={onUndo} tone="undo" icon={RotateCcw} />}
          {onExpand && <IconActionButton label="Expand" onClick={onExpand} tone="secondary" icon={Maximize2} />}
          {onView && <IconActionButton label="View change" onClick={onView} tone="secondary" icon={Eye} />}
        </Stack>
      )}
    </Group>
  );
});
