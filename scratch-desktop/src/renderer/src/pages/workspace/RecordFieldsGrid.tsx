import { ActionIcon, Box, Group, Portal, ScrollArea, Select, Stack, Table, Textarea, Tooltip } from '@mantine/core';
import type { TableViewCol } from '@spinner/shared-types';
import { Minimize2, TriangleAlertIcon } from 'lucide-react';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { classifyFieldChange } from '../../../../shared/field-change-classification';
import type { ValidationEntry } from '../../../../shared/validation-types';
import { Text12Medium, Text12Regular, Text9Regular, TextMono9Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
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
}

const FLOATING_PANEL_GAP = 5;
const LABEL_COLUMN_WIDTH = 280;
const VIEW_ALL_VALUE = '__view_all_fields__';

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

export const RecordFieldsGrid = memo(function RecordFieldsGrid({
  rows,
  footer,
  validationWarnings,
  initialFocusedFieldName,
  onFocusedFieldChange,
}: RecordFieldsGridProps) {
  const [editingAnchorEl, setEditingAnchorEl] = useState<HTMLDivElement | null>(null);
  const [editingAnchorRect, setEditingAnchorRect] = useState<DOMRect | null>(null);
  const [focusedFieldName, setFocusedFieldNameInternal] = useState<string | null>(initialFocusedFieldName ?? null);

  const setFocusedFieldName = (next: string | null) => {
    setFocusedFieldNameInternal(next);
    onFocusedFieldChange?.(next);
  };

  // Sync internal focus state with the parent's requested field, including clearing it.
  useEffect(() => {
    setFocusedFieldNameInternal(initialFocusedFieldName ?? null);
  }, [initialFocusedFieldName]);

  const editingRow = useMemo(() => rows.find((row) => row.editing) ?? null, [rows]);
  const focusedRow = useMemo(
    () => (focusedFieldName ? (rows.find((row) => row.fieldName === focusedFieldName) ?? null) : null),
    [rows, focusedFieldName],
  );

  // If the focused field is missing from a populated record (e.g. switched to a record
  // that doesn't have this field), exit focus mode. Skip while rows is empty — that
  // happens transiently between records, and clearing then would lose persistence.
  useEffect(() => {
    if (focusedFieldName && rows.length > 0 && !focusedRow) {
      setFocusedFieldNameInternal(null);
      onFocusedFieldChange?.(null);
    }
  }, [focusedFieldName, focusedRow, rows.length, onFocusedFieldChange]);

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
    const fieldOptions = [
      ...rows.map((row) => ({
        value: row.fieldName,
        label: row.displayLabel ?? row.fieldName,
      })),
      { value: VIEW_ALL_VALUE, label: `All fields (${rows.length.toLocaleString()})` },
    ];
    const focusedViolations = validationWarnings?.get(focusedRow.fieldName);
    const focusedHasError = focusedViolations?.some((v) => v.level === 'error');
    return (
      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            backgroundColor: 'var(--bg-panel)',
            borderBottom: '1px solid var(--fg-divider)',
            padding: '4px 16px 4px 12px',
          }}
        >
          <Select
            data={fieldOptions}
            value={focusedRow.fieldName}
            onChange={(next) => {
              if (next === VIEW_ALL_VALUE) {
                setFocusedFieldName(null);
              } else if (next) {
                setFocusedFieldName(next);
              }
            }}
            allowDeselect={false}
            searchable={fieldOptions.length > 8}
            variant="unstyled"
            comboboxProps={{ withinPortal: true, zIndex: 10020, width: 'target' }}
            aria-label="Focused field"
            renderOption={({ option }) => (
              <Box
                style={{
                  width: '100%',
                  ...(option.value === VIEW_ALL_VALUE
                    ? {
                        paddingTop: 6,
                        marginTop: 2,
                        borderTop: '1px solid var(--fg-divider)',
                      }
                    : {}),
                }}
              >
                {option.label}
              </Box>
            )}
            styles={{
              input: {
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--fg-primary)',
                paddingLeft: 4,
              },
            }}
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
          <Box style={{ marginLeft: 'auto', width: 28, display: 'flex', justifyContent: 'center' }}>
            <Tooltip label="Minimize" position="left" withArrow zIndex={10020}>
              <ActionIcon
                variant="subtle"
                size={24}
                radius={3}
                aria-label="Minimize"
                onClick={() => setFocusedFieldName(null)}
              >
                <StyledLucideIcon Icon={Minimize2} size={14} strokeWidth={2.25} />
              </ActionIcon>
            </Tooltip>
          </Box>
        </Box>

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
              column={focusedRow.column}
              expanded
            />
          )}
        </Box>

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
          {rows.map((row, idx) => {
            const groupName = row.groupName;
            const prevGroup = idx > 0 ? rows[idx - 1].groupName : undefined;
            const isGroupStart = groupName != null && groupName !== prevGroup;
            const isInGroup = groupName != null;

            const groupBarStyle = isInGroup ? { borderLeft: '6px solid var(--fg-divider)' } : undefined;

            return (
              <React.Fragment key={row.fieldName}>
                {isGroupStart && (
                  <Table.Tr style={{ borderLeft: '6px solid var(--fg-divider)' }}>
                    <Table.Td colSpan={2} style={{ paddingTop: 12, paddingBottom: 8 }}>
                      <Text9Regular c="var(--fg-muted)" fw={700} tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                        {groupName}
                      </Text9Regular>
                    </Table.Td>
                  </Table.Tr>
                )}
                <Table.Tr style={groupBarStyle}>
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
                          column={row.column}
                          richDiff={isMediumOrLargeChange(row)}
                        />
                      )}
                    </Box>
                  </Table.Td>
                </Table.Tr>
              </React.Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
      {footer}

      {editingAnchorOverlay}
    </ScrollArea>
  );
});
