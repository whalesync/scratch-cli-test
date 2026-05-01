import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group, Portal, ScrollArea, Stack, Table, Textarea, Tooltip, UnstyledButton } from '@mantine/core';
import { ChevronDown, TriangleAlertIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { classifyFieldChange } from '../../../../shared/field-change-classification';
import { Text12Medium, Text12Regular, Text9Regular, TextMono9Regular } from '../../components/base/text';
import { FieldReferenceStrip } from './FieldReferenceStrip';
import { FieldValuePanel, type FieldValueDiffKind, type FieldValueDisplayMode } from './FieldValuePanel';

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
}

interface RecordFieldsGridProps {
  rows: RecordFieldRow[];
  footer?: React.ReactNode;
  /** Maps field name → list of validation warning messages to show. */
  validationWarnings?: Map<string, string[]>;
  /**
   * When set, the grid focuses on this field. Updates to this prop re-engage
   * focus mode (e.g. when a different field is requested by the parent).
   */
  initialFocusedFieldName?: string;
}

const FLOATING_PANEL_GAP = 5;
const LABEL_COLUMN_WIDTH = 280;

const FieldEditor = memo(function FieldEditor({ row }: { row: RecordFieldRow }) {
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
      onFocus={(e) => e.currentTarget.select()}
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
          border: 'none',
          outline: '2px solid var(--highlight-border)',
          padding: '8px 12px',
          fontFamily: 'monospace',
          fontSize: 13,
          lineHeight: 1.5,
        },
      }}
    />
  );
});

function diffBorderColor(diffKind: FieldValueDiffKind): string {
  if (diffKind === 'unreviewed') return 'var(--modified-needs-review-stroke)';
  if (diffKind === 'unpublished') return 'var(--modified-approved-stroke)';
  return 'transparent';
}

function FieldLabel({
  row,
  validationWarnings,
  onFocus,
}: {
  row: RecordFieldRow;
  validationWarnings?: Map<string, string[]>;
  onFocus?: () => void;
}) {
  const label = row.displayLabel ?? row.fieldName;
  const warnings = validationWarnings?.get(row.fieldName);
  const content = (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
      <Text12Medium
        c="var(--fg-primary)"
        style={{ flex: 1, wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: 1.5, textAlign: 'left' }}
      >
        {label}
      </Text12Medium>
      {warnings && (
        <Tooltip label={warnings.join('\n')} position="top-end" withArrow zIndex={10020} multiline>
          <Box style={{ display: 'flex', alignItems: 'center', cursor: 'default', flexShrink: 0 }}>
            <StyledLucideIcon Icon={TriangleAlertIcon} size={16} c="var(--mantine-color-orange-6)" />
          </Box>
        </Tooltip>
      )}
    </Box>
  );

  if (!onFocus) return content;

  return (
    <UnstyledButton
      onClick={onFocus}
      aria-label={`Focus on ${label}`}
      style={{ width: '100%', padding: 0, borderRadius: 2 }}
    >
      {content}
    </UnstyledButton>
  );
}

