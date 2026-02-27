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
import { TableList, TablePreview, TableSchemaPreview, TableSearchResult } from '@/types/server-entities/table-list';
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
  NumberInput,
  Pill,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ConnectorAccount, ConnectorPullOptions, DataFolderId, WorkbookId } from '@spinner/shared-types';
import { Service, TableDiscoveryMode } from '@spinner/shared-types';
import { AlertTriangleIcon, SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';

type TableGroup = {
  groupLabel: string | null;
  subGroups: {
    subGroupLabel: string | null;
    tables: TablePreview[];
  }[];
};

function getGroupKeys(table: TablePreview, service: Service): { group: string; subGroup: string | null } | null {
  switch (service) {
    case Service.SUPABASE:
      return {
        group: (table.metadata?.projectName as string) || (table.metadata?.projectRef as string) || '',
        subGroup: (table.metadata?.schema as string) || 'public',
      };
    case Service.AIRTABLE:
      return {
        group: (table.metadata?.baseName as string) || '',
        subGroup: null,
      };
    case Service.WEBFLOW:
      return {
        group: (table.metadata?.siteName as string) || '',
        subGroup: null,
      };
    default:
      return null;
  }
}

function groupTables(tables: TablePreview[], service: Service): TableGroup[] | null {
  const first = tables[0];
  if (!first || !getGroupKeys(first, service)) return null;

  const groupMap = new Map<string, Map<string, TablePreview[]>>();

  for (const table of tables) {
    const keys = getGroupKeys(table, service)!;
    const subKey = keys.subGroup ?? '';

    if (!groupMap.has(keys.group)) groupMap.set(keys.group, new Map());
    const subMap = groupMap.get(keys.group)!;
    if (!subMap.has(subKey)) subMap.set(subKey, []);
    subMap.get(subKey)!.push(table);
  }

  // Always show group labels for services without sub-groups (Airtable, Webflow)
  // For Supabase, only show when there are multiple projects (sub-groups provide context)
  const alwaysShowGroupLabel = service === Service.AIRTABLE || service === Service.WEBFLOW;
  const showGroupLabel = alwaysShowGroupLabel || groupMap.size > 1;
  const sorted = Array.from(groupMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  return sorted.map(([groupKey, subMap]) => ({
    groupLabel: showGroupLabel ? groupKey || 'Unknown' : null,
    subGroups: Array.from(subMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([subKey, subTables]) => ({
        subGroupLabel: subMap.size > 1 ? subKey : null,
        tables: subTables.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      })),
  }));
}

const FILTER_SUPPORTED_SERVICES = new Set([Service.NOTION, Service.AIRTABLE, Service.SUPABASE]);
const FIELD_SELECTION_SERVICES = new Set([Service.SUPABASE]);

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
  const [selectedTableMap, setSelectedTableMap] = useState<Map<string, TablePreview>>(new Map());
  const [filterValues, setFilterValues] = useState<Map<string, string>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [foldersToRemove, setFoldersToRemove] = useState<{ id: DataFolderId; name: string; tableId: string[] }[]>([]);
  const [dirtyFileCount, setDirtyFileCount] = useState(0);

  const supportsFilter = FILTER_SUPPORTED_SERVICES.has(connectorAccount.service);
  const supportsFieldSelection = FIELD_SELECTION_SERVICES.has(connectorAccount.service);
  const isAirtable = connectorAccount.service === Service.AIRTABLE;
  const isNotion = connectorAccount.service === Service.NOTION;
  const groupedTables = useMemo(
    () => groupTables(availableTables, connectorAccount.service),
    [availableTables, connectorAccount.service],
  );
  const hasConnectorOptions = isAirtable || isNotion;
  const [fieldSelections, setFieldSelections] = useState<Map<string, { idField: string; nameField: string | null }>>(
    new Map(),
  );
  const [loadedTableSchemas, setLoadedTableSchemas] = useState<Map<string, TableSchemaPreview>>(new Map());
  const [schemasLoading, setSchemasLoading] = useState<Set<string>>(new Set());

  const [triggerPull, setTriggerPull] = useState(true);

  // Connector-specific options state
  const [airtableViewValues, setAirtableViewValues] = useState<Map<string, string>>(new Map());
  const [notionOptions, setNotionOptions] = useState<
    Map<string, { excludePageContent: boolean; childContentMaxDepth: number | '' }>
  >(new Map());

  // Get currently linked data folders for this connector account
  const linkedFolders = useMemo(() => {
    const folders: {
      id: DataFolderId;
      name: string;
      tableId: string[];
      options: Record<string, unknown> | null;
      path: string | null;
    }[] = [];
    dataFolderGroups.forEach((group) => {
      group.dataFolders.forEach((folder) => {
        if (folder.connectorAccountId === connectorAccount.id) {
          folders.push({
            id: folder.id,
            name: folder.name,
            tableId: folder.tableId,
            options: folder.options,
            path: folder.path,
          });
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
          const folderFilter = (folder.options as ConnectorPullOptions)?.filter;
          if (folderFilter) {
            initialFilters.set(key, folderFilter);
          }
        }
      });
      setSelectedTableIds(linked);
      const initialMap = new Map<string, TablePreview>();
      linkedTablePreviews.forEach((t) => {
        const key = t.id.remoteId.join('/');
        if (linked.has(key)) initialMap.set(key, t);
      });
      setSelectedTableMap(initialMap);
      setFilterValues(initialFilters);
      setFieldSelections(new Map());
      setLoadedTableSchemas(new Map());
      setSchemasLoading(new Set());
      setSearchTerm('');
      setStep(1);
      setShowConfirmation(false);

      // Initialize connector-specific options from existing folders
      const initialAirtableViews = new Map<string, string>();
      const initialNotionOptions = new Map<
        string,
        { excludePageContent: boolean; childContentMaxDepth: number | '' }
      >();
      linkedFolders.forEach((folder) => {
        if (folder.tableId.length > 0) {
          const key = folder.tableId.join('/');
          const opts = folder.options ?? {};
          if (isAirtable && (opts.view as string)) {
            initialAirtableViews.set(key, opts.view as string);
          }
          if (isNotion) {
            initialNotionOptions.set(key, {
              excludePageContent: (opts.excludePageContent as boolean) ?? false,
              childContentMaxDepth: (opts.childContentMaxDepth as number) ?? '',
            });
          }
        }
      });
      setAirtableViewValues(initialAirtableViews);
      setNotionOptions(initialNotionOptions);
      setTriggerPull(true);
    }
  }, [opened, linkedFolders, linkedTablePreviews, disabledTableKeys, isAirtable, isNotion]);

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
    setSelectedTableMap((prev) => {
      const next = new Map(prev);
      if (next.has(tableKey)) {
        next.delete(tableKey);
      } else {
        next.set(tableKey, table);
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

  const handleAirtableViewChange = useCallback((tableKey: string, value: string) => {
    setAirtableViewValues((prev) => {
      const next = new Map(prev);
      if (value) {
        next.set(tableKey, value);
      } else {
        next.delete(tableKey);
      }
      return next;
    });
  }, []);

  const handleNotionOptionChange = useCallback(
    (tableKey: string, field: 'excludePageContent' | 'childContentMaxDepth', value: boolean | number | '') => {
      setNotionOptions((prev) => {
        const next = new Map(prev);
        const current = next.get(tableKey) ?? { excludePageContent: false, childContentMaxDepth: '' as number | '' };
        next.set(tableKey, { ...current, [field]: value });
        return next;
      });
    },
    [],
  );

  const buildOptionsForTable = useCallback(
    (tableKey: string): Record<string, unknown> | undefined => {
      if (isAirtable) {
        const view = airtableViewValues.get(tableKey)?.trim();
        if (view) return { view };
        return {};
      }
      if (isNotion) {
        const opts: Record<string, unknown> = {};
        const notionOpts = notionOptions.get(tableKey);
        if (notionOpts?.excludePageContent) {
          opts.excludePageContent = true;
        }
        if (
          notionOpts?.childContentMaxDepth !== undefined &&
          notionOpts.childContentMaxDepth !== '' &&
          notionOpts.childContentMaxDepth >= 0
        ) {
          opts.childContentMaxDepth = notionOpts.childContentMaxDepth;
        }
        return opts;
      }
      return undefined;
    },
    [isAirtable, isNotion, airtableViewValues, notionOptions],
  );

  // Compute tables to add and remove (used in step 2 display and save)
  const allKnownTables = useMemo(() => {
    if (!isSearchMode) return availableTables;
    const map = new Map<string, TablePreview>();
    for (const t of linkedTablePreviews) map.set(t.id.remoteId.join('/'), t);
    for (const t of searchResultTables) map.set(t.id.remoteId.join('/'), t);
    for (const [key, t] of selectedTableMap) map.set(key, t);
    return Array.from(map.values());
  }, [isSearchMode, linkedTablePreviews, searchResultTables, selectedTableMap, availableTables]);

  const currentlyLinkedKeys = useMemo(() => new Set(linkedFolders.map((f) => f.tableId.join('/'))), [linkedFolders]);

  const newlySelectedTables = useMemo(
    () => Array.from(selectedTableMap.values()).filter((t) => !currentlyLinkedKeys.has(t.id.remoteId.join('/'))),
    [selectedTableMap, currentlyLinkedKeys],
  );

  const tablesToAdd = useMemo(
    () =>
      allKnownTables.filter((table) => {
        const tableKey = table.id.remoteId.join('/');
        return selectedTableIds.has(tableKey) && !currentlyLinkedKeys.has(tableKey);
      }),
    [allKnownTables, selectedTableIds, currentlyLinkedKeys],
  );

  // Fetch table schema when entering step 2 for newly selected tables from field-selection connectors
  useEffect(() => {
    if (step !== 2 || !supportsFieldSelection) return;

    for (const table of tablesToAdd) {
      const tableKey = table.id.remoteId.join('/');
      if (loadedTableSchemas.has(tableKey) || schemasLoading.has(tableKey)) continue;

      setSchemasLoading((prev) => new Set(prev).add(tableKey));

      connectorAccountsApi
        .getTableSchema(workbookId, connectorAccount.id, table.id.remoteId.join(','))
        .then((result) => {
          setLoadedTableSchemas((prev) => new Map(prev).set(tableKey, result));
          // Pre-populate selections with detected defaults if not already set
          setFieldSelections((prev) => {
            if (prev.has(tableKey)) return prev;
            const next = new Map(prev);
            const detectedNameField =
              result.titleColumnRemoteId && result.titleColumnRemoteId.length > 0
                ? result.titleColumnRemoteId[0]
                : null;
            next.set(tableKey, {
              idField: result.idColumnRemoteId,
              nameField: detectedNameField,
            });
            return next;
          });
        })
        .catch((error) => {
          console.debug('Failed to fetch table schema', tableKey, error);
        })
        .finally(() => {
          setSchemasLoading((prev) => {
            const next = new Set(prev);
            next.delete(tableKey);
            return next;
          });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, supportsFieldSelection, tablesToAdd, workbookId, connectorAccount.id]);

  const handleFieldSelectionChange = useCallback(
    (tableKey: string, field: 'idField' | 'nameField', value: string | null) => {
      setFieldSelections((prev) => {
        const next = new Map(prev);
        const current = next.get(tableKey) ?? { idField: '', nameField: null };
        next.set(tableKey, { ...current, [field]: value });
        return next;
      });
    },
    [],
  );

  const pendingFoldersToRemove = useMemo(
    () =>
      linkedFolders.filter((folder) => {
        const folderKey = folder.tableId.join('/');
        return !selectedTableIds.has(folderKey);
      }),
    [linkedFolders, selectedTableIds],
  );

  const getTableLabel = useCallback(
    (table: TablePreview) => {
      const keys = getGroupKeys(table, connectorAccount.service);
      if (keys?.group) {
        return `${keys.group} / ${table.displayName}`;
      }
      return table.displayName;
    },
    [connectorAccount.service],
  );

  // Tables that remain selected (both existing and new) for step 2 display
  const selectedTablesForStep2 = useMemo(() => {
    const tables: { tableKey: string; displayName: string; label: string; isNew: boolean; isRemoved: boolean }[] = [];
    const seen = new Set<string>();

    // Build a lookup from allKnownTables for label resolution
    const tableLookup = new Map<string, TablePreview>();
    for (const t of allKnownTables) tableLookup.set(t.id.remoteId.join('/'), t);

    // Existing linked folders first
    linkedFolders.forEach((folder) => {
      const key = folder.tableId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      const isRemoved = !selectedTableIds.has(key);
      const preview = tableLookup.get(key);
      const label = preview ? getTableLabel(preview) : folder.name;
      tables.push({ tableKey: key, displayName: folder.name, label, isNew: false, isRemoved });
    });

    // Newly added tables
    tablesToAdd.forEach((table) => {
      const key = table.id.remoteId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      tables.push({
        tableKey: key,
        displayName: table.displayName,
        label: getTableLabel(table),
        isNew: true,
        isRemoved: false,
      });
    });

    return tables;
  }, [linkedFolders, selectedTableIds, tablesToAdd, allKnownTables, getTableLabel]);

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

        const folderPaths = new Set(pendingFoldersToRemove.map((f) => (f.path ?? f.name).replace(/^\//, '')));
        const dirtyInRemovedFolders = dirtyFiles.filter((file) => {
          return Array.from(folderPaths).some((folderPath) => {
            const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
            return file.path.startsWith(prefix);
          });
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
      // Add new tables (with optional filter, field overrides, and connector options)
      for (const table of tablesToAdd) {
        const tableKey = table.id.remoteId.join('/');
        const filter = filterValues.get(tableKey)?.trim() || undefined;
        const fields = fieldSelections.get(tableKey);
        const idFieldOverride = fields?.idField || undefined;
        const nameFieldOverride = fields?.nameField || undefined;
        const options = buildOptionsForTable(tableKey);
        await addLinkedDataFolder(
          table.id.remoteId,
          table.displayName,
          connectorAccount.id,
          filter,
          idFieldOverride,
          nameFieldOverride,
          options,
          triggerPull,
        );
      }

      // Update filters and connector options on existing tables that changed
      for (const folder of linkedFolders) {
        const folderKey = folder.tableId.join('/');
        if (!selectedTableIds.has(folderKey)) continue; // being removed
        const newFilter = filterValues.get(folderKey)?.trim() || null;
        const existingFilter = (folder.options as ConnectorPullOptions)?.filter || null;
        const newOptions = buildOptionsForTable(folderKey);
        const filterChanged = newFilter !== existingFilter;
        const optionsChanged =
          hasConnectorOptions && JSON.stringify(newOptions) !== JSON.stringify(folder.options ?? {});
        if (filterChanged || optionsChanged) {
          await dataFolderApi.update(folder.id, {
            filter: newFilter,
            ...(hasConnectorOptions && { options: newOptions }),
          });
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
            {groupedTables
              ? groupedTables.map((group, gi) => (
                  <Box key={group.groupLabel ?? gi}>
                    {group.groupLabel && (
                      <Text13Medium mb={4} mt={gi > 0 ? 'sm' : 0}>
                        {group.groupLabel}
                      </Text13Medium>
                    )}
                    {group.subGroups.map((sg, si) => (
                      <Box key={sg.subGroupLabel ?? si} ml={group.groupLabel ? 'xs' : 0}>
                        {sg.subGroupLabel && (
                          <Text12Regular c="dimmed" mb={2} mt={4}>
                            {sg.subGroupLabel}
                          </Text12Regular>
                        )}
                        <Stack gap={4} ml={sg.subGroupLabel ? 'xs' : 0}>
                          {sg.tables.map((table) => {
                            const tableKey = table.id.remoteId.join('/');
                            const isChecked = selectedTableIds.has(tableKey);
                            return (
                              <Checkbox
                                key={tableKey}
                                label={
                                  <Group gap={6} align="center" wrap="nowrap">
                                    <Text13Regular c={table.disabled ? 'dimmed' : undefined}>
                                      {table.displayName}
                                    </Text13Regular>
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
                      </Box>
                    ))}
                  </Box>
                ))
              : availableTables.map((table) => {
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
        <ButtonPrimaryLight
          onClick={handleNext}
          disabled={selectedTableIds.size === 0 && pendingFoldersToRemove.length === 0}
        >
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

          {newlySelectedTables.length > 0 && (
            <Group gap={6} wrap="wrap">
              <Text12Regular c="dimmed">Selected:</Text12Regular>
              {newlySelectedTables.map((table) => (
                <Pill
                  key={table.id.remoteId.join('/')}
                  withRemoveButton
                  onRemove={() => handleToggleTable(table)}
                  size="sm"
                >
                  {table.displayName}
                </Pill>
              ))}
            </Group>
          )}

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
          ) : availableTables.length > 0 ? (
            <ScrollArea.Autosize mah={300}>
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
          ) : (
            <Text13Regular c="dimmed" ta="center" py="md">
              Type to search for databases
            </Text13Regular>
          )}
        </>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
        <ButtonPrimaryLight
          onClick={handleNext}
          disabled={selectedTableIds.size === 0 && pendingFoldersToRemove.length === 0}
        >
          Next
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Step 2: Configure table settings
  const renderStep2 = () => {
    const hasConfigurableOptions = supportsFilter || supportsFieldSelection || hasConnectorOptions;
    return (
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text13Regular c="dimmed">
            {hasConfigurableOptions ? 'Configure settings for selected tables.' : 'Review selected tables.'}
          </Text13Regular>
          <Text12Regular c="dimmed">Step 2 of 2</Text12Regular>
        </Group>

        <ScrollArea.Autosize mah={400}>
          <Stack gap="sm">
            {selectedTablesForStep2.map((entry, index) => {
              const tableSchema = loadedTableSchemas.get(entry.tableKey);
              const isLoadingSchema = schemasLoading.has(entry.tableKey);
              const currentSelection = fieldSelections.get(entry.tableKey);
              const showFieldSelectors = supportsFieldSelection && entry.isNew && !entry.isRemoved;

              // Extract field names/types from schema properties, unwrapping nullable unions
              const schemaFields = tableSchema
                ? Object.entries((tableSchema.schema?.properties as Record<string, Record<string, unknown>>) ?? {}).map(
                    ([name, prop]) => {
                      let type = (prop?.['x-scratch-connector-data-type'] as string) ?? (prop?.type as string);
                      if (!type) {
                        const variants = (prop?.anyOf ?? prop?.oneOf) as Array<Record<string, unknown>> | undefined;
                        const real = variants?.filter((s) => s.type !== 'null');
                        type = (real?.length ? (real[0].type as string) : undefined) ?? 'unknown';
                      }
                      return { name, type };
                    },
                  )
                : [];

              return (
                <Box key={entry.tableKey}>
                  {index > 0 && <Divider mb="sm" />}
                  <Stack gap="xs">
                    <Group gap="xs" align="center">
                      <Text13Medium c={entry.isRemoved ? 'dimmed' : undefined}>{entry.label}</Text13Medium>
                      {entry.isRemoved && <Badge color="red">Will be removed</Badge>}
                      {entry.isNew && <Badge color="green">New</Badge>}
                    </Group>

                    {showFieldSelectors && isLoadingSchema && (
                      <Group gap="xs" py="xs">
                        <Loader size="xs" />
                        <Text12Regular c="dimmed">Loading table schema...</Text12Regular>
                      </Group>
                    )}

                    {showFieldSelectors && tableSchema && (
                      <>
                        <Select
                          label="ID field"
                          description="Column used to uniquely identify each record"
                          data={schemaFields.map((f) => ({
                            value: f.name,
                            label: `${f.name} (${f.type})`,
                          }))}
                          value={currentSelection?.idField ?? tableSchema.idColumnRemoteId}
                          onChange={(value) => handleFieldSelectionChange(entry.tableKey, 'idField', value)}
                          allowDeselect={false}
                          size="xs"
                        />
                        <Select
                          label="Name field (optional)"
                          description="Column used for filenames. Leave empty to use the ID."
                          data={schemaFields.map((f) => ({
                            value: f.name,
                            label: `${f.name} (${f.type})`,
                          }))}
                          value={currentSelection?.nameField ?? null}
                          onChange={(value) => handleFieldSelectionChange(entry.tableKey, 'nameField', value)}
                          placeholder="None (use ID for filenames)"
                          clearable
                          size="xs"
                        />
                      </>
                    )}

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

                    {!entry.isRemoved && isAirtable && (
                      <TextInput
                        label="View (optional)"
                        description="Airtable view ID to pull records from. Leave empty to pull all records."
                        placeholder="Enter view ID..."
                        value={airtableViewValues.get(entry.tableKey) ?? ''}
                        onChange={(e) => handleAirtableViewChange(entry.tableKey, e.currentTarget.value)}
                        size="xs"
                      />
                    )}

                    {!entry.isRemoved && isNotion && (
                      <>
                        <Checkbox
                          label="Exclude page content"
                          description="Skip pulling the body content of Notion pages. This will increase pulling speed."
                          checked={notionOptions.get(entry.tableKey)?.excludePageContent ?? false}
                          onChange={(e) =>
                            handleNotionOptionChange(entry.tableKey, 'excludePageContent', e.currentTarget.checked)
                          }
                          size="xs"
                        />
                        <NumberInput
                          label="Child content max depth (optional)"
                          description="Maximum depth of nested child blocks to include. Leave empty for default behavior."
                          placeholder="e.g. 2"
                          value={notionOptions.get(entry.tableKey)?.childContentMaxDepth ?? ''}
                          onChange={(val) =>
                            handleNotionOptionChange(
                              entry.tableKey,
                              'childContentMaxDepth',
                              val === '' ? '' : Number(val),
                            )
                          }
                          min={0}
                          max={10}
                          hideControls
                          size="xs"
                        />
                      </>
                    )}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>

        <Group justify="space-between" mt="md">
          <Tooltip label="Immediately start pulling files for the new tables after saving">
            <Switch
              label="Pull files"
              checked={triggerPull}
              onChange={(e) => setTriggerPull(e.currentTarget.checked)}
              size="xs"
            />
          </Tooltip>
          <Group gap="sm">
            <ButtonSecondaryOutline onClick={handleBack}>Back</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={handleSave} loading={isSaving}>
              Save
            </ButtonPrimaryLight>
          </Group>
        </Group>
      </Stack>
    );
  };

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
    <Modal opened={opened} onClose={onClose} title={modalTitle} size="lg" centered>
      {renderContent()}
    </Modal>
  );
}
