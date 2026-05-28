import { ActionIcon, Badge, Group, Modal, Stack, Tooltip } from '@mantine/core';
import { FolderOpen } from 'lucide-react';
import { Text13Medium, TextMono9Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { getConnectorLogoUrl, useConnectorsMetadata } from '../../hooks/use-connectors-metadata';
import { relativeTime } from '../../lib/date-format';
import type { DataFolder } from '../../types/workspace';

const isMac = window.electron?.process?.platform === 'darwin';

interface DataFolderInfoModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  workingCopyPath: string;
  fileCount: number;
}

interface InfoRow {
  label: string;
  iso: string | null;
  relative: boolean;
}

export function DataFolderInfoModal({ opened, onClose, folder, workingCopyPath, fileCount }: DataFolderInfoModalProps) {
  const { data: metadata } = useConnectorsMetadata();
  const supportsIncrementalPull = folder.connectorService
    ? Boolean(metadata?.[folder.connectorService]?.incrementalPull)
    : false;

  const isReadOnly = Boolean((folder.options as { readOnly?: boolean } | null)?.readOnly);

  const rows: InfoRow[] = [
    { label: 'Created', iso: folder.createdAt, relative: true },
    { label: 'Last full pull', iso: folder.lastFullPullAt, relative: true },
  ];
  if (supportsIncrementalPull) {
    rows.push({ label: 'Last incremental pull', iso: folder.lastIncrementalPullAt, relative: true });
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="md"
      centered
      title={
        <Group gap={8} align="center" wrap="nowrap">
          <img
            src={getConnectorLogoUrl(metadata, folder.connectorService)}
            alt=""
            width={18}
            height={18}
            style={{ display: 'block', objectFit: 'contain', flexShrink: 0 }}
          />
          <Text13Medium c="var(--fg-primary)">{folder.name}</Text13Medium>
        </Group>
      }
    >
      <Stack gap="xs">
        <Stack gap={2}>
          <Text13Medium c="var(--fg-secondary)">Location</Text13Medium>
          <Group gap={6} align="flex-start" wrap="nowrap">
            <TextMono9Regular c="var(--fg-primary)" style={{ wordBreak: 'break-all', flex: 1, minWidth: 0 }}>
              {workingCopyPath}
            </TextMono9Regular>
            <Tooltip label={isMac ? 'Open in Finder' : 'Open in Explorer'} position="left" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={isMac ? 'Open in Finder' : 'Open in Explorer'}
                onClick={() => void window.scratchDesktop.showInFolder(workingCopyPath)}
              >
                <StyledLucideIcon Icon={FolderOpen} size={14} c="var(--fg-muted)" />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Stack>

        <Stack gap={2}>
          <Text13Medium c="var(--fg-secondary)">Total files</Text13Medium>
          <TextMono9Regular c="var(--fg-primary)">{fileCount.toLocaleString()}</TextMono9Regular>
        </Stack>

        {rows.map(({ label, iso, relative }) => (
          <Stack key={label} gap={2}>
            <Text13Medium c="var(--fg-secondary)">{label}</Text13Medium>
            {iso ? (
              <Group gap={6} align="baseline">
                <TextMono9Regular c="var(--fg-primary)">
                  {relative ? relativeTime(iso) : new Date(iso).toLocaleString()}
                </TextMono9Regular>
                {relative && (
                  <TextMono9Regular c="var(--fg-muted)">({new Date(iso).toLocaleString()})</TextMono9Regular>
                )}
              </Group>
            ) : (
              <TextMono9Regular c="var(--fg-muted)">Never</TextMono9Regular>
            )}
          </Stack>
        ))}

        {(isReadOnly || folder.isAssetTable || folder.lock) && (
          <Group gap="xs" mt="xs">
            {isReadOnly && (
              <Badge variant="light" color="gray" size="xs">
                Read-only
              </Badge>
            )}
            {folder.isAssetTable && (
              <Badge variant="light" color="blue">
                Asset table
              </Badge>
            )}
            {folder.lock && (
              <Badge variant="light" color="orange">
                Locked: {folder.lock}
              </Badge>
            )}
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
