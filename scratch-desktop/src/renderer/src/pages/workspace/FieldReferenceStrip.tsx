import { ActionIcon, Box, Group, Tooltip } from '@mantine/core';
import { Undo2 } from 'lucide-react';
import { memo } from 'react';
import { Text12Medium } from '../../components/base/text';

interface FieldReferenceStripProps {
  value: string;
  label?: string;
  onUndo?: () => void;
  /** When true, render the value on a single line, truncated to TRUNCATED_MAX_CHARS. */
  truncate?: boolean;
}

const MAX_CONTENT_HEIGHT = 'calc(1.45em * 5 + 10px)';
const ACTION_BUTTON_SIZE = 24;
const TRUNCATED_MAX_CHARS = 50;

function truncateOneLine(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > TRUNCATED_MAX_CHARS ? `${normalized.slice(0, TRUNCATED_MAX_CHARS)}...` : normalized;
}

export const FieldReferenceStrip = memo(function FieldReferenceStrip({
  value,
  label,
  onUndo,
  truncate = false,
}: FieldReferenceStripProps) {
  const renderedValue = truncate ? truncateOneLine(value) : value;
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
            ...(truncate
              ? { whiteSpace: 'nowrap', overflow: 'hidden' }
              : {
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: MAX_CONTENT_HEIGHT,
                  overflowY: 'auto',
                }),
          }}
        >
          {renderedValue}
        </Box>

        {onUndo && (
          <Box style={{ flexShrink: 0 }}>
            <Tooltip label="Discard unpublished change" position="left" withArrow zIndex={10020}>
              <ActionIcon
                variant="subtle"
                size="sm"
                c="red.5"
                aria-label="Discard unpublished change"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onUndo}
              >
                <Undo2 size={14} />
              </ActionIcon>
            </Tooltip>
          </Box>
        )}
      </Group>
    </Box>
  );
});
