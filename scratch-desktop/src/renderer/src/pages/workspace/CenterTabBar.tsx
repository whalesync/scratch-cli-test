import { IconButtonGhost } from '@/components/base/buttons';
import { Text13Medium } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Group } from '@mantine/core';
import { Sparkles, X, type LucideIcon } from 'lucide-react';
import type { CenterTab } from '../../stores/workspace-ui-store';

interface CenterTabBarProps {
  activeTab: CenterTab;
  onSelectChat: () => void;
  /** Label for the data tab, or `null` when no folder/panel is open (no data tab). */
  dataTabLabel: string | null;
  dataTabIcon: LucideIcon;
  onSelectData: () => void;
  onCloseData: () => void;
}

/**
 * Conductor-style center-pane tab strip. The Chat tab is always present and is
 * the primary surface; the Data tab appears beside it when a folder is selected
 * (its grid) or a connections/publish-history/validation panel is open.
 */
export function CenterTabBar({
  activeTab,
  onSelectChat,
  dataTabLabel,
  dataTabIcon,
  onSelectData,
  onCloseData,
}: CenterTabBarProps) {
  return (
    <Group
      gap={0}
      h={34}
      px={6}
      align="stretch"
      wrap="nowrap"
      style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0 }}
    >
      <CenterTab icon={Sparkles} label="Chat" active={activeTab === 'chat'} onSelect={onSelectChat} />
      {dataTabLabel !== null && (
        <CenterTab
          icon={dataTabIcon}
          label={dataTabLabel}
          active={activeTab === 'data'}
          onSelect={onSelectData}
          onClose={onCloseData}
        />
      )}
    </Group>
  );
}

function CenterTab({
  icon,
  label,
  active,
  onSelect,
  onClose,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <Group
      role="tab"
      aria-selected={active}
      gap={6}
      px={12}
      align="center"
      wrap="nowrap"
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        maxWidth: 220,
        borderBottom: active ? '2px solid var(--mantine-color-green-7)' : '2px solid transparent',
        backgroundColor: active ? 'var(--bg-base)' : 'transparent',
        userSelect: 'none',
      }}
    >
      <StyledLucideIcon Icon={icon} size="sm" c={active ? 'var(--fg-primary)' : 'var(--fg-muted)'} />
      <Text13Medium
        c={active ? 'var(--fg-primary)' : 'var(--fg-secondary)'}
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {label}
      </Text13Medium>
      {onClose && (
        <IconButtonGhost
          size="compact-xs"
          aria-label="Close tab"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <StyledLucideIcon Icon={X} size="xs" />
        </IconButtonGhost>
      )}
    </Group>
  );
}
