import type { Rectangle } from '@glideapps/glide-data-grid';
import { Box, Divider, Portal, Stack, TextInput } from '@mantine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text12Medium, Text12Regular, TextMono9Regular } from '../../components/base/text';

interface FolderGridHeaderMenuProps {
  columnId: string;
  columnTitle: string;
  bounds: Rectangle | null;
  initialFilterValue: string;
  onShowNeedsReview: () => void;
  onShowApproved: () => void;
  onApplyTextFilter: (value: string) => void;
  onApproveField: () => void;
  onRejectField: () => void;
  onClose: () => void;
}

export function FolderGridHeaderMenu({
  columnId,
  columnTitle,
  bounds,
  initialFilterValue,
  onShowNeedsReview,
  onShowApproved,
  onApplyTextFilter,
  onApproveField,
  onRejectField,
  onClose,
}: FolderGridHeaderMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [filterValue, setFilterValue] = useState(initialFilterValue);

  useEffect(() => {
    setFilterValue(initialFilterValue);
  }, [columnTitle, initialFilterValue]);

  useEffect(() => {
    if (!bounds) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (menuRef.current?.contains(target)) {
        return;
      }

      onClose();
    };

    window.addEventListener('mousedown', handlePointerDown, true);
    return () => window.removeEventListener('mousedown', handlePointerDown, true);
  }, [bounds, onClose]);

  if (!bounds) {
    return null;
  }

  const menuWidth = 236;
  const left = Math.max(12, Math.min(bounds.x, window.innerWidth - menuWidth - 12));
  const top = Math.max(12, Math.min(bounds.y + bounds.height + 4, window.innerHeight - 320));

  const submitTextFilter = () => {
    onApplyTextFilter(filterValue);
    onClose();
  };

  return (
    <Portal target="#portal">
      <Box
        ref={menuRef}
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 10020,
          width: menuWidth,
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--fg-divider)',
          borderRadius: 10,
          boxShadow: '0 18px 32px rgba(15, 23, 42, 0.16)',
          overflow: 'hidden',
        }}
      >
        <Stack bg="var(--bg-selected)" gap="xs" style={{ borderBottom: '1px solid var(--fg-divider)' }} p={8}>
          <Text12Medium
            c="var(--fg-primary)"
            style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
          >
            {columnTitle ?? columnId}
          </Text12Medium>
          {columnTitle !== columnId && <TextMono9Regular c="dimmed">{columnId}</TextMono9Regular>}
        </Stack>
        <Stack gap={4} p={8}>
          <MenuAction onClick={onClose}>Sort A {'\u2192'} Z</MenuAction>
          <MenuAction onClick={onClose}>Sort Z {'\u2192'} A</MenuAction>

          <Divider my={4} />

          <MenuSectionLabel>Filters</MenuSectionLabel>
          <MenuAction
            onClick={() => {
              onShowNeedsReview();
              onClose();
            }}
          >
            Only show records that need review
          </MenuAction>
          <MenuAction
            onClick={() => {
              onShowApproved();
              onClose();
            }}
          >
            Only show records with approved changes
          </MenuAction>

          <Box px={8} py={4}>
            <Text12Regular c="var(--fg-muted)">Filter by...</Text12Regular>
            <TextInput
              placeholder="Type to filter..."
              size="xs"
              mt={6}
              value={filterValue}
              onChange={(event) => setFilterValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitTextFilter();
                }
              }}
            />
          </Box>

          <Divider my={4} />

          <MenuSectionLabel>{columnTitle}</MenuSectionLabel>
          <MenuAction
            onClick={() => {
              onApproveField();
              onClose();
            }}
            color="var(--highlight-border)"
          >
            Approve all changes in this field
          </MenuAction>
          <MenuAction
            onClick={() => {
              onRejectField();
              onClose();
            }}
            color="var(--mantine-color-red-7)"
          >
            Discard all changes in this field
          </MenuAction>
        </Stack>
      </Box>
    </Portal>
  );
}

function MenuSectionLabel({ children }: { children: ReactNode }) {
  return (
    <Box px={8} pt={2} pb={4}>
      <Text12Medium c="var(--fg-muted)">{children}</Text12Medium>
    </Box>
  );
}

function MenuAction({
  children,
  onClick,
  color = 'var(--mantine-color-text)',
}: {
  children: ReactNode;
  onClick: () => void;
  color?: string;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        border: 0,
        borderRadius: 8,
        backgroundColor: 'transparent',
        color,
        cursor: 'pointer',
        padding: '7px 8px',
        textAlign: 'left',
      }}
    >
      <Text12Regular c="inherit">{children}</Text12Regular>
    </Box>
  );
}
