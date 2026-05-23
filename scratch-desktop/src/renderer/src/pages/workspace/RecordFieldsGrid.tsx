import { ActionIcon, Box, Group, ScrollArea, Select, Stack, Table, Textarea, Tooltip } from '@mantine/core';
import type { TableViewCol } from '@spinner/shared-types';
import { AlignJustify, Columns2, RemoveFormatting, Sparkles, TriangleAlertIcon } from 'lucide-react';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { classifyFieldChange } from '../../../../shared/field-change-classification';
import type { ValidationEntry } from '../../../../shared/validation-types';
import {
  Text12Medium,
  Text12Regular,
  Text9Regular,
  TextMono12Regular,
  TextMono9Regular,
} from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import { CollapsibleRow } from './collapsible-row';
import {
  FieldReviewActions,
  InlineWordsDiff,
  SideBySideCurrentDiff,
  SideBySideDiff,
  SideBySideNewDiff,
} from './diff-renderers';
import { FieldCellValue } from './field-cell-renderer';
import { isPrettifiableMediaType, prettifyValue } from './field-prettifiers';
import type { FieldValueDiffKind, FieldValueDisplayMode } from './field-value-types';
import { DIFF_REMOVED_BG, DIFF_REMOVED_FG, DIFF_TEXT_STYLE, getAddedBg } from './field-value-types';

function isMediumOrLargeChange(row: RecordFieldRow): boolean {
  if (row.diffKind == null) return false;
  const { fieldSize } = classifyFieldChange(row.fromValue ?? '', row.value, undefined);
  return fieldSize === 'M' || fieldSize === 'L';
}

export interface RecordFieldRow {
  fieldName: string;
  /** Human-readable label for the field. Falls back to fieldName when not set. */
  displayLabel?: string;
  /** Optional description shown below the field name. Hidden if it matches displayLabel or fieldName. */
  description?: string;
  /** When set, this field belongs to the named banner group. */
  groupName?: string;
  value: string;
  fromValue?: string;
  diffKind: FieldValueDiffKind;
  displayMode?: FieldValueDisplayMode;
  editing?: boolean;
  referenceValue?: string;
  onClick?: () => void;
  onEditCommit?: (nextValue: string) => void;
  onEditCancel?: () => void;
  onApprove?: () => void;
  onUndo?: () => void;
  /** Column view metadata (readonly state, property type) from the view definition. */
  column?: Pick<TableViewCol, 'readonly' | 'type'>;
  /** JSON Schema `contentMediaType` for this field, used to enable the "Prettify" toggle. */
  contentMediaType?: string;
}

export type { ValidationEntry } from '../../../../shared/validation-types';

interface RecordFieldsGridProps {
  rows: RecordFieldRow[];
  footer?: React.ReactNode;
  /** Maps field name → list of validation violations to show. */
  validationWarnings?: Map<string, ValidationEntry[]>;
  /**
   * When set, the grid focuses on this field. Updates to this prop re-engage
   * focus mode (e.g. when a different field is requested by the parent).
   */
  initialFocusedFieldName?: string;
  /** Notifies parent when the focused field changes. Lets the parent persist focus across remounts. */
  onFocusedFieldChange?: (fieldName: string | null) => void;
  /**
   * Controlled state for the "Prettify" toggle in the focused field view.
   * Lifted to the parent so it survives transient remounts of the grid
   * (e.g. while the next record is loading).
   */
  prettifyActive?: boolean;
  onPrettifyToggle?: () => void;
}

const LABEL_COLUMN_WIDTH = 280;
const CONTROLS_COLUMN_WIDTH = 48;

function validationLevelColor(level: ValidationEntry['level']): string {
  return level === 'error' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-orange-6)';
}

function validationLevelSurface(level: ValidationEntry['level']): string {
  return level === 'error' ? 'var(--mantine-color-red-0)' : 'var(--mantine-color-yellow-0)';
}

function formatValidatorName(validatorKind: string): string {
  return validatorKind.replace(/[_-]+/g, ' ');
}

