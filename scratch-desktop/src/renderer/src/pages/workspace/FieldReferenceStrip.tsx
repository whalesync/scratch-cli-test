import { ActionIcon, Box, Group } from '@mantine/core';
import { RotateCcw } from 'lucide-react';
import { memo } from 'react';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';

interface FieldReferenceStripProps {
  value: string;
  onUndo?: () => void;
}

const MAX_CONTENT_HEIGHT = 'calc(1.45em * 5 + 10px)';
const ACTION_BUTTON_SIZE = 24;

export const FieldReferenceStrip = memo(function FieldReferenceStrip({ value, onUndo }: FieldReferenceStripProps) {
  return (
    <Group align="center" gap={6} wrap="nowrap">
      <Box
        style={{
          flex: 1,
          minWidth: 0,
          backgroundColor: 'var(--bg-panel)',
          border: '1px solid var(--fg-divider)',
          padding: '6px 10px',
          minHeight: ACTION_BUTTON_SIZE,
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.45,
          color: 'var(--fg-muted)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: MAX_CONTENT_HEIGHT,
          overflowY: 'auto',
        }}
      >
        {value}
      </Box>

      {onUndo && (
        <Box style={{ padding: '2px 0' }}>
          <ActionIcon
            variant="transparent"
            size={ACTION_BUTTON_SIZE}
            radius={3}
            aria-label="Undo"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onUndo}
            styles={{
              root: {
                backgroundColor: 'var(--mantine-color-red-1)',
                color: 'var(--mantine-color-red-8)',
                border: '1px solid var(--mantine-color-red-3)',
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
              <StyledLucideIcon Icon={RotateCcw} size={14} strokeWidth={2.25} />
            </span>
          </ActionIcon>
        </Box>
      )}
    </Group>
  );
});
