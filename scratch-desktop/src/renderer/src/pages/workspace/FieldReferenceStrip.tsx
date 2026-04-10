import { ActionIcon, Box, Group, Tooltip } from '@mantine/core';
import { RotateCcw } from 'lucide-react';
import { memo } from 'react';
import { Text12Medium } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';

interface FieldReferenceStripProps {
  value: string;
  label?: string;
  onUndo?: () => void;
}

const MAX_CONTENT_HEIGHT = 'calc(1.45em * 5 + 10px)';
const ACTION_BUTTON_SIZE = 24;

export const FieldReferenceStrip = memo(function FieldReferenceStrip({
  value,
  label,
  onUndo,
}: FieldReferenceStripProps) {
  return (
    <Box
      style={{ padding: '8px 10px 10px', backgroundColor: 'var(--bg-panel)', border: '1px solid var(--fg-divider)' }}
    >
      {label && (
        <Text12Medium c="var(--fg-muted)" mb={6}>
          {label}
        </Text12Medium>
      )}
      <Group align="center" gap={8} wrap="nowrap">
        <Box
          style={{
            flex: 1,
            minWidth: 0,
            backgroundColor: 'var(--bg-base)',
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
          <Box style={{ flexShrink: 0 }}>
            <Tooltip label="Restore" position="left" withArrow zIndex={10020}>
              <ActionIcon
                variant="transparent"
                size={ACTION_BUTTON_SIZE}
                radius={3}
                aria-label="Restore"
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
            </Tooltip>
          </Box>
        )}
      </Group>
    </Box>
  );
});