export function ValidationTooltipContent({
  violations,
  fullWidth,
  showFieldColumn,
}: {
  violations: ValidationEntry[];
  fullWidth?: boolean;
  showFieldColumn?: boolean;
}) {
  return (
    <Box
      style={fullWidth ? { width: '100%', maxWidth: 800, padding: 2 } : { minWidth: 420, maxWidth: 560, padding: 2 }}
    >
      <Table
        fz="xs"
        withRowBorders={false}
        horizontalSpacing={10}
        verticalSpacing={7}
        styles={{
          table: { tableLayout: 'fixed' },
          th: {
            borderBottom: '1px solid rgba(15, 23, 42, 0.10)',
            color: 'rgba(15, 23, 42, 0.48)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            paddingBottom: 8,
            textTransform: 'uppercase',
          },
          td: {
            borderBottom: '1px solid rgba(15, 23, 42, 0.06)',
            color: 'rgba(15, 23, 42, 0.88)',
            lineHeight: 1.35,
          },
        }}
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: 82 }}>Level</Table.Th>
            {showFieldColumn && <Table.Th style={{ width: 150 }}>Field</Table.Th>}
            <Table.Th>Message</Table.Th>
            <Table.Th style={{ width: 150 }}>Validator</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {violations.map((violation, index) => (
            <Table.Tr key={`${violation.level}-${violation.validatorKind}-${index}`}>
              <Table.Td>
                <Box
                  component="span"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    borderRadius: 999,
                    background: validationLevelSurface(violation.level),
                    color: validationLevelColor(violation.level),
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: '0.04em',
                    padding: '3px 7px',
                    textTransform: 'uppercase',
                  }}
                >
                  {violation.level}
                </Box>
              </Table.Td>
              {showFieldColumn && (
                <Table.Td>
                  <Text12Medium c="var(--fg-primary)" style={{ wordBreak: 'break-all' }}>
                    {violation.fieldPath ?? '-'}
                  </Text12Medium>
                </Table.Td>
              )}
              <Table.Td style={{ wordBreak: 'break-word' }}>
                <Stack gap={3}>
                  <Text12Medium c="rgba(15, 23, 42, 0.92)">{violation.message ?? 'No message'}</Text12Medium>
                  {violation.description && (
                    <Text12Regular c="rgba(15, 23, 42, 0.62)" style={{ lineHeight: 1.35 }}>
                      {violation.description}
                    </Text12Regular>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td
                style={{
                  color: 'rgba(15, 23, 42, 0.58)',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  overflowWrap: 'anywhere',
                }}
              >
                {formatValidatorName(violation.validatorKind)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function ValidationTooltip({ violations, children }: { violations: ValidationEntry[]; children: React.ReactNode }) {
  return (
    <Tooltip
      label={<ValidationTooltipContent violations={violations} />}
      position="top"
      multiline
      offset={10}
      zIndex={10020}
      withArrow={false}
      styles={{
        tooltip: {
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--fg-divider)',
          borderRadius: 0,
          boxShadow: 'none',
          padding: 12,
        },
      }}
    >
      {children}
    </Tooltip>
  );
}

const FieldEditor = memo(function FieldEditor({
  row,
  onChange,
}: {
  row: RecordFieldRow;
  onChange?: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const committedRef = useRef(false);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    row.onEditCommit?.(textareaRef.current?.value ?? row.value);
  };

  return (
    <Textarea
      ref={textareaRef}
      autoFocus
      autosize
      minRows={1}
      defaultValue={row.value}
      onChange={(e) => onChange?.(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          committedRef.current = true;
          row.onEditCancel?.();
        }
      }}
      styles={{
        wrapper: { margin: 0 },
        input: {
          backgroundColor: 'var(--bg-base)',
          borderRadius: 0,
          border: '1.5px solid var(--highlight-border)',
          padding: '8px 12px',
          ...DIFF_TEXT_STYLE,
        },
      }}
    />
  );
});

/**
 * Side-by-side editing: left column shows a live diff (current vs typed value),
 * right column shows the textarea editor.
 */
function SideBySideEditingCells({ row, layout }: { row: RecordFieldRow; layout: 'grid' | 'focused' }) {
  const [editValue, setEditValue] = useState(row.value);

  if (layout === 'focused') {
    // Focused field view: 1fr divider 1fr layout
    return (
      <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr', flex: 1, minHeight: 0 }}>
        <Box style={{ minWidth: 0, overflowY: 'auto' }}>
          <SideBySideCurrentDiff fromValue={row.fromValue ?? ''} value={editValue} />
        </Box>
        <Box style={{ backgroundColor: 'var(--fg-divider)' }} />
        <Box style={{ minWidth: 0 }}>
          <FieldEditor row={row} onChange={setEditValue} />
        </Box>
      </Box>
    );
  }

  // Grid table layout: occupies two grid columns (Current + New)
  return (
    <>
      <Box style={{ minWidth: 0 }}>
        <SideBySideCurrentDiff fromValue={row.fromValue ?? ''} value={editValue} />
      </Box>
      <Box style={{ minWidth: 0 }}>
        <FieldEditor row={row} onChange={setEditValue} />
      </Box>
    </>
  );
}

function diffBorderColor(diffKind: FieldValueDiffKind): string {
  if (diffKind === 'unreviewed') return 'var(--modified-needs-review-stroke)';
  if (diffKind === 'unpublished') return 'var(--modified-approved-stroke)';
  return 'transparent';
}

/** Renders approve/reject/discard action buttons in the Controls column. */
function ControlsCell({ row }: { row: RecordFieldRow }) {
  if (row.diffKind == null || (!row.onApprove && !row.onUndo)) return null;
  return (
    <Stack gap={6} align="flex-end" justify="center" style={{ padding: '2px 4px 2px 0' }}>
      <FieldReviewActions diffKind={row.diffKind} onApprove={row.onApprove} onUndo={row.onUndo} />
    </Stack>
  );
}

/** Render the value cell(s) for a single row in inline mode. */
function InlineValueCell({ row }: { row: RecordFieldRow }) {
  if (row.editing) {
    return null; // handled separately
  }

  const clickProps = row.onClick
    ? {
        onClick: row.onClick,
        role: 'button' as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            row.onClick!();
          }
        },
        style: { cursor: 'text' as const },
      }
    : { style: { cursor: 'default' as const } };

  const isDiff = row.displayMode === 'diff' && row.diffKind != null;

  if (isDiff && isMediumOrLargeChange(row)) {
    return (
      <Box {...clickProps}>
        <InlineWordsDiff fromValue={row.fromValue ?? ''} value={row.value} diffKind={row.diffKind} />
      </Box>
    );
  }

  if (isDiff) {
    return (
      <Box {...clickProps}>
        <Box style={{ padding: '6px 12px 2px', ...DIFF_TEXT_STYLE }}>
          <span
            style={{
              color: DIFF_REMOVED_FG,
              textDecoration: 'line-through',
              backgroundColor: DIFF_REMOVED_BG,
              boxDecorationBreak: 'clone',
              WebkitBoxDecorationBreak: 'clone',
              padding: '0 2px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {row.fromValue ?? ''}
          </span>
        </Box>
        <Box style={{ padding: '2px 12px 8px', ...DIFF_TEXT_STYLE }}>
          <span
            style={{
              backgroundColor: getAddedBg(row.diffKind),
              color: 'var(--modified-needs-review-stroke)',
              boxDecorationBreak: 'clone',
              WebkitBoxDecorationBreak: 'clone',
              padding: '0 2px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {row.value}
          </span>
        </Box>
      </Box>
    );
  }

  // Non-diff: plain value
  return (
    <Box {...clickProps}>
      <FieldCellValue value={row.value} column={row.column} muted={row.column?.readonly ?? false} />
    </Box>
  );
}

/** Toggles the "Prettify" view, which reformats the value according to its contentMediaType. */
function PrettifyToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={active ? 'Show original' : 'Prettify'} position="bottom" withArrow zIndex={10020}>
      <ActionIcon variant="subtle" size={20} radius={3} aria-label="Prettify" aria-pressed={active} onClick={onToggle}>
        <StyledLucideIcon Icon={active ? RemoveFormatting : Sparkles} size={14} strokeWidth={2} />
      </ActionIcon>
    </Tooltip>
  );
}

/** Grouped icon toggle for side-by-side vs inline diff view. */
function DiffViewModeToggle({
  diffViewMode,
  setDiffViewMode,
}: {
  diffViewMode: 'side-by-side' | 'inline-words';
  setDiffViewMode: (mode: 'side-by-side' | 'inline-words') => void;
}) {
  const selectedStyle: React.CSSProperties = {
    backgroundColor: 'var(--highlight-fill)',
    outline: '1px solid var(--highlight-border)',
  };
  const groupStyle: React.CSSProperties = {
    border: '1px solid var(--fg-divider)',
    borderRadius: 4,
  };
  return (
    <ActionIcon.Group style={groupStyle}>
      <Tooltip label="Side-by-side diff" withArrow zIndex={10020}>
        <ActionIcon
          variant="subtle"
          size={20}
          radius={3}
          aria-label="Side-by-side diff"
          onClick={() => setDiffViewMode('side-by-side')}
          style={diffViewMode === 'side-by-side' ? selectedStyle : undefined}
        >
          <StyledLucideIcon
            Icon={Columns2}
            size={14}
            strokeWidth={2}
            c={diffViewMode === 'side-by-side' ? 'var(--highlight-text)' : undefined}
          />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Inline diff" withArrow zIndex={10020}>
        <ActionIcon
          variant="subtle"
          size={20}
          radius={3}
          aria-label="Inline diff"
          onClick={() => setDiffViewMode('inline-words')}
          style={diffViewMode === 'inline-words' ? selectedStyle : undefined}
        >
          <StyledLucideIcon
            Icon={AlignJustify}
            size={14}
            strokeWidth={2}
            c={diffViewMode === 'inline-words' ? 'var(--highlight-text)' : undefined}
          />
        </ActionIcon>
      </Tooltip>
    </ActionIcon.Group>
  );
}

export const RecordFieldsGrid = memo(function RecordFieldsGrid({
  rows,
  footer,
  validationWarnings,
  initialFocusedFieldName,
  onFocusedFieldChange,
  prettifyActive: prettifyActiveProp,
  onPrettifyToggle,
}: RecordFieldsGridProps) {
  const [focusedFieldName, setFocusedFieldNameInternal] = useState<string | null>(initialFocusedFieldName ?? null);
  const storedDiffViewMode = useWorkspaceUiStore((s) => s.diffViewMode);
  const setStoredDiffViewMode = useWorkspaceUiStore((s) => s.setDiffViewMode);
  const [prettifyActiveLocal, setPrettifyActiveLocal] = useState(false);
  const prettifyActive = prettifyActiveProp ?? prettifyActiveLocal;
  const togglePrettify = onPrettifyToggle ?? (() => setPrettifyActiveLocal((v) => !v));
  const hasDiffs = useMemo(() => rows.some((row) => row.diffKind != null), [rows]);
  // Side-by-side only makes sense when there are two-sided diffs (modified records).
  // Created/deleted records have only one meaningful value — force inline for them.
  const hasTwoSidedDiff = useMemo(() => rows.some((row) => row.diffKind != null && row.fromValue != null), [rows]);
  const diffViewMode = storedDiffViewMode ?? (hasDiffs ? 'side-by-side' : 'inline-words');
  const isSideBySide = diffViewMode === 'side-by-side' && hasTwoSidedDiff;

  const setFocusedFieldName = (next: string | null) => {
    setFocusedFieldNameInternal(next);
    onFocusedFieldChange?.(next);
  };

  // Sync internal focus state with the parent's requested field, including clearing it.
  useEffect(() => {
    setFocusedFieldNameInternal(initialFocusedFieldName ?? null);
  }, [initialFocusedFieldName]);

  const focusedRow = useMemo(
    () => (focusedFieldName ? (rows.find((row) => row.fieldName === focusedFieldName) ?? null) : null),
    [rows, focusedFieldName],
  );

  const focusedPrettifiable = isPrettifiableMediaType(focusedRow?.contentMediaType);
  const focusedDisplayRow = useMemo<RecordFieldRow | null>(() => {
    if (!focusedRow) return null;
    if (!prettifyActive || !focusedPrettifiable || !focusedRow.contentMediaType) return focusedRow;
    return {
      ...focusedRow,
      value: prettifyValue(focusedRow.value, focusedRow.contentMediaType),
      fromValue:
        focusedRow.fromValue != null
          ? prettifyValue(focusedRow.fromValue, focusedRow.contentMediaType)
          : focusedRow.fromValue,
    };
  }, [focusedRow, focusedPrettifiable, prettifyActive]);

  // If the focused field is missing from a populated record (e.g. switched to a record
  // that doesn't have this field), exit focus mode. Skip while rows is empty — that
  // happens transiently between records, and clearing then would lose persistence.
  useEffect(() => {
    if (focusedFieldName && rows.length > 0 && !focusedRow) {
      setFocusedFieldNameInternal(null);
      onFocusedFieldChange?.(null);
    }
  }, [focusedFieldName, focusedRow, rows.length, onFocusedFieldChange]);

  if (rows.length === 0) {
    return (
      <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text12Regular c="dimmed">No fields available</Text12Regular>
      </Box>
    );
  }

  // --- Focused field view ---
  if (focusedRow) {
    const fieldOptions = rows.map((row) => ({
      value: row.fieldName,
      label: row.groupName
        ? `${row.groupName} \u2022 ${row.displayLabel ?? row.fieldName}`
        : (row.displayLabel ?? row.fieldName),
    }));
    const focusedViolations = validationWarnings?.get(focusedRow.fieldName);
    const focusedHasError = focusedViolations?.some((v) => v.level === 'error');
    const focusedIsDiff = focusedRow.diffKind != null;
    return (
      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Box
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            backgroundColor: 'var(--bg-panel)',
            borderBottom: '1px solid var(--fg-divider)',
            padding: '6px 16px',
          }}
        >
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: 8,
              rowGap: 2,
              alignItems: 'center',
            }}
          >
            <TextMono12Regular c="var(--fg-muted)">FIELD:</TextMono12Regular>
            <Group gap={8} align="center" wrap="nowrap">
              <Select
                data={fieldOptions}
                value={focusedRow.fieldName}
                onChange={(next) => {
                  if (next) {
                    setFocusedFieldName(next);
                  }
                }}
                onClear={() => setFocusedFieldName(null)}
                clearable
                searchable={true}
                allowDeselect={false}
                size="sm"
                miw={300}
                comboboxProps={{ withinPortal: true, zIndex: 10020, width: 'target' }}
                aria-label="Focused field"
              />
              {focusedViolations && focusedViolations.length > 0 && (
                <ValidationTooltip violations={focusedViolations}>
                  <Box style={{ display: 'flex', alignItems: 'center', cursor: 'default' }}>
                    <TriangleAlertIcon
                      size={16}
                      color={focusedHasError ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-orange-6)'}
                    />
                  </Box>
                </ValidationTooltip>
              )}
              <Box style={{ flex: 1 }} />
              {focusedPrettifiable && !focusedRow.editing && (
                <PrettifyToggle active={prettifyActive} onToggle={togglePrettify} />
              )}
              <DiffViewModeToggle diffViewMode={diffViewMode} setDiffViewMode={setStoredDiffViewMode} />
            </Group>
            {(focusedRow.displayLabel !== focusedRow.fieldName ||
              (focusedRow.description &&
                focusedRow.description !== focusedRow.fieldName &&
                focusedRow.description !== (focusedRow.displayLabel ?? focusedRow.fieldName)) ||
              focusedRow.column?.readonly) && (
              <>
                <Box /> {/* empty cell to skip the label column */}
                <Stack gap={2} ml="sm" my="xs" c="var(--fg-secondary)">
                  {focusedRow.displayLabel !== focusedRow.fieldName && (
                    <TextMono9Regular>{focusedRow.fieldName}</TextMono9Regular>
                  )}
                  {focusedRow.description &&
                    focusedRow.description !== focusedRow.fieldName &&
                    focusedRow.description !== (focusedRow.displayLabel ?? focusedRow.fieldName) && (
                      <Text9Regular>{focusedRow.description}</Text9Regular>
                    )}
                  {focusedRow.column?.readonly && <TextMono9Regular>Read-only</TextMono9Regular>}
                </Stack>
              </>
            )}
          </Box>
        </Box>

        <Box style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <Box
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              padding: '4px 16px',
              borderLeft: `4px solid ${diffBorderColor(focusedRow.diffKind)}`,
            }}
          >
            {focusedRow.editing ? (
              isSideBySide && focusedRow.fromValue != null ? (
                <SideBySideEditingCells row={focusedRow} layout="focused" />
              ) : (
                <FieldEditor row={focusedRow} />
              )
            ) : focusedIsDiff ? (
              <Box
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  cursor: focusedRow.onClick ? 'text' : 'default',
                }}
                onClick={focusedRow.onClick}
                role={focusedRow.onClick ? 'button' : undefined}
                tabIndex={focusedRow.onClick ? 0 : undefined}
                onKeyDown={
                  focusedRow.onClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          focusedRow.onClick!();
                        }
                      }
                    : undefined
                }
              >
                {isSideBySide ? (
                  <SideBySideDiff
                    fromValue={focusedDisplayRow?.fromValue ?? ''}
                    value={focusedDisplayRow?.value ?? ''}
                    diffKind={focusedRow.diffKind}
                  />
                ) : (
                  <InlineWordsDiff
                    fromValue={focusedDisplayRow?.fromValue ?? ''}
                    value={focusedDisplayRow?.value ?? ''}
                    diffKind={focusedRow.diffKind}
                  />
                )}
              </Box>
            ) : (
              <Box
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  cursor: focusedRow.onClick ? 'text' : 'default',
                }}
                onClick={focusedRow.onClick}
                role={focusedRow.onClick ? 'button' : undefined}
                tabIndex={focusedRow.onClick ? 0 : undefined}
                onKeyDown={
                  focusedRow.onClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          focusedRow.onClick!();
                        }
                      }
                    : undefined
                }
              >
                <FieldCellValue
                  value={focusedDisplayRow?.value ?? ''}
                  column={focusedRow.column}
                  muted={focusedRow.column?.readonly ?? false}
                />
              </Box>
            )}
          </Box>
          {focusedIsDiff && (focusedRow.onApprove || focusedRow.onUndo) && (
            <Box style={{ padding: '8px 8px 0 0' }}>
              <FieldReviewActions
                diffKind={focusedRow.diffKind}
                onApprove={focusedRow.onApprove}
                onUndo={focusedRow.onUndo}
              />
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  // --- Table view ---
  // Column layout via CSS grid instead of <table> so rows can be individually collapsible.
  // Side-by-side: Field | Current | New | Controls
  // Inline:       Field | Value | Controls
  const gridColumns = isSideBySide
    ? `${LABEL_COLUMN_WIDTH}px 4px 1fr 1fr ${CONTROLS_COLUMN_WIDTH}px`
    : `${LABEL_COLUMN_WIDTH}px 4px 1fr ${CONTROLS_COLUMN_WIDTH}px`;

  const headerStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: gridColumns,
    position: 'sticky',
    top: 0,
    zIndex: 1,
    backgroundColor: 'var(--bg-panel)',
    borderBottom: '1px solid var(--mantine-color-default-border)',
    padding: '12px 8px 12px 16px',
    gap: 0,
    alignItems: 'center',
  };

  const rowGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: gridColumns,
    padding: '4px 8px 4px 16px',
    gap: 0,
    alignItems: 'start',
  };

  return (
    <ScrollArea style={{ flex: 1 }}>
      <style>{`.record-fields-grid-row:hover .record-fields-grid-expand-btn { opacity: 1 !important; }`}</style>
      {/* Header */}
      <Box style={headerStyle}>
        <TextMono12Regular c="var(--fg-muted)">FIELD</TextMono12Regular>
        <Box /> {/* diff border spacer */}
        {isSideBySide ? (
          <>
            <TextMono12Regular c="var(--fg-muted)" style={{ padding: '0 12px' }}>
              CURRENT
            </TextMono12Regular>
            <TextMono12Regular c="var(--fg-muted)" style={{ padding: '0 12px' }}>
              NEW
            </TextMono12Regular>
          </>
        ) : (
          <TextMono12Regular c="var(--fg-muted)" style={{ padding: '0 12px' }}>
            VALUE
          </TextMono12Regular>
        )}
        <Box style={{ display: 'flex', justifyContent: 'center' }}>
          <DiffViewModeToggle diffViewMode={diffViewMode} setDiffViewMode={setStoredDiffViewMode} />
        </Box>
      </Box>

      {/* Rows */}
      {rows.map((row, idx) => {
        const groupName = row.groupName;
        const prevGroup = idx > 0 ? rows[idx - 1].groupName : undefined;
        const isGroupStart = groupName != null && groupName !== prevGroup;
        const isInGroup = groupName != null;

        return (
          <React.Fragment key={row.fieldName}>
            {isGroupStart && (
              <Box
                style={{
                  borderLeft: '6px solid var(--fg-divider)',
                  borderBottom: '1px solid var(--mantine-color-default-border)',
                  padding: '12px 16px 8px',
                }}
              >
                <Text9Regular c="var(--fg-muted)" fw={700} tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                  {groupName}
                </Text9Regular>
              </Box>
            )}
            <CollapsibleRow
              expandButtonLeft={
                isSideBySide
                  ? `calc(${LABEL_COLUMN_WIDTH + 4 + 16}px + (100% - ${LABEL_COLUMN_WIDTH + 4 + CONTROLS_COLUMN_WIDTH + 32}px) / 2)`
                  : undefined
              }
            >
              {() => (
                <Box
                  className="record-fields-grid-row"
                  style={{
                    ...rowGridStyle,
                    ...(isInGroup ? { borderLeft: '6px solid var(--fg-divider)' } : {}),
                  }}
                >
                  {/* Field name column */}
                  <Group h="100%" mih={40} py={8} pr={8} align="top">
                    <Stack gap="xs" flex={1}>
                      <Text12Medium
                        c="var(--fg-primary)"
                        style={{
                          wordBreak: 'break-all',
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.5,
                          cursor: 'pointer',
                          textDecoration: 'none',
                        }}
                        onClick={() => setFocusedFieldName(row.fieldName)}
                        onMouseOver={(e: React.MouseEvent<HTMLElement>) => {
                          e.currentTarget.style.textDecoration = 'underline';
                        }}
                        onMouseOut={(e: React.MouseEvent<HTMLElement>) => {
                          e.currentTarget.style.textDecoration = 'none';
                        }}
                      >
                        {row.displayLabel ?? row.fieldName}
                      </Text12Medium>
                      {row.displayLabel !== row.fieldName && (
                        <TextMono9Regular c="var(--fg-secondary)">{row.fieldName}</TextMono9Regular>
                      )}
                      {row.description &&
                        row.description !== row.fieldName &&
                        row.description !== (row.displayLabel ?? row.fieldName) && (
                          <Text9Regular c="var(--fg-secondary)">{row.description}</Text9Regular>
                        )}
                    </Stack>
                    {validationWarnings?.has(row.fieldName) &&
                      (() => {
                        const vs = validationWarnings.get(row.fieldName)!;
                        const hasErr = vs.some((v) => v.level === 'error');
                        if (vs.length === 0) return null;
                        return (
                          <ValidationTooltip violations={vs}>
                            <Box
                              w={16}
                              h={16}
                              c={hasErr ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-orange-6)'}
                            >
                              <TriangleAlertIcon size={16} />
                            </Box>
                          </ValidationTooltip>
                        );
                      })()}
                  </Group>

                  {/* Diff border indicator */}
                  <Box style={{ backgroundColor: diffBorderColor(row.diffKind), alignSelf: 'stretch' }} />

                  {/* Value column(s) */}
                  {isSideBySide ? (
                    <SideBySideValueCells row={row} />
                  ) : (
                    <Box>{row.editing ? <FieldEditor row={row} /> : <InlineValueCell row={row} />}</Box>
                  )}

                  {/* Controls column */}
                  <Box style={{ display: 'flex', justifyContent: 'center', alignSelf: 'start', paddingTop: 8 }}>
                    <ControlsCell row={row} />
                  </Box>
                </Box>
              )}
            </CollapsibleRow>
          </React.Fragment>
        );
      })}
      {footer}
    </ScrollArea>
  );
});

