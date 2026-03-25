'use client';

import { Box, Menu, UnstyledButton } from '@mantine/core';
import type { LucideIcon } from 'lucide-react';
import { ChevronRightIcon } from 'lucide-react';
import { isValidElement, useRef, useState } from 'react';

export interface ContextMenuItem {
  type?: 'item' | 'divider' | 'submenu';
  label?: string;
  onClick?: () => void;
  color?: string;
  disabled?: boolean;
  icon?: LucideIcon | React.ReactNode;
  delete?: boolean;
  devtool?: boolean;
  /** Child items rendered in a hover submenu (only used when type === 'submenu') */
  children?: ContextMenuItem[];
}

interface ContextMenuProps {
  opened: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  items: ContextMenuItem[];
}

export function renderIcon(icon: LucideIcon | React.ReactNode | undefined) {
  if (!icon) return undefined;

  // Check if it's already a React element (already rendered JSX)
  if (isValidElement(icon)) {
    return icon;
  }

  // Otherwise assume it's a component (function or forwardRef) and render it
  const Icon = icon as LucideIcon;
  return <Icon size={16} />;
}

function SubmenuItem({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openSubmenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setSubmenuOpen(true);
  };

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setSubmenuOpen(false), 150);
  };

  return (
    <div style={{ position: 'relative' }} onMouseEnter={openSubmenu} onMouseLeave={scheduleClose}>
      <Menu.Item
        leftSection={renderIcon(item.icon)}
        rightSection={<ChevronRightIcon size={14} />}
        data-devtool={item.devtool || undefined}
      >
        {item.label}
      </Menu.Item>

      {submenuOpen && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: '100%',
            zIndex: 300,
            background: 'var(--mantine-color-white)',
            border: '1px solid var(--mantine-color-gray-2)',
            borderRadius: 'var(--mantine-radius-sm)',
            boxShadow: 'var(--mantine-shadow-md)',
            padding: '4px',
            minWidth: 180,
          }}
          onMouseEnter={openSubmenu}
          onMouseLeave={scheduleClose}
        >
          {item.children?.map((child, idx) => {
            if (child.type === 'divider') {
              return <div key={idx} style={{ borderTop: '1px solid var(--mantine-color-gray-2)', margin: '4px 0' }} />;
            }
            return (
              <UnstyledButton
                key={idx}
                disabled={child.disabled}
                data-delete={child.delete || undefined}
                data-devtool={child.devtool || undefined}
                onClick={() => {
                  child.onClick?.();
                  onClose();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 'var(--mantine-radius-sm)',
                  width: '100%',
                  fontSize: 'var(--mantine-font-size-sm)',
                  color: child.delete
                    ? 'var(--mantine-color-red-7)'
                    : child.devtool
                      ? 'var(--mantine-color-devTool-8)'
                      : 'var(--mantine-color-dark-9)',
                  opacity: child.disabled ? 0.5 : 1,
                  cursor: child.disabled ? 'default' : 'pointer',
                }}
                onMouseEnter={(e) => {
                  if (!child.disabled)
                    (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--mantine-color-gray-1)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                }}
              >
                {renderIcon(child.icon)}
                {child.label}
              </UnstyledButton>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContextMenuItems({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  return (
    <>
      {items.map((item, index) => {
        if (item.type === 'divider') {
          return <Menu.Divider key={index} />;
        }
        if (item.type === 'submenu' && item.children) {
          return <SubmenuItem key={index} item={item} onClose={onClose} />;
        }
        return (
          <Menu.Item
            key={index}
            leftSection={renderIcon(item.icon)}
            disabled={item.disabled}
            data-delete={item.delete || undefined}
            data-devtool={item.devtool || undefined}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.label}
          </Menu.Item>
        );
      })}
    </>
  );
}

export function ContextMenu({ opened, onClose, position, items }: ContextMenuProps) {
  return (
    <Menu opened={opened} onChange={(o) => !o && onClose()} position="bottom-start" withinPortal>
      <Menu.Target>
        <Box
          style={{
            position: 'fixed',
            top: position.y,
            left: position.x,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <ContextMenuItems items={items} onClose={onClose} />
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * Renders `ContextMenuItem[]` as Mantine `Menu.Item` components.
 * Useful for embedding shared menu items inside a standard `<Menu>` dropdown
 * (as opposed to the right-click positioned `<ContextMenu>`).
 * Submenus are flattened into labeled sections.
 */
export function renderMenuItems(items: ContextMenuItem[], onItemClick: () => void) {
  return items.map((item, index) => {
    if (item.type === 'divider') return <Menu.Divider key={index} />;
    if (item.type === 'submenu' && item.children) {
      return (
        <span key={index}>
          <Menu.Label>{item.label}</Menu.Label>
          {renderMenuItems(item.children, onItemClick)}
        </span>
      );
    }
    return (
      <Menu.Item
        key={index}
        leftSection={renderIcon(item.icon)}
        disabled={item.disabled}
        color={item.delete ? 'red' : item.devtool ? 'devTool' : undefined}
        onClick={() => {
          item.onClick?.();
          onItemClick();
        }}
      >
        {item.label}
      </Menu.Item>
    );
  });
}
