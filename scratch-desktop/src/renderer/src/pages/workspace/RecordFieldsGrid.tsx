import { Box, Portal, ScrollArea, Table, Textarea } from '@mantine/core';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Text12Medium, Text12Regular } from '../../components/base/text';
import { FieldReferenceStrip } from './FieldReferenceStrip';
import { FieldValuePanel, type FieldValueDiffKind, type FieldValueDisplayMode } from './FieldValuePanel';

export interface RecordFieldRow {
  fieldName: string;
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
}

const FLOATING_PANEL_GAP = 5;

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

export const RecordFieldsGrid = memo(function RecordFieldsGrid({ rows, footer }: RecordFieldsGridProps) {
  const [editingAnchorEl, setEditingAnchorEl] = useState<HTMLDivElement | null>(null);
  const [editingAnchorRect, setEditingAnchorRect] = useState<DOMRect | null>(null);

  const editingRow = useMemo(() => rows.find((row) => row.editing) ?? null, [rows]);

  useEffect(() => {
    if (!editingAnchorEl || !editingRow?.referenceValue || !editingRow.onUndo) {
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
            <Table.Th style={{ width: 280 }}>
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
                <Text12Medium
                  c="var(--fg-primary)"
                  style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
                >
                  {row.fieldName}
                </Text12Medium>
              </Table.Td>
              <Table.Td>
                <Box
                  style={{
                    borderLeft: `4px solid ${
                      row.diffKind === 'unreviewed'
                        ? 'var(--modified-needs-review-stroke)'
                        : row.diffKind === 'unpublished'
                          ? 'var(--modified-approved-stroke)'
                          : 'transparent'
                    }`,
                  }}
                >
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
                    />
                  )}
                </Box>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {footer}

      {editingRow?.referenceValue != null && editingRow.onUndo && editingAnchorRect && (
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
      )}
    </ScrollArea>
  );
});