export const RecordFieldsGrid = memo(function RecordFieldsGrid({
  rows,
  footer,
  validationWarnings,
  initialFocusedFieldName,
}: RecordFieldsGridProps) {
  const [editingAnchorEl, setEditingAnchorEl] = useState<HTMLDivElement | null>(null);
  const [editingAnchorRect, setEditingAnchorRect] = useState<DOMRect | null>(null);
  const [focusedFieldName, setFocusedFieldName] = useState<string | null>(initialFocusedFieldName ?? null);

  // Re-engage focus mode whenever the parent requests a (possibly different) field.
  useEffect(() => {
    if (initialFocusedFieldName) setFocusedFieldName(initialFocusedFieldName);
  }, [initialFocusedFieldName]);

  const editingRow = useMemo(() => rows.find((row) => row.editing) ?? null, [rows]);
  const focusedRow = useMemo(
    () => (focusedFieldName ? (rows.find((row) => row.fieldName === focusedFieldName) ?? null) : null),
    [rows, focusedFieldName],
  );

  // If the focused field disappears (e.g. record reload), exit focus mode.
  useEffect(() => {
    if (focusedFieldName && !focusedRow) setFocusedFieldName(null);
  }, [focusedFieldName, focusedRow]);

  useEffect(() => {
    if (!editingAnchorEl || editingRow?.referenceValue == null || !editingRow.onUndo) {
      setEditingAnchorRect(null);
      return;
    }

    const updateRect = () => {
      setEditingAnchorRect(editingAnchorEl.getBoundingClientRect());
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [editingAnchorEl, editingRow]);

  if (rows.length === 0) {
    return (
      <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text12Regular c="dimmed">No fields available</Text12Regular>
      </Box>
    );
  }

  const editingAnchorOverlay =
    editingRow?.referenceValue != null && editingRow.onUndo && editingAnchorRect ? (
      <Portal target="#portal">
        <Box
          className="click-outside-ignore"
          style={{
            position: 'fixed',
            left: Math.max(12, Math.min(editingAnchorRect.left, window.innerWidth - editingAnchorRect.width - 12)),
            top: Math.max(FLOATING_PANEL_GAP, editingAnchorRect.top - FLOATING_PANEL_GAP),
            transform: 'translateY(-100%)',
            zIndex: 10010,
            width: Math.max(280, Math.floor(editingAnchorRect.width)),
            maxWidth: Math.max(280, window.innerWidth - 24),
          }}
        >
          <FieldReferenceStrip
            value={editingRow.referenceValue}
            label={editingRow.diffKind === 'unpublished' ? 'Last published' : 'Last approved'}
            onUndo={editingRow.onUndo}
          />
        </Box>
      </Portal>
    ) : null;

  if (focusedRow) {
    const additionalCount = rows.length - 1;
    return (
      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px 1fr`,
            backgroundColor: 'var(--bg-panel)',
            borderBottom: '1px solid var(--fg-divider)',
            padding: '8px 16px',
            gap: 16,
          }}
        >
          <Text12Medium c="var(--fg-muted)">Field</Text12Medium>
          <Text12Medium c="var(--fg-muted)">Value</Text12Medium>
        </Box>

        <Box
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px 1fr`,
            minHeight: 0,
            gap: 16,
            padding: '4px 16px',
          }}
        >
          <Box style={{ paddingTop: 4 }}>
            <FieldLabel row={focusedRow} validationWarnings={validationWarnings} />
          </Box>
          <Box
            style={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              borderLeft: `4px solid ${diffBorderColor(focusedRow.diffKind)}`,
              paddingLeft: 4,
            }}
          >
            {focusedRow.editing ? (
              <Box ref={setEditingAnchorEl} style={{ display: 'grid', gap: 6 }}>
                <FieldEditor row={focusedRow} />
              </Box>
            ) : (
              <FieldValuePanel
                value={focusedRow.value}
                fromValue={focusedRow.fromValue}
                diffKind={focusedRow.diffKind}
                displayMode={focusedRow.displayMode}
                onClick={focusedRow.onClick}
                onApprove={focusedRow.displayMode === 'diff' ? focusedRow.onApprove : undefined}
                onUndo={focusedRow.displayMode === 'diff' ? focusedRow.onUndo : undefined}
                onMinimize={() => setFocusedFieldName(null)}
                expanded
              />
            )}
          </Box>
        </Box>

        <UnstyledButton
          onClick={() => setFocusedFieldName(null)}
          aria-label="Show additional fields"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '12px 16px',
            borderTop: '1px solid var(--fg-divider)',
            backgroundColor: 'var(--bg-panel)',
            cursor: 'pointer',
          }}
        >
          <Text12Medium c="var(--fg-secondary)">
            Additional Fields
            {additionalCount > 0 ? ` (${additionalCount})` : ''}
          </Text12Medium>
          <StyledLucideIcon Icon={ChevronDown} size={14} c="var(--fg-muted)" />
        </UnstyledButton>

        {editingAnchorOverlay}
      </Box>
    );
  }

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Table
        horizontalSpacing="md"
        verticalSpacing={0}
        withRowBorders
        styles={{
          table: { tableLayout: 'fixed' },
          th: { backgroundColor: 'var(--bg-panel)', position: 'sticky', top: 0, zIndex: 1 },
          td: { verticalAlign: 'top', paddingTop: 4, paddingBottom: 4 },
        }}
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: LABEL_COLUMN_WIDTH }}>
              <Text12Medium c="var(--fg-muted)">Field</Text12Medium>
            </Table.Th>
            <Table.Th>
              <Text12Medium c="var(--fg-muted)">Value</Text12Medium>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.fieldName}>
              <Table.Td style={{ width: 280, height: 40 }} py="xs">
                <Group w="100%" align="top">
                  <Stack gap="xs" flex={1}>
                    <Text12Medium
                      c="var(--fg-primary)"
                      style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
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
                  {validationWarnings?.has(row.fieldName) && (
                    <Tooltip
                      label={validationWarnings.get(row.fieldName)!.join('\n')}
                      position="top-end"
                      withArrow
                      zIndex={10020}
                      multiline
                    >
                      <Box w={16} h={16} c="var(--mantine-color-orange-6)">
                        <TriangleAlertIcon size={16} />
                      </Box>
                    </Tooltip>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                <Box style={{ borderLeft: `4px solid ${diffBorderColor(row.diffKind)}` }}>
                  {row.editing ? (
                    <Box style={{ display: 'grid', gap: 6 }}>
                      <Box ref={setEditingAnchorEl}>
                        <FieldEditor row={row} />
                      </Box>
                    </Box>
                  ) : (
                    <FieldValuePanel
                      value={row.value}
                      fromValue={row.fromValue}
                      diffKind={row.diffKind}
                      displayMode={row.displayMode}
                      onClick={row.onClick}
                      onApprove={row.displayMode === 'diff' ? row.onApprove : undefined}
                      onUndo={row.displayMode === 'diff' ? row.onUndo : undefined}
                      onExpand={isMediumOrLargeChange(row) ? () => setFocusedFieldName(row.fieldName) : undefined}
                      richDiff={isMediumOrLargeChange(row)}
                    />
                  )}
                </Box>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {footer}

      {editingAnchorOverlay}
    </ScrollArea>
  );
});
