'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import MainContent from '@/app/components/layouts/MainContent';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { workbookApi } from '@/lib/api/workbook';
import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
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
import { AdminWorkbookConnectionDto, AdminWorkbookDto, Service, WorkbookId } from '@spinner/shared-types';
import { BookOpenIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const PAGE_SIZE_OPTIONS = ['1', '10', '20', '25', '100', '1000'];

const ALL_SERVICES = Object.values(Service);

function serviceLabel(s: Service): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

// ── Connections modal ──────────────────────────────────────────────────────────

function ConnectionsModal({ workbook, onClose }: { workbook: AdminWorkbookDto | null; onClose: () => void }) {
  return (
    <Modal
      opened={!!workbook}
      onClose={onClose}
      title={workbook ? `Connections — ${workbook.name ?? '(unnamed)'}` : ''}
      size="lg"
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
                <Table.Th>Created</Table.Th>
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
                    <Text size="xs" c="dimmed">
                      {new Date(conn.createdAt).toLocaleDateString()}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ))}
    </Modal>
  );
}

// ── Service multiselect ────────────────────────────────────────────────────────

function ServiceMultiselect({ selected, onChange }: { selected: Service[]; onChange: (services: Service[]) => void }) {
  const toggle = (s: Service) => {
    onChange(selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s]);
  };

  return (
    <Group gap={4} wrap="wrap">
      {ALL_SERVICES.map((s) => {
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
  onMigrate,
  isMigrating,
  migrationError,
}: {
  workbook: AdminWorkbookDto;
  onShowConnections: (w: AdminWorkbookDto) => void;
  onMigrate: (id: WorkbookId) => void;
  isMigrating: boolean;
  migrationError: boolean;
}) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
          {workbook.id}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{workbook.name ?? '(unnamed)'}</Text>
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
        <Badge color={workbook.version === 1 ? 'gray' : 'blue'} variant="outline" size="sm">
          v{workbook.version}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {new Date(workbook.createdAt).toLocaleDateString()}
        </Text>
      </Table.Td>
      <Table.Td>
        {workbook.version >= 2 ? (
          <Tooltip label="Already on v2">
            <Badge color="blue" variant="light" size="sm">
              v2 ✓
            </Badge>
          </Tooltip>
        ) : (
          <Tooltip
            label={
              migrationError
                ? 'Migration failed — check server logs'
                : 'Migrate repo structure to v2 (one repo per connection)'
            }
          >
            <Button
              size="xs"
              variant="outline"
              color={migrationError ? 'red' : undefined}
              loading={isMigrating}
              onClick={() => onMigrate(workbook.id)}
            >
              → v2
            </Button>
          </Tooltip>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WorkbooksDevPage() {
  const { isAdmin, isLoading: isUserLoading } = useScratchPadUser();

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [serviceFilter, setServiceFilter] = useState<Service[]>([]);
  const [serviceMode, setServiceMode] = useState<'AND' | 'OR'>('OR');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const [workbooks, setWorkbooks] = useState<AdminWorkbookDto[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [migratingId, setMigratingId] = useState<WorkbookId | null>(null);
  const [errorId, setErrorId] = useState<WorkbookId | null>(null);

  const [connectionsWorkbook, setConnectionsWorkbook] = useState<AdminWorkbookDto | null>(null);

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

  const handleMigrateToV2 = async (workbookId: WorkbookId) => {
    setMigratingId(workbookId);
    setErrorId(null);
    try {
      await workbookApi.migrateToV2(workbookId);
      await fetchWorkbooks();
    } catch {
      setErrorId(workbookId);
    } finally {
      setMigratingId(null);
    }
  };

  if (isUserLoading) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Workbooks Admin" Icon={BookOpenIcon} />
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
        <MainContent.BasicHeader title="Workbooks Admin" Icon={BookOpenIcon} />
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
      <MainContent.BasicHeader title="Workbooks Admin" Icon={BookOpenIcon} />
      <MainContent.Body>
        <Stack gap="md">
          {/* Filters */}
          <Group gap="sm" align="flex-end">
            <TextInput
              label="Search"
              placeholder="Workbook or org name..."
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
              {total} workbook{total !== 1 ? 's' : ''}
            </Text>
          </Group>

          {/* Table */}
          {isLoading ? (
            <Center h="200px">
              <Group>
                <Loader size="sm" />
                <Text>Loading workbooks...</Text>
              </Group>
            </Center>
          ) : loadError ? (
            <Center h="200px">
              <Text c="red">Failed to load workbooks</Text>
            </Center>
          ) : workbooks.length === 0 ? (
            <Center h="200px">
              <Text c="dimmed">No workbooks found</Text>
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
                    <Table.Th>Version</Table.Th>
                    <Table.Th>Created</Table.Th>
                    <Table.Th>Actions</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {workbooks.map((workbook) => (
                    <WorkbookRow
                      key={workbook.id}
                      workbook={workbook}
                      onShowConnections={setConnectionsWorkbook}
                      onMigrate={handleMigrateToV2}
                      isMigrating={migratingId === workbook.id}
                      migrationError={errorId === workbook.id}
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
    </MainContent>
  );
}
