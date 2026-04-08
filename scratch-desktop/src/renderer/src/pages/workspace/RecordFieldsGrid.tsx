import { Box, ScrollArea, Table } from '@mantine/core';
import { memo } from 'react';
import { Text12Medium, Text12Regular } from '../../components/base/text';
import { FieldValuePanel, type FieldValueDiffKind } from './FieldValuePanel';

export interface RecordFieldRow {
  fieldName: string;
  value: string;
  fromValue?: string;
  diffKind: FieldValueDiffKind;
  onApprove?: () => void;
  onUndo?: () => void;
}

interface RecordFieldsGridProps {
  rows: RecordFieldRow[];
}

export const RecordFieldsGrid = memo(function RecordFieldsGrid({ rows }: RecordFieldsGridProps) {
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
        verticalSpacing="md"
        withRowBorders
        styles={{
          table: { tableLayout: 'fixed' },
          th: { backgroundColor: 'var(--bg-panel)', position: 'sticky', top: 0, zIndex: 1 },
          td: { verticalAlign: 'top' },
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
              <Table.Td style={{ width: 280 }}>
                <Text12Medium
                  c="var(--fg-primary)"
                  style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
                >
                  {row.fieldName}
                </Text12Medium>
              </Table.Td>
              <Table.Td>
                <FieldValuePanel
                  value={row.value}
                  fromValue={row.fromValue}
                  diffKind={row.diffKind}
                  onApprove={row.onApprove}
                  onUndo={row.onUndo}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
});
