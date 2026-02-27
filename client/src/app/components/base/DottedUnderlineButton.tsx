'use client';

import { UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import { Text12Regular, Text13Regular } from './text';

interface DottedUnderlineButtonProps {
  children: ReactNode;
  onClick?: () => void;
  c?: string;
  /** Text size variant. Defaults to 'sm' (13px). Use 'xs' for 12px. */
  size?: 'xs' | 'sm';
}

/**
 * A clickable text element styled with a dotted underline.
 * Used for inline interactive elements like schedule pickers or status displays
 * where a full button would be too heavy.
 */
export function DottedUnderlineButton({
  children,
  onClick,
  c = 'var(--fg-secondary)',
  size = 'sm',
}: DottedUnderlineButtonProps) {
  const TextComponent = size === 'xs' ? Text12Regular : Text13Regular;

  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        verticalAlign: 'baseline',
        padding: 0,
        lineHeight: 'inherit',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <TextComponent c={c} style={{ borderBottom: '1px dotted currentColor', paddingBottom: 1 }}>
        {children}
      </TextComponent>
    </UnstyledButton>
  );
}
