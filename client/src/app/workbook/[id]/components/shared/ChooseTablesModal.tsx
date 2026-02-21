'use client';

import { Badge } from '@/app/components/base/badge';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/app/components/base/text';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useWorkbook } from '@/hooks/use-workbook';
import { connectorAccountsApi } from '@/lib/api/connector-accounts';
import { dataFolderApi } from '@/lib/api/data-folder';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { TableList, TablePreview, TableSearchResult } from '@/types/server-entities/table-list';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  List,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ConnectorAccount, DataFolderId, WorkbookId } from '@spinner/shared-types';
import { Service, TableDiscoveryMode } from '@spinner/shared-types';
import { AlertTriangleIcon, SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';

const FILTER_SUPPORTED_SERVICES = new Set([Service.NOTION, Service.AIRTABLE]);

const DISABLED_MESSAGES: Partial<Record<Service, string>> = {
  [Service.SUPABASE]: "This table doesn't have a unique value column (primary key).",
};
const DEFAULT_DISABLED_MESSAGE = 'Not available';

const DISABLED_CREATES_MESSAGES: Partial<Record<Service, string>> = {
  [Service.SUPABASE]: "This table doesn't have an auto generated primary key, creates are not supported",
};
const DEFAULT_DISABLED_CREATES_MESSAGE = 'Creates are not supported';

interface ChooseTablesModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  connectorAccount: ConnectorAccount;
}

