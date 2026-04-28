'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import MainContent from '@/app/components/layouts/MainContent';
import { renderMenuItems, type ContextMenuItem } from '@/app/workbook/[id]/components/shared/ContextMenu';
import { useConnectionMenu, type ConnectionMenuTarget } from '@/hooks/use-connection-menu';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useGitActions } from '@/hooks/use-git-actions';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { workbookApi } from '@/lib/api/workbook';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Modal,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { AdminWorkbookConnectionDto, AdminWorkbookDto, WorkbookId } from '@spinner/shared-types';
import { BookOpenIcon, FolderIcon, MoreVerticalIcon, ScissorsIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const PAGE_SIZE_OPTIONS = ['1', '10', '20', '25', '100', '1000'];

function serviceLabel(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

// ── Connection row actions (uses shared useConnectionMenu hook) ───────────────

function ConnectionRowActions({
  workbookId,
  connection,
  onShowDataFolders,
}: {
  workbookId: WorkbookId;
  connection: AdminWorkbookConnectionDto;
  onShowDataFolders: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const target: ConnectionMenuTarget = {
    id: connection.id,
    displayName: connection.displayName,
    service: connection.service,
    repoPath: connection.repoPath!,
    // authType is not available on AdminWorkbookConnectionDto, so reconnection will not be shown in admin view.
    // This is intentional as admins don't typically reauthorize connections.
  };

  const extraItemsAfter: ContextMenuItem[] = [
    { label: 'Show Data Folders', icon: FolderIcon, onClick: onShowDataFolders },
  ];

  const { items, modals } = useConnectionMenu(workbookId, target, {
    extraItemsAfter,
  });

  return (
    <>
      <Menu shadow="md" width={220} position="bottom-end" opened={menuOpen} onChange={setMenuOpen}>
        <Menu.Target>
          <ActionIcon variant="subtle" size="sm">
            <MoreVerticalIcon size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>{renderMenuItems(items, () => setMenuOpen(false))}</Menu.Dropdown>
      </Menu>
      {modals}
    </>
  );
}

// ── Connections modal ──────────────────────────────────────────────────────────

function ConnectionsModal({ workbook, onClose }: { workbook: AdminWorkbookDto | null; onClose: () => void }) {
  const [showDataFoldersConn, setShowDataFoldersConn] = useState<AdminWorkbookConnectionDto | null>(null);

  return (
    <>
      <Modal
        opened={!!workbook}
        onClose={onClose}
        title={workbook ? `Connections — ${workbook.name ?? '(unnamed)'}` : ''}
        size="xl"
        centered
      >
        {workbook &&
          (workbook.connections.length === 0 ? (
            <Text c="dimmed" size="sm">
              No connections
            </Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Service</Table.Th>
                  <Table.Th>Display name</Table.Th>
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Repo path</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {workbook.connections.map((conn) => (
                  <Table.Tr key={conn.id}>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <ConnectorIcon connector={conn.service} size={16} />
                        <Badge size="xs" variant="outline">
                          {conn.service}
                        </Badge>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{conn.displayName}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                        {conn.id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                        {conn.repoPath ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {new Date(conn.createdAt).toLocaleDateString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <ConnectionRowActions
                        workbookId={workbook.id}
                        connection={conn}
                        onShowDataFolders={() => setShowDataFoldersConn(conn)}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ))}
      </Modal>
      {showDataFoldersConn && workbook && (
        <DataFoldersModal
          opened={!!showDataFoldersConn}
          onClose={() => setShowDataFoldersConn(null)}
          workbookId={workbook.id}
          connectorAccountId={showDataFoldersConn.id}
          displayName={showDataFoldersConn.displayName}
        />
      )}
    </>
  );
}

// ── Data Folders modal ─────────────────────────────────────────────────────────

function DataFoldersModal({
  opened,
  onClose,
  workbookId,
  connectorAccountId,
  displayName,
}: {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  connectorAccountId: string;
  displayName: string;
}) {
  const { folders, isLoading } = useDataFolders(workbookId);

  // Filter out the data folders for just this connection
  const connFolders = folders.filter((f) => f.connectorAccountId === connectorAccountId);

  return (
    <Modal opened={opened} onClose={onClose} title={`Data Folders — ${displayName}`} size="xl" centered>
      {isLoading ? (
        <Center p="xl">
          <Loader size="sm" />
        </Center>
      ) : connFolders.length === 0 ? (
        <Text c="dimmed" size="sm">
          No data folders for this connection
        </Text>
      ) : (
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <Table stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Path</Table.Th>
                <Table.Th>Table ID</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {connFolders.map((f) => (
                <Table.Tr key={f.id}>
                  <Table.Td>
                    <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                      {f.id}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" style={{ fontFamily: 'monospace' }}>
                      {f.path || '/'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {f.tableId ? f.tableId.join(' / ') : '—'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Modal>
  );
}

// ── Service multiselect ────────────────────────────────────────────────────────

function ServiceMultiselect({ selected, onChange }: { selected: string[]; onChange: (services: string[]) => void }) {
  const { metadata } = useConnectorsMetadata();
  const allServices = metadata ? Object.keys(metadata) : [];
  const toggle = (s: string) => {
    onChange(selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s]);
  };

  return (
    <Group gap={4} wrap="wrap">
      {allServices.map((s) => {
        const active = selected.includes(s);
        return (
          <Tooltip key={s} label={serviceLabel(s)} position="top">
            <div
              onClick={() => toggle(s)}
              style={{
                cursor: 'pointer',
                padding: 3,
                borderRadius: 6,
                border: `1.5px solid ${active ? 'var(--mantine-color-blue-5)' : 'var(--mantine-color-gray-3)'}`,
                background: active ? 'var(--mantine-color-blue-0)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <ConnectorIcon connector={s} size={20} />
            </div>
          </Tooltip>
        );
      })}
    </Group>
  );
}

// ── Connection count cell with icons ──────────────────────────────────────────

function ConnectionCountCell({
  connections,
  onClick,
}: {
  connections: AdminWorkbookConnectionDto[];
  onClick: () => void;
}) {
  if (connections.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  // Deduplicate services for icon display (show each service icon once)
  const uniqueServices = [...new Set(connections.map((c) => c.service))];
  return (
    <Group gap={6} wrap="nowrap" style={{ cursor: 'pointer' }} onClick={onClick}>
      <Text size="sm" fw={500} style={{ minWidth: 16, textAlign: 'right' }}>
        {connections.length}
      </Text>
      {uniqueServices.map((s) => (
        <ConnectorIcon key={s} connector={s} size={22} />
      ))}
    </Group>
  );
}

// ── Workbook row ───────────────────────────────────────────────────────────────

function WorkbookRow({
  workbook,
  onShowConnections,
  onStripAllPrefixes,
}: {
  workbook: AdminWorkbookDto;
  onShowConnections: (w: AdminWorkbookDto) => void;
  onStripAllPrefixes: (workbookId: WorkbookId) => void;
}) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
          {workbook.id}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm">{workbook.name ?? '(unnamed)'}</Text>
          {workbook.isPendingDelete && (
            <Badge color="red" size="sm" variant="light">
              Pending Deletion
            </Badge>
          )}
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {workbook.organizationName}
        </Text>
      </Table.Td>
      <Table.Td>
        <ConnectionCountCell connections={workbook.connections} onClick={() => onShowConnections(workbook)} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {new Date(workbook.createdAt).toLocaleDateString()}
        </Text>
      </Table.Td>
      <Table.Td>
        <Menu shadow="md" width={220} position="bottom-end">
          <Menu.Target>
            <ActionIcon variant="subtle" size="sm">
              <MoreVerticalIcon size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Migration</Menu.Label>
            <Menu.Item leftSection={<ScissorsIcon size={14} />} onClick={() => onStripAllPrefixes(workbook.id)}>
              Strip All Connection Prefixes
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Table.Td>
    </Table.Tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WorkbooksDevPage() {
  const { isAdmin, isLoading: isUserLoading } = useScratchPadUser();

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [serviceFilter, setServiceFilter] = useState<string[]>([]);
  const [serviceMode, setServiceMode] = useState<'AND' | 'OR'>('OR');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const [workbooks, setWorkbooks] = useState<AdminWorkbookDto[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [connectionsWorkbook, setConnectionsWorkbook] = useState<AdminWorkbookDto | null>(null);

  // Only used for workbook-level "Strip All Connection Prefixes" action
  const gitActions = useGitActions();

  const fetchWorkbooks = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    try {
      const result = await workbookApi.adminListWorkbooks({
        search: debouncedSearch || undefined,
        services: serviceFilter.length ? serviceFilter : undefined,
        serviceMode: serviceFilter.length > 1 ? serviceMode : undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      setWorkbooks(result.workbooks);
      setTotal(result.total);
      setConnectionsWorkbook((prev) => (prev ? (result.workbooks.find((w) => w.id === prev.id) ?? prev) : null));
    } catch {
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch, serviceFilter, serviceMode, page, pageSize]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, serviceFilter, serviceMode, pageSize]);

  useEffect(() => {
    if (isAdmin) fetchWorkbooks();
  }, [isAdmin, fetchWorkbooks]);

  if (isUserLoading) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Workspaces Admin" Icon={BookOpenIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Group>
              <Loader size="sm" />
              <Text>Loading...</Text>
            </Group>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  if (!isAdmin) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Workspaces Admin" Icon={BookOpenIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Text c="red">You do not have permission to view this page. Admin access is required.</Text>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  const totalPages = Math.ceil(total / pageSize);

  return (
    <MainContent>
      <MainContent.BasicHeader title="Workspaces Admin" Icon={BookOpenIcon} />
      <MainContent.Body>
        <Stack gap="md">
          {/* Filters */}
          <Group gap="sm" align="flex-end">
            <TextInput
              label="Search"
              placeholder="Workspace or org name..."
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              style={{ flex: 1, maxWidth: 360 }}
              size="sm"
            />
            <Stack gap={4}>
              <Text size="xs" c="dimmed">
                Connector filter
              </Text>
              <ServiceMultiselect selected={serviceFilter} onChange={setServiceFilter} />
            </Stack>
            {serviceFilter.length > 1 && (
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  Mode
                </Text>
                <SegmentedControl
                  size="xs"
                  value={serviceMode}
                  onChange={(v) => setServiceMode(v as 'AND' | 'OR')}
                  data={[
                    { label: 'OR', value: 'OR' },
                    { label: 'AND', value: 'AND' },
                  ]}
                />
              </Stack>
            )}
            <Stack gap={4}>
              <Text size="xs" c="dimmed">
                Per page
              </Text>
              <Select
                data={PAGE_SIZE_OPTIONS}
                value={String(pageSize)}
                onChange={(v) => v && setPageSize(Number(v))}
                size="xs"
                w={80}
              />
            </Stack>
            <Text size="sm" c="dimmed" style={{ alignSelf: 'center', paddingBottom: 4 }}>
              {total} workspace{total !== 1 ? 's' : ''}
            </Text>
          </Group>

          {/* Table */}
          {isLoading ? (
            <Center h="200px">
              <Group>
                <Loader size="sm" />
                <Text>Loading workspaces...</Text>
              </Group>
            </Center>
          ) : loadError ? (
            <Center h="200px">
              <Text c="red">Failed to load workspaces</Text>
            </Center>
          ) : workbooks.length === 0 ? (
            <Center h="200px">
              <Text c="dimmed">No workspaces found</Text>
            </Center>
          ) : (
            <>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>ID</Table.Th>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Org</Table.Th>
                    <Table.Th>Connections</Table.Th>
                    <Table.Th>Created</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {workbooks.map((workbook) => (
                    <WorkbookRow
                      key={workbook.id}
                      workbook={workbook}
                      onShowConnections={setConnectionsWorkbook}
                      onStripAllPrefixes={(id) => void gitActions.handleStripAllPrefixes(id)}
                    />
                  ))}
                </Table.Tbody>
              </Table>

              {totalPages > 1 && (
                <Group justify="center">
                  <Pagination total={totalPages} value={page} onChange={setPage} size="sm" />
                </Group>
              )}
            </>
          )}
        </Stack>
      </MainContent.Body>

      <ConnectionsModal workbook={connectionsWorkbook} onClose={() => setConnectionsWorkbook(null)} />
      {/* Workbook-level strip prefix results modal */}
      <Modal
        opened={gitActions.stripPrefixModalOpen}
        onClose={() => gitActions.setStripPrefixModalOpen(false)}
        title="Strip Connection Prefix Results"
        size="lg"
        centered
      >
        {gitActions.stripPrefixData && (
          <Stack>
            {gitActions.stripPrefixData.map((r) => (
              <Stack key={r.connectorAccountId} gap={2}>
                <Text size="sm" fw={600}>
                  {r.displayName}
                </Text>
                <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                  {r.repoId}
                </Text>
                {r.error ? (
                  <Text size="xs" c="red">
                    Error: {r.error}
                  </Text>
                ) : (
                  <Text size="xs" c="green">
                    Case {r.case} — {r.foldersUpdated} folder{r.foldersUpdated !== 1 ? 's' : ''} updated
                  </Text>
                )}
              </Stack>
            ))}
            <Group justify="flex-end">
              <Button onClick={() => gitActions.setStripPrefixModalOpen(false)}>Close</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </MainContent>
  );
}
