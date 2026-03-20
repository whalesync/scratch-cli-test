'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { TextMono12Regular } from '@/app/components/base/text';
import { Badge, Box, Group, UnstyledButton } from '@mantine/core';
import type { FileDiffStatus } from '@spinner/shared-types';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

export const INDENT_PX = 10;

// ============================================================================
// TreeRow — generic sidebar row with hover highlight, indent, and selection
// ============================================================================

interface TreeRowProps {
  onClick: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  indent?: number;
  /** When true, reserves space for the selection indicator border (3px left). */
  selectable?: boolean;
  isSelected?: boolean;
  children: ReactNode;
}

export function TreeRow({
  onClick,
  onContextMenu,
  indent = 0,
  selectable = false,
  isSelected = false,
  children,
}: TreeRowProps) {
  return (
    <UnstyledButton
      onClick={onClick}
      onContextMenu={onContextMenu}
      px="sm"
      py={4}
      style={{
        width: indent > 0 ? `calc(100% - ${INDENT_PX * indent}px)` : '100%',
        marginLeft: indent > 0 ? INDENT_PX * indent : 0,
        backgroundColor: isSelected ? 'var(--bg-selected)' : 'transparent',
        ...(selectable && {
          borderLeft: isSelected ? '3px solid var(--mantine-primary-color-filled)' : '3px solid transparent',
        }),
      }}
      __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
      styles={{
        root: {
          '&:hover': {
            backgroundColor: isSelected ? 'var(--bg-selected)' : 'var(--hover-bg)',
          },
        },
      }}
    >
      {children}
    </UnstyledButton>
  );
}

// ============================================================================
// ChevronToggle — expand/collapse chevron icon
// ============================================================================

interface ChevronToggleProps {
  isExpanded: boolean;
  onClick?: (e: MouseEvent) => void;
}

export function ChevronToggle({ isExpanded, onClick }: ChevronToggleProps) {
  if (onClick) {
    return (
      <Box
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          marginLeft: -4,
          marginRight: -4,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />
      </Box>
    );
  }

  return (
    <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />
  );
}

// ============================================================================
// DirtyIndicator — colored dot/symbol for file status
// ============================================================================

interface DirtyIndicatorProps {
  status?: FileDiffStatus;
}

export function DirtyIndicator({ status }: DirtyIndicatorProps) {
  const isDirty = status === 'modified' || status === 'added' || status === 'deleted';
  const isDeleted = status === 'deleted';

  return (
    <Box
      style={{
        width: 8,
        height: 8,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 700,
        lineHeight: 1,
        color: isDeleted
          ? 'var(--mantine-color-red-6)'
          : status === 'added'
            ? 'var(--mantine-color-green-6)'
            : isDirty
              ? 'var(--mantine-color-orange-6)'
              : 'transparent',
      }}
    >
      {isDeleted ? '\u00d7' : status === 'added' ? '+' : isDirty ? '\u2022' : ''}
    </Box>
  );
}

// ============================================================================
// DirtyBadge — orange count badge
// ============================================================================

interface DirtyBadgeProps {
  count: number;
}

export function DirtyBadge({ count }: DirtyBadgeProps) {
  if (count <= 0) return null;
  return (
    <Badge size="xs" variant="filled" color="orange">
      {count}
    </Badge>
  );
}

// ============================================================================
// FileNameCell — file name with dirty indicator
// ============================================================================

interface FileNameCellProps {
  name: string;
  status?: FileDiffStatus;
  isHidden?: boolean;
}

export function FileNameCell({ name, status, isHidden }: FileNameCellProps) {
  const isDeleted = status === 'deleted';
  const textColor = isDeleted ? 'var(--fg-secondary)' : 'var(--fg-primary)';

  return (
    <Group gap={6} wrap="nowrap">
      <DirtyIndicator status={status} />
      <TextMono12Regular c={textColor} truncate style={{ flex: 1, opacity: isHidden ? 0.5 : 1 }}>
        {name}
      </TextMono12Regular>
    </Group>
  );
}