export function ChooseTablesModal({ opened, onClose, workbookId, connectorAccount }: ChooseTablesModalProps) {
  const { data, isLoading, isValidating } = useSWR<TableList>(
    opened ? SWR_KEYS.connectorAccounts.tables(workbookId, connectorAccount.id) : null,
    () => connectorAccountsApi.listTables(workbookId, connectorAccount.id),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );
  const discoveryMode = data?.discoveryMode ?? TableDiscoveryMode.LIST;
  const isSearchMode = discoveryMode === TableDiscoveryMode.SEARCH;
  const availableTables = useMemo(() => data?.tables || [], [data?.tables]);
  const tablesLoading = isLoading || (isValidating && availableTables.length === 0);

  // Search state for SEARCH mode
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm] = useDebouncedValue(searchTerm, 300);

  const { data: searchData, isLoading: searchLoading } = useSWR<TableSearchResult>(
    opened && isSearchMode && debouncedSearchTerm
      ? SWR_KEYS.connectorAccounts.searchTables(workbookId, connectorAccount.id, debouncedSearchTerm)
      : null,
    () => connectorAccountsApi.searchTables(workbookId, connectorAccount.id, debouncedSearchTerm),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      keepPreviousData: true,
    },
  );

  const { dataFolderGroups, refresh: refreshDataFolders } = useDataFolders();
  const { addLinkedDataFolder } = useWorkbook(workbookId);

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(new Set());
  const [filterValues, setFilterValues] = useState<Map<string, string>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [foldersToRemove, setFoldersToRemove] = useState<{ id: DataFolderId; name: string; tableId: string[] }[]>([]);
  const [dirtyFileCount, setDirtyFileCount] = useState(0);

  const supportsFilter = FILTER_SUPPORTED_SERVICES.has(connectorAccount.service);

  // Get currently linked data folders for this connector account
  const linkedFolders = useMemo(() => {
    const folders: { id: DataFolderId; name: string; tableId: string[]; filter: string | null }[] = [];
    dataFolderGroups.forEach((group) => {
      group.dataFolders.forEach((folder) => {
        if (folder.connectorAccountId === connectorAccount.id) {
          folders.push({ id: folder.id, name: folder.name, tableId: folder.tableId, filter: folder.filter });
        }
      });
    });
    return folders;
  }, [dataFolderGroups, connectorAccount.id]);

  // Build TablePreview[] from linked folders (for SEARCH mode -- these always show so user can unlink)
  const linkedTablePreviews: TablePreview[] = useMemo(
    () =>
      linkedFolders.map((folder) => ({
        id: { wsId: folder.name, remoteId: folder.tableId },
        displayName: folder.name,
      })),
    [linkedFolders],
  );

  // Search results (including already-linked tables, which appear pre-checked)
  const searchResultTables: TablePreview[] = useMemo(() => {
    return searchData?.tables ?? [];
  }, [searchData]);

  // Build a set of disabled table keys for quick lookup
  const disabledTableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const table of availableTables) {
      if (table.disabled) {
        keys.add(table.id.remoteId.join('/'));
      }
    }
    return keys;
  }, [availableTables]);

  // Initialize state when modal opens
  useEffect(() => {
    if (opened) {
      const linked = new Set<string>();
      const initialFilters = new Map<string, string>();
      linkedFolders.forEach((folder) => {
        if (folder.tableId.length > 0) {
          const key = folder.tableId.join('/');
          if (!disabledTableKeys.has(key)) {
            linked.add(key);
          }
          if (folder.filter) {
            initialFilters.set(key, folder.filter);
          }
        }
      });
      setSelectedTableIds(linked);
      setFilterValues(initialFilters);
      setSearchTerm('');
      setStep(1);
      setShowConfirmation(false);
    }
  }, [opened, linkedFolders, disabledTableKeys]);

  const handleToggleTable = (table: TablePreview) => {
    if (table.disabled) return;
    const tableKey = table.id.remoteId.join('/');
    setSelectedTableIds((prev) => {
      const next = new Set(prev);
      if (next.has(tableKey)) {
        next.delete(tableKey);
      } else {
        next.add(tableKey);
      }
      return next;
    });
  };

  const handleFilterChange = useCallback((tableKey: string, value: string) => {
    setFilterValues((prev) => {
      const next = new Map(prev);
      if (value) {
        next.set(tableKey, value);
      } else {
        next.delete(tableKey);
      }
      return next;
    });
  }, []);

  // Compute tables to add and remove (used in step 2 display and save)
  const allKnownTables = useMemo(
    () => (isSearchMode ? [...linkedTablePreviews, ...searchResultTables] : availableTables),
    [isSearchMode, linkedTablePreviews, searchResultTables, availableTables],
  );

  const currentlyLinkedKeys = useMemo(() => new Set(linkedFolders.map((f) => f.tableId.join('/'))), [linkedFolders]);

  const tablesToAdd = useMemo(
    () =>
      allKnownTables.filter((table) => {
        const tableKey = table.id.remoteId.join('/');
        return selectedTableIds.has(tableKey) && !currentlyLinkedKeys.has(tableKey);
      }),
    [allKnownTables, selectedTableIds, currentlyLinkedKeys],
  );

  const pendingFoldersToRemove = useMemo(
    () =>
      linkedFolders.filter((folder) => {
        const folderKey = folder.tableId.join('/');
        return !selectedTableIds.has(folderKey);
      }),
    [linkedFolders, selectedTableIds],
  );

  // Tables that remain selected (both existing and new) for step 2 display
  const selectedTablesForStep2 = useMemo(() => {
    const tables: { tableKey: string; displayName: string; isNew: boolean; isRemoved: boolean }[] = [];
    const seen = new Set<string>();

    // Existing linked folders first
    linkedFolders.forEach((folder) => {
      const key = folder.tableId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      const isRemoved = !selectedTableIds.has(key);
      tables.push({ tableKey: key, displayName: folder.name, isNew: false, isRemoved });
    });

    // Newly added tables
    tablesToAdd.forEach((table) => {
      const key = table.id.remoteId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      tables.push({ tableKey: key, displayName: table.displayName, isNew: true, isRemoved: false });
    });

    return tables;
  }, [linkedFolders, selectedTableIds, tablesToAdd]);

  const handleNext = () => {
    setStep(2);
  };

  const handleBack = () => {
    setStep(1);
  };

  const handleSave = async () => {
    // If there are folders to remove, check for dirty files and show confirmation
    if (pendingFoldersToRemove.length > 0 && !showConfirmation) {
      try {
        const dirtyFiles = (await workbookApi.getStatus(workbookId)) as { path: string }[];

        const folderNames = new Set(pendingFoldersToRemove.map((f) => f.name));
        const dirtyInRemovedFolders = dirtyFiles.filter((file) => {
          return Array.from(folderNames).some(
            (folderName) => file.path.startsWith(`${folderName}/`) || file.path.includes(`/${folderName}/`),
          );
        });

        setFoldersToRemove(pendingFoldersToRemove);
        setDirtyFileCount(dirtyInRemovedFolders.length);
        setShowConfirmation(true);
        return;
      } catch (error) {
        console.error('Failed to check dirty files:', error);
      }
    }

    setIsSaving(true);
    try {
      // Add new tables (with optional filter)
      for (const table of tablesToAdd) {
        const tableKey = table.id.remoteId.join('/');
        const filter = filterValues.get(tableKey)?.trim() || undefined;
        await addLinkedDataFolder(table.id.remoteId, table.displayName, connectorAccount.id, filter);
      }

      // Update filters on existing tables that changed
      for (const folder of linkedFolders) {
        const folderKey = folder.tableId.join('/');
        if (!selectedTableIds.has(folderKey)) continue; // being removed
        const newFilter = filterValues.get(folderKey)?.trim() || null;
        const existingFilter = folder.filter || null;
        if (newFilter !== existingFilter) {
          await dataFolderApi.update(folder.id, { filter: newFilter });
        }
      }

      // Remove unselected tables
      const toRemove = showConfirmation ? foldersToRemove : pendingFoldersToRemove;
      for (const folder of toRemove) {
        await dataFolderApi.delete(folder.id);
      }

      await refreshDataFolders();

      setShowConfirmation(false);
      onClose();
    } catch (error) {
      console.error('Failed to update tables:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelConfirmation = () => {
    setShowConfirmation(false);
    setFoldersToRemove([]);
    setDirtyFileCount(0);
  };

  const connectionName = connectorAccount.displayName;

  const connectorTitle = (
    <Group gap="xs" align="center">
      <ConnectorIcon connector={connectorAccount.service} size={20} p={0} />
      <Text fw={600}>{connectionName}</Text>
    </Group>
  );

  const modalTitle = showConfirmation ? 'Confirm removal' : connectorTitle;

  // Step 1: Table selection (LIST mode)
  const renderStep1List = () => (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Text13Regular c="dimmed">Pick the tables from {connectionName} to make available in Scratch.</Text13Regular>
        <Text12Regular c="dimmed">Step 1 of 2</Text12Regular>
      </Group>

      {tablesLoading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text13Regular c="dimmed">Loading tables...</Text13Regular>
        </Group>
      ) : availableTables.length === 0 ? (
        <Text13Regular c="dimmed" ta="center" py="xl">
          No tables available for this connection
        </Text13Regular>
      ) : (
        <ScrollArea.Autosize mah={400}>
          <Stack gap="xs">
            {availableTables.map((table) => {
              const tableKey = table.id.remoteId.join('/');
              const isChecked = selectedTableIds.has(tableKey);

              return (
                <Checkbox
                  key={tableKey}
                  label={
                    <Group gap={6} align="center" wrap="nowrap">
                      <Text13Regular c={table.disabled ? 'dimmed' : undefined}>{table.displayName}</Text13Regular>
                      {table.disabled && (
                        <Tooltip
                          label={DISABLED_MESSAGES[connectorAccount.service] ?? DEFAULT_DISABLED_MESSAGE}
                          multiline
                          maw={250}
                          position="right"
                        >
                          <AlertTriangleIcon size={14} color="var(--mantine-color-dimmed)" />
                        </Tooltip>
                      )}
                      {!table.disabled && table.disabledCreates && (
                        <Tooltip
                          label={
                            DISABLED_CREATES_MESSAGES[connectorAccount.service] ?? DEFAULT_DISABLED_CREATES_MESSAGE
                          }
                          multiline
                          maw={250}
                          position="right"
                        >
                          <AlertTriangleIcon size={14} color="var(--mantine-color-yellow-6)" />
                        </Tooltip>
                      )}
                    </Group>
                  }
                  checked={isChecked}
                  disabled={table.disabled}
                  onChange={() => handleToggleTable(table)}
                />
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
        <ButtonPrimaryLight onClick={handleNext} disabled={selectedTableIds.size === 0}>
          Next
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Step 1: Table selection (SEARCH mode)
  const renderStep1Search = () => (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Text13Regular c="dimmed">Search for databases in {connectionName} to make available in Scratch.</Text13Regular>
        <Text12Regular c="dimmed">Step 1 of 2</Text12Regular>
      </Group>

      {tablesLoading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text13Regular c="dimmed">Loading...</Text13Regular>
        </Group>
      ) : (
        <>
          {!debouncedSearchTerm && linkedTablePreviews.length > 0 && (
            <Stack gap="xs">
              <Text13Medium>Linked tables</Text13Medium>
              {linkedTablePreviews.map((table) => {
                const tableKey = table.id.remoteId.join('/');
                const isChecked = selectedTableIds.has(tableKey);
                return (
                  <Checkbox
                    key={tableKey}
                    label={<Text13Regular>{table.displayName}</Text13Regular>}
                    checked={isChecked}
                    onChange={() => handleToggleTable(table)}
                  />
                );
              })}
            </Stack>
          )}

          <TextInput
            placeholder="Search for databases..."
            leftSection={<SearchIcon size={16} />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.currentTarget.value)}
            autoFocus
          />

          {searchLoading && debouncedSearchTerm ? (
            <Group justify="center" py="md">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Searching...</Text13Regular>
            </Group>
          ) : debouncedSearchTerm && searchResultTables.length > 0 ? (
            <>
              <ScrollArea.Autosize mah={300}>
                <Stack gap="xs">
                  {searchResultTables.map((table) => {
                    const tableKey = table.id.remoteId.join('/');
                    const isChecked = selectedTableIds.has(tableKey);
                    return (
                      <Checkbox
                        key={tableKey}
                        label={
                          <Group gap={6} align="center" wrap="nowrap">
                            <Text13Regular c={table.disabled ? 'dimmed' : undefined}>{table.displayName}</Text13Regular>
                            {table.disabled && (
                              <Tooltip
                                label={DISABLED_MESSAGES[connectorAccount.service] ?? DEFAULT_DISABLED_MESSAGE}
                                multiline
                                maw={250}
                                position="right"
                              >
                                <AlertTriangleIcon size={14} color="var(--mantine-color-dimmed)" />
                              </Tooltip>
                            )}
                            {!table.disabled && table.disabledCreates && (
                              <Tooltip
                                label={
                                  DISABLED_CREATES_MESSAGES[connectorAccount.service] ??
                                  DEFAULT_DISABLED_CREATES_MESSAGE
                                }
                                multiline
                                maw={250}
                                position="right"
                              >
                                <AlertTriangleIcon size={14} color="var(--mantine-color-yellow-6)" />
                              </Tooltip>
                            )}
                          </Group>
                        }
                        checked={isChecked}
                        disabled={table.disabled}
                        onChange={() => handleToggleTable(table)}
                      />
                    );
                  })}
                </Stack>
              </ScrollArea.Autosize>
              {searchData?.hasMore && (
                <Text12Regular c="dimmed">
                  Showing first {searchResultTables.length} results. Refine your search for more specific results.
                </Text12Regular>
              )}
            </>
          ) : debouncedSearchTerm ? (
            <Text13Regular c="dimmed" ta="center" py="md">
              No databases found
            </Text13Regular>
          ) : (
            <Text13Regular c="dimmed" ta="center" py="md">
              Type to search for databases
            </Text13Regular>
          )}
        </>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
        <ButtonPrimaryLight onClick={handleNext} disabled={selectedTableIds.size === 0}>
          Next
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Step 2: Configure table settings
  const renderStep2 = () => (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Text13Regular c="dimmed">
          {supportsFilter ? 'Configure settings for selected tables.' : 'Review selected tables.'}
        </Text13Regular>
        <Text12Regular c="dimmed">Step 2 of 2</Text12Regular>
      </Group>

      <ScrollArea.Autosize mah={400}>
        <Stack gap="sm">
          {selectedTablesForStep2.map((entry, index) => (
            <Box key={entry.tableKey}>
              {index > 0 && <Divider mb="sm" />}
              <Stack gap="xs">
                <Group gap="xs" align="center">
                  <Text13Medium c={entry.isRemoved ? 'dimmed' : undefined}>{entry.displayName}</Text13Medium>
                  {entry.isRemoved && <Badge color="red">Will be removed</Badge>}
                  {entry.isNew && <Badge color="green">New</Badge>}
                </Group>

                {!entry.isRemoved && supportsFilter && (
                  <Textarea
                    label="Filter (optional)"
                    description="Leave blank to pull all records, or enter a filter expression to limit which records are pulled."
                    placeholder="Enter filter expression..."
                    value={filterValues.get(entry.tableKey) ?? ''}
                    onChange={(e) => handleFilterChange(entry.tableKey, e.currentTarget.value)}
                    autosize
                    minRows={2}
                    maxRows={4}
                  />
                )}
              </Stack>
            </Box>
          ))}
        </Stack>
      </ScrollArea.Autosize>

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={handleBack}>Back</ButtonSecondaryOutline>
        <ButtonPrimaryLight onClick={handleSave} loading={isSaving}>
          Save
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Confirmation step (removal with dirty files)
  const renderConfirmation = () => (
    <Stack gap="md">
      <Alert icon={<AlertTriangleIcon size={16} />} color="orange" variant="light">
        <Text size="sm" fw={500} mb="xs">
          These folders will no longer be available in Scratch:
        </Text>
        <List size="sm" spacing={4}>
          {foldersToRemove.map((folder) => (
            <List.Item key={folder.id}>{folder.name}</List.Item>
          ))}
        </List>
        {dirtyFileCount > 0 && (
          <Text size="sm" c="orange" mt="sm" fw={500}>
            There {dirtyFileCount === 1 ? 'is' : 'are'} {dirtyFileCount} file{dirtyFileCount === 1 ? '' : 's'} with
            unpublished changes that will be discarded.
          </Text>
        )}
      </Alert>

      <Group justify="flex-end" gap="sm" mt="md">
        <Button variant="subtle" color="gray" onClick={handleCancelConfirmation}>
          Go back
        </Button>
        <Button color="red" onClick={handleSave} loading={isSaving}>
          Remove
        </Button>
      </Group>
    </Stack>
  );

  const renderContent = () => {
    if (showConfirmation) return renderConfirmation();
    if (step === 2) return renderStep2();
    if (isSearchMode) return renderStep1Search();
    return renderStep1List();
  };

  return (
    <Modal opened={opened} onClose={onClose} title={modalTitle} size="md" centered>
      {renderContent()}
    </Modal>
  );
}
