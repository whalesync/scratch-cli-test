'use client';

import { ActionIconThreeDots } from '@/app/components/base/action-icons';
import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { Text13Medium, Text13Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import MainContent from '@/app/components/layouts/MainContent';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { Box, Group, Menu, Stack } from '@mantine/core';
import { PlusIcon } from 'lucide-react';

export default function ConnectionsPage() {
  const { workbook } = useActiveWorkbook();
  const { connectorAccounts, isLoading: isLoadingConnections } = useConnectorAccounts(workbook?.id);
  const { dataFolderGroups, isLoading: isLoadingFolders } = useDataFolders();
  const { metadata } = useConnectorsMetadata();

  const isLoading = isLoadingConnections || isLoadingFolders;

  // Build a map of connectorAccountId -> data folders for nesting
  const foldersByConnection = new Map<string, typeof dataFolderGroups[number]['dataFolders']>();
  for (const group of dataFolderGroups) {
    for (const folder of group.dataFolders) {
      if (folder.connectorAccountId) {
        const existing = foldersByConnection.get(folder.connectorAccountId) ?? [];
        existing.push(folder);
        foldersByConnection.set(folder.connectorAccountId, existing);
      }
    }
  }

  return (
    <MainContent>
      <MainContent.BasicHeader
        title="Connections"
        actions={
          <Group gap="sm" align="center">
            {workbook && (
              <Text13Regular c="var(--fg-secondary)">{workbook.name}</Text13Regular>
            )}
            <ButtonPrimarySolid
              leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />}
              onClick={() => {
                // No-op — backend action not yet wired
              }}
            >
              Connect new service
            </ButtonPrimarySolid>
          </Group>
        }
      />
      <MainContent.Body>
        <Box p="md">
          {isLoading && (
            <Text13Regular c="dimmed">Loading connections...</Text13Regular>
          )}

          {!isLoading && (!connectorAccounts || connectorAccounts.length === 0) && (
            <Text13Regular c="dimmed">No connections yet. Connect a service to get started.</Text13Regular>
          )}

          {!isLoading && connectorAccounts && connectorAccounts.length > 0 && (
            <Stack gap="lg">
              {connectorAccounts.map((connection) => {
                const folders = foldersByConnection.get(connection.id) ?? [];
                const serviceName = getServiceName(metadata, connection.service);
                return (
                  <Box
                    key={connection.id}
                    style={{
                      border: '1px solid var(--mantine-color-gray-3)',
                      borderRadius: 'var(--mantine-radius-sm)',
                    }}
                  >
                    {/* Connection row */}
                    <Group
                      justify="space-between"
                      wrap="nowrap"
                      p="sm"
                      style={{
                        borderBottom: folders.length > 0 ? '1px solid var(--mantine-color-gray-2)' : undefined,
                      }}
                    >
                      <Group gap="xs" wrap="nowrap">
                        <Text13Medium>{connection.displayName || serviceName}</Text13Medium>
                        {connection.displayName && (
                          <Text13Regular c="dimmed">{serviceName}</Text13Regular>
                        )}
                      </Group>
                      <ConnectionMenu />
                    </Group>

                    {/* Data folder rows */}
                    {folders.length > 0 && (
                      <Stack gap={0}>
                        {folders.map((folder, idx) => (
                          <Group
                            key={folder.id}
                            justify="space-between"
                            wrap="nowrap"
                            px="sm"
                            py="xs"
                            pl="xl"
                            style={{
                              borderBottom:
                                idx < folders.length - 1 ? '1px solid var(--mantine-color-gray-1)' : undefined,
                            }}
                          >
                            <Text13Regular>{folder.name}</Text13Regular>
                            <DataFolderMenu />
                          </Group>
                        ))}
                      </Stack>
                    )}
                  </Box>
                );
              })}
            </Stack>
          )}
        </Box>
      </MainContent.Body>
    </MainContent>
  );
}

function ConnectionMenu() {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIconThreeDots />
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => {}}>Choose tables</Menu.Item>
        <Menu.Item onClick={() => {}}>Reauthorize</Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" onClick={() => {}}>
          Remove
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function DataFolderMenu() {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIconThreeDots />
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => {}}>Advanced settings</Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" onClick={() => {}}>
          Unlink this table
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
