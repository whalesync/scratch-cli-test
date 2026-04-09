import { ConnectorIcon } from '@/components/ConnectorIcon';
import { getConnectorLogoUrl, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Box, Group, Menu, Progress } from '@mantine/core';
import { Download, FolderOpen, MoreHorizontal, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Workspace } from '../types/workspace';
import { ButtonSecondaryOutline, IconButtonGhost } from './base/buttons';
import { Text12Medium, Text16Medium, TextTitle4 } from './base/text';
import { StyledLucideIcon } from './icons/StyledLucideIcon';

function useConnectorServices(workspace: Workspace): string[] {
  return useMemo(() => {
    const folders = workspace.dataFolders ?? [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const f of folders) {
      const s = f.connectorService;
      if (s && !seen.has(s)) {
        seen.add(s);
        ordered.push(s);
      }
    }
    return ordered;
  }, [workspace.dataFolders]);
}

function ServiceIcons({ workspace, faded, size = 22 }: { workspace: Workspace; faded?: boolean; size?: number }) {
  const services = useConnectorServices(workspace);
  const { data: connectorsMetadata } = useConnectorsMetadata();
  if (services.length === 0) return null;
  return (
    <Group gap={6} style={{ opacity: faded ? 0.75 : 1 }}>
      {services.map((service) => (
        <ConnectorIcon
          key={service}
          connector={service}
          src={getConnectorLogoUrl(connectorsMetadata, service)}
          size={size}
        />
      ))}
    </Group>
  );
}

const cardBaseStyle: React.CSSProperties = {
  borderRadius: 10,
  padding: '16px 18px',
  marginBottom: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  transition: 'all .15s',
  position: 'relative',
};

/** Downloaded workspace — entire card opens it; hover shows the secondary-actions menu. */
export function DownloadedWorkspaceCard({
  workspace,
  onOpen,
  onRemove,
}: {
  workspace: Workspace;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        ...cardBaseStyle,
        background: '#fff',
        border: '1px solid var(--mantine-color-gray-2)',
        boxShadow: hovered
          ? '0 4px 12px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.06)'
          : '0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)',
        cursor: 'pointer',
      }}
    >
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text16Medium mb={6} lineClamp={1}>
          {workspace.name || 'Untitled Workspace'}
        </Text16Medium>
        <ServiceIcons workspace={workspace} />
      </Box>
      <Box onClick={(e) => e.stopPropagation()} style={{ visibility: hovered || menuOpen ? 'visible' : 'hidden' }}>
        <Menu position="bottom-end" withinPortal shadow="md" width={200} onChange={setMenuOpen}>
          <Menu.Target>
            <IconButtonGhost aria-label="Workspace actions">
              <StyledLucideIcon Icon={MoreHorizontal} size="sm" />
            </IconButtonGhost>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<StyledLucideIcon Icon={FolderOpen} size="sm" />} onClick={onOpen}>
              Open
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<StyledLucideIcon Icon={Trash2} size="sm" />} onClick={onRemove}>
              Remove local copy
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Box>
    </Box>
  );
}

/** Cloud workspace — exists on the server but not downloaded yet. */
export function CloudWorkspaceCard({
  workspace,
  onDownload,
  inGroup,
  isFirst,
}: {
  workspace: Workspace;
  onDownload: () => void;
  /** When true, the card drops its own dashed border — assumes a dashed wrapper supplies it. */
  inGroup?: boolean;
  /** When inGroup, suppress the top hairline divider for the first row. */
  isFirst?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onDownload}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDownload();
        }
      }}
      style={{
        ...cardBaseStyle,
        padding: '10px 14px',
        marginBottom: inGroup ? 0 : 6,
        borderRadius: inGroup ? 0 : 10,
        background: hovered ? 'var(--mantine-color-gray-1)' : inGroup ? 'transparent' : '#fbfbf9',
        border: inGroup
          ? 'none'
          : `1px dashed ${hovered ? 'var(--mantine-color-gray-5)' : 'var(--mantine-color-gray-4)'}`,
        borderTop: inGroup && !isFirst ? '1px solid var(--mantine-color-gray-2)' : undefined,
        cursor: 'pointer',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Group gap={12} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <TextTitle4
          c="var(--fg-secondary)"
          lineClamp={1}
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {workspace.name || 'Untitled Workspace'}
        </TextTitle4>
        <ServiceIcons workspace={workspace} faded size={18} />
      </Group>
      <Box onClick={(e) => e.stopPropagation()} style={{ visibility: hovered ? 'visible' : 'hidden' }}>
        <ButtonSecondaryOutline
          size="xs"
          leftSection={<StyledLucideIcon Icon={Download} size="sm" />}
          onClick={onDownload}
        >
          Download to…
        </ButtonSecondaryOutline>
      </Box>
    </Box>
  );
}

/** A card mid-transition (download or remove) — animates in place until completion. */
export function PendingWorkspaceCard({
  workspace,
  label,
  color = 'green',
}: {
  workspace: Workspace;
  label: string;
  color?: 'green' | 'gray';
}) {
  const tint = color === 'green' ? 'var(--mantine-color-green-0)' : 'var(--mantine-color-gray-1)';
  const border = color === 'green' ? 'var(--mantine-color-green-4)' : 'var(--mantine-color-gray-4)';
  const ink = color === 'green' ? 'var(--mantine-color-green-8)' : 'var(--fg-secondary)';
  return (
    <Box
      style={{
        ...cardBaseStyle,
        background: tint,
        border: `1px solid ${border}`,
        cursor: 'default',
      }}
    >
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text16Medium mb={8} lineClamp={1}>
          {workspace.name || 'Untitled Workspace'}
        </Text16Medium>
        <Group gap="sm" wrap="nowrap">
          <Progress value={100} animated striped color={color} size="sm" style={{ flex: 1 }} />
          <Text12Medium c={ink} style={{ minWidth: 86, textAlign: 'right' }}>
            {label}
          </Text12Medium>
        </Group>
      </Box>
    </Box>
  );
}

/** Backwards-compatible alias used by the cloud download flow. */
export function DownloadingWorkspaceCard({ workspace }: { workspace: Workspace }) {
  return <PendingWorkspaceCard workspace={workspace} label="Downloading…" color="green" />;
}
