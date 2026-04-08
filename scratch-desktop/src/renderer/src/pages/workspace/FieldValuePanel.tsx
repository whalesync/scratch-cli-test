import { Box, Group, Stack, Textarea } from '@mantine/core';
import { diffWordsWithSpace } from 'diff';
import { memo } from 'react';
import { ButtonDangerLight, ButtonPrimaryLight, ButtonSecondaryOutline } from '../../components/base/buttons';

export type FieldValueDiffKind = 'unreviewed' | 'unpublished' | null;

interface FieldValuePanelProps {
  value: string;
  fromValue?: string;
  diffKind: FieldValueDiffKind;
  editing?: boolean;
  editValue?: string;
  onEditValueChange?: (value: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onApprove?: () => void;
  onUndo?: () => void;
  onEdit?: () => void;
}

const DIFF_WORKING_BG = '#dbeafe'; // blue-100  — unreviewed (w != d)
const DIFF_WORKING_BORDER = '#60a5fa'; // blue-400
const DIFF_UNPUBLISHED_BG = '#eff6ff'; // blue-50   — unpublished (d != m, w == d)
const DIFF_UNPUBLISHED_BORDER = '#93c5fd'; // blue-300

export const FieldValuePanel = memo(function FieldValuePanel({
  value,
  fromValue = '',
  diffKind,
  editing = false,
  editValue,
  onEditValueChange,
  onSave,
  onCancel,
  onApprove,
  onUndo,
  onEdit,
}: FieldValuePanelProps) {
  const bg =
    diffKind === 'unreviewed' ? DIFF_WORKING_BG : diffKind === 'unpublished' ? DIFF_UNPUBLISHED_BG : 'var(--bg-base)';
  const border =
    diffKind === 'unreviewed'
      ? DIFF_WORKING_BORDER
      : diffKind === 'unpublished'
        ? DIFF_UNPUBLISHED_BORDER
        : 'var(--fg-divider)';
  const hasActions = editing ? Boolean(onSave || onCancel) : Boolean(onApprove || onUndo || onEdit);

  return (
    <Group align="flex-start" gap="md" wrap="nowrap">
      <Box style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <Textarea
            autoFocus
            autosize
            minRows={4}
            value={editValue ?? value}
            onChange={(e) => onEditValueChange?.(e.currentTarget.value)}
            styles={
              diffKind !== null
                ? {
                    input: {
                      backgroundColor: bg,
                      borderLeft: `4px solid ${border}`,
                      borderRadius: 4,
                      fontFamily: 'monospace',
                      fontSize: 13,
                    },
                  }
                : { input: { fontFamily: 'monospace', fontSize: 13 } }
            }
          />
        ) : (
          <Box
            style={{
              backgroundColor: bg,
              borderLeft: `4px solid ${border}`,
              borderRadius: 4,
              padding: '12px 16px',
              fontFamily: 'monospace',
              fontSize: 13,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {diffKind !== null
              ? diffWordsWithSpace(fromValue, value).map((part, i) => {
                  if (part.removed) {
                    return (
                      <span key={i} style={{ color: '#dc2626', textDecoration: 'line-through' }}>
                        {part.value}
                      </span>
                    );
                  }
                  if (part.added) {
                    return (
                      <span key={i} style={{ color: '#16a34a', fontWeight: 700 }}>
                        {part.value}
                      </span>
                    );
                  }
                  return <span key={i}>{part.value}</span>;
                })
              : value}
          </Box>
        )}
      </Box>

      {hasActions && (
        <Stack gap="xs" style={{ flexShrink: 0, width: 100 }}>
          {editing ? (
            <>
              {onSave && (
                <ButtonPrimaryLight fullWidth onClick={onSave}>
                  Save
                </ButtonPrimaryLight>
              )}
              {onCancel && (
                <ButtonSecondaryOutline fullWidth onClick={onCancel}>
                  Cancel
                </ButtonSecondaryOutline>
              )}
            </>
          ) : (
            <>
              {onApprove && (
                <ButtonPrimaryLight fullWidth onClick={onApprove}>
                  Approve
                </ButtonPrimaryLight>
              )}
              {onUndo && (
                <ButtonDangerLight fullWidth onClick={onUndo}>
                  Undo
                </ButtonDangerLight>
              )}
              {onEdit && (
                <ButtonSecondaryOutline fullWidth onClick={onEdit}>
                  Edit
                </ButtonSecondaryOutline>
              )}
            </>
          )}
        </Stack>
      )}
    </Group>
  );
});