/** Renders the Current and New value cells for side-by-side mode. */
function SideBySideValueCells({ row }: { row: RecordFieldRow }) {
  const clickProps = row.onClick
    ? {
        onClick: row.onClick,
        role: 'button' as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            row.onClick!();
          }
        },
        style: { cursor: 'text' as const },
      }
    : { style: { cursor: 'default' as const } };

  if (row.editing) {
    return <SideBySideEditingCells row={row} layout="grid" />;
  }

  const isDiff = row.diffKind != null;

  if (isDiff) {
    // Changed field: word-level diff — Current highlights removed words, New highlights added words
    const fromValue = row.fromValue ?? '';
    return (
      <>
        <Box style={{ minWidth: 0 }}>
          <SideBySideCurrentDiff fromValue={fromValue} value={row.value} />
        </Box>
        <Box style={{ minWidth: 0 }}>
          <Box {...clickProps}>
            <SideBySideNewDiff fromValue={fromValue} value={row.value} diffKind={row.diffKind} />
          </Box>
        </Box>
      </>
    );
  }

  // Unchanged field: Current shows value, New shows "(unchanged)"
  return (
    <>
      <Box style={{ minWidth: 0 }}>
        <Box {...clickProps}>
          <FieldCellValue value={row.value} column={row.column} muted={row.column?.readonly ?? false} />
        </Box>
      </Box>
      <Box style={{ minWidth: 0 }}>
        <Box style={{ padding: '8px 12px', ...DIFF_TEXT_STYLE }}>
          <span style={{ color: 'var(--fg-muted)', fontStyle: 'italic' }}>(unchanged)</span>
        </Box>
      </Box>
    </>
  );
}
