import { Code, Group, Tooltip, UnstyledButton } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { StyledLucideIcon } from '../icons/StyledLucideIcon';

interface CopyableCodeProps {
  value: string;
  /** Font size override for the rendered code, in px. Defaults to 11. */
  fontSize?: number;
}

/**
 * Inline-monospace value with a click-to-copy affordance. Used for IDs, SHAs,
 * file paths — anywhere we want to make a "select-and-copy" interaction
 * faster than highlight-and-Cmd-C.
 */
export function CopyableCode({ value, fontSize = 11 }: CopyableCodeProps) {
  const clipboard = useClipboard({ timeout: 1500 });
  return (
    <Group gap={4} wrap="nowrap" align="center">
      <Code style={{ fontSize, wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{value}</Code>
      <Tooltip label={clipboard.copied ? 'Copied' : 'Copy'} withArrow>
        <UnstyledButton
          onClick={() => clipboard.copy(value)}
          style={{ flexShrink: 0, padding: 2, display: 'flex' }}
          aria-label="Copy to clipboard"
        >
          <StyledLucideIcon
            Icon={clipboard.copied ? CheckIcon : CopyIcon}
            size={12}
            c={clipboard.copied ? 'var(--mantine-color-green-7)' : 'var(--fg-muted)'}
          />
        </UnstyledButton>
      </Tooltip>
    </Group>
  );
}
